"""
Safety FSM.

Every command from the operator (joystick) or the LLM (intents) goes through
SafetyGuard.guard() before reaching the bridge. The guard either passes the
command (possibly with values clamped) or rejects it with a reason.

States:
    IDLE    — bridge connected, robot folded down, no commands accepted
              other than `stand_up` and `clear_estop`.
    ARMED   — operator pressed "arm". Stand-up allowed; movement still gated
              on heartbeat. This is the "I'm watching" state.
    ACTIVE  — receiving valid heartbeats, all motion commands allowed.
    ESTOP   — latched. Only `clear_estop` exits.

Transitions:
    IDLE   --arm-->        ARMED
    ARMED  --heartbeat-->  ACTIVE
    ACTIVE --no_heartbeat--> ARMED   (after HEARTBEAT_TIMEOUT_S)
    *      --estop-->      ESTOP
    ESTOP  --clear_estop--> IDLE

The FSM is intentionally tiny. If you want a real BT later, swap the guard
internals — the public surface (guard, arm, estop, etc.) doesn't change.
"""

from __future__ import annotations

import enum
import logging
import time
from collections import deque
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Limits — these are the "hard" envelope. The bridge clamps too, but most
# rejections should happen here so the operator sees a clear reason.
VX_LIMIT = 1.5
VY_LIMIT = 0.8
VYAW_LIMIT = 2.0

HEARTBEAT_TIMEOUT_S = 1.0
BATTERY_LOW_PERCENT = 15.0
TILT_LIMIT_RAD = 0.6  # ~34°

# Proximity-aware velocity scaling (M4 smart-assist).
#   range >= SLOWDOWN_START → no scaling, full velocity
#   range <= HARD_FLOOR     → axis zeroed; can't drive into the obstacle
#   in between              → linear scale-down
# Only the directional axis matching the commanded sign is scaled — driving
# *away* from a near obstacle is always allowed at full speed.
OBSTACLE_HARD_FLOOR = 0.3       # m
OBSTACLE_SLOWDOWN_START = 1.0   # m

# Recent assist events get logged here so report_status can surface them
# to the LLM. Capped — old events fall out the back of the deque.
ASSIST_LOG_MAX = 16
ASSIST_LOG_WINDOW_S = 30.0


class SafetyState(str, enum.Enum):
    IDLE = "idle"
    ARMED = "armed"
    ACTIVE = "active"
    ESTOP = "estop"


@dataclass
class GuardResult:
    allowed: bool
    reason: str = ""
    # If allowed and clamped, the resulting values:
    vx: float = 0.0
    vy: float = 0.0
    vyaw: float = 0.0
    # Smart-assist diagnostics: short human-readable strings describing
    # what the guard scaled or blocked, e.g. "slowed (front 0.45m)" or
    # "blocked (left 0.20m)". Empty when the guard didn't intervene.
    assists: list[str] = field(default_factory=list)


def _proximity_scale(range_m: float, side: str) -> tuple[float, str | None]:
    """
    Compute the velocity scale factor for an axis given the proximity
    reading on the side of the robot it's moving toward.

    Returns (scale, reason). reason is None if range is clear (scale=1.0).
    """
    if range_m >= OBSTACLE_SLOWDOWN_START:
        return 1.0, None
    if range_m <= OBSTACLE_HARD_FLOOR:
        return 0.0, f"blocked ({side} {range_m:.2f}m)"
    span = OBSTACLE_SLOWDOWN_START - OBSTACLE_HARD_FLOOR
    scale = (range_m - OBSTACLE_HARD_FLOOR) / span
    return scale, f"slowed ({side} {range_m:.2f}m)"


