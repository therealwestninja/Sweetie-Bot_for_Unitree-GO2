"""
RealBridge tests.

These tests do NOT verify behaviour against actual Unitree hardware.
They verify the integration *shape*:
  - connect() initializes DDS and SportClient correctly
  - DDS callbacks correctly populate RobotState
  - command methods dispatch to the right SDK functions with right args
  - mode-code mapping behaves
  - get_state() returns isolated copies (thread safety)

End-to-end verification against a real Go2 (or a Cyclone DDS-backed
simulator) is the open M7 gap.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


def _make_fake_sdk() -> tuple[dict, MagicMock]:
    """Build a mock SDK module dict matching what _import_sdk() returns."""
    sport_inst = MagicMock()
    # Unitree convention: 0 = success
    sport_inst.StandUp.return_value = 0
    sport_inst.StandDown.return_value = 0
    sport_inst.Move.return_value = 0
    sport_inst.StopMove.return_value = 0
    sport_inst.Damp.return_value = 0
    sport_inst.SetTimeout.return_value = None
    sport_inst.Init.return_value = None

    sport_class = MagicMock(return_value=sport_inst)

    sub_inst = MagicMock()
    sub_class = MagicMock(return_value=sub_inst)

    sdk = {
        "ChannelFactoryInitialize": MagicMock(),
        "ChannelSubscriber": sub_class,
        "SportClient": sport_class,
        "SportModeState_": MagicMock,
        "LowState_": MagicMock,
    }
    return sdk, sport_inst


@pytest.fixture
def patched_sdk():
    sdk, sport_inst = _make_fake_sdk()
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        yield sdk, sport_inst


# ── Lifecycle ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_connect_initializes_dds_with_configured_params(patched_sdk):
    sdk, _ = patched_sdk
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge(network_interface="wlan0", domain_id=3)
    await b.connect()

    # ChannelFactoryInitialize called with our domain + interface
    sdk["ChannelFactoryInitialize"].assert_called_once_with(3, "wlan0")
    # Two subscribers initialized
    assert sdk["ChannelSubscriber"].call_count == 2
    # SportClient instantiated, configured, and Init'd
    sdk["SportClient"].assert_called_once()
    await b.disconnect()


@pytest.mark.asyncio
async def test_connect_uses_default_interface_when_none(patched_sdk):
    sdk, _ = patched_sdk
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()
    # Default interface is "eth0", default domain 0
    sdk["ChannelFactoryInitialize"].assert_called_once_with(0, "eth0")
    await b.disconnect()


@pytest.mark.asyncio
async def test_connect_is_idempotent(patched_sdk):
    sdk, _ = patched_sdk
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()
    await b.connect()  # second call should be a no-op
    sdk["ChannelFactoryInitialize"].assert_called_once()
    await b.disconnect()


@pytest.mark.asyncio
async def test_disconnect_clears_handles(patched_sdk):
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()
    await b.disconnect()
    assert b._connected is False
    assert b._sport is None


def test_import_sdk_raises_clear_error_when_missing():
    """If unitree_sdk2py isn't installed, _import_sdk gives an actionable error."""
    from sweetie.core.real_bridge import _import_sdk
    with patch.dict("sys.modules", {"unitree_sdk2py": None}):
        with pytest.raises(RuntimeError, match="unitree_sdk2py is not installed"):
            _import_sdk()


# ── State callback (DDS thread → cached state) ───────────────────────────────


def _fake_sport_state_msg(
    *,
    pos=(1.5, -0.5, 0.27),
    rpy=(0.05, -0.03, 1.57),
    velocity=(0.4, 0.0, 0.0),
    yaw_speed=0.0,
    body_height=0.27,
    range_obstacle=(0.8, 3.0, 3.0, 3.0),
    mode=1,
):
    """Build a SimpleNamespace shaped like SportModeState_."""
    return SimpleNamespace(
        position=list(pos),
        imu_state=SimpleNamespace(rpy=list(rpy)),
        velocity=list(velocity),
        yaw_speed=yaw_speed,
        body_height=body_height,
        range_obstacle=list(range_obstacle),
        mode=mode,
    )


@pytest.mark.asyncio
async def test_sport_state_callback_populates_robot_state(patched_sdk):
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()

    msg = _fake_sport_state_msg(
        pos=(2.0, 1.0, 0.27),
        rpy=(0.1, -0.05, 0.5),
        velocity=(0.3, 0.05, 0.0),
        range_obstacle=(0.7, 2.0, 3.0, 1.5),
    )
    b._on_sport_state(msg)
    s = await b.get_state()
    assert s.x == 2.0 and s.y == 1.0
    assert s.roll == pytest.approx(0.1)
    assert s.pitch == pytest.approx(-0.05)
    assert s.yaw == pytest.approx(0.5)
    assert s.vx == pytest.approx(0.3)
    assert s.vy == pytest.approx(0.05)
    assert s.range_obstacle == [0.7, 2.0, 3.0, 1.5]
    await b.disconnect()


@pytest.mark.asyncio
async def test_low_state_callback_populates_battery(patched_sdk):
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()

    msg = SimpleNamespace(bms_state=SimpleNamespace(soc=72))
    b._on_low_state(msg)
    s = await b.get_state()
    assert s.battery_percent == pytest.approx(72.0)
    await b.disconnect()


