"""
Grid path planner — A* + line-of-sight string-pulling.

This is the browser PoC's proven pathing (octile A*, no corner-cutting, blocked
start/goal snapping, then LOS string-pulling) ported to Python so the *same*
navigation runs in sim and on hardware. It is deliberately grid-agnostic: it
plans over a `GridView` (a boolean blocked-grid + resolution + origin), which is
exactly what `core/mapping.OccupancyGrid.blocked_grid()` emits from LiDAR
(P-SLAM) and also what the hand-authored sim map is. Output is world-space
waypoints the Navigator/avoidance follow.

No third-party deps.
"""

from __future__ import annotations

import heapq
import math

DEFAULT_ROBOT_R = 0.22  # m, matches the sim + RealBridge clearance assumptions


class GridView:
    """A boolean blocked-grid (`grid[j][i]`, 1=blocked) with world<->cell maths.

    Decouples the planner from where the grid came from: the SLAM occupancy
    grid, the sim's authored map, or a test fixture all wrap the same way.
    """

    def __init__(self, blocked: list[list[int]], resolution: float,
                origin_x: float = 0.0, origin_y: float = 0.0) -> None:
        self.g = blocked
        self.gh = len(blocked)
        self.gw = len(blocked[0]) if blocked else 0
        self.res = float(resolution)
        self.ox = float(origin_x)
        self.oy = float(origin_y)

    def passable(self, i: int, j: int) -> bool:
        return 0 <= i < self.gw and 0 <= j < self.gh and self.g[j][i] == 0

    def cell_of(self, x: float, y: float) -> tuple[int, int]:
        i = int(math.floor((x - self.ox) / self.res))
        j = int(math.floor((y - self.oy) / self.res))
        i = max(0, min(self.gw - 1, i))
        j = max(0, min(self.gh - 1, j))
        return i, j

    def center(self, i: int, j: int) -> tuple[float, float]:
        return self.ox + (i + 0.5) * self.res, self.oy + (j + 0.5) * self.res

    def nearest_free(self, i: int, j: int) -> tuple[int, int] | None:
        """Spiral outward to the closest traversable cell (snaps a blocked endpoint)."""
        if self.passable(i, j):
            return i, j
        for r in range(1, max(self.gw, self.gh)):
            for dj in range(-r, r + 1):
                for di in range(-r, r + 1):
                    if max(abs(di), abs(dj)) != r:
                        continue
                    if self.passable(i + di, j + dj):
                        return i + di, j + dj
        return None


def a_star(grid: GridView, sx: float, sy: float, gx: float, gy: float
        ) -> list[tuple[float, float]] | None:
    """Octile A* over the grid; returns world-space cell-center waypoints or None.

    No corner-cutting (a diagonal step requires both orthogonal neighbours
    clear), and a blocked start/goal is snapped to the nearest free cell.
    """
    si, sj = grid.cell_of(sx, sy)
    gi, gj = grid.cell_of(gx, gy)
    if not grid.passable(gi, gj):
        snap = grid.nearest_free(gi, gj)
        if snap is None:
            return None
        gi, gj = snap
    if not grid.passable(si, sj):
        snap = grid.nearest_free(si, sj)
        if snap is None:
            return None
        si, sj = snap

    SQ2 = math.sqrt(2.0)

    def h(i: int, j: int) -> float:
        dx, dy = abs(i - gi), abs(j - gj)
        return (dx + dy) + (SQ2 - 2) * min(dx, dy)  # octile

    neighbours = ((1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
                (1, 1, SQ2), (1, -1, SQ2), (-1, 1, SQ2), (-1, -1, SQ2))

    start = (si, sj)
    goal = (gi, gj)
    open_heap: list[tuple[float, tuple[int, int]]] = [(h(si, sj), start)]
    came: dict[tuple[int, int], tuple[int, int]] = {}
    gscore: dict[tuple[int, int], float] = {start: 0.0}
    closed: set[tuple[int, int]] = set()

    while open_heap:
        _, cur = heapq.heappop(open_heap)
        if cur == goal:
            return _rebuild(grid, came, cur)
        if cur in closed:
            continue
        closed.add(cur)
        ci, cj = cur
        cg = gscore[cur]
        for di, dj, cost in neighbours:
            ni, nj = ci + di, cj + dj
            if not grid.passable(ni, nj):
                continue
            if di != 0 and dj != 0:  # no corner cutting
                if not grid.passable(ci + di, cj) or not grid.passable(ci, cj + dj):
                    continue
            nk = (ni, nj)
            tentative = cg + cost
            if tentative < gscore.get(nk, math.inf):
                came[nk] = cur
                gscore[nk] = tentative
                heapq.heappush(open_heap, (tentative + h(ni, nj), nk))
    return None


def _rebuild(grid: GridView, came: dict, k: tuple[int, int]) -> list[tuple[float, float]]:
    cells = [k]
    while k in came:
        k = came[k]
        cells.append(k)
    cells.reverse()
    return [grid.center(i, j) for (i, j) in cells]


def line_of_sight(grid: GridView, ax: float, ay: float, bx: float, by: float) -> bool:
    """True if the straight segment a->b crosses only traversable cells."""
    steps = int(math.ceil(math.hypot(bx - ax, by - ay) / (grid.res * 0.5)))
    for s in range(steps + 1):
        t = (s / steps) if steps else 0.0
        i, j = grid.cell_of(ax + (bx - ax) * t, ay + (by - ay) * t)
        if not grid.passable(i, j):
            return False
    return True


def smooth_path(grid: GridView, pts: list[tuple[float, float]]
            ) -> list[tuple[float, float]]:
    """String-pulling: drop intermediate waypoints the robot can see past."""
    if not pts or len(pts) <= 2:
        return list(pts) if pts else pts
    out = [pts[0]]
    anchor = 0
    for i in range(2, len(pts)):
        if not line_of_sight(grid, pts[anchor][0], pts[anchor][1], pts[i][0], pts[i][1]):
            out.append(pts[i - 1])
            anchor = i - 1
    out.append(pts[-1])
    return out


def plan_path(grid: GridView, start: tuple[float, float], goal: tuple[float, float]
            ) -> list[tuple[float, float]] | None:
    """Public entry: A* then string-pull. Returns world waypoints or None."""
    raw = a_star(grid, start[0], start[1], goal[0], goal[1])
    if raw is None:
        return None
    return smooth_path(grid, raw)


def plan_on_occupancy(occ, start: tuple[float, float], goal: tuple[float, float], *,
                    inflate_radius: float = DEFAULT_ROBOT_R,
                    unknown_blocked: bool = True
                    ) -> list[tuple[float, float]] | None:
    """Plan directly over a mapping.OccupancyGrid (the LiDAR/SLAM map).

    Inflates obstacles by the robot radius so the path keeps clearance — the
    same guarantee the avoidance reflex enforces locally — and (by default)
    refuses to route through never-observed space.
    """
    blocked = occ.blocked_grid(inflate_radius=inflate_radius, unknown_blocked=unknown_blocked)
    grid = GridView(blocked, occ.res, occ.origin_x, occ.origin_y)
    return plan_path(grid, start, goal)
