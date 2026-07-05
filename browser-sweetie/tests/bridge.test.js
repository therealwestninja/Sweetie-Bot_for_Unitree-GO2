import { describe, it, expect } from "vitest";
import { makeBridge } from "../src/bridge.js";

const mockWorld = () => ({
  ticks: 0, lastObs: null,
  tick(dt, obs) { this.ticks++; this.lastObs = obs; },
  proximityRanges() { return [1.5, 3, 3, 3]; },
  bearingFrom(x, y, name) { return name === "couch" ? Math.PI / 2 : null; },
});

const drive = (b, n, dt = 0.02) => { for (let i = 0; i < n; i++) b.integrate(dt); };

describe("bridge — posture + mode", () => {
  it("stand up / sit down transitions and blocks move while down", () => {
    const b = makeBridge();
    expect(b.state.mode).toBe("down");
    expect(b.move(1, 0, 0)).toBe(false);       // can't move while folded
    b.standUp(); expect(b.state.mode).toBe("standing"); expect(b.state.body_height).toBeCloseTo(0.27);
    expect(b.move(1, 0, 0)).toBe(true); expect(b.state.mode).toBe("moving");
    b.standDown(); expect(b.state.mode).toBe("down"); expect(b.state.velocity.x).toBe(0);
  });

  it("set_body_height clamps to [0.18,0.34] and is a no-op while down", () => {
    const b = makeBridge();
    expect(b.setBodyHeight(0.3)).toBe(false); // down
    b.standUp();
    b.setBodyHeight(0.5); expect(b.state.body_height).toBeCloseTo(0.34);
    b.setBodyHeight(0.1); expect(b.state.body_height).toBeCloseTo(0.18);
  });
});

describe("bridge — kinematic integration", () => {
  it("drives forward in the heading direction; yaw rotates", () => {
    const b = makeBridge();
    b.standUp(); b.move(1, 0, 0);          // 1 m/s forward, yaw 0 → +x
    drive(b, 50);                           // 1s
    expect(b.state.pose.x).toBeCloseTo(1.0, 1);
    expect(b.state.pose.y).toBeCloseTo(0.0, 5);
    b.move(0, 0, 1);                        // spin
    drive(b, 50);
    expect(b.state.pose.yaw).toBeCloseTo(1.0, 1);
  });

  it("move clamps to the velocity envelope", () => {
    const b = makeBridge(); b.standUp();
    b.move(9, 9, 9);
    expect(b.state.velocity.x).toBeCloseTo(1.5);
    expect(b.state.velocity.y).toBeCloseTo(0.8);
    expect(b.state.velocity.yaw).toBeCloseTo(2.0);
  });

  it("battery drains faster while moving", () => {
    const b = makeBridge(); b.standUp();
    b.move(0, 0, 0); drive(b, 100); const idleDrop = 100 - b.state.battery_percent;
    const b2 = makeBridge(); b2.standUp(); b2.move(1, 0, 0); drive(b2, 100);
    const moveDrop = 100 - b2.state.battery_percent;
    expect(moveDrop).toBeGreaterThan(idleDrop);
  });
});

describe("bridge — nav + look_at", () => {
  it("go_to_pose drives to the target then stops (arrival)", () => {
    const b = makeBridge(); b.standUp();
    b.goToPose(1.0, 0.0); expect(b.hasNavTarget()).toBe(true);
    drive(b, 600);
    // arrives within the 0.20m arrival radius (stops SHORT of the exact point, by design)
    expect(Math.hypot(1.0 - b.state.pose.x, 0 - b.state.pose.y)).toBeLessThanOrEqual(0.21);
    expect(b.hasNavTarget()).toBe(false);     // cleared on arrival
    expect(b.state.mode).toBe("standing");
  });

  it("look_at rotates to face a named object (needs a world); reports outcomes", () => {
    const b = makeBridge({ world: mockWorld() });
    expect(b.lookAtEntity("couch")).toBe("wrong_mode"); // still down
    b.standUp();
    expect(b.lookAtEntity("ghost")).toBe("no_target");  // unknown name
    expect(b.lookAtEntity("couch")).toBe("ok");
    expect(b.hasYawTarget()).toBe(true);
    drive(b, 400);
    expect(Math.abs(b.state.pose.yaw - Math.PI / 2)).toBeLessThan(0.06); // faced the couch (within YAW_GOAL_TOLERANCE)
    expect(b.hasYawTarget()).toBe(false);
  });

  it("no world -> look_at returns 'no_world'", () => {
    const b = makeBridge(); b.standUp();
    expect(b.lookAtEntity("couch")).toBe("no_world");
  });

  it("world tick + proximity republish happen each integrate", () => {
    const w = mockWorld();
    const b = makeBridge({ world: w }); b.standUp();
    drive(b, 3);
    expect(w.ticks).toBe(3);
    expect(b.state.range_obstacle).toEqual([1.5, 3, 3, 3]);
  });
});

describe("bridge — e-stop", () => {
  it("emergency_stop zeroes velocity + latches; clear_estop returns to down", () => {
    const b = makeBridge(); b.standUp(); b.move(1, 0, 0);
    b.emergencyStop();
    expect(b.state.mode).toBe("estop"); expect(b.state.velocity.x).toBe(0);
    expect(b.move(1, 0, 0)).toBe(false); expect(b.standUp()).toBe(false);
    expect(b.clearEstop()).toBe(true); expect(b.state.mode).toBe("down");
  });
});
