"""
SimPerception — ground-truth perception over the simulator's World.

The hardware-neutral base (`PerceptionBase`) lives in `sweetie.core.perception`
so real-hardware code needn't import the simulator. This module provides the
sim implementation plus the vision parameters the camera model uses.
"""

from __future__ import annotations

from sweetie.core.perception import PerceptionBase

# Vision parameters. Roughly modelled on the Go2's front-facing camera
# (~70° horizontal FOV). Real implementations may override these.
VISION_FOV_DEG = 70.0
VISION_RANGE = 8.0


# ─────────────────────────────────────────────────────────────────────────────
# SimPerception — ground-truth perception over the simulator's World.
#
# Restored/implemented during the back-port pass (the uploaded snapshot was
# missing this class, which broke `core.bridge` import and the whole sim).
# It "cheats" by reading World object positions directly instead of inferring
# from the proximity field, but it models the same two things the real layer
# must: a forward CAMERA (FOV cone + range + occlusion) for *recognition*, and
# coarse 4-quadrant *proximity* awareness for dynamic entities. Events it emits
# (entered/left range, quadrant changes, entered/left view) flow to the bus so
# ambient cognition can comment. Design mirrors the proven PoC perception.
# ─────────────────────────────────────────────────────────────────────────────

import math as _math
import time as _time
from collections import deque as _deque

VISION_HALF_FOV_RAD = _math.radians(VISION_FOV_DEG / 2.0)
# Static objects smaller than this don't clutter vision (fence posts etc.);
# dynamic entities are always reported regardless of size.
MIN_STATIC_VISION_RADIUS = 0.1


from sweetie.core.mathutil import wrap_angle as _wrap


class SimPerception(PerceptionBase):
    """Perception over a known World. See module note above."""

    PERCEPTION_RANGE = 6.0  # quadrant/proximity awareness range (m)

    def __init__(self, world) -> None:
        self.world = world
        self._event_log: _deque[tuple[float, str]] = _deque(maxlen=256)
        self._new_events: list[str] = []
        self._quad: dict[str, str] = {}      # name -> last quadrant (dynamic only)
        self._inview: dict[str, bool] = {}   # name -> last vision state

    # ── proximity / quadrant ────────────────────────────────────────────────

    def _classify_quadrant(self, rx, ry, ryaw, tx, ty) -> str:
        dist = _math.hypot(tx - rx, ty - ry)
        if dist > self.PERCEPTION_RANGE:
            return "far"
        b = _wrap(_math.atan2(ty - ry, tx - rx) - ryaw)
        ab = abs(b)
        if ab <= _math.pi / 4:
            return "front"
        if ab >= 3 * _math.pi / 4:
            return "back"
        return "left" if b > 0 else "right"

    # ── vision (camera FOV + occlusion) ──────────────────────────────────────

    def _is_visible(self, obj, rx, ry, ryaw) -> bool:
        dx, dy = obj.x - rx, obj.y - ry
        dist = _math.hypot(dx, dy)
        if dist < 1e-6 or dist > VISION_RANGE:
            return False
        if abs(_wrap(_math.atan2(dy, dx) - ryaw)) > VISION_HALF_FOV_RAD:
            return False
        if not obj.dynamic and obj.radius < MIN_STATIC_VISION_RADIUS:
            return False
        # occlusion: a closer SOLID object whose disk straddles the sightline
        for o in self.world.objects:
            if o is obj or not getattr(o, "obstacle", True):
                continue
            od = _math.hypot(o.x - rx, o.y - ry)
            if od >= dist:
                continue  # not between us and the target
            t = ((o.x - rx) * dx + (o.y - ry) * dy) / (dist * dist)
            if t <= 0 or t >= 1:
                continue
            px, py = rx + t * dx, ry + t * dy
            if _math.hypot(o.x - px, o.y - py) < o.radius:
                return False
        return True

    def vision_summary(self, robot_x, robot_y, robot_yaw) -> list[dict]:
        out = []
        for obj in self.world.objects:
            if not self._is_visible(obj, robot_x, robot_y, robot_yaw):
                continue
            dx, dy = obj.x - robot_x, obj.y - robot_y
            out.append({
                "name": obj.name,
                "distance_m": round(_math.hypot(dx, dy), 2),
                "bearing_deg": round(_math.degrees(_wrap(_math.atan2(dy, dx) - robot_yaw)), 1),
                "category": getattr(obj, "category", "object"),
                "dynamic": bool(obj.dynamic),
            })
        out.sort(key=lambda e: e["distance_m"])
        return out

    # ── tick / events ─────────────────────────────────────────────────────────

    def _emit(self, ev: str) -> None:
        self._event_log.append((_time.time(), ev))
        self._new_events.append(ev)

    def tick(self, robot_x, robot_y, robot_yaw, range_obstacle=None) -> None:
        for obj in self.world.objects:
            name = obj.name
            # Quadrant transitions — dynamic entities only (a moving thing
            # crossing the robot's awareness is the interesting signal).
            if obj.dynamic:
                q = self._classify_quadrant(robot_x, robot_y, robot_yaw, obj.x, obj.y)
                prev = self._quad.get(name)
                if prev is None:
                    if q != "far":
                        self._emit(f"{name} in {q}")
                elif prev == "far" and q != "far":
                    self._emit(f"{name} entered range ({q})")
                elif prev != "far" and q == "far":
                    self._emit(f"{name} left visible range")
                elif prev != q and q != "far":
                    self._emit(f"{name} now in {q}")
                self._quad[name] = q

            # Vision entry/exit — any object (static or dynamic) that the
            # camera can actually see (FOV + range + not occluded).
            vis = self._is_visible(obj, robot_x, robot_y, robot_yaw)
            if vis and not self._inview.get(name, False):
                self._emit(f"{name} entered view")
            elif not vis and self._inview.get(name, False):
                self._emit(f"{name} left view")
            self._inview[name] = vis

    def recent_events(self, window_s: float = 30.0) -> list[dict]:
        now = _time.time()
        cutoff = now - window_s
        return [
            {"event": ev, "age_s": round(now - t, 1)}
            for (t, ev) in self._event_log
            if t >= cutoff
        ]

    def drain_new_events(self) -> list[str]:
        out = self._new_events
        self._new_events = []
        return out
