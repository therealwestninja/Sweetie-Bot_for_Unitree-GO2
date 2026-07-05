import { describe, it, expect } from "vitest";
import { makeMarket } from "../src/agents/market.js";
import { makeEconomy } from "../src/agents/economy.js";

// deterministic rng + the same shared-treasury shape colony.html injects into both modules
function seeded(s = 1) { let x = s >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }
const makeTreasury = (bal = 0) => ({ balance: () => bal, draw(a) { const d = Math.max(0, Math.min(a, bal)); bal -= d; return d; }, deposit(a) { bal += Math.max(0, a); }, set(v) { bal = Math.max(0, v); } });

describe("shared treasury — the embodied bots and the abstract population are ONE conserved economy", () => {
  it("keeps the whole town (embodied wallets + abstract wallets + shared treasury) invariant at the supply", () => {
    const TOWN = 1500, EMBODIED = 16, PER = 45, supply = TOWN * PER;
    const bank = makeTreasury(supply);
    // embodied: a tiny fake colony — money undefined, so each wallet is SEEDED from the shared bank at construction
    const names = Array.from({ length: EMBODIED }, (_, i) => "E" + i);
    const agents = names.map((n) => ({ name: n, zone: null, home: "home:" + n }));
    const colony = { agents, sendTo: (n, z) => { const a = agents.find((x) => x.name === n); if (a) a.zone = z; return true; } };
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: {}, config: { bank, townSupply: supply } });
    const market = makeMarket({ n: TOWN - EMBODIED, rng: seeded(7), config: { bank, townSupply: supply } });
    const total = () => bank.balance() + market.walletSum() + agents.reduce((s, a) => s + (a.money || 0), 0);
    expect(total()).toBeCloseTo(supply, 3);            // conserved by construction (every wallet drawn from the one pool)
    for (let t = 0; t < 1500; t++) {
      market.tick();
      agents.forEach((a, k) => { a.zone = ["bank", a.home, "library", null][(t + k) % 4]; }); // churn the 16 through the loop
      econ.tick();
      if (t % 300 === 0) expect(Math.abs(total() - supply)).toBeLessThan(1e-6);
    }
    expect(Math.abs(total() - supply)).toBeLessThan(1e-6); // exact — money only ever MOVES between wallets and the one treasury
    expect(bank.balance()).toBeGreaterThanOrEqual(0);
  });

  it("market.stats folds the embodied wallets into the town-wide distribution and totals", () => {
    const TOWN = 300, EMBODIED = 12, PER = 45, supply = TOWN * PER;
    const bank = makeTreasury(supply);
    const market = makeMarket({ n: TOWN - EMBODIED, rng: seeded(3), config: { bank, townSupply: supply } });
    for (let t = 0; t < 400; t++) market.tick();
    const embodied = Array.from({ length: EMBODIED }, (_, i) => (i + 1) * 3); // stand-in street wallets
    const s = market.stats(14, embodied);
    expect(s.n).toBe(TOWN); expect(s.abstractN).toBe(TOWN - EMBODIED); expect(s.embodied).toBe(EMBODIED); // the whole town
    expect(s.supply).toBe(supply);
    const embSum = embodied.reduce((a, b) => a + b, 0);
    expect(Math.abs(s.total - (bank.balance() + market.walletSum() + embSum))).toBeLessThan(1); // total = treasury + every wallet
    expect(s.buckets.reduce((a, b) => a + b, 0)).toBe(TOWN); // every townsperson binned exactly once
  });

  it("without a bank both modules still run as their own closed, conserved economies (default path unchanged)", () => {
    const market = makeMarket({ n: 400, rng: seeded(2) });
    for (let t = 0; t < 500; t++) market.tick();
    const s = market.stats(); // no embodied arg
    expect(s.n).toBe(400); expect(s.embodied).toBe(0);
    expect(Math.abs(s.total - s.supply)).toBeLessThanOrEqual(2); // self-contained supply, conserved
  });
});
