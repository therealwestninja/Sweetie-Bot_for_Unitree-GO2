"""Gesture vocabulary + bridge.perform_gesture tests. Run via pytest."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from sweetie.core.gestures import GESTURES, SAFE_GESTURES, resolve
from sweetie.sim.world import World


# ── vocabulary is grounded in the real command table ────────────────────────


def test_gesture_ids_match_robot_cmd_table():
    """Every gesture's api_id must equal the vendored ROBOT_CMD id for its
    SportClient method — keeps the vocab reconciled to the real table."""
    from sweetie.teleop.robot_commands import ROBOT_CMD
    for name, g in GESTURES.items():
        assert g.method in ROBOT_CMD, f"{name}: {g.method} not in ROBOT_CMD"
        assert ROBOT_CMD[g.method] == g.api_id, f"{name}: id mismatch"


def test_resolve_is_case_and_space_insensitive():
    assert resolve("  Hello ") is GESTURES["hello"]
    assert resolve("nope") is None


def test_safe_gestures_exclude_acrobatics():
    assert "moonwalk" not in SAFE_GESTURES
    assert "frontflip" not in SAFE_GESTURES
    assert "hello" in SAFE_GESTURES


# ── SimBridge behaviour ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sim_gesture_succeeds_when_standing():
    from sweetie.core.bridge import SimBridge
    b = SimBridge(World([]))
    await b.stand_up()
    assert await b.perform_gesture("hello") is True
    assert await b.perform_gesture("not-a-gesture") is False


@pytest.mark.asyncio
async def test_sim_gesture_refused_when_folded():
    from sweetie.core.bridge import SimBridge
    b = SimBridge(World([]))
    await b.stand_down()  # mode == "down"
    assert await b.perform_gesture("hello") is False


# ── RealBridge behaviour (mock SDK) ──────────────────────────────────────────


def _fake_sdk():
    sport = MagicMock()
    for m in ("Hello", "FrontFlip", "SetTimeout", "Init", "StopMove"):
        getattr(sport, m).return_value = 0
    sub = MagicMock()
    return {
        "ChannelFactoryInitialize": MagicMock(),
        "ChannelSubscriber": MagicMock(return_value=sub),
        "SportClient": MagicMock(return_value=sport),
        "SportModeState_": MagicMock,
        "LowState_": MagicMock,
    }, sport


@pytest.mark.asyncio
async def test_real_gesture_calls_sport_method():
    from sweetie.core.real_bridge import RealBridge
    sdk, sport = _fake_sdk()
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        b = RealBridge()
        await b.connect()
        assert await b.perform_gesture("hello") is True
        sport.Hello.assert_called_once()
        await b.disconnect()


@pytest.mark.asyncio
async def test_real_risky_gesture_refused_unless_enabled():
    from sweetie.core.real_bridge import RealBridge
    sdk, sport = _fake_sdk()
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        b = RealBridge()  # enable_risky defaults False
        await b.connect()
        assert await b.perform_gesture("frontflip") is False
        sport.FrontFlip.assert_not_called()
        await b.disconnect()

    sdk2, sport2 = _fake_sdk()
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk2):
        b2 = RealBridge(enable_risky=True)
        await b2.connect()
        assert await b2.perform_gesture("frontflip") is True
        sport2.FrontFlip.assert_called_once()
        await b2.disconnect()
