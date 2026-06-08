"""
Tests for the autonomy orchestrator (sweetie/cognition/autonomy.py).

Covers the scheduling contract — urgency tiering, cooldown gating, the
single-tick lock, the idle ticker, and attach/detach idempotency — using
a fake Cognition so no LLM or bridge is involved. Runs under
`asyncio_mode = "auto"` (see pyproject), so test coroutines need no
decorator.

The orchestrator decides *when* to think; `Cognition.autonomy_tick`
decides *what* to do. These tests only exercise the former.
"""

from __future__ import annotations

import asyncio

import pytest

from sweetie.cognition.autonomy import Autonomy, _perception_is_urgent
from sweetie.core.bus import bus


class FakeCog:
    """Stand-in for Cognition: records triggers, can simulate a slow tick."""

    def __init__(self, delay: float = 0.0) -> None:
        self.triggers: list[str] = []
        self.delay = delay
        self._in_flight = 0
        self.max_in_flight = 0

    async def autonomy_tick(self, trigger: str) -> None:
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        self.triggers.append(trigger)
        if self.delay:
            await asyncio.sleep(self.delay)
        self._in_flight -= 1


@pytest.fixture
async def attached():
    """Yield a factory that attaches an Autonomy and tears it down after."""
    created: list[Autonomy] = []

    def _make(cog, **kw) -> Autonomy:
        a = Autonomy(cog, **kw)
        a.attach()
        created.append(a)
        return a

    yield _make
    for a in created:
        await a.detach()


# ── Perception urgency classifier ───────────────────────────────────────────

@pytest.mark.parametrize("event", [
    "obstacle entered front quadrant (0.5 m)",
    "the cat came into view",
    "something stepped into front",
    "person approaching",
])
def test_classifier_urgent(event):
    assert _perception_is_urgent(event) is True


@pytest.mark.parametrize("event", [
    "front quadrant cleared",
    "left the front quadrant",        # deescalation wins over "front quadrant"
    "the cat is out of view",
    "person moving parallel",
    "",
])
def test_classifier_not_urgent(event):
    assert _perception_is_urgent(event) is False


# ── Cooldown gating ──────────────────────────────────────────────────────────

async def test_normal_trigger_respects_cooldown(attached):
    cog = FakeCog()
    attached(cog, idle_interval_s=0, cooldown_s=8.0)
    await bus.publish("zone_changed", {"from": "a", "to": "b"})  # fires
    await bus.publish("zone_changed", {"from": "b", "to": "c"})  # within cooldown
    await asyncio.sleep(0.05)
    assert cog.triggers == ["zone:a→b"]


async def test_urgent_bypasses_cooldown(attached):
    cog = FakeCog()
    attached(cog, idle_interval_s=0, cooldown_s=8.0, urgent_min_gap_s=0.0)
    await bus.publish("zone_changed", {"from": "a", "to": "b"})       # normal, starts cooldown
    await asyncio.sleep(0.02)
    await bus.publish("assist", {"events": ["slowed: front 0.4m"]})   # urgent, bypasses it
    await asyncio.sleep(0.05)
    assert len(cog.triggers) == 2
    assert cog.triggers[1].startswith("assist:")


async def test_urgent_floor_still_applies(attached):
    cog = FakeCog()
    attached(cog, idle_interval_s=0, cooldown_s=8.0, urgent_min_gap_s=1.0)
    await bus.publish("assist", {"events": ["e1"]})  # fires
    await asyncio.sleep(0.02)
    await bus.publish("assist", {"events": ["e2"]})  # within the 1s urgent floor
    await asyncio.sleep(0.05)
    assert cog.triggers == ["assist:e1"]


async def test_urgent_floor_clamped_to_cooldown():
    # urgent_min_gap_s can never exceed cooldown_s — a tiny cooldown
    # shouldn't make urgent slower than normal.
    cog = FakeCog()
    a = Autonomy(cog, idle_interval_s=0, cooldown_s=0.5, urgent_min_gap_s=5.0)
    assert a._urgent_min_gap_s == 0.5


