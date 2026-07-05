import { describe, it, expect } from "vitest";
import { makePsyche } from "../src/agents/psyche.js";
import { makeColonyApp } from "../src/agents/colonyApp.js";

function twoInARoom() {
  return { topic: "quest", statics: [{ name: "table", x: 0, y: 0, radius: 0.6 }],
    zones: [{ name: "forge", x: 0, y: 3, radius: 1.4 }, { name: "booth", x: 0, y: -3, radius: 1, booth: true }],
    bots: [{ name: "arthur", startZone: "forge", pose: { x: -1, y: 2 } }, { name: "mordred", startZone: "forge", pose: { x: 1, y: 2 } }],
    seeds: [{ bot: "arthur", stance: 0.9, text: "seek the grail" }] };
}
function settle(app, n = 700) { let t = 0; for (let i = 0; i < n; i++) { t += 20; app.tick(0.02); } return t; }

describe("psyche — the inner life (grudges, rumination, healing, persistence)", () => {
  it("a bad turn from someone sours the mood AND leaves a grudge that stews", () => {
    let t = 0; const p = makePsyche({ seed: 3, now: () => t });
    const before = p.mood().valence;
    p.onSlighted("mordred", 0.7, "he mocked me at the well");   // an interpersonal wound
    expect(p.mood().valence).toBeLessThan(before);              // mood dropped
    expect(p.feabout("mordred")).toBeLessThan(-0.2);            // a grudge against him
    expect(p.grudges().some((g) => g.who === "mordred")).toBe(true);

    // time passes, the mood decays back toward baseline...
    for (let i = 0; i < 60; i++) { t += 1; p.tick(); }
    const settled = p.mood().valence;
    // ...but RUMINATING on it re-opens the wound: the mood sours again, unprompted, "days later"
    const recalled = p.ruminate();
    expect(recalled.who).toBe("mordred");
    expect(p.mood().valence).toBeLessThan(settled + 0.001);     // re-lived → not better than before dwelling
    expect(p.disposition().volatility).toBeGreaterThan(0.2);    // aroused + sour → prone to act out
  });

  it("a grudge survives a reload (a fresh psyche restored from a snapshot still resents them)", () => {
    let t = 0; const p = makePsyche({ seed: 5, now: () => t });
    p.onSlighted("kay", 0.8, "betrayed a confidence");
    const snap = p.snapshot();
    const p2 = makePsyche({ seed: 5, now: () => (t += 1) });     // a new session
    p2.restore(snap);
    expect(p2.feabout("kay")).toBeLessThan(-0.2);                // the grudge came back with them
    expect(p2.ruminate()?.who).toBe("kay");                      // and it's still what they stew on
  });

  it("a kindness from the resented one HEALS it — the wound resolves and stops stewing", () => {
    let t = 0; const p = makePsyche({ seed: 7, now: () => t });
    p.onSlighted("bors", 0.7);
    expect(p.feabout("bors")).toBeLessThan(-0.2);
    p.reconcile("bors");                                         // a good turn from bors
    expect(p.feabout("bors")).toBeGreaterThan(0);               // warmed
    // the only grudge memory was about bors → now resolved → nothing left to ruminate on
    expect(p.ruminate()).toBeNull();
  });

  it("mood gates disposition: a warm bot cooperates, a soured one turns volatile", () => {
    const warm = makePsyche({ seed: 1 }); warm.experience({ valence: 0.8, arousal: 0.4 });
    const sour = makePsyche({ seed: 1 }); sour.experience({ valence: -0.8, arousal: 0.8 });
    expect(warm.disposition().cooperation).toBeGreaterThan(sour.disposition().cooperation);
    expect(sour.disposition().volatility).toBeGreaterThan(warm.disposition().volatility);
  });
});

describe("psyche in the colony — a grudge changes what a bot DOES", () => {
  it("without a grudge, a roommate catches your view; WITH one, you snub them and they don't", () => {
    let t = 0;
    // control: no grudge → mordred, sharing the forge, catches arthur's seeded view
    const ctrl = makeColonyApp({ scenario: twoInARoom(), mouth: null, now: () => (t += 1), config: { minds: true, socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0 } });
    settle(ctrl);
    expect(ctrl.state().bots.find((b) => b.name === "mordred").stance).toBeGreaterThan(0.2);

    // grudge: arthur can't stand mordred → he snubs him → mordred never catches the view
    const grud = makeColonyApp({ scenario: twoInARoom(), mouth: null, now: () => (t += 1), config: { minds: true, socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0 } });
    grud.colony.agents.find((a) => a.name === "arthur").mind.onSlighted("mordred", 1.0, "an old wound");
    settle(grud);
    const s = grud.state();
    expect(s.bots.find((b) => b.name === "arthur").grudges.some((g) => g.who === "mordred")).toBe(true); // it shows
    expect(s.bots.find((b) => b.name === "mordred").stance).toBeLessThan(0.2);                            // and it BIT: snubbed
    expect(grud.events.some((e) => e.kind === "snub")).toBe(true);
  });

  it("the grudge survives a session (snapshot → restore into a fresh town)", () => {
    let t = 0;
    const a = makeColonyApp({ scenario: twoInARoom(), mouth: null, now: () => (t += 1), config: { minds: true, rng: () => 0 } });
    a.colony.agents.find((x) => x.name === "arthur").mind.onSlighted("mordred", 0.9);
    const snap = a.snapshotPsyches();
    const b = makeColonyApp({ scenario: twoInARoom(), mouth: null, now: () => (t += 1), config: { minds: true, rng: () => 0 } });
    b.restorePsyches(snap);
    expect(b.state().bots.find((x) => x.name === "arthur").grudges.some((g) => g.who === "mordred")).toBe(true);
  });
});
