"""
Tiny async pub/sub bus.

Intentionally trivial. If you outgrow this, swap in nats / redis / whatever.
For M1 it just lets the cognition layer publish "speak" events that the
WebSocket layer forwards to the browser, without those two layers knowing
about each other.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], Awaitable[None]]


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = defaultdict(list)

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._subs[topic].append(handler)

    def unsubscribe(self, topic: str, handler: Handler) -> None:
        if handler in self._subs[topic]:
            self._subs[topic].remove(handler)

    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        for h in list(self._subs[topic]):
            try:
                await h(payload)
            except Exception:
                logger.exception("Bus handler error on topic %s", topic)


bus = EventBus()  # process-wide singleton; fine for an MVP
