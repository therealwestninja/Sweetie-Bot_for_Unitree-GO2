// The Observatory — the civilization INSTRUMENT. Unit tests prove a moment ("does induct() inherit a word");
// the Observatory measures emergent, longitudinal PROPERTIES of the whole town over a long run: how much its
// dialect churns, how long its myths survive, how split it's been, and — the goalpost metric — whether it's
// becoming more INHERITABLE over time (a town a newcomer can actually be raised by). This is the second cell of
// the "new shell" (differential/observatory), distinct from the assert-a-value unit tests. Deterministic; sample
// it on the social cadence, then read report().

export function makeObservatory({ society, rumors, chronicle, colony, topic, config = {} } = {}) {
  const C = { schismAt: 0.75, healBelow: 0.35, topK: 5, seriesEvery: 10, seriesCap: 200, ...config };
  let samples = 0, splitSamples = 0, polSum = 0, polMax = 0, schismCycles = 0, wasSplit = false;
  let coinedTotal = 0, retiredTotal = 0, prevWords = new Set();
  const loreFirst = new Map();          // lore id → sample it appeared (to measure lifespan)
  const loreLife = [];                  // completed legend lifespans (in samples)
  let transmissionSum = 0, transmissionMax = 0;
  let prevTop = new Set(), repChurnSum = 0, repSamples = 0; // reputation-hierarchy stability
  const series = [];                    // a bounded time-series of the civilization's trajectory

  const names = () => colony.agents.map((a) => a.name);
  // What a newcomer would inherit RIGHT NOW: established words + the town's legends + the reputations it'd learn.
  const inheritableNow = () => {
    const dict = rumors.dictionary();
    const words = dict.filter((w) => w.status === "official" || w.reach >= 0.5).length;
    const reps = colony.agents.filter((a) => rumors.reputation(a.name).mentions > 0).length;
    return words + chronicle.lore().length + reps;
  };

  return {
    // Sample the civilization once (call on the social cadence).
    tick() {
      samples++;
      const pol = society.polarization(names(), topic);
      polSum += pol; if (pol > polMax) polMax = pol;
      if (pol >= C.schismAt) splitSamples++;
      if (!wasSplit && pol >= C.schismAt) wasSplit = true;
      else if (wasSplit && pol <= C.healBelow) { wasSplit = false; schismCycles++; } // a full split→heal cycle

      // dialect churn — words appearing / disappearing between samples
      const words = new Set(rumors.dictionary().map((w) => w.token));
      for (const w of words) if (!prevWords.has(w)) coinedTotal++;
      for (const w of prevWords) if (!words.has(w)) retiredTotal++;
      prevWords = words;

      // myth persistence — track each legend's lifespan
      const lore = chronicle.lore(); const liveIds = new Set(lore.map((e) => e.id));
      for (const e of lore) if (!loreFirst.has(e.id)) loreFirst.set(e.id, samples);
      for (const [id, first] of [...loreFirst]) if (!liveIds.has(id)) { loreLife.push(samples - first); loreFirst.delete(id); }

      // transmission potential over time
      const t = inheritableNow(); transmissionSum += t; if (t > transmissionMax) transmissionMax = t;

      // reputation-hierarchy STABILITY — does the town's top tier stay the same figures, or does status shuffle?
      const ranked = colony.agents.map((a) => ({ name: a.name, m: rumors.reputation(a.name).mentions })).filter((x) => x.m > 0).sort((a, b) => b.m - a.m).slice(0, C.topK);
      const top = new Set(ranked.map((x) => x.name));
      if (prevTop.size) { let changed = 0; for (const n of top) if (!prevTop.has(n)) changed++; repChurnSum += changed / Math.max(1, top.size); repSamples++; }
      prevTop = top;

      // the civilization's TRAJECTORY — a bounded time-series (so we can see growth, not just the final tally)
      if (samples % C.seriesEvery === 0) {
        const dict = rumors.dictionary();
        series.push({ round: samples, words: dict.length, official: dict.filter((w) => w.status === "official").length, legends: chronicle.lore().length, polarization: +pol.toFixed(3), inheritable: t });
        while (series.length > C.seriesCap) series.shift();
      }
    },

    // The civilization's trajectory over the run (for a sparkline / offline analysis).
    series: () => series.map((p) => ({ ...p })),

    // The civilization report — summary statistics over the run so far.
    report() {
      const dict = rumors.dictionary();
      return {
        rounds: samples,
        dialect: {
          active: dict.length,
          official: dict.filter((w) => w.status === "official").length,
          coinedTotal, retiredTotal,
          churnPerRound: samples ? +((coinedTotal + retiredTotal) / samples).toFixed(3) : 0,
        },
        myth: {
          legends: chronicle.lore().length,
          retiredLegends: loreLife.length,
          avgLifespan: loreLife.length ? +(loreLife.reduce((a, b) => a + b, 0) / loreLife.length).toFixed(1) : null,
        },
        reputation: {
          // 0 = a stable hierarchy (the same figures stay notable); →1 = status churns constantly
          churn: repSamples ? +(repChurnSum / repSamples).toFixed(3) : 0,
          topFigures: [...prevTop],
        },
        opinion: {
          splitFraction: samples ? +(splitSamples / samples).toFixed(3) : 0,
          meanPolarization: samples ? +(polSum / samples).toFixed(3) : 0,
          maxPolarization: +polMax.toFixed(3),
          schismCycles,
        },
        // the goalpost metric: is the town becoming a place a newcomer can be RAISED by?
        transmission: {
          nowInheritable: inheritableNow(),
          meanInheritable: samples ? +(transmissionSum / samples).toFixed(2) : 0,
          maxInheritable: transmissionMax,
        },
      };
    },
  };
}
