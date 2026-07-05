import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";

function mk(scene = "apartment") {
  let t = 0;
  const sim = makeSim({ scene, now: () => (t += 0.02) });
  return { sim, run: (n) => { for (let i = 0; i < n; i++) sim.step(); } };
}

describe("simLoop — telemetry frame", () => {
  it("produces the dashboard frame contract", () => {
    const { sim } = mk();
    const f = sim.step();
    expect(f.type).toBe("telemetry");
    expect(f.state).toHaveProperty("pose");
    expect(f.state).toHaveProperty("range_obstacle");
    expect(f.state).toHaveProperty("battery_percent");
    expect(f.safety.state).toBe("idle");
    expect(Array.isArray(f.dynamic_objects)).toBe(true);
    expect(f.dynamic_objects.some((o) => /cat/.test(o.name))).toBe(true); // apartment has the cat
  });

  it("worldPayload lists the static scene for the UI", () => {
    const { sim } = mk();
    const p = sim.worldPayload();
    expect(p.objects.length).toBeGreaterThan(3);
    expect(p.objects[0]).toHaveProperty("category");
  });
});

describe("simLoop — commands route through safety", () => {
  it("move is blocked until armed+heartbeat+standing, then drives", () => {
    const { sim, run } = mk("obstacle-sparse");
    expect(sim.command({ type: "move", vx: 0.5 }).ok).toBe(false); // idle
    sim.command({ type: "arm" });
    sim.command({ type: "heartbeat" });
    expect(sim.command({ type: "stand_up" }).ok).toBe(true);
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    expect(sim.command({ type: "move", vx: 0.5 }).ok).toBe(true); // active+standing
    run(50);
    expect(sim.bridge.state.pose.x).toBeGreaterThan(0.2);
  });

  it("estop syncs the body and blocks motion; clear_estop recovers", () => {
    const { sim } = mk();
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    sim.command({ type: "estop" });
    expect(sim.safety.state).toBe("estop");
    expect(sim.bridge.state.mode).toBe("estop");
    expect(sim.command({ type: "move", vx: 1 }).ok).toBe(false);
    expect(sim.command({ type: "clear_estop" }).ok).toBe(true);
    expect(sim.bridge.state.mode).toBe("down");
  });

  it("proximity slowdown emits an assist event on the bus", () => {
    const { sim } = mk();
    const assists = [];
    sim.bus.subscribe("assist", (p) => assists.push(...p.events));
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    sim.bridge.state.range_obstacle = [0.4, 3, 3, 3]; // wall ahead
    sim.command({ type: "move", vx: 1.0 });
    expect(assists.some((a) => /front/.test(a))).toBe(true);
  });

  it("unknown command is rejected", () => {
    const { sim } = mk();
    expect(sim.command({ type: "teleport" }).ok).toBe(false);
  });
});

describe("simLoop — events", () => {
  it("publishes telemetry each step and a zone_changed event on region entry", () => {
    const { sim, run } = mk("apartment");
    let frames = 0, zones = [];
    sim.bus.subscribe("telemetry", () => frames++);
    sim.bus.subscribe("zone_changed", (z) => zones.push(z));
    sim.bridge.state.pose = { x: 100, y: 100, yaw: 0 }; // start outside any region
    sim.step();
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };       // move into the apartment
    sim.step();
    expect(frames).toBe(2);
    expect(zones.some((z) => z.to === "apartment")).toBe(true);
  });

  it("auto-trips ESTOP on battery-low and syncs the body", () => {
    const { sim } = mk();
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    sim.bridge.state.battery_percent = 10; // drained
    sim.step();
    expect(sim.safety.state).toBe("estop");
    expect(sim.bridge.state.mode).toBe("estop");
  });
});
