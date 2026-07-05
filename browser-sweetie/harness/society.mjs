// C1 payoff demo — the whole flywheel, deterministic (no Ollama): the user seeds a divisive idea at the booth,
// it spreads by gossip and hardens two camps, homophily pulls them into separate halls (tribes go physical),
// then a megaphone blast cuts across the divide and reshuffles allegiances. Watch polarization + tribes move.
//   node harness/society.mjs
import { makeColony } from "../src/agents/colony.js";
import { makeSociety } from "../src/agents/society.js";
import { makeGossip } from "../src/agents/gossip.js";
import { makeMegaphone } from "../src/agents/megaphone.js";
import { applyHomophily } from "../src/agents/homophily.js";

const TOPIC = "the-quest";
const zones = [
  { name: "forge", x: -3.4, y: 0, radius: 1.3, purpose: "plans" },
  { name: "garden", x: 3.4, y: 0, radius: 1.3, purpose: "rest" },
  { name: "hall", x: 0, y: -3.4, radius: 1.3, purpose: "mingle" },
];
const KN = ["arthur", "percival", "galahad", "mordred", "kay", "bors"];
const colony = makeColony({ statics: [{ name: "table", x: 0, y: 0, radius: 0.7 }], zones, bots: KN.map((name, i) => ({ name, pose: { x: -2.5 + i * 1.0, y: 1.6 } })) });
// openness varies by knight (stubborn ↔ suggestible) — deterministic
const openMap = { arthur: 0.5, percival: 0.45, galahad: 0.4, mordred: 0.5, kay: 0.55, bors: 0.5 };
const society = makeSociety({ openness: (b) => openMap[b] ?? 0.4 });
const gossip = makeGossip();
let t = 0;
const megaphone = makeMegaphone({ now: () => t, cooldownMs: 1000, rng: () => 0, gossip });

const settle = (cap = 4000) => { for (let i = 0; i < cap; i++) { t += 20; colony.tick(0.02); if (colony.allArrived()) break; } };
const learn = (bot, b) => { if (b) society.absorb(bot, b); return b; };

// two opinion leaders in two halls, each with two (initially neutral) followers
["arthur", "percival", "galahad"].forEach((k) => colony.sendTo(k, "forge"));
["mordred", "kay", "bors"].forEach((k) => colony.sendTo(k, "garden"));
settle();
learn("arthur", gossip.seed("arthur", { topic: TOPIC, stance: 0.9, text: "the grail is our true quest", source: "the user" }));
learn("mordred", gossip.seed("mordred", { topic: TOPIC, stance: -0.9, text: "forget the grail — defend the realm", source: "the user" }));

function gossipRound() {
  for (const z of zones) { const occ = colony.inZone(z.name); for (let i = 0; i < occ.length - 1; i++) learn(occ[i + 1], gossip.relay(occ[i], occ[i + 1], { decay: 0.18 })); }
}
function homophilyRound() { const m = applyHomophily(colony, society, { margin: 0.05 }); settle(); return m; }
function show(label) {
  const lob = colony.lobbies();
  const tribes = society.tribes(KN).map((t) => t.join("+"));
  console.log(`\n▸ ${label}`);
  for (const z of zones) console.log(`   ${z.name.padEnd(7)}: ${(lob[z.name] || []).map((n) => `${n}(${society.opinion(n, TOPIC).stance.toFixed(2)})`).join(", ") || "—"}`);
  console.log(`   polarization ${society.polarization(KN, TOPIC)}  ·  consensus ${society.consensus(KN, TOPIC)}  ·  tribes: ${tribes.join("  |  ")}`);
}

console.log(`\n=== The schism — a colony forms tribes around "${TOPIC}" ===`);
show("seeded: arthur heard the user (pro-grail), mordred heard the user (anti)");
for (let r = 1; r <= 3; r++) { gossipRound(); homophilyRound(); show(`round ${r}: word spreads + homophily`); }

// a megaphone cuts across the divide
t += 1000;
const blast = await megaphone.fire(KN.map((name) => ({ name })), { });
KN.forEach((k) => learn(k, gossip.know(k).find((x) => x.topic === "megaphone"))); // everyone absorbs it
// give the megaphone a real stance (arthur rallying the grail) so it moves opinions
KN.forEach((k) => society.absorb(k, { topic: TOPIC, stance: 0.9, fidelity: 1 }));
show(`📣 MEGAPHONE — ${blast.winner} blasts everyone (verbatim, fidelity 1) to rally for the grail`);
for (let r = 4; r <= 6; r++) { gossipRound(); homophilyRound(); show(`round ${r}: after the blast`); }

console.log(`\n=== final allegiances ===`);
for (const tribe of society.tribes(KN)) console.log(`   tribe: ${tribe.map((n) => `${n}(${society.opinion(n, TOPIC).stance.toFixed(2)})`).join(", ")}`);
console.log("");
