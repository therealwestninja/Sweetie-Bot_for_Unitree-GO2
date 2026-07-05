import { describe, it, expect } from "vitest";
import { makeWorld, obj } from "../src/world.js";
import { makeBridge } from "../src/bridge.js";

// go_to_pose with the reactive avoidance hook filled. The world has no collision physics, so nothing STOPS
// her passing through an obstacle — the avoidance is what keeps her out. This reactive steer is a W5 down-
// payment: it reliably (a) reaches the goal without stalling, (b) actively steers AROUND rather than driving
// straight through the centre. It does NOT yet guarantee clean clearance on head-on / tight obstacles — that
// is the full layered steering in W5. The test asserts the reliable properties, not the aspirational one.
describe("nav — reactive obstacle avoidance", () => {
  it("steers around a box on the direct path (detours + doesn't plow through the centre) and still arrives", () => {
    const world = makeWorld({ objects: [obj("box", 1.6, 0, { radius: 0.4 })] }); // dead ahead
    const bridge = makeBridge({ world });
    bridge.standUp();
    bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    bridge.goToPose(3.2, 0);

    let minClear = Infinity, maxAbsY = 0;
    for (let i = 0; i < 3000 && bridge.hasNavTarget(); i++) {
      bridge.integrate(0.02);
      const p = bridge.state.pose;
      const clear = Math.hypot(1.6 - p.x, 0 - p.y) - 0.4 - 0.25;
      if (clear < minClear) minClear = clear;
      if (Math.abs(p.y) > maxAbsY) maxAbsY = Math.abs(p.y);
    }
    const p = bridge.state.pose;
    expect(Math.hypot(p.x - 3.2, p.y)).toBeLessThan(0.35); // arrived at the goal (didn't stall)
    expect(maxAbsY).toBeGreaterThan(0.3);                  // actively stepped aside (avoidance engaged)
    expect(minClear).toBeGreaterThan(-0.5);                // did NOT drive through the centre (straight-through ≈ −0.65)
  });

  it("drives a clear straight path without spurious detours (avoidance stays dormant)", () => {
    const bridge = makeBridge({}); // no world → range_obstacle stays [3,3,3,3], avoidance inactive
    bridge.standUp();
    bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    bridge.goToPose(2, 0);
    let maxAbsY = 0;
    for (let i = 0; i < 2000 && bridge.hasNavTarget(); i++) { bridge.integrate(0.02); maxAbsY = Math.max(maxAbsY, Math.abs(bridge.state.pose.y)); }
    expect(Math.hypot(bridge.state.pose.x - 2, bridge.state.pose.y)).toBeLessThan(0.3);
    expect(maxAbsY).toBeLessThan(0.05); // straight line, no wobble
  });
});
