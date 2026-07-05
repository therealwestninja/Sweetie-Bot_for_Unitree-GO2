// Colony demo (Stage A — physical, no Ollama): a round table of knight-bots shuttling between four chat
// lobbies, navigating around each other + the arena obstacles. Reports lobby membership and the closest
// approach between any two bots (the collision signal). Run:  node harness/colony.mjs
import { makeColony } from "../src/agents/colony.js";

const statics = [
  { name: "round table", x: 0, y: 0, radius: 0.7 },
  { name: "brazier N", x: 0, y: 2.2, radius: 0.35 },
  { name: "brazier S", x: 0, y: -2.2, radius: 0.35 },
];
const zones = [
  { name: "forge", x: -3.2, y: 3.0, radius: 1.2, purpose: "hammer out plans" },
  { name: "library", x: 3.2, y: 3.0, radius: 1.2, purpose: "quiet research + lore" },
  { name: "war-room", x: 3.2, y: -3.0, radius: 1.2, purpose: "strategy + conflict" },
  { name: "garden", x: -3.2, y: -3.0, radius: 1.2, purpose: "rest + informal talk" },
];
const KNIGHTS = ["arthur", "lancelot", "gawain", "percival", "galahad", "mordred"];
const bots = KNIGHTS.map((name, i) => ({ name, pose: { x: -4 + i * 1.5, y: 0 } }));

const colony = makeColony({ statics, zones, bots });

let mono = 0, minSepEver = Infinity;
function step(n) { for (let i = 0; i < n; i++) { mono += 0.02; colony.tick(0.02); minSepEver = Math.min(minSepEver, colony.minSeparation()); } }
function runPhase(label, maxSteps = 3000) {
  const start = mono; let phaseMin = Infinity;
  for (let i = 0; i < maxSteps; i++) { mono += 0.02; colony.tick(0.02); const s = colony.minSeparation(); phaseMin = Math.min(phaseMin, s); minSepEver = Math.min(minSepEver, s); if (colony.allArrived()) break; }
  const lob = colony.lobbies();
  console.log(`\n▸ ${label}   (${(mono - start).toFixed(1)}s, closest approach ${phaseMin.toFixed(2)}m)`);
  for (const z of zones) console.log(`   ${z.name.padEnd(9)} [${z.purpose}]: ${(lob[z.name] || []).join(", ") || "—"}`);
}

console.log(`\n=== Round-table colony — ${KNIGHTS.length} knights, ${zones.length} lobbies ===`);
console.log(`(bot radius ${colony.botRadius}m → a collision would be centres < ${(2 * colony.botRadius).toFixed(2)}m apart)`);

// Phase 1: everyone crowds into the forge (worst-case: 6 bots converge on one lobby)
KNIGHTS.forEach((k) => colony.sendTo(k, "forge"));
runPhase("all → forge (crowding stress)");

// Phase 2: split into three lobbies (cross-traffic as paths intersect)
[["arthur", "war-room"], ["lancelot", "war-room"], ["gawain", "library"], ["percival", "library"], ["galahad", "garden"], ["mordred", "garden"]].forEach(([k, z]) => colony.sendTo(k, z));
runPhase("split → war-room / library / garden");

// Phase 3: full reshuffle to the library (everyone crosses the arena)
KNIGHTS.forEach((k) => colony.sendTo(k, "library"));
runPhase("all → library (cross-arena reshuffle)");

console.log(`\n=== closest approach across the whole run: ${minSepEver.toFixed(2)}m  → ${minSepEver >= 2 * colony.botRadius ? "NO collisions ✅" : "OVERLAP ❌"} ===\n`);
