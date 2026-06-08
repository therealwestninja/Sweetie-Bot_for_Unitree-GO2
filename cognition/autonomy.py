"""
Autonomy orchestrator — sweetie's primary cognition loop.

This is the thing that decides *when* to consult Claude. It does not
decide *what* to do — that's `Cognition.autonomy_tick`, which runs the
LLM with full tool access. The orchestrator's only job is scheduling:
turn bus events and the passage of time into `autonomy_tick(trigger)`
calls, without thrashing the model (and the API bill).

Two trigger sources, both funnelled through one cooldown + one lock:

1. **Bus events.** Perception transitions, smart-assist interventions,
   and region changes each schedule a tick. "Something happened —
   reconsider if it matters."
2. **Idle ticks.** Every `idle_interval_s`, a tick fires with trigger
   ``"idle"``. This is what makes sweetie autonomous rather than merely
   reactive: she keeps initiative even when nothing external happens.

Relationship to `AmbientCognition` (cognition/ambient.py): ambient was
the older, text-only path (the LLM could only comment, never act).
Autonomy supersedes it — same cooldown/lock discipline, but full tool
access and an idle ticker. Run one or the other, not both.

-----------------------------------------------------------------------
Urgency tiering
-----------------------------------------------------------------------
Not every trigger deserves the same latency. A region change is
informational; smart-assist slamming on the brakes because something is
danger-close in the direction of travel is "react NOW." A single flat
cooldown forces both to wait the same ~8 s, which means a safety-relevant
event arriving just after an idle tick sits unhandled for almost the
whole cooldown.

So triggers are split into two tiers:

- **NORMAL** — idle ticks, region changes, "something moved / left /
  cleared" perceptions. Gated by the full `cooldown_s`. This is the
  anti-spam budget that keeps per-session API usage bounded.
- **URGENT** — smart-assist interventions, and perceptions that mean
  something just got *closer* (entered a quadrant, stepped in front,
  came into view). These **bypass the cooldown** and fire as soon as
  the in-flight tick (if any) finishes, subject only to a small hard
  floor (`urgent_min_gap_s`) so even a storm of urgent events can't
  truly spam the model.

The pattern is borrowed directly from the Float Knights bot AI, whose
bots hold a freshly-chosen behaviour state for a commit window
(`botDecisionCommitFrames`) to stop flip-flop jitter, but let genuine
emergencies — taking a hit, the target dying, an incoming projectile in
the threat bubble — interrupt that hold immediately
(`_isEmergencyInterrupt`). Same idea, different timescale: the cooldown
is sweetie's commit window; safety-relevant perception/assist events are
her emergency interrupts. (Float Knights' bots model the same Go2 this
runs on, so the mapping is one-to-one rather than analogical.)

Misclassification is safe by construction: urgency only ever *lowers*
latency. Treating an urgent event as normal just makes it wait for the
cooldown — i.e., the old behaviour, no regression. Treating a normal
event as urgent at worst spends one extra tick. The floor caps the
downside either way.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from sweetie.cognition.llm import Cognition
from sweetie.core.bus import bus

logger = logging.getLogger(__name__)


# Substrings that mark a perception event as URGENT — something got
# closer or appeared, as opposed to leaving/clearing. Matched
# case-insensitively against the event text. Deliberately tolerant: the
# sim and real perception layers phrase events slightly differently
# ("obstacle entered front quadrant", "X stepped into front", "X came
# into view"), and the cost of a near-miss here is only one cooldown of
# latency, never a dropped event.
_URGENT_PERCEPTION_HINTS: tuple[str, ...] = (
    "entered",
    "into front",
    "in front",
    "front quadrant",
    "into view",
    "came into view",
    "approaching",
)

# Conversely, these mark a perception as definitely NOT urgent even if
# it happens to contain an urgent-looking word ("left the front
# quadrant" contains "front quadrant" but is a recession). Checked first.
_DEESCALATION_HINTS: tuple[str, ...] = (
    "cleared",
    "left",
    "out of view",
    "receding",
    "no longer",
)


class Autonomy:
    """
    Bus-event + idle-timer driven scheduler for `Cognition.autonomy_tick`.

    Holds a monotonic cooldown timer (no two *normal* ticks closer than
    `cooldown_s`) and an asyncio lock (only one tick in flight at a
    time). When either gate blocks a normal trigger, the trigger is
    dropped silently — autonomy is best-effort, not a queue. Urgent
    triggers skip the cooldown gate but still respect the lock and a
    small hard floor.

    Interface (consumed by teleop/server.py):
        Autonomy(cog, idle_interval_s=..., cooldown_s=...)
        .attach()        # sync: subscribe to bus + start idle ticker
        await .detach()  # async, idempotent: stop ticker + unsubscribe
    """

    DEFAULT_IDLE_INTERVAL_S = 15.0
    DEFAULT_COOLDOWN_S = 8.0
    # Hard floor between *any* two ticks, including urgent ones. Stops a
    # burst of assist/perception events from firing back-to-back LLM
    # calls. Small enough that "react now" still feels immediate.
    DEFAULT_URGENT_MIN_GAP_S = 1.5

    def __init__(
        self,
        cog: Cognition,
        idle_interval_s: float = DEFAULT_IDLE_INTERVAL_S,
        cooldown_s: float = DEFAULT_COOLDOWN_S,
        urgent_min_gap_s: float = DEFAULT_URGENT_MIN_GAP_S,
    ) -> None:
        self._cog = cog
        self._idle_interval_s = max(0.0, idle_interval_s)
        self._cooldown_s = max(0.0, cooldown_s)
        # The urgent floor can never exceed the normal cooldown — if a
        # caller sets a tiny cooldown, urgent shouldn't be *slower* than
        # normal.
        self._urgent_min_gap_s = max(0.0, min(urgent_min_gap_s, self._cooldown_s))

        self._last_tick: float = 0.0  # monotonic seconds, set on tick start
        self._lock = asyncio.Lock()
        self._idle_task: asyncio.Task | None = None
        self._attached = False

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def attach(self) -> None:
        """Subscribe to trigger topics and start the idle ticker.

        Synchronous so it can be called from FastAPI's lifespan setup
        without awaiting. Idempotent.
        """
        if self._attached:
            return
        bus.subscribe("perception", self._on_perception)
        bus.subscribe("assist", self._on_assist)
        bus.subscribe("zone_changed", self._on_zone_changed)
        self._attached = True
        if self._idle_interval_s > 0:
            self._idle_task = asyncio.create_task(self._idle_loop())
        logger.info(
            "Autonomy attached (idle=%.0fs, cooldown=%.0fs, urgent_floor=%.1fs)",
            self._idle_interval_s, self._cooldown_s, self._urgent_min_gap_s,
        )

    async def detach(self) -> None:
        """Stop the idle ticker and unsubscribe. Idempotent.

        Awaits the idle task's cancellation so no tick can fire while the
        caller (server `_end_session`) writes the episode summary.
        """
        if not self._attached:
            return
        self._attached = False
        bus.unsubscribe("perception", self._on_perception)
        bus.unsubscribe("assist", self._on_assist)
        bus.unsubscribe("zone_changed", self._on_zone_changed)
        if self._idle_task is not None:
            self._idle_task.cancel()
            try:
                await self._idle_task
            except asyncio.CancelledError:
                pass
            self._idle_task = None
        logger.info("Autonomy detached")

    # ── Bus handlers ──────────────────────────────────────────────────────────

    async def _on_perception(self, payload: dict[str, Any]) -> None:
        event = str(payload.get("event", "")).strip()
        if not event:
            return
        await self._fire(f"perception:{event}", urgent=_perception_is_urgent(event))

    async def _on_assist(self, payload: dict[str, Any]) -> None:
        events = payload.get("events", [])
        if not events:
            return
        # Smart-assist firing means the safety layer slowed or blocked
        # motion — always worth reconsidering immediately.
        joined = "; ".join(str(e) for e in events)
        await self._fire(f"assist:{joined}", urgent=True)

    async def _on_zone_changed(self, payload: dict[str, Any]) -> None:
        old = payload.get("from") or "(nowhere)"
        new = payload.get("to") or "(nowhere)"
        # Crossing a region boundary is context, not an emergency.
        await self._fire(f"zone:{old}→{new}", urgent=False)

    # ── Idle ticker ────────────────────────────────────────────────────────────

    async def _idle_loop(self) -> None:
        """Fire a normal `idle` tick every `idle_interval_s`."""
        try:
            while True:
                await asyncio.sleep(self._idle_interval_s)
                await self._fire("idle", urgent=False)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Autonomy idle loop crashed")

    # ── Gating + dispatch ───────────────────────────────────────────────────────

    async def _fire(self, trigger: str, *, urgent: bool) -> None:
        """Apply the cooldown/floor gate + lock, then run one tick.

        NORMAL triggers wait out the full cooldown. URGENT triggers skip
        the cooldown but still honour the hard floor and never stack on
        top of an in-flight tick.
        """
        gap = self._urgent_min_gap_s if urgent else self._cooldown_s
        now = time.monotonic()
        if now - self._last_tick < gap:
            return
        # Don't pile up behind an in-flight tick. An urgent event that
        # arrives mid-tick is dropped here, but the very next tick the
        # LLM runs will see the fresh perception/assist state anyway
        # (it's all in report_status / recent_perceptions), so the
        # reaction isn't lost — just folded into the next decision.
        if self._lock.locked():
            return
        async with self._lock:
            # Re-check inside the lock: a concurrent trigger may have
            # ticked between our outer check and acquiring the lock.
            if time.monotonic() - self._last_tick < gap:
                return
            # Stamp the tick start (not completion) so a long LLM call
            # doesn't let a backlog of events all fire the instant it
            # returns.
            self._last_tick = time.monotonic()
            try:
                await self._cog.autonomy_tick(trigger)
            except Exception:
                # autonomy_tick already guards its own LLM call, but the
                # orchestrator must never let one bad tick kill the loop.
                logger.exception("Autonomy tick failed (trigger=%s)", trigger)


def _perception_is_urgent(event: str) -> bool:
    """Classify a perception event string as urgent (got closer/appeared).

    De-escalation hints win over urgent hints so "left the front
    quadrant" is correctly treated as non-urgent despite containing
    "front quadrant".
    """
    text = event.lower()
    if any(h in text for h in _DEESCALATION_HINTS):
        return False
    return any(h in text for h in _URGENT_PERCEPTION_HINTS)
