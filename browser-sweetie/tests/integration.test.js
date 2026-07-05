import { describe, it, expect } from "vitest";
import { makeScene } from "../src/world.js";
import { makeBridge } from "../src/bridge.js";
import { makeSafety } from "../src/safety.js";
import { makeSimPerception } from "../src/perception.js";
import { makeBus } from "../src/bus.js";

// W0 definition-of-done: the body modules COMPOSE into a working loop — drive a robot under the safety
// chokepoint, the world reacts (cat flees), perception emits events, proximity slows motion near obstacles.
function makeBody(scene = "apartment") {
  const world = makeScene(scene);
  let mono = 0, wall = 0;
  const bridge = makeBridge({ world, now: () => mono });
  const safety = makeSafety({ now: () => mono, wallNow: () => wall });
  const perc = makeSimPerception({ world, now: () => mono });
  const bus = makeBus();
  const dt = 0.02;
  // one loop step: safety predicates → (optional command via guard) → integrate → perception → publish
  function step(cmd) {
    mono += dt; wall += dt;
    safety.tick(bridge.state);
    if (cmd) {
      const r = safety.guard(cmd.vx, cmd.vy, cmd.vyaw, bridge.state);
      if (r.allowed) { bridge.move(r.vx, r.vy, r.vyaw); r.assists.forEach((a) => safety.recordAssist(a)); }
      return r;
    }
    bridge.integrate(dt);
    perc.tick(bridge.state.pose.x, bridge.state.pose.y, bridge.state.pose.yaw);
    for (const e of perc.drainNewEvents()) bus.publish("perception", { event: e });
    return null;
  }
  return { world, bridge, safety, perc, bus, step };
}

describe("W0 integration — the body loop composes", () => {
  it("armed+active robot drives forward under the guard and the pose advances", () => {
    const b = makeBody("obstacle-sparse"); // open field, clear ahead
    b.safety.arm(); b.safety.heartbeat(); b.bridge.standUp();
    b.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    const g = b.step({ vx: 0.5, vy: 0, vyaw: 0 }); // guarded move (sets velocity)
    expect(g.allowed).toBe(true);
    for (let i = 0; i < 50; i++) b.step();          // integrate 1s
    expect(b.bridge.state.pose.x).toBeGreaterThan(0.2); // actually moved forward
  });

  it("safety blocks motion until armed+heartbeat; E-STOP zeroes it", () => {
    const b = makeBody();
    expect(b.safety.guard(1, 0, 0, b.bridge.state).allowed).toBe(false); // idle
    b.safety.arm();
    expect(b.safety.guard(1, 0, 0, b.bridge.state).allowed).toBe(false); // armed, no heartbeat
    b.safety.heartbeat();
    expect(b.safety.guard(1, 0, 0, b.bridge.state).allowed).toBe(true);  // active
    b.safety.estop();
    const r = b.safety.guard(1, 0, 0, b.bridge.state);
    expect(r.allowed).toBe(false); expect(r.vx).toBe(0);
  });

  it("proximity scaling kicks in when an obstacle is close ahead (smart-assist)", () => {
    const b = makeBody();
    b.safety.arm(); b.safety.heartbeat();
    // fake a wall 0.4m ahead
    b.bridge.state.range_obstacle = [0.4, 3, 3, 3];
    const r = b.safety.guard(1.0, 0, 0, b.bridge.state);
    expect(r.allowed).toBe(true);
    expect(r.vx).toBeLessThan(1.0);           // slowed
    expect(r.vx).toBeGreaterThan(0);          // not fully blocked at 0.4m
    expect(r.assists.some((a) => /front/.test(a))).toBe(true);
  });

  it("the reactive cat flees as the robot drives at it (closed sensorimotor loop)", () => {
    const b = makeBody("apartment");
    const cat = b.world.byName("cat");
    // place robot right next to the cat and stand+drive toward it
    b.bridge.state.pose = { x: cat.x - 0.3, y: cat.y, yaw: 0 };
    b.bridge.standUp();
    const before = Math.hypot(cat.x - b.bridge.state.pose.x, cat.y - b.bridge.state.pose.y);
    for (let i = 0; i < 30; i++) { b.bridge.move(0.3, 0, 0); b.step(); } // integrate ticks world -> cat flees
    const after = Math.hypot(cat.x - b.bridge.state.pose.x, cat.y - b.bridge.state.pose.y);
    expect(after).toBeGreaterThan(before);    // the cat kept its distance / fled
  });

  it("perception events flow onto the bus as things come into view", () => {
    const b = makeBody("apartment");
    b.bridge.standUp();
    const events = [];
    b.bus.subscribe("perception", (p) => events.push(p.event));
    for (let i = 0; i < 20; i++) { b.bridge.move(0, 0, 0.5); b.step(); } // spin in place -> objects sweep through view
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => /entered view|in front|now in/.test(e))).toBe(true);
  });
});
