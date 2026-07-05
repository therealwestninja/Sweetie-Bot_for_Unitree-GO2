import { describe, it, expect } from "vitest";
import { makeChronicle } from "../src/agents/chronicle.js";

// a stub society with no polarization, so schism/heal never fire and we isolate the economic-era path
const flatSociety = { polarization: () => 0, consensus: () => 0 };
const mk = () => makeChronicle({ society: flatSociety, agentNames: () => [] });

describe("chronicle — the business cycle's eras become inherited history", () => {
  it("mints an 'era' lore entry from an observed economy-era, and a newcomer inherits it in the digest", () => {
    const c = mk();
    c.observe({ kind: "economy-era", label: "recession" });
    const minted = c.tick("the Festival");
    expect(minted.length).toBe(1);
    const era = c.lore().find((e) => e.kind === "era");
    expect(era).toBeTruthy();
    expect(era.summary).toMatch(/lean|winter|pinch|hard years/); // a lean-times phrase
    expect(c.digest(6).some((s) => s === era.summary)).toBe(true); // shows up in what a newcomer inherits
  });

  it("remembers lean times harder than booms (bigger magnitude = more legendary)", () => {
    const c = mk();
    c.observe({ kind: "economy-era", label: "boom" });
    c.observe({ kind: "economy-era", label: "recession" });
    c.tick("T");
    const boom = c.lore().find((e) => e.kind === "era" && /plenty|good years|boom|fat/.test(e.summary));
    const lean = c.lore().find((e) => e.kind === "era" && /lean|winter|pinch|hard/.test(e.summary));
    expect(boom.magnitude).toBeCloseTo(1.3, 5);
    expect(lean.magnitude).toBeCloseTo(1.5, 5);
    expect(lean.magnitude).toBeGreaterThan(boom.magnitude);
  });

  it("gives successive booms distinct names, so recurring epochs read as different chapters", () => {
    const c = mk();
    for (let i = 0; i < 3; i++) { c.observe({ kind: "economy-era", label: "boom" }); c.tick("T"); }
    const booms = c.lore().filter((e) => e.kind === "era");
    const names = new Set(booms.map((e) => e.summary));
    expect(booms.length).toBe(3);
    expect(names.size).toBe(3); // three different boom-era phrases, not the same line thrice
  });

  it("persists the era counters so ordinal naming continues across a reload", () => {
    const a = mk();
    a.observe({ kind: "economy-era", label: "boom" }); a.tick("T"); // consumes ERA_BOOM[0]
    const firstName = a.lore().find((e) => e.kind === "era").summary;
    const b = mk();
    b.restore(a.snapshot());
    b.observe({ kind: "economy-era", label: "boom" }); b.tick("T"); // should consume ERA_BOOM[1], not [0]
    const afterRestore = b.lore().filter((e) => e.kind === "era").pop().summary;
    expect(afterRestore).not.toBe(firstName); // counter carried over → a fresh phrase
  });
});
