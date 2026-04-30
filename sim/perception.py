"""
Simulator perception.

In real hardware, perception is a vision/lidar pipeline: cameras and lidar
feed into detectors, trackers, and a stream of named entities with
positions and velocities. The cognition layer (LLM) consumes a *summary*
of that stream — recent events, what's nearby, motion classification.

This file is the simulator's stand-in for that pipeline. It cheats by
reading positions directly out of the World (we have ground truth), but
exposes the same interface a real perception layer would: `tick()`
(advance / observe) and `recent_events()` (what just happened).

The architectural seam is in `PerceptionBase`. A future RealPerception
in `sweetie/perception/real.py` would implement the same surface from
camera output and slot into `RealBridge` exactly the way `SimPerception`
slots into `SimBridge`.

What lives where:
- This file:        sim-only ground-truth-cheating perception
- bridge.py:        owns *its* perception instance, calls tick() each frame
- cognition/llm.py: queries `bridge.recent_perceptions()` (delegates here)
"""

from __future__ import annotations

import math
import time
from collections import deque

from sweetie.sim.world import World


class PerceptionBase:
    """
    The interface a perception layer exposes.

    Sim and real implementations share this surface so the rest of the
    codebase doesn't care which one is running.
    """

    def tick(self, robot_x: float, robot_y: float, robot_yaw: float) -> None:
        """Advance one frame of perception given the current robot pose."""
        raise NotImplementedError

    def recent_events(self, window_s: float = 30.0) -> list[dict]:
        """Return events in the last `window_s` seconds, newest last."""
        raise NotImplementedError

    def vision_summary(
        self, robot_x: float, robot_y: float, robot_yaw: float,
    ) -> list[dict]:
        """Return entities currently visible (in-FOV, not occluded)."""
        raise NotImplementedError


# Vision parameters. Roughly modelled on the Go2's Intel RealSense
# front-facing camera (~70° horizontal FOV at the wide end). Range is
# more arbitrary — most relevant entities are well inside 8 m.
VISION_FOV_DEG = 70.0
VISION_RANGE = 8.0


def _ray_blocked(
    rx: float, ry: float, ex: float, ey: float,
    obstacles: list,
) -> str | None:
    """
    Check if the line segment from (rx, ry) to (ex, ey) is blocked by
    any of the given obstacles (each must have .x, .y, .radius). Returns
    the name of the first blocking obstacle, or None.

    A circular obstacle blocks the ray if the closest point on the ray
    to its center is within the obstacle's radius AND that closest point
    lies between the endpoints (not before the start, not past the end).
    """
    dx = ex - rx
    dy = ey - ry
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-9:
        return None
    for obs in obstacles:
        # Project obstacle center onto the ray, parametrized t∈[0,1].
        ox = obs.x - rx
        oy = obs.y - ry
        t = (ox * dx + oy * dy) / seg_len_sq
        if t <= 0.0 or t >= 1.0:
            continue  # closest point is outside the segment
        # Distance from obstacle center to the closest point on the ray
        cx = rx + t * dx
        cy = ry + t * dy
        gap = math.hypot(obs.x - cx, obs.y - cy)
        if gap < obs.radius:
            return obs.name
    return None


