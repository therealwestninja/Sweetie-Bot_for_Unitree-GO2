import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

// A tiny town with two lobbies, a home band, and one bot of each chronotype. cycleTicks 4 → one tick per phase;
// socialEvery 1 → each app.tick() advances the clock one phase. dayNight on. No minds/mouth needed — dormancy is
// independent of both, so this stays deterministic and offline.
const ZONES = [
  { name: "square", x: -2, y: 0, radius: 1.4, purpose: "meet" },
  { name: "market", x: 2, y: 0, radius: 1.4, purpose: "trade" },
  { name: "lofts", x: 0, y: 3, radius: 1.4, home: true, purpose: "sleep" },
];
const BOTS = [
  { name: "Robin", startZone: "square", pose: { x: -2, y: 0.4 }, chronotype: "lark" },
  { name: "Midge", startZone: "square", pose: { x: -2.4, y: 0.4 }, chronotype: "default" },
  { name: "Nyx", startZone: "market", pose: { x: 2, y: 0.4 }, chronotype: "owl" },
];
// socialEvery lets us separate the two clocks: a HUGE value keeps the phase fixed while physics runs (so we can
// watch a sleeper actually WALK home); socialEvery 1 flips a phase every tick (so we can watch the roster rotate).
function town(startTick, socialEvery = 1) {
  let t = 0;
  return makeColonyApp({ scenario: { topic: "festival", zones: ZONES, bots: BOTS, seeds: [] }, mouth: null, now: () => (t += 1),
    config: { dayNight: true, socialEvery, homophilyEvery: 1e9, megaphoneCooldownMs: 1e9, rng: () => 0.5, clock: { enabled: true, cycleTicks: 4, startTick } } });
}
const sleeping = (app) => Object.fromEntries(app.state().bots.map((b) => [b.name, b.asleep]));
const zoneOf = (app, n) => app.state().bots.find((b) => b.name === n).zone;

describe("day/night dormancy — off-shift bots sleep at home and rotate in", () => {
  it("boots at dawn with only the lark awake; the owl and default walk home to sleep", () => {
    const app = town(0, 1e9);          // dawn, phase frozen (clock won't advance during the settle)
    expect(app.state().clock.phase).toBe("dawn");
    expect(sleeping(app)).toEqual({ Robin: false, Midge: true, Nyx: true });
    for (let i = 0; i < 800; i++) app.tick(); // let the sleepers physically reach the home band
    expect(zoneOf(app, "Nyx")).toBe("lofts");
    expect(zoneOf(app, "Midge")).toBe("lofts");
    expect(zoneOf(app, "Robin")).toBe("square"); // the lark never left the town
  });

  it("rotates the awake set as the phases turn — night wakes the owl, sleeps the lark", () => {
    const app = town(0);              // dawn: lark up
    app.tick();                        // → day: lark + default
    expect(app.state().clock.phase).toBe("day");
    expect(sleeping(app)).toEqual({ Robin: false, Midge: false, Nyx: true });
    app.tick();                        // → dusk: default + owl
    expect(sleeping(app)).toEqual({ Robin: true, Midge: false, Nyx: false });
    app.tick();                        // → night: owl only
    expect(app.state().clock.phase).toBe("night");
    expect(sleeping(app)).toEqual({ Robin: true, Midge: true, Nyx: false });
  });

  it("a sleeping bot is never summoned to the booth", () => {
    const zones = [
      { name: "square", x: -2, y: 0, radius: 1.4, purpose: "meet" },
      { name: "well", x: 0, y: -3, radius: 0.8, booth: true, purpose: "oracle" },
      { name: "lofts", x: 0, y: 3, radius: 1.4, home: true, purpose: "sleep" },
    ];
    let t = 0;
    const app = makeColonyApp({ scenario: { topic: "festival", zones,
      bots: [{ name: "Nyx", startZone: "square", pose: { x: -2, y: 0.4 }, chronotype: "owl", curiosity: 1 }], seeds: [] },
      mouth: null, now: () => (t += 1), config: { dayNight: true, socialEvery: 1, rng: () => 0.5, clock: { enabled: true, cycleTicks: 4, startTick: 0 } } });
    // dawn: the owl is asleep → the booth must not pull it (it's the only bot, and it's out of commission)
    expect(app.state().bots[0].asleep).toBe(true);
    return app.serviceBooth().then((r) => { expect(r.phase).toBe("idle"); expect(app.state().booth.occupant).toBeFalsy(); });
  });

  it("disabled day/night leaves everyone awake (no regression)", () => {
    let t = 0;
    const app = makeColonyApp({ scenario: { topic: "x", zones: [{ name: "square", x: 0, y: 0, radius: 1.4 }],
      bots: [{ name: "Owl", pose: { x: 0, y: 0.4 }, chronotype: "owl" }], seeds: [] },
      mouth: null, now: () => (t += 1), config: { socialEvery: 1, rng: () => 0.5 } }); // dayNight defaults off
    expect(app.state().clock).toBeNull();
    for (let i = 0; i < 6; i++) app.tick();
    expect(app.state().bots[0].asleep).toBe(false);
  });
});
