// Layered steering — ported from the float-knights study (whose bots are explicitly modelled on the Unitree
// Go2). It replaces the naive "turn away from the front quadrant" reactive field that oscillated and grazed.
// Two things fix that: (1) SEPARATION from per-obstacle vectors (not a single quadrant range), so she's pushed
// out of the way of *each* nearby obstacle continuously; (2) a LOCAL-MINIMUM ESCAPE — when seek and separation
// cancel (a dead-ahead obstacle) or progress stalls, she commits a perpendicular strafe toward the clearer
// flank until she's clear. Output is HOLONOMIC (the Go2 can strafe): a body-frame {vx,vy,vyaw} that realises
// the desired world velocity while turning to face travel — so she can side-step instantly instead of pivoting.
import { clamp, wrapAngle } from "./mathutil.js";

const ROBOT_R = 0.25;

export function makeSteering(cfg = {}) {
  const C = {
    maxSpeed: 0.45, arrive: 0.25,          // cruise speed; goal reached radius
    sepRange: 1.0, sepInner: 0.35,         // separation influence; inner "hard push" band
    sepGain: 1.35, seekGain: 1.0,          // relative weights of avoid vs. go
    turnKp: 1.7, maxVyaw: 2.0, maxVy: 0.8, maxVx: 1.5, // face-travel gain + envelope
    stuckTicks: 45, escapeMaxTicks: 200, escapeGain: 1.6, escapeSeek: 0.55, escapeExit: 0.3, escapeMinTravel: 0.7, // local-minimum escape
    ...cfg,
  };
  let lastDist = Infinity, stuck = 0, escapeLeft = 0, escapePerp = [0, 0], escapeEntryDist = Infinity, escapeStart = [0, 0];

  // Which perpendicular flank (relative to the goal heading) is clearer — steer the escape toward it.
  function clearerPerp(pose, obstacles, sx, sy) {
    const L = [-sy, sx], R = [sy, -sx];
    let scoreL = 0, scoreR = 0;
    for (const o of obstacles) {
      const ox = o.x - pose.x, oy = o.y - pose.y, d = Math.hypot(ox, oy) - o.radius - ROBOT_R;
      if (d > C.sepRange * 1.5) continue;
      const w = Math.max(0, C.sepRange * 1.5 - d);
      if (ox * L[0] + oy * L[1] > 0) scoreL += w;   // an obstacle lies toward the left flank
      if (ox * R[0] + oy * R[1] > 0) scoreR += w;
    }
    return scoreL <= scoreR ? L : R;                 // fewer obstacles that way
  }

  return {
    reset() { lastDist = Infinity; stuck = 0; escapeLeft = 0; escapePerp = [0, 0]; escapeEntryDist = Infinity; },

    // One steering step. pose {x,y,yaw}; goal {x,y}; obstacles [{x,y,radius}]. Returns a body-frame command
    // + arrived flag + the active mode (seek/escape) for introspection.
    step({ pose, goal, obstacles = [], dt = 0.02 }) {
      const dx = goal.x - pose.x, dy = goal.y - pose.y, dist = Math.hypot(dx, dy);
      if (dist < C.arrive) { this.reset(); return { vx: 0, vy: 0, vyaw: 0, arrived: true, mode: "arrived" }; }

      const sx = dx / dist, sy = dy / dist;                  // seek unit (world)
      // separation: sum repulsion from each near obstacle (two-tier: linear falloff + a hard inner band),
      // attenuated as she nears the goal so a goal sitting next to an obstacle stays reachable.
      let rx = 0, ry = 0;
      const attenuate = Math.min(1, dist / (C.arrive * 3));
      for (const o of obstacles) {
        const ox = pose.x - o.x, oy = pose.y - o.y, c = Math.hypot(ox, oy) || 1e-6;
        const sd = c - o.radius - ROBOT_R;                   // surface-to-surface distance
        if (sd >= C.sepRange) continue;
        let w = (C.sepRange - sd) / C.sepRange;              // 0 at range → 1 at contact
        if (sd < C.sepInner) w += (C.sepInner - Math.max(sd, -0.2)) / C.sepInner; // hard inner push
        rx += (ox / c) * w; ry += (oy / c) * w;
      }
      let wx = C.seekGain * sx + C.sepGain * rx * attenuate;
      let wy = C.seekGain * sy + C.sepGain * ry * attenuate;

      // local-minimum handling. When seek≈−separation (a cluster/dead-ahead) the desired collapses and she
      // orbits. The fix is a COMMITTED perpendicular strafe: pick the clearer flank once, damp the seek so she
      // commits to going around, and HOLD it until she's actually made progress past the obstruction (not a
      // fixed tick count — that's what let her re-trap). A generous timeout is only a safety valve.
      const progressed = dist < lastDist - 0.002; lastDist = Math.min(lastDist, dist);
      if (escapeLeft > 0) {
        wx = C.escapeSeek * wx + escapePerp[0] * C.escapeGain;
        wy = C.escapeSeek * wy + escapePerp[1] * C.escapeGain;
        const travelled = Math.hypot(pose.x - escapeStart[0], pose.y - escapeStart[1]);
        // exit when she's physically RELOCATED past the blocker (strafing doesn't cut goal-distance, so a
        // pure goal-progress test never fires and she orbits) — or she got closer, or the safety timeout.
        if (travelled > C.escapeMinTravel || dist < escapeEntryDist - C.escapeExit || --escapeLeft <= 0) { escapeLeft = 0; stuck = 0; lastDist = dist; }
      } else {
        if (progressed) stuck = 0; else stuck++;
        if (stuck > C.stuckTicks || Math.hypot(wx, wy) < 0.2) { escapePerp = clearerPerp(pose, obstacles, sx, sy); escapeLeft = C.escapeMaxTicks; escapeEntryDist = dist; escapeStart = [pose.x, pose.y]; stuck = 0; }
      }

      // normalise to cruise speed, slow into the goal
      const mag = Math.hypot(wx, wy) || 1;
      const speed = C.maxSpeed * Math.min(1, dist / (C.arrive * 2));
      const Wx = (wx / mag) * speed, Wy = (wy / mag) * speed;

      // world → body frame (invert the pose rotation), and turn to face travel
      const cy = Math.cos(pose.yaw), sYaw = Math.sin(pose.yaw);
      const vx = clamp(Wx * cy + Wy * sYaw, -C.maxVx, C.maxVx);
      const vy = clamp(-Wx * sYaw + Wy * cy, -C.maxVy, C.maxVy);
      const travelYaw = Math.atan2(Wy, Wx);
      const vyaw = clamp(wrapAngle(travelYaw - pose.yaw) * C.turnKp, -C.maxVyaw, C.maxVyaw);
      return { vx, vy, vyaw, arrived: false, mode: escapeLeft > 0 ? "escape" : "seek", desiredYaw: travelYaw };
    },
  };
}
