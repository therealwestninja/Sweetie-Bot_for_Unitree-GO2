"""
Perchance fallback bridge.

When no Anthropic key is configured (or as a deliberate offline mode), Sweetie's
conversational replies can be served by a free Perchance-hosted text AI instead
of canned strings. The Go2 stack is Python; Perchance's `aiTextPlugin` lives in
a browser. This module is the broker between them:

    cognition.chat()  --submit(prompt)-->  PerchanceBridge  <--poll()/complete()--  userscript
                                                                  (Perchance tab)

A Tampermonkey/Violentmonkey userscript (see `userscripts/`) runs on a Perchance
generator page, long-polls this broker for a pending prompt, runs it through the
page's `aiTextPlugin`, and posts the completion back. The broker resolves the
awaiting `submit()` call.

Design choices:
  * `submit()` returns None *immediately* when no userscript has polled recently,
    so the no-fallback path stays fast (callers degrade to canned replies) and
    the bridge can be on by default without slowing anything when unused.
  * No tool-calling: Perchance does plain text generation, so this backs the
    conversational reply only — autonomy/tool turns stay on Anthropic.
"""

from __future__ import annotations

import asyncio
import itertools
import time

CONSUMER_TTL_S = 15.0      # a userscript is "online" if it polled within this
DEFAULT_TIMEOUT_S = 45.0   # how long submit() waits for a completion


class PerchanceBridge:
    def __init__(self, *, default_timeout: float = DEFAULT_TIMEOUT_S,
                consumer_ttl: float = CONSUMER_TTL_S) -> None:
        self._queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self.default_timeout = default_timeout
        self.consumer_ttl = consumer_ttl
        self._last_poll = 0.0

    @property
    def consumer_online(self) -> bool:
        """True if a userscript has polled within the TTL window."""
        return (time.monotonic() - self._last_poll) < self.consumer_ttl

    async def submit(self, prompt: str, timeout: float | None = None) -> str | None:
        """Enqueue a prompt for the Perchance tab and await its completion.

        Returns the generated text, or None if no consumer is online or the
        wait times out. Never raises on timeout/absence — callers fall back."""
        if not self.consumer_online:
            return None
        rid = str(next(self._ids))
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        await self._queue.put((rid, prompt))
        try:
            text = await asyncio.wait_for(fut, timeout or self.default_timeout)
            return text
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            return None

    async def poll(self, wait: float = 25.0) -> dict | None:
        """Userscript long-poll: return the next {id, prompt} or None on idle."""
        self._last_poll = time.monotonic()
        try:
            rid, prompt = await asyncio.wait_for(self._queue.get(), wait)
        except asyncio.TimeoutError:
            return None
        return {"id": rid, "prompt": prompt}

    def complete(self, rid: str, text: str) -> bool:
        """Userscript posts a completion; resolve the awaiting submit()."""
        fut = self._pending.pop(rid, None)
        if fut is not None and not fut.done():
            fut.set_result(text)
            return True
        return False

    def fail(self, rid: str, reason: str = "error") -> bool:
        """Userscript reports a failure; unblock submit() with None."""
        fut = self._pending.pop(rid, None)
        if fut is not None and not fut.done():
            fut.set_result(None)
            return True
        return False

    def status(self) -> dict:
        return {
            "consumer_online": self.consumer_online,
            "pending": len(self._pending),
            "queued": self._queue.qsize(),
        }


# Module-level singleton shared by the server routes and the cognition layer
# (mirrors how `core.bus` is shared). Tests construct their own instance.
perchance_bridge = PerchanceBridge()
