// Simulated world — objects, regions, scenes, and reactive entities (port of Legacy_Sweetie-Bot/sim/world.py).
// Coordinates: x = east/forward, y = north/left, yaw CCW from +x, meters. NOT a physics engine — circles,
// no collisions, entities drift freely; the point is a live agent-in-environment for the brain to move through.
import { wrapAngle } from "./mathutil.js";

// tiny deterministic PRNG (mulberry32) so reactive entities are reproducible per seed
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function obj(name, x, y, o = {}) {
  return { name, x, y, radius: o.radius ?? 0.3, description: o.description ?? "", category: o.category ?? "object", obstacle: o.obstacle ?? true, dynamic: false };
}
export function region(name, x_min, x_max, y_min, y_max, description = "") {
  return { name, x_min, x_max, y_min, y_max, description, contains(x, y) { return x >= x_min && x <= x_max && y >= y_min && y <= y_max; } };
}

// ---- reactive entities ----
// Cat: random-walk within roam_radius of home; flees directly away when the observer gets within flee_distance.
export function wanderer(name, x, y, o = {}) {
  const e = {
    name, x, y, radius: o.radius ?? 0.15, category: o.category ?? "animal", obstacle: o.obstacle ?? true, dynamic: true,
    description: o.description ?? "", _prevX: x, _prevY: y, _dt: 0.02,
    homeX: o.homeX ?? x, homeY: o.homeY ?? y, speed: o.speed ?? 0.2, roam: o.roam ?? 1.0, tol: o.tol ?? 0.05,
    fleeDist: o.fleeDist ?? 0, fleeMul: o.fleeMul ?? 2.0, tx: x, ty: y, rand: rng(o.seed ?? 1234),
  };
  e.update = function (dt, observer) {
    this._prevX = this.x; this._prevY = this.y; this._dt = dt;
    let fleeing = false;
    if (observer && this.fleeDist > 0) {
      const dx = this.x - observer.x, dy = this.y - observer.y, d = Math.hypot(dx, dy);
      if (d <= this.fleeDist) {
        fleeing = true;
        const step = this.fleeDist * 1.5;
        if (d < 1e-6) { const a = (this.rand() * 2 - 1) * Math.PI; this.tx = this.x + Math.cos(a) * step; this.ty = this.y + Math.sin(a) * step; }
        else { this.tx = this.x + (dx / d) * step; this.ty = this.y + (dy / d) * step; }
      }
    }
    const dx = this.tx - this.x, dy = this.ty - this.y, dist = Math.hypot(dx, dy);
    const spd = this.speed * (fleeing ? this.fleeMul : 1);
    if (dist < this.tol) { const a = (this.rand() * 2 - 1) * Math.PI, r = this.rand() * this.roam; this.tx = this.homeX + Math.cos(a) * r; this.ty = this.homeY + Math.sin(a) * r; }
    else { const m = Math.min(spd * dt, dist); this.x += (dx / dist) * m; this.y += (dy / dist) * m; }
  };
  return e;
}

// Person: loops a waypoint path; yields (freezes) when the observer is inside the forward cone toward the goal.
export function pathWalker(name, x, y, waypoints, o = {}) {
  const e = {
    name, x, y, radius: o.radius ?? 0.25, category: o.category ?? "person", obstacle: o.obstacle ?? true, dynamic: true,
    description: o.description ?? "", _prevX: x, _prevY: y, _dt: 0.02,
    waypoints, speed: o.speed ?? 0.3, tol: o.tol ?? 0.08, yieldDist: o.yieldDist ?? 0, coneCos: o.coneCos ?? 0.5, wp: 0,
  };
  e.update = function (dt, observer) {
    this._prevX = this.x; this._prevY = this.y; this._dt = dt;
    const goal = this.waypoints[this.wp];
    if (observer && this.yieldDist > 0) {
      const ox = observer.x - this.x, oy = observer.y - this.y, od = Math.hypot(ox, oy);
      const hx = goal[0] - this.x, hy = goal[1] - this.y, hd = Math.hypot(hx, hy);
      if (od <= this.yieldDist) {
        if (od < 1e-6) return; // observer on top -> yield
        const cos = (ox * hx + oy * hy) / (od * hd || 1);
        if (cos > this.coneCos) return; // in the forward cone -> freeze
      }
    }
    const dx = goal[0] - this.x, dy = goal[1] - this.y, dist = Math.hypot(dx, dy);
    if (dist < this.tol) { this.wp = (this.wp + 1) % this.waypoints.length; }
    else { const m = Math.min(this.speed * dt, dist); this.x += (dx / dist) * m; this.y += (dy / dist) * m; }
  };
  return e;
}

