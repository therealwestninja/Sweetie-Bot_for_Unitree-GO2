// Psyche — the inner life. Temperament gave a bot a drifting MOOD; the psyche gives it a HISTORY that mood is
// a function of. The point (the whole point, really): behaviour = f(now, everything that's happened, current
// state) — NOT f(prompt). That's what lets a townsperson hold a grudge, stew on it while idle, and act out of
// character days later for a reason you have to go digging to find.
//
// Three organs on top of the neuromodulation field:
//  1. AFFECTIVE MEMORY — an emotional event is stored WITH its valence/arousal charge; charged ones don't fade.
//  2. FEELINGS — a per-other-bot affect scalar (fondness ↔ grudge), moved by interactions, decaying slowly.
//  3. RUMINATION — while idle, dwell on the most charged unresolved memory and RE-LIVE a fraction of its affect.
//     This is the engine of "still angry about it days later": the wound re-opens itself until something heals it.
// Persistable (snapshot/restore) so "days ago" survives a reload — the grudge is a memory, and rumination
// re-creates the mood from it on the next session.
import { makeNeuromodulation, CHEMICALS } from "../../../../brain/src/neuromodulation.js";

const { DOPAMINE, NOREPINEPHRINE, SEROTONIN } = CHEMICALS;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

function seededSetpoints(seed) {
  let s = (seed >>> 0) || 1; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return { [DOPAMINE]: 0.2 + (r() - 0.5) * 0.12, [NOREPINEPHRINE]: 0.3 + (r() - 0.5) * 0.26, [SEROTONIN]: 0.5 + (r() - 0.5) * 0.34 };
}

