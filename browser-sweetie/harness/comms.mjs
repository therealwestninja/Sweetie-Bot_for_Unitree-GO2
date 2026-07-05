// Communication-layer demo (mock hooks, no Ollama/human): a knight visits the user booth, carries the user's
// words back, they spread by broken-telephone through the hall, and then a lottery-winner takes the megaphone
// and blasts a manifesto to everyone verbatim. Shows the CONTRAST: gossip degrades, the megaphone doesn't.
//   node harness/comms.mjs
import { makeColony } from "../src/agents/colony.js";
import { makeGossip } from "../src/agents/gossip.js";
import { makeBooth } from "../src/agents/booth.js";
import { makeMegaphone } from "../src/agents/megaphone.js";

const KN = ["arthur", "lancelot", "gawain", "percival", "mordred"];
const zones = [
  { name: "booth", x: 0, y: 3.4, radius: 1.0, purpose: "meet the user (one at a time)" },
  { name: "hall", x: 0, y: -3.0, radius: 1.6, purpose: "mingle + trade news" },
];
const colony = makeColony({ statics: [{ name: "table", x: 0, y: 0, radius: 0.7 }], zones, bots: KN.map((name, i) => ({ name, curiosity: 0.9 - i * 0.15, pose: { x: -3 + i * 1.5, y: 0 } })) });
const gossip = makeGossip();

let t = 0;
const booth = makeBooth({ colony, gossip, boothZone: colony.zoneByName("booth"),
  introOf: (b) => `${b.name} knocks: "Good user, a word?"`,
  onUser: () => ({ action: "reply", text: "the grail rests beneath the old chapel floor, guarded by a riddle" }), now: () => t });

const megaphone = makeMegaphone({ now: () => t, cooldownMs: 5000, rng: () => 0.42, gossip,
  compose: (w) => `${w.name} on the megaphone: "Knights! Our true quest is the grail — rally to me at dawn."` });

console.log("\n=== Communication layer — booth · gossip · megaphone ===\n");

// 1) One knight visits the booth and hears the user
let visitor = null;
for (let i = 0; i < 500 && !visitor; i++) { const r = await booth.tick(); if (r.phase === "released") visitor = r.freed; for (let k = 0; k < 12; k++) { t += 20; colony.tick(0.02); } }
const heard = gossip.know(visitor).find((x) => x.source === "the user");
console.log(`▸ ${visitor} visited the booth. The user told them (first-hand, fidelity ${heard.fidelity}):`);
console.log(`    "${heard.text}"`);
console.log(`  (the other knights only KNOW a meeting happened — awareness log: ${booth.awarenessLog().map((a) => a.bot).join(", ")})\n`);

// 2) Broken telephone: the visitor whispers it down a chain of knights
console.log("▸ word of mouth (each retelling loses a little):");
const chain = [visitor, ...KN.filter((k) => k !== visitor)];
for (let i = 0; i < chain.length - 1; i++) {
  const got = gossip.relay(chain[i], chain[i + 1], { decay: 0.22 });
  if (got) console.log(`    ${chain[i]} → ${chain[i + 1]} (fidelity ${got.fidelity}): "${got.text}"`);
}

// 3) The megaphone: charge it, run the lottery, blast everyone verbatim
console.log("\n▸ the megaphone charges…");
t += 5000;
const blast = await megaphone.fire(KN.map((name) => ({ name })));
console.log(`    🏆 lottery winner: ${blast.winner}`);
console.log(`    📣 heard IDENTICALLY by all + the user: "${blast.message}"`);

console.log("\n=== who knows the user's secret, and how mangled ===");
for (const k of KN) { const b = gossip.know(k).find((x) => x.topic === "from-the-user"); console.log(`   ${k.padEnd(9)} ${b ? `(fid ${b.fidelity}, ${b.hops} hops): "${b.text}"` : "— hasn't heard the rumour —"}`); }
console.log("");
