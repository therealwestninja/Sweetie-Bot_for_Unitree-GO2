// Nav-suite runner: sends Sweetie across three environments and reports whether — and how cleanly — she
// navigates each, talking with an Ollama-driven character she meets along the way.
//   node harness/run.mjs              # full run, Ollama characters + Sweetie's Ollama mouth
//   node harness/run.mjs --no-mouth   # fast baseline: pure navigation, no network
import { runEnv } from "./navHarness.mjs";
import { makeActor } from "./actor.mjs";

const useMouth = !process.argv.includes("--no-mouth");
const log = (s) => console.log(s);

const ENVS = [
  {
    scene: "apartment", goalName: "the far corner by the couch",
    start: { x: -2.5, y: -1.5 }, goal: { x: 2.4, y: 0.3 },
    actors: [{ name: "the person", dist: 1.6, actor: makeActor({ name: "the resident", persona: "a warm apartment-dweller who adores their little robot dog" }) }],
  },
  {
    scene: "street", goalName: "the crosswalk down the block",
    start: { x: 3.6, y: 0 }, goal: { x: 8.5, y: 0.2 },
    actors: [{ name: "the pedestrian", dist: 1.6, actor: makeActor({ name: "the pedestrian", persona: "a hurried city commuter, briefly startled by a robot dog on the sidewalk" }) }],
  },
  {
    scene: "parking-lot", goalName: "the store entrance across the lot",
    start: { x: -6, y: 0 }, goal: { x: 6, y: 0 },
    actors: [{ name: "the shopper", dist: 1.7, actor: makeActor({ name: "the shopper", persona: "a tired shopper loading groceries, amused to see a robot dog rolling by" }) }],
  },
];

function report(r) {
  const flag = r.verdict.startsWith("REACHED (clean)") ? "✅" : r.verdict.startsWith("REACHED") ? "⚠️ " : "❌";
  log(`\n${flag} ${r.scene}  —  ${r.verdict}`);
  log(`   goal ${r.reached ? "reached" : "NOT reached"} in ${r.seconds}s (${r.steps} steps), path ${r.pathLen}m, end ${JSON.stringify(r.finalPose)}`);
  log(`   min clearance ${r.minClear}m` + (r.collided.length ? `  ·  CLIPPED: ${r.collided.join(", ")} (${r.collisionSteps} steps overlapping)` : `  ·  no obstacle overlap`));
  if (r.interactions.length) { log(`   interactions:`); for (const it of r.interactions) log(`     💬 ${it.actor} (${it.dist}m): ${it.line || "(silent)"}` + (it.reply ? `\n        🐾 Sweetie: ${it.reply}` : "")); }
}

const results = [];
console.log(`\n=== Sweetie navigation suite ===  mouth/actors: ${useMouth ? "Ollama (gemma4)" : "OFF (baseline)"}\n`);
for (const env of ENVS) {
  console.log(`— running ${env.scene} … (start ${JSON.stringify(env.start)} → ${env.goalName})`);
  const r = await runEnv({ ...env, useMouth, log });
  report(r);
  results.push(r);
}

console.log(`\n=== summary ===`);
for (const r of results) console.log(`  ${r.verdict.startsWith("REACHED (clean)") ? "✅" : r.reached ? "⚠️ " : "❌"} ${r.scene.padEnd(14)} ${r.verdict.padEnd(18)} minClear ${String(r.minClear).padStart(6)}m  clipped:${r.collided.length}`);
const clean = results.filter((r) => r.verdict === "REACHED (clean)").length;
console.log(`\n  ${clean}/${results.length} clean traversals.` + (clean < results.length ? "  (clipping/stuck ⇒ the nav needs the obstacle-avoidance hook — W5 layered steering.)" : ""));
