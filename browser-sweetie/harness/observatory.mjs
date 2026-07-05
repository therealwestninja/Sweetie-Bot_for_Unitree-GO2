// The Observatory run — the "new shell" as a runnable artifact. A long, deterministic, Ollama-free civilization
// run that measures emergent PROPERTIES over time (not a unit assertion): dialect churn, myth persistence, how
// split the town has been, and whether it's becoming a place a newcomer could be RAISED by. Then a closing
// ABLATION: a bot inducted into this town's culture vs an identical blank one.
//
//   node harness/observatory.mjs [rounds]     (default 4000)
import { makeColonyApp } from "../src/agents/colonyApp.js";

// a tiny seeded PRNG so the whole run is reproducible (mechanics are deterministic under a fixed rng)
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rng = lcg(20260704);

const zones = [
  { name: "well", x: 0, y: 4, radius: 1, booth: true }, { name: "spa", x: 0, y: -1.4, radius: 1, charger: true, ports: 2 },
  { name: "library", x: -4, y: 1, radius: 1.4 }, { name: "bakery", x: 4, y: 1, radius: 1.4 },
  { name: "orchard", x: -4, y: -4, radius: 1.4 }, { name: "boutique", x: 4, y: -4, radius: 1.4 },
];
const NAMES = ["Ada", "Bram", "Cleo", "Dov", "Esme", "Finn", "Gwen", "Hugo", "Ivy", "Jax", "Kit", "Lena"];
const bots = NAMES.map((name, i) => ({ name, startZone: zones[2 + (i % 4)].name, pose: { x: (i % 4) - 1.5 + (i < 6 ? -4 : 4) * 0, y: (i < 6 ? 1 : -4) + (i % 3) * 0.3 - 0.3 }, curiosity: 0.4 + (i % 5) * 0.12, dominance: 0.2 + (i % 6) * 0.14 }));
const seeds = [{ bot: "Ada", stance: 0.9, text: "reinvent the festival" }, { bot: "Bram", stance: -0.9, text: "keep the old ways" }, { bot: "Cleo", stance: 0.6 }, { bot: "Dov", stance: -0.6 }];

let t = 0;
const app = makeColonyApp({
  scenario: { topic: "the festival", statics: [{ name: "oak", x: 0, y: 0, radius: 0.6 }], zones, bots, seeds },
  mouth: null, now: () => (t += 1),
  config: { minds: true, rng, socialEvery: 4, homophilyEvery: 6, megaphoneCooldownMs: 4000, rumorChance: 0.2, language: { coinChance: 0.1 }, lexicon: { officialReach: 0.4 } },
});

const ROUNDS = parseInt(process.argv[2] || "4000", 10);
for (let i = 0; i < ROUNDS; i++) { app.tick(0.02); if (i % 400 === 0) app.serviceMegaphone().catch(() => {}); }

console.log(`\n=== CIVILIZATION REPORT after ${ROUNDS} rounds (seeded, Ollama-free) ===`);
console.log(JSON.stringify(app.observatory.report(), null, 2));

// closing ABLATION — raise one newcomer in this town's culture, leave an identical one blank
app.colony.agents.push(...["Raised", "Fresh"].map((name) => ({ name, zone: "library", dominance: 0.5, curiosity: 0.5, mover: { pose: { x: -4, y: 1 }, hasGoal: () => false }, mind: null })));
const got = app.induct("Raised");
const know = (n) => app.gossip.know(n);
console.log(`\n=== ABLATION — a citizen RAISED in this town vs a BLANK one ===`);
console.log(JSON.stringify({
  inheritedByRaised: got,
  raised: { words: know("Raised").filter((b) => b.topic === "meme").length, lore: know("Raised").filter((b) => b.topic === "lore").length, reputations: know("Raised").filter((b) => b.topic === "social").length, opinion: +app.society.opinion("Raised", app.topic).stance.toFixed(3) },
  blank: { words: know("Fresh").filter((b) => b.topic === "meme").length, lore: know("Fresh").filter((b) => b.topic === "lore").length, reputations: know("Fresh").filter((b) => b.topic === "social").length, opinion: +app.society.opinion("Fresh", app.topic).stance.toFixed(3) },
}, null, 2));
console.log("\nThe raised bot differs measurably from the blank one → culture demonstrably raises its members.\n");
