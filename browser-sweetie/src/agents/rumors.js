// Rumors — the town's second-hand knowledge. Beyond spreading OPINIONS, bots now gossip about EACH OTHER: a
// witness in a crowded room notices a pair ("I saw A and B together") and starts a social rumour that spreads,
// mutates, and — because the ATTRIBUTION degrades faster than the content (gossip.js) — becomes "everyone's
// saying…". Aggregated, those rumours are REPUTATION: what the colony believes about you, who you're linked
// with, and whether they think well of it. Plus MEMES: a bot can coin a word/catchphrase that spreads by sheer
// exposure until it's common knowledge — the "quiz" story, emergent. All deterministic + Node-testable.

export function makeRumors({ colony, gossip, society, rng = Math.random } = {}) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const lexicon = new Map(); // token → { id, token, meaning, coiner, coinedAt } — the town's shared dictionary
  const witnessed = new Map(); // "witness|A~B|rel" → belief id — so re-noticing the SAME pairing doesn't mint a fresh rumour every round (that unbounded re-minting was a slow memory grower); a new rumour only when the relationship visibly CHANGES
  const LEX_CAP = 50;        // hard backstop on the dictionary size — the word-game mints tokens fast; without a bound (and without retiring flops) the lexicon + everyone's beliefs grow forever (the real "3-min memory leak")
  let coinSeq = 0;

  return {
    // A witness in a lobby of 3+ notices a PAIR of the others and starts a social rumour coloured by how they
    // seem to get on (their opinion-affinity is the observable proxy). Returns events (already phrased).
    witness({ chance = 0.2 } = {}) {
      const events = [];
      for (const z of colony.zones) {
        const occ = colony.inZone(z.name); if (occ.length < 3 || rng() > chance) continue;
        const w = pick(occ);
        const others = occ.filter((n) => n !== w); if (others.length < 2) continue;
        const A = pick(others), B = pick(others.filter((n) => n !== A));
        const aff = society.affinity(A, B) ?? 0.5;
        const rel = aff > 0.68 ? 1 : aff < 0.32 ? -1 : 0;
        // Don't MINT a brand-new rumour id for an observation this witness has already spread (that unbounded
        // re-minting is a slow memory grower). A repeat of the same pairing REFRESHES the existing rumour (and can
        // re-circulate + re-log) instead of adding another distinct belief. A genuinely CHANGED relationship (rel
        // flip) is a new observation → a new rumour.
        const key = `${w}|${[A, B].sort().join("~")}|${rel}`;
        const text = rel > 0 ? `${A} and ${B} are thick as thieves` : rel < 0 ? `${A} and ${B} are at odds` : `${A} and ${B} were talking`;
        const seen = witnessed.get(key);
        if (seen != null) { gossip.refresh(w, seen); }    // re-notice: bump the witness's own copy back to first-hand, no new id
        else { const b = gossip.seed(w, { text, topic: "social", about: [A, B], rel, attribution: w, fidelity: 1 }); witnessed.set(key, b.id); if (witnessed.size > 400) witnessed.delete(witnessed.keys().next().value); } // bound the dedup map (evict oldest) — a re-notice may re-mint later, acceptable churn
        events.push({ kind: "witness", from: w, about: [A, B], zone: z.name, text: `${w}: I saw ${text}` });
      }
      return events;
    },

    // What the colony believes ABOUT a bot: how widely it's talked of, who it's linked with, and net sentiment
    // (rel weighted by fidelity, deduped across holders — the best-preserved copy of each rumour counts once).
    reputation(name) {
      const best = new Map();
      for (const a of colony.agents) for (const b of gossip.know(a.name)) if (Array.isArray(b.about) && b.about.includes(name)) { const ex = best.get(b.id); if (!ex || b.fidelity > ex.fidelity) best.set(b.id, b); }
      const beliefs = [...best.values()];
      const assoc = {}; let sentiment = 0;
      for (const b of beliefs) { sentiment += (b.rel || 0) * b.fidelity; for (const o of b.about) if (o !== name) assoc[o] = (assoc[o] || 0) + 1; }
      return { mentions: beliefs.length, sentiment: +sentiment.toFixed(2), associates: Object.entries(assoc).sort((x, y) => y[1] - x[1]).map(([n]) => n) };
    },

    // Coin a word/catchphrase, optionally with a meaning. The TOKEN (a belief with a stable id) spreads virally
    // through gossip — a single token survives the broken-telephone mutation intact, so it reaches the whole town
    // (the invention of "quiz"). The MEANING is filed in the shared dictionary, which anyone new can read.
    coinMeme(botName, token, meaning = "") {
      const b = gossip.seed(botName, { text: token, topic: "meme", fidelity: 1, attribution: botName });
      lexicon.set(token, { id: b.id, token, meaning: meaning || "(no agreed meaning yet)", coiner: botName, coinedAt: ++coinSeq, status: "proposed", curatedBy: null });
      if (lexicon.size > LEX_CAP) { // backstop: evict the oldest non-official word (+ forget its belief everywhere)
        let victim = null, oldestAny = null;
        for (const [tok, e] of lexicon) {
          if (!oldestAny || e.coinedAt < oldestAny.at) oldestAny = { tok, at: e.coinedAt };
          if (e.status === "official") continue;
          if (!victim || e.coinedAt < victim.at) victim = { tok, at: e.coinedAt };
        }
        const v = victim || oldestAny; // if EVERY word is official (cap would otherwise be defeated), retire the oldest one anyway
        if (v) this.remove(v.tok);
      }
      return b;
    },
    // Retire a word: drop it from the dictionary AND forget its belief in every bot (a flopped/obsolete word).
    remove(token) { const e = lexicon.get(token); if (!e) return false; lexicon.delete(token); if (gossip.forget) gossip.forget(e.id); return true; },
    // Persist the shared DICTIONARY (part of the culture snapshot). The witnessed dedup map is an optimization —
    // not restored (it self-rebuilds); coinSeq is carried so new words don't collide.
    snapshot() { return { lexicon: [...lexicon.values()], coinSeq }; },
    restore(s) { if (!s) return; lexicon.clear(); for (const e of s.lexicon || []) lexicon.set(e.token, { ...e }); coinSeq = Math.max(coinSeq, s.coinSeq || 0); },
    define(token, meaning) { const e = lexicon.get(token); if (e && meaning) { e.meaning = meaning; return true; } return false; }, // the town refines the gloss
    // The lexicographer's edit: set a word's meaning/status and stamp who curated it.
    curate(token, { meaning, status, by } = {}) { const e = lexicon.get(token); if (!e) return false; if (meaning) e.meaning = meaning; if (status) e.status = status; if (by) e.curatedBy = by; return true; },
    entry(token) { const e = lexicon.get(token); return e ? { ...e } : null; },
    lookup(token) { const e = lexicon.get(token); return e ? { ...e } : null; },     // what a newcomer reads
    commonKnowledge(token) { let heard = 0, total = 0; for (const a of colony.agents) { total++; if (gossip.know(a.name).some((b) => b.topic === "meme" && (b.text === token || b.origin === token))) heard++; } return { token, heard, of: total, reach: +(heard / (total || 1)).toFixed(2) }; },

    // The town's shared DICTIONARY: every coined word, its meaning, its coiner, and how far it's spread — so a
    // newcomer (bot or human) can learn what the tokens mean in plain English.
    dictionary() { return [...lexicon.values()].map((e) => { const ck = this.commonKnowledge(e.token); return { token: e.token, meaning: e.meaning, coiner: e.coiner, status: e.status, curatedBy: e.curatedBy, reach: ck.reach, heard: ck.heard, of: ck.of }; }).sort((a, b) => b.reach - a.reach); },

    // Trace a word THROUGH THE NETWORK by its id: who holds it and who they caught it from (the via-graph) — so
    // you can watch it move as the colony adopts it into its language.
    spread(token) {
      const e = lexicon.get(token); if (!e) return null;
      const adopters = [], edges = [];
      for (const a of colony.agents) { const b = gossip.know(a.name).find((x) => x.id === e.id); if (b) { adopters.push({ name: a.name, from: b.via || (a.name === e.coiner ? "coined" : null), hops: b.hops }); if (b.via) edges.push({ from: b.via, to: a.name }); } }
      return { id: e.id, token: e.token, coiner: e.coiner, reach: +(adopters.length / (colony.agents.length || 1)).toFixed(2), adopters: adopters.sort((x, y) => x.hops - y.hops), edges };
    },
  };
}
