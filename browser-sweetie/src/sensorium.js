// Sensorium — the afferent nerve. Translates the body's telemetry frame + perception events into drive on
// the brain's four input channels each cognition cycle, so the SAME winner-take-all router the chat brain
// uses (sensory→REFLEX_REPLY, memory→RESPOND, threat→ESCALATE, reward→approach) now runs on a robot's senses.
// This is the afferent half of the "senses are pluggable organs" seam: swap this module for real Go2 sensors
// later and the cognition core is unchanged. Injection values are normalized [0,1] to match the chat brain's
// scale (chemHarness/validation inject ~0.4–0.9); phasic channels are re-cleared by cognition each cycle.
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Proximity → threat: a wall at the hard floor is maximally alarming; clear past THREAT_NEAR is calm.
const THREAT_NEAR = 1.5;  // m — threat begins ramping in
const THREAT_HARD = 0.3;  // m — full alarm (matches safety's OBSTACLE_HARD_FLOOR)
// Categories that read as "someone", not "something" — a social/approach cue rather than an obstacle.
const FRIENDLY = new Set(["person", "animal"]);

export function makeSensorium({ organism } = {}) {
  const seen = new Set();       // entities ever seen → distinguishes true novelty from re-acquisition
  let lastNearest = Infinity;   // for looming detection (closing distance fast = extra salience)

  return {
    // One afferent cycle. `frame` = sim telemetryFrame; `events` = perc.drainNewEvents() strings this cycle;
    // `visible` = perc.visionSummary(...) (optional, for friendly-in-view reward); opts.addressed/prompt mark
    // a supervisor turn (a direct demand for deliberation). Returns the drive summary for telemetry/tests.
    observe(frame, events = [], { addressed = false, prompt = null, visible = [] } = {}) {
      const ro = (frame && frame.state && frame.state.range_obstacle) || [3, 3, 3, 3];
      const nearest = Math.min(...ro);
      const front = ro[0];
      const drivers = [];

      // --- threat (tonic): nearest obstacle, with a looming bonus when it's the FRONT axis closing fast ---
      let threat = clamp01((THREAT_NEAR - nearest) / (THREAT_NEAR - THREAT_HARD));
      const closing = lastNearest - nearest; // >0 = getting closer since last cycle
      if (front <= nearest + 1e-6 && closing > 0.05) { threat = clamp01(threat + 0.3); drivers.push("looming-front"); }
      lastNearest = nearest;
      if (threat > 0.05) drivers.push(`prox ${nearest.toFixed(2)}m`);

      // --- sensory (phasic): fresh perception events are novelty/salience bursts; a front-quadrant event
      // is sharper than a peripheral one. No events → a low ambient tone so the fast arc idles, not dead. ---
      let sensory = 0.15;
      for (const e of events) {
        if (/entered view|entered range|\bin (front|left|right|behind)\b/.test(e)) sensory = Math.max(sensory, 0.6);
        if (/front/.test(e)) sensory = Math.max(sensory, 0.8);
      }
      if (events.length) drivers.push(`${events.length} event(s)`);

      // --- memory (deliberation demand): a supervisor prompt is a direct request to think → drives RESPOND.
      //     A genuinely NEW entity (first sighting) also asks for a beat of deliberation, but weakly. ---
      let memory = 0;
      if (addressed || prompt) { memory = 0.9; drivers.push("addressed"); }
      for (const e of events) {
        const m = e.match(/^(.+?) entered view$/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); memory = Math.max(memory, 0.4); drivers.push(`novel:${m[1]}`); }
      }

      // --- reward (approach): a friendly face in the FOV, when nothing is threatening, is a gentle pull to
      //     orient/greet (the snap REFLEX_REPLY arc). Suppressed while a threat dominates. ---
      let reward = 0;
      if (threat < 0.5) {
        const friend = visible.find((v) => v.dynamic || FRIENDLY.has(v.category));
        if (friend) { reward = clamp01(0.5 - 0.3 * (friend.distance_m / 6)); drivers.push(`friend:${friend.name}`); }
      }

      organism.inject("threat", threat);
      organism.inject("sensory", sensory);
      organism.inject("memory", memory);
      organism.inject("reward", reward);
      return { threat: +threat.toFixed(3), sensory: +sensory.toFixed(3), memory: +memory.toFixed(3), reward: +reward.toFixed(3), nearest: +nearest.toFixed(2), drivers };
    },

    // Clear the phasic channels (call after a cycle's ticks so a burst doesn't bleed into the next cycle).
    clearPhasic() { organism.inject("sensory", 0); organism.inject("memory", 0); organism.inject("reward", 0); },
    reset() { seen.clear(); lastNearest = Infinity; },
  };
}
