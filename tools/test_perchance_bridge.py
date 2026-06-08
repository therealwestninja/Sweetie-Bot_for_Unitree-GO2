"""Perchance fallback: broker round-trip + cognition chat() fallback."""

from __future__ import annotations

import asyncio

import pytest

from sweetie.core.perchance_bridge import PerchanceBridge


@pytest.mark.asyncio
async def test_submit_poll_complete_roundtrip():
    b = PerchanceBridge()
    b._last_poll = asyncio.get_event_loop().time()  # mark a consumer online

    async def consumer():
        job = await b.poll(wait=2.0)
        assert job is not None
        b.complete(job["id"], "hi from perchance")

    task = asyncio.create_task(consumer())
    text = await b.submit("say hi", timeout=2.0)
    await task
    assert text == "hi from perchance"


@pytest.mark.asyncio
async def test_submit_returns_none_when_no_consumer_online():
    b = PerchanceBridge()
    # _last_poll defaults to 0 -> offline -> instant None (no waiting)
    assert await b.submit("anything", timeout=5.0) is None


@pytest.mark.asyncio
async def test_submit_times_out_when_no_completion():
    b = PerchanceBridge(consumer_ttl=1000.0)
    b._last_poll = asyncio.get_event_loop().time()
    # mark online but never poll/complete -> times out -> None
    assert await b.submit("hello", timeout=0.2) is None


@pytest.mark.asyncio
async def test_fail_unblocks_submit_with_none():
    b = PerchanceBridge()
    b._last_poll = asyncio.get_event_loop().time()

    async def consumer():
        job = await b.poll(wait=2.0)
        b.fail(job["id"], "plugin error")

    task = asyncio.create_task(consumer())
    text = await b.submit("x", timeout=2.0)
    await task
    assert text is None


# ── cognition uses the fallback when there's no Anthropic client ─────────────


class _FakeBridge:
    """Stand-in PerchanceBridge that always returns a fixed line."""
    def __init__(self, reply):
        self.reply = reply
        self.prompts = []

    async def submit(self, prompt, timeout=None):
        self.prompts.append(prompt)
        return self.reply


@pytest.mark.asyncio
async def test_chat_uses_perchance_when_no_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from sweetie.core.bridge import SimBridge
    from sweetie.core.safety import SafetyGuard
    from sweetie.cognition.llm import Cognition
    from sweetie.sim.world import World

    fake = _FakeBridge("purr — hello!")
    cog = Cognition(SimBridge(World([])), SafetyGuard(), world=World([]), perchance=fake)
    reply = await cog.chat("hi sweetie")
    assert reply == "purr — hello!"
    assert fake.prompts and "hi sweetie" in fake.prompts[0]


@pytest.mark.asyncio
async def test_chat_falls_back_to_canned_when_perchance_empty(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from sweetie.core.bridge import SimBridge
    from sweetie.core.safety import SafetyGuard
    from sweetie.cognition.llm import Cognition
    from sweetie.sim.world import World

    cog = Cognition(SimBridge(World([])), SafetyGuard(), world=World([]),
                    perchance=_FakeBridge(None))
    reply = await cog.chat("hi")
    assert "no API key" in reply
