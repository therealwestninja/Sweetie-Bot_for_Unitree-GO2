// Market — the economy at SCALE. The named townsfolk you can watch on the street are a sample; a real economy needs
// a POPULATION (both sides of every transaction), so this runs N abstract agents (default 1500) as pure DATA — no
// physics, no sprites, just the money loop as a state machine, O(N) per tick (typed-array columns for speed). Same
// conservation law as economy.js: money circulates through a TREASURY and the total (all wallets + treasury) is
// invariant. Because agents have PHASES (work → bank → home) rather than positions, they never physically cluster.
// The UI reads stats() and shows the FLOW — circulation + wealth distribution — not 1500 dots. Deterministic (rng in).

export function makeMarket({ n = 1500, employedFrac = 0.62, config = {}, rng = Math.random } = {}) {
  // rentRate makes rent PROGRESSIVE — a small fraction of what you hold accrues on top of the flat base, so the rich
  // bleed money back into the treasury proportionally (a wealth tax that funds everyone's wages). This is the real
  // equalizer: without it, high earners compound unchecked and inequality runs away (Gini → 0.7, most agents broke);
  // with it, wealth self-limits and the treasury stays liquid. drawCap is an optional ATM withdrawal limit (off by
  // default — a knob, not load-bearing). Tuned so both sides of the economy stay staffed with a mild, healthy spread.
  // cycle (optional, off by default): a slow BUSINESS CYCLE — employment breathes on a sinusoid, hiring the idle in booms
  // and laying them off in recessions. Money stays exactly CONSERVED (only the `employed` LABEL flips, never a balance);
  // what moves is circulation velocity, the wealth spread, and who's poor — so the flow view has something to dramatize.
  const C = { startMoney: 20, perCapita: 45, wage: 0.8, socialWage: 0.22, rent: 0.04, rentRate: 0.0025, bankAt: 6, transit: 10, rentTransit: 8, wageCap: 30, drawCap: 1e9, cycle: false, cyclePeriod: 5200, cycleAmp: 0.24, hireRate: 0.015, ...config };
  // OPTIONAL shared treasury: when a `bank` is injected, this market's abstract agents draw wages from / pay rent into
  // the SAME pool as the embodied street bots (economy.js) — so the 16 you watch really are members of the 1,500, not
  // a separate economy. `townSupply` is then the whole-town supply (1,500 × perCapita), not just this market's share.
  const bank = config.bank || null;
  const supply = config.townSupply ?? (n * C.perCapita);
  // structure-of-arrays for cache-friendly O(N) at scale
  const money = new Float64Array(n), wages = new Float64Array(n), rentDue = new Float64Array(n);
  const employed = new Uint8Array(n), phase = new Uint8Array(n), timer = new Int16Array(n); // phase 0=work 1=toBank 2=home
  const jit = (base) => base + Math.floor(rng() * Math.max(1, base * 0.7)); // transit jitter — keeps agents out of lockstep
  // Scatter the population across the whole work → bank → home cycle at birth. Without this every agent starts
  // identical and marches in lockstep, so all 1,500 sit in the SAME phase at once (the phase counts pulse instead of
  // staying steadily staffed). Random starting phase / wages / rent / timer desynchronizes them — both sides manned.
  for (let i = 0; i < n; i++) { money[i] = bank ? bank.draw(C.startMoney) : C.startMoney; employed[i] = rng() < employedFrac ? 1 : 0; phase[i] = Math.floor(rng() * 3); wages[i] = rng() * C.bankAt; rentDue[i] = rng() * 9; timer[i] = Math.floor(rng() * C.transit); }
  let treasury = bank ? 0 : Math.max(0, n * C.perCapita - n * C.startMoney); // local treasury only when no shared bank
  const treasuryBal = () => bank ? bank.balance() : treasury;
  let flowWages = 0, flowRent = 0; // money moved this tick (the flow the viz draws)
  let employedCount = 0; for (let i = 0; i < n; i++) if (employed[i]) employedCount++;
  let clock = 0, cursor = 0, cycleVal = 0; // business-cycle state: tick clock, a rolling hire/fire cursor, last sinusoid value
  // Nudge the employed fraction toward `target` by flipping a bounded budget of agents this tick (booms hire the idle,
  // recessions lay the employed off). Only the label flips — no money moves — so conservation is untouched. The cursor
  // walks the array so we don't keep hiring/firing the same block.
  const retarget = (target) => {
    const desired = Math.round(target * n), wantEmployed = desired > employedCount ? 1 : 0;
    let budget = Math.min(Math.abs(desired - employedCount), Math.ceil(C.hireRate * n));
    for (let scan = 0; budget > 0 && scan < n; scan++) { const i = (cursor + scan) % n; if (employed[i] !== wantEmployed) { employed[i] = wantEmployed; employedCount += wantEmployed ? 1 : -1; budget--; } }
    cursor = (cursor + ((n / 7) | 0) + 1) % n;
  };

  return {
    n, treasury: () => treasuryBal(), supply: () => supply,
    walletSum() { let s = 0; for (let i = 0; i < n; i++) s += money[i]; return s; }, // for external conservation reconcile

    // One market beat. Each agent advances its work → bank → home loop; money only ever MOVES (conserved).
    tick() {
      let fw = 0, fr = 0;
      for (let i = 0; i < n; i++) {
        rentDue[i] += C.rent + money[i] * C.rentRate; // progressive: hold more, owe more (recirculates wealth)
        const p = phase[i];
        if (p === 0) {                                   // WORKING — accrue wage claims (labour, not money yet)
          if (wages[i] < C.wageCap) wages[i] += C.socialWage + (employed[i] ? C.wage : 0);
          if (wages[i] > C.bankAt) { phase[i] = 1; timer[i] = jit(C.transit); } // enough earned → set off for the bank
        } else if (p === 1) {                            // heading to the BANK
          if (--timer[i] <= 0) { const want = Math.min(wages[i], C.drawCap); const draw = bank ? bank.draw(want) : Math.min(want, treasury); money[i] += draw; if (!bank) treasury -= draw; wages[i] -= draw; fw += draw; phase[i] = 2; timer[i] = jit(C.rentTransit); } // cash out (what the treasury covers), head home
        } else {                                         // heading HOME
          if (--timer[i] <= 0) { const pay = Math.min(money[i], rentDue[i]); money[i] -= pay; rentDue[i] -= pay; if (bank) bank.deposit(pay); else treasury += pay; fr += pay; phase[i] = 0; } // pay rent (money → treasury), back to work
        }
      }
      flowWages = fw; flowRent = fr;
      if (C.cycle) { clock++; cycleVal = Math.sin(clock * 2 * Math.PI / C.cyclePeriod); retarget(Math.max(0.1, Math.min(0.95, employedFrac + C.cycleAmp * cycleVal))); } // employment breathes; money untouched
    },

    // Aggregate the population into the numbers the display needs (flows, distribution, inequality) — NOT 1500 dots.
    // `embodied` (optional) folds the street bots' real wallets into the distribution/Gini/total so the viz shows the
    // WHOLE town (abstract + embodied); the phase counts stay abstract-only (the embodied move on the street, not here).
    stats(bins = 14, embodied = []) {
      const em = embodied || []; const M = n + em.length; const buckets = new Int32Array(bins); const span = C.perCapita * 2.2;
      let total = treasuryBal(), sum = 0, min = Infinity, max = -Infinity, working = 0, banking = 0, home = 0, broke = 0;
      const bump = (m, owes) => { total += m; sum += m; if (m < min) min = m; if (m > max) max = m; if (m < 1 && owes > 12) broke++; buckets[Math.max(0, Math.min(bins - 1, Math.floor(m / span * bins)))]++; };
      for (let i = 0; i < n; i++) { bump(money[i], rentDue[i]); const p = phase[i]; if (p === 0) working++; else if (p === 1) banking++; else home++; }
      for (const m of em) bump(m, 0); // embodied wallets: into the distribution + totals, but not the abstract phase counts
      // Gini from a sorted copy over the WHOLE town (O(M log M); called on the throttled render cadence, fine for M≈1500)
      const all = new Float64Array(M); all.set(money, 0); for (let j = 0; j < em.length; j++) all[n + j] = em[j];
      all.sort(); let cum = 0; for (let i = 0; i < M; i++) cum += (i + 1) * all[i];
      const gini = sum > 0 ? +((2 * cum) / (M * sum) - (M + 1) / M).toFixed(3) : 0;
      const cycleLabel = !C.cycle ? "steady" : cycleVal > 0.15 ? "boom" : cycleVal < -0.15 ? "recession" : "steady";
      return { n: M, abstractN: n, embodied: em.length, total: Math.round(total), treasury: Math.round(treasuryBal()), supply, avg: +(sum / M).toFixed(1), min: Math.round(min), max: Math.round(max), gini, employedFrac: +(employedCount / n).toFixed(3), employed: employedCount, working, banking, home, broke, buckets: Array.from(buckets), binSpan: +span.toFixed(1), flowWages: +flowWages.toFixed(1), flowRent: +flowRent.toFixed(1), cycle: C.cycle, cyclePhase: +cycleVal.toFixed(3), cycleLabel };
    },

    snapshot() { return { money: Array.from(money), wages: Array.from(wages), rentDue: Array.from(rentDue), phase: Array.from(phase), timer: Array.from(timer), employed: Array.from(employed), treasury, clock }; },
    restore(d) { if (!d || !d.money || d.money.length !== n) return; money.set(d.money); wages.set(d.wages); rentDue.set(d.rentDue); phase.set(d.phase); timer.set(d.timer); employed.set(d.employed); if (!bank) treasury = d.treasury; clock = d.clock || 0; employedCount = 0; for (let i = 0; i < n; i++) if (employed[i]) employedCount++; }, // shared bank reconciled externally; recompute the employed tally from the restored labels
  };
}
