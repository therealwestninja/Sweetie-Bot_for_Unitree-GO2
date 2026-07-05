import { describe, it, expect } from "vitest";
import { makeSociety } from "../src/agents/society.js";
import { makeColony } from "../src/agents/colony.js";
import { applyHomophily, preferredLobby } from "../src/agents/homophily.js";

describe("society — opinions", () => {
  it("adopts a first belief, then a conflicting one pulls it toward the middle (prior resists)", () => {
    const s = makeSociety({ openness: () => 0.5 });
    s.absorb("x", { topic: "grail", stance: 1, fidelity: 1 });
    expect(s.opinion("x", "grail").stance).toBe(1);          // first thing heard is adopted
    expect(s.opinion("x", "grail").confidence).toBeCloseTo(0.5, 5);
    s.absorb("x", { topic: "grail", stance: -1, fidelity: 1 });
    const o = s.opinion("x", "grail");
    expect(o.stance).toBeGreaterThan(-1); expect(o.stance).toBeLessThan(1); // moved, not flipped
    expect(o.confidence).toBeGreaterThan(0.5);               // hearing more → more sure
  });

  it("a degraded (far-hop) belief influences less than a first-hand one", () => {
    const s = makeSociety({ openness: () => 0.5 });
    s.absorb("near", { topic: "t", stance: 1, fidelity: 1 });
    s.absorb("far", { topic: "t", stance: 1, fidelity: 0.2 });
    expect(s.opinion("near", "t").confidence).toBeGreaterThan(s.opinion("far", "t").confidence);
  });
});

describe("society — tribes + metrics", () => {
  it("opposing camps split into two tribes; agreement is one tribe", () => {
    const s = makeSociety();
    const pro = ["a", "b", "c"], anti = ["d", "e", "f"];
    pro.forEach((b) => s.absorb(b, { topic: "grail", stance: 0.9, fidelity: 1 }));
    anti.forEach((b) => s.absorb(b, { topic: "grail", stance: -0.9, fidelity: 1 }));
    const tribes = s.tribes([...pro, ...anti]);
    expect(tribes.length).toBe(2);
    expect(tribes.map((t) => t.length).sort()).toEqual([3, 3]);
    expect(s.polarization([...pro, ...anti], "grail")).toBeGreaterThan(0.5); // clearly split
    // everyone agreeing → a single tribe, ~zero polarization
    const s2 = makeSociety();
    ["a", "b", "c"].forEach((b) => s2.absorb(b, { topic: "grail", stance: 0.8, fidelity: 1 }));
    expect(s2.tribes(["a", "b", "c"]).length).toBe(1);
    expect(s2.polarization(["a", "b", "c"], "grail")).toBeLessThan(0.15);
  });

  it("a strong megaphone-style broadcast shifts the consensus", () => {
    const s = makeSociety({ openness: () => 0.4 });
    const bots = ["a", "b", "c"];
    bots.forEach((b) => s.absorb(b, { topic: "t", stance: 0.5, fidelity: 0.6 })); // mildly for
    const before = s.consensus(bots, "t");
    bots.forEach((b) => s.absorb(b, { topic: "t", stance: -1, fidelity: 1 }));    // a loud counter-blast
    const after = s.consensus(bots, "t");
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  it("advocacy surfaces a bot's strongest-held cause", () => {
    const s = makeSociety();
    s.absorb("x", { topic: "grail", stance: 0.9, fidelity: 1 });
    s.absorb("x", { topic: "weather", stance: 0.2, fidelity: 0.3 });
    expect(s.advocacy("x").topic).toBe("grail");
  });
});

describe("homophily — tribes become physical", () => {
  function twoHalls() {
    const zones = [{ name: "hallA", x: -3.2, y: 0, radius: 1.3, purpose: "" }, { name: "hallB", x: 3.2, y: 0, radius: 1.3, purpose: "" }];
    const bots = ["a", "b", "c", "d"].map((name, i) => ({ name, pose: { x: -1.5 + i * 1.0, y: 0 } }));
    return makeColony({ statics: [], zones, bots });
  }
  const settle = (c, cap = 4000) => { for (let i = 0; i < cap; i++) { c.tick(0.02); if (c.allArrived()) break; } };

  it("preferredLobby pulls a bot toward the lobby holding its allies", () => {
    const c = twoHalls(); const s = makeSociety();
    ["a", "b"].forEach((b) => c.sendTo(b, "hallA")); ["c", "d"].forEach((b) => c.sendTo(b, "hallB")); settle(c);
    ["a", "b", "e"].forEach((b) => s.absorb(b, { topic: "grail", stance: 0.9, fidelity: 1 })); // e agrees with the hallA pair
    ["c", "d"].forEach((b) => s.absorb(b, { topic: "grail", stance: -0.9, fidelity: 1 }));
    expect(preferredLobby(c, s, "e")).toBe("hallA");
  });

  it("a mixed lobby self-sorts: allies end up together, rivals apart", () => {
    const c = twoHalls(); const s = makeSociety();
    ["a", "b", "c", "d"].forEach((b) => c.sendTo(b, "hallA")); settle(c);     // everyone crammed in one hall
    ["a", "b"].forEach((b) => s.absorb(b, { topic: "grail", stance: 0.9, fidelity: 1 }));
    ["c", "d"].forEach((b) => s.absorb(b, { topic: "grail", stance: -0.9, fidelity: 1 }));
    for (let r = 0; r < 8; r++) { applyHomophily(c, s); settle(c); }
    const z = (n) => c.zoneOf(c.agents.find((x) => x.name === n).mover.pose);
    expect(z("a")).toBe(z("b"));      // allies together
    expect(z("c")).toBe(z("d"));      // allies together
    expect(z("a")).not.toBe(z("c"));  // rival camps in different halls
  });
});
