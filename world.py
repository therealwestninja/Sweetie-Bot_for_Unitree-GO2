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


@dataclass(frozen=True)
class Observer:
    """
    An external observer (typically the robot) that reactive entities
    react to. Passed through World.tick() to each dynamic entity's
    update() method on every frame. Optional everywhere — entities that
    ignore it behave the same as they did pre-reactive.
    """

    x: float
    y: float
    yaw: float = 0.0


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

    def update(self, dt: float, observer: Observer | None = None) -> None:
        """Advance this object by `dt` seconds. No-op for static objects.

        `observer` is an optional reference to an external observer (the
        robot). Reactive subclasses may use it to flee, yield, or
        otherwise respond to its position. The base WorldObject ignores it.
        """

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

    Reactive behaviour: if `flee_distance > 0` and an `observer` arrives
    within that distance, the wanderer overrides its current target with
    one heading directly away from the observer, and moves at
    `speed * flee_speed_multiplier` until it's clear. This is the cat
    scrambling away when the robot gets too close.
    """

    dynamic: ClassVar[bool] = True

    speed: float = 0.2
    roam_radius: float = 1.0
    home_x: float | None = None  # None → use initial x
    home_y: float | None = None
    seed: int | None = None
    arrival_tolerance: float = 0.05
    # Reactive params. flee_distance=0 disables fleeing entirely (back-compat).
    flee_distance: float = 0.0
    flee_speed_multiplier: float = 2.0

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

    def update(self, dt: float, observer: Observer | None = None) -> None:
        # If observer is too close, override the current target with a flee
        # heading. Movement code below then drives toward whichever target
        # is current — flee or wander — at the appropriate speed.
        fleeing = self._maybe_flee(observer)
        speed = self.speed * (self.flee_speed_multiplier if fleeing else 1.0)
        self._step_toward_target(dt, speed)

    def _maybe_flee(self, observer: Observer | None) -> bool:
        if observer is None or self.flee_distance <= 0.0:
            return False
        dx = self.x - observer.x
        dy = self.y - observer.y
        dist = math.hypot(dx, dy)
        if dist > self.flee_distance:
            return False
        # Set target heading directly away from the observer.
        if dist < 1e-6:
            # Observer is right on top of us — flee in a random direction.
            angle = self._rng.uniform(-math.pi, math.pi)
            ux, uy = math.cos(angle), math.sin(angle)
        else:
            ux, uy = dx / dist, dy / dist
        flee_step = self.flee_distance * 1.5
        self._target_x = self.x + ux * flee_step
        self._target_y = self.y + uy * flee_step
        return True

    def _step_toward_target(self, dt: float, speed: float) -> None:
        dx = self._target_x - self.x
        dy = self._target_y - self.y
        dist = math.hypot(dx, dy)
        if dist < self.arrival_tolerance:
            # Reached target — pick a new one inside the roam circle. After
            # a flee, this is the path back home (since the new target is
            # constrained to roam_radius from home).
            angle = self._rng.uniform(-math.pi, math.pi)
            r = self._rng.uniform(0.0, self.roam_radius)
            self._target_x = (self.home_x or 0.0) + r * math.cos(angle)
            self._target_y = (self.home_y or 0.0) + r * math.sin(angle)
            return
        step = min(speed * dt, dist)
        self.x += step * dx / dist
        self.y += step * dy / dist


@dataclass
class PathWalker(WorldObject):
    """
    A WorldObject that walks a fixed loop of waypoints at constant speed.

    When it reaches the current waypoint (within `arrival_tolerance`), it
    advances to the next one and loops at the end. The person.

    `waypoints` is a list of (x, y) tuples. An empty list means stand still.

    Reactive behaviour: if `yield_distance > 0` and an `observer` is within
    that distance AND inside the forward ~60° cone (i.e. roughly in the
    walker's path), the walker stops moving for this tick. This is the
    person seeing the robot in their way and pausing, expecting the robot
    to move. Note: there's no escape — if the operator never moves, the
    walker waits indefinitely. That's by design; M? could add an "I'll
    just go around" behaviour later.
    """

    dynamic: ClassVar[bool] = True

    waypoints: list[tuple[float, float]] = field(default_factory=list)
    speed: float = 0.3
    arrival_tolerance: float = 0.08
    # Reactive params. yield_distance=0 disables yielding (back-compat).
    yield_distance: float = 0.0
    # Cosine of the half-angle of the forward cone in which observers count
    # as "in my path". 0.5 = 60° half-angle. Higher = narrower cone.
    yield_cone_cos: float = 0.5

    _wp_index: int = field(init=False, default=0)

    def update(self, dt: float, observer: Observer | None = None) -> None:
        if self._should_yield(observer):
            return  # don't move this tick
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

    def _should_yield(self, observer: Observer | None) -> bool:
        if observer is None or self.yield_distance <= 0.0 or not self.waypoints:
            return False
        dx = observer.x - self.x
        dy = observer.y - self.y
        dist = math.hypot(dx, dy)
        if dist > self.yield_distance:
            return False
        if dist < 1e-6:
            return True  # observer right on top of us — definitely yield
        # Heading vector: from current position toward current waypoint.
        wx, wy = self.waypoints[self._wp_index]
        hdx, hdy = wx - self.x, wy - self.y
        hdist = math.hypot(hdx, hdy)
        if hdist < 1e-6:
            return False
        # Cosine of angle between heading and direction-to-observer.
        cos_angle = (dx * hdx + dy * hdy) / (dist * hdist)
        return cos_angle > self.yield_cone_cos


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

    def tick(self, dt: float, observer: Observer | None = None) -> None:
        """
        Advance all dynamic entities by `dt` seconds, tracking velocity.

        `observer` (typically the robot's pose) is forwarded to each
        entity's update() method so reactive entities can respond to it.
        """
        for obj in self.objects:
            if obj.dynamic:
                # Snapshot before update so velocity_of() can compute dx/dt.
                obj._prev_x = obj.x
                obj._prev_y = obj.y
                obj._tick_dt = dt
                obj.update(dt, observer=observer)

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
                # Reactive: cats don't like robots getting too close.
                flee_distance=0.6,
                flee_speed_multiplier=2.5,
                # No seed → unpredictable in production. Tests pass their own.
            ),
            PathWalker(
                name="person",
                x=-2.0, y=1.5,
                radius=0.25,
                category="person",
                description="a person walking around the apartment",
                speed=0.4,
                # Reactive: pause when the robot is in our way.
                yield_distance=1.0,
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
