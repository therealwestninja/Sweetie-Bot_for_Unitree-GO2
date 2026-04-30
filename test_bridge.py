"""SimBridge tests."""

from __future__ import annotations

import asyncio
import math

import pytest

from sweetie.core.bridge import SimBridge, VX_LIMIT, VY_LIMIT, VYAW_LIMIT
from sweetie.sim.world import PROXIMITY_MAX_RANGE, World, WorldObject


@pytest.fixture
async def bridge():
    b = SimBridge()
    await b.connect()
    yield b
    await b.disconnect()


@pytest.mark.asyncio
async def test_connect_starts_tick_task():
    b = SimBridge()
    await b.connect()
    assert b._tick_task is not None
    assert not b._tick_task.done()
    await b.disconnect()


@pytest.mark.asyncio
async def test_starts_in_down_mode(bridge):
    s = await bridge.get_state()
    assert s.mode == "down"


@pytest.mark.asyncio
async def test_stand_up_changes_mode(bridge):
    await bridge.stand_up()
    s = await bridge.get_state()
    assert s.mode == "standing"
    assert s.body_height == pytest.approx(0.27)


@pytest.mark.asyncio
async def test_move_rejected_when_down(bridge):
    ok = await bridge.move(0.5, 0, 0)
    assert ok is False


@pytest.mark.asyncio
async def test_move_when_standing_sets_velocity(bridge):
    await bridge.stand_up()
    ok = await bridge.move(0.5, 0.0, 0.0)
    assert ok is True
    s = await bridge.get_state()
    assert s.vx == pytest.approx(0.5)
    assert s.mode == "moving"


@pytest.mark.asyncio
async def test_move_clamps_at_bridge(bridge):
    await bridge.stand_up()
    await bridge.move(99.0, 99.0, 99.0)
    s = await bridge.get_state()
    assert s.vx == pytest.approx(VX_LIMIT)
    assert s.vy == pytest.approx(VY_LIMIT)
    assert s.vyaw == pytest.approx(VYAW_LIMIT)


@pytest.mark.asyncio
async def test_stop_move_zeros_velocity(bridge):
    await bridge.stand_up()
    await bridge.move(0.5, 0.0, 0.5)
    await bridge.stop_move()
    s = await bridge.get_state()
    assert s.vx == 0 and s.vy == 0 and s.vyaw == 0
    assert s.mode == "standing"


@pytest.mark.asyncio
async def test_estop_freezes_and_blocks_motion(bridge):
    await bridge.stand_up()
    await bridge.emergency_stop()
    s = await bridge.get_state()
    assert s.mode == "estop"
    assert s.vx == 0
    # Subsequent moves rejected
    assert await bridge.move(0.5, 0, 0) is False
    assert await bridge.stand_up() is False


@pytest.mark.asyncio
async def test_clear_estop_returns_to_down(bridge):
    await bridge.emergency_stop()
    await bridge.clear_estop()
    s = await bridge.get_state()
    assert s.mode == "down"


@pytest.mark.asyncio
async def test_pose_integrates_with_velocity(bridge):
    await bridge.stand_up()
    await bridge.move(0.5, 0.0, 0.0)
    s0 = await bridge.get_state()
    x0 = s0.x
    await asyncio.sleep(0.2)
    s1 = await bridge.get_state()
    assert s1.x > x0  # moved forward


# ── M3: world integration ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_range_obstacle_default_max_when_no_world():
    b = SimBridge()  # no world
    await b.connect()
    await asyncio.sleep(0.05)
    s = await b.get_state()
    assert s.range_obstacle == [PROXIMITY_MAX_RANGE] * 4
    await b.disconnect()


@pytest.mark.asyncio
async def test_range_obstacle_populated_from_world():
    w = World([WorldObject("x", 1.0, 0.0, radius=0.0)])
    b = SimBridge(world=w)
    await b.connect()
    await asyncio.sleep(0.05)
    s = await b.get_state()
    assert s.range_obstacle[0] == pytest.approx(1.0, abs=0.01)
    await b.disconnect()


# ── M3: look_at_entity ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_look_at_no_world():
    b = SimBridge()
    await b.connect()
    await b.stand_up()
    assert await b.look_at_entity("anything") == "no_world"
    await b.disconnect()


@pytest.mark.asyncio
async def test_look_at_no_target():
    b = SimBridge(world=World([]))
    await b.connect()
    await b.stand_up()
    assert await b.look_at_entity("ghost") == "no_target"
    await b.disconnect()