class SafetyGuard:
    """Single source of truth for whether a command is allowed right now."""

    def __init__(self) -> None:
        self.state = SafetyState.IDLE
        self._last_heartbeat: float = 0.0
        # Ring buffer of recent assist events: (timestamp, reason).
        # Surfaced to the LLM via report_status so it can answer
        # "why did I just slow down?" without ambient running.
        self._assist_log: deque[tuple[float, str]] = deque(maxlen=ASSIST_LOG_MAX)

    # ── State transitions ────────────────────────────────────────────────────

    def arm(self) -> bool:
        if self.state == SafetyState.ESTOP:
            return False
        if self.state == SafetyState.IDLE:
            self.state = SafetyState.ARMED
            logger.info("Safety: IDLE → ARMED")
        return True

    def heartbeat(self) -> None:
        """Operator UI calls this on every joystick frame / WS message."""
        self._last_heartbeat = time.monotonic()
        if self.state == SafetyState.ARMED:
            self.state = SafetyState.ACTIVE
            logger.info("Safety: ARMED → ACTIVE")

    def estop(self) -> None:
        prev = self.state
        self.state = SafetyState.ESTOP
        if prev != SafetyState.ESTOP:
            logger.warning("Safety: %s → ESTOP", prev.value)

    def clear_estop(self) -> bool:
        if self.state != SafetyState.ESTOP:
            return False
        self.state = SafetyState.IDLE
        self._last_heartbeat = 0.0
        logger.info("Safety: ESTOP → IDLE (cleared)")
        return True

    def disarm(self) -> None:
        if self.state in (SafetyState.ARMED, SafetyState.ACTIVE):
            self.state = SafetyState.IDLE
            self._last_heartbeat = 0.0
            logger.info("Safety: → IDLE (disarmed)")

    # ── Predicate maintenance ────────────────────────────────────────────────

    def tick(self, robot_state) -> None:
        """
        Called periodically by the server. Checks predicates and may
        transition ACTIVE→ARMED (heartbeat lost) or *→ESTOP (battery, tilt).
        """
        # Heartbeat timeout
        if self.state == SafetyState.ACTIVE:
            if time.monotonic() - self._last_heartbeat > HEARTBEAT_TIMEOUT_S:
                self.state = SafetyState.ARMED
                logger.warning("Safety: ACTIVE → ARMED (heartbeat lost)")

        # Hard estops
        if self.state != SafetyState.ESTOP:
            if robot_state.battery_percent < BATTERY_LOW_PERCENT:
                logger.warning("Safety: low battery → ESTOP")
                self.estop()
            elif (
                abs(robot_state.roll) > TILT_LIMIT_RAD
                or abs(robot_state.pitch) > TILT_LIMIT_RAD
            ):
                logger.warning("Safety: tilt limit → ESTOP")
                self.estop()

    # ── Command guard ────────────────────────────────────────────────────────

    def guard(
        self,
        vx: float,
        vy: float,
        vyaw: float,
        state=None,
    ) -> GuardResult:
        """
        Validate and clamp a movement command. The only path to motion.

        If `state` is supplied (a RobotState with `range_obstacle[4]`), the
        guard also applies M4 smart-assist proximity scaling: it slows or
        blocks motion in directions where an obstacle is too close.
        """
        if self.state == SafetyState.ESTOP:
            return GuardResult(False, "estop latched")
        if self.state == SafetyState.IDLE:
            return GuardResult(False, "not armed")
        if self.state == SafetyState.ARMED:
            return GuardResult(False, "no heartbeat (send heartbeat to ACTIVATE)")

        # ACTIVE — clamp to the absolute envelope first.
        cvx = max(-VX_LIMIT, min(VX_LIMIT, float(vx)))
        cvy = max(-VY_LIMIT, min(VY_LIMIT, float(vy)))
        cvyaw = max(-VYAW_LIMIT, min(VYAW_LIMIT, float(vyaw)))

        assists: list[str] = []

        # M4: proximity-aware scaling. Apply per-axis using the range on the
        # side the robot is moving toward. Driving away from a near obstacle
        # is unaffected (scale=1.0).
        if state is not None:
            ranges = state.range_obstacle  # [front, left, back, right]

            # Forward / backward → front (0) or back (2) range
            if cvx > 0:
                s, msg = _proximity_scale(ranges[0], "front")
                cvx *= s
                if msg:
                    assists.append(msg)
            elif cvx < 0:
                s, msg = _proximity_scale(ranges[2], "back")
                cvx *= s
                if msg:
                    assists.append(msg)

            # Strafe left/right → left (1) or right (3) range
            if cvy > 0:
                s, msg = _proximity_scale(ranges[1], "left")
                cvy *= s
                if msg:
                    assists.append(msg)
            elif cvy < 0:
                s, msg = _proximity_scale(ranges[3], "right")
                cvy *= s
                if msg:
                    assists.append(msg)

            # Yaw is intentionally not scaled. Rotating in place doesn't
            # close the distance to an obstacle in our model. (In a real
            # quadruped it sometimes does — sweep that under "M4 follow-up
            # if you actually see false-positive rotations getting hurt.")

        return GuardResult(True, "ok", cvx, cvy, cvyaw, assists)

    # ── Smart-assist log ────────────────────────────────────────────────────

    def record_assist(self, reason: str) -> None:
        """Log an assist event for later retrieval via recent_assists()."""
        self._assist_log.append((time.time(), reason))

    def recent_assists(self, window_s: float = ASSIST_LOG_WINDOW_S) -> list[dict]:
        """Return assist events from the last `window_s` seconds, newest last."""
        now = time.time()
        cutoff = now - window_s
        return [
            {"age_s": round(now - t, 1), "reason": r}
            for t, r in self._assist_log
            if t >= cutoff
        ]

    # ── Non-motion action guard ─────────────────────────────────────────────
    #
    # `guard()` is for velocity commands. For discrete actions like stand_up
    # or sit_down — typically issued by the LLM cognition layer — different
    # rules apply. Read-only actions are always allowed; physical actions
    # require the operator to have armed.
    #
    # Action policy:
    #   stand_up   — requires ARMED or ACTIVE (operator must be in the loop)
    #   sit_down   — requires ARMED or ACTIVE (folding down is still motion)
    #   halt       — allowed always (always safe to stop)
    #   report     — always allowed (read-only)

    READ_ONLY_ACTIONS = frozenset({"report"})
    ALWAYS_ACTIONS = frozenset({"halt"})  # allowed in any state (incl. ESTOP)
    ARMED_REQUIRED_ACTIONS = frozenset({"stand_up", "sit_down", "look_at"})

    def guard_action(self, action: str) -> GuardResult:
        """Decide whether a discrete action is permitted right now."""
        if action in self.READ_ONLY_ACTIONS:
            return GuardResult(True, "ok")
        if action in self.ALWAYS_ACTIONS:
            return GuardResult(True, "ok")
        if action in self.ARMED_REQUIRED_ACTIONS:
            if self.state == SafetyState.ESTOP:
                return GuardResult(False, "estop latched")
            if self.state == SafetyState.IDLE:
                return GuardResult(False, "not armed")
            return GuardResult(True, "ok")
        return GuardResult(False, f"unknown action {action!r}")

    def to_dict(self) -> dict:
        return {
            "state": self.state.value,
            "limits": {"vx": VX_LIMIT, "vy": VY_LIMIT, "vyaw": VYAW_LIMIT},
            "heartbeat_timeout_s": HEARTBEAT_TIMEOUT_S,
        }
