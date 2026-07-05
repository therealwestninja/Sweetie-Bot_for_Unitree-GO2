// Lightweight per-agent navigator — the colony version of the hero robot's nav, WITHOUT the safety FSM /
// bridge overhead (NPCs don't need arm/heartbeat/E-STOP). It reuses the real value: A* over the static map
// (planner.js) + layered steering to execute each leg (steering.js). Crucially, `step` takes a live obstacle
// list so the colony can feed it the OTHER bots each tick — that's how bots avoid each other, not just the
// furniture. Holonomic, so a bot side-steps a neighbour instead of pivoting into it.
import { makeSteering } from "../steering.js";
import { planPath } from "../planner.js";
import { wrapAngle } from "../mathutil.js";

export function makeMover({ pose = { x: 0, y: 0, yaw: 0 }, speed = 0.5, radius = 0.28, jitter = 0, arrive = 0.25, rng = Math.random } = {}) {
  const steer = makeSteering({ maxSpeed: speed, arrive: arrive });
  let path = [], idx = 0, goal = null;
  const noise = () => (jitter ? (rng() * 2 - 1) * jitter : 0); // small motor noise → breaks symmetric livelocks + organic motion

  return {
    pose, radius,
    get goal() { return goal; },
    hasGoal: () => goal !== null,
    waypoints: () => path.slice(idx),

    // Plan a route to (x,y) around the STATIC obstacles + WALLS (buildings/road); moving bots are reactive in step().
    // `nav` = { walls, openings } — the building walls with doorway/crosswalk gaps, so routes go through doors.
    setGoal(x, y, statics = [], nav = {}) {
      goal = { x, y };
      const p = planPath({ x: pose.x, y: pose.y }, { x, y }, statics, { clearance: radius + 0.15, walls: nav.walls || [], openings: nav.openings || [], wallClear: radius + 0.08 });
      path = p && p.length ? p : [{ x, y }];
      idx = 0; steer.reset();
    },
    clearGoal() { goal = null; path = []; idx = 0; steer.reset(); },

    // Advance one step. `obstacles` = whatever this bot must avoid right now (nearby statics + the other bots).
    // Returns { arrived, moving, mode }. Integrates the holonomic steering command into the world pose.
    step(dt = 0.02, obstacles = []) {
      if (!goal) return { arrived: true, moving: false };
      const isLast = idx >= path.length - 1;
      if (!isLast && Math.hypot(path[idx].x - pose.x, path[idx].y - pose.y) < 0.4) { idx++; steer.reset(); }
      const cmd = steer.step({ pose, goal: path[idx], obstacles, dt });
      if (cmd.arrived && isLast) { this.clearGoal(); return { arrived: true, moving: false }; }
      if (cmd.arrived) { idx++; steer.reset(); return { arrived: false, moving: true, mode: "waypoint" }; }
      const jx = cmd.vx + noise(), jy = cmd.vy + noise(), jyaw = cmd.vyaw + noise() * 3;
      const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
      pose.x += (jx * cy - jy * sy) * dt;
      pose.y += (jx * sy + jy * cy) * dt;
      pose.yaw = wrapAngle(pose.yaw + jyaw * dt);
      return { arrived: false, moving: true, mode: cmd.mode };
    },
  };
}
