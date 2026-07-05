import { describe, it, expect } from "vitest";
import { makeSociety } from "../src/agents/society.js";

// wealth lookup the colony feeds society (net worth); here a plain map
const wealthOf = (w) => (bot) => (bot in w ? w[bot] : null);

describe("society — economic class folds into affinity (economy → society)", () => {
  it("is INERT by default (no classOf / classWeight 0) — affinity is pure opinion, null without shared topics", () => {
    const s = makeSociety({});
    expect(s.affinity("A", "B")).toBe(null);                 // no opinions, no class → no basis
    s.absorb("A", { topic: "T", stance: 0.8, fidelity: 1 }); s.absorb("B", { topic: "T", stance: 0.8, fidelity: 1 });
    expect(s.affinity("A", "B")).toBeGreaterThan(0.9);       // agree strongly → high, unaffected by class
  });

  it("with class weighted in, similar wealth = kinship and very different wealth = distance (even with NO shared opinions)", () => {
    const s = makeSociety({ classOf: wealthOf({ Rich: 30, Rich2: 30, Poor: 5, Mid: 20 }), classWeight: 0.3, classScale: 20 });
    expect(s.affinity("Rich", "Rich2")).toBeCloseTo(1, 5);   // same wealth → full class kinship (class is the only basis)
    expect(s.affinity("Rich", "Poor")).toBeCloseTo(0, 5);    // $25 gap ≥ scale → no kinship
    expect(s.affinity("Rich", "Mid")).toBeCloseTo(0.5, 5);   // $10 gap → half
  });

  it("class TILTS an opinion-based affinity — agreement between a rich and poor bot is cooled by the class gap", () => {
    const w = { Rich: 30, Poor: 5, Rich2: 30 };
    const s = makeSociety({ classOf: wealthOf(w), classWeight: 0.3, classScale: 20 });
    for (const b of ["Rich", "Poor", "Rich2"]) for (let i = 0; i < 3; i++) s.absorb(b, { topic: "T", stance: 0.8, fidelity: 1 }); // all agree strongly
    const sameClass = s.affinity("Rich", "Rich2");   // agree + same wealth
    const crossClass = s.affinity("Rich", "Poor");   // agree + big wealth gap
    expect(sameClass).toBeGreaterThan(crossClass);   // class gap lowers alliance despite identical opinions
    expect(crossClass).toBeGreaterThan(0.5);         // but shared opinion still keeps them partly allied (0.7·1 + 0.3·0)
  });

  it("class sorting shows up in TRIBES — with no opinions, wealth alone splits the town into rich and poor blocs", () => {
    const s = makeSociety({ classOf: wealthOf({ R1: 40, R2: 42, R3: 38, P1: 4, P2: 6, P3: 3 }), classWeight: 0.5, classScale: 20 });
    const tribes = s.tribes(["R1", "R2", "R3", "P1", "P2", "P3"], 0.62);
    // the rich cluster together and the poor cluster together — two blocs, not one town
    const blocOf = (n) => tribes.findIndex((t) => t.includes(n));
    expect(blocOf("R1")).toBe(blocOf("R2")); expect(blocOf("R2")).toBe(blocOf("R3"));
    expect(blocOf("P1")).toBe(blocOf("P2")); expect(blocOf("P2")).toBe(blocOf("P3"));
    expect(blocOf("R1")).not.toBe(blocOf("P1"));   // rich and poor are different tribes
  });
});
