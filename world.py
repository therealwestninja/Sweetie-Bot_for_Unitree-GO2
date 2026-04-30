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


@dataclass(frozen=True)
class Region:
    """
    A named axis-aligned bounding box on the world's xy plane.

    Regions are used for zone-aware behavior — the bridge can detect
    when the robot crosses from one region to another and emit an event.
    They're also a natural way to give the LLM spatial context ("you're
    in the apartment area" vs "you're in the street").

    Regions don't enforce anything — they're just labelled bounding
    boxes. They never block motion. Multiple regions may overlap; the
    first match in `World.regions` wins for `region_at()`.
    """

    name: str
    x_min: float
    x_max: float
    y_min: float
    y_max: float
    description: str = ""

    def contains(self, x: float, y: float) -> bool:
        return self.x_min <= x <= self.x_max and self.y_min <= y <= self.y_max


@dataclass
class WorldObject:
    """A named thing in the world. Position is the center of its bounding circle."""

    name: str
    x: float
    y: float
    radius: float = 0.3
    description: str = ""
    # Loose grouping the LLM can reason about: 'furniture', 'animal',
    # 'person', 'fixture', 'decor', 'object', 'prop', 'vehicle',
    # 'infrastructure', 'cone', 'barrier', 'stairs', 'terrain'.
    # Free-form; not enum'd because we want to grow the vocabulary
    # without ceremony.
    category: str = "object"
    # Whether this object physically blocks the robot. False for terrain
    # features (slopes, hills, moguls) that the robot can drive over even
    # though they're spatially extended. M4 proximity scaling and
    # range_obstacle ignore non-obstacles.
    obstacle: bool = True

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
            "obstacle": self.obstacle,
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
    # Named bounding boxes laid over the xy plane. Used for zone-aware
    # context ("you're in the apartment") and zone-transition events
    # that ambient cognition can react to. Defaults to no regions —
    # focused practice scenes that span a single area don't need them.
    regions: list[Region] = field(default_factory=list)

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

    def region_at(self, x: float, y: float) -> Region | None:
        """First region containing (x, y), or None. List order is precedence."""
        for r in self.regions:
            if r.contains(x, y):
                return r
        return None

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
            if not obj.obstacle:
                continue
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


# ── Scene builders ──────────────────────────────────────────────────────────
#
# Each region of the studio backlot is built by its own private function
# so individual practice scenes can pick and choose. The combined
# `studio_scene()` is what the M? scene-expansion milestone shipped; the
# split into apartment / street / stairs / agility lets an operator
# focus on one practice area at a time without the visual clutter of the
# others. Pattern borrowed from `isaac_go2_ros2/sim_env.py` (BSD-2,
# RoboVerse community 2024) — see `third_party/isaac_go2_ros2/sim_env.py`
# and `docs/go2-references.md`.


def _apartment_objects() -> list[WorldObject]:
    """Couch / table / kitchen / door / rug, plus the cat and the person.

    The reactive entities live here because their waypoints reference
    apartment furniture coordinates. Picking a non-apartment scene
    means a static-only world.
    """
    return [
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
            x=0.5, y=-1.5, radius=0.15,
            category="animal",
            description="a small black cat, currently wandering",
            speed=0.15, roam_radius=0.8,
            flee_distance=0.6, flee_speed_multiplier=2.5,
        ),
        PathWalker(
            name="person",
            x=-2.0, y=1.5, radius=0.25,
            category="person",
            description="a person walking around the apartment",
            speed=0.4, yield_distance=1.0,
            waypoints=[
                (-2.0,  1.5), (-0.5,  2.3), ( 1.5,  2.3),
                ( 2.5,  0.5), ( 2.0, -1.5), (-1.0, -2.0),
                (-2.3,  0.0),
            ],
        ),
    ]


