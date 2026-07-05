// Safety FSM + command chokepoint — a faithful JS port of Legacy_Sweetie-Bot/core/safety.py. This is the
// single most important body module: EVERY motion command (supervisor joystick OR brain/LLM tool-call)
// passes through guard()/guardAction() before it can move the robot. Pure logic; clocks injected for tests.
//
// States: IDLE (connected, folded — refuses all but stand_up/clear) → ARMED (operator armed; stand ok, move
// blocked pending heartbeat) → ACTIVE (heartbeats flowing; motion allowed) → ESTOP (latched; clear only).

export const SafetyState = { IDLE: "idle", ARMED: "armed", ACTIVE: "active", ESTOP: "estop" };

export const SAFETY_LIMITS = { vx: 1.5, vy: 0.8, vyaw: 2.0 }; // m/s, m/s, rad/s
const HEARTBEAT_TIMEOUT_S = 1.0;
const BATTERY_LOW_PERCENT = 15.0;
const TILT_LIMIT_RAD = 0.6;              // ~34°
const OBSTACLE_HARD_FLOOR = 0.3;         // m — axis zeroed at/below
const OBSTACLE_SLOWDOWN_START = 1.0;     // m — full speed at/above
const ASSIST_LOG_MAX = 16;

const READ_ONLY = new Set(["report"]);
const ALWAYS = new Set(["halt"]);
const ARMED_REQUIRED = new Set(["stand_up", "sit_down", "look_at", "gesture", "go_to_pose", "follow_path", "set_body_height"]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// now = MONOTONIC seconds (heartbeat/timeout); wallNow = WALL-CLOCK seconds (assist log timestamps). Kept
// distinct because monotonic can't go backwards (safe for timeouts) but wall time is what "how long ago" means.
export function makeSafety({ now = () => 0, wallNow = () => 0 } = {}) {
  let state = SafetyState.IDLE;
  let lastHeartbeat = 0;
  const assistLog = []; // { at (wall), reason }

  // proximity range on one side -> velocity scale [0,1] + a human reason (or null when clear).
  function proximityScale(rangeM, side) {
    if (rangeM >= OBSTACLE_SLOWDOWN_START) return [1.0, null];
    if (rangeM <= OBSTACLE_HARD_FLOOR) return [0.0, `blocked (${side} ${rangeM.toFixed(2)}m)`];
    const scale = (rangeM - OBSTACLE_HARD_FLOOR) / (OBSTACLE_SLOWDOWN_START - OBSTACLE_HARD_FLOOR);
    return [scale, `slowed (${side} ${rangeM.toFixed(2)}m)`];
  }

  return {
    get state() { return state; },

    // --- state transitions ---
    arm() { if (state === SafetyState.ESTOP) return false; if (state === SafetyState.IDLE) { state = SafetyState.ARMED; return true; } return true; },
    disarm() { if (state === SafetyState.ESTOP) return false; state = SafetyState.IDLE; lastHeartbeat = 0; return true; },
    heartbeat() { if (state === SafetyState.ARMED) state = SafetyState.ACTIVE; if (state === SafetyState.ACTIVE) { lastHeartbeat = now(); return true; } return false; },
    estop() { if (state === SafetyState.ESTOP) return false; state = SafetyState.ESTOP; return true; },
    clearEstop() { if (state !== SafetyState.ESTOP) return false; state = SafetyState.IDLE; lastHeartbeat = 0; return true; },

    // Periodic predicate check (heartbeat loss, battery-low, tilt) — call from the sim tick loop.
    tick(robotState = {}) {
      if (state === SafetyState.ACTIVE && now() - lastHeartbeat > HEARTBEAT_TIMEOUT_S) state = SafetyState.ARMED;
      if (state !== SafetyState.ESTOP) {
        const batt = robotState.battery_percent ?? 100;
        const imu = robotState.imu || { roll: 0, pitch: 0 };
        if (batt < BATTERY_LOW_PERCENT) state = SafetyState.ESTOP;
        else if (Math.abs(imu.roll) > TILT_LIMIT_RAD || Math.abs(imu.pitch) > TILT_LIMIT_RAD) state = SafetyState.ESTOP;
      }
    },

    // THE motion chokepoint. Clamps to the envelope, then scales the axis moving TOWARD an obstacle.
    // range_obstacle = [front, left, back, right]. yaw is never scaled (rotating in place closes no distance).
    guard(vx, vy, vyaw, robotState = null) {
      if (state === SafetyState.ESTOP) return { allowed: false, reason: "estop latched", vx: 0, vy: 0, vyaw: 0, assists: [] };
      if (state === SafetyState.IDLE) return { allowed: false, reason: "not armed", vx: 0, vy: 0, vyaw: 0, assists: [] };
      if (state === SafetyState.ARMED) return { allowed: false, reason: "no heartbeat (send heartbeat to ACTIVATE)", vx: 0, vy: 0, vyaw: 0, assists: [] };
      let cvx = clamp(vx, -SAFETY_LIMITS.vx, SAFETY_LIMITS.vx);
      let cvy = clamp(vy, -SAFETY_LIMITS.vy, SAFETY_LIMITS.vy);
      const cvyaw = clamp(vyaw, -SAFETY_LIMITS.vyaw, SAFETY_LIMITS.vyaw);
      const assists = [];
      const ro = robotState && robotState.range_obstacle;
      const scaleAxis = (v, s) => { const out = v * s; return out === 0 ? 0 : out; }; // normalize -0 -> +0
      if (ro) {
        if (cvx > 0) { const [s, r] = proximityScale(ro[0], "front"); cvx = scaleAxis(cvx, s); if (r) assists.push(r); }
        else if (cvx < 0) { const [s, r] = proximityScale(ro[2], "back"); cvx = scaleAxis(cvx, s); if (r) assists.push(r); }
        if (cvy > 0) { const [s, r] = proximityScale(ro[1], "left"); cvy = scaleAxis(cvy, s); if (r) assists.push(r); }
        else if (cvy < 0) { const [s, r] = proximityScale(ro[3], "right"); cvy = scaleAxis(cvy, s); if (r) assists.push(r); }
      }
      return { allowed: true, reason: "ok", vx: cvx, vy: cvy, vyaw: cvyaw, assists };
    },

    // The discrete-action chokepoint (stand_up / look_at / go_to_pose / …).
    guardAction(action) {
      if (READ_ONLY.has(action)) return { allowed: true, reason: "ok" };
      if (ALWAYS.has(action)) return { allowed: true, reason: "ok" }; // halt always allowed, even in ESTOP
      if (ARMED_REQUIRED.has(action)) {
        if (state === SafetyState.ESTOP) return { allowed: false, reason: "estop latched" };
        if (state === SafetyState.IDLE) return { allowed: false, reason: "not armed" };
        return { allowed: true, reason: "ok" };
      }
      return { allowed: false, reason: `unknown action '${action}'` };
    },

    // Smart-assist ring buffer — lets the brain answer "why did I slow down?".
    recordAssist(reason) { assistLog.push({ at: wallNow(), reason }); while (assistLog.length > ASSIST_LOG_MAX) assistLog.shift(); },
    recentAssists(windowS = 30) {
      const cutoff = wallNow() - windowS;
      return assistLog.filter((a) => a.at >= cutoff).map((a) => ({ age_s: +(wallNow() - a.at).toFixed(2), reason: a.reason }));
    },

    proximityScale, // exposed for tests
    toDict() { return { state, limits: { ...SAFETY_LIMITS }, heartbeat_timeout_s: HEARTBEAT_TIMEOUT_S }; },
  };
}
