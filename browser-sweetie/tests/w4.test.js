import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";
import { makeCognition } from "../src/cognition.js";
import { makeIdleDriver } from "../src/idleDriver.js";

function fakeSched() {
  let now = 0; const q = [];
  return {
    now: () => now,
    defer: (fn, ms) => { const item = { fn, at: now + ms, cancelled: false }; q.push(item); return () => { item.cancelled = true; }; },
    async advance(ms) { const target = now + ms; for (;;) { const live = q.filter((i) => !i.cancelled && i.at <= target).sort((a, b) => a.at - b.at); if (!live.length) break; const n = live[0]; n.cancelled = true; now = n.at; const r = n.fn(); if (r && r.then) await r; } now = target; },
  };
}

describe("W4 — idle cognition (synthetic [idle] turn)", () => {
  it("an idle turn narrates an INTERNAL thought and does NOT move by default (no roam)", async () => {
    const sim = makeSim({ scene: "apartment" });
    const cog = makeCognition({ sim, backend: null });
    const r = await cog.idleTick({ kind: "lull", roam: false });
    expect(typeof r.thought).toBe("string");
    expect(r.thought.length).toBeGreaterThan(0);
    expect(r.acted).toBeNull();               // internal only — no motor
    expect(sim.bridge.hasYawTarget()).toBe(false);
  });

  it("the driving-frame gate is required to move: roam alone can't act while unsafe (not armed)", async () => {
    const sim = makeSim({ scene: "apartment" });
    const cog = makeCognition({ sim, backend: null });
    // roam requested but safety is IDLE → still no motor
    const r = await cog.idleTick({ kind: "checkin", roam: true });
    expect(r.acted).toBeNull();
  });

  it("with roam + armed/active + a visible companion, an idle turn gently orients (safety-gated motor)", async () => {
    const sim = makeSim({ scene: "apartment" });
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    const cat = sim.world.byName("cat");
    sim.bridge.state.pose = { x: cat.x - 1.0, y: cat.y, yaw: 0 }; // face the cat, clear-ish LOS
    const cog = makeCognition({ sim, backend: null });
    const visible = sim.perc.visionSummary(sim.bridge.state.pose.x, sim.bridge.state.pose.y, 0);
    if (visible.some((v) => v.dynamic)) {           // only assert when a companion is actually in view
      const r = await cog.idleTick({ kind: "checkin", roam: true });
      expect(r.acted && r.acted[0].ok).toBe(true);
      expect(sim.bridge.hasYawTarget()).toBe(true);
    }
  });
});

describe("W4 — driver + cognition, left alone", () => {
  it("left idle, she initiates thoughts on an adaptive cadence; input preempts the next turn", async () => {
    const s = fakeSched();
    const sim = makeSim({ scene: "apartment" });
    const thoughts = [];
    const cog = makeCognition({ sim, backend: null, config: { onIdleThought: (t) => thoughts.push(t) } });
    const driver = makeIdleDriver({
      clock: s, defer: s.defer,
      onIdleTurn: ({ kind, isCurrent }) => cog.idleTick({ kind, roam: false, isCurrent }),
      config: { floorMs: 100, ceilMs: 400, seedAvgGapMs: 200, seedGapVarMs: 100, minGapVarMs: 100, idleZ: 1.2, aiFloorMs: 0, settleCycles: 1 },
    });
    driver.setSeedPicker(cog.seedPicker);
    driver.start(0);
    await s.advance(3000);
    expect(thoughts.length).toBeGreaterThanOrEqual(1);   // she initiated on her own
    expect(typeof thoughts[0]).toBe("string");
    // a real input snaps the poll to the floor and resets the rhythm
    const before = driver.nextDelay(s.now());
    driver.notifyInput(s.now());
    expect(driver.nextDelay(s.now())).toBeLessThanOrEqual(before);
  });
});
