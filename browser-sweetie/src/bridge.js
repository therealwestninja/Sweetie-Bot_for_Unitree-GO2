// SimBridge — kinematic simulator (port of Legacy_Sweetie-Bot/core/bridge.py). Integrates commanded
// velocity → pose (no Z, no contact forces), runs the yaw-controller (look_at) and straight-line nav
// (go_to_pose), drains battery, and republishes range_obstacle from the world. The bridge does NOT call
// the SafetyGuard — the caller runs commands through safety.guard() first; the bridge only re-clamps to
// the hard envelope (defense in depth). `world` is optional (nav/look-at fall back to bare geometry).
import { clamp, wrapAngle } from "./mathutil.js";
import { makeSteering } from "./steering.js";
import { planPath } from "./planner.js";

export const BRIDGE_LIMITS = { vx: 1.5, vy: 0.8, vyaw: 2.0 };
const BATTERY_DRAIN_IDLE = 0.0001, BATTERY_DRAIN_MOVING = 0.001; // %/tick
const YAW_KP = 2.5, YAW_GOAL_TOLERANCE = 3 * Math.PI / 180;      // look_at controller
const BODY_MIN = 0.18, BODY_DEFAULT = 0.27, BODY_MAX = 0.34, BODY_DOWN = 0.10;
const NAV_SPEED = 0.45, NAV_ARRIVAL = 0.20; // cruise speed + arrival radius (steering owns the rest)
const STEER_QUERY_R = 2.0;                   // only feed obstacles within this surface distance to the steerer
const WP_SWITCH = 0.4;                        // advance to the next planned waypoint within this distance

