import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

function scenario() {
  return {
    topic: "quest",
    statics: [{ name: "table", x: 0, y: 0, radius: 0.7 }],
    zones: [
      { name: "booth", x: 0, y: 3.4, radius: 1.0, booth: true, purpose: "the user" },
      { name: "forge", x: -3.4, y: 0, radius: 1.3, purpose: "plans" },
      { name: "garden", x: 3.4, y: 0, radius: 1.3, purpose: "rest" },
    ],
    bots: [
      { name: "arthur", startZone: "forge", curiosity: 0.95 },
      { name: "percival", startZone: "forge", curiosity: 0.2 },
      { name: "mordred", startZone: "garden", curiosity: 0.2 },
      { name: "kay", startZone: "garden", curiosity: 0.2 },
    ],
    seeds: [{ bot: "arthur", stance: 0.9, text: "seek the grail" }, { bot: "mordred", stance: -0.9, text: "defend the realm" }],
  };
}

describe("colonyApp — orchestrated society sim", () => {
  it("gossip spreads within lobbies and two tribes form (deterministic, mouth:null)", () => {
    let t = 0;
    const app = makeColonyApp({ scenario: scenario(), mouth: null, now: () => t, config: { megaphoneCooldownMs: 100000, socialEvery: 5, rng: () => 0 } });
    for (let i = 0; i < 900; i++) { t += 20; app.tick(0.02); }
    const s = app.state();
    expect(s.bots.find((b) => b.name === "percival").stance).toBeGreaterThan(0.2); // caught arthur's view
    expect(s.bots.find((b) => b.name === "kay").stance).toBeLessThan(-0.2);        // caught mordred's
    expect(s.metrics.tribeCount).toBe(2);
    expect(s.metrics.polarization).toBeGreaterThan(0.4);
    expect(s.bots[0]).toHaveProperty("tribe");
    expect(s.megaphone).toHaveProperty("cooldownLeft");
  });

  it("the booth seeds a first-hand belief from the user (mock reply)", async () => {
    let t = 0;
    const app = makeColonyApp({ scenario: scenario(), mouth: null, now: () => t, onUser: async (bot, { convo }) => (convo.some((m) => m.who === "user") ? { action: "release" } : { action: "say", text: "the well has run dry" }), config: { megaphoneCooldownMs: 100000, socialEvery: 5, rng: () => 0 } });
    let seeded = false;
    for (let i = 0; i < 400 && !seeded; i++) {
      await app.serviceBooth();
      for (let k = 0; k < 12; k++) { t += 20; app.tick(0.02); }
      seeded = app.colony.agents.some((a) => app.gossip.know(a.name).some((x) => x.source === "the user"));
    }
    expect(seeded).toBe(true);
  });

  it("the booth is a multi-turn conversation the USER ends (not auto-released after one reply)", async () => {
    let t = 0;
    const said = ["the well ran dry", "and the crops are failing"]; // the user says two things, then sends the bot off
    const respondCalls = [];
    // a mouth mock that records the bot's replies so we can prove it answered each turn
    const mouth = { PRIORITY: { booth: 100, megaphone: 80 }, async generate({ tag }) { if (tag && tag.startsWith("say:")) respondCalls.push(tag); return "I hear you, and I'll carry word."; } };
    const app = makeColonyApp({ scenario: scenario(), mouth, now: () => t,
      onUser: async (bot, { convo }) => { const turns = convo.filter((m) => m.who === "user").length; return turns < said.length ? { action: "say", text: said[turns] } : { action: "release" }; },
      config: { megaphoneCooldownMs: 1e9, socialEvery: 5, rng: () => 0 } });
    let released = false;
    for (let i = 0; i < 500 && !released; i++) { const r = await app.serviceBooth(); if (r && r.phase === "released") released = true; for (let k = 0; k < 12; k++) { t += 20; app.tick(0.02); } }
    // the visitor bot heard BOTH of the user's lines (two first-hand beliefs), and the bot replied each turn
    const heardBoth = app.colony.agents.some((a) => { const fromUser = app.gossip.know(a.name).filter((x) => x.source === "the user").map((x) => x.text); return said.every((s) => fromUser.includes(s)); });
    expect(heardBoth).toBe(true);
    expect(respondCalls.length).toBeGreaterThanOrEqual(2); // the bot answered each of the user's turns
  });

  it("a megaphone blast moves the colony's consensus", async () => {
    let t = 0;
    const app = makeColonyApp({ scenario: scenario(), mouth: null, now: () => t, config: { megaphoneCooldownMs: 1000, socialEvery: 5, rng: () => 0 } });
    for (let i = 0; i < 900; i++) { t += 20; app.tick(0.02); }        // let the two camps form
    const before = app.state().metrics.consensus;
    t += 1000;                                                        // charge the megaphone
    const res = await app.serviceMegaphone();
    expect(res).not.toBeNull();
    expect(app.state().metrics.consensus).not.toBe(before);          // one loud voice shifted everyone
  });
});
