// Economy — the town runs on money, and money is CONSERVED. Rather than hand-tuning wage/rent constants to keep
// the town from inflating or going broke, the balance is a LAW: rent flows into a town TREASURY, wages are paid
// OUT of that treasury, and total money (every wallet + the treasury) is a constant. So it can't inflate (no money
// is created) or collapse (none is destroyed) — it just circulates, self-balancing around the money SUPPLY (the one
// dial). When bots hoard cash the treasury drains and wages can't be paid → they can't get richer → they spend on
// rent → the treasury refills → wages flow again. Homeostasis, for free.
//
// The loop: work (labour accrues WAGE CLAIMS) → visit the BANK to convert claims to cash the treasury can cover (an
// instant ATM check-in, no queue) → pay RENT from cash at home (which returns that money to the treasury). Falling
// behind on rent doesn't kill you — it STRESSES the psyche, which drives you back to work. Deterministic; opt-in.

export function makeEconomy({ colony, bankZone, homeOf = null, jobs = {}, psycheOf = () => null, rng = Math.random, config = {} } = {}) {
  // rentRate makes rent PROGRESSIVE (like the 1,500-agent market): a fraction of what you HOLD accrues on top of the
  // flat base, so the rich bleed cash back to the treasury proportionally. Without it a bot earns ~8× its rent and its
  // wealth runs away — cash piles up in-wallet, the treasury drains, and it never has reason to bank↔home. This is the
  // self-balancing law (not a hand-tuned constant): hold more → owe more → the equilibrium wealth self-limits. Off (0)
  // by default so the unit tests keep flat rent; the live town turns it on (economyCfg.rentRate).
  // The self-balancing knobs (rentRate / rentDrive / wealthCap) default OFF — they FIGHT the street bots' slow physical
  // pay cadence (progressive rent accrues faster than they can walk home to pay; a wealth cap starves their rent buffer
  // and pushes everyone into debt). The two fixes that actually work are structural, not tuned: LEAVE the bank after
  // cashing out (below) so the work→bank→home loop completes, and a treasury RESERVE floor (colony.html) that keeps the
  // clearing pool liquid. With flat rent the 16 stay solvent; only a very long run nudges their wealth up mildly.
  const C = { startMoney: 15, wage: 0.45, socialWage: 0.12, rent: 0.07, rentRate: 0, bankAt: 3, rentDrive: Infinity, stressAt: 18, perCapita: 40, wageCap: 25, wealthCap: Infinity, moodPerf: false, ...config };
  const workplaceOf = (a) => (jobs[a.name] ? jobs[a.name].at : null);
  // The town's social venues (shop lobbies) — where debate + witnessing happen. Bots head here for the WORKDAY after
  // paying rent (below), so the shops aren't deserted and the social layer isn't starved by the bank↔home oscillation.
  const lobbies = (colony.zones || []).filter((z) => !z.charger && !z.booth && !z.megaphone && !z.home).map((z) => z.name);
  const N = colony.agents.length;
  // OPTIONAL shared treasury: when a `bank` is injected, these embodied bots draw wages from / pay rent into the SAME
  // pool as the 1,500 abstract agents (market.js) — one town economy, not two. Each bot's starting money comes from that
  // shared pool so the whole town stays conserved. Without a bank this runs as its own closed economy (unchanged).
  const bank = config.bank || null;
  for (const a of colony.agents) { const seed = a.money != null ? a.money : (bank ? bank.draw(C.startMoney) : C.startMoney); a.money = seed; a.wages = a.wages ?? 0; a.rentDue = a.rentDue ?? 0; a.job = jobs[a.name] ? jobs[a.name].title : (a.job || null); a.home = a.home || (homeOf ? homeOf(a) : null); }
  // The town's money SUPPLY is fixed; the treasury holds whatever isn't in a wallet. Total (wallets + treasury) is
  // invariant from here on — the conservation law that makes the economy self-balancing.
  const supply = config.townSupply ?? config.moneySupply ?? (N * C.perCapita);
  let treasury = bank ? 0 : Math.max(0, supply - colony.agents.reduce((s, a) => s + (a.money || 0), 0));
  const treasuryBal = () => bank ? bank.balance() : treasury;
  const take = (amt) => { if (bank) return bank.draw(amt); const d = Math.min(amt, treasury); treasury -= d; return d; }; // returns what the treasury could cover
  const put = (amt) => { if (bank) bank.deposit(amt); else treasury += amt; };

  const perfOf = (a) => { if (!C.moodPerf) return 1; const mo = psycheOf(a); const v = mo && mo.mood ? mo.mood().valence : 0; return Math.max(0.15, Math.min(1.35, 0.75 + 0.6 * v)); }; // the SAME formula the earn step uses — the real productivity, exposed for probes
  return {
    jobTitle: (a) => (jobs[a.name] ? jobs[a.name].title : null),
    perf: perfOf,
    treasury: () => +treasuryBal().toFixed(2),
    supply: () => supply,

    // One economy beat (call on the social cadence). Returns events for the log.
    tick() {
      const ev = [];
      for (const a of colony.agents) {
        const m = psycheOf(a); const mood = m && m.mood ? m.mood() : null; // psyche/mood shapes job PRODUCTIVITY (step 1), banking urgency (step 5), rent-stress (step 6)
        // 1) EARN — a WAGE CLAIM for being up & about; a JOB at its workplace (or the Watch) is worth a bonus, scaled by
        //    mood-driven PRODUCTIVITY when moodPerf is on: a depressed (low-valence) bot works at reduced capacity, a
        //    content one over-performs. THIS is the pathway by which a mood shock finally reaches the ECONOMY. Asleep = off.
        if (!a.asleep && a.wages < C.wageCap) { a.wages += C.socialWage; const wp = workplaceOf(a); if ((wp && a.zone === wp) || a.job === "the Watch") { const perf = (C.moodPerf && mood) ? Math.max(0.15, Math.min(1.35, 0.75 + 0.6 * mood.valence)) : 1; a.wages += C.wage * perf; } }
        // 2) RENT accrues — the clock that forces action. PROGRESSIVE: base + a slice of what you hold (wealth self-limits).
        a.rentDue += C.rent + (a.money || 0) * C.rentRate;
        // PERSONALITY → ECONOMY: mood also shapes how urgently a bot seeks cash. Anxious bots (aroused + low-valence) bank
        // SOONER (crave security); content, low-arousal bots let their wages ride. This shifts the DRIVE threshold (timing).
        const bankAt = mood ? C.bankAt * (1.3 - 0.6 * Math.max(0, Math.min(1, mood.arousal * 0.55 + (0.2 - mood.valence) * 0.6))) : C.bankAt;
        // 3) BANK — cash out claims for as much as the TREASURY can cover (money moves treasury → wallet; conserved).
        //    Then LEAVE (a bank is a check-in, not a hangout): head home to pay the rent you just drew cash for. Without
        //    this, cashed-out bots LOITER at the bank (crowding it) and never complete work→bank→HOME, so their cash
        //    piles up in-wallet and never returns to the treasury as rent — the "bank crowd + poor treasury" bug.
        if (a.zone === bankZone) {
          if (a.wages > 0.01 && treasuryBal() > 0.01) { const room = Math.max(0, C.wealthCap - a.money); const draw = room > 0 ? take(Math.min(a.wages, room)) : 0; if (draw > 0) { a.money += draw; a.wages -= draw; if (draw > 1) ev.push({ kind: "econ", from: a.name, text: `💰 ${a.name} draws ${Math.round(draw)} at the bank` }); } } // don't withdraw beyond what you can hold (wealthCap) — excess stays in the treasury (conserved), so no wallet runs away
          a.atBank = false;
          // ALWAYS leave the bank (it's a check-in, never a hangout): owe rent + have cash → go home to pay it (a
          // protected errand); otherwise head back to work to earn. Never loiter — loitering is what crowds the bank.
          if (a.home && a.rentDue > 0.4 && a.money > 0.4) { a.goingHome = true; if (a.zone !== a.home) colony.sendTo(a.name, a.home); }
          else { const dest = workplaceOf(a) || a.home; if (dest && a.zone !== dest) colony.sendTo(a.name, dest); }
        }
        // 4) HOME — arriving home ENDS the "going home" errand; pay rent from cash → money returns to the TREASURY.
        //    Then head back OUT for the WORKDAY: employed bots to their workplace (finally earning the job wage), others
        //    to a lobby. This is the missing third state — without it bots oscillate bank↔home and the shops stay empty,
        //    starving the whole social layer (lobby debate + witnessing). Night-sleep (a.asleep) keeps them home to rest.
        if (a.home && a.zone === a.home) { a.goingHome = false;
          if (a.rentDue > 0.4 && a.money > 0.4) { const pay = Math.min(a.money, a.rentDue); a.money -= pay; a.rentDue -= pay; put(pay); if (pay > 1) ev.push({ kind: "econ", from: a.name, text: `🏠 ${a.name} pays ${Math.round(pay)} rent` }); }
          if (!a.asleep && !a.charge && !a.quest && !a.onMic && !a.atBooth) { const wp = workplaceOf(a); const dest = (wp && wp !== bankZone) ? wp : (lobbies.length ? lobbies[Math.floor(rng() * lobbies.length)] : null); if (dest && a.zone !== dest) colony.sendTo(a.name, dest); } }
        // 5) DRIVE (the churn) — earned a decent chunk AND the bank has cash to pay → make for the bank (a PROTECTED
        //    trip: a.atBank keeps day/night & homophily from yanking you off course). Then day/night takes you home.
        else if (!a.charge && !a.quest && !a.onMic && !a.atBooth && a.wages > bankAt && treasuryBal() > 1) { a.atBank = true; if (a.zone !== bankZone) colony.sendTo(a.name, bankZone); }
        // 5b) RENT PILED UP + you're holding cash → make for HOME to pay it down (a protected errand). Keeps even the
        //     low earners (who rarely earn enough to bank) from falling endlessly behind on rent.
        else if (!a.charge && !a.quest && !a.onMic && !a.atBooth && a.home && a.rentDue > C.rentDrive && a.money > 0.4) { a.goingHome = true; if (a.zone !== a.home) colony.sendTo(a.name, a.home); }
        // 6) STRESS — falling behind on rent gnaws at you (motivates work; never fatal). Reuses this bot's psyche `m`.
        if (a.rentDue > C.stressAt) { if (m && m.experience && rng() < 0.08) { m.experience({ valence: -0.3, arousal: 0.5, kind: "rent" }); ev.push({ kind: "brood", from: a.name, text: `${a.name} frets over the rent — ${Math.round(a.rentDue)} owed` }); } }
      }
      return ev;
    },

    // Persist wallets + the treasury (the whole money supply survives a rebuild/reload, conserved).
    snapshot() { const o = { _treasury: treasuryBal() }; for (const a of colony.agents) o[a.name] = { money: a.money, wages: a.wages, rentDue: a.rentDue }; return o; },
    restore(d) { if (!d) return; if (!bank && d._treasury != null) treasury = d._treasury; for (const a of colony.agents) if (d[a.name]) { a.money = d[a.name].money; a.wages = d[a.name].wages; a.rentDue = d[a.name].rentDue; } }, // shared bank is reconciled externally, never from a snapshot
  };
}
