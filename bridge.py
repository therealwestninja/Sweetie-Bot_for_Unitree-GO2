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
import time
from collections import deque
from dataclasses import dataclass, field

from sweetie.sim.world import PROXIMITY_MAX_RANGE, World

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


def _wrap_pi(angle: float) -> float:
    """Wrap an angle to [-pi, pi]."""
    return ((angle + math.pi) % (2 * math.pi)) - math.pi


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

    # Range beyond which an entity is considered "out of perceptual range"
    # for the purposes of perception events. Slightly bigger than the
    # proximity sensor max range to avoid flapping at the edge.
    PERCEPTION_RANGE = 4.0  # m

    def __init__(self, world: World | None = None) -> None:
        self._state = RobotState()
        self._connected = False
        self._tick_task: asyncio.Task | None = None
        self._world = world
        self._yaw_target: float | None = None  # set by look_at_entity, cleared on goal-reached or move()
        # Perception state — tracked per dynamic entity so we can emit
        # events on quadrant transitions. Real hardware would replace
        # this with output from a vision pipeline; for sim we cheat with
        # ground-truth positions.
        self._entity_quadrant: dict[str, str] = {}
        self._perception_log: deque[tuple[float, str]] = deque(maxlen=20)

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
        # An explicit move command always wins over an in-progress look_at.
        self._yaw_target = None
        # Clamp at the bridge as defense-in-depth.
        self._state.vx = max(-VX_LIMIT, min(VX_LIMIT, vx))
        self._state.vy = max(-VY_LIMIT, min(VY_LIMIT, vy))
        self._state.vyaw = max(-VYAW_LIMIT, min(VYAW_LIMIT, vyaw))
        self._state.mode = "moving" if any((vx, vy, vyaw)) else "standing"
        return True

    async def stop_move(self) -> bool:
        self._state.vx = self._state.vy = self._state.vyaw = 0.0
        self._yaw_target = None
        if self._state.mode == "moving":
            self._state.mode = "standing"
        return True

    async def emergency_stop(self) -> bool:
        self._state.vx = self._state.vy = self._state.vyaw = 0.0
        self._state.mode = "estop"
        self._yaw_target = None
        return True

    async def clear_estop(self) -> bool:
        if self._state.mode == "estop":
            self._state.mode = "down"
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
                s.vyaw = max(-VYAW_LIMIT, min(VYAW_LIMIT, YAW_KP * err))

        # Pose integration in world frame.
        cos_y, sin_y = math.cos(s.yaw), math.sin(s.yaw)
        s.x += (s.vx * cos_y - s.vy * sin_y) * dt
        s.y += (s.vx * sin_y + s.vy * cos_y) * dt
        s.yaw = _wrap_pi(s.yaw + s.vyaw * dt)

        # Advance moving world entities, then compute proximity from their
        # new positions. Order matters: we want the proximity reading the
        # operator gets to reflect the *current* world, not last frame's.
        if self._world is not None:
            self._world.tick(dt)
            s.range_obstacle = self._world.proximity_ranges(s.x, s.y, s.yaw)
            self._update_perceptions()

        # Power.
        moving = any((s.vx, s.vy, s.vyaw))
        s.battery_percent = max(
            0.0,
            s.battery_percent
            - (self.BATTERY_DRAIN_MOVING if moving else self.BATTERY_DRAIN_IDLE),
        )

    # ── Perception (sim-only, ground-truth shortcut) ────────────────────────
    #
    # In real hardware this would be a vision/lidar pipeline producing
    # entity-tracking events. For sim we just read positions out of the
    # world and emit events on quadrant transitions. The seam here is
    # `recent_perceptions()` — the LLM gets the same shape regardless of
    # how the events were derived.

    def _classify_quadrant(self, ox: float, oy: float) -> str:
        """Return 'front'|'left'|'back'|'right'|'far' for a world-frame point."""
        s = self._state
        dx, dy = ox - s.x, oy - s.y
        dist = math.hypot(dx, dy)
        if dist > self.PERCEPTION_RANGE:
            return "far"
        cy, sy = math.cos(-s.yaw), math.sin(-s.yaw)
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

    def _update_perceptions(self) -> None:
        """Track quadrant transitions for dynamic entities; log meaningful ones."""
        if self._world is None:
            return
        now = time.time()
        for obj in self._world.objects:
            if not obj.dynamic:
                continue
            new_q = self._classify_quadrant(obj.x, obj.y)
            old_q = self._entity_quadrant.get(obj.name)
            if new_q == old_q:
                continue
            self._entity_quadrant[obj.name] = new_q
            # Only log "interesting" transitions — entry/exit from range,
            # and arrivals into the front quadrant (the most safety-relevant).
            # Other transitions (back → left, left → right, etc.) are noise.
            if old_q is None:
                # First observation; note the initial location only if in range.
                if new_q != "far":
                    self._perception_log.append(
                        (now, f"{obj.name} initially in {new_q} quadrant")
                    )
            elif old_q == "far" and new_q != "far":
                self._perception_log.append(
                    (now, f"{obj.name} entered range ({new_q})")
                )
            elif old_q != "far" and new_q == "far":
                self._perception_log.append(
                    (now, f"{obj.name} left visible range")
                )
            elif new_q == "front" and old_q in ("left", "right"):
                self._perception_log.append(
                    (now, f"{obj.name} now directly in front")
                )

    def recent_perceptions(self, window_s: float = 30.0) -> list[dict]:
        """Return perception events from the last `window_s` seconds, newest last."""
        now = time.time()
        cutoff = now - window_s
        return [
            {"age_s": round(now - t, 1), "event": e}
            for t, e in self._perception_log
            if t >= cutoff
        ]
