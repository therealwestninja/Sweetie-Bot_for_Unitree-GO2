// The Chronicle — the town's memory of ITSELF. Gossip/reputation/language make culture that lives BETWEEN minds
// (a word spreading, a reputation forming); the Chronicle is where the salient MOMENTS crystallize into LORE the
// town carries forward and can hand to a newcomer. This is the return-arrow that turns "a society of minds" into
// a civilization: culture that can be INHERITED, not just culture that happens. (See docs/GOALPOST.md §addendum.)
//
// It watches two streams: the society's POLARIZATION (edge-detected → a schism, or a healing) and the round's
// EVENTS (a word entering the language, a megaphone rally). Each becomes a bounded lore entry weighted by how big
// a deal it was; the town remembers its legends and forgets its trivia. Deterministic + Node-testable.

// Evocative names for the recurring economic epochs, so a town that lives through several booms/lean spells remembers
// them as distinct chapters rather than one repeated line (indexed by how many of each it has seen — deterministic).
const ERA_BOOM = ["a season of plenty", "the good years", "a boom on the street", "the fat years"];
const ERA_LEAN = ["the lean times, when work grew scarce", "a long winter for the purse", "the pinch", "hard years on the street"];

export function makeChronicle({ society, agentNames = () => [], config = {} } = {}) {
  const C = { schismAt: 0.75, healAt: 0.35, cap: 40, ...config };
  const lore = [];             // { id, kind, round, summary, who[], magnitude }
  const buffer = [];           // events observed since the last tick (word-adopted / megaphone / economy-era)
  let seq = 0, round = 0, wasSplit = false, booms = 0, leans = 0;

  function add(kind, summary, who = [], magnitude = 1) {
    const e = { id: ++seq, kind, round, summary, who, magnitude: +magnitude.toFixed(2) };
    lore.push(e);
    if (lore.length > C.cap) { // forget the least legendary moment
      let min = 0; for (let i = 1; i < lore.length; i++) if (lore[i].magnitude < lore[min].magnitude) min = i;
      lore.splice(min, 1);
    }
    return e;
  }

  return {
    lore: () => lore.map((e) => ({ ...e })),
    // The headline legends a newcomer inherits — biggest first, then most recent.
    digest: (n = 5) => [...lore].sort((a, b) => b.magnitude - a.magnitude || b.round - a.round).slice(0, n).map((e) => e.summary),
    round: () => round,

    // Persist the town's HISTORY (part of the culture snapshot), including the schism edge-state + counters.
    snapshot() { return { lore: lore.map((e) => ({ ...e })), seq, round, wasSplit, booms, leans }; },
    restore(s) { if (!s) return; lore.length = 0; for (const e of s.lore || []) lore.push({ ...e }); seq = Math.max(seq, s.seq || 0); round = Math.max(round, s.round || 0); wasSplit = !!s.wasSplit; booms = s.booms || 0; leans = s.leans || 0; },

    // Feed the emit() stream here; the Chronicle keeps only the kinds it turns into lore.
    observe(ev) { if (ev && (ev.kind === "word-adopted" || (ev.kind === "megaphone" && ev.from && ev.from !== "watch") || ev.kind === "economy-era")) buffer.push(ev); },

    // Call on the social cadence with the town's central `topic`. Edge-detects a schism/healing and drains the
    // observed events into lore. Returns the newly-minted lore events (for the log).
    tick(topic) {
      round++;
      const minted = [];
      const push = (e, text) => minted.push({ kind: "lore", from: e.who[0] || null, text, lore: e });

      // SCHISM / HEALING — record the TRANSITION (edge), not every tick it stays split.
      const pol = society.polarization(agentNames(), topic);
      if (!wasSplit && pol >= C.schismAt) { wasSplit = true; push(add("schism", `the town split over ${topic}`, [], 1.5 + pol), `✦ a schism is remembered — ${topic} tore the town in two`); }
      else if (wasSplit && pol <= C.healAt) { wasSplit = false; push(add("healing", `the town came back together over ${topic}`, [], 1.5), `✦ the town healed its rift over ${topic}`); }

      // Lore-worthy events observed this round.
      for (const ev of buffer.splice(0)) {
        if (ev.kind === "word-adopted") { const w = (String(ev.text).match(/["“]([^"”]+)["”]/) || [])[1] || "a new word"; push(add("word", `“${w}” entered the town's language`, ev.from ? [ev.from] : [], 1.4), `✦ “${w}” is now part of how the town speaks`); }
        else if (ev.kind === "megaphone") { push(add("rally", `${ev.from} once rallied the whole town`, [ev.from], 1.2), `✦ the town remembers ${ev.from} taking the megaphone`); }
        // ECONOMIC ERA — the business cycle's booms and lean spells become inherited history (lean times remembered harder).
        else if (ev.kind === "economy-era") { const boom = ev.label === "boom"; const name = boom ? ERA_BOOM[booms++ % ERA_BOOM.length] : ERA_LEAN[leans++ % ERA_LEAN.length]; push(add("era", `the town lived through ${name}`, [], boom ? 1.3 : 1.5), `✦ an age passes into memory — ${name}`); }
      }
      return minted;
    },
  };
}
