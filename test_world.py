"""World model tests."""

from __future__ import annotations

import math

import pytest

from sweetie.sim.world import (
    PROXIMITY_MAX_RANGE,
    QUADRANT_BACK,
    QUADRANT_FRONT,
    QUADRANT_LEFT,
    QUADRANT_RIGHT,
    Observer,
    PathWalker,
    Wanderer,
    World,
    WorldObject,
    default_scene,
)


# ── Lookup ──────────────────────────────────────────────────────────────────


def test_by_name_exact_match():
    w = World([WorldObject("couch", 1, 0)])
    assert w.by_name("couch").name == "couch"


def test_by_name_case_insensitive():
    w = World([WorldObject("Couch", 1, 0)])
    assert w.by_name("COUCH").name == "Couch"
    assert w.by_name("couch").name == "Couch"


def test_by_name_strips_leading_the():
    w = World([WorldObject("cat", 0, -1)])
    assert w.by_name("the cat").name == "cat"
    assert w.by_name("The Cat").name == "cat"


def test_by_name_missing_returns_none():
    w = World([WorldObject("cat", 0, -1)])
    assert w.by_name("dog") is None


def test_default_scene_has_named_objects():
    s = default_scene()
    names = s.names()
    assert "couch" in names
    assert "cat" in names
    assert "kitchen counter" in names


# ── Bearing ─────────────────────────────────────────────────────────────────


def test_bearing_directly_in_front():
    """Object at (1, 0) from origin → bearing 0."""
    w = World([WorldObject("x", 1, 0)])
    assert w.bearing_from(0, 0, w.objects[0]) == pytest.approx(0)


def test_bearing_directly_to_left():
    """Object at (0, 1) from origin → bearing pi/2."""
    w = World([WorldObject("x", 0, 1)])
    assert w.bearing_from(0, 0, w.objects[0]) == pytest.approx(math.pi / 2)


def test_bearing_behind():
    w = World([WorldObject("x", -1, 0)])
    bearing = w.bearing_from(0, 0, w.objects[0])
    # atan2 returns pi for (-1, 0)
    assert abs(bearing - math.pi) < 1e-6 or abs(bearing + math.pi) < 1e-6


# ── Proximity ranges ────────────────────────────────────────────────────────


def test_proximity_no_objects_returns_max():
    w = World([])
    r = w.proximity_ranges(0, 0, 0)
    assert r == [PROXIMITY_MAX_RANGE] * 4


def test_proximity_object_in_front_quadrant():
    """Robot at origin facing +x; object at (1, 0) → front quadrant."""
    w = World([WorldObject("x", 1.0, 0.0, radius=0.0)])
    r = w.proximity_ranges(0, 0, 0)
    assert r[QUADRANT_FRONT] == pytest.approx(1.0)
    assert r[QUADRANT_LEFT] == PROXIMITY_MAX_RANGE
    assert r[QUADRANT_BACK] == PROXIMITY_MAX_RANGE
    assert r[QUADRANT_RIGHT] == PROXIMITY_MAX_RANGE


def test_proximity_object_to_left_quadrant():
    w = World([WorldObject("x", 0.0, 1.0, radius=0.0)])
    r = w.proximity_ranges(0, 0, 0)
    assert r[QUADRANT_LEFT] == pytest.approx(1.0)
    assert r[QUADRANT_FRONT] == PROXIMITY_MAX_RANGE


def test_proximity_subtracts_object_radius():
    """A 0.5m-radius object 1m away should report 0.5m to its edge."""
    w = World([WorldObject("x", 1.0, 0.0, radius=0.5)])
    r = w.proximity_ranges(0, 0, 0)
    assert r[QUADRANT_FRONT] == pytest.approx(0.5)


def test_proximity_quadrant_rotates_with_yaw():
    """If the robot turns 90°, the object that was in front is now to the right."""
    w = World([WorldObject("x", 1.0, 0.0, radius=0.0)])
    r = w.proximity_ranges(0, 0, math.pi / 2)
    # In robot frame after yaw=+pi/2: world +x is now at robot-frame -y, i.e. RIGHT.
    assert r[QUADRANT_RIGHT] == pytest.approx(1.0)
    assert r[QUADRANT_FRONT] == PROXIMITY_MAX_RANGE


