"""
Tests for the local obstacle-avoidance reflex (sweetie/core/avoidance.py).

Two layers:

1. Pure-function checks on `steer()` — the heading/active/clearance/speed
   contract, in isolation. No robot, no time.
2. Integration drives — a compact harness that mirrors the real pipeline
   (`SimBridge._integrate`'s turn-then-drive nav math **plus** the safety
   guard's front-quadrant proximity slowdown from `core/safety.py`) and
   runs a virtual robot from a start to a goal past obstacles. The harness
   is embedded here on purpose so the test is self-contained — it asserts
   the behaviour the reflex promises without needing the whole bridge.

The promise, stated as invariants:

- **Hard invariant, every scenario:** the robot never penetrates an
  obstacle (edge distance never goes negative). This holds even in traps.
- **Reaches the goal** for an isolated obstacle and for genuinely
  passable fields (a clear corridor exists).
- **May stall, must not collide** against a wall or in a concave pocket —
  no local "graze this edge" solution exists, so the reflex parks the
  robot and (in the live system) the LLM re-plans next tick. This is the
  documented boundary between a local reflex and a global planner, which
  the ROADMAP keeps out of scope.

Runs under `asyncio_mode = "auto"`, but these tests are synchronous.
"""

from __future__ import annotations

import math

import pytest

from sweetie.core.avoidance import AvoidanceConfig, SteerResult, steer


# ── Faithful nav + safety integration harness ────────────────────────────────
# Constants copied from core/bridge.py and core/safety.py so the drive
# matches the real pipeline a deployed reflex would run inside.

_NAV_SPEED = 0.4
_NAV_KP = 0.5
_VYAW_LIMIT = 2.0
_YAW_KP = 2.5
_NAV_HEADING_TOL = math.radians(25.0)
_NAV_ARRIVAL_TOL = 0.20
_DT = 0.1
_HARD_FLOOR = 0.3        # OBSTACLE_HARD_FLOOR
_SLOWDOWN_START = 1.0    # OBSTACLE_SLOWDOWN_START
_PROX_MAX = 3.0


