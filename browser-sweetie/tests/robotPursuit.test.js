import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";
import { makeRobotPursuit, waypointGoal } from "../src/robotPursuit.js";

function bot() {
  let mono = 0; const sim = makeSim({ scene: "apartment", now: () => mono, dt: 0.02 });
  sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
  sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
  return sim;
}

describe("robotPursuit — the verified task-layer wired to the body", () => {
  it("runs a guided tour: every leg is confirmed by a REAL pose check, cleanly (no clipping)", async () => {
    const sim = bot();
    const r = await makeRobotPursuit({ sim }).run(waypointGoal([{ x: -1.8, y: -1.2 }, { x: 1.8, y: -1.2 }]));
    expect(r.status).toBe("done");
    expect(r.executed).toBe(2);
    expect(r.trace.every((e) => e.result === "verified")).toBe(true);   // each leg verified against reality
    expect(r.trace.some((e) => e.result === "shortcut-rejected")).toBe(false); // reached them honestly, not through walls
  });

  it("a hard SAFETY INVARIANT stops the task before any motion (E-STOP latched)", async () => {
    const sim = bot();
    sim.command({ type: "estop" });                                     // latched
    const before = { ...sim.bridge.state.pose };
    const r = await makeRobotPursuit({ sim }).run(waypointGoal([{ x: -1.8, y: -1.2 }]));
    expect(r.status).toBe("aborted");
    expect(r.reason).toMatch(/E-STOP/);
    expect(sim.bridge.state.pose).toEqual(before);                      // she never moved
  });

  it("does NOT hallucinate arrival at an unreachable leg (inside the couch) — it escalates", async () => {
    const sim = bot();
    const r = await makeRobotPursuit({ sim, ticksPerStep: 200 }).run(waypointGoal([{ x: 2, y: 1.5 }])); // couch centre
    expect(r.status).not.toBe("done");
    expect(["escalated", "aborted"]).toContain(r.status);
    expect(r.trace.at(-1).result).not.toBe("verified");                 // never falsely verified
  });
});
