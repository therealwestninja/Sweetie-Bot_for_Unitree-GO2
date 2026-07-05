// Society — the MINDS the colony was missing. It turns the messages the channels move (booth / gossip /
// megaphone) into OPINIONS, and opinions into ALLIANCES. This is the deterministic core of the flywheel:
// a bot absorbs a belief → its stance on that topic shifts → its affinity to like-minded bots rises →
// tribes emerge → homophily pulls the tribe physically together → they talk more → … No LLM required; an
// Ollama voice is pure flavour on top. Everything here is measurable, which is the point: you can watch
// tribes crystallise and read a polarization number, not just vibes.
import { clamp } from "../mathutil.js";

export function makeSociety({ openness = () => 0.35, classOf = () => null, classWeight = 0, classScale = 20 } = {}) {
  const op = new Map(); // bot -> Map(topic -> { stance, confidence })
  const of = (bot) => { if (!op.has(bot)) op.set(bot, new Map()); return op.get(bot); };
  const opennessOf = (bot) => (typeof openness === "function" ? openness(bot) : openness);
  // CLASS SOLIDARITY (optional): two bots of similar wealth feel kinship, very different wealth feels distance. Folded
  // into affinity so tribes + homophily migration partly sort along economic lines — the rich and poor drift apart and
  // physically separate. classOf(bot) → a net-worth number (or null = unknown); classWeight 0 (default) makes it inert.
  const classSim = (a, b) => { const wa = classOf(a), wb = classOf(b); if (wa == null || wb == null) return null; return clamp(1 - Math.abs(wa - wb) / classScale, 0, 1); };

  return {
    // Fold a received belief into the bot's opinion. Influence = belief.fidelity (how strongly/clearly it
    // arrived — decays down the gossip chain) × the bot's openness (a personality trait: stubborn vs suggestible).
    // Confidence accrues toward 1; stance is a confidence-weighted running mean → repeated/strong input wins.
    absorb(bot, belief) {
      if (!belief || belief.topic == null) return;
      const m = of(bot);
      const cur = m.get(belief.topic) || { stance: 0, confidence: 0 };
      const w = clamp((belief.fidelity ?? 1) * opennessOf(bot), 0, 1);
      if (w <= 0) return;
      const denom = cur.confidence + w;
      const stance = denom > 0 ? (cur.stance * cur.confidence + (belief.stance ?? 0) * w) / denom : (belief.stance ?? 0);
      m.set(belief.topic, { stance: clamp(stance, -1, 1), confidence: clamp(cur.confidence + w * (1 - cur.confidence), 0, 1) });
    },

    // Confidence DECAY — the anti-calcification damper. absorb() only ever RAISES confidence (monotonic toward 1), so
    // once convinced a bot is permanently stubborn and the town can freeze into rigid opinion castes — an echo chamber
    // that can never re-mix. Eroding confidence a little each social round reopens minds: actively-reinforced opinions
    // stay firm (absorb rebuilds them), abandoned ones soften back toward openness. STANCE is untouched — the bot still
    // leans the same way, it just holds it less tightly and can be moved again. Below `floor` the opinion is dropped.
    decay({ rate = 0.008, floor = 0.04 } = {}) {
      for (const m of op.values()) for (const [t, o] of m) { o.confidence -= rate; if (o.confidence <= floor) m.delete(t); }
    },

    opinion(bot, topic) { return of(bot).get(topic) || { stance: 0, confidence: 0 }; },
    opinions(bot) { return Object.fromEntries(of(bot)); },
    topics() { const s = new Set(); for (const m of op.values()) for (const t of m.keys()) s.add(t); return [...s]; },

    // Persist the town's collective OPINIONS (part of the culture snapshot) so they survive a rebuild/reload.
    snapshot() { const out = {}; for (const [bot, m] of op) out[bot] = Object.fromEntries(m); return out; },
    restore(s) { if (!s) return; op.clear(); for (const [bot, topics] of Object.entries(s)) { const m = new Map(); for (const [t, v] of Object.entries(topics)) m.set(t, { stance: v.stance, confidence: v.confidence }); op.set(bot, m); } },

    // How aligned two bots are over the topics they BOTH hold an opinion on: 1 = identical, 0 = opposite,
    // confidence-weighted. Returns null when they share no topics (no basis for alliance).
    affinity(a, b) {
      const ma = of(a), mb = of(b); let wsum = 0, agree = 0;
      for (const [t, oa] of ma) { const ob = mb.get(t); if (!ob) continue; const w = Math.min(oa.confidence, ob.confidence); if (w <= 0) continue; wsum += w; agree += w * (1 - Math.abs(oa.stance - ob.stance) / 2); }
      const opAff = wsum > 0 ? agree / wsum : null;
      const cls = classWeight > 0 ? classSim(a, b) : null;      // class solidarity, if wealth is known and weighted in
      if (opAff == null) return cls;                            // no shared opinions → class is the only basis (or null)
      if (cls == null) return opAff;                            // no class signal → pure opinion agreement
      return clamp(opAff * (1 - classWeight) + cls * classWeight, 0, 1); // blend: opinion agreement, tilted by class
    },

    // Tribes = connected components of the graph where an edge exists iff affinity ≥ threshold (union-find).
    tribes(bots, threshold = 0.62) {
      const parent = new Map(bots.map((b) => [b, b]));
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const union = (x, y) => { parent.set(find(x), find(y)); };
      for (let i = 0; i < bots.length; i++) for (let j = i + 1; j < bots.length; j++) { const a = this.affinity(bots[i], bots[j]); if (a != null && a >= threshold) union(bots[i], bots[j]); }
      const groups = new Map();
      for (const b of bots) { const r = find(b); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b); }
      return [...groups.values()].sort((x, y) => y.length - x.length);
    },

    // A bot's cause: the topic it feels most strongly + confidently about (its manifesto/megaphone seed).
    advocacy(bot) {
      let best = null;
      for (const [topic, o] of of(bot)) { const strength = Math.abs(o.stance) * o.confidence; if (!best || strength > best.strength) best = { topic, stance: o.stance, confidence: o.confidence, strength: +strength.toFixed(3) }; }
      return best;
    },

    // --- metrics (so we can SEE the dynamics) ---
    // Polarization on a topic: mean absolute deviation of stances weighted by confidence (0 = consensus,
    // →1 = split camps). Only counts bots that actually hold an opinion.
    polarization(bots, topic) {
      const held = bots.map((b) => of(b).get(topic)).filter((o) => o && o.confidence > 0.05);
      if (held.length < 2) return 0;
      const mean = held.reduce((s, o) => s + o.stance * o.confidence, 0) / held.reduce((s, o) => s + o.confidence, 0);
      return +(held.reduce((s, o) => s + o.confidence * Math.abs(o.stance - mean), 0) / held.reduce((s, o) => s + o.confidence, 0)).toFixed(3);
    },
    consensus(bots, topic) { const held = bots.map((b) => of(b).get(topic)).filter((o) => o && o.confidence > 0.05); return held.length ? +(held.reduce((s, o) => s + o.stance, 0) / held.length).toFixed(3) : 0; },
  };
}
