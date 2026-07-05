// Traffic lights for the 4-way intersection. A phase machine cycling the two roads' right-of-way with a yellow
// clearing interval between: H (horizontal road green) → Hy (yellow) → V (vertical green) → Vy (yellow) → …
// Pedestrians cross the road that is RED: while the horizontal road is green (H), the vertical road is stopped, so
// its crosswalks (axis 'V' = the N/S crossings) show WALK; and vice-versa. During a yellow, everyone waits (clearing).
//
// TICK-DRIVEN (not wall-clock): advanced one step per sim tick, so it scales with the sim-speed slider and freezes
// when the sim is paused. Deterministic → Node-testable.

export function makeTraffic({ greenTicks = 340, yellowTicks = 80, enabled = true, phases = ["H", "Hy", "V", "Vy"] } = {}) {
  const dur = { H: greenTicks, Hy: yellowTicks, V: greenTicks, Vy: yellowTicks };
  const cycle = phases.reduce((s, p) => s + (dur[p] || 0), 0) || 1;
  let t = 0;
  const phaseAt = (tt) => { let e = ((tt % cycle) + cycle) % cycle; for (const p of phases) { if (e < dur[p]) return p; e -= dur[p]; } return phases[0]; };

  return {
    enabled,
    tick() { t++; },
    ticks: () => t,
    setTicks(n) { t = n; },                 // tests
    phase: () => phaseAt(t),

    // The CAR signal for a road ('H'|'V') → 'green' | 'yellow' | 'red'.
    carSignal(road) { const p = phaseAt(t); if (road === "H") return p === "H" ? "green" : p === "Hy" ? "yellow" : "red"; return p === "V" ? "green" : p === "Vy" ? "yellow" : "red"; },

    // Can pedestrians cross a crosswalk of this AXIS right now? A crosswalk crossing the horizontal road (axis 'H')
    // is walkable only while the horizontal road is fully RED = the vertical road is green (phase V). And vice-versa.
    walk(axis) { const p = phaseAt(t); return axis === "V" ? p === "H" : p === "V"; },
    signal(axis) { return this.walk(axis) ? "walk" : "wait"; },
  };
}
