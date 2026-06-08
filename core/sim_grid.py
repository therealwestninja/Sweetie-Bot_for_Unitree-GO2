"""
Rasterize the simulator's `World` into a planner `GridView`.

This is what lets the back-ported A* planner / Navigator route around the sim's
actual obstacles, the same way `mapping.OccupancyGrid.blocked_grid()` feeds the
planner from LiDAR on hardware. Sim and hardware therefore share one planner over
one grid abstraction — the only difference is where the grid comes from.
"""

from __future__ import annotations

import math

from sweetie.core.planner import GridView, DEFAULT_ROBOT_R


def grid_from_world(world, *, res: float = 0.1, margin: float = 1.0,
                    inflate: float = DEFAULT_ROBOT_R) -> GridView:
    """A blocked-grid covering the world's obstacles (+margin), inflated by the
    robot radius so planned paths keep clearance. Passable terrain is ignored."""
    obstacles = [o for o in world.objects if getattr(o, "obstacle", True)]
    xs = [o.x for o in world.objects] or [0.0]
    ys = [o.y for o in world.objects] or [0.0]
    radii = [getattr(o, "radius", 0.0) for o in world.objects] or [0.0]
    pad = max(radii) + inflate + margin
    minx, maxx = min(xs) - pad, max(xs) + pad
    miny, maxy = min(ys) - pad, max(ys) + pad
    gw = max(1, int(math.ceil((maxx - minx) / res)))
    gh = max(1, int(math.ceil((maxy - miny) / res)))
    grid = [[0] * gw for _ in range(gh)]
    for o in obstacles:
        rr = getattr(o, "radius", 0.0) + inflate
        # cells whose center lies within (radius+inflate) of the obstacle
        i0 = max(0, int((o.x - rr - minx) / res))
        i1 = min(gw - 1, int((o.x + rr - minx) / res))
        j0 = max(0, int((o.y - rr - miny) / res))
        j1 = min(gh - 1, int((o.y + rr - miny) / res))
        for j in range(j0, j1 + 1):
            cy = miny + (j + 0.5) * res
            for i in range(i0, i1 + 1):
                cx = minx + (i + 0.5) * res
                if math.hypot(cx - o.x, cy - o.y) <= rr:
                    grid[j][i] = 1
    return GridView(grid, res, minx, miny)
