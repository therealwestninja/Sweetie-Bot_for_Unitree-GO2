"""
Occupancy-grid mapping (P-SLAM).

The PoC drives A* over a hand-authored grid. On real hardware the map isn't
drawn — it's *built* from the Go2's L1 LiDAR, exactly as the Unitree app does
(its embedded web sim ships a SLAM worker + voxel WASM + point cloud; see
docs/unitree-app-mining.md). This module is that builder: it turns a stream of
planar LiDAR scans into an occupancy grid, then emits the same boolean
blocked-grid the planner already consumes — so A*, string-pulling, and the
avoidance reflex ride on top unchanged. Swapping the static map for this is the
last thing standing between `RealBridge.go_to_pose` refusing and working.

Model: a standard log-odds occupancy grid with an inverse sensor model. Each
beam is ray-cast across the grid; cells the beam passes through get evidence
*free*, the cell it terminates on (a real return, not a max-range miss) gets
evidence *occupied*. Repeated scans accumulate, so transient/noisy returns wash
out and real structure firms up. Thresholding the log-odds gives occupied /
free / unknown; the costmap inflates occupied cells by the robot radius so the
planner keeps clearance (same guarantee the avoidance reflex enforces locally).

Pure Python, no deps. The 3D-cloud -> planar-scan projection (take the min
range per azimuth in a height band around the body) lives upstream in
perception; this module consumes the planar scan.
"""

from __future__ import annotations
from sweetie.core.mathutil import clamp

import math
from dataclasses import dataclass

# Inverse-sensor-model log-odds increments and clamps. l_occ/l_free are the
# evidence a single beam contributes; l_min/l_max bound accumulation so a cell
# can always be revised when the world changes (a door opens, a chair moves).
L_OCC = 0.85
L_FREE = -0.40
L_MIN = -4.0
L_MAX = 4.0
# Decision thresholds on log-odds: above OCC -> occupied, below FREE -> free,
# in-between (incl. never-observed 0.0) -> unknown.
OCC_THRESHOLD = 0.5
FREE_THRESHOLD = -0.5


@dataclass
class Scan:
    """A planar LiDAR scan in the robot frame.

    ranges: metres per beam (a beam at/над max_range is treated as "no return").
    angle_min / angle_increment: beam angles in the robot frame (rad), beam i
    at angle_min + i*angle_increment, measured CCW from the robot's +x (heading).
    """
    ranges: list[float]
    angle_min: float
    angle_increment: float
    max_range: float = 12.0


