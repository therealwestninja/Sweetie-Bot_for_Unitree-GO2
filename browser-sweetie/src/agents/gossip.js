// Gossip substrate — what each bot KNOWS, and how knowledge spreads person-to-person and DEGRADES on the way
// (the broken-telephone game). A belief keeps a stable `id` across hops so we can tell who's heard a rumour,
// while its `text`/`fidelity` mutate each retelling. This is the local, lossy channel — the opposite of the
// megaphone's pristine global blast. The actual re-wording is an injected `mutate` (Ollama in the browser); the
// default is a deterministic word-drop so tests are stable and the degradation is visible without a model.

function defaultMutate(text, fidelity) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const keep = Math.max(1, Math.round(words.length * Math.max(0.25, fidelity))); // fewer words survive as trust drops
  if (keep >= words.length) return text;
  return words.slice(0, keep).join(" ") + " …";
}

export function makeGossip({ mutate = defaultMutate } = {}) {
  let seq = 0;
  const mem = new Map(); // botName -> Map(id -> belief)
  const BELIEF_CAP = 120; // a mind holds only so many rumours. Meme/social rumours self-retire (forget/dedup), but plain opinion/fact/broadcast beliefs never did → over a long interactive run (booth facts, megaphone blasts) a bot's store grew without bound. Evict the OLDEST (Map insertion order) so recent first-hand facts survive.
  const of = (bot) => { if (!mem.has(bot)) mem.set(bot, new Map()); return mem.get(bot); };
  // keep a belief only if it's new or higher-fidelity than what the bot already holds for that id
  const put = (bot, b) => { const m = of(bot); const ex = m.get(b.id); if (!ex || b.fidelity > ex.fidelity) { m.set(b.id, b); if (!ex && m.size > BELIEF_CAP) m.delete(m.keys().next().value); return true; } return false; };

  return {
    // A bot learns something first-hand (e.g. straight from the user at the booth) → fidelity 1, hop 0.
    // `stance` ∈ [-1,1] is the position the belief takes on its topic (0 = a neutral fact); the society layer
    // folds it into opinions. Fidelity doubles as "how strongly it's held" and decays down the gossip chain.
    // `about` = the subject (a bot / a pair) for SOCIAL rumours; `attribution` = who it's ascribed to (degrades
    // down the chain, source forgotten before content). Both default sensibly for plain first-hand facts.
    seed(bot, { text, source = bot, topic = "rumor", stance = 0, fidelity = 1, about = null, attribution = null, rel = 0 }) {
      const b = { id: ++seq, text, origin: text, source, topic, stance, fidelity, hops: 0, via: null, about, attribution: attribution || source, rel };
      put(bot, b); return b;
    },
    // Everyone hears the SAME thing at once, verbatim (the megaphone). Returns the belief.
    broadcast({ text, source, topic = "broadcast", stance = 0, fidelity = 1 }, bots) {
      const b0 = { id: ++seq, text, origin: text, source, topic, stance, fidelity, hops: 0, via: source };
      for (const bot of bots) put(bot, { ...b0 }); return b0;
    },
    know(bot) { return [...of(bot).values()]; },
    knows(bot, id) { return of(bot).has(id); },
    // Re-notice something first-hand: reset an existing belief the bot holds back to fidelity 1 / hop 0, WITHOUT
    // minting a new id. Lets a repeated observation re-circulate (and re-log) without growing the belief store.
    refresh(bot, id) { const b = of(bot).get(id); if (b) { b.fidelity = 1; b.hops = 0; return true; } return false; },
    // Erase a belief EVERYWHERE (every bot forgets it). Used to retire a coined word that flopped / went obsolete
    // so dead rumours don't pile up in every store forever. Returns how many bots held it.
    forget(id) { let n = 0; for (const m of mem.values()) if (m.delete(id)) n++; return n; },

    // Time-decay for SOCIAL rumours (reputation). A witness sighting ("A and B are at odds") never decays the way
    // passed-along gossip does (that's chain fidelity, not time), so it would color a bot's reputation FOREVER —
    // the town's belief is never disconfirmed, a permanent echo chamber. Aging fades a rumour that isn't reinforced
    // (a re-witness → refresh() resets it to 1, or a re-relay); below `floor` it's forgotten. So reputation
    // MEAN-REVERTS toward neutral unless the town keeps re-observing it. Scoped to `social` — opinions/facts/memes/
    // broadcasts keep their own lifecycles. Call on the social cadence. Returns how many beliefs faded out.
    age({ rate = 0.03, floor = 0.12, topics = ["social"] } = {}) {
      let faded = 0;
      for (const m of mem.values()) for (const [id, b] of m) { if (!topics.includes(b.topic)) continue; b.fidelity -= rate; if (b.fidelity < floor) { m.delete(id); faded++; } }
      return faded;
    },

    // Persist the raw belief substrate (part of the culture snapshot). `seq` is carried so restored ids don't
    // collide with freshly-minted ones after a reload.
    snapshot() { const beliefs = {}; for (const [bot, m] of mem) beliefs[bot] = [...m.values()]; return { beliefs, seq }; },
    restore(s) { if (!s) return; mem.clear(); for (const [bot, arr] of Object.entries(s.beliefs || {})) { const m = new Map(); for (const b of arr) m.set(b.id, b); mem.set(bot, m); } seq = Math.max(seq, s.seq || 0); },
    heardCount(id) { let n = 0; for (const m of mem.values()) if (m.has(id)) n++; return n; },
    // Per-rumour spread summary (for instrumentation): who's heard each rumour, and how degraded it's gotten
    // (avgFidelity = the broken-telephone signal). Sorted by reach.
    rumorStats() {
      const agg = new Map();
      for (const m of mem.values()) for (const b of m.values()) {
        let a = agg.get(b.id); if (!a) { a = { id: b.id, origin: b.origin, topic: b.topic, source: b.source, holders: 0, fidSum: 0 }; agg.set(b.id, a); }
        a.holders++; a.fidSum += b.fidelity;
      }
      return [...agg.values()].map((a) => ({ id: a.id, origin: a.origin, topic: a.topic, source: a.source, holders: a.holders, avgFidelity: +(a.fidSum / a.holders).toFixed(2) })).sort((x, y) => y.holders - x.holders);
    },

    // `from` tells `to` the juiciest thing `to` doesn't already know (or knows worse) — mutated + decayed.
    // Returns the belief `to` received, or null if there was nothing new to pass on.
    relay(from, to, { decay = 0.2 } = {}) {
      let pick = null;
      for (const b of of(from).values()) {
        const t = of(to).get(b.id);
        if ((!t || b.fidelity - decay > t.fidelity) && (!pick || b.fidelity > pick.fidelity)) pick = b;
      }
      if (!pick) return null;
      const fidelity = Math.max(0, +(pick.fidelity - decay).toFixed(3));
      // attribution degrades: the FIRST retelling names who told you; deeper/low-trust → the source is forgotten
      // ("someone's saying") well before the content is. That's how "I saw" becomes "everyone knows".
      const attribution = pick.hops === 0 ? from : (fidelity < 0.5 ? "someone" : pick.attribution);
      const nb = { ...pick, text: mutate(pick.text, fidelity), fidelity, hops: pick.hops + 1, via: from, attribution };
      return put(to, nb) ? nb : null;
    },

    // Render a belief the way a bot would SAY it — first-hand vs second-hand, with the (degraded) attribution.
    phrase(b) {
      if (!b) return "";
      if (b.hops === 0) return b.about ? `I saw ${b.text}` : b.text;
      return b.attribution && b.attribution !== "someone" ? `${b.attribution} says ${b.text}` : `someone's saying ${b.text}`;
    },
  };
}
