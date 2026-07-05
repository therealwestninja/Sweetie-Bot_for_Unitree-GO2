import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

function scen(onEvent) {
  return {
    scenario: {
      topic: "quest",
      statics: [{ name: "table", x: 0, y: 0, radius: 0.6 }],
      zones: [
        { name: "booth", x: 0, y: 4, radius: 1.0, booth: true },
        { name: "charger", x: 0, y: -4, radius: 1.2, charger: true, ports: 2 },
        { name: "forge", x: -4, y: 0, radius: 1.4 },
        { name: "library", x: 4, y: 0, radius: 1.4 },
      ],
      bots: [
        { name: "a", startZone: "forge", curiosity: 0.9 }, { name: "b", startZone: "forge", curiosity: 0.2 },
        { name: "c", startZone: "library", curiosity: 0.8 }, { name: "d", startZone: "library", curiosity: 0.15 },
        { name: "e", startZone: "forge", curiosity: 0.5 }, { name: "f", startZone: "library", curiosity: 0.4 },
      ],
      seeds: [{ bot: "a", stance: 0.9, text: "seek it" }, { bot: "c", stance: -0.9, text: "forget it" }],
    },
    onEvent,
  };
}

describe("charger — battery, limited ports, lineups, water-cooler gossip", () => {
  it("low knights queue for the 2 ports (a lineup forms) and charge back up; the charger mixes gossip", () => {
    let t = 0; const cooler = [];
    const { scenario } = scen();
    const app = makeColonyApp({ scenario, mouth: null, now: () => t, config: { socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0, onEvent: (e) => { if (e.kind === "cooler") cooler.push(e); }, charger: { low: 35, full: 92, drainMove: 1.2, drainIdle: 0.8, chargeRate: 2.5 } } });
    let maxQueue = 0, everCharging = false, everCharged = false;
    for (let i = 0; i < 5000; i++) {
      t += 20; app.tick(0.02);
      const s = app.state();
      maxQueue = Math.max(maxQueue, s.charger.queue);
      if (s.bots.some((b) => b.charge === "charging")) everCharging = true;
      if (app.events.some((e) => /tops up|charge time is up/.test(e.text || ""))) everCharged = true;
    }
    expect(everCharging).toBe(true);                 // knights actually plug in
    expect(maxQueue).toBeGreaterThan(0);             // more low knights than ports → a lineup
    expect(everCharged).toBe(true);                  // and they top up + leave (throughput)
    expect(cooler.length).toBeGreaterThan(0);        // water-cooler gossip happened at the charger
  });

  it("the booth cycles through MORE THAN TWO knights (fairness fix)", async () => {
    let t = 0;
    const { scenario } = scen();
    const app = makeColonyApp({ scenario, mouth: null, now: () => t, onUser: async (bot, { convo }) => (convo.some((m) => m.who === "user") ? { action: "release" } : { action: "say", text: "a word from the user" }), config: { socialEvery: 6, megaphoneCooldownMs: 1e9, rng: () => 0, charger: { low: 2 } } }); // low charge threshold so charging doesn't interfere with the booth test
    for (let i = 0; i < 4000; i++) { await app.serviceBooth(); for (let k = 0; k < 8; k++) { t += 20; app.tick(0.02); } }
    const visitors = app.colony.agents.filter((a) => app.gossip.know(a.name).some((x) => x.source === "the user")).map((a) => a.name);
    expect(visitors.length).toBeGreaterThanOrEqual(3); // not just the two keenest in a loop
  });
});
