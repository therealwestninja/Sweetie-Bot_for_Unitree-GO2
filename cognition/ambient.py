"""
Ambient cognition.

Subscribes to the event bus and lets the LLM choose to comment on what's
happening in the simulation, even when the operator hasn't asked anything.
Strict cooldown prevents the LLM from spamming chat. Off by default;
enable with `SWEETIE_AMBIENT=on`.

What ambient does NOT do:
- Take any actions. The LLM in ambient mode has no tools — it can only
  produce text or stay silent.
- React to its own intents. The `intent` bus topic carries the LLM's
  own action attempts; ambient ignores those to avoid feedback loops.
- Override the operator. Ambient comments are just chat lines; the
  operator can ignore, mute (by disabling ambient), or keep going.

Triggering events:
- `assist`: the safety guard intervened (slowed/blocked motion).
- `perception`: a dynamic entity changed quadrant in interesting ways
  (entered/left range, stepped into the front quadrant).

If you find ambient too chatty for your taste, raise `cooldown_s` or
narrow the subscribed topics in `attach()`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from sweetie.cognition.llm import Cognition
from sweetie.core.bus import bus

logger = logging.getLogger(__name__)


class AmbientCognition:
    """
    Bus-event-driven wrapper around `Cognition.ambient_react`.

    Holds a monotonic cooldown timer (no two ambient utterances closer
    than `cooldown_s` apart) and an asyncio lock (only one ambient call
    in flight at a time). Either restriction means the event is dropped
    silently — ambient is best-effort, not guaranteed.
    """

    DEFAULT_COOLDOWN_S = 20.0

    def __init__(
        self,
        cog: Cognition,
        cooldown_s: float = DEFAULT_COOLDOWN_S,
    ) -> None:
        self._cog = cog
        self._cooldown_s = cooldown_s
        self._last_utterance: float = 0.0  # monotonic seconds
        self._lock = asyncio.Lock()
        self._attached = False

    def attach(self) -> None:
        """Subscribe to the bus topics that should trigger ambient cognition."""
        if self._attached:
            return
        bus.subscribe("assist", self._on_assist)
        bus.subscribe("perception", self._on_perception)
        bus.subscribe("zone_changed", self._on_zone_changed)
        self._attached = True
        logger.info(
            "AmbientCognition attached (cooldown=%.0fs)", self._cooldown_s
        )

    # ── Bus handlers ────────────────────────────────────────────────────────

    async def _on_assist(self, payload: dict[str, Any]) -> None:
        events = payload.get("events", [])
        if not events:
            return
        # Combine multiple simultaneous assists into one observation.
        observation = "Smart-assist intervened: " + "; ".join(events) + "."
        await self._maybe_react(observation)

    async def _on_perception(self, payload: dict[str, Any]) -> None:
        event = payload.get("event", "").strip()
        if not event:
            return
        await self._maybe_react(f"Just noticed: {event}.")

    async def _on_zone_changed(self, payload: dict[str, Any]) -> None:
        old = payload.get("from") or "(nowhere)"
        new = payload.get("to") or "(nowhere)"
        await self._maybe_react(
            f"The robot just crossed from {old} into {new}."
        )

    # ── Decision and dispatch ───────────────────────────────────────────────

    async def _maybe_react(self, observation: str) -> None:
        """Apply cooldown + lock; if both clear, ask the LLM to react."""
        now = time.monotonic()
        if now - self._last_utterance < self._cooldown_s:
            return
        if self._lock.locked():
            return
        async with self._lock:
            # Re-check cooldown inside the lock — another concurrent call
            # might have just spoken between our outer check and acquire.
            if time.monotonic() - self._last_utterance < self._cooldown_s:
                return
            text = await self._cog.ambient_react(observation)
            if text:
                # Reset cooldown only when we *actually* speak. If the LLM
                # decided '(silent)', leave the budget alone — the next
                # event is still eligible immediately.
                self._last_utterance = time.monotonic()
                await bus.publish("ambient", {"text": text})
                logger.info("ambient: %s", text)
