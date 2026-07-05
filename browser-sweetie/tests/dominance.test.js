import { describe, it, expect } from "vitest";
import { makeLobbyChat } from "../src/agents/lobby.js";

function lobby(doms, sharpness = 4) {
  const colony = { agents: Object.entries(doms).map(([name, dominance]) => ({ name, ...(dominance == null ? {} : { dominance }) })) };
  return makeLobbyChat({ colony, society: { opinion: () => ({ stance: 0, confidence: 0.5 }), absorb: () => {} }, persona: {}, mouth: null, topic: "t", config: { dominanceSharpness: sharpness } });
}
// how often `a` takes the floor over `b`, sampled
function initRate(lc, a, b, N = 4000) { let ai = 0; for (let i = 0; i < N; i++) if (lc.pickInitiator(a, b).initiator === a) ai++; return ai / N; }

describe("lobby dominance — who takes the floor is a scalable, testable spectrum", () => {
  it("a near-total DOMINANT (0.99) almost always opens; the near-total SUB (0.01) almost never", () => {
    const rate = initRate(lobby({ dom: 0.99, sub: 0.01 }), "dom", "sub");
    expect(rate).toBeGreaterThan(0.9);   // ~98% at the default sharpness
  });

  it("two EQUALS are a coin-flip (no fixed leader)", () => {
    const rate = initRate(lobby({ a: 0.5, b: 0.5 }), "a", "b");
    expect(rate).toBeGreaterThan(0.42); expect(rate).toBeLessThan(0.58);
  });

  it("the range is COMPRESSIBLE/SCALABLE: sharpness dials how much dominance decides", () => {
    const strong = initRate(lobby({ d: 0.9, s: 0.1 }, 6), "d", "s");   // strict hierarchy
    const flat = initRate(lobby({ d: 0.9, s: 0.1 }, 0.5), "d", "s");   // egalitarian town
    expect(strong).toBeGreaterThan(flat);       // more sharpness → more dominance-determined
    expect(flat).toBeLessThan(0.72);            // compressed toward a coin-flip…
    expect(flat).toBeGreaterThan(0.5);          // …but still tilted the right way
  });

  it("unset dominance defaults to 0.5 — an even town", () => {
    expect(lobby({ x: undefined }).dominanceOf("x")).toBe(0.5);
  });

  it("in an argument the SUB yields more to the DOM than the reverse (dominant wins)", () => {
    const lc = lobby({ dom: 0.9, sub: 0.1 });
    expect(lc.yieldFactor("sub", "dom")).toBeGreaterThan(lc.yieldFactor("dom", "sub"));
  });
});
