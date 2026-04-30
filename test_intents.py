"""
Cognition tool-dispatch tests.

We don't test the LLM itself here — `Cognition.chat()` requires a real API
key and is integration-tested by hand. What we test is `_dispatch_tool`:
the path between "the model called this tool" and "the bridge responded".
That path includes the safety guard, the bridge call, and the bus
announcement, which is where the load-bearing logic lives.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from sweetie.cognition.llm import Cognition
from sweetie.core.bridge import SimBridge
from sweetie.core.bus import bus
from sweetie.core.safety import SafetyGuard
from sweetie.sim.world import World, WorldObject


@pytest.fixture
async def setup():
    """Fresh bridge + safety + cognition + bus subscription per test."""
    # M3: tests get a small world so look_at and report_status have content.
    world = World([
        WorldObject("couch", 2.0, 1.5, radius=0.6),
        WorldObject("cat", 0.5, -1.5, radius=0.15),
    ])
    bridge = SimBridge(world=world)
    await bridge.connect()
    safety = SafetyGuard()
    cog = Cognition(bridge=bridge, safety=safety)

    intent_events: list[dict] = []
    speak_events: list[dict] = []

    async def on_intent(p):
        intent_events.append(p)

    async def on_speak(p):
        speak_events.append(p)

    bus.subscribe("intent", on_intent)
    bus.subscribe("speak", on_speak)

    yield {
        "bridge": bridge,
        "safety": safety,
        "cog": cog,
        "intents": intent_events,
        "speaks": speak_events,
    }

    bus.unsubscribe("intent", on_intent)
    bus.unsubscribe("speak", on_speak)
    await bridge.disconnect()


# ── speak ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_speak_publishes_event_and_returns_ok(setup):
    result = await setup["cog"]._dispatch_tool("speak", {"text": "hi there"})
    assert result == "ok"
    assert setup["speaks"] == [{"text": "hi there"}]


@pytest.mark.asyncio
async def test_speak_empty_text_returns_error(setup):
    result = await setup["cog"]._dispatch_tool("speak", {"text": ""})
    assert result.startswith("error")
    assert setup["speaks"] == []


# ── stand_up ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stand_up_rejected_when_idle(setup):
    result = await setup["cog"]._dispatch_tool("stand_up", {})
    assert result.startswith("rejected")
    assert "armed" in result
    state = await setup["bridge"].get_state()
    assert state.mode == "down"  # bridge was NOT called
    # Intent event recorded with 'rejected' outcome
    assert setup["intents"][-1]["action"] == "stand_up"
    assert setup["intents"][-1]["outcome"] == "rejected"


@pytest.mark.asyncio
async def test_stand_up_succeeds_when_armed(setup):
    setup["safety"].arm()
    result = await setup["cog"]._dispatch_tool("stand_up", {})
    assert result == "ok"
    state = await setup["bridge"].get_state()
    assert state.mode == "standing"
    assert setup["intents"][-1]["outcome"] == "ok"


@pytest.mark.asyncio
async def test_stand_up_rejected_when_estopped(setup):
    setup["safety"].arm()
    setup["safety"].estop()
    result = await setup["cog"]._dispatch_tool("stand_up", {})
    assert "estop" in result


# ── sit_down ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sit_down_requires_armed(setup):
    result = await setup["cog"]._dispatch_tool("sit_down", {})
    assert result.startswith("rejected")


@pytest.mark.asyncio
async def test_sit_down_succeeds_from_standing(setup):
    setup["safety"].arm()
    await setup["bridge"].stand_up()
    result = await setup["cog"]._dispatch_tool("sit_down", {})
    assert result == "ok"
    state = await setup["bridge"].get_state()
    assert state.mode == "down"


# ── halt ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_halt_allowed_in_idle(setup):
    result = await setup["cog"]._dispatch_tool("halt", {})
    assert result in ("ok", "no-op")


@pytest.mark.asyncio
async def test_halt_zeros_velocity_when_moving(setup):
    setup["safety"].arm()
    setup["safety"].heartbeat()
    await setup["bridge"].stand_up()
    await setup["bridge"].move(0.5, 0.0, 0.0)

    result = await setup["cog"]._dispatch_tool("halt", {})
    assert result == "ok"
    state = await setup["bridge"].get_state()
    assert state.vx == 0.0


@pytest.mark.asyncio
async def test_halt_allowed_even_in_estop(setup):
    setup["safety"].estop()
    # halt is in ALWAYS_ACTIONS — never rejected
    result = await setup["cog"]._dispatch_tool("halt", {})
    assert not result.startswith("rejected")


# ── report_status ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_report_status_returns_json(setup):
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert "safety" in snapshot
    assert "mode" in snapshot
    assert "battery_percent" in snapshot
    assert "velocity" in snapshot
    assert "pose" in snapshot


@pytest.mark.asyncio
async def test_report_status_always_allowed_even_estop(setup):
    setup["safety"].estop()
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)  # i.e. didn't return a rejection string
    assert snapshot["safety"] == "estop"


@pytest.mark.asyncio
async def test_report_status_reflects_current_state(setup):
    setup["safety"].arm()
    await setup["bridge"].stand_up()
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert snapshot["safety"] == "armed"
    assert snapshot["mode"] == "standing"


# ── unknown tool ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_tool_returns_error(setup):
    result = await setup["cog"]._dispatch_tool("teleport", {})
    assert result.startswith("error")


# ── safety bypass impossibility ──────────────────────────────────────────────
#
# This is the property that matters most: there should be no path from a
# tool call to bridge motion that doesn't touch SafetyGuard. We verify it
# by leaving the safety in IDLE and confirming none of the "do something"
# tools actually make the bridge move.


@pytest.mark.asyncio
async def test_no_action_tool_moves_bridge_when_idle(setup):
    for name in ("stand_up", "sit_down"):
        await setup["cog"]._dispatch_tool(name, {})
    state = await setup["bridge"].get_state()
    assert state.mode == "down"  # never escaped its initial mode


@pytest.mark.asyncio
async def test_look_at_blocked_when_idle(setup):
    """look_at also passes through the safety guard."""
    result = await setup["cog"]._dispatch_tool("look_at", {"target": "couch"})
    assert result.startswith("rejected")
    assert "armed" in result
    assert setup["bridge"]._yaw_target is None  # bridge wasn't called


# ── M3: look_at ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_look_at_succeeds_when_armed_and_standing(setup):
    setup["safety"].arm()
    await setup["bridge"].stand_up()
    result = await setup["cog"]._dispatch_tool("look_at", {"target": "couch"})
    assert result.startswith("ok")
    # Intent recorded with target as the reason field
    last = setup["intents"][-1]
    assert last["action"] == "look_at"
    assert last["outcome"] == "ok"
    assert last["reason"] == "couch"


@pytest.mark.asyncio
async def test_look_at_unknown_target(setup):
    setup["safety"].arm()
    await setup["bridge"].stand_up()
    result = await setup["cog"]._dispatch_tool("look_at", {"target": "ghost"})
    assert result.startswith("rejected")
    assert "ghost" in result


@pytest.mark.asyncio
async def test_look_at_when_robot_down(setup):
    setup["safety"].arm()
    # robot is still 'down', not 'standing'
    result = await setup["cog"]._dispatch_tool("look_at", {"target": "couch"})
    assert "standing" in result.lower() or "wrong" in result.lower()


@pytest.mark.asyncio
async def test_look_at_empty_target(setup):
    setup["safety"].arm()
    await setup["bridge"].stand_up()
    result = await setup["cog"]._dispatch_tool("look_at", {"target": ""})
    assert result.startswith("error")


# ── M3: report_status includes world data ───────────────────────────────────


@pytest.mark.asyncio
async def test_report_status_includes_proximity(setup):
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert "proximity_m" in snapshot
    for q in ("front", "left", "back", "right"):
        assert q in snapshot["proximity_m"]


@pytest.mark.asyncio
async def test_report_status_includes_nearby_objects(setup):
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert "nearby_objects" in snapshot
    names = [o["name"] for o in snapshot["nearby_objects"]]
    # both fixture objects are within visible range from origin
    assert "couch" in names
    assert "cat" in names


# ── M4: report_status surfaces smart-assist log ─────────────────────────────


@pytest.mark.asyncio
async def test_report_status_includes_recent_assists(setup):
    setup["safety"].record_assist("slowed (front 0.45m)")
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert "recent_assists" in snapshot
    assert len(snapshot["recent_assists"]) == 1
    assert "slowed" in snapshot["recent_assists"][0]["reason"]


@pytest.mark.asyncio
async def test_report_status_recent_assists_empty_by_default(setup):
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert snapshot["recent_assists"] == []


# ── M?-scene: report_status carries categories, motion, perceptions ─────────


@pytest.mark.asyncio
async def test_report_status_includes_categories(setup):
    """Each nearby object should carry its category."""
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    objs = {o["name"]: o for o in snapshot["nearby_objects"]}
    # The setup fixture uses a small world with default 'object' category;
    # the field should be present regardless.
    for o in objs.values():
        assert "category" in o


@pytest.mark.asyncio
async def test_report_status_includes_recent_perceptions(setup):
    """The bridge populates perception events; report_status surfaces them."""
    # Wait briefly for the bridge to log the initial observation
    await asyncio.sleep(0.1)
    result = await setup["cog"]._dispatch_tool("report_status", {})
    snapshot = json.loads(result)
    assert "recent_perceptions" in snapshot
    # We don't assert it's non-empty (timing-sensitive), only structurally present.
    assert isinstance(snapshot["recent_perceptions"], list)