export function makePsyche({ traits = null, seed = 1, now = () => 0 } = {}) {
  const chem = makeNeuromodulation({ setpoints: traits || seededSetpoints(seed) });
  const memories = [];          // { who, valence, arousal, text, kind, salience, at, resolved }
  const feelings = new Map();   // otherName -> affect [-1,1]
  const feabout = (who) => feelings.get(who) ?? 0;
  const setFeel = (who, d) => { if (who) feelings.set(who, clamp(feabout(who) + d, -1, 1)); };
  const MEM_CAP = 64;           // the mind holds only so many charged memories — the rest fade past recall

  // Keep the store bounded: when it overflows, FORGET the most forgettable — resolved wounds first, then the
  // least salient. Without this a long run (esp. rumination re-living wounds) grows the array without bound.
  function pruneMemories() {
    if (memories.length <= MEM_CAP) return;
    memories.sort((a, b) => (a.resolved ? -1 : a.salience) - (b.resolved ? -1 : b.salience)); // most forgettable first
    memories.splice(0, memories.length - MEM_CAP);
  }

  // The core: an emotional event. valence ∈ [-1,1], arousal ∈ [0,1], `who` = who it's ABOUT (for grudges).
  // `record` — whether this lays down a NEW memory. Rumination re-lives an existing wound (moves the mood) WITHOUT
  // minting another memory; recording it there would let wounds BREED (each re-live spawns a re-livable memory →
  // unbounded, super-linear growth = the sim's memory leak). So rumination passes record:false.
  function experience({ who = null, valence = 0, arousal = 0.3, text = "", kind = "", record = true } = {}) {
    if (valence >= 0) { chem.burst(DOPAMINE, 0.4 * valence * (0.5 + arousal)); chem.burst(SEROTONIN, 0.25 * valence); }
    else { chem.burst(NOREPINEPHRINE, 0.5 * -valence * (0.5 + arousal)); chem.burst(DOPAMINE, -0.3 * -valence); } // aversion
    chem.tick();
    setFeel(who, 0.45 * valence);
    const charge = Math.abs(valence) * (0.5 + arousal);
    if (record && charge > 0.25) { memories.push({ who, valence, arousal, text, kind, salience: +charge.toFixed(3), at: now(), resolved: false }); pruneMemories(); }
    return charge;
  }

  const _lesions = {}; // channel → its healthy setpoint, remembered so heal() can restore it exactly
  return {
    chem, experience,

    // --- perturbation hooks (the Disorders Lab) — chronically shift a neuromodulator's SETPOINT (homeostasis then
    // pulls the level toward it), so we can watch a channel-loss cascade into mood/behaviour, and HEAL it back. ---
    lesion(channel, setpoint) { if (!(channel in _lesions)) _lesions[channel] = chem.setpoint(channel); chem.setTrait({ setpoints: { [channel]: setpoint } }); return true; }, // remembers the healthy setpoint once, so repeated lesions don't lose it
    heal(channel = null) { const chans = channel ? [channel] : Object.keys(_lesions); for (const c of chans) if (c in _lesions) { chem.setTrait({ setpoints: { [c]: _lesions[c] } }); delete _lesions[c]; } return true; },
    // Snap the whole field back to a CLEAN healthy state instantly (restore setpoints AND set every level = setpoint) —
    // for "independent trials" in the lab, so one run's residue doesn't confound the next. resolveChem, not a slow settle.
    resetChem() { this.heal(); const s = chem.snapshot(); for (const k in s) s[k].level = s[k].setpoint; chem.restore(s); return true; },
    lesioned() { return { ..._lesions }; },        // which channels are currently lesioned → their healthy setpoints
    channel(name) { return { level: +chem.level(name).toFixed(3), setpoint: +chem.setpoint(name).toFixed(3) }; }, // for the lab's live traces

    // Dwell on the most charged UNRESOLVED memory → re-live a fraction of it. Call while idle. Returns the
    // memory picked (for a thought line), or null if there's nothing gnawing.
    ruminate() {
      const live = memories.filter((m) => !m.resolved && m.salience > 0.15).sort((a, b) => b.salience - a.salience);
      if (!live.length) return null;
      const m = live[0];
      experience({ who: m.who, valence: m.valence * 0.5, arousal: m.arousal * 0.7, kind: "rumination", record: false }); // relive the FEELING, don't mint a new memory
      m.salience = +(m.salience * 0.94).toFixed(3);   // picking at a wound heals it only a little
      return m;
    },
    // A good turn from someone you resented can HEAL it — mark their negative memories resolved, warm the feeling.
    reconcile(who) { setFeel(who, 0.55); for (const m of memories) if (m.who === who && m.valence < 0) m.resolved = true; chem.burst(SEROTONIN, 0.3); chem.tick(); },

    tick() {
      chem.tick();
      for (const [w, v] of feelings) feelings.set(w, v * 0.999);
      let faded = false;
      for (const m of memories) { m.salience = +(m.salience * 0.9995).toFixed(4); if (m.salience < 0.02) faded = true; }
      if (faded) for (let i = memories.length - 1; i >= 0; i--) if (memories[i].salience < 0.02) memories.splice(i, 1); // a memory faded past recall → let it go (keeps the store bounded)
    },
    mood() { const m = chem.readout(); return { valence: +m.valence.toFixed(2), arousal: +m.arousal.toFixed(2) }; },
    feabout,
    grudges() { return [...feelings.entries()].filter(([, v]) => v < -0.25).map(([who, v]) => ({ who, feeling: +v.toFixed(2) })).sort((a, b) => a.feeling - b.feeling); },
    // What the mood + feelings incline the bot to do.
    disposition() { const { valence, arousal } = this.mood(); return { cooperation: clamp01(0.55 + 0.5 * valence), curiosity: clamp01(0.4 + 0.7 * arousal + 0.25 * valence), volatility: clamp01(arousal * (0.6 - valence)) }; },

    // --- temperament-compatible surface (so existing colony wiring keeps working) ---
    onGossip() { experience({ valence: 0.18, arousal: 0.3, kind: "learned" }); },
    onChat(who) { experience({ who, valence: 0.22, arousal: 0.3, kind: "chat" }); },
    onMovedAlong() { experience({ who: "the watch", valence: -0.45, arousal: 0.75, kind: "hauled-off", text: "hauled out of my spot" }); },
    onCharged() { experience({ valence: 0.15, arousal: 0.2, kind: "topped-up" }); },
    onSlighted(who, severity = 0.6, text = "") { experience({ who, valence: -severity, arousal: 0.7, kind: "slight", text }); },
    nudge(name, mag) { chem.burst(name, mag); },
    curiosityMul() { return 0.55 + 0.9 * this.disposition().curiosity; },
    opennessMul() { return clamp01(0.7 + 0.6 * chem.readout().arousal); },

    // --- persistence ("days ago" survives a reload): the grudge is the memory + feeling; mood re-derives. ---
    snapshot() { return { memories: memories.map((m) => ({ ...m })), feelings: [...feelings] }; },
    restore(s) { if (!s) return; memories.length = 0; feelings.clear(); (s.memories || []).forEach((m) => memories.push(m)); (s.feelings || []).forEach(([w, v]) => feelings.set(w, v)); pruneMemories(); }, // REPLACE, don't append — restore runs on every rebuild, and appending would duplicate the whole store each time
  };
}
