import { describe, it, expect } from "vitest";
import { makeGossip } from "../src/agents/gossip.js";
import { makeRumors } from "../src/agents/rumors.js";
import { makeColonyApp } from "../src/agents/colonyApp.js";

describe("gossip — attribution degrades (I saw → X said → someone's saying)", () => {
  it("first-hand is 'I saw'; the first retelling names the teller; deep/low-trust forgets the source", () => {
    const g = makeGossip();
    const seed = g.seed("bors", { text: "arthur and mordred are thick as thieves", about: ["arthur", "mordred"], rel: 1 });
    expect(g.phrase(g.know("bors").find((b) => b.id === seed.id))).toMatch(/^I saw /);
    g.relay("bors", "gawain");                                   // hop 1
    expect(g.phrase(g.know("gawain").find((b) => b.id === seed.id))).toMatch(/^bors says /);
    g.relay("gawain", "kay", { decay: 0.4 }); g.relay("kay", "percival", { decay: 0.4 }); // fidelity falls
    expect(g.phrase(g.know("percival").find((b) => b.id === seed.id))).toMatch(/someone's saying/);
  });
});

describe("rumors — observational gossip → reputation", () => {
  it("a witness starts a rumour about a pair, and it becomes the colony's belief ABOUT them", () => {
    const g = makeGossip();
    // a tiny society stub so affinity reads high for the pair
    const society = { affinity: (a, b) => (a !== b ? 0.9 : 1) };
    const colony = { zones: [{ name: "sq" }], inZone: () => ["bors", "arthur", "mordred"], agents: [{ name: "bors" }, { name: "arthur" }, { name: "mordred" }] };
    const rum = makeRumors({ colony, gossip: g, society, rng: () => 0 });   // rng 0 → always witnesses
    const evs = rum.witness({ chance: 1 });
    expect(evs[0].text).toMatch(/I saw .* thick as thieves/);
    const rep = rum.reputation("arthur");
    expect(rep.mentions).toBeGreaterThan(0);
    expect(rep.associates).toContain("mordred");                 // arthur is talked about WITH mordred
    expect(rep.sentiment).toBeGreaterThan(0);                    // and it's a warm rumour
  });
});

describe("rumors — a coined meme becomes common knowledge (the 'quiz' story)", () => {
  it("one bot coins a word and it spreads to (nearly) the whole town, intact", () => {
    const g = makeGossip();
    const names = ["a", "b", "c", "d", "e"];
    const colony = { zones: [{ name: "sq" }], inZone: () => names, agents: names.map((n) => ({ name: n })) };
    const rum = makeRumors({ colony, gossip: g, society: { affinity: () => 0.5 } });
    rum.coinMeme("a", "quiz");
    expect(rum.commonKnowledge("quiz").reach).toBeCloseTo(0.2, 1);          // only the coiner, at first
    for (let round = 0; round < 6; round++) for (let i = 0; i < names.length - 1; i++) g.relay(names[i], names[i + 1]);
    const ck = rum.commonKnowledge("quiz");
    expect(ck.reach).toBeGreaterThan(0.6);                                  // now the town knows the word
    expect(g.know("e").some((b) => b.text === "quiz")).toBe(true);          // survived the telephone game intact
  });
});

describe("rumors — the shared dictionary + tracking a token through the network", () => {
  const town = () => {
    const g = makeGossip();
    const names = ["a", "b", "c", "d"];
    const colony = { zones: [{ name: "sq" }], inZone: () => names, agents: names.map((n) => ({ name: n })) };
    return { g, names, rum: makeRumors({ colony, gossip: g, society: { affinity: () => 0.5 } }) };
  };

  it("a coined word carries a MEANING into the town's dictionary that a newcomer can read", () => {
    const { rum } = town();
    rum.coinMeme("a", "quiz", "a playful challenge or test");
    expect(rum.lookup("quiz").meaning).toBe("a playful challenge or test");
    expect(rum.lookup("quiz").coiner).toBe("a");
    expect(rum.dictionary()[0]).toMatchObject({ token: "quiz", meaning: "a playful challenge or test" });
    rum.define("quiz", "a friendly test of wits");                 // the town refines the gloss
    expect(rum.lookup("quiz").meaning).toBe("a friendly test of wits");
  });

  it("you can TRACE the token by id through the network — who has it and who they caught it from", () => {
    const { g, rum } = town();
    const b = rum.coinMeme("a", "quiz", "a test");
    g.relay("a", "b"); g.relay("b", "c");                          // a → b → c
    const sp = rum.spread("quiz");
    expect(sp.id).toBe(b.id);
    expect(sp.coiner).toBe("a");
    expect(sp.adopters.map((x) => x.name).sort()).toEqual(["a", "b", "c"]);
    expect(sp.edges).toContainEqual({ from: "a", to: "b" });       // the via-graph shows the path it travelled
    expect(sp.edges).toContainEqual({ from: "b", to: "c" });
    expect(sp.reach).toBe(0.75);                                   // 3 of 4 know it
  });
});

describe("rumors — wired into the colony", () => {
  it("state() exposes reputation per bot + a memes summary without breaking anything", () => {
    let t = 0;
    const scenario = { topic: "quest", statics: [], zones: [{ name: "sq", x: 0, y: 0, radius: 2 }],
      bots: ["a", "b", "c"].map((n, i) => ({ name: n, pose: { x: -0.8 + i * 0.8, y: 0 }, startZone: "sq" })), seeds: [] };
    const app = makeColonyApp({ scenario, mouth: null, now: () => ++t, config: { minds: true, socialEvery: 5, megaphoneCooldownMs: 1e9, rng: () => 0, rumorChance: 1 } });
    for (let i = 0; i < 400; i++) app.tick(0.02);
    const s = app.state();
    expect(s.bots[0]).toHaveProperty("reputation");
    expect(s).toHaveProperty("dictionary");
    expect(app.events.some((e) => e.kind === "witness")).toBe(true);       // witnessing actually happened
  });
});