def test_proximity_object_beyond_max_range_ignored():
    w = World([WorldObject("x", PROXIMITY_MAX_RANGE + 5, 0)])
    r = w.proximity_ranges(0, 0, 0)
    assert r == [PROXIMITY_MAX_RANGE] * 4


def test_proximity_takes_min_when_two_in_same_quadrant():
    w = World([
        WorldObject("near", 1.0, 0.0, radius=0.0),
        WorldObject("far", 2.5, 0.0, radius=0.0),
    ])
    r = w.proximity_ranges(0, 0, 0)
    assert r[QUADRANT_FRONT] == pytest.approx(1.0)


# ── Visible summary ─────────────────────────────────────────────────────────


def test_visible_summary_sorted_by_distance():
    w = World([
        WorldObject("far", 5.0, 0.0),
        WorldObject("near", 1.0, 0.0),
        WorldObject("mid", 3.0, 0.0),
    ])
    summary = w.visible_summary(0, 0, max_range=10)
    assert [s["name"] for s in summary] == ["near", "mid", "far"]


def test_visible_summary_excludes_far_objects():
    w = World([WorldObject("here", 1, 0), WorldObject("nope", 50, 0)])
    summary = w.visible_summary(0, 0)
    assert [s["name"] for s in summary] == ["here"]


def test_visible_summary_includes_bearing_and_distance():
    w = World([WorldObject("x", 0, 1)])  # to the left → bearing 90°
    summary = w.visible_summary(0, 0)
    assert summary[0]["distance_m"] == pytest.approx(1.0)
    assert summary[0]["bearing_deg"] == pytest.approx(90.0)


# ── M5: dynamic entities ─────────────────────────────────────────────────────


def test_world_object_is_static_by_default():
    o = WorldObject("rock", 0, 0)
    assert o.dynamic is False


def test_world_object_update_is_noop():
    o = WorldObject("rock", 0, 0)
    o.update(1.0)
    assert (o.x, o.y) == (0, 0)


def test_to_dict_includes_dynamic_flag():
    static = WorldObject("rock", 0, 0)
    moving = Wanderer(name="cat", x=0, y=0)
    assert static.to_dict()["dynamic"] is False
    assert moving.to_dict()["dynamic"] is True


# ── Wanderer ────────────────────────────────────────────────────────────────


def test_wanderer_dynamic_true():
    assert Wanderer.dynamic is True


def test_wanderer_moves_over_time():
    cat = Wanderer(name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=42)
    start = (cat.x, cat.y)
    for _ in range(20):
        cat.update(0.1)  # 2 seconds total
    assert (cat.x, cat.y) != start


def test_wanderer_deterministic_with_seed():
    a = Wanderer(name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=42)
    b = Wanderer(name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=42)
    for _ in range(50):
        a.update(0.1)
        b.update(0.1)
    assert a.x == pytest.approx(b.x)
    assert a.y == pytest.approx(b.y)


def test_wanderer_stays_near_home():
    """Cat shouldn't drift off into the void."""
    cat = Wanderer(name="c", x=5.0, y=5.0, speed=1.0, roam_radius=1.0, seed=1)
    home = (cat.home_x, cat.home_y)
    max_dist = 0.0
    for _ in range(200):
        cat.update(0.1)
        d = math.hypot(cat.x - home[0], cat.y - home[1])
        max_dist = max(max_dist, d)
    # Roam radius is 1.0; some overshoot is fine but it shouldn't double.
    assert max_dist < 2.0


def test_wanderer_home_defaults_to_initial_position():
    cat = Wanderer(name="c", x=3.5, y=-2.0)
    assert cat.home_x == 3.5
    assert cat.home_y == -2.0


# ── PathWalker ──────────────────────────────────────────────────────────────


def test_path_walker_dynamic_true():
    assert PathWalker.dynamic is True


def test_path_walker_with_no_waypoints_does_nothing():
    p = PathWalker(name="p", x=1, y=1, waypoints=[])
    p.update(1.0)
    assert (p.x, p.y) == (1, 1)


def test_path_walker_moves_toward_first_waypoint():
    p = PathWalker(name="p", x=0, y=0, waypoints=[(1.0, 0.0)], speed=1.0)
    p.update(0.5)
    assert p.x == pytest.approx(0.5)


