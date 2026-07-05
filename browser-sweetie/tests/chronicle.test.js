import { describe, it, expect } from "vitest";
import { makeChronicle } from "../src/agents/chronicle.js";

// a fake society whose polarization we drive directly, so the edge-detection is deterministic
function fakeSociety(polSeq) { let i = 0; return { polarization: () => (i < polSeq.length ? polSeq[i++] : polSeq[polSeq.length - 1]) }; }

describe("chronicle — the town crystallizes its salient moments into inheritable lore", () => {
  it("edge-detects a SCHISM (records the transition once, not every tick it stays split)", () => {
    const ch = makeChronicle({ society: fakeSociety([0.2, 0.9, 0.9, 0.9]), agentNames: () => ["a", "b"] });
    const t1 = ch.tick("the festival"); // pol 0.2 → nothing
    const t2 = ch.tick("the festival"); // pol 0.9 → schism
    const t3 = ch.tick("the festival"); // pol 0.9 → already split, no new lore
    expect(t1.length).toBe(0);
    expect(t2.some((e) => e.lore.kind === "schism")).toBe(true);
    expect(t3.length).toBe(0);
    expect(ch.lore().filter((e) => e.kind === "schism").length).toBe(1);
  });

  it("records a HEALING when polarization falls back", () => {
    const ch = makeChronicle({ society: fakeSociety([0.9, 0.1]) });
    ch.tick("x");                         // schism
    const healed = ch.tick("x");          // pol 0.1 → healing
    expect(healed.some((e) => e.lore.kind === "healing")).toBe(true);
  });

  it("turns a word-adopted and a megaphone rally into lore", () => {
    const ch = makeChronicle({ society: fakeSociety([0.2]) });
    ch.observe({ kind: "word-adopted", from: "Ada", text: `“wug” has entered the language` });
    ch.observe({ kind: "megaphone", from: "Boss", text: "📣 rally!" });
    ch.observe({ kind: "megaphone", from: "watch", text: "🛡 patrol" }); // the Watch is not lore-worthy
    const minted = ch.tick("x");
    const kinds = ch.lore().map((e) => e.kind);
    expect(kinds).toContain("word");
    expect(kinds).toContain("rally");
    expect(ch.lore().find((e) => e.kind === "word").summary).toMatch(/wug/);
    expect(ch.lore().filter((e) => e.kind === "rally").length).toBe(1); // watch didn't count
    expect(minted.length).toBe(2);
  });

  it("digest returns the biggest legends first, and the store stays capped", () => {
    const ch = makeChronicle({ society: fakeSociety([0.2]), config: { cap: 3 } });
    for (let i = 0; i < 10; i++) ch.observe({ kind: "megaphone", from: "R" + i, text: "x" });
    ch.tick("x");
    expect(ch.lore().length).toBeLessThanOrEqual(3); // capped — forgets the least legendary
    const dig = ch.digest(2);
    expect(dig.length).toBe(2);
    expect(dig.every((s) => typeof s === "string")).toBe(true);
  });
});
