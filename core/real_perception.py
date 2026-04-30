"""
Real-hardware perception layer.

UNVERIFIED on real hardware. Built against the documented `LowState`
schema (`range_obstacle: float[4]` — front, left, back, right) but
not runtime-tested against a Go2.

What it does:
- Watches the bridge's range_obstacle proximity readings each tick.
- Tracks per-quadrant near/far membership.
- Emits transition events when an obstacle enters/leaves a quadrant.

What it deliberately does NOT do (yet):
- Semantic identification — there's no on-board ML model in our stack.
  An entity is "an obstacle in the front quadrant", never "the cat".
- Camera frame ingestion — depth from RealSense is published but we
  don't decode it. `vision_summary()` returns [] honestly.
- Tracking across frames — events are quadrant-membership only, no
  identity persistence.

Architectural seam: same `PerceptionBase` surface as `SimPerception`,
so the bridge, cognition, ambient layer, and operator UI all consume
this exactly the way they consume sim perception. When a real-camera
detector eventually ships, it slots in here behind the same surface.
"""

from __future__ import annotations

import logging
import time
from collections import deque

from sweetie.core.perception import PerceptionBase

logger = logging.getLogger(__name__)


# Distance threshold (meters) below which an obstacle is considered
# "near" in a quadrant. Above this, the quadrant is "clear". Tuned
# loosely for the Go2 — most close-encounter scenarios put obstacles
# under 2 m. Configurable per-instance for site-specific tuning.
DEFAULT_NEAR_THRESHOLD_M = 2.0

# Hysteresis band: an obstacle must move from <= NEAR to > NEAR + HYST
# before we declare it "left". Without hysteresis, a stationary
# obstacle sitting right at the threshold would flap and spam events.
DEFAULT_HYSTERESIS_M = 0.30

EVENT_LOG_MAX = 20

_QUADRANT_NAMES = ("front", "left", "back", "right")


class RealPerception(PerceptionBase):
    """
    Perception derived from `LowState.range_obstacle` over time.

    Maintains per-quadrant near/far state with hysteresis and emits
    transition events. The same shape SimPerception emits, so the
    bridge / cognition / ambient layers don't care which is running.

    UNVERIFIED on real hardware — built against the documented
    LowState schema but not tested against an actual Go2.
    """

    def __init__(
        self,
        near_threshold_m: float = DEFAULT_NEAR_THRESHOLD_M,
        hysteresis_m: float = DEFAULT_HYSTERESIS_M,
    ) -> None:
        self._near_threshold = float(near_threshold_m)
        self._hysteresis = float(hysteresis_m)
        # Per-quadrant near state — None until first reading.
        self._quad_near: list[bool | None] = [None, None, None, None]
        self._event_log: deque[tuple[float, str]] = deque(maxlen=EVENT_LOG_MAX)
        # Buffer of new events for bus forwarding (drained each tick).
        self._new_events: list[str] = []

    # ── PerceptionBase ─────────────────────────────────────────────────────

    def tick(
        self,
        robot_x: float,
        robot_y: float,
        robot_yaw: float,
        range_obstacle: tuple[float, float, float, float] | None = None,
    ) -> None:
        # `range_obstacle` is required for real perception. The bridge
        # always supplies it; if a caller forgets, we silently no-op
        # rather than crash.
        if range_obstacle is None or len(range_obstacle) != 4:
            return
        now = time.time()
        for i, name in enumerate(_QUADRANT_NAMES):
            d = float(range_obstacle[i])
            old = self._quad_near[i]
            if old is None:
                # First reading establishes baseline — only log if near.
                new_near = d <= self._near_threshold
                self._quad_near[i] = new_near
                if new_near:
                    ev = f"obstacle in {name} quadrant ({d:.1f} m)"
                    self._event_log.append((now, ev))
                    self._new_events.append(ev)
                continue

            # Hysteresis: different threshold to flip from near→far.
            if old:
                # Currently near — check if cleared past the hysteresis band.
                if d > self._near_threshold + self._hysteresis:
                    self._quad_near[i] = False
                    ev = f"{name} quadrant cleared"
                    self._event_log.append((now, ev))
                    self._new_events.append(ev)
            else:
                # Currently far — check if entered.
                if d <= self._near_threshold:
                    self._quad_near[i] = True
                    ev = f"obstacle entered {name} quadrant ({d:.1f} m)"
                    self._event_log.append((now, ev))
                    self._new_events.append(ev)

    def recent_events(self, window_s: float = 30.0) -> list[dict]:
        now = time.time()
        cutoff = now - window_s
        return [
            {"age_s": round(now - t, 1), "event": e}
            for t, e in self._event_log
            if t >= cutoff
        ]

    def drain_new_events(self) -> list[str]:
        out = self._new_events
        self._new_events = []
        return out

    def vision_summary(
        self, robot_x: float, robot_y: float, robot_yaw: float,
    ) -> list[dict]:
        # No semantic vision pipeline on real hardware in our stack yet.
        # When a real detector lands (camera frames + on-board model or
        # external service), it produces named entities here. Until
        # then, return empty rather than fabricate.
        return []
