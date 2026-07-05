import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";
import { makeMission } from "../src/mission.js";

// Drive the body loop + tick the mission at a control rate until it settles or times out.
function runMission(sim, mission, { maxSteps = 6000, controlEvery = 5 } = {}) {
  sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
  for (let i = 0; i < maxSteps; i++) {
    sim.command({ type: "heartbeat" });
    sim.step();
    if (i % controlEvery === 0) mission.tick();
    if (mission.status !== "running") break;
  }
  return mission;
}

describe("mission — geometry modes (no LLM)", () => {
  it("patrol visits A→B→C and succeeds after a lap", () => {
    const sim = makeSim({ scene: "obstacle-sparse" });
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    const points = [{ x: 1.2, y: 0 }, { x: 0, y: 1.2 }, { x: -1.2, y: 0 }]; // inside the cleared centre
    const m = makeMission({ type: "patrol", params: { points, laps: 1, dwell: 5 }, sim });
    runMission(sim, m);
    expect(m.status).toBe("succeeded");
    expect(m.metrics().ticks).toBeGreaterThan(0);
  });

  it("search-pattern sweeps its coverage waypoints", () => {
    const sim = makeSim({ scene: "obstacle-sparse" });
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    const m = makeMission({ type: "search-pattern", params: { pattern: "lawnmower", area: { minX: -1, maxX: 1, minY: -1, maxY: 1 }, lane: 1 }, sim });
    runMission(sim, m);
    expect(m.status).toBe("succeeded");
    expect(m.metrics().covered).toBe(m.metrics().waypoints);
  });

  it("search succeeds when the target comes into view", () => {
    const sim = makeSim({ scene: "apartment" });
    const couch = sim.world.byName("couch");
    sim.bridge.state.pose = { x: couch.x - 1.5, y: couch.y, yaw: 0 }; // already looking at the couch
    const m = makeMission({ type: "search", params: { target: "couch", area: { minX: -2, maxX: 2, minY: -2, maxY: 2 } }, sim });
    runMission(sim, m, { maxSteps: 1500 });
    expect(m.status).toBe("succeeded");
    expect(m.phase).toMatch(/spotted/);
  });

  it("follow keeps a moving actor in range", () => {
    const sim = makeSim({ scene: "apartment" });
    const person = sim.world.byName("the person");
    sim.bridge.state.pose = { x: person.x + 0.9, y: person.y, yaw: 0 };
    const m = makeMission({ type: "follow", params: { target: "the person", standoff: 1.0, maxDist: 3, duration: 400 }, sim });
    runMission(sim, m, { maxSteps: 3000 });
    expect(m.status).toBe("succeeded");
    expect(m.metrics().inRange / m.metrics().samples).toBeGreaterThan(0.6);
  });

  it("an unknown mode fails cleanly", () => {
    const sim = makeSim({ scene: "apartment" });
    const m = makeMission({ type: "moonwalk", params: {}, sim });
    m.tick();
    expect(m.status).toBe("failed");
  });
});