export function makeBridge({ world = null, now = () => 0 } = {}) {
  const s = {
    timestamp: now(),
    velocity: { x: 0, y: 0, yaw: 0 },
    pose: { x: 0, y: 0, yaw: 0 },
    body_height: BODY_DOWN,
    imu: { roll: 0, pitch: 0 },
    battery_percent: 100,
    mode: "down", // "down" | "standing" | "moving" | "estop"
    range_obstacle: [3, 3, 3, 3], // [front, left, back, right], default = max range
  };
  let yawTarget = null; // look_at goal (radians, world frame)
  let navTarget = null; // current leg goal { x, y } (the active waypoint)
  let navPath = [];     // A* waypoints from goToPose (static-obstacle route); last = the true goal
  let navIdx = 0;       // index of the active waypoint in navPath
  const steer = makeSteering({ maxSpeed: NAV_SPEED, arrive: NAV_ARRIVAL }); // layered go_to_pose steering

  const isMoving = () => s.velocity.x !== 0 || s.velocity.y !== 0 || s.velocity.yaw !== 0;
  const clearTargets = () => { yawTarget = null; navTarget = null; navPath = []; navIdx = 0; steer.reset(); };

  // Advance one step of `dt` seconds. Order matches bridge.py._integrate exactly.
  function integrate(dt) {
    s.timestamp = now();
    const estop = s.mode === "estop";

    if (yawTarget !== null && !estop) {
      // rotate in place toward the look_at bearing
      const err = wrapAngle(yawTarget - s.pose.yaw);
      if (Math.abs(err) < YAW_GOAL_TOLERANCE) { s.velocity.yaw = 0; yawTarget = null; if (s.mode === "moving") s.mode = "standing"; }
      else { s.velocity.x = 0; s.velocity.y = 0; s.velocity.yaw = clamp(YAW_KP * err, -BRIDGE_LIMITS.vyaw, BRIDGE_LIMITS.vyaw); }
    } else if (navTarget !== null && !estop) {
      // Follow the planned waypoints; the layered steering executes each leg holonomically and still dodges
      // DYNAMIC entities the static plan didn't know about. Advance to the next waypoint as she nears it; the
      // final one is the true goal, where the steering's arrival radius settles her to standing.
      const isLast = navIdx >= navPath.length - 1;
      if (!isLast && Math.hypot(navTarget.x - s.pose.x, navTarget.y - s.pose.y) < WP_SWITCH) { navTarget = navPath[++navIdx]; steer.reset(); }
      const obstacles = world ? world.objects.filter((o) => o.obstacle && Math.hypot(o.x - s.pose.x, o.y - s.pose.y) - o.radius < STEER_QUERY_R) : [];
      const cmd = steer.step({ pose: s.pose, goal: navTarget, obstacles, dt });
      if (cmd.arrived && isLast) { navTarget = null; navPath = []; s.velocity.x = 0; s.velocity.y = 0; s.velocity.yaw = 0; s.mode = "standing"; }
      else if (cmd.arrived) { navTarget = navPath[++navIdx]; steer.reset(); }
      else { s.velocity.x = cmd.vx; s.velocity.y = cmd.vy; s.velocity.yaw = cmd.vyaw; }
    }

    // pose integration in the world frame
    const { x: vx, y: vy, yaw: vyaw } = s.velocity;
    const cy = Math.cos(s.pose.yaw), sy = Math.sin(s.pose.yaw);
    s.pose.x += (vx * cy - vy * sy) * dt;
    s.pose.y += (vx * sy + vy * cy) * dt;
    s.pose.yaw = wrapAngle(s.pose.yaw + vyaw * dt);

    if (world) {
      const observer = { x: s.pose.x, y: s.pose.y, yaw: s.pose.yaw };
      if (world.tick) world.tick(dt, observer);
      if (world.proximityRanges) s.range_obstacle = world.proximityRanges(s.pose.x, s.pose.y, s.pose.yaw);
    }

    s.battery_percent = Math.max(0, s.battery_percent - (isMoving() ? BATTERY_DRAIN_MOVING : BATTERY_DRAIN_IDLE));
    return s;
  }

  return {
    state: s,
    toDict() { return JSON.parse(JSON.stringify(s)); },
    integrate,

    // --- commands (the caller has already run these through safety.guard/guardAction) ---
    standUp() { if (s.mode === "estop") return false; s.mode = "standing"; s.body_height = BODY_DEFAULT; return true; },
    standDown() { if (s.mode === "estop") return false; s.mode = "down"; s.body_height = BODY_DOWN; s.velocity = { x: 0, y: 0, yaw: 0 }; yawTarget = null; return true; },
    move(vx, vy, vyaw) {
      if (s.mode === "estop" || s.mode === "down") return false;
      yawTarget = null;
      if (vx !== 0 || vy !== 0 || vyaw !== 0) navTarget = null;
      s.velocity.x = clamp(vx, -BRIDGE_LIMITS.vx, BRIDGE_LIMITS.vx);
      s.velocity.y = clamp(vy, -BRIDGE_LIMITS.vy, BRIDGE_LIMITS.vy);
      s.velocity.yaw = clamp(vyaw, -BRIDGE_LIMITS.vyaw, BRIDGE_LIMITS.vyaw);
      s.mode = (vx !== 0 || vy !== 0 || vyaw !== 0) ? "moving" : "standing";
      return true;
    },
    stopMove() { s.velocity = { x: 0, y: 0, yaw: 0 }; clearTargets(); if (s.mode === "moving") s.mode = "standing"; return true; },
    emergencyStop() { s.velocity = { x: 0, y: 0, yaw: 0 }; s.mode = "estop"; clearTargets(); return true; },
    clearEstop() { if (s.mode === "estop") { s.mode = "down"; return true; } return false; },
    setBodyHeight(m) { if (s.mode === "down") return false; s.body_height = clamp(m, BODY_MIN, BODY_MAX); return true; },
    goToPose(x, y) {
      if (s.mode === "estop" || s.mode === "down") return false;
      yawTarget = null;
      // Plan a route around the STATIC obstacles (furniture/cars/walls); dynamic entities are left to the
      // steering. Falls back to a direct heading if there's no world or no route.
      const statics = world ? world.objects.filter((o) => o.obstacle && !o.dynamic).map((o) => ({ x: o.x, y: o.y, radius: o.radius })) : [];
      const path = world ? planPath({ x: s.pose.x, y: s.pose.y }, { x, y }, statics, { clearance: 0.4 }) : null;
      navPath = path && path.length ? path : [{ x, y }];
      navIdx = 0; navTarget = navPath[0]; steer.reset(); s.mode = "moving"; return true;
    },
    lookAtEntity(name) {
      if (!world) return "no_world";
      if (s.mode === "down" || s.mode === "estop") return "wrong_mode";
      const bearing = world.bearingFrom ? world.bearingFrom(s.pose.x, s.pose.y, name) : null;
      if (bearing === null || bearing === undefined) return "no_target";
      yawTarget = bearing; s.mode = "moving"; return "ok";
    },
    performGesture(name, safeSet = null) {
      if (s.mode === "estop" || s.mode === "down") return false;
      if (safeSet && !safeSet.has(name)) return false; // unknown/unsafe gesture
      return true; // behavioural-only in sim
    },
    // introspection used by tests / the loop
    hasYawTarget: () => yawTarget !== null,
    hasNavTarget: () => navTarget !== null,
    navWaypoints: () => navPath.slice(navIdx), // remaining planned waypoints (for the UI / harness)
  };
}
