"""
SafetyGuard tests. These define what "safety" actually means in this codebase.

If you change behaviour, change the test first.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import pytest

from sweetie.core.safety import (
    BATTERY_LOW_PERCENT,
    HEARTBEAT_TIMEOUT_S,
    TILT_LIMIT_RAD,
    VX_LIMIT,
    VY_LIMIT,
    VYAW_LIMIT,
    SafetyGuard,
    SafetyState,
)


@dataclass
class FakeRobot:
    battery_percent: float = 100.0
    roll: float = 0.0
    pitch: float = 0.0


# ── State machine transitions ────────────────────────────────────────────────


def test_starts_idle():
    assert SafetyGuard().state == SafetyState.IDLE


def test_arm_idle_to_armed():
    g = SafetyGuard()
    assert g.arm() is True
    assert g.state == SafetyState.ARMED


def test_arm_from_active_is_idempotent_noop():
    g = SafetyGuard()
    g.arm()
    g.heartbeat()
    assert g.state == SafetyState.ACTIVE
    g.arm()  # should not change state
    assert g.state == SafetyState.ACTIVE


def test_heartbeat_promotes_armed_to_active():
    g = SafetyGuard()
    g.arm()
    g.heartbeat()
    assert g.state == SafetyState.ACTIVE


def test_heartbeat_does_nothing_in_idle():
    g = SafetyGuard()
    g.heartbeat()
    assert g.state == SafetyState.IDLE


def test_estop_latches_from_any_state():
    for start in (SafetyState.IDLE, SafetyState.ARMED, SafetyState.ACTIVE):
        g = SafetyGuard()
        g.state = start
        g.estop()
        assert g.state == SafetyState.ESTOP


def test_arm_blocked_from_estop():
    g = SafetyGuard()
    g.estop()
    assert g.arm() is False
    assert g.state == SafetyState.ESTOP


def test_clear_estop_returns_to_idle():
    g = SafetyGuard()
    g.estop()
    assert g.clear_estop() is True
    assert g.state == SafetyState.IDLE


def test_clear_estop_only_works_from_estop():
    g = SafetyGuard()
    assert g.clear_estop() is False  # was IDLE
    g.arm()
    assert g.clear_estop() is False  # was ARMED


def test_disarm_from_armed_or_active_returns_to_idle():
    g = SafetyGuard()
    g.arm()
    g.disarm()
    assert g.state == SafetyState.IDLE
    g.arm(); g.heartbeat()
    g.disarm()
    assert g.state == SafetyState.IDLE


# ── Predicate tick ───────────────────────────────────────────────────────────


def test_tick_demotes_active_to_armed_after_heartbeat_timeout(monkeypatch):
    g = SafetyGuard()
    g.arm()
    g.heartbeat()
    assert g.state == SafetyState.ACTIVE

    # Fast-forward monotonic clock past the timeout.
    base = time.monotonic()
    monkeypatch.setattr(time, "monotonic", lambda: base + HEARTBEAT_TIMEOUT_S + 0.1)
    g.tick(FakeRobot())
    assert g.state == SafetyState.ARMED


def test_tick_estops_on_low_battery():
    g = SafetyGuard()
    g.arm()
    g.tick(FakeRobot(battery_percent=BATTERY_LOW_PERCENT - 0.1))
    assert g.state == SafetyState.ESTOP


def test_tick_estops_on_excess_tilt():
    g = SafetyGuard()
    g.arm()
    g.tick(FakeRobot(roll=TILT_LIMIT_RAD + 0.01))
    assert g.state == SafetyState.ESTOP

    g2 = SafetyGuard()
    g2.arm()
    g2.tick(FakeRobot(pitch=-TILT_LIMIT_RAD - 0.01))
    assert g2.state == SafetyState.ESTOP


# ── Command guard ────────────────────────────────────────────────────────────


def test_guard_rejects_when_idle():
    g = SafetyGuard()
    r = g.guard(0.5, 0, 0)
    assert r.allowed is False
    assert "armed" in r.reason


def test_guard_rejects_when_armed_no_heartbeat():
    g = SafetyGuard()
    g.arm()
    r = g.guard(0.5, 0, 0)
    assert r.allowed is False
    assert "heartbeat" in r.reason


def test_guard_rejects_when_estopped():
    g = SafetyGuard()
    g.estop()
    r = g.guard(0.5, 0, 0)
    assert r.allowed is False
    assert "estop" in r.reason


def test_guard_passes_in_active():
    g = SafetyGuard()
    g.arm(); g.heartbeat()
    r = g.guard(0.5, 0.1, -0.3)
    assert r.allowed
    assert r.vx == pytest.approx(0.5)
    assert r.vy == pytest.approx(0.1)
    assert r.vyaw == pytest.approx(-0.3)


def test_guard_clamps_to_envelope():
    g = SafetyGuard()
    g.arm(); g.heartbeat()
    r = g.guard(99.0, -99.0, 99.0)
    assert r.vx == pytest.approx(VX_LIMIT)
    assert r.vy == pytest.approx(-VY_LIMIT)
    assert r.vyaw == pytest.approx(VYAW_LIMIT)


# ── Action guard (non-motion) ────────────────────────────────────────────────


def test_guard_action_report_always_allowed():
    g = SafetyGuard()
    assert g.guard_action("report").allowed
    g.estop()
    assert g.guard_action("report").allowed


def test_guard_action_halt_always_allowed():
    g = SafetyGuard()
    # IDLE
    assert g.guard_action("halt").allowed
    # ARMED
    g.arm()
    assert g.guard_action("halt").allowed
    # ACTIVE
    g.heartbeat()
    assert g.guard_action("halt").allowed
    # ESTOP
    g.estop()
    assert g.guard_action("halt").allowed


def test_guard_action_stand_up_requires_armed():
    g = SafetyGuard()
    r = g.guard_action("stand_up")
    assert not r.allowed and "armed" in r.reason
    g.arm()
    assert g.guard_action("stand_up").allowed


def test_guard_action_sit_down_requires_armed():
    g = SafetyGuard()
    assert not g.guard_action("sit_down").allowed
    g.arm()
    assert g.guard_action("sit_down").allowed


def test_guard_action_blocked_by_estop():
    g = SafetyGuard()
    g.estop()
    r = g.guard_action("stand_up")
    assert not r.allowed and "estop" in r.reason


def test_guard_action_unknown_action_rejected():
    g = SafetyGuard()
    r = g.guard_action("teleport")
    assert not r.allowed and "unknown" in r.reason


# ── M4: proximity-aware velocity scaling ────────────────────────────────────


from dataclasses import dataclass as _dc
from sweetie.core.safety import (  # noqa: E402
    OBSTACLE_HARD_FLOOR,
    OBSTACLE_SLOWDOWN_START,
)


@_dc
class _FakeStateWithRanges:
    """Minimal state shim — guard() only reads .range_obstacle."""

    range_obstacle: list


def _active_guard() -> SafetyGuard:
    g = SafetyGuard()
    g.arm()
    g.heartbeat()
    return g


def _state(front=10.0, left=10.0, back=10.0, right=10.0):
    return _FakeStateWithRanges(range_obstacle=[front, left, back, right])


def test_guard_no_state_means_no_proximity_scaling():
    g = _active_guard()
    r = g.guard(0.5, 0, 0)  # state=None
    assert r.allowed
    assert r.vx == pytest.approx(0.5)
    assert r.assists == []


def test_guard_clear_ranges_no_assists():
    g = _active_guard()
    r = g.guard(0.5, 0.0, 0.0, state=_state())  # all 10m clear
    assert r.allowed
    assert r.vx == pytest.approx(0.5)
    assert r.assists == []


def test_guard_scales_forward_for_front_obstacle():
    g = _active_guard()
    # Front obstacle at midpoint between hard floor and slowdown start.
    mid = (OBSTACLE_HARD_FLOOR + OBSTACLE_SLOWDOWN_START) / 2
    r = g.guard(1.0, 0, 0, state=_state(front=mid))
    assert r.allowed
    # Expected scale: 0.5 (linear)
    assert r.vx == pytest.approx(0.5, abs=0.01)
    assert any("slowed" in a and "front" in a for a in r.assists)


def test_guard_blocks_forward_inside_hard_floor():
    g = _active_guard()
    r = g.guard(1.0, 0, 0, state=_state(front=OBSTACLE_HARD_FLOOR / 2))
    assert r.allowed  # the command still "passes" — just zeroed
    assert r.vx == pytest.approx(0.0)
    assert any("blocked" in a for a in r.assists)


def test_guard_does_not_scale_reverse_when_front_blocked():
    """A close-front obstacle must NOT slow reverse motion."""
    g = _active_guard()
    r = g.guard(-0.8, 0, 0, state=_state(front=0.1))
    assert r.allowed
    assert r.vx == pytest.approx(-0.8)
    assert r.assists == []


def test_guard_scales_reverse_for_back_obstacle():
    g = _active_guard()
    r = g.guard(-1.0, 0, 0, state=_state(back=OBSTACLE_HARD_FLOOR / 2))
    assert r.vx == pytest.approx(0.0)
    assert any("blocked" in a and "back" in a for a in r.assists)


def test_guard_scales_strafe_left():
    g = _active_guard()
    mid = (OBSTACLE_HARD_FLOOR + OBSTACLE_SLOWDOWN_START) / 2
    r = g.guard(0, 0.5, 0, state=_state(left=mid))
    assert r.vy == pytest.approx(0.25, abs=0.01)
    assert any("left" in a for a in r.assists)


def test_guard_scales_strafe_right_when_going_right():
    g = _active_guard()
    r = g.guard(0, -0.5, 0, state=_state(right=OBSTACLE_HARD_FLOOR / 2))
    assert r.vy == pytest.approx(0.0)
    assert any("right" in a for a in r.assists)


def test_guard_yaw_never_scaled():
    g = _active_guard()
    # Even with everything at the hard floor, yaw passes through unchanged.
    r = g.guard(0, 0, 1.0, state=_state(front=0.1, left=0.1, back=0.1, right=0.1))
    assert r.vyaw == pytest.approx(1.0)


def test_guard_multiple_axes_each_scaled_independently():
    g = _active_guard()
    # Forward AND strafe-left, both with close obstacles → both scaled.
    r = g.guard(0.5, 0.3, 0, state=_state(front=0.5, left=0.5))
    assert r.vx < 0.5
    assert r.vy < 0.3
    assert len(r.assists) == 2  # one for front, one for left


# ── M4: assist log ──────────────────────────────────────────────────────────


def test_recent_assists_empty_initially():
    g = SafetyGuard()
    assert g.recent_assists() == []


def test_record_and_retrieve_assist():
    g = SafetyGuard()
    g.record_assist("slowed (front 0.40m)")
    log = g.recent_assists()
    assert len(log) == 1
    assert log[0]["reason"] == "slowed (front 0.40m)"
    assert log[0]["age_s"] >= 0


def test_recent_assists_window_excludes_old(monkeypatch):
    g = SafetyGuard()
    base = time.time()
    # Manually insert an old event
    g._assist_log.append((base - 100, "ancient"))
    g._assist_log.append((base - 1, "recent"))
    monkeypatch.setattr(time, "time", lambda: base)
    log = g.recent_assists(window_s=10)
    reasons = [e["reason"] for e in log]
    assert "ancient" not in reasons
    assert "recent" in reasons


def test_assist_log_capped():
    """The deque is bounded; old entries fall off when full."""
    g = SafetyGuard()
    for i in range(50):
        g.record_assist(f"event-{i}")
    log = g.recent_assists(window_s=1e9)
    # Should be at most ASSIST_LOG_MAX (= 16) entries
    from sweetie.core.safety import ASSIST_LOG_MAX
    assert len(log) <= ASSIST_LOG_MAX
