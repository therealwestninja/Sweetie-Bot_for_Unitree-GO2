"""
Bridge layer.

A bridge is the only thing in the codebase that knows how to talk to a robot
(real or simulated). Everything else — safety, cognition, the web UI — talks
to BridgeBase. This is the seam where you'd later drop in a RealBridge
(unitree_sdk2py / DDS) without touching anything above.

For M1-M3 we ship SimBridge. It maintains a plausible RobotState, integrates
commanded velocity into pose, populates proximity ranges from a World (M3),
and supports closed-loop yaw goals for `look_at` (M3).
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass, field

from sweetie.core.avoidance import AvoidanceConfig
from sweetie.core.avoidance import steer as avoid_steer
from sweetie.core.bus import bus
from sweetie.sim.perception import SimPerception
from sweetie.sim.world import PROXIMITY_MAX_RANGE, Observer, World

logger = logging.getLogger(__name__)

# Velocity envelope — also enforced in safety.py, but the bridge is the
# last line of defense.
VX_LIMIT = 1.5
VY_LIMIT = 0.8
VYAW_LIMIT = 2.0

# Closed-loop yaw control for look_at: simple P controller, with a small
# tolerance band where we consider the goal "reached".
YAW_KP = 2.5
YAW_GOAL_TOLERANCE = math.radians(3.0)


from sweetie.core.mathutil import clamp, wrap_angle as _wrap_pi


@dataclass
class RobotState:
    timestamp: float = field(default_factory=time.time)
    # Motion
    vx: float = 0.0
    vy: float = 0.0
    vyaw: float = 0.0
    body_height: float = 0.27  # Go2 default standing height (m)
    # Pose (sim-integrated)
    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0
    # IMU
    roll: float = 0.0
    pitch: float = 0.0
    # Power
    battery_percent: float = 100.0
    # Status
    mode: str = "down"  # "down" | "standing" | "moving" | "estop"
    # Proximity ranges to nearest obstacle in [front, left, back, right].
    # Mirrors `range_obstacle[4]` from the real Go2's SportModeState.msg.
    range_obstacle: list[float] = field(
        default_factory=lambda: [PROXIMITY_MAX_RANGE] * 4
    )

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "velocity": {"x": self.vx, "y": self.vy, "yaw": self.vyaw},
            "pose": {"x": self.x, "y": self.y, "yaw": self.yaw},
            "body_height": self.body_height,
            "imu": {"roll": self.roll, "pitch": self.pitch},
            "battery_percent": self.battery_percent,
            "mode": self.mode,
            "range_obstacle": list(self.range_obstacle),
        }


# Body height envelope for the Go2 (meters). Source: Unitree firmware /
# `unitree_sdk2py.SportClient.BodyHeight()` accepts a relative offset
# from the standing default (~0.27 m) in roughly ±0.10 m. We expose
# absolute heights to the operator/LLM and convert internally.
BODY_HEIGHT_MIN = 0.18  # crouched
BODY_HEIGHT_DEFAULT = 0.27
BODY_HEIGHT_MAX = 0.34  # tall

# Navigation tuning. NAV_KP scales speed by distance-to-target so the
# robot decelerates smoothly on approach. NAV_ARRIVAL_TOLERANCE is the
# distance at which we declare "arrived" and stop the goal.
NAV_SPEED = 0.4
NAV_KP = 0.5
NAV_ARRIVAL_TOLERANCE = 0.20
NAV_HEADING_TOLERANCE = 0.15  # rad — turn-then-drive threshold


class BridgeBase:
    """Interface every bridge implements. Async because the real one will be."""

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def get_state(self) -> RobotState: ...
    async def stand_up(self) -> bool: ...
    async def stand_down(self) -> bool: ...
    async def move(self, vx: float, vy: float, vyaw: float) -> bool: ...
    async def stop_move(self) -> bool: ...
    async def emergency_stop(self) -> bool: ...
    async def clear_estop(self) -> bool: ...
    async def look_at_entity(self, name: str) -> str: ...
    async def set_body_height(self, meters: float) -> bool: ...
    async def go_to_pose(self, x: float, y: float) -> bool: ...
    async def perform_gesture(self, name: str) -> bool: ...


class SimBridge(BridgeBase):
    """
    Behavioural simulator. No physics — just integrates commanded velocity
    into pose, drains battery slowly, and reports plausible state.

    If a `World` is supplied, the bridge populates `range_obstacle` and
    supports `look_at_entity(name)` with a tiny closed-loop yaw controller.
    Without a world, all proximity readings stay at PROXIMITY_MAX_RANGE
    and `look_at_entity` returns "no_world".
    """

    TICK_HZ = 50
    BATTERY_DRAIN_IDLE = 0.0001  # %/tick
    BATTERY_DRAIN_MOVING = 0.001

    def __init__(self, world: World | None = None) -> None:
        self._state = RobotState()
        self._connected = False
        self._tick_task: asyncio.Task | None = None
        self._world = world
        self._yaw_target: float | None = None  # set by look_at_entity, cleared on goal-reached or move()
        # Navigation goal — set by go_to_pose, cleared on arrival, halt,
        # estop, or any operator move() with nonzero velocity.
        self._nav_target: tuple[float, float] | None = None
        # Current region (world.region_at(robot pose), name or None). Used
        # to emit zone-change events the LLM/ambient can react to.
        self._current_region: str | None = None
        # Perception is its own module now. SimPerception cheats with
        # ground-truth from the World; a future RealPerception would
        # consume camera/lidar output. The bridge just calls .tick() and
        # exposes .recent_perceptions().
        self._perception: SimPerception | None = (
            SimPerception(world) if world is not None else None
        )
        # Local obstacle avoidance — a reactive steering reflex that bends
        # nav headings around solid obstacles the LLM's straight-line
        # waypoint would otherwise cross. Default on; disable with
        # SWEETIE_NAV_AVOIDANCE=off to get the old press-into-it behaviour.
        # See core/avoidance.py. Sim-only: RealBridge refuses nav entirely
        # until a real planner exists, so there's nothing to wrap there.
        self._avoidance = os.getenv("SWEETIE_NAV_AVOIDANCE", "on").lower() != "off"
        self._avoid_cfg = AvoidanceConfig()

    def _solid_obstacles(self) -> list[tuple[float, float, float]]:
        """(x, y, radius) for world objects that physically block motion.

        Passable terrain (slopes, gravel — `obstacle=False`) is excluded,
        same as `proximity_ranges`. Empty when there's no world.
        """
        if self._world is None:
            return []
        return [
            (o.x, o.y, o.radius) for o in self._world.objects if o.obstacle
        ]

    @property
    def world(self) -> World | None:
        return self._world

    async def connect(self) -> None:
        self._connected = True
        self._tick_task = asyncio.create_task(self._tick_loop())
        logger.info("SimBridge connected, ticking at %d Hz", self.TICK_HZ)

    async def disconnect(self) -> None:
        self._connected = False
        if self._tick_task:
            self._tick_task.cancel()
            try:
                await self._tick_task
            except asyncio.CancelledError:
                pass
        logger.info("SimBridge disconnected")

    async def get_state(self) -> RobotState:
        return self._state

    async def stand_up(self) -> bool:
        if self._state.mode == "estop":
            return False
        self._state.mode = "standing"
        self._state.body_height = 0.27
        return True

    async def stand_down(self) -> bool:
        if self._state.mode == "estop":
            return False
        self._state.mode = "down"
        self._state.body_height = 0.10
        self._state.vx = self._state.vy = self._state.vyaw = 0.0
        self._yaw_target = None
        return True

    async def move(self, vx: float, vy: float, vyaw: float) -> bool:
        if self._state.mode in ("estop", "down"):
            return False
        # An explicit move command always wins over an in-progress look_at
        # OR an in-progress nav goal — operator agency beats automation.
        self._yaw_target = None
        if any((vx, vy, vyaw)):
            self._nav_target = None
        # Clamp at the bridge as defense-in-depth.
        self._state.vx = clamp(vx, -VX_LIMIT, VX_LIMIT)
        self._state.vy = clamp(vy, -VY_LIMIT, VY_LIMIT)
        self._state.vyaw = clamp(vyaw, -VYAW_LIMIT, VYAW_LIMIT)
        self._state.mode = "moving" if any((vx, vy, vyaw)) else "standing"
        return True

    async def stop_move(self) -> bool:
        self._state.vx = self._state.vy = self._state.vyaw = 0.0
        self._yaw_target = None
        self._nav_target = None
        if self._state.mode == "moving":
            self._state.mode = "standing"
        return True

    async def emergency_stop(self) -> bool:
        self._state.vx = self._state.vy = self._state.vyaw = 0.0
        self._state.mode = "estop"
        self._yaw_target = None
        self._nav_target = None
        return True

    async def clear_estop(self) -> bool:
        if self._state.mode == "estop":
            self._state.mode = "down"
        return True

    async def plan_route(self, x: float, y: float):
        """Plan an obstacle-avoiding route from the current pose to (x, y) over
        the World, using the back-ported A* planner. Returns world-frame
        waypoints (suitable for follow_path) or None if no route / no world.
        Parity with RealBridge.plan_to so sim and hardware plan identically."""
        if self._world is None:
            return None
        from sweetie.core.sim_grid import grid_from_world
        from sweetie.core.planner import plan_path
        grid = grid_from_world(self._world)
        s = self._state
        return plan_path(grid, (s.x, s.y), (x, y))

    async def perform_gesture(self, name: str) -> bool:
        """Play an expressive gesture. In sim this is behavioural-only (no
        physics) — it succeeds for any known gesture while standing, so the
        cognition/dashboard path can be exercised exactly as on hardware."""
        from sweetie.core.gestures import resolve
        g = resolve(name)
        if g is None:
            return False
        if self._state.mode in ("estop", "down"):
            return False
        logger.info("SimBridge gesture: %s (%s)", name, g.desc)
        return True

    async def set_body_height(self, meters: float) -> bool:
        """Crouch or stand tall. Range clamped to [BODY_HEIGHT_MIN, BODY_HEIGHT_MAX].

        No-op when the robot is folded (`mode == "down"`) since body
        height in that state is dictated by the fold pose. Allowed in
        all other modes including ESTOP for honesty — though the robot
        is already on the floor in estop, so it's effectively a no-op
        there too.
        """
        if self._state.mode == "down":
            return False
        clamped = clamp(meters, BODY_HEIGHT_MIN, BODY_HEIGHT_MAX)
        self._state.body_height = clamped
        return True

    async def go_to_pose(self, x: float, y: float) -> bool:
        """Drive in a straight line toward (x, y) under safety, decelerating on approach.

        This is a *navigation goal*, not a hard command — the safety
        guard's proximity scaling still applies, so the robot will
        slow/stop near obstacles even mid-route. The goal is cleared on
        arrival, on `halt`, on `emergency_stop`, on any operator move
        with nonzero velocity, or by another `go_to_pose`.

        No global path-planning. A *local* obstacle-avoidance reflex
        (core/avoidance.py, default on; SWEETIE_NAV_AVOIDANCE=off to
        disable) bends the heading around solid obstacles the straight
        line would cross and slows for tight passes, with the safety
        guard's proximity scaling underneath. It handles isolated
        obstacles and passable fields; it can stall against a wall or in
        a concave pocket (no local detour exists), in which case the
        robot stops making progress and the LLM can choose a new target.
        It never drives *into* an obstacle.
        """
        if self._state.mode in ("estop", "down"):
            return False
        self._yaw_target = None  # nav owns yaw too
        self._nav_target = (float(x), float(y))
        self._state.mode = "moving"
        return True

    async def look_at_entity(self, name: str) -> str:
        """
        Aim the robot's body to face a named world object. Returns one of:
          'ok'         — yaw target set, controller will rotate toward it
          'no_world'   — no world is attached to this bridge
          'no_target'  — no object with that name exists
          'wrong_mode' — robot is folded down or in E-STOP

        The actual rotation happens in the tick loop; the controller stops
        when within YAW_GOAL_TOLERANCE.
        """
        if self._world is None:
            return "no_world"
        if self._state.mode in ("down", "estop"):
            return "wrong_mode"
        target = self._world.by_name(name)
        if target is None:
            return "no_target"
        s = self._state
        self._yaw_target = self._world.bearing_from(s.x, s.y, target)
        s.mode = "moving"
        return "ok"

    # ── Tick loop ────────────────────────────────────────────────────────────

    async def _tick_loop(self) -> None:
        dt = 1.0 / self.TICK_HZ
        while self._connected:
            try:
                await asyncio.sleep(dt)
                self._integrate(dt)
                # Forward fresh perception events to the bus so ambient
                # cognition (and any future subscribers) can react live.
                if self._perception is not None:
                    for event in self._perception.drain_new_events():
                        await bus.publish("perception", {"event": event})
                # Region transitions — emit a zone_changed event when
                # the robot crosses from one named region into another
                # (or out into the void).
                if self._world is not None:
                    s = self._state
                    region = self._world.region_at(s.x, s.y)
                    new_name = region.name if region is not None else None
                    if new_name != self._current_region:
                        old_name = self._current_region
                        self._current_region = new_name
                        await bus.publish("zone_changed", {
                            "from": old_name,
                            "to": new_name,
                        })
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("SimBridge tick error")

    def _integrate(self, dt: float) -> None:
        s = self._state
        s.timestamp = time.time()

        # If a yaw target is active, drive vyaw toward it. Translation is
        # zeroed during a look_at — we're rotating in place.
        if self._yaw_target is not None and s.mode != "estop":
            err = _wrap_pi(self._yaw_target - s.yaw)
            if abs(err) < YAW_GOAL_TOLERANCE:
                s.vyaw = 0.0
                self._yaw_target = None
                if s.mode == "moving":
                    s.mode = "standing"
            else:
                s.vx = 0.0
                s.vy = 0.0
                s.vyaw = clamp(YAW_KP * err, -VYAW_LIMIT, VYAW_LIMIT)

        # If a nav target is active, compute desired vx / vyaw to drive
        # toward it. Yaw target takes precedence (above) — they shouldn't
        # both be set in practice, but if they are, look_at wins this tick.
        elif self._nav_target is not None and s.mode != "estop":
            tx, ty = self._nav_target
            dx = tx - s.x
            dy = ty - s.y
            dist = math.hypot(dx, dy)
            if dist < NAV_ARRIVAL_TOLERANCE:
                # Arrived — clear goal and stop.
                self._nav_target = None
                s.vx = s.vy = s.vyaw = 0.0
                s.mode = "standing"
            else:
                # Local obstacle avoidance bends the heading around any
                # solid obstacle the straight line would cross, and may
                # recommend slowing so the turn lands in time. Falls back
                # to the straight bearing when disabled or the corridor is
                # clear. This is a reactive reflex *under* the LLM's
                # waypoint, not a planner — see core/avoidance.py.
                nav_speed_scale = 1.0
                if self._avoidance and self._world is not None:
                    res = avoid_steer(
                        s.x, s.y, tx, ty,
                        self._solid_obstacles(), self._avoid_cfg,
                    )
                    target_yaw = res.heading
                    nav_speed_scale = res.speed_scale
                else:
                    target_yaw = math.atan2(dy, dx)
                yaw_err = _wrap_pi(target_yaw - s.yaw)
                if abs(yaw_err) > NAV_HEADING_TOLERANCE:
                    # Turn toward target before driving forward.
                    s.vx = 0.0
                    s.vy = 0.0
                    s.vyaw = clamp(YAW_KP * yaw_err, -VYAW_LIMIT, VYAW_LIMIT)
                else:
                    # Drive forward, decelerating on approach. The
                    # avoidance speed scale (≤1) gives a tight turn time
                    # to complete; the safety guard's proximity scaling
                    # still applies on top, downstream.
                    speed = min(NAV_SPEED, NAV_KP * dist) * nav_speed_scale
                    s.vx = speed
                    s.vy = 0.0
                    # Gentle heading correction while driving.
                    s.vyaw = clamp(0.5 * yaw_err, -VYAW_LIMIT, VYAW_LIMIT)

        # Pose integration in world frame.
        cos_y, sin_y = math.cos(s.yaw), math.sin(s.yaw)
        s.x += (s.vx * cos_y - s.vy * sin_y) * dt
        s.y += (s.vx * sin_y + s.vy * cos_y) * dt
        s.yaw = _wrap_pi(s.yaw + s.vyaw * dt)

        # Advance moving world entities, then compute proximity from their
        # new positions. Order matters: we want the proximity reading the
        # operator gets to reflect the *current* world, not last frame's.
        # The Observer hands the robot's pose to reactive entities so they
        # can flee, yield, etc.
        if self._world is not None:
            self._world.tick(dt, observer=Observer(s.x, s.y, s.yaw))
            s.range_obstacle = self._world.proximity_ranges(s.x, s.y, s.yaw)
            if self._perception is not None:
                self._perception.tick(s.x, s.y, s.yaw)

        # Power.
        moving = any((s.vx, s.vy, s.vyaw))
        s.battery_percent = max(
            0.0,
            s.battery_percent
            - (self.BATTERY_DRAIN_MOVING if moving else self.BATTERY_DRAIN_IDLE),
        )

    # ── Perception delegation ──────────────────────────────────────────────
    #
    # The bridge owns the perception layer and exposes its results. In sim
    # this is SimPerception (ground-truth shortcut over the World); in
    # real hardware it would be a camera/lidar pipeline. The cognition
    # layer queries this same surface either way.

    def recent_perceptions(self, window_s: float = 30.0) -> list[dict]:
        """Return perception events from the last `window_s` seconds, newest last."""
        if self._perception is None:
            return []
        return self._perception.recent_events(window_s=window_s)

    def vision_summary(self) -> list[dict]:
        """Return entities currently visible through the forward camera (FOV + occlusion)."""
        if self._perception is None:
            return []
        s = self._state
        return self._perception.vision_summary(s.x, s.y, s.yaw)

    def current_region(self) -> str | None:
        """Name of the named region the robot is currently in, or None."""
        return self._current_region