def _street_objects() -> list[WorldObject]:
    """Road, parked car, sidewalk furniture, traffic cones, fence line."""
    return [
        WorldObject("road", x=6.0, y=0.0, radius=0.0,
                    category="terrain", obstacle=False,
                    description="a paved 2-lane road running roughly N-S"),
        WorldObject("car", x=6.0, y=-1.0, radius=0.9,
                    category="vehicle",
                    description="a parked sedan along the curb"),
        WorldObject("lamp post", x=4.5, y=2.5, radius=0.05,
                    category="infrastructure",
                    description="a tall street lamp post"),
        WorldObject("fire hydrant", x=4.5, y=-2.5, radius=0.15,
                    category="infrastructure",
                    description="a red fire hydrant on the sidewalk"),
        # Sidewalk curbs — 4 small posts approximating the curb edge.
        WorldObject("curb (north end)",     x=5.0, y=2.0, radius=0.08,
                    category="infrastructure",
                    description="raised concrete curb edge"),
        WorldObject("curb (mid-north)",     x=5.0, y=0.5, radius=0.08,
                    category="infrastructure",
                    description="raised concrete curb edge"),
        WorldObject("curb (mid-south)",     x=5.0, y=-1.0, radius=0.08,
                    category="infrastructure",
                    description="raised concrete curb edge"),
        WorldObject("curb (south end)",     x=5.0, y=-2.5, radius=0.08,
                    category="infrastructure",
                    description="raised concrete curb edge"),
        # Traffic cones in a coning-off pattern.
        WorldObject("traffic cone NW", x=5.5, y=1.5, radius=0.15,
                    category="cone",
                    description="orange traffic cone"),
        WorldObject("traffic cone NE", x=6.5, y=1.5, radius=0.15,
                    category="cone",
                    description="orange traffic cone"),
        WorldObject("traffic cone SW", x=5.5, y=-1.8, radius=0.15,
                    category="cone",
                    description="orange traffic cone"),
        WorldObject("traffic cone SE", x=6.5, y=-1.8, radius=0.15,
                    category="cone",
                    description="orange traffic cone"),
        # Fence line on the sidewalk side.
        WorldObject("fence post 1", x=4.0, y=-2.0, radius=0.05,
                    category="barrier",
                    description="part of a chain-link fence line"),
        WorldObject("fence post 2", x=4.0, y=-0.7, radius=0.05,
                    category="barrier",
                    description="part of a chain-link fence line"),
        WorldObject("fence post 3", x=4.0, y=0.7, radius=0.05,
                    category="barrier",
                    description="part of a chain-link fence line"),
        WorldObject("fence post 4", x=4.0, y=2.0, radius=0.05,
                    category="barrier",
                    description="part of a chain-link fence line"),
    ]


def _stairs_objects() -> list[WorldObject]:
    """Straight stair runs (2/3/5/8 steps) plus the L-bend.

    Note: our kinematic sim has no Z axis — stairs are represented
    spatially and the LLM can talk about them, but the robot doesn't
    actually traverse them. Real stairs traversal is an M6 (physics)
    concern. They're marked as obstacles so the safety guard treats
    them as something to approach carefully.
    """
    return [
        WorldObject("stairs (2-step run)", x=-3.0, y=5.0, radius=0.6,
                    category="stairs",
                    description="a 2-step run going up to the north"),
        WorldObject("stairs (3-step run)", x=-1.0, y=5.0, radius=0.7,
                    category="stairs",
                    description="a 3-step run going up to the north"),
        WorldObject("stairs (5-step run)", x=1.0, y=5.0, radius=0.9,
                    category="stairs",
                    description="a 5-step run going up to the north"),
        WorldObject("stairs (8-step run)", x=3.0, y=5.0, radius=1.2,
                    category="stairs",
                    description="an 8-step run going up to the north"),
        # L-bend stairs: 2 steps up, 90° right turn platform, then 8 more.
        WorldObject("L-bend stairs (lower)", x=-3.0, y=7.5, radius=0.5,
                    category="stairs",
                    description="2 steps up, leading to a turn platform"),
        WorldObject("L-bend stairs (platform)", x=-2.5, y=8.0, radius=0.4,
                    category="stairs",
                    description="90-degree right-turn platform between stair runs"),
        WorldObject("L-bend stairs (upper)", x=-1.0, y=8.5, radius=1.0,
                    category="stairs",
                    description="8 steps continuing east from the turn platform"),
    ]