@pytest.mark.asyncio
async def test_look_at_when_down_returns_wrong_mode():
    w = World([WorldObject("x", 1, 0)])
    b = SimBridge(world=w)
    await b.connect()
    # Robot is in 'down' mode by default
    assert await b.look_at_entity("x") == "wrong_mode"
    await b.disconnect()


@pytest.mark.asyncio
async def test_look_at_rotates_robot_toward_target():
    """Object to the left → robot should rotate to ~+pi/2 yaw."""
    w = World([WorldObject("x", 0.0, 1.0, radius=0.0)])
    b = SimBridge(world=w)
    await b.connect()
    await b.stand_up()
    assert await b.look_at_entity("x") == "ok"

    # Allow the controller to converge.
    for _ in range(40):
        await asyncio.sleep(0.05)
        s = await b.get_state()
        if abs(((s.yaw - math.pi / 2 + math.pi) % (2 * math.pi)) - math.pi) < 0.06:
            break
    s = await b.get_state()
    assert s.yaw == pytest.approx(math.pi / 2, abs=0.06)
    await b.disconnect()


@pytest.mark.asyncio
async def test_move_cancels_look_at():
    """If the operator drives, an in-progress look_at gives up immediately."""
    w = World([WorldObject("x", -1.0, 0.0)])  # behind robot
    b = SimBridge(world=w)
    await b.connect()
    await b.stand_up()
    await b.look_at_entity("x")
    assert b._yaw_target is not None
    # Operator commands a move
    await b.move(0.5, 0.0, 0.0)
    assert b._yaw_target is None
    await b.disconnect()


# ── M5: bridge ticks the world ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bridge_tick_advances_dynamic_entities():
    """Confirm the SimBridge tick loop calls world.tick() so entities move."""
    from sweetie.sim.world import Wanderer  # local import to avoid top-of-file churn
    cat = Wanderer(name="cat", x=0.0, y=0.0, speed=1.0, roam_radius=2.0, seed=11)
    w = World([cat])
    b = SimBridge(world=w)
    await b.connect()
    start = (cat.x, cat.y)
    await asyncio.sleep(0.5)
    assert (cat.x, cat.y) != start
    await b.disconnect()


# ── M?-scene: perception events ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recent_perceptions_empty_initially():
    b = SimBridge()
    await b.connect()
    assert b.recent_perceptions() == []
    await b.disconnect()


@pytest.mark.asyncio
async def test_perception_logs_initial_observation():
    """First tick should log where each dynamic entity starts (in range)."""
    from sweetie.sim.world import Wanderer
    cat = Wanderer(name="cat", x=1.0, y=0.0, speed=0.0)  # in front, not moving
    w = World([cat])
    b = SimBridge(world=w)
    await b.connect()
    await asyncio.sleep(0.1)
    log = b.recent_perceptions()
    assert any("cat" in e["event"] and "front" in e["event"] for e in log)
    await b.disconnect()


@pytest.mark.asyncio
async def test_perception_logs_quadrant_change_to_front():
    """Entity moving from left into front should generate an event."""
    from sweetie.sim.world import PathWalker
    # Entity walks from left (0, 1) to front (1, 0)
    p = PathWalker(
        name="walker", x=0.0, y=1.0,
        waypoints=[(1.0, 0.0)], speed=1.0,
    )
    w = World([p])
    b = SimBridge(world=w)
    await b.connect()
    # Wait for the entity to traverse
    await asyncio.sleep(2.0)
    log = b.recent_perceptions()
    events = [e["event"] for e in log]
    assert any("walker" in e and "in front" in e for e in events)
    await b.disconnect()


# ── M? reactive: bridge passes observer to world ────────────────────────────


@pytest.mark.asyncio
async def test_bridge_observer_triggers_cat_flee():
    """Place a fleeing cat next to robot's start, confirm it scrambles away."""
    from sweetie.sim.world import Wanderer
    cat = Wanderer(
        name="cat", x=0.4, y=0.0, speed=1.0, roam_radius=2.0, seed=1,
        flee_distance=1.0, flee_speed_multiplier=3.0,
    )
    w = World([cat])
    b = SimBridge(world=w)
    await b.connect()
    # Robot is at (0, 0); cat starts at (0.4, 0). After ticks, cat should
    # move away (positive x direction, since flee = away from observer).
    await asyncio.sleep(0.4)
    assert cat.x > 0.4  # moved further from the robot
    await b.disconnect()


