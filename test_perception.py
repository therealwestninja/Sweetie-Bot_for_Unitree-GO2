"""SimPerception tests — direct, not via the bridge."""

from __future__ import annotations

import math
import time

import pytest

from sweetie.sim.perception import SimPerception
from sweetie.sim.world import PathWalker, Wanderer, World, WorldObject


def test_recent_events_empty_initially():
    p = SimPerception(World([]))
    assert p.recent_events() == []


def test_tick_with_static_objects_emits_no_quadrant_events():
    """Static objects don't generate quadrant transitions (those are dynamic-only).

    Vision-entry events ARE allowed for statics — they fire as the robot
    moves and previously-hidden objects come into view. This test only
    asserts that the quadrant pipeline ignores statics.
    """
    w = World([WorldObject("rock", x=10.0, y=0.0)])  # placed far so it isn't in view
    p = SimPerception(w)
    p.tick(0.0, 0.0, 0.0)
    p.tick(0.0, 0.0, 0.0)
    events = [e["event"] for e in p.recent_events()]
    # No "in front" / "left visible range" / "entered range" events from a static rock.
    quadrant_words = ("front quadrant", "entered range", "left visible range")
    assert not any(any(w in e for w in quadrant_words) for e in events)


def test_tick_emits_initial_observation_for_dynamic_in_range():
    cat = Wanderer(name="cat", x=1.0, y=0.0, speed=0.0)
    w = World([cat])
    p = SimPerception(w)
    p.tick(0.0, 0.0, 0.0)
    events = [e["event"] for e in p.recent_events()]
    assert any("cat" in e and "front" in e for e in events)


def test_tick_does_not_emit_initial_observation_when_far():
    """An entity that starts beyond perception range should not be 'initially' logged."""
    cat = Wanderer(name="cat", x=10.0, y=0.0, speed=0.0)
    w = World([cat])
    p = SimPerception(w)
    p.tick(0.0, 0.0, 0.0)
    assert p.recent_events() == []


def test_far_classification_at_edge():
    """Entity beyond PERCEPTION_RANGE classifies as 'far'."""
    p = SimPerception(World([]))
    q = p._classify_quadrant(0, 0, 0, p.PERCEPTION_RANGE + 0.5, 0)
    assert q == "far"


def test_quadrant_classification():
    """Robot at origin facing +x: targets in each quadrant classify correctly."""
    p = SimPerception(World([]))
    assert p._classify_quadrant(0, 0, 0, 1.0, 0.0) == "front"
    assert p._classify_quadrant(0, 0, 0, 0.0, 1.0) == "left"
    assert p._classify_quadrant(0, 0, 0, -1.0, 0.0) == "back"
    assert p._classify_quadrant(0, 0, 0, 0.0, -1.0) == "right"


def test_perception_emits_entered_range_event():
    """Entity that starts far and walks closer should generate an 'entered range' event."""
    walker = PathWalker(name="walker", x=10.0, y=0.0, waypoints=[(0.5, 0.0)], speed=20.0)
    w = World([walker])
    p = SimPerception(w)
    # First tick: walker is far → no event recorded (other than nothing)
    p.tick(0.0, 0.0, 0.0)
    # Now move walker closer — simulate by walking
    w.tick(1.0)  # 20 m/s × 1 s = 20m, should arrive at waypoint
    p.tick(0.0, 0.0, 0.0)
    events = [e["event"] for e in p.recent_events()]
    assert any("entered range" in e for e in events)


def test_perception_emits_left_range_event():
    walker = PathWalker(name="walker", x=1.0, y=0.0, waypoints=[(50.0, 0.0)], speed=100.0)
    w = World([walker])
    p = SimPerception(w)
    p.tick(0.0, 0.0, 0.0)  # initial in front
    w.tick(0.5)  # walker is now far away
    p.tick(0.0, 0.0, 0.0)
    events = [e["event"] for e in p.recent_events()]
    assert any("left visible range" in e for e in events)


def test_perception_emits_now_in_front_when_quadrant_changes():
    """Walker moving from left quadrant into front."""
    walker = PathWalker(name="walker", x=0.0, y=1.5, waypoints=[(1.0, 0.0)], speed=2.0)
    w = World([walker])
    p = SimPerception(w)
    p.tick(0.0, 0.0, 0.0)  # walker on the left
    # Step until it crosses into front
    for _ in range(20):
        w.tick(0.1)
        p.tick(0.0, 0.0, 0.0)
    events = [e["event"] for e in p.recent_events()]
    assert any("walker" in e and "in front" in e for e in events)


