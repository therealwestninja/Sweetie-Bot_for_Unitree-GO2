import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

// bots sit at explicit poses (no startZone → no nav churn) so proximity is deterministic
function scen() {
  return { topic: "q", statics: [],
    zones: [{ name: "forge", x: -3, y: 0, radius: 1.4 }, { name: "garden", x: 3, y: 0, radius: 1.4 }],
    bots: [{ name: "arthur", pose: { x: -1, y: 0 } }, { name: "mordred", pose: { x: -0.6, y: 0 } }, { name: "gawain", pose: { x: 0, y: 0 } }],
    seeds: [] };
}
function app() { let t = 0; return makeColonyApp({ scenario: scen(), mouth: null, now: () => (t += 1), config: { minds: true, socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0, language: { coinChance: 0 } } }); }
function run(a, n) { let t = 0; for (let i = 0; i < n; i++) { t += 20; a.tick(0.02); } }
const bot = (a, name) => a.colony.agents.find((x) => x.name === name);

describe("volition — inner state becomes a verified, self-carried-out goal", () => {
  it("RECONCILE: a bot seeks out the one it resents and, on reaching them, HEALS the grudge", () => {
    const a = app();
    bot(a, "arthur").mind.onSlighted("mordred", 0.8, "an old wound");
    expect(bot(a, "arthur").mind.feabout("mordred")).toBeLessThan(0);
    a.volition.assign("arthur", { kind: "reconcile", target: "mordred" });
    run(a, 20);
    expect(bot(a, "arthur").mind.feabout("mordred")).toBeGreaterThan(0);   // mended, not merely decayed
    expect(a.events.some((e) => e.kind === "amends")).toBe(true);          // the reconciliation actually happened
  });

  it("CONFRONT: a bot storms up to the one it resents and it deepens on BOTH sides", () => {
    const a = app();
    bot(a, "arthur").mind.onSlighted("mordred", 0.6);
    a.volition.assign("arthur", { kind: "confront", target: "mordred" });
    run(a, 20);
    expect(a.events.some((e) => e.kind === "confront")).toBe(true);
    expect(bot(a, "mordred").mind.feabout("arthur")).toBeLessThan(0);       // mordred now resents arthur back
  });

  it("RECONCILE REBUFFED: if the target still resents you back, the olive branch is spurned and stings", () => {
    const a = app();
    bot(a, "arthur").mind.onSlighted("mordred", 0.6);
    for (let i = 0; i < 2; i++) bot(a, "mordred").mind.onSlighted("arthur", 0.9);   // mordred resents arthur HARD → won't accept
    expect(bot(a, "mordred").mind.feabout("arthur")).toBeLessThan(-0.5);
    a.volition.assign("arthur", { kind: "reconcile", target: "mordred" });
    run(a, 20);
    expect(a.events.some((e) => e.kind === "rebuffed" && e.from === "arthur")).toBe(true);
    expect(bot(a, "arthur").mind.feabout("mordred")).toBeLessThan(0);   // NOT healed — the gesture failed
  });

  it("CONFRONT DEFUSED: a calm, cooperative target clears the air instead of escalating", () => {
    const a = app();
    bot(a, "arthur").mind.onSlighted("mordred", 0.6);
    for (let i = 0; i < 3; i++) bot(a, "mordred").mind.experience({ valence: 0.9, arousal: 0.03, kind: "serene" }); // make mordred calm + cooperative
    a.volition.assign("arthur", { kind: "confront", target: "mordred" });
    run(a, 20);
    expect(a.events.some((e) => e.kind === "amends" && e.from === "arthur")).toBe(true); // the air cleared (a positive resolution)
    expect(a.events.some((e) => e.kind === "confront" && e.from === "arthur")).toBe(false); // it did NOT blow up
    expect(bot(a, "mordred").mind.feabout("arthur")).toBeGreaterThanOrEqual(0); // mordred didn't dig in against arthur
  });

  it("NOVELTY: a bored bot walks to somewhere new and the trip lifts its mood", () => {
    const a = app();
    const before = bot(a, "gawain").mind.mood().valence;
    a.volition.assign("gawain", { kind: "novelty", targetZone: "garden" }); // garden is across the map
    run(a, 400);
    expect(a.events.some((e) => e.kind === "wander" && e.from === "gawain")).toBe(true);
    expect(bot(a, "gawain").mind.mood().valence).toBeGreaterThan(before);
  });

  it("WATCHDOG: a quest it can't complete is abandoned (loop-of-death guard), not chased forever", () => {
    const a = app();
    bot(a, "mordred").mover.pose.x = 6; bot(a, "mordred").mover.pose.y = 6;   // way out of reach
    bot(a, "arthur").mind.onSlighted("mordred", 0.7);
    a.volition.assign("arthur", { kind: "reconcile", target: "mordred" });
    // drive volition directly, pinning arthur each tick → no progress is ever made toward the target
    let gaveUp = false;
    for (let i = 0; i < 25; i++) { const ar = bot(a, "arthur"); ar.mover.pose.x = -1; ar.mover.pose.y = 0; const evs = a.volition.tick(); if (evs.some((e) => e.kind === "give-up" && e.from === "arthur")) gaveUp = true; }
    expect(gaveUp).toBe(true);                                              // it gave up instead of chasing forever
  });
});
