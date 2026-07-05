// Commit-discipline — the anti-dither governor, ported from the float-knights study (whose bots are
// explicitly modeled on the Unitree Go2). A continuous perceive→decide→act loop flip-flops: two arcs of
// near-equal drive trade the winner-take-all every tick and the body twitches. Three mechanisms fix it,
// all overridable by an EMERGENCY interrupt (a looming obstacle must always win instantly):
//   1. arc-commit hold   — once an arc is chosen, keep it for >= arcCommitTicks before a rival can take over
//                          (a software stand-in for lateral-inhibition self-excitation in the decision layer).
//   2. target-memory     — a look_at/go_to target is RETAINED for targetTTL ticks after it leaves view, TTL
//                          counting down only while blind (the fix for look-at twitch when a person steps
//                          behind furniture). Re-seeing it refills the TTL.
//   3. emergency-interrupt — proximity inside the hard bubble (or a bump) preempts the committed arc at once.

export function makeCommitController({ arcCommitTicks = 6, targetTTL = 25, bubble = 0.45 } = {}) {
  let committedArc = "QUIET";
  let ticksInArc = 0;
  let target = null;      // { name, ttl }

  return {
    // Stabilize the raw winner-take-all reading into a committed arc. `reading` = { action, confidence }.
    // emergency short-circuits the hold. Returns { arc, switched, suppressed?, reason }.
    chooseArc(reading = { action: "QUIET" }, { emergency = false, emergencyArc = "ESCALATE" } = {}) {
      if (emergency) {
        const switched = committedArc !== emergencyArc;
        committedArc = emergencyArc; ticksInArc = 0;
        return { arc: committedArc, switched, reason: "emergency" };
      }
      ticksInArc++;
      const candidate = reading.action || "QUIET";
      if (candidate === committedArc) return { arc: committedArc, switched: false, reason: "held (same winner)" };
      // Leaving idle (QUIET) is instant — the hold only resists trading between ACTIVE arcs, which is where
      // the twitch lives. From an active arc, a rival must out-wait the commit window.
      if (committedArc !== "QUIET" && ticksInArc < arcCommitTicks) return { arc: committedArc, switched: false, suppressed: candidate, reason: `commit-hold ${ticksInArc}/${arcCommitTicks}` };
      const prev = committedArc;
      committedArc = candidate; ticksInArc = 0;
      return { arc: committedArc, switched: true, from: prev, reason: prev === "QUIET" ? "from idle" : "window elapsed" };
    },

    // Looming-obstacle / bump preemption. `frame` = sim telemetryFrame; bumped is an optional external flag.
    emergencyInterrupt(frame, { bumped = false } = {}) {
      const ro = (frame && frame.state && frame.state.range_obstacle) || [3, 3, 3, 3];
      const nearest = Math.min(...ro);
      if (bumped) return { tripped: true, reason: "bump" };
      if (nearest <= bubble) return { tripped: true, reason: `obstacle ${nearest.toFixed(2)}m in bubble` };
      return { tripped: false, nearest: +nearest.toFixed(2) };
    },

    // --- attention target-memory ---
    setTarget(name) { if (name) target = { name, ttl: targetTTL }; },
    // Call once per cognition cycle with the currently-visible entity names. Refills TTL if the target is in
    // view; otherwise decays it; drops the target at TTL 0. Returns the live target name (or null).
    tickTargets(visibleNames = []) {
      if (!target) return null;
      if (visibleNames.includes(target.name)) target.ttl = targetTTL;
      else if (--target.ttl <= 0) target = null;
      return target ? target.name : null;
    },
    target() { return target ? target.name : null; },
    targetTtl() { return target ? target.ttl : 0; },
    hasTarget() { return !!target; },

    reset() { committedArc = "QUIET"; ticksInArc = 0; target = null; },
    get arc() { return committedArc; },
    get ticks() { return ticksInArc; },
  };
}
