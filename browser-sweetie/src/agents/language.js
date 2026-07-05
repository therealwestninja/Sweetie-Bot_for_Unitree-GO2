// Language evolution — the meta-word-game. Coining a word is now MOTIVATED and SELECTED, not mechanical:
//   • CURIOSITY  — hearing a novel token is intrinsically rewarding (a dopamine nudge), which is the "reason"
//     to pick it up and pass it on. Novelty is contagious.
//   • RECOGNITION — when your word is adopted, YOU get a mood boost: being paid attention to feels good. That
//     reward is what makes coining worth the effort.
//   • REFLEXION  — if your word FLOPS (nobody takes it up before it stalls), you feel the small sting, note that
//     it didn't work, MINE A FRESH token (avoiding every word already in use), and try again — a learning curve.
// Selection: tokens compete on adoption; winners enter the dictionary, losers are abandoned and replaced. Over
// time the town's lexicon evolves. Needs psyches (the mood rewards), so it runs only when minds are on.

const CON = "bdkmnpstvzflrgw", VOW = "aeiou";
function syllable(rng) { const c = () => CON[Math.floor(rng() * CON.length)], v = () => VOW[Math.floor(rng() * VOW.length)]; return c() + v() + (rng() < 0.4 ? c() : ""); }

export function makeLanguage({ colony, rumors, agentOf, rng = Math.random, config = {} } = {}) {
  const C = { adoptReach: 0.5, stallTicks: 8, coinChance: 0.05, ...config };
  const pending = new Map();     // token → { coiner, born, holders:Set }
  const tries = new Map();       // botName → how many words they've had to abandon (their learning curve)
  let clock = 0, unique = 0;

  function mineToken() {
    for (let k = 0; k < 40; k++) { const t = syllable(rng) + (rng() < 0.5 ? syllable(rng) : ""); if (!rumors.lookup(t) && !pending.has(t)) return t; }
    return "wug" + (++unique);   // guaranteed-fresh fallback so a stalled miner never re-uses a taken word
  }

  function coin(botName, meaning = "") {
    const t = mineToken();
    rumors.coinMeme(botName, t, meaning);
    pending.set(t, { coiner: botName, born: clock, holders: new Set([botName]) });
    const a = agentOf(botName); if (a && a.mind && a.mind.nudge) a.mind.nudge("dopamine", 0.12); // hopeful about the new word
    return t;
  }

  return {
    coin, mineToken, pendingTokens: () => [...pending.keys()], attempts: (name) => tries.get(name) || 0,

    // Advance the word-game one round: hand out curiosity + recognition rewards, retire winners, and make a
    // flopped coiner reflect + retry. Returns events.
    tick() {
      clock++; const events = [];
      for (const [t, p] of [...pending]) {
        const sp = rumors.spread(t); if (!sp) { pending.delete(t); continue; }
        const holders = sp.adopters.map((x) => x.name);
        const fresh = holders.filter((n) => !p.holders.has(n));
        for (const n of fresh) { const a = agentOf(n); if (a && a.mind) a.mind.experience({ valence: 0.12, arousal: 0.4, kind: "novelty" }); p.holders.add(n); } // CURIOSITY: a new word is a little thrill
        const coiner = agentOf(p.coiner);
        if (fresh.length) { p.born = clock; if (coiner && coiner.mind) coiner.mind.experience({ valence: 0.15 * fresh.length, arousal: 0.4, kind: "recognised" }); events.push({ kind: "word-catch", from: p.coiner, text: `${p.coiner}'s “${t}” catches on → ${fresh.join(", ")}` }); } // RECOGNITION + MOMENTUM: a word still gaining adopters resets its stall clock, so a catching-on word isn't culled on a fixed timer (it gets the chance to spread far enough to canonize)

        if (sp.reach >= C.adoptReach) { pending.delete(t); if (coiner && coiner.mind) coiner.mind.experience({ valence: 0.5, arousal: 0.5, kind: "word-adopted" }); events.push({ kind: "word-adopted", from: p.coiner, text: `“${t}” has entered the language` }); continue; }
        if (clock - p.born > C.stallTicks) { // FLOP → REFLEXION → retry
          pending.delete(t);
          if (coiner && coiner.mind) coiner.mind.experience({ valence: -0.12, arousal: 0.4, kind: "word-flopped" });
          const n = (tries.get(p.coiner) || 0) + 1; tries.set(p.coiner, n);
          const t2 = coin(p.coiner);            // mine the replacement FIRST (while the old word is still in the lexicon, so it won't re-pick it)…
          if (rumors.remove) rumors.remove(t);  // …THEN abandon the loser — forget it (dictionary + everyone's belief) so dead words don't pile up
          events.push({ kind: "word-flop", from: p.coiner, text: `${p.coiner}'s “${t}” didn't catch (attempt ${n}) — wonders why, mines a fresh one: “${t2}”` });
        }
      }
      return events;
    },

    // Now and then a CURIOUS bot feels inventive and coins a word unprompted.
    maybeCoin() {
      if (rng() >= C.coinChance) return null;   // >= so coinChance:0 truly disables it
      const eligible = colony.agents.filter((a) => a.mind && (!a.mind.disposition || a.mind.disposition().curiosity >= 0.5));
      if (!eligible.length) return null;
      const a = eligible[Math.floor(rng() * eligible.length)];
      const t = coin(a.name);
      return { kind: "word-coin", from: a.name, text: `${a.name}, feeling inventive, coins “${t}”` };
    },
  };
}
