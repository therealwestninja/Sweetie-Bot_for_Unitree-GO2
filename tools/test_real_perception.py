"""RealPerception tests — direct, no SDK / DDS involved."""

from __future__ import annotations

from sweetie.core.real_perception import RealPerception


def _far():
    """A range_obstacle tuple where every quadrant is far."""
    return (10.0, 10.0, 10.0, 10.0)


def _near_front():
    """Front quadrant near, others far."""
    return (1.0, 10.0, 10.0, 10.0)


def test_initial_far_emits_nothing():
    p = RealPerception()
    p.tick(0, 0, 0, _far())
    assert p.drain_new_events() == []
    assert p.recent_events() == []


def test_initial_near_emits_obstacle_event():
    p = RealPerception()
    p.tick(0, 0, 0, _near_front())
    events = p.drain_new_events()
    assert len(events) == 1
    assert "front" in events[0]


def test_far_to_near_transition_emits():
    p = RealPerception()
    p.tick(0, 0, 0, _far())
    p.drain_new_events()  # baseline
    p.tick(0, 0, 0, _near_front())
    events = p.drain_new_events()
    assert any("front" in e and "entered" in e for e in events)


def test_near_to_far_transition_emits_cleared():
    p = RealPerception()
    p.tick(0, 0, 0, _near_front())
    p.drain_new_events()  # baseline
    p.tick(0, 0, 0, _far())
    events = p.drain_new_events()
    assert any("front" in e and "cleared" in e for e in events)


def test_hysteresis_prevents_flapping_at_threshold():
    """An obstacle right at the threshold shouldn't flap entered/cleared."""
    p = RealPerception(near_threshold_m=2.0, hysteresis_m=0.30)
    # Start near
    p.tick(0, 0, 0, (1.5, 10.0, 10.0, 10.0))
    p.drain_new_events()  # baseline
    # Move just past threshold (within hysteresis band) — must NOT clear
    p.tick(0, 0, 0, (2.1, 10.0, 10.0, 10.0))
    assert p.drain_new_events() == []
    # Move outside hysteresis band — must clear
    p.tick(0, 0, 0, (2.5, 10.0, 10.0, 10.0))
    events = p.drain_new_events()
    assert any("cleared" in e for e in events)


def test_each_quadrant_tracked_independently():
    p = RealPerception()
    p.tick(0, 0, 0, _far())
    p.drain_new_events()
    # Front and right both go near
    p.tick(0, 0, 0, (1.0, 10.0, 10.0, 1.5))
    events = p.drain_new_events()
    assert any("front" in e for e in events)
    assert any("right" in e for e in events)
    assert not any("left" in e for e in events)
    assert not any("back" in e for e in events)


def test_drain_clears_buffer():
    p = RealPerception()
    p.tick(0, 0, 0, _near_front())
    p.drain_new_events()
    assert p.drain_new_events() == []


def test_recent_events_persists_after_drain():
    """Drain only clears the new-events buffer; the rolling log stays."""
    p = RealPerception()
    p.tick(0, 0, 0, _near_front())
    p.drain_new_events()
    assert len(p.recent_events()) == 1


def test_vision_summary_returns_empty_no_detector():
    p = RealPerception()
    p.tick(0, 0, 0, _near_front())
    assert p.vision_summary(0, 0, 0) == []


def test_tick_no_op_when_range_obstacle_missing():
    """Bridge must always supply range_obstacle; absence is no-op, not crash."""
    p = RealPerception()
    p.tick(0, 0, 0, None)
    p.tick(0, 0, 0, (1.0, 2.0))  # wrong arity
    assert p.drain_new_events() == []
