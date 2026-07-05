// SimPerception — camera FOV + occlusion + quadrant awareness, emitting events (port of
// Legacy_Sweetie-Bot/sim/perception.py). Two views that can disagree: forward vision (70° cone, occluded)
// vs 360° quadrant awareness. Feeds the brain's salience/attention + phasic event channels.
import { wrapAngle } from "./mathutil.js";

const HALF_FOV = (35 * Math.PI) / 180; // 70° cone
const VISION_RANGE = 8.0;
const PERCEPTION_RANGE = 6.0;
const MIN_STATIC_VISION_RADIUS = 0.1;
const EVENT_LOG_MAX = 256;

export function makeSimPerception({ world, now = () => 0 } = {}) {
  const quad = {};   // name -> last quadrant ("far" | front/left/back/right)
  const inview = {}; // name -> bool
  const log = [];    // { at, event }
  let fresh = [];    // events since last drain

  function emit(event) { const at = now(); fresh.push(event); log.push({ at, event }); while (log.length > EVENT_LOG_MAX) log.shift(); }

  function classifyQuadrant(rx, ry, ryaw, tx, ty) {
    const dist = Math.hypot(tx - rx, ty - ry);
    if (dist > PERCEPTION_RANGE) return "far";
    const b = wrapAngle(Math.atan2(ty - ry, tx - rx) - ryaw), ab = Math.abs(b);
    if (ab <= Math.PI / 4) return "front";
    if (ab >= 3 * Math.PI / 4) return "back";
    return b > 0 ? "left" : "right";
  }

  function isVisible(o, rx, ry, ryaw) {
    const dx = o.x - rx, dy = o.y - ry, dist = Math.hypot(dx, dy);
    if (dist < 1e-6 || dist > VISION_RANGE) return false;
    if (Math.abs(wrapAngle(Math.atan2(dy, dx) - ryaw)) > HALF_FOV) return false; // outside the cone
    if (!o.dynamic && o.radius < MIN_STATIC_VISION_RADIUS) return false;          // tiny static clutter
    for (const c of world.objects) {                                             // occlusion
      if (c === o || !c.obstacle) continue;
      const od = Math.hypot(c.x - rx, c.y - ry);
      if (od >= dist) continue;                                                   // must be nearer
      const t = ((c.x - rx) * dx + (c.y - ry) * dy) / (dist * dist);
      if (t <= 0 || t >= 1) continue;
      const px = rx + t * dx, py = ry + t * dy;
      if (Math.hypot(c.x - px, c.y - py) < c.radius) return false;                // disk straddles the ray
    }
    return true;
  }

  return {
    isVisible: (o, x, y, yaw) => isVisible(o, x, y, yaw),
    classifyQuadrant,

    visionSummary(x, y, yaw) {
      const out = [];
      for (const o of world.objects) {
        if (!isVisible(o, x, y, yaw)) continue;
        const dx = o.x - x, dy = o.y - y;
        out.push({ name: o.name, distance_m: +Math.hypot(dx, dy).toFixed(2), bearing_deg: +((wrapAngle(Math.atan2(dy, dx) - yaw) * 180) / Math.PI).toFixed(1), category: o.category, dynamic: o.dynamic });
      }
      return out.sort((a, b) => a.distance_m - b.distance_m);
    },

    // per-tick: emit quadrant-transition (dynamic) + vision enter/exit (all) event strings
    tick(x, y, yaw) {
      for (const o of world.objects) {
        if (o.dynamic) {
          const prev = quad[o.name], q = classifyQuadrant(x, y, yaw, o.x, o.y);
          if (prev === undefined) { if (q !== "far") emit(`${o.name} in ${q}`); }
          else if (prev === "far" && q !== "far") emit(`${o.name} entered range (${q})`);
          else if (prev !== "far" && q === "far") emit(`${o.name} left visible range`);
          else if (prev !== q && q !== "far") emit(`${o.name} now in ${q}`);
          quad[o.name] = q;
        }
        const vis = isVisible(o, x, y, yaw), was = !!inview[o.name];
        if (vis && !was) emit(`${o.name} entered view`);
        else if (!vis && was) emit(`${o.name} left view`);
        inview[o.name] = vis;
      }
    },

    recentEvents(windowS = 30) { const cutoff = now() - windowS; return log.filter((e) => e.at >= cutoff).map((e) => ({ event: e.event, age_s: +(now() - e.at).toFixed(2) })); },
    drainNewEvents() { const e = fresh; fresh = []; return e; },
  };
}
