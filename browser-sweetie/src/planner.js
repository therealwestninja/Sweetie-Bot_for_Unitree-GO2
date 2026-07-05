// A* global path planner — the other half of "pathing". Reactive steering (steering.js) is great at smooth
// local avoidance and dodging things that MOVE, but it local-minimums in dense clutter (a room full of
// furniture): seek and separation cancel and she orbits. A* solves the global route over the STATIC obstacles;
// the steering then executes each short leg (and still dodges dynamic entities between waypoints). Standard
// hybrid: global plan + local reactive. Grid A*, 8-connected octile, no corner-cutting, then a line-of-sight
// string-pull so we hand the follower a few waypoints instead of a jagged cell path.

function autoBounds(start, goal, obstacles, pad, walls = []) {
  let minX = Math.min(start.x, goal.x), maxX = Math.max(start.x, goal.x), minY = Math.min(start.y, goal.y), maxY = Math.max(start.y, goal.y);
  for (const o of obstacles) { minX = Math.min(minX, o.x - o.radius); maxX = Math.max(maxX, o.x + o.radius); minY = Math.min(minY, o.y - o.radius); maxY = Math.max(maxY, o.y + o.radius); }
  for (const w of walls) { minX = Math.min(minX, w.x - w.w / 2); maxX = Math.max(maxX, w.x + w.w / 2); minY = Math.min(minY, w.y - w.h / 2); maxY = Math.max(maxY, w.y + w.h / 2); }
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

const inRect = (wx, wy, r, pad = 0) => Math.abs(wx - r.x) <= r.w / 2 + pad && Math.abs(wy - r.y) <= r.h / 2 + pad;

// Plan a path from start→goal avoiding the obstacle disks AND rectangular WALLS (buildings, the road). Returns an
// array of world waypoints (ending at/near goal), or null if unreachable. `clearance` inflates every obstacle
// disk (≈ robot radius + margin). `walls` are blocked rects {x,y,w,h}; `openings` are rects that carve free gaps
// back out of the walls (doorways, the crosswalk) — that's what makes bots route through doors + use the crosswalk.
export function planPath(start, goal, obstacles = [], { bounds, cell = 0.25, clearance = 0.45, pad = 1.0, walls = [], openings = [], wallClear = 0.3 } = {}) {
  const b = bounds || autoBounds(start, goal, obstacles, pad, walls);
  const nx = Math.max(1, Math.ceil((b.maxX - b.minX) / cell)) + 1;
  const ny = Math.max(1, Math.ceil((b.maxY - b.minY) / cell)) + 1;
  const worldOf = (cx, cy) => [b.minX + cx * cell, b.minY + cy * cell];
  const cellOf = (x, y) => [Math.round((x - b.minX) / cell), Math.round((y - b.minY) / cell)];
  const inGrid = (cx, cy) => cx >= 0 && cy >= 0 && cx < nx && cy < ny;

  const blockCache = new Map();
  const blocked = (cx, cy) => {
    if (!inGrid(cx, cy)) return true;
    const k = cx * ny + cy; const hit = blockCache.get(k); if (hit !== undefined) return hit;
    const [wx, wy] = worldOf(cx, cy);
    let bl = false; for (const o of obstacles) { if (Math.hypot(wx - o.x, wy - o.y) < o.radius + clearance) { bl = true; break; } }
    if (!bl && walls.length) { // inside a wall (inflated by the bot's clearance) and NOT inside a doorway/crosswalk opening
      let inWall = false; for (const w of walls) if (inRect(wx, wy, w, wallClear)) { inWall = true; break; }
      if (inWall) { let open = false; for (const o of openings) if (inRect(wx, wy, o, wallClear)) { open = true; break; } bl = !open; }
    }
    blockCache.set(k, bl); return bl;
  };
  // nudge a blocked endpoint to the nearest free cell (start may sit inside clearance; goal may be tight)
  const nearestFree = (cx, cy, maxR = 18) => {
    if (!blocked(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxR; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      if (!blocked(cx + dx, cy + dy)) return [cx + dx, cy + dy];
    }
    return null;
  };

  const s = nearestFree(...cellOf(start.x, start.y)), g = nearestFree(...cellOf(goal.x, goal.y));
  if (!s || !g) return null;
  const key = (cx, cy) => cx * ny + cy;
  const SQRT2 = Math.SQRT2;
  const h = (cx, cy) => { const dx = Math.abs(cx - g[0]), dy = Math.abs(cy - g[1]); return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy); }; // octile
  const gScore = new Map(), came = new Map(), open = [];
  const push = (cx, cy, f) => { open.push([f, cx, cy]); };
  gScore.set(key(s[0], s[1]), 0); push(s[0], s[1], h(s[0], s[1]));

  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];
  let found = null, guard = 0;
  while (open.length && guard++ < nx * ny * 9) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i; // small grids → linear min is fine
    const [, cx, cy] = open.splice(bi, 1)[0];
    if (cx === g[0] && cy === g[1]) { found = [cx, cy]; break; }
    const cg = gScore.get(key(cx, cy));
    for (const [dx, dy, cost] of NB) {
      const nxc = cx + dx, nyc = cy + dy;
      if (blocked(nxc, nyc)) continue;
      if (dx !== 0 && dy !== 0 && (blocked(cx + dx, cy) || blocked(cx, cy + dy))) continue; // no corner cutting
      const ng = cg + cost, nk = key(nxc, nyc);
      if (ng < (gScore.get(nk) ?? Infinity)) { gScore.set(nk, ng); came.set(nk, key(cx, cy)); push(nxc, nyc, ng + h(nxc, nyc)); }
    }
  }
  if (!found) return null;

  // reconstruct cell path
  const cellsRev = []; let ck = key(found[0], found[1]);
  while (ck !== undefined) { const cx = Math.floor(ck / ny), cy = ck % ny; cellsRev.push([cx, cy]); ck = came.get(ck); if (cx === s[0] && cy === s[1]) break; }
  const cells = cellsRev.reverse();

  // line-of-sight string-pull → few waypoints
  const los = (a, c) => { const steps = Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1])); for (let i = 1; i < steps; i++) { const t = i / steps; if (blocked(Math.round(a[0] + (c[0] - a[0]) * t), Math.round(a[1] + (c[1] - a[1]) * t))) return false; } return true; };
  const wp = [cells[0]]; let anchor = 0;
  for (let i = 2; i < cells.length; i++) { if (!los(cells[anchor], cells[i])) { wp.push(cells[i - 1]); anchor = i - 1; } }
  wp.push(cells[cells.length - 1]);

  const out = wp.slice(1).map(([cx, cy]) => { const [wx, wy] = worldOf(cx, cy); return { x: +wx.toFixed(3), y: +wy.toFixed(3) }; });
  out[out.length - 1] = { x: goal.x, y: goal.y }; // snap the last waypoint to the true goal
  return out;
}
