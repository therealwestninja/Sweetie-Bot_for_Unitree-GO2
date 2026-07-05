// The Lexicographer — a bot with a JOB: keeping the town's dictionary. Coining (language.js) throws words into
// the world; someone has to decide which ones are real. Each grooming pass the keeper walks the lexicon and:
//   • promotes a word the town has actually taken up (reach ≥ officialReach) to "official" — and, if it still has
//     no agreed meaning, records a provisional gloss so a newcomer can read what it means;
//   • retires a word that was coined, sat there, and never caught on ("obsolete");
//   • leaves a once-official word alone even if it later fades — it's part of the language now.
// Doing the job well is quietly satisfying (a little "purpose" to the keeper's mood). Deterministic + testable.

export function makeLexicographer({ colony, rumors, agentOf = () => null, config = {} } = {}) {
  const C = { officialReach: 0.5, obsoleteAfter: 12, ...config };
  const firstSeen = new Map();   // token → the grooming round we first noticed it (for the obsolete clock)
  let rounds = 0;

  // Who holds the post: a bot flagged for it, else the calmest (least-curious) soul — a natural archivist.
  function chooseKeeper() {
    const flagged = colony.agents.find((a) => a.lexicographer || a.role === "lexicographer");
    if (flagged) return flagged.name;
    const byCalm = [...colony.agents].sort((a, b) => (a.curiosity ?? 0.5) - (b.curiosity ?? 0.5));
    return byCalm.length ? byCalm[0].name : null;
  }
  let keeper = chooseKeeper();
  const provisionalGloss = (w) => `a bit of ${w.coiner}'s coinage, now heard all over town`;

  return {
    keeper: () => keeper,
    setKeeper(name) { if (colony.agents.some((a) => a.name === name)) keeper = name; },

    // One grooming pass. Returns events (kind "lexicon").
    tick() {
      rounds++; const events = [];
      if (!keeper) { keeper = chooseKeeper(); if (!keeper) return events; }
      let worked = 0;
      const live = new Set();
      for (const w of rumors.dictionary()) {
        const e = rumors.entry(w.token); if (!e) continue;
        live.add(w.token);
        if (!firstSeen.has(w.token)) firstSeen.set(w.token, rounds);

        if (w.reach >= C.officialReach && e.status !== "official") {
          const gloss = /no agreed meaning/i.test(e.meaning) ? provisionalGloss(w) : e.meaning;
          rumors.curate(w.token, { status: "official", meaning: gloss, by: keeper });
          events.push({ kind: "lexicon", from: keeper, text: `📖 ${keeper} enters “${w.token}” in the dictionary — ${gloss}` });
          worked++;
        } else if (e.status !== "official" && e.status !== "obsolete" && w.reach === 0 && rounds - firstSeen.get(w.token) > C.obsoleteAfter) {
          rumors.curate(w.token, { status: "obsolete", by: keeper });
          events.push({ kind: "lexicon", from: keeper, text: `📖 ${keeper} marks “${w.token}” obsolete — it never caught on` });
          worked++;
        }
      }
      for (const tok of firstSeen.keys()) if (!live.has(tok)) firstSeen.delete(tok); // a word that left the dictionary (retired/evicted) drops out of the obsolete-clock too — keeps firstSeen bounded
      if (worked) { const a = agentOf(keeper); if (a && a.mind && a.mind.experience) a.mind.experience({ valence: 0.06 * worked, arousal: 0.2, kind: "purpose" }); }
      return events;
    },
  };
}