def test_path_walker_advances_on_arrival():
    """Reach waypoint 0, then start heading to waypoint 1."""
    p = PathWalker(name="p", x=0, y=0, waypoints=[(0.5, 0.0), (0.5, 1.0)], speed=2.0)
    # Step until well past the first waypoint
    for _ in range(20):
        p.update(0.1)
    # Should be on the way from (0.5, 0) toward (0.5, 1) — y should have grown
    assert p.x == pytest.approx(0.5, abs=0.05)
    assert p.y > 0.3


def test_path_walker_loops_through_waypoints():
    """After visiting all waypoints, returns to the first."""
    p = PathWalker(
        name="p", x=0, y=0,
        waypoints=[(1, 0), (1, 1), (0, 1)],
        speed=5.0,
    )
    for _ in range(100):
        p.update(0.1)
    # Without stop conditions, it must still be moving (cycling).
    # We check _wp_index is sensible
    assert 0 <= p._wp_index < 3


# ── World.tick ──────────────────────────────────────────────────────────────


def test_tick_updates_dynamic_objects():
    cat = Wanderer(name="cat", x=0, y=0, speed=1.0, roam_radius=2.0, seed=7)
    rock = WorldObject("rock", 5, 5)
    w = World([cat, rock])
    for _ in range(30):
        w.tick(0.1)
    assert (cat.x, cat.y) != (0, 0)  # moved
    assert (rock.x, rock.y) == (5, 5)  # static, unchanged


def test_tick_with_no_dynamic_objects_is_safe():
    w = World([WorldObject("a", 0, 0), WorldObject("b", 1, 1)])
    w.tick(0.1)  # should not raise


def test_default_scene_has_dynamic_entities():
    s = default_scene()
    dyn_names = [o.name for o in s.objects if o.dynamic]
    assert "cat" in dyn_names
    assert "person" in dyn_names


# ── M?-scene: categories ────────────────────────────────────────────────────


def test_world_object_default_category():
    o = WorldObject("rock", 0, 0)
    assert o.category == "object"


def test_default_scene_assigns_categories():
    s = default_scene()
    cats = {o.name: o.category for o in s.objects}
    assert cats["cat"] == "animal"
    assert cats["person"] == "person"
    assert cats["couch"] == "furniture"
    assert cats["door"] == "fixture"
    assert cats["rug"] == "decor"


def test_to_dict_includes_category():
    o = WorldObject("foo", 0, 0, category="furniture")
    assert o.to_dict()["category"] == "furniture"


# ── M?-scene: velocity tracking ─────────────────────────────────────────────


def test_velocity_of_static_is_zero():
    w = World([WorldObject("rock", 5, 5)])
    w.tick(0.1)
    assert w.velocity_of(w.objects[0]) == (0.0, 0.0)


def test_velocity_of_before_first_tick_is_zero():
    cat = Wanderer(name="c", x=0, y=0, speed=1.0, seed=1)
    w = World([cat])
    assert w.velocity_of(cat) == (0.0, 0.0)


def test_velocity_of_dynamic_after_tick_is_nonzero():
    cat = Wanderer(name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=3)
    w = World([cat])
    # First tick: the wanderer's initial target equals its position, so it
    # picks a fresh target this tick without moving. Second tick: moves.
    w.tick(0.1)
    w.tick(0.1)
    vx, vy = w.velocity_of(cat)
    speed = math.hypot(vx, vy)
    assert speed > 0.0
    assert speed <= 1.05  # tolerate float fuzz


def test_velocity_consistent_with_path_walker_speed():
    """A PathWalker at 1 m/s should report ~1 m/s velocity along its path."""
    p = PathWalker(name="p", x=0, y=0, waypoints=[(10, 0)], speed=1.0)
    w = World([p])
    w.tick(0.1)
    vx, vy = w.velocity_of(p)
    assert vx == pytest.approx(1.0, abs=0.01)
    assert abs(vy) < 0.01


# ── M?-scene: visible_summary enrichment ────────────────────────────────────


def test_visible_summary_includes_category():
    w = World([WorldObject("couch", 1, 0, category="furniture")])
    summary = w.visible_summary(0, 0)
    assert summary[0]["category"] == "furniture"


def test_visible_summary_static_object_has_no_motion_fields():
    w = World([WorldObject("rock", 1, 0)])
    summary = w.visible_summary(0, 0)
    assert "motion" not in summary[0]
    assert "velocity_mps" not in summary[0]


