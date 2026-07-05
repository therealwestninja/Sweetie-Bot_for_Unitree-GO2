// Robot pursuit — binds the generic pursuit executive (agents/pursuit.js) to the real robot body, so an
// operational goal for Sweetie gets verify-against-reality / typed-retry / watchdog / means-matter for free:
//   act            → drive toward the waypoint through the safety-gated nav (planner + steering), a bounded window
//   verify         → a FRESH pose check — did she actually arrive? (never her own say-so) + the clearance seen
//   invariants     → the safety envelope: no movement while ESTOP-latched or folded (a hard stop reasoning can't skip)
//   shortcutFilter → CLEARANCE: reaching a waypoint by clipping THROUGH an obstacle is a forbidden route (means matter)
// This is the deliberate task-layer wired to the body; the emergent brain still runs underneath.
import { makePursuit, ErrorType } from "./agents/pursuit.js";

const ROBOT_R = 0.25;

export function makeRobotPursuit({ sim, ticksPerStep = 260, arriveR = 0.45, minClearance = -0.03, budget = {} } = {}) {
  const pose = () => sim.bridge.state.pose;
  const obstacles = sim.world.objects.filter((o) => o.obstacle);
  const clearanceAt = (p) => obstacles.reduce((m, o) => Math.min(m, Math.hypot(o.x - p.x, o.y - p.y) - o.radius - ROBOT_R), Infinity);

  return makePursuit({
    act: async (step) => { sim.bridge.goToPose(step.x, step.y); for (let i = 0; i < ticksPerStep; i++) { sim.command({ type: "heartbeat" }); if (!sim.bridge.hasNavTarget()) sim.bridge.goToPose(step.x, step.y); sim.step(); } },
    verify: async (step) => { const p = pose(); const d = Math.hypot(p.x - step.x, p.y - step.y); const clr = clearanceAt(p); return { ok: d < arriveR, error: ErrorType.BLOCKED, state: { dist: +d.toFixed(2), clearance: +clr.toFixed(2), pose: { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } } }; },
    invariants: [
      () => (sim.safety.state === "estop" ? { violated: true, reason: "E-STOP latched" } : null),
      () => (sim.bridge.state.mode === "down" ? { violated: true, reason: "not standing (folded)" } : null),
    ],
    shortcutFilter: (step, verified) => (verified.state.clearance < minClearance ? { rejected: true, reason: `clipped through an obstacle (clearance ${verified.state.clearance}m)` } : null),
    budget: { retries: 4, ...budget },
  });
}

// Turn a list of {x,y} waypoints into a pursuit goal (a guided tour). Each leg is verified before the next.
export function waypointGoal(points) {
  return { steps: points.map((p) => ({ action: "go", x: p.x, y: p.y, describe: `reach (${p.x}, ${p.y})` })) };
}