@pytest.mark.asyncio
async def test_get_state_returns_isolated_copy(patched_sdk):
    """Mutating the returned state must not affect the bridge's cache."""
    from sweetie.core.real_bridge import RealBridge

    b = RealBridge()
    await b.connect()
    b._on_sport_state(_fake_sport_state_msg())

    s1 = await b.get_state()
    s1.x = 999.0
    s1.range_obstacle[0] = 999.0
    s2 = await b.get_state()
    assert s2.x != 999.0
    assert s2.range_obstacle[0] != 999.0
    await b.disconnect()


# ── Mode mapping ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mode_damp_maps_to_estop(patched_sdk):
    from sweetie.core.real_bridge import RealBridge, SPORT_MODE_DAMP
    b = RealBridge()
    await b.connect()
    b._on_sport_state(_fake_sport_state_msg(mode=SPORT_MODE_DAMP))
    s = await b.get_state()
    assert s.mode == "estop"
    await b.disconnect()


@pytest.mark.asyncio
async def test_mode_stand_down_maps_to_down(patched_sdk):
    from sweetie.core.real_bridge import RealBridge, SPORT_MODE_STAND_DOWN
    b = RealBridge()
    await b.connect()
    b._on_sport_state(_fake_sport_state_msg(mode=SPORT_MODE_STAND_DOWN))
    s = await b.get_state()
    assert s.mode == "down"
    await b.disconnect()


@pytest.mark.asyncio
async def test_mode_balance_with_velocity_maps_to_moving(patched_sdk):
    from sweetie.core.real_bridge import RealBridge, SPORT_MODE_BALANCE_STAND
    b = RealBridge()
    await b.connect()
    b._on_sport_state(_fake_sport_state_msg(
        mode=SPORT_MODE_BALANCE_STAND, velocity=(0.5, 0.0, 0.0)
    ))
    s = await b.get_state()
    assert s.mode == "moving"
    await b.disconnect()


@pytest.mark.asyncio
async def test_mode_balance_at_rest_maps_to_standing(patched_sdk):
    from sweetie.core.real_bridge import RealBridge, SPORT_MODE_BALANCE_STAND
    b = RealBridge()
    await b.connect()
    b._on_sport_state(_fake_sport_state_msg(
        mode=SPORT_MODE_BALANCE_STAND, velocity=(0.0, 0.0, 0.0), yaw_speed=0.0,
    ))
    s = await b.get_state()
    assert s.mode == "standing"
    await b.disconnect()


# ── Commands ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stand_up_calls_sdk(patched_sdk):
    _, sport = patched_sdk
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    ok = await b.stand_up()
    assert ok is True
    sport.StandUp.assert_called_once()
    await b.disconnect()


@pytest.mark.asyncio
async def test_stand_down_calls_sdk(patched_sdk):
    _, sport = patched_sdk
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    ok = await b.stand_down()
    assert ok is True
    sport.StandDown.assert_called_once()
    await b.disconnect()


@pytest.mark.asyncio
async def test_move_passes_clamped_args_to_sdk(patched_sdk):
    _, sport = patched_sdk
    from sweetie.core.real_bridge import RealBridge
    from sweetie.core.bridge import VX_LIMIT
    b = RealBridge()
    await b.connect()
    await b.move(99.0, 0.0, 0.0)  # over the limit
    sport.Move.assert_called_once()
    called_args = sport.Move.call_args.args
    assert called_args[0] == pytest.approx(VX_LIMIT)  # clamped
    await b.disconnect()


@pytest.mark.asyncio
async def test_emergency_stop_calls_damp_and_sets_mode(patched_sdk):
    _, sport = patched_sdk
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    ok = await b.emergency_stop()
    assert ok is True
    sport.Damp.assert_called_once()
    s = await b.get_state()
    assert s.mode == "estop"
    await b.disconnect()


@pytest.mark.asyncio
async def test_clear_estop_doesnt_call_sdk(patched_sdk):
    """clear_estop only flips internal mode — the operator must explicitly stand_up."""
    _, sport = patched_sdk
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    await b.emergency_stop()
    sport.reset_mock()  # clear calls so we can assert nothing new fires
    ok = await b.clear_estop()
    assert ok is True
    # Specifically: no sport client method should have been invoked.
    assert not sport.StandUp.called
    assert not sport.RecoveryStand.called
    s = await b.get_state()
    assert s.mode == "down"
    await b.disconnect()


@pytest.mark.asyncio
async def test_sdk_call_returns_false_on_nonzero_result(patched_sdk):
    """Unitree convention: nonzero return = error code → bridge reports False."""
    _, sport = patched_sdk
    sport.StandUp.return_value = 7  # arbitrary nonzero error code
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    ok = await b.stand_up()
    assert ok is False
    await b.disconnect()


@pytest.mark.asyncio
async def test_sdk_call_returns_false_on_exception(patched_sdk):
    _, sport = patched_sdk
    sport.StandUp.side_effect = RuntimeError("DDS timeout")
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    ok = await b.stand_up()
    assert ok is False
    await b.disconnect()


@pytest.mark.asyncio
async def test_command_before_connect_returns_false(patched_sdk):
    """Calling commands on an unconnected bridge is safe — returns False."""
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()  # NOT connected
    assert await b.stand_up() is False
    assert await b.move(0.5, 0, 0) is False
    assert await b.emergency_stop() is False


@pytest.mark.asyncio
async def test_look_at_returns_no_world(patched_sdk):
    """RealBridge has no perception layer — look_at should report no_world."""
    from sweetie.core.real_bridge import RealBridge
    b = RealBridge()
    await b.connect()
    assert await b.look_at_entity("anything") == "no_world"
    await b.disconnect()
