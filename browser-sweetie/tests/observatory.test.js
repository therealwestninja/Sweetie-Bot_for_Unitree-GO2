import { describe, it, expect } from "vitest";
import { makeObservatory } from "../src/agents/observatory.js";

// Drive the four cultural surfaces directly so the civilization trajectory is deterministic.
function rig() {
  let pol = 0; const dict = []; const lore = []; const reps = {};
  const society = { polarization: () => pol };
  const rumors = { dictionary: () => dict.map((d) => ({ ...d })), reputation: (n) => ({ mentions: reps[n] || 0 }) };
  const chronicle = { lore: () => lore.map((e) => ({ ...e })) };
  const colony = { agents: [{ name: "a" }, { name: "b" }, { name: "c" }] };
  const obs = makeObservatory({ society, rumors, chronicle, colony, topic: "t", config: { schismAt: 0.75, healBelow: 0.35 } });
  return { obs, set: (p) => (pol = p), dict, lore, reps };
}

describe("observatory — longitudinal civilization metrics", () => {
  it("counts split→heal cycles and the fraction of history the town was split", () => {
    const r = rig();
    r.set(0.2); r.obs.tick();  // calm
    r.set(0.9); r.obs.tick();  // split
    r.set(0.9); r.obs.tick();  // still split
    r.set(0.1); r.obs.tick();  // healed → 1 cycle
    r.set(0.9); r.obs.tick();  // split again
    r.set(0.2); r.obs.tick();  // healed → 2 cycles
    const rep = r.obs.report();
    expect(rep.opinion.schismCycles).toBe(2);
    expect(rep.opinion.splitFraction).toBeCloseTo(3 / 6, 3); // 3 of 6 samples were >= schismAt
    expect(rep.opinion.maxPolarization).toBe(0.9);
  });

  it("measures dialect churn (words coined and retired over the run)", () => {
    const r = rig();
    r.obs.tick();                                   // empty
    r.dict.push({ token: "zib", status: "proposed", reach: 0.1 }); r.obs.tick(); // +1 coined
    r.dict.push({ token: "wug", status: "proposed", reach: 0.1 }); r.obs.tick(); // +1 coined
    r.dict.splice(0, 1); r.obs.tick();              // "zib" retired
    const rep = r.obs.report();
    expect(rep.dialect.coinedTotal).toBe(2);
    expect(rep.dialect.retiredTotal).toBe(1);
    expect(rep.dialect.active).toBe(1);             // only "wug" remains
    expect(rep.dialect.churnPerRound).toBeGreaterThan(0);
  });

  it("measures myth persistence (a retired legend's lifespan)", () => {
    const r = rig();
    r.lore.push({ id: 1, summary: "the schism" }); r.obs.tick(); // legend appears (sample 1)
    r.obs.tick(); r.obs.tick();                                   // survives (samples 2,3)
    r.lore.splice(0, 1); r.obs.tick();                            // gone at sample 4 → lifespan 3
    const rep = r.obs.report();
    expect(rep.myth.retiredLegends).toBe(1);
    expect(rep.myth.avgLifespan).toBe(3);
  });

  it("measures reputation-hierarchy stability (0 = a durable top tier, high = status churn)", () => {
    const stable = rig();
    stable.reps.a = 5; stable.reps.b = 4; stable.reps.c = 3;   // a fixed pecking order
    for (let i = 0; i < 5; i++) stable.obs.tick();
    expect(stable.obs.report().reputation.churn).toBe(0);       // the same figures stayed on top
    expect(stable.obs.report().reputation.topFigures).toContain("a");

    const churny = rig();
    churny.reps.a = 5; churny.obs.tick();
    churny.reps.a = 0; churny.reps.b = 5; churny.obs.tick();    // top figure flipped
    churny.reps.b = 0; churny.reps.c = 5; churny.obs.tick();    // flipped again
    expect(churny.obs.report().reputation.churn).toBeGreaterThan(0);
  });

  it("records a bounded time-series of the civilization's trajectory", () => {
    // a dedicated rig with seriesEvery:1 so every tick records a point, seriesCap:3 so it's bounded
    let pol = 0.2; const dict = []; const lore = [];
    const s2 = makeObservatory({ society: { polarization: () => pol }, rumors: { dictionary: () => dict.map((d) => ({ ...d })), reputation: () => ({ mentions: 0 }) }, chronicle: { lore: () => lore.map((e) => ({ ...e })) }, colony: { agents: [{ name: "a" }] }, topic: "t", config: { seriesEvery: 1, seriesCap: 3 } });
    dict.push({ token: "x", status: "official", reach: 0.6 }); s2.tick();
    lore.push({ id: 1, summary: "l" }); s2.tick();
    s2.tick(); s2.tick(); // more than seriesCap → oldest dropped
    const ser = s2.series();
    expect(ser.length).toBe(3);                                 // capped
    expect(ser[ser.length - 1].round).toBe(4);                  // newest kept
    expect(ser[0].round).toBe(2);                               // oldest (round 1) evicted
    expect(ser[ser.length - 1]).toHaveProperty("official");
  });

  it("tracks the goalpost metric — the town becoming more INHERITABLE over time", () => {
    const r = rig();
    r.obs.tick();                                   // nothing to inherit (0)
    r.dict.push({ token: "zib", status: "official", reach: 0.6 }); // an official word
    r.lore.push({ id: 1, summary: "a legend" });                  // a legend
    r.reps["a"] = 3;                                               // a reputation
    r.obs.tick();
    const rep = r.obs.report();
    expect(rep.transmission.nowInheritable).toBe(3);              // 1 word + 1 legend + 1 reputation
    expect(rep.transmission.maxInheritable).toBe(3);
    expect(rep.transmission.meanInheritable).toBeGreaterThan(0);
  });
});
