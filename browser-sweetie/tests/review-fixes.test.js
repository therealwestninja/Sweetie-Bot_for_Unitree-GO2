import { describe, it, expect } from "vitest";
import { makeWatch } from "../src/agents/watch.js";
import { makeBooth } from "../src/agents/booth.js";
import { makeGossip } from "../src/agents/gossip.js";

// Regression tests for the code-review pass (2026-07). Each guards a HIGH finding.

describe("Watch respects the owner-flags (asleep/onMic/atBooth) — doesn't yank a bot another subsystem owns", () => {
  const colonyOf = (agents) => { const sent = []; return { agents, sendTo: (n, z) => { sent.push([n, z]); return true; }, _sent: sent }; };
  const looterer = (name, extra = {}) => ({ name, charge: "", zone: null, mover: { pose: { x: 0, y: 0 }, hasGoal: () => false }, ...extra });

  it("moves along a plain open-loiterer but leaves asleep / onMic / atBooth bots alone", () => {
    const agents = [looterer("Plain"), looterer("Sleeper", { asleep: true }), looterer("Speaker", { onMic: true }), looterer("Guest", { atBooth: true })];
    const colony = colonyOf(agents);
    const watch = makeWatch({ colony, lobbyZones: [{ name: "sq" }], config: { campTicks: 1, rng: () => 0 } });
    watch.tick(); watch.tick(); // dwell needs two reads (first establishes lastPos) to cross campTicks
    const moved = colony._sent.map(([n]) => n);
    expect(moved).toContain("Plain");
    expect(moved).not.toContain("Sleeper");
    expect(moved).not.toContain("Speaker");
    expect(moved).not.toContain("Guest");
  });
});

describe("Booth recovers from a throwing hook instead of wedging in 'interacting'", () => {
  it("a rejecting onUser ends the audience ('error') and the booth returns to idle", async () => {
    const boothZone = { name: "well", x: 0, y: 0 };
    const colony = { agents: [{ name: "a", curiosity: 1, dominance: 0.5, mover: { pose: { x: 0, y: 0 } } }], sendTo: () => {}, zoneOf: () => "well" };
    const booth = makeBooth({ colony, gossip: makeGossip(), boothZone, introOf: async () => "hi", respond: async () => "ok", onUser: async () => { throw new Error("boom"); } });
    await booth.tick();               // idle → summoned
    await booth.tick();               // summoned → interacting (arrived)
    const r = await booth.tick();     // interacting: onUser throws → must NOT wedge
    expect(r.phase).toBe("done");
    expect(r.ended).toBe("error");
    await booth.tick();               // done → released
    expect(booth.phase()).toBe("idle"); // fully recovered, not stuck "interacting"
  });
});

describe("Gossip belief store is bounded (opinion/fact/broadcast beliefs no longer grow forever)", () => {
  it("caps a bot's beliefs and evicts the OLDEST, keeping the most recent", () => {
    const g = makeGossip();
    for (let i = 0; i < 200; i++) g.seed("a", { text: "r" + i, topic: "rumor", fidelity: 1 }); // 200 distinct ids
    const held = g.know("a");
    expect(held.length).toBeLessThanOrEqual(120);
    expect(held.some((b) => b.text === "r199")).toBe(true);  // newest survived
    expect(held.some((b) => b.text === "r0")).toBe(false);   // oldest evicted
  });
});
