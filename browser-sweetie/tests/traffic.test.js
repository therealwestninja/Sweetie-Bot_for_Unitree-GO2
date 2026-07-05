import { describe, it, expect } from "vitest";
import { makeTraffic } from "../src/agents/traffic.js";

describe("traffic lights — the intersection phase machine", () => {
  it("cycles H → Hy → V → Vy and wraps", () => {
    const tl = makeTraffic({ greenTicks: 3, yellowTicks: 1 });
    const seen = [];
    for (let i = 0; i < 8; i++) { seen.push(tl.phase()); tl.tick(); }
    expect(seen).toEqual(["H", "H", "H", "Hy", "V", "V", "V", "Vy"]);
    expect(tl.phase()).toBe("H"); // wrapped
  });

  it("pedestrians cross the RED road: vertical crosswalks walk during H, horizontal during V", () => {
    const tl = makeTraffic({ greenTicks: 2, yellowTicks: 1 });
    // phase H (ticks 0-1): horizontal green → cross the vertical road (axis 'V' crosswalks WALK), axis 'H' wait
    expect(tl.walk("V")).toBe(true); expect(tl.walk("H")).toBe(false);
    tl.setTicks(3); // phase V
    expect(tl.walk("H")).toBe(true); expect(tl.walk("V")).toBe(false);
  });

  it("during a yellow, NOBODY walks (clearing interval)", () => {
    const tl = makeTraffic({ greenTicks: 2, yellowTicks: 2 });
    tl.setTicks(2); // Hy
    expect(tl.phase()).toBe("Hy");
    expect(tl.walk("H")).toBe(false); expect(tl.walk("V")).toBe(false);
  });

  it("car signals match the phase", () => {
    const tl = makeTraffic({ greenTicks: 2, yellowTicks: 1 });
    expect(tl.carSignal("H")).toBe("green"); expect(tl.carSignal("V")).toBe("red");
    tl.setTicks(2); expect(tl.carSignal("H")).toBe("yellow");
    tl.setTicks(3); expect(tl.carSignal("H")).toBe("red"); expect(tl.carSignal("V")).toBe("green");
  });
});
