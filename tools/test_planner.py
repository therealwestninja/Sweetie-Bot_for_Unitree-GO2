"""Tests for core/planner.py. Run directly or under pytest."""

from __future__ import annotations

import math
import sys

from sweetie.core.planner import GridView, a_star, plan_path, line_of_sight, plan_on_occupancy
from sweetie.core.mapping import OccupancyGrid


def _grid(rows: list[str], res=1.0) -> GridView:
    """Build a GridView from ASCII rows ('#'=blocked, '.'=free). Row 0 is j=0."""
    g = [[1 if c == '#' else 0 for c in row] for row in rows]
    return GridView(g, res)


def main():
    R = []
    ok = lambda n, c: R.append((n, bool(c)))

    # open field: straight-ish path, string-pulled to ~2 endpoints
    gv = _grid(["......",
                "......",
                "......"])
    p = plan_path(gv, (0.5, 0.5), (5.5, 0.5))
    ok("open field returns a path", p is not None)
    ok("string-pulling collapses a straight run to 2 pts", p is not None and len(p) == 2)
    ok("path ends at goal cell center", p is not None and abs(p[-1][0] - 5.5) < 1e-6)

    # wall with a gap: must route through the gap (not straight through the wall)
    gw = _grid(["....",
                "##.#",
                "....",
                "...."])
    p2 = plan_path(gw, (0.5, 0.5), (0.5, 3.5))
    ok("walled map still finds a route", p2 is not None)
    # every waypoint segment must be collision-free under LOS
    clean = p2 is not None and all(
        line_of_sight(gw, p2[i][0], p2[i][1], p2[i+1][0], p2[i+1][1]) for i in range(len(p2)-1))
    ok("planned segments are all collision-free", clean)
    # the path must pass through the gap column (x in cell index 2)
    via_gap = p2 is not None and any(gw.cell_of(x, y) == (2, 1) for (x, y) in
        [(p2[i][0] + (p2[i+1][0]-p2[i][0])*t, p2[i][1] + (p2[i+1][1]-p2[i][1])*t)
        for i in range(len(p2)-1) for t in (0.25, 0.5, 0.75)])
    ok("route goes through the wall gap", via_gap)

    # no corner cutting: blocked diagonal pinch can't be crossed corner-to-corner
    pinch = _grid([".#",
                "#."])
    # from (0,0) to (1,1): both orthogonal neighbours of the diagonal are blocked
    pp = a_star(pinch, 0.5, 0.5, 1.5, 1.5)
    ok("no corner-cut through a diagonal pinch (unreachable -> None)", pp is None)

    # blocked goal snaps to nearest free
    gsnap = _grid(["...",
                ".#.",
                "..."])
    ps = plan_path(gsnap, (0.5, 0.5), (1.5, 1.5))  # goal is the blocked center
    ok("blocked goal snaps to a free cell (path returned)", ps is not None)

    # fully walled-off goal -> None
    box = _grid(["#####",
                "#...#",
                "#.#.#",
                "#...#",
                "#####"])
    # surround the target cell (2,2) is '#'; pick an enclosed unreachable: make a sealed pocket
    sealed = _grid(["......",
                    ".####.",
                    ".#..#.",
                    ".#..#.",
                    ".####.",
                    "......"])
    pn = plan_path(sealed, (0.5, 0.5), (2.5, 2.5))  # inside the sealed box
    ok("sealed-off goal returns None", pn is None)

    # integration with the SLAM occupancy grid (P-SLAM -> planner)
    occ = OccupancyGrid(6.0, 6.0, resolution=0.1)
    # observe a room so interior is free and walls occupied
    def room_scan(x, y, room, n=360, mx=12.0):
        from sweetie.core.mapping import Scan
        xmin, ymin, xmax, ymax = room
        inc = 2*math.pi/n
        rs = []
        for i in range(n):
            a = -math.pi + i*inc
            cx, sy = math.cos(a), math.sin(a)
            ts = []
            if abs(cx) > 1e-9:
                for wx in (xmin, xmax):
                    t = (wx-x)/cx
                    if t > 1e-6 and ymin-1e-6 <= y+t*sy <= ymax+1e-6:
                        ts.append(t)
            if abs(sy) > 1e-9:
                for wy in (ymin, ymax):
                    t = (wy-y)/sy
                    if t > 1e-6 and xmin-1e-6 <= x+t*cx <= xmax+1e-6:
                        ts.append(t)
            rs.append(min(min(ts), mx) if ts else mx)
        return Scan(ranges=rs, angle_min=-math.pi, angle_increment=inc, max_range=mx)
    for _ in range(3):
        occ.integrate_scan(3.0, 3.0, 0.0, room_scan(3.0, 3.0, (0.5, 0.5, 5.5, 5.5)))
    route = plan_on_occupancy(occ, (1.5, 1.5), (4.5, 4.5), inflate_radius=0.15)
    ok("plan over the LiDAR-built map succeeds inside the room", route is not None)
    ok("LiDAR-map route stays inside walls", route is not None and all(
        0.5 < x < 5.5 and 0.5 < y < 5.5 for (x, y) in route))

    p_ = sum(1 for _, c in R if c)
    f_ = sum(1 for _, c in R if not c)
    for n, c in R:
        print(("  [PASS] " if c else "  [FAIL] ") + n)
    print(f"{p_} passed, {f_} failed")
    return 1 if f_ else 0


if __name__ == "__main__":
    sys.exit(main())