def _agility_objects() -> list[WorldObject]:
    """Apple boxes (props) plus passable terrain (slope, hill, moguls, gravel)."""
    return [
        # Apple boxes — standard film-industry sizes.
        WorldObject("apple box (full)", x=-4.5, y=-3.5, radius=0.18,
                    category="prop",
                    description="full apple box, ~20 inches tall"),
        WorldObject("apple box (half)", x=-4.5, y=-4.0, radius=0.18,
                    category="prop",
                    description="half apple box, ~10 inches tall"),
        WorldObject("apple box (quarter / pancake)", x=-5.0, y=-3.5, radius=0.16,
                    category="prop",
                    description="quarter apple box, aka pancake, ~5 inches tall"),
        WorldObject("apple box (eighth)", x=-5.0, y=-4.0, radius=0.15,
                    category="prop",
                    description="eighth apple box, ~2.5 inches tall"),
        # Terrain — passable; doesn't block proximity scaling in our sim.
        WorldObject("gentle slope", x=-6.5, y=-4.5, radius=1.2,
                    category="terrain", obstacle=False,
                    description="a gentle slope, maybe 10 degrees, leading up to the hill"),
        WorldObject("hill", x=-7.5, y=-6.5, radius=1.5,
                    category="terrain", obstacle=False,
                    description="a small grassy hill, peaks ~0.5 m above flat ground"),
        WorldObject("moguls", x=-3.5, y=-6.0, radius=1.3,
                    category="terrain", obstacle=False,
                    description="a patch of small bumps, like ski moguls — challenging footing"),
        WorldObject("gravel patch", x=-1.5, y=-5.5, radius=0.8,
                    category="terrain", obstacle=False,
                    description="loose gravel, would slow a real Go2 down"),
    ]


# ── Scene constructors ──────────────────────────────────────────────────────
#
# Each function returns a fresh `World`. Construct fresh on every call —
# don't cache — because tests and live ticks both mutate object state
# (positions, _prev_x, etc.).


# ── Region definitions ──────────────────────────────────────────────────────
#
# Bounding boxes for the four named regions of the studio backlot. The
# numbers match the ASCII layout diagram in `studio_scene()`. Order
# matters: `region_at()` returns the FIRST match, so put narrower/more
# specific zones earlier if any are added later.

_APARTMENT_REGION = Region(
    name="apartment",
    x_min=-3.0, x_max=3.5, y_min=-3.0, y_max=4.0,
    description="the apartment: furniture, cat, and person",
)
_STREET_REGION = Region(
    name="street",
    x_min=3.5, x_max=9.0, y_min=-9.0, y_max=4.0,
    description="the street area with car, hydrant, lamp, cones, fence",
)
_STAIRS_REGION = Region(
    name="stairs",
    x_min=-9.0, x_max=3.5, y_min=4.0, y_max=9.0,
    description="the stairs run-up zone",
)
_AGILITY_REGION = Region(
    name="agility",
    x_min=-9.0, x_max=-3.0, y_min=-9.0, y_max=-3.0,
    description="the agility area: apple boxes, slopes, hill, moguls, gravel",
)


def apartment_scene() -> World:
    """Just the apartment: furniture + cat + person. No street, stairs, or props."""
    return World(objects=_apartment_objects(), regions=[_APARTMENT_REGION])


def street_scene() -> World:
    """Just the street: car, hydrant, lamp, cones, fence, curbs. Static only."""
    return World(objects=_street_objects(), regions=[_STREET_REGION])


def stairs_scene() -> World:
    """Just the stairs: 2/3/5/8-step runs and the L-bend. Static only."""
    return World(objects=_stairs_objects(), regions=[_STAIRS_REGION])


def agility_scene() -> World:
    """Just the agility area: apple boxes + slopes / hill / moguls / gravel."""
    return World(objects=_agility_objects(), regions=[_AGILITY_REGION])


def studio_scene() -> World:
    """
    The full "studio backlot" — every region in one world.

    Layout (top-down, x = east/forward, y = north/left):

        y=+9 ┌───────────────────────────────────┐
             │   STAIRS                          │
             │   (run-up zone)                   │
        y=+4 ├──────────────────┐                │
             │ APARTMENT        │                │
             │ (couch, cat,     │  STREET        │
             │  person, etc.)   │  (car, hydrant,│
        y=0  │                  │   cones, ...)  │
             │                  │                │
        y=-3 ├──────────────────┘                │
             │ AGILITY                           │
             │ (slopes, hill, moguls, props)     │
        y=-9 └───────────────────────────────────┘
             x=-9   x=-3        x=+3.5   x=+9

    This is what `default_scene()` returns for back-compat.
    """
    return World(
        objects=(
            _apartment_objects()
            + _street_objects()
            + _stairs_objects()
            + _agility_objects()
        ),
        regions=[
            _APARTMENT_REGION,
            _STREET_REGION,
            _STAIRS_REGION,
            _AGILITY_REGION,
        ],
    )


