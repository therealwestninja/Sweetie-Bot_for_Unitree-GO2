import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

const PR = { lobby: 50, booth: 100, megaphone: 80, converse: 60, gossip: 20 };

function scenario() {
  return {
    topic: "the Summer Festival", statics: [{ name: "oak", x: 0, y: 0, radius: 0.6 }],
    zones: [{ name: "well", x: 0, y: 4, radius: 1, booth: true }, { name: "library", x: -4, y: 0, radius: 1.5 }, { name: "bakery", x: 4, y: 0, radius: 1.5 }],
    // an OPPOSED pair share the library so their debate actually moves opinions (agreeing bots wouldn't)
    bots: [
      { name: "Sage", startZone: "library", pose: { x: -3.6, y: 0.5 }, persona: "a bookish planner" }, { name: "Bushel", startZone: "library", pose: { x: -3.6, y: -0.5 }, persona: "a stubborn traditionalist" },
      { name: "Cinder", startZone: "bakery", pose: { x: 3.6, y: 0.5 }, persona: "a sardonic helper" }, { name: "Streak", startZone: "bakery", pose: { x: 3.6, y: -0.5 }, persona: "a brash reformer" },
    ],
    seeds: [{ bot: "Sage", stance: 0.7, text: "change it" }, { bot: "Bushel", stance: -0.8, text: "keep it" }],
  };
}

describe("lobby conversations — townsfolk debate and opinions shift", () => {
  it("two co-located bots hold a MULTI-TURN exchange (>2 lines) that moves their opinions", async () => {
    let t = 0;
    const mouth = { PRIORITY: PR, async generate({ tag }) { return `(${tag}) here is my view on the festival.`; } };
    // one lobby, one strongly-opposed pair → a real debate that runs the arc (won't converge in a few turns)
    const scen = {
      topic: "the Summer Festival", statics: [],
      zones: [{ name: "library", x: 0, y: 0, radius: 2 }],
      bots: [
        { name: "Sage", startZone: "library", pose: { x: -0.6, y: 0 }, persona: "a bookish planner" },
        { name: "Bushel", startZone: "library", pose: { x: 0.6, y: 0 }, persona: "a stubborn traditionalist" },
      ],
      seeds: [{ bot: "Sage", stance: 0.8, text: "change it" }, { bot: "Bushel", stance: -0.8, text: "keep it" }],
    };
    const app = makeColonyApp({ scenario: scen, mouth, now: () => t, config: { megaphoneCooldownMs: 1e9, socialEvery: 5, homophilyEvery: 1e9, rng: () => 0.5, lobby: { cooldownMs: 0, turns: 4, convergeEps: 0 } } }); // convergeEps 0 → run the full arc
    for (let i = 0; i < 20; i++) { t += 20; app.tick(0.02); } // register zone membership (they start in-zone)
    const beforeSage = app.society.opinion("Sage", app.topic).stance;   // pro (+)
    const beforeBushel = app.society.opinion("Bushel", app.topic).stance; // anti (−)
    const res = await app.serviceLobbies();
    expect(res).not.toBeNull();
    expect(res.lines.length).toBe(4);                      // a real back-and-forth, not a fixed 2-shot
    expect(res.lines.length).toBe(res.turns);
    expect(app.events.filter((e) => e.kind === "chat").length).toBe(res.lines.length); // each turn was emitted as it landed
    // after debating the opposed neighbour across several turns, each drifts toward the other
    expect(app.society.opinion("Sage", app.topic).stance).toBeLessThan(beforeSage);
    expect(app.society.opinion("Bushel", app.topic).stance).toBeGreaterThan(beforeBushel);
  });

  it("stops early when the two find common ground (converged), after at least one real exchange", async () => {
    let t = 0;
    const mouth = { PRIORITY: PR, async generate() { return "quite so."; } };
    // two bots who ALREADY agree (same stance) → they exchange a line each, then wrap up early
    const scen = {
      topic: "the Summer Festival", statics: [],
      zones: [{ name: "library", x: 0, y: 0, radius: 2 }],
      bots: [
        { name: "Ada", startZone: "library", pose: { x: -0.6, y: 0 }, persona: "a planner" },
        { name: "Bea", startZone: "library", pose: { x: 0.6, y: 0 }, persona: "a planner" },
      ],
      seeds: [{ bot: "Ada", stance: 0.6, text: "change it" }, { bot: "Bea", stance: 0.6, text: "change it" }],
    };
    const app = makeColonyApp({ scenario: scen, mouth, now: () => t, config: { megaphoneCooldownMs: 1e9, socialEvery: 5, homophilyEvery: 1e9, rng: () => 0.5, lobby: { cooldownMs: 0, turns: 6, convergeEps: 0.28 } } });
    for (let i = 0; i < 20; i++) { t += 20; app.tick(0.02); }
    const res = await app.serviceLobbies();
    expect(res.converged).toBe(true);
    expect(res.lines.length).toBe(2);       // one real back-and-forth, then common ground → stop (not the full 6)
  });

  it("the DOMINANT voice wins the argument — the sub moves more than the dom over the arc", async () => {
    let t = 0;
    const mouth = { PRIORITY: PR, async generate() { return "here's how I see it."; } };
    // two co-located opposites, but one is far more dominant than the other
    const scen = {
      topic: "the Summer Festival", statics: [],
      zones: [{ name: "library", x: 0, y: 0, radius: 2 }],
      bots: [
        { name: "Boss", startZone: "library", pose: { x: -0.6, y: 0 }, dominance: 0.95, persona: "a commanding leader" },
        { name: "Meek", startZone: "library", pose: { x: 0.6, y: 0 }, dominance: 0.05, persona: "a timid follower" },
      ],
      seeds: [{ bot: "Boss", stance: 0.9, text: "reinvent it" }, { bot: "Meek", stance: -0.9, text: "keep it" }],
    };
    const app = makeColonyApp({ scenario: scen, mouth, now: () => t, config: { megaphoneCooldownMs: 1e9, socialEvery: 5, homophilyEvery: 1e9, rng: () => 0.5, lobby: { cooldownMs: 0, convergeEps: 0 } } }); // convergeEps 0 → run the full arc
    for (let i = 0; i < 20; i++) { t += 20; app.tick(0.02); }
    const b0 = app.society.opinion("Boss", app.topic).stance, m0 = app.society.opinion("Meek", app.topic).stance;
    await app.serviceLobbies();
    const bMoved = Math.abs(app.society.opinion("Boss", app.topic).stance - b0);
    const mMoved = Math.abs(app.society.opinion("Meek", app.topic).stance - m0);
    expect(mMoved).toBeGreaterThan(bMoved); // the meek one caved further toward the boss than vice-versa
  });

  it("respects a per-lobby cooldown (not ready immediately after a chat)", async () => {
    let t = 0;
    const mouth = { PRIORITY: PR, async generate() { return "a line."; } };
    const app = makeColonyApp({ scenario: scenario(), mouth, now: () => t, config: { megaphoneCooldownMs: 1e9, socialEvery: 5, homophilyEvery: 1e9, rng: () => 0.5, lobby: { cooldownMs: 20000 } } });
    for (let i = 0; i < 40; i++) { t += 20; app.tick(0.02); }
    const lobs = app.colony.lobbies();
    const name = Object.keys(lobs).find((n) => lobs[n].length >= 2);
    expect(app.lobbyChat.ready(name)).toBe(true);
    await app.lobbyChat.chat(name, lobs[name]);
    expect(app.lobbyChat.ready(name)).toBe(false); // that lobby is now on cooldown
  });
});
