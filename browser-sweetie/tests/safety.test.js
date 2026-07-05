import { describe, it, expect } from "vitest";
import { makeSafety, SafetyState } from "../src/safety.js";

// injectable clocks so heartbeat/timeout + assist ages are deterministic
function mk() {
  let mono = 0, wall = 1000;
  const s = makeSafety({ now: () => mono, wallNow: () => wall });
  return { s, adv: (dm, dw = dm) => { mono += dm; wall += dw; } };
}

describe("safety FSM transitions", () => {
  it("idle -> armed -> active -> (heartbeat lost) -> armed", () => {
    const { s, adv } = mk();
    expect(s.state).toBe(SafetyState.IDLE);
    s.arm(); expect(s.state).toBe(SafetyState.ARMED);
    s.heartbeat(); expect(s.state).toBe(SafetyState.ACTIVE);
    adv(0.5); s.tick({}); expect(s.state).toBe(SafetyState.ACTIVE); // within timeout
    adv(0.6); s.tick({}); expect(s.state).toBe(SafetyState.ARMED);  // >1s since last heartbeat
  });

  it("estop latches and only clear_estop exits (arm from estop is a no-op)", () => {
    const { s } = mk();
    s.arm(); s.heartbeat();
    s.estop(); expect(s.state).toBe(SafetyState.ESTOP);
    expect(s.arm()).toBe(false); expect(s.state).toBe(SafetyState.ESTOP);
    expect(s.clearEstop()).toBe(true); expect(s.state).toBe(SafetyState.IDLE);
  });

  it("auto-trips ESTOP on battery-low and on tilt", () => {
    const a = mk(); a.s.arm(); a.s.heartbeat();
    a.s.tick({ battery_percent: 14 }); expect(a.s.state).toBe(SafetyState.ESTOP);
    const b = mk(); b.s.arm(); b.s.heartbeat();
    b.s.tick({ battery_percent: 100, imu: { roll: 0.7, pitch: 0 } }); expect(b.s.state).toBe(SafetyState.ESTOP);
  });
});

describe("proximity -> velocity scaling", () => {
  it("clear >=1.0m, hard floor <=0.3m, linear in between", () => {
    const { s } = mk();
    expect(s.proximityScale(1.2, "front")).toEqual([1.0, null]);
    expect(s.proximityScale(0.3, "front")[0]).toBe(0.0);
    const [mid] = s.proximityScale(0.65, "front"); // halfway
    expect(mid).toBeCloseTo(0.5, 5);
  });
});

describe("guard() motion chokepoint", () => {
  it("blocks when not active; scales the axis moving toward an obstacle; never scales yaw", () => {
    const { s } = mk();
    expect(s.guard(1, 0, 0).allowed).toBe(false);        // idle
    s.arm(); expect(s.guard(1, 0, 0).allowed).toBe(false); // armed, no heartbeat
    s.heartbeat();
    // clear ahead, wall on the right; drive forward+right+turn
    const r = s.guard(2.0, -0.5, 3.0, { range_obstacle: [3, 3, 3, 0.3] });
    expect(r.allowed).toBe(true);
    expect(r.vx).toBeCloseTo(1.5, 5);   // clamped to vx limit, front clear -> full
    expect(r.vy).toBe(0);               // right blocked (0.3m) -> zeroed
    expect(r.vyaw).toBeCloseTo(2.0, 5); // clamped to yaw limit, NOT scaled
    expect(r.assists.some((a) => /right/.test(a))).toBe(true);
  });

  it("ESTOP zeroes everything", () => {
    const { s } = mk(); s.arm(); s.heartbeat(); s.estop();
    const r = s.guard(1, 1, 1);
    expect(r.allowed).toBe(false);
    expect([r.vx, r.vy, r.vyaw]).toEqual([0, 0, 0]);
  });
});

describe("guardAction() discrete chokepoint", () => {
  it("halt always allowed (even ESTOP), report read-only, motion needs armed", () => {
    const { s } = mk();
    expect(s.guardAction("report").allowed).toBe(true);
    expect(s.guardAction("stand_up").allowed).toBe(false); // idle
    s.arm();
    expect(s.guardAction("stand_up").allowed).toBe(true);
    s.estop();
    expect(s.guardAction("stand_up").allowed).toBe(false); // estop latched
    expect(s.guardAction("halt").allowed).toBe(true);      // halt still ok
    expect(s.guardAction("frobnicate").allowed).toBe(false); // unknown
  });
});

describe("assist log", () => {
  it("records reasons and reports recent ones within the window, bounded to 16", () => {
    const { s, adv } = mk();
    s.recordAssist("slowed (front 0.50m)");
    adv(5); s.recordAssist("blocked (right 0.30m)");
    expect(s.recentAssists(30).length).toBe(2);
    adv(40); expect(s.recentAssists(30).length).toBe(0); // aged out
    for (let i = 0; i < 20; i++) s.recordAssist("x" + i);
    expect(s.recentAssists(999).length).toBeLessThanOrEqual(16); // ring bound
  });
});
