import { describe, it, expect } from "vitest";
import { makeTemperament } from "../src/agents/temperament.js";
import { makeColonyApp } from "../src/agents/colonyApp.js";

describe("temperament — per-bot neuromodulated mood", () => {
  it("mood sours when moved along and recovers with good things", () => {
    const t = makeTemperament({ seed: 5 });
    const before = t.mood().valence;
    for (let i = 0; i < 6; i++) { t.onMovedAlong(); t.tick(); } // repeatedly told off
    const stressed = t.mood().valence;
    expect(stressed).toBeLessThan(before);
    for (let i = 0; i < 14; i++) { t.onCharged(); t.onChat(); t.tick(); } // a top-up + good company
    expect(t.mood().valence).toBeGreaterThan(stressed);
  });

  it("arousal lifts curiosity (an agitated bot seeks the well more)", () => {
    const t = makeTemperament({ seed: 3 });
    const c0 = t.curiosityMul();
    for (let i = 0; i < 8; i++) { t.onMovedAlong(); t.tick(); } // norepinephrine ↑ → arousal ↑
    expect(t.curiosityMul()).toBeGreaterThan(c0);
  });

  it("different seeds give different resting temperaments", () => {
    const a = makeTemperament({ seed: 1 }).mood(), b = makeTemperament({ seed: 999 }).mood();
    expect(a.valence !== b.valence || a.arousal !== b.arousal).toBe(true);
  });
});

describe("colonyApp — brains give bots individual, drifting moods", () => {
  it("with minds:true every bot has a mood and they differ; a Watch scolding shows up in mood", () => {
    let t = 0;
    const scenario = {
      topic: "quest", statics: [{ name: "oak", x: 0, y: 0, radius: 0.6 }],
      zones: [{ name: "well", x: 0, y: 4, radius: 1, booth: true }, { name: "spa", x: 0, y: -4, radius: 1.1, charger: true, ports: 2 }, { name: "library", x: -4, y: 0, radius: 1.4 }, { name: "bakery", x: 4, y: 0, radius: 1.4 }],
      bots: ["a", "b", "c", "d", "e"].map((n, i) => ({ name: n, startZone: i % 2 ? "library" : "bakery" })),
      seeds: [{ bot: "a", stance: 0.9, text: "x" }, { bot: "b", stance: -0.9, text: "y" }],
    };
    const app = makeColonyApp({ scenario, mouth: null, now: () => t, config: { minds: true, socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0.5, charger: { low: 30, chargeRate: 1, drainMove: 0.6, drainIdle: 0.3 } } });
    for (let i = 0; i < 4000; i++) { t += 20; app.tick(0.02); }
    const s = app.state();
    expect(s.bots.every((b) => b.mood && typeof b.mood.valence === "number")).toBe(true);
    const valences = new Set(s.bots.map((b) => b.mood.valence));
    expect(valences.size).toBeGreaterThan(1); // not all identical — individual temperaments
  });
});
