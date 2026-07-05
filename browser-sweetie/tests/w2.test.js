import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";
import { makeOrganism } from "../../../brain/src/organism.js";
import { makeSensorium } from "../src/sensorium.js";
import { makeMotorCodec } from "../src/motorCodec.js";
import { makeCommitController } from "../src/commit.js";
import { makeCognition } from "../src/cognition.js";

// A deterministic mouth: returns whatever canned text the test wired, echoing the prompt if a fn is given.
function mockBackend(reply) {
  return { name: "mock", async generate({ messages }) { return typeof reply === "function" ? reply(messages) : reply; } };
}
function armStandActive(sim) {
  sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
}

describe("sensorium — perception → brain channels", () => {
  it("maps proximity to threat and a friendly face to reward", () => {
    const org = makeOrganism({ seed: 3 });
    const sens = makeSensorium({ organism: org });
    const near = sens.observe({ state: { range_obstacle: [0.35, 3, 3, 3], mode: "moving" } }, []);
    const far = sens.observe({ state: { range_obstacle: [3, 3, 3, 3], mode: "standing" } }, [],
      { visible: [{ name: "the cat", distance_m: 1.2, bearing_deg: 5, category: "animal", dynamic: true }] });
    expect(near.threat).toBeGreaterThan(0.7);
    expect(far.threat).toBe(0);
    expect(far.reward).toBeGreaterThan(0);   // friendly in view, nothing threatening
    expect(near.reward).toBe(0);             // threat suppresses approach
  });

  it("an addressed turn drives the memory (deliberation) channel", () => {
    const org = makeOrganism({ seed: 3 });
    const sens = makeSensorium({ organism: org });
    const d = sens.observe({ state: { range_obstacle: [3, 3, 3, 3] } }, [], { addressed: true, prompt: "look at the cat" });
    expect(d.memory).toBeGreaterThan(0.8);
    expect(d.drivers).toContain("addressed");
  });
});

describe("motorCodec — parse + safety-gated dispatch (new-build #3)", () => {
  it("parses speech and tool calls with numeric coercion", () => {
    const sim = makeSim({ scene: "apartment" });
    const codec = makeMotorCodec({ bridge: sim.bridge, safety: sim.safety });
    const { speech, intents } = codec.parse("Hello there! look_at(the cat) go_to_pose(1.5, -2)");
    expect(speech).toBe("Hello there!");
    expect(intents.map((i) => i.tool)).toEqual(["look_at", "go_to_pose"]);
    expect(intents[1].args).toEqual([1.5, -2]);
  });

  it("blocks motor when not armed, allows it when active", () => {
    const sim = makeSim({ scene: "apartment" });
    const codec = makeMotorCodec({ bridge: sim.bridge, safety: sim.safety });
    const blocked = codec.dispatch([{ tool: "look_at", args: ["the cat"] }], { world: sim.world });
    expect(blocked[0].ok).toBe(false);
    expect(blocked[0].reason).toMatch(/not armed/);
    armStandActive(sim);
    const ok = codec.dispatch([{ tool: "look_at", args: ["the cat"] }], { world: sim.world });
    expect(ok[0].ok).toBe(true);
    expect(sim.bridge.hasYawTarget()).toBe(true);
  });

  it("halt is always allowed; bad numeric args fail closed", () => {
    const sim = makeSim({ scene: "apartment" });
    const codec = makeMotorCodec({ bridge: sim.bridge, safety: sim.safety });
    expect(codec.dispatch([{ tool: "halt", args: [] }])[0].ok).toBe(true); // even idle
    armStandActive(sim);
    expect(codec.dispatch([{ tool: "go_to_pose", args: [NaN, 1] }])[0].ok).toBe(false);
  });
});

describe("commit-discipline — anti-dither", () => {
  it("adopts from idle instantly but holds an active arc for the commit window", () => {
    const c = makeCommitController({ arcCommitTicks: 6 });
    expect(c.chooseArc({ action: "REFLEX_REPLY" }).arc).toBe("REFLEX_REPLY"); // instant from QUIET
    let last;
    for (let i = 0; i < 4; i++) last = c.chooseArc({ action: "RESPOND" });     // rival, inside window
    expect(last.arc).toBe("REFLEX_REPLY");
    expect(last.suppressed).toBe("RESPOND");
    for (let i = 0; i < 3; i++) last = c.chooseArc({ action: "RESPOND" });     // out-waits the window
    expect(last.arc).toBe("RESPOND");
  });

  it("emergency preempts instantly; target-memory survives occlusion then expires", () => {
    const c = makeCommitController({ arcCommitTicks: 6, targetTTL: 25 });
    c.chooseArc({ action: "RESPOND" });
    expect(c.chooseArc({ action: "HOLD" }, { emergency: true, emergencyArc: "EMERGENCY" }).arc).toBe("EMERGENCY");
    c.setTarget("the cat");
    for (let i = 0; i < 20; i++) c.tickTargets([]); // 20 blind ticks
    expect(c.hasTarget()).toBe(true);               // retained through occlusion
    for (let i = 0; i < 6; i++) c.tickTargets([]);  // past TTL
    expect(c.hasTarget()).toBe(false);
  });
});

describe("cognition — brain in the loop (thesis payoff)", () => {
  it("emergency obstacle trips the onboard reflex: halts the body, no LLM", () => {
    const sim = makeSim({ scene: "apartment" });
    armStandActive(sim);
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    sim.bridge.move(1.0, 0, 0); // moving forward
    const cog = makeCognition({ sim, backend: null });
    sim.bridge.state.range_obstacle = [0.35, 3, 3, 3]; // wall in the bubble
    const f = cog.step();
    expect(f.arc).toBe("EMERGENCY");
    expect(f.emergency.tripped).toBe(true);
    expect(sim.bridge.state.velocity.x).toBe(0); // halted
    expect(f.speech).toMatch(/too close/);
  });

  it("a supervisor turn drives a safety-gated look_at through the mouth", async () => {
    const sim = makeSim({ scene: "apartment" });
    armStandActive(sim);
    const cog = makeCognition({ sim, backend: mockBackend("I see you! look_at(the cat)") });
    const res = await cog.converse("look at the cat");
    const look = res.motor.find((m) => m.tool === "look_at");
    expect(look.ok).toBe(true);
    expect(sim.bridge.hasYawTarget()).toBe(true);
    expect(cog.commit.target()).toBe("the cat"); // attention locked onto it
  });

  it("does not flip-flop arcs every cycle in a stable scene", () => {
    const sim = makeSim({ scene: "obstacle-sparse" });
    armStandActive(sim);
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    const cog = makeCognition({ sim, backend: null });
    let prev = null, switches = 0;
    for (let i = 0; i < 40; i++) { const f = cog.step(); if (prev !== null && f.arc !== prev) switches++; prev = f.arc; }
    expect(switches).toBeLessThanOrEqual(6); // committed, not twitching
  });
});
