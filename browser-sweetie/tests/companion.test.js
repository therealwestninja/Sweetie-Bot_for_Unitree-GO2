import { describe, it, expect, vi } from "vitest";
import { makeCompanion } from "../src/go2/companion.js";
import { makeGo2Driver } from "../src/go2/driver.js";
import { makeDecider } from "../src/decider.js";

function mockSdk() { const calls = []; const rec = (n) => (...a) => calls.push([n, ...a]); return { calls, StopMove: rec("StopMove"), StandUp: rec("StandUp"), BalanceStand: rec("BalanceStand"), StandDown: rec("StandDown"), BodyHeight: rec("BodyHeight"), Euler: rec("Euler"), Move: rec("Move"), WiggleHips: rec("WiggleHips") }; }
const named = (c, n) => c.filter((x) => x[0] === n);
const armed = { armed: true, mode: "standing", battery: 80, imu: { roll: 0, pitch: 0 }, ranges: [3, 3, 3, 3] };

describe("companion — the sense→decide→act control loop", () => {
  it("a normal cycle: builds a frame, asks /decide, and acts on the body", async () => {
    const sdk = mockSdk(); const driver = makeGo2Driver({ sdk, nav: { navigateToPose() {} } });
    const decide = vi.fn(async () => ({ arc: "REFLEX_REPLY", intents: [{ tool: "stand", args: [], ok: true }] }));
    const r = await makeCompanion({ decide, driver }).step(armed);
    expect(decide).toHaveBeenCalledOnce();
    expect(r.source).toBe("decide");
    expect(named(sdk.calls, "StandUp").length).toBe(1);
  });

  it("HARD SAFETY FIRST: a tilt fault halts immediately and NEVER calls /decide", async () => {
    const sdk = mockSdk(); const driver = makeGo2Driver({ sdk, nav: null });
    const decide = vi.fn(async () => ({ intents: [{ tool: "go_to_pose", args: [5, 5], ok: true }] }));
    const r = await makeCompanion({ decide, driver }).step({ ...armed, imu: { roll: 0.9, pitch: 0 } });
    expect(decide).not.toHaveBeenCalled();               // didn't wait on the brain to stop
    expect(r.source).toBe("onboard");
    expect(named(sdk.calls, "StopMove").length).toBe(1);
  });

  it("FAIL-SAFE: if /decide errors (network loss / timeout), she stops and holds", async () => {
    const sdk = mockSdk(); const driver = makeGo2Driver({ sdk, nav: null });
    const decide = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const r = await makeCompanion({ decide, driver }).step(armed);
    expect(r.source).toBe("failsafe");
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(named(sdk.calls, "StopMove").length).toBe(1);
  });

  it("passes a human prompt through to /decide", async () => {
    const decide = vi.fn(async () => ({ arc: "QUIET", intents: [] }));
    await makeCompanion({ decide, driver: makeGo2Driver({ sdk: mockSdk(), nav: null }) }).step(armed, { prompt: "sit please" });
    expect(decide.mock.calls[0][1]).toEqual({ prompt: "sit please" });
  });

  it("END-TO-END with the real decider: an obstacle ahead → freeze on the body", async () => {
    const sdk = mockSdk(); const driver = makeGo2Driver({ sdk, nav: null });
    const companion = makeCompanion({ decide: (f, o) => makeDecider({ backend: null }).decide(f, o), driver });
    const r = await companion.step({ ...armed, mode: "moving", ranges: [0.3, 3, 3, 3], detections: [{ label: "chair", name: "the chair", distance: 0.3, bearing: 0 }] });
    expect(r.decision.arc).toBe("EMERGENCY");
    expect(r.halted).toBe(true);
    expect(named(sdk.calls, "StopMove").length).toBe(1);
  });
});
