// Temperament — a lightweight BRAIN per townsperson, so their behaviour varies organically instead of running
// on fixed constants. It's the project's own neuromodulation field (the 4-chemical mood engine from the spiking
// brain), given a distinct baseline per bot (seed → different resting temperament) and nudged by what happens
// to them: learning gossip is mildly rewarding, a chat warms them, being moved-along by the Watch stresses
// them, topping up feels good. The drifting mood then modulates their curiosity (do they seek the well?) and
// openness (how easily their opinion sways) — so a bot has good days and bad days, and no two behave alike.
//
// This is the honest, principled answer to "the colony feels robotic": real (tested) brain chemistry, per bot.
import { makeNeuromodulation, CHEMICALS } from "../../../../brain/src/neuromodulation.js";

const { DOPAMINE, NOREPINEPHRINE, SEROTONIN } = CHEMICALS;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Deterministic per-bot baseline: small offsets from a seed → some folk are naturally sunnier, edgier, calmer.
function seededSetpoints(seed) {
  let s = (seed >>> 0) || 1; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return {
    [DOPAMINE]: 0.2 + (r() - 0.5) * 0.12,
    [NOREPINEPHRINE]: 0.3 + (r() - 0.5) * 0.26,
    [SEROTONIN]: 0.5 + (r() - 0.5) * 0.34,
  };
}

export function makeTemperament({ traits = null, seed = 1 } = {}) {
  const chem = makeNeuromodulation({ setpoints: traits || seededSetpoints(seed) });
  return {
    tick() { chem.tick(); },                                   // homeostatic drift back toward baseline
    mood() { const m = chem.readout(); return { valence: +m.valence.toFixed(2), arousal: +m.arousal.toFixed(2) }; },

    // --- events nudge the mood ---
    onGossip() { chem.burst(DOPAMINE, 0.12); },                // learning something new = mildly rewarding
    onChat() { chem.burst(SEROTONIN, 0.10); chem.burst(DOPAMINE, 0.04); }, // company = warmth
    onMovedAlong() { chem.burst(NOREPINEPHRINE, 0.35); chem.burst(DOPAMINE, -0.12); }, // being told off = stress
    onCharged() { chem.burst(DOPAMINE, 0.10); chem.burst(SEROTONIN, 0.05); },          // a top-up feels good
    nudge(name, mag) { chem.burst(name, mag); },

    // --- mood → behaviour multipliers ---
    curiosityMul() { return 0.55 + 0.9 * chem.readout().arousal; },        // aroused → more likely to seek the well
    opennessMul() { return clamp01(0.7 + 0.6 * chem.readout().arousal); }, // agitated → more swayable; calm → entrenched
    chem,
  };
}