const FRONT = 0, LEFT = 1, BACK = 2, RIGHT = 3;

export function makeWorld({ objects = [], regions = [] } = {}) {
  const norm = (n) => String(n).toLowerCase().replace(/^the\s+/, "").trim();
  return {
    objects, regions,
    names() { return objects.map((o) => o.name); },
    byName(name) { const q = norm(name); return objects.find((o) => norm(o.name) === q) || null; },
    regionAt(x, y) { return regions.find((r) => r.contains(x, y)) || null; },
    bearingFrom(x, y, name) { const o = this.byName(name); return o ? Math.atan2(o.y - y, o.x - x) : null; },

    // advance dynamic entities; snapshot prev-pos for velocity recovery
    tick(dt, observer) { for (const o of objects) if (o.dynamic && o.update) { o.update(dt, observer); o._dt = dt; } },
    velocityOf(o) { const dt = o._dt || 0.02; return { x: (o.x - o._prevX) / dt, y: (o.y - o._prevY) / dt }; },

    // 4-quadrant nearest-edge proximity → [front,left,back,right] (mirrors the real Go2 range_obstacle[4]).
    proximityRanges(x, y, yaw, maxRange = 3.0) {
      const ranges = [maxRange, maxRange, maxRange, maxRange];
      const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
      for (const o of objects) {
        if (!o.obstacle) continue;
        const dx = o.x - x, dy = o.y - y;
        const rx = dx * cy - dy * sy, ry = dx * sy + dy * cy; // world→robot frame
        const edge = Math.max(0, Math.hypot(rx, ry) - o.radius);
        if (edge >= maxRange) continue;
        const ang = Math.atan2(ry, rx);
        let q;
        if (ang >= -Math.PI / 4 && ang < Math.PI / 4) q = FRONT;
        else if (ang >= Math.PI / 4 && ang < 3 * Math.PI / 4) q = LEFT;
        else if (ang >= 3 * Math.PI / 4 || ang < -3 * Math.PI / 4) q = BACK;
        else q = RIGHT;
        if (edge < ranges[q]) ranges[q] = edge;
      }
      return ranges;
    },

    // omnidirectional "what's around me" (no FOV/occlusion) — used by report_status. Dynamic entities get
    // a velocity + motion classification relative to the observer.
    visibleSummary(x, y, maxRange = 6.0) {
      const out = [];
      for (const o of objects) {
        const dx = o.x - x, dy = o.y - y, d = Math.hypot(dx, dy);
        if (d > maxRange) continue;
        const row = { name: o.name, distance_m: +d.toFixed(2), category: o.category, dynamic: o.dynamic };
        if (o.dynamic) {
          const v = this.velocityOf(o); const speed = Math.hypot(v.x, v.y);
          const ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0;
          const closing = -(v.x * ux + v.y * uy); // +ve = approaching the observer
          row.motion = d < 1e-6 ? "at observer" : speed < 0.05 ? "stationary" : closing > 0.05 ? "approaching" : closing < -0.05 ? "receding" : "parallel";
        }
        out.push(row);
      }
      return out.sort((a, b) => a.distance_m - b.distance_m);
    },
  };
}