class SimPerception(PerceptionBase):
    """
    Ground-truth perception over a `World`.

    Tracks per-entity quadrant relative to the robot. Logs meaningful
    transitions (entered/left visible range, stepped into the front
    quadrant). Static objects are ignored — their position never changes.

    The "interesting" filter is intentionally narrow: we only emit on
    range entry/exit and on transitions into the front quadrant. Other
    transitions (back→left, left→right, etc.) are noise — most of the
    time, an entity's quadrant churns as it walks past, and we don't
    want to spam the log.
    """

    # Range beyond which an entity is considered out of perceptual range.
    # Slightly bigger than the bridge's PROXIMITY_MAX_RANGE to avoid
    # flapping at the boundary.
    PERCEPTION_RANGE = 4.0

    EVENT_LOG_MAX = 20

    def __init__(self, world: World) -> None:
        self._world = world
        self._entity_quadrant: dict[str, str] = {}
        self._event_log: deque[tuple[float, str]] = deque(maxlen=self.EVENT_LOG_MAX)
        # Buffer of events generated since the last drain. The bridge polls
        # this each tick and broadcasts to the bus, so ambient cognition
        # can react in real time.
        self._new_events: list[str] = []
        # Per-entity vision state: True if currently in FOV and not occluded.
        # Tracking lets us emit transitions ("X entered view", "X is now hidden").
        self._entity_visible: dict[str, bool] = {}

    # ── PerceptionBase ─────────────────────────────────────────────────────

    def tick(self, robot_x: float, robot_y: float, robot_yaw: float) -> None:
        if self._world is None:
            return
        now = time.time()
        # Quadrant tracking — covers the full 360° (this is the proximity
        # sensor model: front/left/back/right). Every object, dynamic or not,
        # could in principle generate a quadrant transition, but we only
        # care about the moving ones since static positions don't change
        # relative to the robot until the *robot* moves.
        for obj in self._world.objects:
            if not obj.dynamic:
                continue
            new_q = self._classify_quadrant(robot_x, robot_y, robot_yaw, obj.x, obj.y)
            old_q = self._entity_quadrant.get(obj.name)
            if new_q != old_q:
                self._entity_quadrant[obj.name] = new_q
                event = self._describe_transition(obj.name, old_q, new_q)
                if event is not None:
                    self._event_log.append((now, event))
                    self._new_events.append(event)

        # Vision tracking — covers the forward camera FOV and applies
        # occlusion. Both static and dynamic entities can transition
        # (the robot walking around static furniture changes what's
        # in view, what's hidden, and what just appeared from behind
        # something). We only track entities the LLM might care about,
        # which means: skip very small things (radius < 0.10 m, like
        # fence posts) so the log doesn't fill up with cosmetic detail.
        for obj in self._world.objects:
            if obj.radius < 0.10 and not obj.dynamic:
                continue
            new_v = self._is_visible(robot_x, robot_y, robot_yaw, obj)
            old_v = self._entity_visible.get(obj.name)
            if new_v != old_v:
                self._entity_visible[obj.name] = new_v
                if old_v is None:
                    # First-ever check; only log if visible (entry into view)
                    if new_v:
                        ev = f"{obj.name} entered view"
                        self._event_log.append((now, ev))
                        self._new_events.append(ev)
                elif new_v:
                    ev = f"{obj.name} entered view"
                    self._event_log.append((now, ev))
                    self._new_events.append(ev)
                else:
                    ev = f"{obj.name} left view"
                    self._event_log.append((now, ev))
                    self._new_events.append(ev)

    def drain_new_events(self) -> list[str]:
        """Return events generated since the last drain; clears the buffer.

        Used by the bridge's tick loop to forward fresh events to the bus.
        """
        out = self._new_events
        self._new_events = []
        return out

    def recent_events(self, window_s: float = 30.0) -> list[dict]:
        now = time.time()
        cutoff = now - window_s
        return [
            {"age_s": round(now - t, 1), "event": e}
            for t, e in self._event_log
            if t >= cutoff
        ]

    def vision_summary(
        self, robot_x: float, robot_y: float, robot_yaw: float,
    ) -> list[dict]:
        """
        What the robot currently sees through its forward camera.

        Returns each visible (in-FOV, not occluded) entity with:
          - name, category, distance_m, bearing_deg (relative to heading)
          - is_dynamic
          - description

        Sorted near-to-far. Used by the LLM as a richer alternative to
        the proximity-quadrant view when it wants to know "what am I
        looking at?".
        """
        if self._world is None:
            return []
        result: list[dict] = []
        for obj in self._world.objects:
            # Cosmetic-only objects (radius 0, e.g. the rug) are visible
            # if in cone, but tiny posts (fence/lamp) we skip to keep
            # the summary readable.
            if obj.radius < 0.10 and not obj.dynamic:
                continue
            if not self._is_visible(robot_x, robot_y, robot_yaw, obj):
                continue
            dx = obj.x - robot_x
            dy = obj.y - robot_y
            dist = math.hypot(dx, dy)
            # Bearing relative to robot heading (+ = left, - = right).
            world_bearing = math.atan2(dy, dx)
            rel_bearing = math.degrees(self._wrap_pi(world_bearing - robot_yaw))
            result.append({
                "name": obj.name,
                "category": obj.category,
                "distance_m": round(dist, 2),
                "bearing_deg": round(rel_bearing, 1),
                "is_dynamic": obj.dynamic,
                "description": obj.description,
            })
        result.sort(key=lambda r: r["distance_m"])
        return result

    # ── Visibility helpers ──────────────────────────────────────────────────

    def _is_visible(
        self,
        robot_x: float, robot_y: float, robot_yaw: float,
        obj,
    ) -> bool:
        """Visible iff in front-cone, in range, and not occluded."""
        dx = obj.x - robot_x
        dy = obj.y - robot_y
        dist = math.hypot(dx, dy)
        if dist > VISION_RANGE or dist < 1e-6:
            return False
        # Angle to the entity in robot frame
        world_bearing = math.atan2(dy, dx)
        rel_bearing = self._wrap_pi(world_bearing - robot_yaw)
        if abs(rel_bearing) > math.radians(VISION_FOV_DEG / 2.0):
            return False
        # Occlusion check — only consider solid obstacles other than `obj`.
        # Passable terrain (obstacle=False) doesn't block sight.
        blockers = [
            o for o in self._world.objects
            if o is not obj and o.obstacle and o.radius > 0.05
        ]
        return _ray_blocked(robot_x, robot_y, obj.x, obj.y, blockers) is None

    @staticmethod
    def _wrap_pi(a: float) -> float:
        while a > math.pi:
            a -= 2 * math.pi
        while a < -math.pi:
            a += 2 * math.pi
        return a

    # ── Internals ──────────────────────────────────────────────────────────

    def _classify_quadrant(
        self,
        robot_x: float, robot_y: float, robot_yaw: float,
        obj_x: float, obj_y: float,
    ) -> str:
        dx = obj_x - robot_x
        dy = obj_y - robot_y
        dist = math.hypot(dx, dy)
        if dist > self.PERCEPTION_RANGE:
            return "far"
        cy, sy = math.cos(-robot_yaw), math.sin(-robot_yaw)
        rx = dx * cy - dy * sy
        ry = dx * sy + dy * cy
        ang = math.atan2(ry, rx)
        if -math.pi / 4 <= ang < math.pi / 4:
            return "front"
        if math.pi / 4 <= ang < 3 * math.pi / 4:
            return "left"
        if ang >= 3 * math.pi / 4 or ang < -3 * math.pi / 4:
            return "back"
        return "right"

    def _describe_transition(
        self, name: str, old_q: str | None, new_q: str
    ) -> str | None:
        if old_q is None:
            return f"{name} initially in {new_q} quadrant" if new_q != "far" else None
        if old_q == "far" and new_q != "far":
            return f"{name} entered range ({new_q})"
        if old_q != "far" and new_q == "far":
            return f"{name} left visible range"
        if new_q == "front" and old_q in ("left", "right"):
            return f"{name} now directly in front"
        return None  # other transitions are noise
