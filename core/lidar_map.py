"""
LiDAR voxel map -> planar occupancy -> planner grid (the hardware nav source).

On a real Go2 the 4D LiDAR publishes a voxel map on `rt/utlidar/voxel_map`
(+ `_compressed`) and the sensor pose on `rt/utlidar/robot_pose`. This module
turns that into the same `mapping.OccupancyGrid` the planner/Navigator already
consume in sim — so the hardware nav loop is:

    voxel_map (+ pose) --decode--> 3D points --project--> OccupancyGrid
        --blocked_grid--> planner GridView --> Navigator.follow

Two honesty notes:
  * The exact DDS message schema for the voxel map isn't in the BSD-2 community
    references, so `decode_voxel_map` is deliberately tolerant of several common
    shapes (flat positions array, list of point objects, or an occupancy-grid
    style {data,resolution,origin,dims}). Verify the real field names on
    bring-up and adjust the one decoder if needed.
  * Everything here is unit-tested with synthetic points; live behaviour needs a
    robot. The decode/project/grid math does not.
"""

from __future__ import annotations

import math

from sweetie.core.mapping import OccupancyGrid
from sweetie.core.planner import GridView, DEFAULT_ROBOT_R

import logging

logger = logging.getLogger(__name__)

# Optional real decoder. The community WebRTC drivers (go2_webrtc_connect /
# unitree_webrtc_connect) ship a verified LiDAR point-cloud decoder; register it
# here on hardware so we use the real wire format instead of the tolerant
# best-effort fallback. The callable takes the raw message and returns an
# iterable of (x, y, z) points (or point objects with .x/.y/.z).
_DECODER = None


def register_voxel_decoder(fn) -> None:
    """Install a real voxel-map decoder (e.g. from go2_webrtc_connect)."""
    global _DECODER
    _DECODER = fn


def _normalize_points(pts) -> list[tuple[float, float, float]]:
    out = []
    for p in pts:
        try:
            out.append((float(p.x), float(p.y), float(p.z)))
        except AttributeError:
            if len(p) >= 3:
                out.append((float(p[0]), float(p[1]), float(p[2])))
    return out


def decode_voxel_map(msg) -> list[tuple[float, float, float]]:
    """Best-effort decode of a Go2 voxel-map message into (x, y, z) points.

    If a real decoder has been registered (recommended on hardware), use it
    first. Otherwise fall back to tolerant parsing of common shapes. Returns
    map-frame points (metres); unrecognised shapes -> empty list. See note.
    """
    if msg is None:
        return []
    if _DECODER is not None:
        try:
            pts = _DECODER(msg)
            if pts:
                return _normalize_points(pts)
        except Exception:
            logger.exception("registered voxel decoder failed; using fallback")
    # 1) already a sequence of points
    if isinstance(msg, (list, tuple)) and msg and isinstance(msg[0], (list, tuple)):
        return [(float(p[0]), float(p[1]), float(p[2])) for p in msg if len(p) >= 3]
    # 2) flat positions array: [x0,y0,z0, x1,y1,z1, ...]
    pos = getattr(msg, "positions", None)
    if pos is not None and len(pos) >= 3:
        return [(float(pos[i]), float(pos[i + 1]), float(pos[i + 2]))
                for i in range(0, len(pos) - 2, 3)]
    # 3) list of point objects with .x/.y/.z
    pts = getattr(msg, "points", None)
    if pts:
        out = []
        for p in pts:
            try:
                out.append((float(p.x), float(p.y), float(p.z)))
            except AttributeError:
                if len(p) >= 3:
                    out.append((float(p[0]), float(p[1]), float(p[2])))
        return out
    # 4) occupancy-voxel style: dense `data` with resolution + origin + width/depth
    data = getattr(msg, "data", None)
    res = getattr(msg, "resolution", None)
    if data is not None and res is not None:
        ox, oy, oz = (getattr(msg, "origin", None) or (0.0, 0.0, 0.0))[:3]
        w = int(getattr(msg, "width", 0)) or int(round(len(data) ** (1 / 3)))
        d = int(getattr(msg, "depth", w)) or w
        out = []
        for idx, v in enumerate(data):
            if not v:
                continue
            i = idx % w
            j = (idx // w) % d
            k = idx // (w * d)
            out.append((ox + (i + 0.5) * res, oy + (j + 0.5) * res, oz + (k + 0.5) * res))
        return out
    return []


class LidarMapper:
    """Maintains a planar OccupancyGrid from successive LiDAR frames."""

    def __init__(self, *, width_m: float = 20.0, height_m: float = 20.0,
                resolution: float = 0.1, origin_x: float = -10.0, origin_y: float = -10.0,
                z_min: float = 0.05, z_max: float = 1.2,
                bearing_bin_deg: float = 1.0, max_range: float = 12.0) -> None:
        self.grid = OccupancyGrid(width_m, height_m, resolution, origin_x, origin_y)
        self.z_min = z_min          # ignore the floor
        self.z_max = z_max          # ignore the ceiling / overhead
        self.max_range = max_range
        self._bin = math.radians(bearing_bin_deg)

    def integrate(self, robot_x: float, robot_y: float, robot_yaw: float,
                points: list[tuple[float, float, float]]) -> None:
        """Fuse one LiDAR frame (map-frame points) taken at the given pose.

        Points are filtered to a height band (so the floor/ceiling don't read as
        obstacles), reduced to the nearest return per bearing bin (a planar
        scan), then ray-cast into the grid: free along each ray, occupied at the
        hit. Bearing binning makes free-space clearing well-defined."""
        nearest: dict[int, float] = {}
        for (x, y, z) in points:
            if z < self.z_min or z > self.z_max:
                continue
            dx, dy = x - robot_x, y - robot_y
            r = math.hypot(dx, dy)
            if r <= 0.0 or r > self.max_range:
                continue
            ang = math.atan2(dy, dx) - robot_yaw  # robot-frame bearing
            b = int(round(ang / self._bin))
            if b not in nearest or r < nearest[b]:
                nearest[b] = r
        if not nearest:
            return
        beams = [(b * self._bin, r) for b, r in nearest.items()]
        self.grid.integrate_beams(robot_x, robot_y, robot_yaw, beams, self.max_range)

    def grid_view(self, inflate: float = DEFAULT_ROBOT_R,
                unknown_blocked: bool = False) -> GridView:
        """Planner grid. unknown_blocked defaults False so the robot may move
        through not-yet-observed space within the mapped area (only LiDAR-seen
        obstacles block); set True for conservative/known-only navigation."""
        return GridView(
            self.grid.blocked_grid(inflate_radius=inflate, unknown_blocked=unknown_blocked),
            self.grid.res, self.grid.origin_x, self.grid.origin_y,
        )

    def ingest(self, msg, robot_x: float, robot_y: float, robot_yaw: float) -> int:
        """Decode a raw voxel-map message and integrate it. Returns point count."""
        pts = decode_voxel_map(msg)
        self.integrate(robot_x, robot_y, robot_yaw, pts)
        return len(pts)
