import { describe, it, expect } from "vitest";
import { makeGossip } from "../src/agents/gossip.js";

describe("gossip.age — social rumours fade so reputation isn't a permanent echo chamber", () => {
  it("decays a social rumour's fidelity each round and forgets it below the floor", () => {
    const g = makeGossip();
    g.seed("witness", { text: "A and B are at odds", topic: "social", about: ["A", "B"], rel: -1, fidelity: 1 });
    for (let i = 0; i < 8; i++) g.age({ rate: 0.1, floor: 0.12 }); // 1 → 0.2, still held
    expect(g.know("witness").length).toBe(1);
    expect(g.know("witness")[0].fidelity).toBeCloseTo(0.2, 5);
    g.age({ rate: 0.1, floor: 0.12 });                              // 0.2 → 0.1 < floor → forgotten
    expect(g.know("witness").length).toBe(0);
  });

  it("leaves non-social beliefs (opinions/facts) untouched", () => {
    const g = makeGossip();
    g.seed("bo", { text: "the festival should be bigger", topic: "opinion", stance: 0.8, fidelity: 1 });
    g.seed("bo", { text: "the well is in the SW", topic: "rumor", fidelity: 1 });
    for (let i = 0; i < 20; i++) g.age({ rate: 0.1, floor: 0.12 });
    expect(g.know("bo").length).toBe(2);                            // aging scoped to `social` only → both survive
    expect(g.know("bo").every((b) => b.fidelity === 1)).toBe(true);
  });

  it("a reinforced (refreshed) rumour survives — only UN-reinforced reputation fades", () => {
    const g = makeGossip();
    const b = g.seed("w", { text: "C is trouble", topic: "social", about: ["C"], rel: -1, fidelity: 1 });
    for (let i = 0; i < 5; i++) g.age({ rate: 0.1, floor: 0.12 }); // 1 → 0.5
    g.refresh("w", b.id);                                          // re-witnessed → back to 1
    expect(g.know("w")[0].fidelity).toBe(1);
    for (let i = 0; i < 5; i++) g.age({ rate: 0.1, floor: 0.12 }); // 1 → 0.5, still held (would've been gone without the refresh)
    expect(g.know("w").length).toBe(1);
  });
});