def _wrap(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


def _front_range(x, y, yaw, obstacles):
    """Front-quadrant proximity — mirror of World.proximity_ranges[FRONT]."""
    cy, sy = math.cos(-yaw), math.sin(-yaw)
    best = _PROX_MAX
    for (ox, oy, orad) in obstacles:
        dx, dy = ox - x, oy - y
        rx = dx * cy - dy * sy
        ry = dx * sy + dy * cy
        edge = max(0.0, math.hypot(rx, ry) - orad)
        if edge >= _PROX_MAX:
            continue
        ang = math.atan2(ry, rx)
        if -math.pi / 4 <= ang < math.pi / 4:
            best = min(best, edge)
    return best


def _prox_scale(r):
    """Mirror of safety._proximity_scale."""
    if r >= _SLOWDOWN_START:
        return 1.0
    if r <= _HARD_FLOOR:
        return 0.0
    return (r - _HARD_FLOOR) / (_SLOWDOWN_START - _HARD_FLOOR)


def _drive(start, goal, obstacles, cfg=None, max_steps=3000):
    """Run a virtual robot start→goal with the avoidance reflex active.

    Returns dict(reached, collided, min_edge, steps, end).
    """
    x, y = start
    yaw = math.atan2(goal[1] - y, goal[0] - x)
    min_edge = math.inf
    collided = False
    for i in range(max_steps):
        dx, dy = goal[0] - x, goal[1] - y
        dist = math.hypot(dx, dy)
        if dist < _NAV_ARRIVAL_TOL:
            return dict(reached=True, collided=collided, min_edge=min_edge,
                        steps=i, end=(x, y))
        res = steer(x, y, goal[0], goal[1], obstacles, cfg)
        ye = _wrap(res.heading - yaw)
        if abs(ye) > _NAV_HEADING_TOL:
            vyaw = max(-_VYAW_LIMIT, min(_VYAW_LIMIT, _YAW_KP * ye))
            vx = 0.0
        else:
            vx = min(_NAV_SPEED, _NAV_KP * dist) * res.speed_scale
            vyaw = max(-_VYAW_LIMIT, min(_VYAW_LIMIT, 0.5 * ye))
        if vx > 0:  # safety front-quadrant slowdown
            vx *= _prox_scale(_front_range(x, y, yaw, obstacles))
        x += vx * math.cos(yaw) * _DT
        y += vx * math.sin(yaw) * _DT
        yaw = _wrap(yaw + vyaw * _DT)
        for (ox, oy, orad) in obstacles:
            edge = math.hypot(ox - x, oy - y) - orad
            min_edge = min(min_edge, edge)
            if edge < 0:
                collided = True
    return dict(reached=False, collided=collided, min_edge=min_edge,
                steps=max_steps, end=(x, y))


# ── Pure-function contract ───────────────────────────────────────────────────

def test_clear_path_is_a_passthrough():
    r = steer(0, 0, 5, 0, [])
    assert r.active is False
    assert r.speed_scale == 1.0
    assert math.isclose(r.heading, 0.0, abs_tol=1e-9)
    assert r.min_clearance == math.inf


def test_isolated_obstacle_deflects_heading():
    # Obstacle within the look-ahead (edge ≈ 0.55 m < 1.5 m) and dead ahead.
    r = steer(0, 0, 6, 0, [(1.2, 0, 0.4)])
    assert r.active is True
    assert abs(_wrap(r.heading - 0.0)) > math.radians(5)  # bent off the straight line


def test_obstacle_outside_lookahead_not_yet_engaged():
    # Same obstacle far ahead (edge 2.25 m > 1.5 m look-ahead): no deflection
    # *yet* — the reflex engages as the robot closes, not from across the room.
    r = steer(0, 0, 6, 0, [(3, 0, 0.5)])
    assert r.active is False
    assert r.min_clearance == pytest.approx(2.25)


def test_obstacle_off_to_the_side_does_not_deflect():
    # Centre well outside the corridor → no deflection, but clearance still seen.
    r = steer(0, 0, 6, 0, [(3, 3.0, 0.4)])
    assert r.active is False
    assert r.min_clearance < math.inf


def test_obstacle_behind_is_ignored():
    r = steer(0, 0, 6, 0, [(-2, 0, 0.5)])
    assert r.active is False


def test_obstacle_beyond_goal_is_ignored():
    r = steer(0, 0, 3, 0, [(6, 0, 0.5)])
    assert r.active is False


def test_speed_scale_ramps_with_blocker_proximity():
    far = steer(0, 0, 8, 0, [(7.0, 0, 0.4)])   # blocker near the goal, far from us
    near = steer(0, 0, 8, 0, [(1.0, 0, 0.4)])  # blocker right in front of us
    assert near.speed_scale < far.speed_scale
    assert near.speed_scale >= AvoidanceConfig().speed_floor - 1e-9


def test_arrival_attenuation_reduces_deflection_near_goal():
    # Same obstacle geometry relative to the robot, but the goal is far in
    # one case and very close in the other. Closer goal → less deflection.
    far_goal = steer(0, 0, 6.0, 0, [(0.8, 0.0, 0.4)])
    near_goal = steer(0, 0, 0.5, 0, [(0.8, 0.0, 0.4)])
    far_def = abs(_wrap(far_goal.heading - math.atan2(0, 6.0)))
    near_def = abs(_wrap(near_goal.heading - math.atan2(0, 0.5)))
    assert near_def < far_def


def test_dead_ahead_tie_break_is_deterministic():
    # Perfectly dead-ahead obstacle within look-ahead: side choice must be
    # stable, not random.
    a = steer(0, 0, 6, 0, [(1.2, 0, 0.4)]).heading
    b = steer(0, 0, 6, 0, [(1.2, 0, 0.4)]).heading
    assert a == b


def test_at_goal_is_safe_noop():
    r = steer(2, 2, 2, 2, [(2, 2, 0.4)])
    assert r.active is False


# ── Integration: reaches goal, never collides ───────────────────────────────

NEVER_COLLIDE_CASES = {
    "clear":            ((0, 0), (5, 0), []),
    "isolated_ahead":   ((0, 0), (6, 0), [(3, 0, 0.5)]),
    "side":             ((0, 0), (6, 0), [(3, 2.5, 0.5)]),
    "goal_beside_obs":  ((0, 0), (3.0, 0), [(4.0, 0, 0.5)]),   # 0.5 m gap to edge
    "string_of_beads":  ((0, 0), (8, 0), [(2, 0, 0.4), (4, 0, 0.4), (6, 0, 0.4)]),
    "alternating_lane": ((0, 0), (8, 0), [(2, 0.8, 0.4), (4, -0.8, 0.4), (6, 0.8, 0.4)]),
    "passable_field":   ((0, 0), (9, 0), [(2, 0.6, 0.4), (3.5, -0.7, 0.4),
                                          (5, 0.7, 0.4), (6.5, -0.6, 0.4), (8, 0.5, 0.4)]),
}


@pytest.mark.parametrize("name", list(NEVER_COLLIDE_CASES))
def test_reaches_goal_without_colliding(name):
    start, goal, obs = NEVER_COLLIDE_CASES[name]
    r = _drive(start, goal, obs)
    assert r["collided"] is False, f"{name}: collided (min_edge={r['min_edge']:.2f})"
    assert r["reached"] is True, f"{name}: did not reach (end={r['end']})"
    assert r["min_edge"] >= 0.0


# ── Integration: honest local limits — never collide, may stall ──────────────

TRAP_CASES = {
    "wall":        ((0, 0), (6, 0), [(3, -1.2, 0.6), (3, 0, 0.6), (3, 1.2, 0.6)]),
    "tight_gate":  ((0, 0), (7, 0), [(4.5, -0.3, 0.4), (5.0, 0.6, 0.4)]),
    "deep_pocket": ((0, 0), (6, 0), [(2.5, -0.7, 0.5), (2.5, 0.7, 0.5),
                                     (3.3, -0.7, 0.5), (3.3, 0.7, 0.5), (3.8, 0, 0.5)]),
}


@pytest.mark.parametrize("name", list(TRAP_CASES))
def test_traps_never_collide_even_if_stalled(name):
    """A local reflex may fail to *reach* through a wall/pocket — but it
    must never drive *into* one. (If it stalls, the live LLM re-plans.)"""
    start, goal, obs = TRAP_CASES[name]
    r = _drive(start, goal, obs)
    assert r["collided"] is False, f"{name}: collided (min_edge={r['min_edge']:.2f})"
    assert r["min_edge"] >= 0.0
