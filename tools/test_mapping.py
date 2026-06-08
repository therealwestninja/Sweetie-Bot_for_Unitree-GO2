"""
Tests for core/mapping.py — the LiDAR occupancy-grid mapper (P-SLAM).
Run directly (`python tools/test_mapping.py`) or under pytest.
"""

from __future__ import annotations

import math
import sys

from sweetie.core.mapping import OccupancyGrid, Scan, _bresenham


def _ok(name, cond, results):
    results.append((name, bool(cond)))


def synth_room_scan(x, y, yaw, room, n=360, max_range=12.0):
    """Cast n beams from (x,y) inside an axis-aligned room and return a Scan.

    room = (xmin, ymin, xmax, ymax). Each beam's range = distance to the first
    wall it hits (analytic ray-box intersection from an interior point).
    """
    xmin, ymin, xmax, ymax = room
    inc = 2 * math.pi / n
    ranges = []
    for i in range(n):
        ang = yaw + (-math.pi) + i * inc
        cx, sy = math.cos(ang), math.sin(ang)
        ts = []
        if abs(cx) > 1e-9:
            for wx in (xmin, xmax):
                t = (wx - x) / cx
                if t > 1e-6:
                    iy = y + t * sy
                    if ymin - 1e-6 <= iy <= ymax + 1e-6:
                        ts.append(t)
        if abs(sy) > 1e-9:
            for wy in (ymin, ymax):
                t = (wy - y) / sy
                if t > 1e-6:
                    ix = x + t * cx
                    if xmin - 1e-6 <= ix <= xmax + 1e-6:
                        ts.append(t)
        r = min(ts) if ts else max_range
        ranges.append(min(r, max_range))
    return Scan(ranges=ranges, angle_min=-math.pi, angle_increment=inc, max_range=max_range)


def main():
    R = []

    # 1. coordinate transforms round-trip
    g = OccupancyGrid(12.0, 9.0, resolution=0.1)
    cx, cy = g.world_to_cell(3.34, 5.07)
    wx, wy = g.cell_to_world(cx, cy)
    _ok("world<->cell round-trips within half a cell",
        abs(wx - 3.34) <= 0.05 + 1e-9 and abs(wy - 5.07) <= 0.05 + 1e-9, R)
    _ok("grid dims sized from metres/res", g.gw == 120 and g.gh == 90, R)

    # 2. single beam: cells before the hit go free, the hit cell goes occupied
    g2 = OccupancyGrid(6.0, 6.0, resolution=0.1, origin_x=0, origin_y=0)
    # robot at (1,3) facing +x, one beam straight ahead hitting a wall at x=4
    g2.integrate_beams(1.0, 3.0, 0.0, [(0.0, 3.0)], max_range=12.0)
    hit = g2.world_to_cell(4.0, 3.0)
    mid = g2.world_to_cell(2.5, 3.0)
    _ok("beam endpoint marked occupied", g2.log_odds(*hit) > 0, R)
    _ok("cells along the beam marked free", g2.log_odds(*mid) < 0, R)

    # 3. max-range beam (no return) clears space, marks nothing occupied
    g3 = OccupancyGrid(6.0, 6.0, resolution=0.1)
    g3.integrate_beams(1.0, 3.0, 0.0, [(0.0, 12.0)], max_range=12.0)
    far = g3.world_to_cell(3.0, 3.0)
    _ok("no-return beam leaves no occupied cell along it", g3.log_odds(*far) <= 0, R)

    # 4. full 360 scan in a room -> walls occupied, interior free (after a few scans)
    room = (0.5, 0.5, 5.5, 5.5)
    g4 = OccupancyGrid(6.0, 6.0, resolution=0.1)
    rob = (3.0, 3.0, 0.0)
    for _ in range(3):  # accumulate to clear the occ threshold
        g4.integrate_scan(rob[0], rob[1], rob[2], synth_room_scan(*rob, room))
    interior = g4.state(*g4.world_to_cell(3.0, 3.0))
    wall_e = g4.state(*g4.world_to_cell(5.5, 3.0))
    wall_n = g4.state(*g4.world_to_cell(3.0, 5.5))
    _ok("room interior reads free", interior == "free", R)
    _ok("east wall reads occupied", wall_e == "occupied", R)
    _ok("north wall reads occupied", wall_n == "occupied", R)
    st = g4.stats()
    _ok("most cells are now classified (not all unknown)", st["unknown"] < st["cells"] * 0.7, R)

    # 5. blocked_grid: occupied cells block, and inflation dilates them
    bg = g4.blocked_grid(inflate_radius=0.0, unknown_blocked=False)
    wx_e, wy_e = g4.world_to_cell(5.5, 3.0)
    _ok("blocked_grid blocks the wall cell", bg[wy_e][wx_e] == 1, R)
    just_inside = g4.world_to_cell(5.2, 3.0)  # ~0.3m inside the east wall
    _ok("cell 0.3m inside wall is clear without inflation",
        bg[just_inside[1]][just_inside[0]] == 0, R)
    bg_inf = g4.blocked_grid(inflate_radius=0.35, unknown_blocked=False)
    _ok("inflation by 0.35m blocks the cell ~0.3m from the wall",
        bg_inf[just_inside[1]][just_inside[0]] == 1, R)

    # 6. unknown handling: a never-observed grid is all-unknown -> blocked when conservative
    g6 = OccupancyGrid(2.0, 2.0, resolution=0.5)
    bgu = g6.blocked_grid(unknown_blocked=True)
    bgf = g6.blocked_grid(unknown_blocked=False)
    _ok("unobserved space is blocked when unknown_blocked=True",
        all(all(c == 1 for c in row) for row in bgu), R)
    _ok("unobserved space is open when unknown_blocked=False",
        all(all(c == 0 for c in row) for row in bgf), R)

    # 7. blocked_grid shape matches grid dims (feeds A* as grid[y][x])
    _ok("blocked_grid shape is [gh][gw]", len(bg) == g4.gh and len(bg[0]) == g4.gw, R)

    # 8. bresenham basic sanity
    line = _bresenham(0, 0, 3, 1)
    _ok("bresenham endpoints correct", line[0] == (0, 0) and line[-1] == (3, 1), R)
    _ok("bresenham is contiguous", all(
        max(abs(line[i+1][0]-line[i][0]), abs(line[i+1][1]-line[i][1])) == 1
        for i in range(len(line)-1)), R)

    # 9. dynamic revision: a wall that opens (becomes free) flips back
    g9 = OccupancyGrid(6.0, 6.0, resolution=0.1)
    for _ in range(3):
        g9.integrate_beams(1.0, 3.0, 0.0, [(0.0, 3.0)], max_range=12.0)  # wall at x=4
    was_occ = g9.state(*g9.world_to_cell(4.0, 3.0)) == "occupied"
    for _ in range(8):
        g9.integrate_beams(1.0, 3.0, 0.0, [(0.0, 12.0)], max_range=12.0)  # door opens
    now_free = g9.state(*g9.world_to_cell(4.0, 3.0)) != "occupied"
    _ok("a cleared obstacle is revised away (log-odds bounded)", was_occ and now_free, R)

    p = sum(1 for _, c in R if c)
    f = sum(1 for _, c in R if not c)
    for name, c in R:
        print(("  [PASS] " if c else "  [FAIL] ") + name)
    print(f"{p} passed, {f} failed")
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
