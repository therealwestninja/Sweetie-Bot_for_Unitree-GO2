// Idle/autonomy driver — W4's genuinely-new build (new-build #2). The brain is TURN-DRIVEN (it reacts when
// something happens); this gives it a heartbeat so that, left alone, it initiates. Ported from the user's
// Chloe-bot / my-girl async-agency engine, NOT the legacy Python idle loop. Core principle: ONE adaptive
// clock, and "idle" is a STATE DERIVED FROM INPUT RHYTHM, not a fixed timeout — a fast-paced human is
// declared idle sooner (in ms) than a slow one, because it's measured relative to THEIR tempo.
//
// Everything expensive is gated: a settle guard (don't fire from stale boot state), an AI-cadence floor (the
// adaptive poll can never out-run the costly turn), a single lane lock, and commit-point revalidation (if the
// human speaks WHILE an autonomous turn is composing, discard it unsent = clean interrupt-on-input). Fully
// dependency-injected (clock + defer) so it's deterministically Node-testable exactly like the mined engine.

export function makeIdleDriver({ clock, defer, onIdleTurn, config = {} } = {}) {
  const C = {
    floorMs: 100, ceilMs: 700,        // adaptive poll bounds
    idleZ: 1.2,                       // silenceZ threshold to declare idle
    alpha: 0.3, beta: 0.25,           // Jacobson EWMA gains (avgGap / gapVar)
    minGapVarMs: 1000,                // gapVar floor in the z-score denominator
    aiFloorMs: 4000,                  // AI-cadence floor: min wall-time between autonomous turns of a kind
    seedAvgGapMs: 3000, seedGapVarMs: 1000, // priors before any input is seen
    settleCycles: 1,                  // observe N ticks before the first autonomous turn (spin-up guard)
    ...config,
  };

  let avgGap = C.seedAvgGapMs, gapVar = C.seedGapVarMs;
  let lastInputAt = 0, lastTurnAt = new Map(); // per-kind wall-clock of last autonomous turn
  let deferGen = 0;                  // epoch — bumped on every real input (interrupt token)
  let running = false;               // lane lock (one autonomous turn at a time)
  let settleRemaining = C.settleCycles;
  let cancel = null, started = false;

  const silentFor = (now) => now - lastInputAt;
  // Jacobson/TCP-RTT z-score of the current silence against THIS human's rhythm.
  const silenceZ = (now) => (silentFor(now) - avgGap) / Math.max(gapVar, C.minGapVarMs);
  const isIdle = (now) => silenceZ(now) >= C.idleZ;
  const aiPassDue = (kind, now) => now - (lastTurnAt.get(kind) ?? -Infinity) >= C.aiFloorMs;

  // Poll fast right after input (responsive), relax toward ceil as silence grows (cheap when nothing happens).
  function computeNextDelay(now) {
    const z = Math.max(0, silenceZ(now));
    const frac = Math.min(1, z / C.idleZ);
    return Math.round(C.floorMs + frac * (C.ceilMs - C.floorMs));
  }

  function schedule(ms) { cancel = defer(tick, ms); }

  async function tick() {
    const now = clock.now();
    const nextDelay = computeNextDelay(now);
    // spin-up settle: observe first, so nothing fires from stale persisted timestamps at boot
    if (settleRemaining > 0) { settleRemaining--; schedule(nextDelay); return; }

    if (isIdle(now) && !running) {
      const kind = pickSeedKind();
      if (aiPassDue(kind, now)) {
        running = true;
        const gen = deferGen;               // capture the epoch this turn belongs to
        try {
          await onIdleTurn({ kind, now, silenceZ: +silenceZ(now).toFixed(2), isCurrent: () => gen === deferGen });
          // commit-point revalidation: a real input during composing bumped deferGen → this turn is stale,
          // so don't count it against the AI-cadence floor (it was discarded, not spent).
          if (gen === deferGen) lastTurnAt.set(kind, clock.now());
        } finally { running = false; }
      }
    }
    schedule(nextDelay);
  }

  // Seed kind is a hook for the content layer (lull-filler / check-in / scan / revisit); default single kind.
  let seedPicker = () => "idle";
  function pickSeedKind() { return seedPicker(); }

  return {
    // Boot: seed the rhythm at `now` and schedule the first observe tick a ceil away (nothing fires yet).
    start(now = clock.now()) { if (started) return; started = true; lastInputAt = now; settleRemaining = C.settleCycles; schedule(C.ceilMs); },
    stop() { if (cancel) cancel(); cancel = null; started = false; },

    // A real input arrived (a supervisor message OR a salient world event). Update the rhythm EWMA, snap the
    // next poll to the floor (addressed-priority), and BUMP the interrupt epoch so any in-flight autonomous
    // turn is discarded on completion.
    notifyInput(now = clock.now()) {
      if (lastInputAt) {
        const gap = now - lastInputAt;
        const err = gap - avgGap;
        avgGap = avgGap + C.alpha * err;              // EWMA mean
        gapVar = gapVar + C.beta * (Math.abs(err) - gapVar); // EWMA mean-abs-deviation
      }
      lastInputAt = now;
      deferGen++;                                     // interrupt token → discard unsent
      if (cancel) { cancel(); schedule(C.floorMs); }  // snap to floor for responsiveness
    },

    setSeedPicker(fn) { if (typeof fn === "function") seedPicker = fn; },

    // introspection (tests + UI)
    isIdle: (now = clock.now()) => isIdle(now),
    silenceZ: (now = clock.now()) => +silenceZ(now).toFixed(3),
    nextDelay: (now = clock.now()) => computeNextDelay(now),
    rhythm: () => ({ avgGap: Math.round(avgGap), gapVar: Math.round(gapVar) }),
    epoch: () => deferGen,
    get running() { return running; },
  };
}