class OccupancyGrid:
    def __init__(
        self,
        width_m: float,
        height_m: float,
        resolution: float = 0.1,
        origin_x: float = 0.0,
        origin_y: float = 0.0,
    ) -> None:
        self.res = float(resolution)
        self.origin_x = float(origin_x)
        self.origin_y = float(origin_y)
        self.gw = max(1, int(math.ceil(width_m / self.res)))
        self.gh = max(1, int(math.ceil(height_m / self.res)))
        # log-odds, row-major [gh][gw], 0.0 == unknown
        self._lo = [[0.0] * self.gw for _ in range(self.gh)]

    # ── coordinate transforms ───────────────────────────────────────────────

    def world_to_cell(self, x: float, y: float) -> tuple[int, int]:
        cx = int(math.floor((x - self.origin_x) / self.res))
        cy = int(math.floor((y - self.origin_y) / self.res))
        return cx, cy

    def cell_to_world(self, cx: int, cy: int) -> tuple[float, float]:
        x = self.origin_x + (cx + 0.5) * self.res
        y = self.origin_y + (cy + 0.5) * self.res
        return x, y

    def in_bounds(self, cx: int, cy: int) -> bool:
        return 0 <= cx < self.gw and 0 <= cy < self.gh

    # ── evidence accumulation ────────────────────────────────────────────────

    def _bump(self, cx: int, cy: int, delta: float) -> None:
        if not self.in_bounds(cx, cy):
            return
        v = self._lo[cy][cx] + delta
        self._lo[cy][cx] = clamp(v, L_MIN, L_MAX)

    def integrate_scan(self, x: float, y: float, yaw: float, scan: Scan) -> None:
        """Fuse one planar scan taken at robot pose (x, y, yaw)."""
        rcx, rcy = self.world_to_cell(x, y)
        for i, r in enumerate(scan.ranges):
            ang = yaw + scan.angle_min + i * scan.angle_increment
            hit = r < scan.max_range and r > 0.0 and not math.isinf(r) and not math.isnan(r)
            reach = r if hit else scan.max_range
            ex = x + reach * math.cos(ang)
            ey = y + reach * math.sin(ang)
            ecx, ecy = self.world_to_cell(ex, ey)
            cells = _bresenham(rcx, rcy, ecx, ecy)
            # All but the last cell are free space the beam travelled through.
            for (cx, cy) in cells[:-1]:
                self._bump(cx, cy, L_FREE)
            if cells:
                last = cells[-1]
                if hit:
                    self._bump(last[0], last[1], L_OCC)
                else:
                    self._bump(last[0], last[1], L_FREE)

    def integrate_beams(self, x: float, y: float, yaw: float,
                        beams: list[tuple[float, float]], max_range: float = 12.0) -> None:
        """Convenience: fuse explicit (angle_rad_in_robot_frame, range_m) beams."""
        for (ang, r) in beams:
            hit = 0.0 < r < max_range
            reach = r if hit else max_range
            wa = yaw + ang
            ecx, ecy = self.world_to_cell(x + reach * math.cos(wa), y + reach * math.sin(wa))
            rcx, rcy = self.world_to_cell(x, y)
            cells = _bresenham(rcx, rcy, ecx, ecy)
            for (cx, cy) in cells[:-1]:
                self._bump(cx, cy, L_FREE)
            if cells:
                self._bump(cells[-1][0], cells[-1][1], L_OCC if hit else L_FREE)

    # ── readout ───────────────────────────────────────────────────────────────

    def log_odds(self, cx: int, cy: int) -> float:
        return self._lo[cy][cx] if self.in_bounds(cx, cy) else 0.0

    def probability(self, cx: int, cy: int) -> float:
        lo = self.log_odds(cx, cy)
        return 1.0 - 1.0 / (1.0 + math.exp(lo))

    def state(self, cx: int, cy: int) -> str:
        """'occupied' | 'free' | 'unknown' for a cell."""
        lo = self.log_odds(cx, cy)
        if lo >= OCC_THRESHOLD:
            return "occupied"
        if lo <= FREE_THRESHOLD:
            return "free"
        return "unknown"

    def blocked_grid(self, inflate_radius: float = 0.0,
                    unknown_blocked: bool = True) -> list[list[int]]:
        """Emit the boolean blocked-grid the A* planner consumes.

        1 = blocked, 0 = traversable. Occupied cells are blocked and dilated by
        `inflate_radius` (m) so the planner keeps the robot's body clear — the
        same clearance guarantee the local avoidance reflex enforces. With
        `unknown_blocked` (default), never-observed cells are blocked too, so
        the planner won't route confidently through space the LiDAR hasn't seen
        (set False to allow optimistic traversal of unknown space, e.g. for
        frontier exploration).
        """
        grid = [[0] * self.gw for _ in range(self.gh)]
        occ = []
        for cy in range(self.gh):
            for cx in range(self.gw):
                s = self.state(cx, cy)
                if s == "occupied":
                    grid[cy][cx] = 1
                    occ.append((cx, cy))
                elif s == "unknown" and unknown_blocked:
                    grid[cy][cx] = 1
        if inflate_radius > 0.0 and occ:
            rad = int(math.ceil(inflate_radius / self.res))
            for (ox, oy) in occ:
                for dy in range(-rad, rad + 1):
                    for dx in range(-rad, rad + 1):
                        if dx * dx + dy * dy > rad * rad:
                            continue
                        nx, ny = ox + dx, oy + dy
                        if self.in_bounds(nx, ny):
                            grid[ny][nx] = 1
        return grid

    def stats(self) -> dict:
        occ = free = unk = 0
        for cy in range(self.gh):
            for cx in range(self.gw):
                s = self.state(cx, cy)
                occ += s == "occupied"
                free += s == "free"
                unk += s == "unknown"
        return {"occupied": occ, "free": free, "unknown": unk,
                "cells": self.gw * self.gh, "gw": self.gw, "gh": self.gh}


def _bresenham(x0: int, y0: int, x1: int, y1: int) -> list[tuple[int, int]]:
    """Integer line from (x0,y0) to (x1,y1) inclusive (Bresenham)."""
    cells = []
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    x, y = x0, y0
    while True:
        cells.append((x, y))
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy
    return cells