// ---- scenes ----
function apartment() {
  const objects = [
    obj("couch", 2, 1.5, { radius: 0.6, category: "furniture" }),
    obj("coffee table", 1.2, 0, { radius: 0.4, category: "furniture" }),
    obj("kitchen counter", -1.5, 2.5, { radius: 0.7, category: "furniture" }),
    obj("door", -2.5, 0, { radius: 0.2, category: "fixture" }),
    obj("rug", 1, 0.5, { radius: 0, category: "terrain", obstacle: false }),
    wanderer("the cat", 0.5, -1.5, { radius: 0.15, speed: 0.15, roam: 0.8, fleeDist: 0.6, fleeMul: 2.5, homeX: 0.5, homeY: -1.5, seed: 7 }),
    pathWalker("the person", -2, 1.5, [[-2, 1.5], [-1, 2.5], [1, 2.5], [2, 1], [1, -0.5], [-0.5, -0.5], [-2, 0.5]], { radius: 0.25, speed: 0.4, yieldDist: 1.0 }),
  ];
  return makeWorld({ objects, regions: [region("apartment", -3, 3.5, -3, 4)] });
}
function street() {
  const objects = [obj("road", 6, 0, { radius: 0, category: "terrain", obstacle: false }), obj("car", 6, -1, { radius: 0.9, category: "vehicle" }), obj("lamp post", 4, 2, { radius: 0.15, category: "infrastructure" }), obj("fire hydrant", 5, 1.5, { radius: 0.2, category: "fixture" })];
  for (let i = 0; i < 4; i++) objects.push(obj("cone " + (i + 1), 4.5 + i * 0.6, -0.5, { radius: 0.15, category: "cone" }));
  objects.push(pathWalker("the pedestrian", 5, 3, [[5, 3], [7, 0], [5, -3], [7, 0]], { radius: 0.25, speed: 0.5, yieldDist: 1.1 }));
  return makeWorld({ objects, regions: [region("street", 3.5, 9, -9, 4)] });
}
function obstacleField(count, seed) {
  const r = rng(seed), objects = [], placed = [];
  let tries = 0;
  while (objects.length < count && tries < count * 30) {
    tries++;
    const x = r() * 18 - 9, y = r() * 18 - 9, rad = 0.2 + r() * 0.4;
    if (Math.hypot(x, y) < 1.5 + rad) continue;
    if (placed.some((p) => Math.hypot(x - p.x, y - p.y) < rad + p.r + 0.1)) continue;
    placed.push({ x, y, r: rad });
    objects.push(obj("rock " + objects.length, x, y, { radius: rad, category: "barrier" }));
  }
  return makeWorld({ objects, regions: [region("obstacle field", -9, 9, -9, 9)] });
}

function parkingLot() {
  const objects = [];
  // two rows of parked cars flanking a central drive lane (x −5..5), lane clear down the middle (y≈0)
  for (let i = 0; i < 6; i++) {
    const x = -5 + i * 2;
    objects.push(obj("car " + (i * 2 + 1), x, 2.4, { radius: 0.9, category: "vehicle" }));
    objects.push(obj("car " + (i * 2 + 2), x, -2.4, { radius: 0.9, category: "vehicle" }));
  }
  objects.push(obj("lane line", 0, 0, { radius: 0, category: "terrain", obstacle: false }));
  objects.push(obj("lamp post", 0, 3.4, { radius: 0.15, category: "infrastructure" }));
  objects.push(obj("shopping cart", -1.5, 0.7, { radius: 0.3, category: "object" }));   // a stray obstacle IN the lane
  objects.push(obj("pillar", 1.5, -0.6, { radius: 0.35, category: "infrastructure" })); // and another
  // a shopper crossing the lane — the human the harness drives via Ollama
  objects.push(pathWalker("the shopper", 3, 3, [[3, 3], [3, -3], [3, 3]], { radius: 0.25, speed: 0.35, yieldDist: 1.2 }));
  return makeWorld({ objects, regions: [region("parking lot", -6.5, 6.5, -3.5, 3.5)] });
}

export const SCENES = {
  apartment,
  street,
  "parking-lot": parkingLot,
  "obstacle-sparse": () => obstacleField(50, 1),
  "obstacle-medium": () => obstacleField(100, 2),
  "obstacle-dense": () => obstacleField(200, 3),
  studio() { // apartment + street concatenated (a subset of the full backlot; more added later)
    const a = apartment(), s = street();
    return makeWorld({ objects: [...a.objects, ...s.objects], regions: [...a.regions, ...s.regions] });
  },
};
export function makeScene(name = "studio") { return (SCENES[name] || SCENES.studio)(); }