# ── Procedural obstacle scenes ──────────────────────────────────────────────
#
# Random scattered obstacles in a bounded area. Useful for stress-testing
# navigation, smart-assist scaling, and the LLM's reaction to "this place
# is full of stuff" without hand-placing 200 rocks. Pattern borrowed from
# `isaac_go2_ros2/sim_env.py` (BSD-2 RoboVerse community 2024) — in their
# Isaac Sim setup, terrain generators procedurally place hurdles, ramps,
# and rough patches in a randomized arena. We do the same in 2D.
#
# Three densities are exposed: sparse, medium, dense. The same RNG seed
# is used every time so tests are reproducible and runs stay comparable.
# A clearance disk around the origin keeps the robot's spawn point free.


def _generate_obstacle_field(
    count: int,
    seed: int,
    *,
    bounds: tuple[float, float, float, float] = (-9.0, 9.0, -9.0, 9.0),
    spawn_clearance: float = 1.5,
    radius_min: float = 0.20,
    radius_max: float = 0.60,
) -> list[WorldObject]:
    """Place `count` deterministic random obstacles within `bounds`.

    Obstacles are simple rocks (`category="prop"`, `obstacle=True`).
    Origin (0, 0) is kept clear within `spawn_clearance` so the robot
    can stand and turn before it has to deal with anything. Bounded
    rejection-sampling — if 200 attempts can't place an obstacle without
    overlapping a previous one or violating spawn clearance, we move on
    with whatever was placed (so densities are best-effort, not exact).
    """
    import random

    rng = random.Random(seed)
    x_min, x_max, y_min, y_max = bounds
    placed: list[WorldObject] = []

    for i in range(count):
        for _attempt in range(200):
            x = rng.uniform(x_min, x_max)
            y = rng.uniform(y_min, y_max)
            r = rng.uniform(radius_min, radius_max)
            # Spawn clearance: don't drop a rock on the robot.
            if math.hypot(x, y) < spawn_clearance + r:
                continue
            # No overlap with already-placed obstacles.
            if any(
                math.hypot(x - p.x, y - p.y) < (r + p.radius + 0.10)
                for p in placed
            ):
                continue
            placed.append(WorldObject(
                name=f"rock {i + 1}",
                x=x, y=y, radius=round(r, 2),
                category="prop",
                description=f"a rock, ~{round(r * 100)} cm across",
            ))
            break
    return placed


_OBSTACLE_FIELD_REGION = Region(
    name="obstacle-field",
    x_min=-9.0, x_max=9.0, y_min=-9.0, y_max=9.0,
    description="an open field scattered with rocks of varying size",
)


def obstacle_sparse_scene() -> World:
    """~50 random rocks. Light density — easy to navigate around."""
    return World(
        objects=_generate_obstacle_field(count=50, seed=1),
        regions=[_OBSTACLE_FIELD_REGION],
    )


def obstacle_medium_scene() -> World:
    """~100 random rocks. Realistic outdoor-ish density."""
    return World(
        objects=_generate_obstacle_field(count=100, seed=2),
        regions=[_OBSTACLE_FIELD_REGION],
    )


def obstacle_dense_scene() -> World:
    """~200 random rocks. Stress-test density — many will fail to place."""
    return World(
        objects=_generate_obstacle_field(count=200, seed=3),
        regions=[_OBSTACLE_FIELD_REGION],
    )


# ── Scene registry ──────────────────────────────────────────────────────────

SCENES: dict[str, "callable"] = {
    "apartment": apartment_scene,
    "street":    street_scene,
    "stairs":    stairs_scene,
    "agility":   agility_scene,
    "studio":    studio_scene,
    "obstacle-sparse": obstacle_sparse_scene,
    "obstacle-medium": obstacle_medium_scene,
    "obstacle-dense":  obstacle_dense_scene,
}


def get_scene(name: str) -> World:
    """
    Return a fresh `World` by scene name. Unknown names fall back to
    `studio` (the full backlot) with a logged warning.
    """
    constructor = SCENES.get(name.lower().strip())
    if constructor is None:
        # Defer the import so this module stays cheap to import.
        import logging
        logging.getLogger(__name__).warning(
            "Unknown scene name %r; falling back to 'studio'. "
            "Valid names: %s",
            name, sorted(SCENES.keys()),
        )
        return studio_scene()
    return constructor()


# Back-compat: the old `default_scene()` is what most tests and demos
# expect — keep it as an alias to the full studio backlot.
def default_scene() -> World:
    """Back-compat alias for `studio_scene()`. Prefer `get_scene("studio")` going forward."""
    return studio_scene()
