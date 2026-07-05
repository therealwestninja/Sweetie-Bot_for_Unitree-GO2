// Lobby conversations — the LLM social payoff. Gossip (gossip.js) spreads opinion VECTORS with a text label;
// this makes co-located townsfolk actually TALK: a short, in-character, turn-based exchange about the topic,
// routed through the shared mouth/scheduler so it stays gentle (one conversation in flight, a per-lobby
// cooldown). Afterwards each speaker drifts a little toward the other's view — hearing a confident argument
// moves you, weighted by your own openness (society.absorb). So opinions shift from real dialogue, not just
// number-passing. Deterministic-safe: with no mouth it no-ops; the shift only happens on a real exchange.

import { stripSelfName } from "./textStream.js";

const stanceWord = (s) => (s > 0.3 ? "strongly for shaking up the festival" : s > 0.05 ? "leaning toward changing the festival" : s < -0.3 ? "strongly for keeping the old traditions" : s < -0.05 ? "leaning toward tradition" : "genuinely torn");

export function makeLobbyChat({ colony, society, persona, mouth, topic, now = () => 0, config = {} } = {}) {
  // dominanceSharpness = how MUCH dominance decides who leads: 0 → it doesn't (coin-flip, egalitarian town),
  // high → a hierarchy (the 0.99-dom almost always opens, the 0.99-sub almost never). That's the compressible/
  // scalable knob; each bot's own `dominance` ∈ [0,1] is its position on the axis (default 0.5, an even town).
  // turns = how many lines the debate runs (each side speaks turns/2 times) — the multi-turn ARC, not a fixed
  // 2-shot; convergeEps = if the two positions get this close they've "found common ground" and stop early;
  // onLine(lobbyName,{who,text}) fires per completed turn so the exchange can unfold turn-by-turn in the UI.
  const C = { cooldownMs: 16000, pull: 0.16, dominanceSharpness: 4, turns: 4, convergeEps: 0.28, onLine: null, rng: Math.random, ...config };
  const lastAt = new Map();   // lobbyName -> ts of last conversation
  let busy = false;

  const dominanceOf = (n) => { const a = colony && colony.agents.find((x) => x.name === n); return (a && a.dominance != null) ? a.dominance : 0.5; };

  // The most-opposed pair present → an actual debate (falls back to any two).
  function pickPair(names) {
    const ranked = names.map((n) => ({ n, s: society.opinion(n, topic).stance })).sort((a, b) => a.s - b.s);
    return [ranked[0].n, ranked[ranked.length - 1].n];
  }

  // WHO OPENS is decided by dominance, as a weighted draw (softmax of dominance·sharpness) — a spectrum, not a
  // fixed leader. A near-total dom takes the floor almost every time; two equals are a coin-flip. Returns
  // [initiator, responder] + p (the initiator's probability, for introspection/tests).
  function pickInitiator(a, b, rng = C.rng) {
    const k = C.dominanceSharpness, wa = Math.exp(k * dominanceOf(a)), wb = Math.exp(k * dominanceOf(b));
    const p = wa / (wa + wb);
    return rng() < p ? { initiator: a, responder: b, p: +p.toFixed(3) } : { initiator: b, responder: a, p: +(1 - p).toFixed(3) };
  }
  // How much you YIELD in an argument: you cave more to someone more dominant than you, dig in against a lesser.
  const yieldFactor = (self, other) => Math.max(0.1, Math.min(1.6, 0.6 + (dominanceOf(other) - dominanceOf(self)) * 1.4));
  const tone = (n) => { const d = dominanceOf(n); return d > 0.66 ? "You are assertive and used to leading the room." : d < 0.34 ? "You are soft-spoken and tend to defer." : "You are even-keeled."; };
  const moodOf = (n) => { const a = colony && colony.agents.find((x) => x.name === n); return (a && a.mind && a.mind.mood) ? a.mind.mood() : null; };
  // Mood COLOURS the voice — the neurochemistry finally reaches what a bot SAYS, not just what it does. A depressed bot
  // speaks flat and low; an agitated one is tense and short; a buoyant one is warm. Empty near baseline (or with no
  // psyche) so it doesn't clutter the prompt. THIS is what makes a lesion audible, not just a number on a chart.
  const moodClause = (n) => { const m = moodOf(n); if (!m) return ""; const v = m.valence, ar = m.arousal; let f = "";
    if (v > 0.25) f = ar > 0.55 ? "Right now you feel buoyant, almost elated" : "Right now you feel content and warm";
    else if (v < -0.25) f = ar > 0.55 ? "Right now you feel agitated and on edge — tense and short-fused" : "Right now you feel low and flat, drained of energy";
    else if (ar > 0.62) f = "Right now you feel restless and keyed-up";
    return f ? f + ", and it colours how you speak. " : ""; };

  return {
    ready(lobbyName, t = now()) { return !busy && !!mouth && t - (lastAt.get(lobbyName) ?? -Infinity) >= C.cooldownMs; },
    isBusy: () => busy,
    dominanceOf, pickInitiator, yieldFactor, moodClause,   // exposed so the dominance + mood dynamics are inspectable/testable without the LLM

    // Run a multi-turn debate in `lobbyName` among `names` (>=2): the most-opposed pair take turns arguing, and
    // after EACH line the listener drifts toward the speaker's current stance — so positions move turn by turn and
    // the more dominant voice (who yields less) gradually wins. They stop early if they FIND COMMON GROUND. Async
    // via the mouth; returns { pair, lines:[{who,text}], turns, converged, shifted:{a,b} } or null.
    async chat(lobbyName, names) {
      if (busy || !mouth || names.length < 2) return null;
      busy = true;
      try {
        const pair = pickPair(names);
        const { initiator: a, responder: b } = pickInitiator(pair[0], pair[1]); // dominance decides who opens
        const order = [a, b];
        const sysFor = (n) => `${persona[n]} ${tone(n)} ${moodClause(n)}On ${topic}, you are ${stanceWord(society.opinion(n, topic).stance)}. Speak one short line, in character, in first person — no stage directions.`;
        const lines = [];
        let converged = false;
        for (let turn = 0; turn < C.turns; turn++) {
          const speaker = order[turn % 2], listener = order[(turn + 1) % 2];
          const os = society.opinion(speaker, topic); // the speaker argues from where they stand RIGHT NOW (it drifts as the debate goes)
          const user = turn === 0
            ? `You take the floor, chatting with ${listener} in the ${lobbyName}. Share your view on ${topic}.`
            : `${lines[turn - 1].who} just said: "${lines[turn - 1].text}". Reply in your own words, holding or softening your view on ${topic}.`;
          const onChunk = C.onLobbyChunk ? (c) => C.onLobbyChunk(lobbyName, speaker, c.fullTextSoFar) : null;
          const raw = await mouth.generate({ system: sysFor(speaker), messages: [{ role: "user", content: user }], priority: mouth.PRIORITY.lobby, tag: `lobby:${speaker}`, onChunk });
          const ln = { who: speaker, text: stripSelfName(String(raw || "").trim(), speaker) }; // drop a leading "Name:" the model echoes
          lines.push(ln);
          if (C.onLine) C.onLine(lobbyName, ln); // let the UI show the exchange unfold line-by-line
          // the LISTENER is moved by what they just heard — weighted by the speaker's conviction AND by who's
          // dominant (the sub yields more). Applied every turn, so a long argument shifts opinions more than a short one.
          society.absorb(listener, { topic, stance: os.stance, fidelity: C.pull * (os.confidence || 0.5) * yieldFactor(listener, speaker) });
          if (turn >= 1 && Math.abs(society.opinion(a, topic).stance - society.opinion(b, topic).stance) < C.convergeEps) { converged = true; break; } // found common ground → wrap up early (but always at least one real back-and-forth)
        }
        if (colony) for (const n of [a, b]) { const ag = colony.agents.find((x) => x.name === n); if (ag && ag.mind) ag.mind.onChat(); }

        lastAt.set(lobbyName, now());
        return { pair: [a, b], lines, turns: lines.length, converged, shifted: { a: society.opinion(a, topic).stance, b: society.opinion(b, topic).stance } };
      } finally { busy = false; }
    },
  };
}
