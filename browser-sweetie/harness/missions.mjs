// Mission-mode demonstrator: runs each behaviour mode in a fitting environment and reports status + metrics.
// Geometry modes only (no Ollama) — the social modes (junkyard-dog / sleuth) are scaffolded in mission.js and
// wired for Ollama separately.  Run:  node harness/missions.mjs
import { makeSim } from "../src/simLoop.js";
import { makeMission } from "../src/mission.js";

function run(label, scene, start, spec, { maxSteps = 6000, controlEvery = 5 } = {}) {
  let mono = 0;
  const sim = makeSim({ scene, now: () => mono });
  sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
  sim.bridge.state.pose = { x: start.x, y: start.y, yaw: 0 };
  const m = makeMission({ ...spec, sim });
  let steps = 0;
  for (let i = 0; i < maxSteps; i++) { mono += 0.02; sim.command({ type: "heartbeat" }); sim.step(); if (i % controlEvery === 0) m.tick(); steps++; if (m.status !== "running") break; }
  const icon = m.status === "succeeded" ? "✅" : m.status === "failed" ? "❌" : "⏳";
  console.log(`${icon} ${label.padEnd(26)} [${scene}]  ${m.status}  ·  ${m.phase}`);
  console.log(`     metrics: ${JSON.stringify(m.metrics())}  (${(steps * 0.02).toFixed(1)}s)`);
  return m.status;
}

console.log("\n=== Sweetie mission-mode suite ===\n");
run("patrol A→B→C", "parking-lot", { x: -5, y: 0 }, { type: "patrol", params: { points: [{ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }], laps: 1, dwell: 8 } });
run("search-pattern (lawnmower)", "parking-lot", { x: -5, y: 0 }, { type: "search-pattern", params: { pattern: "lawnmower", area: { minX: -5, maxX: 5, minY: -1, maxY: 1 }, lane: 1 } });
run("search <the cat>", "apartment", { x: -2, y: -1 }, { type: "search", params: { target: "the cat", area: { minX: -2.5, maxX: 2.5, minY: -2, maxY: 3 }, lane: 1.4 } }, { maxSteps: 5000 });
run("follow <the person>", "apartment", { x: -2, y: 1.5 }, { type: "follow", params: { target: "the person", standoff: 1.0, maxDist: 3, duration: 400 } });
run("roam", "street", { x: 5, y: 0 }, { type: "roam", params: { area: { minX: 4, maxX: 8, minY: -3, maxY: 3 }, duration: 500 } });
console.log("");