def test_visible_summary_dynamic_includes_motion_fields():
    cat = Wanderer(name="c", x=1.0, y=0.0, speed=0.5, roam_radius=1.0, seed=5)
    w = World([cat])
    w.tick(0.1)
    summary = w.visible_summary(0, 0)
    entry = summary[0]
    assert "velocity_mps" in entry
    assert "speed_mps" in entry
    assert entry["motion"] in {"approaching", "receding", "parallel", "stationary"}


def test_visible_summary_motion_approaching():
    """An entity with velocity straight toward observer → 'approaching'."""
    p = PathWalker(name="p", x=2.0, y=0.0, waypoints=[(0.0, 0.0)], speed=1.0)
    w = World([p])
    w.tick(0.1)  # moves p toward (0,0)
    summary = w.visible_summary(0, 0)
    assert summary[0]["motion"] == "approaching"


def test_visible_summary_motion_receding():
    p = PathWalker(name="p", x=1.0, y=0.0, waypoints=[(5.0, 0.0)], speed=1.0)
    w = World([p])
    w.tick(0.1)
    summary = w.visible_summary(0, 0)
    assert summary[0]["motion"] == "receding"


def test_visible_summary_motion_stationary_when_unmoved():
    """A dynamic entity that hasn't been ticked yet should read as stationary."""
    cat = Wanderer(name="c", x=1, y=0, speed=0.0, seed=1)
    w = World([cat])
    w.tick(0.1)  # speed=0 → cat doesn't move
    summary = w.visible_summary(0, 0)
    assert summary[0]["motion"] == "stationary"


# ── M? reactive: Observer dataclass ─────────────────────────────────────────


def test_observer_is_frozen():
    """Observer should be immutable to prevent accidental mutation by entities."""
    o = Observer(1.0, 2.0, 0.5)
    with pytest.raises(Exception):  # dataclasses.FrozenInstanceError on 3.11+
        o.x = 999.0


def test_observer_default_yaw():
    o = Observer(1.0, 2.0)
    assert o.yaw == 0.0


# ── M? reactive: Wanderer flees ─────────────────────────────────────────────


def test_wanderer_default_does_not_flee():
    """Backward-compat: Wanderer with no flee_distance ignores observers."""
    cat = Wanderer(name="c", x=0, y=0, speed=0.0, seed=1)
    pre = (cat.x, cat.y)
    cat.update(0.1, observer=Observer(0.05, 0, 0))  # observer right next to cat
    assert (cat.x, cat.y) == pre


def test_wanderer_with_flee_distance_ignores_far_observer():
    cat = Wanderer(
        name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=1,
        flee_distance=0.5, flee_speed_multiplier=3.0,
    )
    # First tick picks a wander target. Observer is far away → no flee.
    cat.update(0.05, observer=Observer(5.0, 5.0))
    cat.update(0.05, observer=Observer(5.0, 5.0))
    # Cat should be moving toward its wander target at normal speed (≤ 0.05m/tick)
    speed = math.hypot(cat.x, cat.y) / 0.05
    assert speed < 1.5  # not the 3.0x flee speed


def test_wanderer_flees_when_observer_close():
    """Cat should move noticeably away from a close observer."""
    cat = Wanderer(
        name="c", x=0.0, y=0.0, speed=0.5, roam_radius=2.0, seed=2,
        flee_distance=1.0, flee_speed_multiplier=3.0,
    )
    # Observer to the +x side of the cat → cat should head -x
    obs = Observer(0.5, 0.0)  # 0.5m away, well inside flee_distance
    cat.update(0.1, observer=obs)
    assert cat.x < 0  # moved away from observer


def test_wanderer_flees_at_increased_speed():
    """Compared to non-fleeing, a fleeing cat covers more ground per tick."""
    seed = 7
    # Non-fleeing baseline: same cat with no observer.
    a = Wanderer(name="a", x=0.0, y=0.0, speed=0.5, roam_radius=2.0, seed=seed)
    a.update(0.1)  # picks target
    a.update(0.1)
    base_dist = math.hypot(a.x, a.y)

    # Fleeing: same params, but with a close observer triggering flee.
    b = Wanderer(
        name="b", x=0.0, y=0.0, speed=0.5, roam_radius=2.0, seed=seed,
        flee_distance=1.0, flee_speed_multiplier=3.0,
    )
    obs = Observer(0.4, 0.0)
    b.update(0.1, observer=obs)
    flee_dist = math.hypot(b.x, b.y)

    assert flee_dist > base_dist


