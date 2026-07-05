import { describe, it, expect } from "vitest";
import { makeSociety } from "../src/agents/society.js";

describe("society.decay — convictions soften if unreinforced (anti-calcification)", () => {
  it("erodes confidence each round while leaving stance intact", () => {
    const s = makeSociety({ openness: () => 1 });
    s.absorb("A", { topic: "T", stance: 0.8, fidelity: 1 });
    expect(s.opinion("A", "T").confidence).toBeCloseTo(1, 5);
    for (let i = 0; i < 5; i++) s.decay({ rate: 0.1, floor: 0.04 });
    const o = s.opinion("A", "T");
    expect(o.confidence).toBeCloseTo(0.5, 5);   // held less tightly
    expect(o.stance).toBeCloseTo(0.8, 5);        // but still leans exactly the same way
  });

  it("drops an opinion once confidence decays past the floor — the bot is fully re-opened", () => {
    const s = makeSociety({ openness: () => 1 });
    s.absorb("A", { topic: "T", stance: 0.8, fidelity: 1 });
    for (let i = 0; i < 12; i++) s.decay({ rate: 0.1, floor: 0.04 });
    expect(Object.keys(s.opinions("A")).length).toBe(0);          // forgotten entirely
    expect(s.opinion("A", "T").confidence).toBe(0);
  });

  it("a re-absorbed opinion stays firm — only ABANDONED convictions soften", () => {
    const s = makeSociety({ openness: () => 1 });
    s.absorb("A", { topic: "T", stance: 0.8, fidelity: 1 });
    for (let r = 0; r < 12; r++) { s.decay({ rate: 0.05, floor: 0.04 }); s.absorb("A", { topic: "T", stance: 0.8, fidelity: 0.3 }); }
    expect(s.opinion("A", "T").confidence).toBeGreaterThan(0.4);  // ongoing reinforcement keeps it alive
  });

  it("tribes form on a freshly-shared opinion, then DISSOLVE once it's abandoned (the town can re-mix)", () => {
    const s = makeSociety({ openness: () => 1 });
    for (const b of ["A", "B"]) s.absorb(b, { topic: "T", stance: 0.9, fidelity: 1 });
    expect(s.tribes(["A", "B"], 0.62)[0].length).toBe(2);         // agree strongly → one tribe
    for (let i = 0; i < 20; i++) s.decay({ rate: 0.1, floor: 0.04 });
    expect(s.tribes(["A", "B"], 0.62)[0].length).toBe(1);         // convictions faded → no shared basis → tribe dissolves
  });
});
