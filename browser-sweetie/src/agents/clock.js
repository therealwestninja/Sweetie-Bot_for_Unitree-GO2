// Day/night clock — a deterministic phase machine that gives the colony a life-RHYTHM and, together with per-bot
// CHRONOTYPES, staggers WHO IS AWAKE so a large cast never all competes for the mouth (Ollama) at once. This is
// the rationing lever behind the extended cast: dormant bots sleep at home, holding their state (mood/grudges),
// and rotate back in at their phase. Fully deterministic (no rng) → trivially Node-testable.
//
// DEFAULT DISABLED — one eternal "day", everyone awake — so every existing sim and test is byte-for-byte
// unchanged until a scenario opts in (config.dayNight). The AWAKE table and cycle length are config, so the
// concurrency/rhythm can be tuned without touching callers.

export const PHASES = ["dawn", "day", "dusk", "night"];

// Which chronotypes are awake in each phase. Larks rise early (dawn→day), owls run late (dusk→night), and the
// default townsfolk hold the bright middle (day→dusk). So dawn = larks only, night = owls only (intimate, chatty
// — few awake), while day/dusk are the bustling overlap (a crowd, each quieter). That texture is intentional.
export const AWAKE = { lark: ["dawn", "day"], default: ["day", "dusk"], owl: ["dusk", "night"] };

export const PHASE_GLYPH = { dawn: "🌅", day: "☀️", dusk: "🌆", night: "🌙" };

export function makeColonyClock({ enabled = false, cycleTicks = 240, startTick = 0, phases = PHASES, awake = AWAKE } = {}) {
  const n = phases.length;
  const wrap = (t) => (((t % cycleTicks) + cycleTicks) % cycleTicks);
  // equal-width phases: phase i covers [i/n, (i+1)/n) of the cycle
  const phaseAt = (t) => phases[Math.min(n - 1, Math.floor((wrap(t) / cycleTicks) * n))];
  let t = wrap(startTick);
  let cur = phaseAt(t);

  return {
    enabled,
    phase: () => (enabled ? cur : "day"),
    glyph: () => PHASE_GLYPH[enabled ? cur : "day"] || "",
    tickInCycle: () => t,
    fraction: () => t / cycleTicks,
    // Is this chronotype awake right now? Disabled clock → always awake.
    isAwake: (chronotype = "default") => {
      if (!enabled) return true;
      const set = awake[chronotype] || awake.default;
      return set.includes(cur);
    },
    // Advance one social tick. Returns { phase, changed } so the orchestrator can re-evaluate dormancy only on a
    // phase boundary (cheap). No-op (never "changed") while disabled.
    tick() {
      if (!enabled) return { phase: "day", changed: false };
      t = wrap(t + 1);
      const p = phaseAt(t);
      const changed = p !== cur;
      cur = p;
      return { phase: cur, changed };
    },
  };
}
