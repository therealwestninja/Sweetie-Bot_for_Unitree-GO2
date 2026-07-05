import { describe, it, expect } from "vitest";
import { makeGossip } from "../src/agents/gossip.js";
import { makeRumors } from "../src/agents/rumors.js";
import { makeLanguage } from "../src/agents/language.js";
import { makePsyche } from "../src/agents/psyche.js";

function town(cfg = {}) {
  const g = makeGossip();
  const names = ["a", "b", "c", "d"];
  const agents = names.map((n) => ({ name: n, mind: makePsyche({ seed: n.charCodeAt(0) }) }));
  const colony = { agents, zones: [{ name: "sq" }], inZone: () => names };
  const agentOf = (nm) => agents.find((a) => a.name === nm);
  const rumors = makeRumors({ colony, gossip: g, society: { affinity: () => 0.5 }, rng: () => 0 });
  const language = makeLanguage({ colony, rumors, agentOf, rng: () => 0.5, config: { adoptReach: 0.5, stallTicks: 3, ...cfg } });
  return { g, names, agents, rumors, language, agentOf };
}

describe("language evolution — the meta-word-game", () => {
  it("mines a FRESH token that isn't already in use", () => {
    const { language, rumors } = town();
    const t = language.coin("a", "first");
    const t2 = language.mineToken();
    expect(t2).not.toBe(t);
    expect(rumors.lookup(t2)).toBeNull();               // not coined yet — genuinely unused
  });

  it("adoption REWARDS the coiner (recognition) and the new adopter gets a CURIOSITY lift", () => {
    const { g, language, agentOf } = town();
    const t = language.coin("a", "a test");
    const coinerBefore = agentOf("a").mind.mood().valence, adopterBefore = agentOf("b").mind.mood().valence;
    g.relay("a", "b");                                    // b picks the word up
    const evs = language.tick();
    expect(evs.some((e) => e.kind === "word-catch")).toBe(true);
    expect(agentOf("a").mind.mood().valence).toBeGreaterThan(coinerBefore); // paid attention to → mood up
    expect(agentOf("b").mind.mood().valence).toBeGreaterThan(adopterBefore); // a new word is a thrill
  });

  it("a word that spreads far enters the language and stops pending", () => {
    const { g, language } = town();
    const t = language.coin("a");
    g.relay("a", "b"); g.relay("b", "c");                 // 3 of 4 → reach 0.75 ≥ 0.5
    const evs = language.tick();
    expect(evs.some((e) => e.kind === "word-adopted")).toBe(true);
    expect(language.pendingTokens()).not.toContain(t);
  });

  it("a FLOPPED word makes the coiner reflect + retry with a NEW token (a learning curve)", () => {
    const { language } = town();
    const t = language.coin("a");
    let flop = null;
    for (let i = 0; i < 6; i++) { const f = language.tick().find((e) => e.kind === "word-flop"); if (f) flop = f; } // no adoption → stalls
    expect(flop).toBeTruthy();
    expect(flop.from).toBe("a");
    expect(language.attempts("a")).toBeGreaterThan(0);   // it counted as a lesson
    const pend = language.pendingTokens();
    expect(pend.length).toBeGreaterThan(0);              // it tried again…
    expect(pend).not.toContain(t);                        // …with a DIFFERENT word
  });
});