# ── Body height ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_body_height_clamps_to_range():
    from sweetie.core.bridge import BODY_HEIGHT_MAX, BODY_HEIGHT_MIN
    b = SimBridge()
    await b.connect()
    b._state.mode = "standing"
    await b.set_body_height(99.0)
    assert b._state.body_height == pytest.approx(BODY_HEIGHT_MAX)
    await b.set_body_height(-99.0)
    assert b._state.body_height == pytest.approx(BODY_HEIGHT_MIN)
    await b.disconnect()


@pytest.mark.asyncio
async def test_set_body_height_refused_when_folded():
    b = SimBridge()
    await b.connect()
    # Default mode is "down" (folded)
    ok = await b.set_body_height(0.27)
    assert ok is False
    await b.disconnect()


# ── Navigation (go_to_pose) ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_go_to_pose_drives_robot_toward_target():
    b = SimBridge()
    await b.connect()
    b._state.mode = "standing"
    ok = await b.go_to_pose(2.0, 0.0)
    assert ok is True
    # Wait for the tick loop to drive the robot
    await asyncio.sleep(0.5)
    s = await b.get_state()
    assert s.x > 0.1  # moved toward target
    await b.disconnect()


@pytest.mark.asyncio
async def test_go_to_pose_arrives_and_clears_goal():
    b = SimBridge()
    await b.connect()
    b._state.mode = "standing"
    await b.go_to_pose(0.5, 0.0)  # close target
    # Wait long enough to arrive
    await asyncio.sleep(3.0)
    assert b._nav_target is None  # goal cleared
    s = await b.get_state()
    # Within arrival tolerance of (0.5, 0)
    assert abs(s.x - 0.5) < 0.3
    await b.disconnect()


@pytest.mark.asyncio
async def test_operator_move_cancels_nav():
    """Any nonzero operator velocity command cancels an active nav goal."""
    b = SimBridge()
    await b.connect()
    b._state.mode = "standing"
    await b.go_to_pose(5.0, 5.0)
    assert b._nav_target is not None
    await b.move(0.1, 0.0, 0.0)
    assert b._nav_target is None
    await b.disconnect()


@pytest.mark.asyncio
async def test_estop_cancels_nav():
    b = SimBridge()
    await b.connect()
    b._state.mode = "standing"
    await b.go_to_pose(5.0, 5.0)
    await b.emergency_stop()
    assert b._nav_target is None
    await b.disconnect()


@pytest.mark.asyncio
async def test_go_to_pose_refused_when_estop():
    b = SimBridge()
    await b.connect()
    b._state.mode = "estop"
    ok = await b.go_to_pose(1.0, 0.0)
    assert ok is False
    await b.disconnect()


# ── Region tracking ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bridge_publishes_zone_change_event():
    """Robot starting in 'apartment' should emit a zone_changed event on first tick."""
    from sweetie.core.bus import bus
    from sweetie.sim.world import studio_scene

    captured: list[dict] = []

    async def collect(payload):
        captured.append(payload)

    bus.subscribe("zone_changed", collect)
    try:
        b = SimBridge(world=studio_scene())
        await b.connect()
        # Robot starts at (0, 0) which is inside the apartment region.
        # First tick should fire from None → "apartment".
        await asyncio.sleep(0.1)
        assert any(p["to"] == "apartment" for p in captured)
        await b.disconnect()
    finally:
        bus._subs.clear()


@pytest.mark.asyncio
async def test_bridge_current_region_reflects_pose():
    """Manually moving the robot into a different region updates current_region."""
    from sweetie.sim.world import studio_scene
    b = SimBridge(world=studio_scene())
    await b.connect()
    await asyncio.sleep(0.1)
    assert b.current_region() == "apartment"
    # Teleport robot to street area
    b._state.x = 6.0
    b._state.y = 0.0
    await asyncio.sleep(0.1)
    assert b.current_region() == "street"
    await b.disconnect()


@pytest.mark.asyncio
async def test_bridge_with_no_regions_has_none_current():
    """A world with no regions returns None for current_region throughout."""
    from sweetie.sim.world import World, WorldObject
    b = SimBridge(world=World([WorldObject("rock", 0, 0)]))  # no regions
    await b.connect()
    await asyncio.sleep(0.1)
    assert b.current_region() is None
    await b.disconnect()
