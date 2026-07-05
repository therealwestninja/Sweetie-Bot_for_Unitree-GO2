import { describe, it, expect } from "vitest";
import { makeColony } from "../src/agents/colony.js";
import { makeGossip } from "../src/agents/gossip.js";
import { makeMegaphone } from "../src/agents/megaphone.js";
import { makeBooth } from "../src/agents/booth.js";

describe("gossip — broken telephone", () => {
  it("a rumour degrades as it passes hop to hop, and everyone ends up knowing (a version of) it", () => {
    const g = makeGossip();
    const chain = ["a", "b", "c", "d"];
    const seed = g.seed("a", { text: "the bridge past the north gate is out until the spring thaw", source: "the user" });
    for (let i = 0; i < chain.length - 1; i++) g.relay(chain[i], chain[i + 1]);
    const fidelities = chain.map((b) => g.know(b).find((x) => x.id === seed.id)?.fidelity);
    expect(fidelities[0]).toBe(1);
    expect(fidelities[3]).toBeLessThan(fidelities[0]);                 // trust decayed down the line
    for (let i = 1; i < fidelities.length; i++) expect(fidelities[i]).toBeLessThanOrEqual(fidelities[i - 1]);
    expect(g.heardCount(seed.id)).toBe(4);                             // it reached everyone
    const last = g.know("d").find((x) => x.id === seed.id);
    expect(last.text.length).toBeLessThan(seed.text.length);          // words were lost along the way
    expect(last.hops).toBe(3);
  });

  it("a broadcast lands verbatim, at full fidelity, for all", () => {
    const g = makeGossip();
    const b = g.broadcast({ text: "assemble at the round table", source: "arthur 📣" }, ["a", "b", "c"]);
    for (const who of ["a", "b", "c"]) { const k = g.know(who).find((x) => x.id === b.id); expect(k.text).toBe("assemble at the round table"); expect(k.fidelity).toBe(1); }
  });

  it("rumorStats summarises reach + degradation for instrumentation", () => {
    const g = makeGossip();
    const s = g.seed("a", { text: "the well ran dry", source: "the user" });
    g.relay("a", "b"); g.relay("b", "c");           // spreads to 3, degrading
    g.seed("d", { text: "a quiet rumour", source: "d" }); // reach 1
    const stats = g.rumorStats();
    expect(stats[0].id).toBe(s.id);                  // widest-reach rumour first
    expect(stats[0].holders).toBe(3);
    expect(stats[0].avgFidelity).toBeLessThan(1);    // degraded on the way
    expect(stats.find((r) => r.holders === 1)).toBeTruthy();
  });
});

describe("megaphone — lottery + cooldown + global blast", () => {
  it("fires only when charged, picks a winner by lottery, and blasts verbatim to everyone", async () => {
    let t = 0; const g = makeGossip();
    const bots = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const mp = makeMegaphone({ now: () => t, cooldownMs: 1000, rng: () => 0, gossip: g, compose: (w) => `I, ${w.name}, propose we seek the grail.` });
    const first = await mp.fire(bots);
    expect(first.winner).toBe("a");                                   // rng()=0 → first ticket
    expect(g.know("c").some((x) => /grail/.test(x.text) && x.fidelity === 1)).toBe(true); // reached everyone, pristine
    t = 500; expect(await mp.fire(bots)).toBeNull();                  // still on cooldown
    expect(mp.cooldownLeft()).toBe(500);
    t = 1000; expect(await mp.fire(bots)).not.toBeNull();             // recharged
    expect(mp.fires()).toBe(2);
  });
});

describe("booth — the user embassy + word-of-mouth handoff", () => {
  function arena() {
    const zones = [
      { name: "booth", x: 0, y: 3, radius: 1.0, purpose: "meet the user" },
      { name: "hall", x: 0, y: -3, radius: 1.2, purpose: "mingle" },
    ];
    const bots = ["a", "b", "c"].map((name, i) => ({ name, curiosity: 0.9 - i * 0.1, pose: { x: -2 + i * 2, y: 0 } }));
    return makeColony({ statics: [], zones, bots });
  }
  async function driveBooth(colony, booth, { untilReleases = 2, cycles = 500 } = {}) {
    let released = 0;
    for (let i = 0; i < cycles && released < untilReleases; i++) {
      const r = await booth.tick();
      if (r.phase === "released") released++;
      for (let k = 0; k < 12; k++) colony.tick(0.02);
    }
    return released;
  }

  it("summons a curious bot, the user replies, and the bot leaves carrying the user's words", async () => {
    const c = arena(); const g = makeGossip();
    const booth = makeBooth({ colony: c, gossip: g, boothZone: c.zoneByName("booth"), introOf: (b) => `${b.name}: hello, are you the user?`, onUser: (bot, { convo }) => (convo.some((m) => m.who === "user") ? { action: "release" } : { action: "say", text: "the well in the garden has run dry" }) });
    const released = await driveBooth(c, booth, { untilReleases: 2 });
    expect(released).toBeGreaterThanOrEqual(2);                       // a revolving cast, not just one visitor
    // the first visitor (most curious = "a") now holds the user's words first-hand
    const aKnows = g.know("a").find((x) => x.source === "the user");
    expect(aKnows && aKnows.text).toBe("the well in the garden has run dry");
    expect(aKnows.fidelity).toBe(1);
    // others became AWARE an interaction happened — but hold no content from it
    expect(booth.awarenessLog().length).toBeGreaterThanOrEqual(2);
    expect(booth.visitCount("c")).toBe(0);                                 // c never got a turn (a then b visited)
    expect(g.know("c").some((x) => x.source === "the user")).toBe(false);  // so c hasn't "heard" it — it must gossip to learn
  });

  it("a rejection leaves the bot with nothing to spread", async () => {
    const c = arena(); const g = makeGossip();
    const booth = makeBooth({ colony: c, gossip: g, boothZone: c.zoneByName("booth"), onUser: () => ({ action: "reject" }) });
    await driveBooth(c, booth, { untilReleases: 1 });
    expect(g.know("a").some((x) => x.source === "the user")).toBe(false);
    expect(booth.awarenessLog().length).toBeGreaterThanOrEqual(1);    // still visible that someone approached
  });
});
