import { describe, it, expect } from "vitest";
import { frameFromSensors, rangesFromScan, makeGo2Driver } from "../src/go2/driver.js";
import { makeDecider } from "../src/decider.js";

// a mock unitree_sdk2 sport client + Nav2 that just record what they were told to do
function mockSdk() { const calls = []; const rec = (n) => (...a) => calls.push([n, ...a]); return { calls, StopMove: rec("StopMove"), StandUp: rec("StandUp"), BalanceStand: rec("BalanceStand"), StandDown: rec("StandDown"), BodyHeight: rec("BodyHeight"), Euler: rec("Euler"), Move: rec("Move"), Hello: rec("Hello"), WiggleHips: rec("WiggleHips"), Scrape: rec("Scrape"), Stretch: rec("Stretch"), Sit: rec("Sit") }; }
function mockNav() { const goals = []; return { goals, navigateToPose: (p) => goals.push(p) }; }
const named = (calls, n) => calls.filter((c) => c[0] === n);

describe("go2 driver contract — SENSORS → FRAME", () => {
  it("reduces a LiDAR scan to [front,left,back,right] quadrant ranges", () => {
    const scan = [{ angle: 0, range: 0.8 }, { angle: Math.PI / 2, range: 1.5 }, { angle: Math.PI, range: 2.2 }, { angle: -Math.PI / 2, range: 0.4 }];
    expect(rangesFromScan(scan, { maxRange: 3 })).toEqual([0.8, 1.5, 2.2, 0.4]);
    expect(rangesFromScan([], { maxRange: 3 })).toEqual([3, 3, 3, 3]);   // empty → maxRange
  });

  it("builds the decider frame: safety derived, detections mapped to visible[]", () => {
    const f = frameFromSensors({ armed: true, mode: "standing", battery: 88, pose: { x: 1, y: 2, yaw: 0.3 }, scan: [{ angle: 0, range: 0.5 }], detections: [{ label: "person", name: "the visitor", distance: 1.4, bearing: 12 }] });
    expect(f.safety).toBe("active");
    expect(f.ranges[0]).toBe(0.5);
    expect(f.visible[0]).toMatchObject({ name: "the visitor", category: "person", dynamic: true, distance_m: 1.4, bearing_deg: 12 });
    expect(frameFromSensors({ estop: true }).safety).toBe("estop");
    expect(frameFromSensors({ armed: false, mode: "down" }).safety).toBe("idle");
  });
});

describe("go2 driver contract — DECISION → GO2", () => {
  const live = { estop: false, roll: 0, pitch: 0, battery: 80, mode: "standing" };

  it("maps the motor verbs to sport-mode / Nav2 calls", () => {
    const sdk = mockSdk(), nav = mockNav(); const drv = makeGo2Driver({ sdk, nav });
    const frame = { visible: [{ name: "the cat", bearing_deg: 20 }] };
    drv.execute({ intents: [
      { tool: "stand", args: [], ok: true }, { tool: "set_body_height", args: [0.34], ok: true },
      { tool: "look_at", args: ["the cat"], ok: true }, { tool: "go_to_pose", args: [2, -1], ok: true },
      { tool: "gesture", args: ["wag"], ok: true }, { tool: "halt", args: [], ok: true },
    ] }, { live, frame });
    expect(named(sdk.calls, "StandUp").length).toBe(1);
    expect(named(sdk.calls, "BodyHeight")[0][1]).toBeCloseTo(0.04, 2);   // 0.34 − nominal 0.30
    expect(named(sdk.calls, "Euler").length).toBe(1);                    // small yaw → Euler
    expect(nav.goals[0]).toEqual({ x: 2, y: -1 });                       // go_to_pose → Nav2 goal
    expect(named(sdk.calls, "WiggleHips").length).toBe(1);               // gesture 'wag'
    expect(named(sdk.calls, "StopMove").length).toBe(1);
  });

  it("EMERGENCY halts immediately and skips every other intent", () => {
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const r = drv.execute({ emergency: true, intents: [{ tool: "go_to_pose", args: [5, 5], ok: true }] }, { live });
    expect(r.halted).toBe(true);
    expect(named(sdk.calls, "StopMove").length).toBe(1);
    expect(named(sdk.calls, "Move").length).toBe(0);                     // nothing else ran
  });

  it("the BODY has the final veto: onboard state refuses a move even if the decider said ok", () => {
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const r = drv.execute({ intents: [{ tool: "go_to_pose", args: [1, 1], ok: true }, { tool: "halt", args: [], ok: true }] }, { live: { ...live, estop: true } });
    expect(r.results.find((x) => x.tool === "go_to_pose").ok).toBe(false); // refused onboard
    expect(named(sdk.calls, "StopMove").length).toBe(1);                   // halt still honoured
  });

  it("look_at a target that isn't visible fails cleanly (no blind spin)", () => {
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const r = drv.execute({ intents: [{ tool: "look_at", args: ["the ghost"], ok: true }] }, { live, frame: { visible: [] } });
    expect(r.results[0].ok).toBe(false); expect(r.results[0].reason).toMatch(/not visible/);
    expect(named(sdk.calls, "Euler").length + named(sdk.calls, "Move").length).toBe(0);
  });

  it("an intent already gated OFF by the decider is not re-executed", () => {
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const r = drv.execute({ intents: [{ tool: "go_to_pose", args: [1, 1], ok: false, reason: "not armed" }] }, { live });
    expect(r.results[0].skipped).toBe("decider-gated");
    expect(sdk.calls.length).toBe(0);
  });
});

describe("go2 driver — FULL ROUND-TRIP: raw sensors → frame → /decide → intents → Go2 body", () => {
  it("an obstacle ahead makes her freeze on the actual body", async () => {
    const decider = makeDecider({ backend: null });
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const frame = frameFromSensors({ armed: true, mode: "moving", battery: 70, scan: [{ angle: 0, range: 0.3 }], detections: [{ label: "chair", name: "the chair", distance: 0.3, bearing: 0 }] });
    const decision = await decider.decide(frame);
    const r = drv.execute(decision, { live: { mode: "moving", battery: 70 }, frame });
    expect(decision.arc).toBe("EMERGENCY");
    expect(r.halted).toBe(true);
    expect(named(sdk.calls, "StopMove").length).toBe(1);
  });

  it("a human line makes her orient toward a real detected target", async () => {
    const decider = makeDecider({ backend: { name: "m", async generate() { return "hi! look_at(the visitor)"; } } });
    const sdk = mockSdk(); const drv = makeGo2Driver({ sdk, nav: mockNav() });
    const frame = frameFromSensors({ armed: true, mode: "standing", battery: 70, detections: [{ label: "person", name: "the visitor", distance: 1.5, bearing: 15 }] });
    const decision = await decider.decide(frame, { prompt: "look at the visitor" });
    const r = drv.execute(decision, { live: { mode: "standing", battery: 70 }, frame });
    expect(decision.intents.find((i) => i.tool === "look_at").ok).toBe(true);
    expect(named(sdk.calls, "Euler").length + named(sdk.calls, "Move").length).toBe(1); // actually turned
    expect(r.results.some((x) => x.ok)).toBe(true);
  });
});
