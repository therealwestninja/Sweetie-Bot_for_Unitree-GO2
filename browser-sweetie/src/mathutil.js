// Shared geometry helpers (port of Legacy_Sweetie-Bot/core/mathutil.py). Meters + radians throughout.
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Wrap an angle to (-π, π]. Robust for arbitrarily large/negative inputs (JS % keeps the sign of the
// dividend, so normalize into [0, 2π) first, then shift).
export function wrapAngle(a) {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

export const hypot = (dx, dy) => Math.hypot(dx, dy);
