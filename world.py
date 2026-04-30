"""
Fake world.

A 2D top-down "room" containing named objects. Each object is a circle on
the floor with a name, a radius, and an optional description. The same
object plays two roles:

  - A target the LLM can refer to by name (`look_at("the couch")`).
  - An obstacle that contributes to the robot's `range_obstacle[4]`
    proximity readings, mirroring the schema the real Go2 publishes.

Some objects move on their own (Wanderer, PathWalker). The bridge ticks
the world every frame, so moving entities update at simulator rate (50 Hz)
and the existing M4 smart-assist scaling reacts to them automatically.

The world is intentionally not a physics engine. It doesn't simulate
collisions or push-back — moving entities will happily drift through walls
and through each other. That's enough for the smart-assist hooks, the
look-at tool, and surroundings reports. When/if real physics matter,
swap in MuJoCo and have the bridge consume that instead of this.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import ClassVar

# Quadrant indices for range_obstacle[4]. These match what we'll show in
# the UI and what we'll tell the LLM in report_status.
QUADRANT_FRONT = 0
QUADRANT_LEFT = 1
QUADRANT_BACK = 2
QUADRANT_RIGHT = 3
QUADRANT_NAMES = ("front", "left", "back", "right")

# How far the (notional) proximity sensors see, in meters. Anything beyond
# this returns max_range, matching real-world ultrasonic-style sensors.
PROXIMITY_MAX_RANGE = 3.0


@dataclass
class WorldObject:
    """A named thing in the world. Position is the center of its bounding circle."""

    name: str
    x: float
    y: float
    radius: float = 0.3
    description: str = ""
    # Loose grouping the LLM can reason about: 'furniture', 'animal',
    # 'person', 'fixture', 'decor', 'object'. Free-form; not enum'd because
    # we want to grow the vocabulary without ceremony.
    category: str = "object"

    # Class-level flag so `World` can pick out entities that need ticking.
    # Subclasses override this to True. Using a ClassVar keeps it out of
    # the dataclass field list, so it doesn't show up in __init__.
    dynamic: ClassVar[bool] = False

    # Per-tick velocity tracking. World.tick() snapshots position before
    # calling update(), so velocity_of(obj) can recover dx/dt afterward.
    # Static objects keep these at zero forever; harmless overhead.
    _prev_x: float = field(init=False, default=0.0)
    _prev_y: float = field(init=False, default=0.0)
    _tick_dt: float = field(init=False, default=0.0)

    def update(self, dt: float) -> None:
        """Advance this object by `dt` seconds. No-op for static objects."""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "x": self.x,
            "y": self.y,
            "radius": self.radius,
            "description": self.description,
            "category": self.category,
            "dynamic": self.dynamic,
        }


@dataclass
class Wanderer(WorldObject):
    """
    A WorldObject that random-walks within `roam_radius` of its home position.

    Picks a random target inside the roam circle, walks toward it at `speed`,
    picks a new one when it arrives. The cat.

    Pass `seed` for deterministic behaviour in tests; leave it None for
    "different every run".
    """

    dynamic: ClassVar[bool] = True

    speed: float = 0.2
    roam_radius: float = 1.0
    home_x: float | None = None  # None → use initial x
    home_y: float | None = None
    seed: int | None = None
    arrival_tolerance: float = 0.05

    # Internal state
    _target_x: float = field(init=False, default=0.0)
    _target_y: float = field(init=False, default=0.0)
    _rng: random.Random = field(init=False, default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.home_x is None:
            self.home_x = self.x
        if self.home_y is None:
            self.home_y = self.y
        self._target_x = self.x
        self._target_y = self.y
        self._rng = random.Random(self.seed)

    def update(self, dt: float) -> None:
        dx = self._target_x - self.x
        dy = self._target_y - self.y
        dist = math.hypot(dx, dy)
        if dist < self.arrival_tolerance:
            # Reached target — pick a new one inside the roam circle.
            angle = self._rng.uniform(-math.pi, math.pi)
            r = self._rng.uniform(0.0, self.roam_radius)
            self._target_x = (self.home_x or 0.0) + r * math.cos(angle)
            self._target_y = (self.home_y or 0.0) + r * math.sin(angle)
            return
        step = min(self.speed * dt, dist)
        self.x += step * dx / dist
        self.y += step * dy / dist


@dataclass
class PathWalker(WorldObject):
    """
    A WorldObject that walks a fixed loop of waypoints at constant speed.

    When it reaches the current waypoint (within `arrival_tolerance`), it
    advances to the next one and loops at the end. The person.

    `waypoints` is a list of (x, y) tuples. An empty list means stand still.
    """

    dynamic: ClassVar[bool] = True

    waypoints: list[tuple[float, float]] = field(default_factory=list)
    speed: float = 0.3
    arrival_tolerance: float = 0.08

    _wp_index: int = field(init=False, default=0)

    def update(self, dt: float) -> None:
        if not self.waypoints:
            return
        wx, wy = self.waypoints[self._wp_index]
        dx, dy = wx - self.x, wy - self.y
        dist = math.hypot(dx, dy)
        if dist < self.arrival_tolerance:
            self._wp_index = (self._wp_index + 1) % len(self.waypoints)
            return
        step = min(self.speed * dt, dist)
        self.x += step * dx / dist
        self.y += step * dy / dist


@dataclass
class World:
    """A flat collection of WorldObjects with spatial query helpers."""

    objects: list[WorldObject] = field(default_factory=list)

    # ── lookup ──────────────────────────────────────────────────────────────

    def by_name(self, name: str) -> WorldObject | None:
        """Case-insensitive lookup. Tolerant of leading articles ('the cat')."""
        norm = name.strip().lower()
        if norm.startswith("the "):
            norm = norm[4:]
        for obj in self.objects:
            on = obj.name.strip().lower()
            if on == norm or on.removeprefix("the ") == norm:
                return obj
        return None

    def names(self) -> list[str]:
        return [o.name for o in self.objects]

    # ── geometry ────────────────────────────────────────────────────────────

    def bearing_from(self, x: float, y: float, target: WorldObject) -> float:
        """World-frame yaw (radians, [-pi, pi]) from (x, y) toward target."""
        return math.atan2(target.y - y, target.x - x)

    def proximity_ranges(
        self,
        x: float,
        y: float,
        yaw: float,
        max_range: float = PROXIMITY_MAX_RANGE,
    ) -> list[float]:
        """
        Mimic the real Go2's `range_obstacle[4]` field.

        Returns [front, left, back, right] distances in meters, measured
        from the robot to the nearest edge of any object whose center
        lies in that quadrant of the robot frame. Caps at `max_range`.
        """
        ranges = [max_range] * 4
        cy, sy = math.cos(-yaw), math.sin(-yaw)
        for obj in self.objects:
            dx = obj.x - x
            dy = obj.y - y
            # Transform world-frame delta into robot frame.
            rx = dx * cy - dy * sy
            ry = dx * sy + dy * cy
            edge_dist = max(0.0, math.hypot(rx, ry) - obj.radius)
            if edge_dist >= max_range:
                continue
            # Classify by angle in robot frame.
            ang = math.atan2(ry, rx)
            if -math.pi / 4 <= ang < math.pi / 4:
                q = QUADRANT_FRONT
            elif math.pi / 4 <= ang < 3 * math.pi / 4:
                q = QUADRANT_LEFT
            elif ang >= 3 * math.pi / 4 or ang < -3 * math.pi / 4:
                q = QUADRANT_BACK
            else:
                q = QUADRANT_RIGHT
            ranges[q] = min(ranges[q], edge_dist)
        return ranges

    def visible_summary(
        self,
        x: float,
        y: float,
        max_range: float = PROXIMITY_MAX_RANGE * 2,
    ) -> list[dict]:
        """
        Cheap "what's around me" report. No FOV cone, no occlusion — every
        object within `max_range` is listed with its bearing, distance, and
        category, sorted near-to-far. For dynamic entities, the entry also
        carries a velocity vector and a `motion` heuristic ('approaching',
        'receding', 'parallel', 'stationary') relative to the observer
        position. Used by the LLM's report_status tool.

        The motion classification assumes the observer is stationary. When
        the robot itself is moving fast this is inaccurate, but the
        operator's joystick speed is generally well below entity speeds,
        and the LLM gets the raw velocity too if it wants to do better.
        """
        result: list[dict] = []
        for obj in self.objects:
            dx, dy = obj.x - x, obj.y - y
            dist = math.hypot(dx, dy)
            if dist > max_range:
                continue
            bearing_deg = math.degrees(math.atan2(dy, dx))
            entry: dict = {
                "name": obj.name,
                "category": obj.category,
                "distance_m": round(dist, 2),
                "bearing_deg": round(bearing_deg, 1),
                "description": obj.description,
            }
            if obj.dynamic:
                vx, vy = self.velocity_of(obj)
                speed = math.hypot(vx, vy)
                entry["velocity_mps"] = {"x": round(vx, 2), "y": round(vy, 2)}
                entry["speed_mps"] = round(speed, 2)
                if speed < 0.05:
                    entry["motion"] = "stationary"
                elif dist < 1e-6:
                    entry["motion"] = "at observer"
                else:
                    # Closing = entity moving toward observer (positive when approaching).
                    ux, uy = dx / dist, dy / dist
                    closing = -(vx * ux + vy * uy)
                    if closing > 0.05:
                        entry["motion"] = "approaching"
                    elif closing < -0.05:
                        entry["motion"] = "receding"
                    else:
                        entry["motion"] = "parallel"
            result.append(entry)
        result.sort(key=lambda r: r["distance_m"])
        return result

    def to_dict(self) -> dict:
        return {"objects": [o.to_dict() for o in self.objects]}

    # ── tick ────────────────────────────────────────────────────────────────

    def tick(self, dt: float) -> None:
        """Advance all dynamic entities by `dt` seconds, tracking velocity."""
        for obj in self.objects:
            if obj.dynamic:
                # Snapshot before update so velocity_of() can compute dx/dt.
                obj._prev_x = obj.x
                obj._prev_y = obj.y
                obj._tick_dt = dt
                obj.update(dt)

    def velocity_of(self, obj: WorldObject) -> tuple[float, float]:
        """Instantaneous velocity (m/s) recovered from the last tick."""
        if not obj.dynamic or obj._tick_dt == 0.0:
            return (0.0, 0.0)
        return (
            (obj.x - obj._prev_x) / obj._tick_dt,
            (obj.y - obj._prev_y) / obj._tick_dt,
        )


def default_scene() -> World:
    """
    A small domestic-ish room. Everything is roughly within a 4 x 4 m area
    centered on the robot's start position (0, 0, yaw=0 = facing +x).

    Coordinate conventions: +x is "in front", +y is "to the left" of the
    robot's starting orientation. (Standard right-hand rule, z-up.)

    Static furniture (couch, coffee table, kitchen counter, door, rug),
    plus two moving entities — a Wanderer cat and a PathWalker person.
    """
    return World(
        objects=[
            WorldObject("couch", x=2.0, y=1.5, radius=0.6,
                        category="furniture",
                        description="a long soft couch along the wall"),
            WorldObject("coffee table", x=1.2, y=0.0, radius=0.4,
                        category="furniture",
                        description="a low wooden coffee table"),
            WorldObject("kitchen counter", x=-1.5, y=2.5, radius=0.7,
                        category="furniture",
                        description="the kitchen counter, with the sink"),
            WorldObject("door", x=-2.5, y=0.0, radius=0.2,
                        category="fixture",
                        description="the doorway out to the hallway"),
            WorldObject("rug", x=1.0, y=0.5, radius=0.0,
                        category="decor",
                        description="a patterned rug; not an obstacle"),
            Wanderer(
                name="cat",
                x=0.5, y=-1.5,
                radius=0.15,
                category="animal",
                description="a small black cat, currently wandering",
                speed=0.15,
                roam_radius=0.8,
                # No seed → unpredictable in production. Tests pass their own.
            ),
            PathWalker(
                name="person",
                x=-2.0, y=1.5,
                radius=0.25,
                category="person",
                description="a person walking around the apartment",
                speed=0.4,
                # A counter-clockwise loop around the room periphery,
                # threading between the static furniture.
                waypoints=[
                    (-2.0,  1.5),
                    (-0.5,  2.3),
                    ( 1.5,  2.3),
                    ( 2.5,  0.5),
                    ( 2.0, -1.5),
                    (-1.0, -2.0),
                    (-2.3,  0.0),
                ],
            ),
        ]
    )