# ── Lock: never two ticks in flight ──────────────────────────────────────────

async def test_lock_serializes_ticks(attached):
    cog = FakeCog(delay=0.2)
    attached(cog, idle_interval_s=0, cooldown_s=0.0, urgent_min_gap_s=0.0)
    await bus.publish("assist", {"events": ["a"]})
    await asyncio.sleep(0.02)
    await bus.publish("assist", {"events": ["b"]})  # dropped: tick in flight
    await bus.publish("assist", {"events": ["c"]})  # dropped: tick in flight
    await asyncio.sleep(0.4)
    assert cog.max_in_flight == 1


# ── Perception routing end-to-end ────────────────────────────────────────────

async def test_perception_urgency_routing(attached):
    cog = FakeCog()
    attached(cog, idle_interval_s=0, cooldown_s=8.0, urgent_min_gap_s=0.0)
    await bus.publish("perception", {"event": "obstacle entered front quadrant (0.4 m)"})
    await asyncio.sleep(0.02)
    await bus.publish("perception", {"event": "front quadrant cleared"})  # normal, in cooldown
    await asyncio.sleep(0.05)
    assert cog.triggers == ["perception:obstacle entered front quadrant (0.4 m)"]


async def test_empty_payloads_dropped(attached):
    cog = FakeCog()
    attached(cog, idle_interval_s=0, cooldown_s=0.0)
    await bus.publish("perception", {"event": ""})
    await bus.publish("assist", {"events": []})
    await asyncio.sleep(0.05)
    assert cog.triggers == []


# ── Idle ticker ──────────────────────────────────────────────────────────────

async def test_idle_ticker_fires_and_detach_stops_it():
    cog = FakeCog()
    a = Autonomy(cog, idle_interval_s=0.1, cooldown_s=0.0, urgent_min_gap_s=0.0)
    a.attach()
    await asyncio.sleep(0.35)
    fired = len(cog.triggers)
    assert fired >= 2
    assert all(t == "idle" for t in cog.triggers)
    await a.detach()
    await asyncio.sleep(0.25)
    assert len(cog.triggers) == fired  # no ticks after detach


async def test_idle_interval_zero_means_no_ticker():
    cog = FakeCog()
    a = Autonomy(cog, idle_interval_s=0, cooldown_s=0.0)
    a.attach()
    assert a._idle_task is None
    await asyncio.sleep(0.15)
    assert cog.triggers == []
    await a.detach()


# ── Idempotency ──────────────────────────────────────────────────────────────

async def test_attach_idempotent_no_double_subscribe():
    cog = FakeCog()
    a = Autonomy(cog, idle_interval_s=0, cooldown_s=0.0)
    a.attach()
    a.attach()  # must not double-subscribe
    await bus.publish("assist", {"events": ["x"]})
    await asyncio.sleep(0.05)
    assert cog.triggers == ["assist:x"]  # one, not two
    await a.detach()


async def test_detach_idempotent():
    cog = FakeCog()
    a = Autonomy(cog, idle_interval_s=0.1, cooldown_s=0.0)
    a.attach()
    await a.detach()
    await a.detach()  # must not raise
    # And a detach without a prior attach is also fine.
    await Autonomy(cog).detach()


async def test_failing_tick_does_not_kill_loop(attached):
    class Boom(FakeCog):
        async def autonomy_tick(self, trigger):
            self.triggers.append(trigger)
            raise RuntimeError("simulated LLM failure")

    cog = Boom()
    attached(cog, idle_interval_s=0, cooldown_s=0.0, urgent_min_gap_s=0.0)
    await bus.publish("assist", {"events": ["first"]})
    await asyncio.sleep(0.05)
    await bus.publish("assist", {"events": ["second"]})  # loop survived the first
    await asyncio.sleep(0.05)
    assert cog.triggers == ["assist:first", "assist:second"]
