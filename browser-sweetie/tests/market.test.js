import { describe, it, expect } from "vitest";
import { makeMarket } from "../src/agents/market.js";

// a deterministic rng so employment assignment (and everything) is reproducible
function seeded(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

describe("market — the economy at scale", () => {
  it("stands up 1500 agents and conserves money across long churn", () => {
    const m = makeMarket({ n: 1500, rng: seeded(7) });
    const supply = m.supply();
    expect(supply).toBe(1500 * 45);
    // total (all wallets + treasury) must equal the fixed supply, tick after tick
    for (let t = 0; t < 2000; t++) {
      m.tick();
      if (t % 250 === 0) { const s = m.stats(); expect(Math.abs(s.total - supply)).toBeLessThanOrEqual(2); } // rounding only
    }
    const s = m.stats();
    expect(Math.abs(s.total - supply)).toBeLessThanOrEqual(2);
    expect(s.treasury).toBeGreaterThanOrEqual(0);
  });

  it("circulates — money actually flows both ways once warmed up", () => {
    const m = makeMarket({ n: 1500, rng: seeded(3) });
    let sawWages = false, sawRent = false;
    for (let t = 0; t < 600; t++) { m.tick(); const s = m.stats(); if (s.flowWages > 0) sawWages = true; if (s.flowRent > 0) sawRent = true; }
    expect(sawWages).toBe(true); // cash left the treasury (bank cash-outs)
    expect(sawRent).toBe(true);  // cash returned to the treasury (rent)
  });

  it("all three phases are populated (both sides of the economy are staffed)", () => {
    const m = makeMarket({ n: 1500, rng: seeded(11) });
    for (let t = 0; t < 400; t++) m.tick();
    const s = m.stats();
    expect(s.working + s.banking + s.home).toBe(1500);
    expect(s.working).toBeGreaterThan(0);
    expect(s.banking + s.home).toBeGreaterThan(0); // some are away from work, circulating
  });

  it("produces a wealth distribution and a Gini in (0,1)", () => {
    const m = makeMarket({ n: 1500, rng: seeded(5) });
    for (let t = 0; t < 1200; t++) m.tick();
    const s = m.stats();
    expect(s.buckets.reduce((a, b) => a + b, 0)).toBe(1500); // every agent binned exactly once
    expect(s.gini).toBeGreaterThan(0);
    expect(s.gini).toBeLessThan(1);
    expect(s.max).toBeGreaterThanOrEqual(s.avg); // inequality: someone is above the mean
  });

  it("snapshot / restore round-trips the whole population", () => {
    const a = makeMarket({ n: 300, rng: seeded(9) });
    for (let t = 0; t < 300; t++) a.tick();
    const snap = a.snapshot();
    const before = a.stats();
    const b = makeMarket({ n: 300, rng: seeded(999) });
    b.restore(snap);
    const after = b.stats();
    expect(after.total).toBe(before.total);
    expect(after.treasury).toBe(before.treasury);
    expect(after.gini).toBe(before.gini);
  });
});

describe("market — the business cycle breathes employment WITHOUT touching conservation", () => {
  it("swings the employed fraction between a boom and a recession over one period", () => {
    const period = 2000;
    const m = makeMarket({ n: 1500, rng: seeded(4), config: { cycle: true, cyclePeriod: period, cycleAmp: 0.24, hireRate: 0.05 } });
    let maxEmp = -Infinity, minEmp = Infinity, sawBoom = false, sawBust = false;
    for (let t = 0; t < period; t++) { m.tick(); const s = m.stats(); maxEmp = Math.max(maxEmp, s.employedFrac); minEmp = Math.min(minEmp, s.employedFrac); if (s.cycleLabel === "boom") sawBoom = true; if (s.cycleLabel === "recession") sawBust = true; }
    expect(sawBoom).toBe(true); expect(sawBust).toBe(true);       // the economy visibly expands AND contracts
    expect(maxEmp - minEmp).toBeGreaterThan(0.2);                  // a real swing in who's working (~2×cycleAmp)
  });

  it("conserves money exactly through a full boom/bust — only the LABEL flips, never a balance", () => {
    const m = makeMarket({ n: 1200, rng: seeded(8), config: { cycle: true, cyclePeriod: 1500, hireRate: 0.05 } });
    const supply = m.supply();
    for (let t = 0; t < 3000; t++) { m.tick(); if (t % 200 === 0) expect(Math.abs(m.stats().total - supply)).toBeLessThanOrEqual(2); }
    expect(Math.abs(m.stats().total - supply)).toBeLessThanOrEqual(2);
  });

  it("is off by default — a market with no cycle config reports steady", () => {
    const m = makeMarket({ n: 500, rng: seeded(1) });
    for (let t = 0; t < 300; t++) m.tick();
    const s = m.stats();
    expect(s.cycle).toBe(false); expect(s.cycleLabel).toBe("steady");
  });
});