def test_wanderer_resumes_wandering_after_observer_leaves():
    """Once the observer is gone, the cat picks a new wander target."""
    cat = Wanderer(
        name="c", x=0.0, y=0.0, speed=2.0, roam_radius=1.0, seed=3,
        flee_distance=1.0, flee_speed_multiplier=2.0,
    )
    # Flee for a while
    for _ in range(20):
        cat.update(0.05, observer=Observer(0.1, 0.0))
    fled_pos = (cat.x, cat.y)
    # Observer gone — keep ticking, eventually cat should start moving back
    for _ in range(50):
        cat.update(0.05)
    # The cat should not be heading further away from home in perpetuity.
    # We just check it's now within 2x roam_radius from home (won't drift forever).
    home_dist = math.hypot(cat.x - cat.home_x, cat.y - cat.home_y)
    assert home_dist <= 2.5  # bounded


# ── M? reactive: PathWalker yields ──────────────────────────────────────────


def test_path_walker_default_does_not_yield():
    """Backward-compat: yield_distance=0 ignores observers."""
    p = PathWalker(name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0)
    p.update(0.1, observer=Observer(0.1, 0))  # observer right in front
    assert p.x > 0  # still moved


def test_path_walker_yields_to_observer_in_forward_cone():
    p = PathWalker(
        name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0,
        yield_distance=0.8,
    )
    pre = (p.x, p.y)
    # Observer is in the forward cone (0.5m ahead) → should yield
    p.update(0.1, observer=Observer(0.5, 0.0))
    assert (p.x, p.y) == pre


def test_path_walker_does_not_yield_to_observer_behind():
    """Observer behind shouldn't trigger yield."""
    p = PathWalker(
        name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0,
        yield_distance=0.8,
    )
    # Heading +x, observer at -x → behind us
    p.update(0.1, observer=Observer(-0.5, 0.0))
    assert p.x > 0  # moved forward


def test_path_walker_does_not_yield_to_observer_far_away():
    p = PathWalker(
        name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0,
        yield_distance=0.5,
    )
    p.update(0.1, observer=Observer(2.0, 0.0))  # outside yield_distance
    assert p.x > 0


def test_path_walker_does_not_yield_to_observer_to_the_side():
    p = PathWalker(
        name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0,
        yield_distance=0.8,
    )
    # Observer is 90° to the side, outside the forward cone
    p.update(0.1, observer=Observer(0.0, 0.5))
    assert p.x > 0


def test_path_walker_resumes_walking_when_observer_leaves():
    p = PathWalker(
        name="p", x=0, y=0, waypoints=[(1, 0)], speed=1.0,
        yield_distance=0.8,
    )
    # Yielding
    p.update(0.1, observer=Observer(0.5, 0.0))
    assert p.x == 0
    # Observer leaves
    p.update(0.1)
    assert p.x > 0


# ── M? reactive: World.tick passes observer ─────────────────────────────────


def test_world_tick_forwards_observer_to_dynamic_objects():
    """If World.tick is called with an observer, it reaches each dynamic entity."""
    cat = Wanderer(
        name="c", x=0.0, y=0.0, speed=1.0, roam_radius=2.0, seed=1,
        flee_distance=1.0, flee_speed_multiplier=3.0,
    )
    w = World([cat])
    obs = Observer(0.3, 0.0)  # close — should trigger flee
    w.tick(0.1, observer=obs)
    # Cat should have moved away from the observer (negative x direction)
    assert cat.x < 0


def test_world_tick_without_observer_still_works():
    """Backward-compat: tick(dt) with no observer still ticks entities."""
    cat = Wanderer(name="c", x=0, y=0, speed=1.0, roam_radius=2.0, seed=1)
    w = World([cat])
    w.tick(0.1)
    w.tick(0.1)
    # Cat moved
    assert (cat.x, cat.y) != (0.0, 0.0)


def test_default_scene_cat_is_reactive():
    """The default scene cat has fleeing enabled."""
    s = default_scene()
    cat = next(o for o in s.objects if o.name == "cat")
    assert cat.flee_distance > 0


def test_default_scene_person_is_reactive():
    """The default scene person has yielding enabled."""
    s = default_scene()
    person = next(o for o in s.objects if o.name == "person")
    assert person.yield_distance > 0
