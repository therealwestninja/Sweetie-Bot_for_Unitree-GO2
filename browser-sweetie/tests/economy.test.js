import { describe, it, expect } from "vitest";
import { makeEconomy } from "../src/agents/economy.js";

// a tiny fake colony: agents with a settable `zone`, and a sendTo that records where the economy pushes them
function rig(agents) {
  const sent = [];
  const colony = { agents, sendTo: (n, z) => { sent.push([n, z]); const a = agents.find((x) => x.name === n); if (a) a._target = z; return true; } };
  return { colony, sent };
}
const bot = (name, zone = null) => ({ name, zone, home: "home:" + name });

describe("economy — work → bank → rent, with an ATM-style (no-queue) bank", () => {
  it("earns wages while out working, then cashes them ALL at the bank on arrival (instant, no queue)", () => {
    const a = bot("Ada", "library");
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Ada: { title: "the Librarian", at: "library" } }, config: { startMoney: 0, wage: 0.5, socialWage: 0 } });
    econ.tick(); econ.tick(); econ.tick();      // 3 beats at her workplace → wages accrue, no cash yet
    expect(a.wages).toBeCloseTo(1.5, 5); expect(a.money).toBe(0);
    a.zone = "bank"; econ.tick();               // reach the bank → instant cash-out of everything (no earning at the bank)
    expect(a.wages).toBe(0);
    expect(a.money).toBeCloseTo(1.5, 5);         // all her accrued wages became cash, in one instant check-in
  });

  it("pays rent from cash when home, and rent keeps accruing until paid", () => {
    const a = bot("Bo", null); a.money = 20; a.rentDue = 0;
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", config: { rent: 1 } });
    for (let i = 0; i < 5; i++) econ.tick();     // rent accrues while she's out
    expect(a.rentDue).toBeGreaterThan(3);
    const owed = a.rentDue; a.zone = a.home; econ.tick(); // go home → pay
    expect(a.rentDue).toBeLessThan(owed);
    expect(a.money).toBeLessThan(20);
  });

  it("DRIVES a rent-burdened bot with uncashed wages to the bank (the churn)", () => {
    const a = bot("Cy", "bakery"); a.money = 0; a.wages = 5; a.rentDue = 6;
    const { colony, sent } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", config: { cashHunt: 4 } });
    econ.tick();
    expect(sent).toContainEqual(["Cy", "bank"]);
  });

  it("sends a rested bot back OUT to work (the workday) so shops don't sit empty and the social layer isn't starved", () => {
    const a = bot("Wren", "home:Wren"); a.money = 20; a.rentDue = 0;    // home, awake, rent settled
    const { colony, sent } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Wren: { title: "the Baker", at: "bakery" } }, config: { rent: 0 } });
    econ.tick();
    expect(sent).toContainEqual(["Wren", "bakery"]);                    // routed to its workplace for the day
  });

  it("keeps a SLEEPING bot home (the workday routing respects night rest)", () => {
    const a = bot("Nyx", "home:Nyx"); a.money = 20; a.rentDue = 0; a.asleep = true;
    const { colony, sent } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Nyx: { title: "the Baker", at: "bakery" } }, config: { rent: 0 } });
    econ.tick();
    expect(sent).not.toContainEqual(["Nyx", "bakery"]);                 // asleep → stays home to rest
  });

  it("caps a wallet at wealthCap — the overdraw stays in the treasury (no wallet runs away over long runs)", () => {
    const a = bot("Cap", "bank"); a.money = 20; a.wages = 100; a.rentDue = 0;
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", config: { wealthCap: 30, moneySupply: 1000, rent: 0 } });
    const t0 = econ.treasury();
    econ.tick();
    expect(a.money).toBeCloseTo(30, 5);              // filled only up to the cap
    expect(a.wages).toBeCloseTo(90, 5);             // the rest stays as unclaimed wage (in the treasury, not the wallet)
    expect(econ.treasury()).toBeCloseTo(t0 - 10, 5); // only the $10 of headroom left the treasury
  });

  it("LEAVES the bank after cashing out and heads home to pay rent (no loitering → no bank crowd, treasury refills)", () => {
    const a = bot("Zoe", "bank"); a.money = 0; a.wages = 10; a.rentDue = 8;
    const { colony, sent } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank" });
    econ.tick();                                    // at the bank → cash out, then get routed home
    expect(a.wages).toBe(0);                        // cashed out
    expect(a.money).toBeGreaterThan(0);
    expect(a.goingHome).toBe(true);                 // now on the protected home errand
    expect(sent).toContainEqual(["Zoe", a.home]);   // routed home to pay the rent it just drew cash for
  });

  it("clears the errand and pays rent on arriving home (completing work→bank→home so cash returns to the treasury)", () => {
    const a = bot("Ivy", "home:Ivy"); a.money = 20; a.rentDue = 5; a.goingHome = true;
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", config: { rent: 0 } });
    const t0 = econ.treasury();
    econ.tick();
    expect(a.goingHome).toBe(false);                // errand done on arrival
    expect(a.rentDue).toBeLessThan(5);              // rent paid down
    expect(a.money).toBeLessThan(20);
    expect(econ.treasury()).toBeGreaterThan(t0);    // that money returned to the treasury
  });

  it("MOOD scales job PRODUCTIVITY — a depressed bot earns less job wage than a content one (mood → economy)", () => {
    const dep = bot("Dep", "library"), con = bot("Con", "library"); dep.wages = 0; con.wages = 0;
    const { colony } = rig([dep, con]);
    const moods = { Dep: { valence: -0.8, arousal: 0.5 }, Con: { valence: 0.8, arousal: 0.5 } };
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Dep: { title: "x", at: "library" }, Con: { title: "x", at: "library" } }, psycheOf: (a) => ({ mood: () => moods[a.name] }), config: { moodPerf: true, socialWage: 0, wage: 1 } });
    econ.tick();
    expect(con.wages).toBeGreaterThan(dep.wages);   // the content bot out-produces the depressed one
    expect(dep.wages).toBeCloseTo(0.27, 2);          // perf = 0.75 + 0.6·(−0.8) = 0.27
    expect(con.wages).toBeCloseTo(1.23, 2);          // perf = 0.75 + 0.6·(+0.8) = 1.23
  });

  it("moodPerf OFF (default) — job wage is flat regardless of mood", () => {
    const a = bot("Sad", "library"); a.wages = 0;
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Sad: { title: "x", at: "library" } }, psycheOf: () => ({ mood: () => ({ valence: -0.9, arousal: 0.5 }) }), config: { socialWage: 0, wage: 1 } });
    econ.tick();
    expect(a.wages).toBeCloseTo(1, 5);               // full wage — mood ignored when moodPerf is off
  });

  it("MOOD shapes banking urgency — an anxious bot heads to the bank sooner than a content one (brain → economy)", () => {
    const anx = bot("Anx", "bakery"), con = bot("Con", "bakery");
    anx.money = 0; anx.wages = 5; anx.rentDue = 0; con.money = 0; con.wages = 5; con.rentDue = 0;
    const { colony, sent } = rig([anx, con]);
    const moods = { Anx: { valence: -0.4, arousal: 0.8 }, Con: { valence: 0.5, arousal: 0.1 } }; // anxious vs content
    const econ = makeEconomy({ colony, bankZone: "bank", psycheOf: (a) => ({ mood: () => moods[a.name] }), config: { bankAt: 5, wage: 0, socialWage: 0 } });
    econ.tick();
    const drivenToBank = sent.filter((s) => s[1] === "bank").map((s) => s[0]);
    expect(drivenToBank).toContain("Anx");        // anxious → lowered threshold (~4.1) → drives at wages 5
    expect(drivenToBank).not.toContain("Con");    // content → raised threshold (~6.5) → lets its wages ride
  });

  it("unpaid rent STRESSES the psyche (not fatal — it motivates)", () => {
    const hits = [];
    const a = bot("Dee", "orchard"); a.rentDue = 12;
    const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank", rng: () => 0, psycheOf: () => ({ experience: (e) => hits.push(e) }), config: { stressAt: 9 } });
    econ.tick();
    expect(hits.length).toBe(1);
    expect(hits[0].valence).toBeLessThan(0);
  });

  it("CONSERVES money — total (all wallets + the treasury) is invariant however the economy churns", () => {
    const agents = ["Al", "Bea", "Ci", "Di"].map((n) => ({ name: n, zone: null, home: "home:" + n, money: 10 }));
    const { colony } = rig(agents);
    const econ = makeEconomy({ colony, bankZone: "bank", jobs: { Ci: { title: "x", at: "library" } }, config: { moneySupply: 200 } });
    const total = () => econ.treasury() + agents.reduce((s, a) => s + a.money, 0);
    expect(total()).toBeCloseTo(200, 5);                 // supply set, treasury holds the rest
    for (let i = 0; i < 400; i++) {                      // shuffle everyone through work / bank / home so money circulates
      agents.forEach((a, k) => { a.zone = ["bank", a.home, "library", null][(i + k) % 4]; });
      econ.tick();
    }
    expect(total()).toBeCloseTo(200, 3);                 // neither created nor destroyed — balance is a law, not a tuning
    expect(econ.treasury()).toBeGreaterThanOrEqual(0);   // and the treasury never goes negative
  });

  it("snapshot/restore round-trips the wallets and the treasury", () => {
    const a = bot("Ed"); const { colony } = rig([a]);
    const econ = makeEconomy({ colony, bankZone: "bank" });
    a.money = 33; a.wages = 4; a.rentDue = 2;
    const snap = econ.snapshot();
    a.money = 0; a.wages = 0; a.rentDue = 0;
    econ.restore(snap);
    expect(a.money).toBe(33); expect(a.rentDue).toBe(2);
  });
});