def test_recent_events_excludes_old_entries(monkeypatch):
    p = SimPerception(World([]))
    base = time.time()
    p._event_log.append((base - 100, "ancient"))
    p._event_log.append((base - 1, "recent"))
    monkeypatch.setattr(time, "time", lambda: base)
    log = p.recent_events(window_s=10)
    reasons = [e["event"] for e in log]
    assert "ancient" not in reasons
    assert "recent" in reasons


# ── Vision: FOV cone + occlusion ────────────────────────────────────────────


def test_vision_summary_empty_when_nothing_in_front():
    """Robot facing +x, entity directly behind it → not in vision."""
    w = World([WorldObject("rock", x=-2.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    summary = p.vision_summary(0, 0, 0)
    assert summary == []


def test_vision_summary_sees_entity_in_front():
    w = World([WorldObject("rock", x=2.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    summary = p.vision_summary(0, 0, 0)
    assert len(summary) == 1
    assert summary[0]["name"] == "rock"
    assert summary[0]["distance_m"] == pytest.approx(2.0)
    assert abs(summary[0]["bearing_deg"]) < 1.0  # straight ahead


def test_vision_excludes_objects_outside_fov():
    """An object 90° to the side is outside the ~70° cone."""
    w = World([WorldObject("side", x=0.0, y=2.0, radius=0.3)])
    p = SimPerception(w)
    assert p.vision_summary(0, 0, 0) == []


def test_vision_respects_yaw():
    """Rotating the robot 90° (facing +y) brings the side object into view."""
    w = World([WorldObject("side", x=0.0, y=2.0, radius=0.3)])
    p = SimPerception(w)
    summary = p.vision_summary(0, 0, math.pi / 2)
    assert len(summary) == 1
    assert summary[0]["name"] == "side"


def test_vision_excludes_objects_beyond_range():
    from sweetie.sim.perception import VISION_RANGE
    w = World([WorldObject("far", x=VISION_RANGE + 1.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    assert p.vision_summary(0, 0, 0) == []


def test_vision_occlusion_blocks_far_object():
    """A close obstacle directly in front blocks a far object behind it."""
    w = World([
        WorldObject("near", x=1.0, y=0.0, radius=0.5),
        WorldObject("far",  x=3.0, y=0.0, radius=0.3),
    ])
    p = SimPerception(w)
    summary = p.vision_summary(0, 0, 0)
    names = [s["name"] for s in summary]
    assert "near" in names
    assert "far" not in names  # blocked


def test_vision_occlusion_does_not_self_occlude():
    """An object should never occlude itself."""
    w = World([WorldObject("only", x=2.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    summary = p.vision_summary(0, 0, 0)
    assert len(summary) == 1


def test_vision_passable_terrain_does_not_occlude():
    """A passable hill in front of a real obstacle shouldn't hide it."""
    w = World([
        WorldObject("hill", x=1.0, y=0.0, radius=1.0,
                    obstacle=False, category="terrain"),
        WorldObject("box",  x=3.0, y=0.0, radius=0.3),
    ])
    p = SimPerception(w)
    names = [s["name"] for s in p.vision_summary(0, 0, 0)]
    assert "box" in names  # passable hill doesn't block sight


def test_vision_skips_tiny_static_objects():
    """Fence posts (radius 0.05) shouldn't clutter vision_summary."""
    w = World([
        WorldObject("post", x=2.0, y=0.0, radius=0.05),
        WorldObject("rock", x=2.0, y=-0.3, radius=0.3),
    ])
    p = SimPerception(w)
    names = [s["name"] for s in p.vision_summary(0, 0, 0)]
    assert "post" not in names
    assert "rock" in names


def test_vision_includes_dynamic_entities_even_if_tiny():
    """A small cat should still appear (dynamic = always interesting)."""
    cat = Wanderer(name="cat", x=2.0, y=0.0, radius=0.05, speed=0.0)
    w = World([cat])
    p = SimPerception(w)
    names = [s["name"] for s in p.vision_summary(0, 0, 0)]
    assert "cat" in names


def test_vision_event_fires_on_entry_into_view():
    w = World([WorldObject("box", x=2.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    p.tick(0, 0, 0)  # box enters view
    events = [e["event"] for e in p.recent_events()]
    assert any("box" in e and "entered view" in e for e in events)


def test_vision_event_fires_on_leaving_view():
    w = World([WorldObject("box", x=2.0, y=0.0, radius=0.3)])
    p = SimPerception(w)
    p.tick(0, 0, 0)            # entered view
    p.tick(0, 0, math.pi)      # robot turned around — box now behind
    events = [e["event"] for e in p.recent_events()]
    assert any("box" in e and "left view" in e for e in events)
