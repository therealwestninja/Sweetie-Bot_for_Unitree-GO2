"""
Local obstacle avoidance — a reactive steering reflex under the planner.

The LLM is the planner: it picks where sweetie goes (`go_to_pose`,
`follow_path`). But its waypoints are coordinates, and the straight line
to a coordinate can cross a solid obstacle. Today that means the robot
presses into the furniture and the safety guard slows it to a halt (see
`SimBridge.go_to_pose`'s own docstring). This module is the fast reflex
*beneath* the planner that steers around the obstacle instead — the
"fast reflexes underneath as a safety floor" idea from GrowBot, with the
tangent-steering geometry inspired by Float Knights' bot pathing (which
models this same Go2).

It is deliberately **local**, not a path planner:

- Each tick it looks only at obstacles intersecting the short corridor
  straight ahead toward the goal, picks the single nearest one, and
  deflects just far enough to clear its edge. Once the corridor is
  clear it heads straight to the goal again. It keeps no map, no plan,
  no memory between ticks.
- Like every reactive method it can stall against a wall or in a concave
  pocket — a barrier wider than it can see around has no local "graze
  this edge" solution. Escaping that is a *global* planner's job, which
  the ROADMAP keeps out of scope on purpose ("the LLM is the planner").
  When the reflex stalls, the robot simply stops progressing toward that
  waypoint, and the LLM picks a new target on its next tick. The reflex
  degrades to today's press-into-it behaviour, never worse.

Why tangent steering rather than a summed potential field
---------------------------------------------------------
The obvious approach — sum a goal-attraction force with a repulsion from
every nearby obstacle — stalls badly in even a sparse obstacle field:
the repulsions from several obstacles cancel the attraction at some point
short of the goal, the robot parks at that false equilibrium, and the
turn-then-drive controller jitters in place. Tangent steering sidesteps
the whole failure class: there is never an equilibrium to get stuck in,
because the moment the single blocking obstacle is cleared, the heading
snaps back to the goal. It also matches how a person walks through a
room — you don't feel a force field from the sofa, you just step around
the one thing in your way.

Pure and dependency-free: it takes plain obstacle tuples, not `World`
objects, so it is trivial to unit-test and reusable from either bridge.
`SimBridge` adapts `World.objects` (the solid ones) into the tuple form.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class AvoidanceConfig:
    """Tunables for the local avoider. Defaults sit just inside the safety
    guard's reactive band (slowdown 1.0 m → hard floor 0.3 m), so the
    robot steers clear *before* the guard has to brake."""

    # Edge-distance (m) within which an obstacle in the path corridor
    # triggers a deflection. The reflex's "look-ahead." Wider than the
    # safety slowdown onset so steering leads, braking backstops.
    lookahead: float = 1.5
    # Clearance (m) the robot keeps from an obstacle's edge — its own
    # half-width plus a margin.
    clearance: float = 0.25
    # Extra lateral padding (m) added when deciding how wide to swing, so
    # the robot grazes the edge with comfort, not exactly.
    pass_margin: float = 0.15
    # Distance-to-goal (m) below which deflection fades toward the direct
    # bearing, so the robot can settle on a goal that sits near an
    # obstacle instead of being pushed off it forever.
    arrival: float = 0.6
    # Lowest forward-speed multiplier the reflex will recommend when a
    # blocker is right on top of the robot. The robot creeps, never
    # freezes — forward progress (and thus the chance to steer clear)
    # is preserved.
    speed_floor: float = 0.4


@dataclass(frozen=True)
class SteerResult:
    """Output of one steering evaluation.

    heading        — world-frame angle (rad) the robot should aim for.
    active         — True if an obstacle deflected the heading this tick.
    min_clearance  — smallest obstacle edge-distance seen (m) across all
                     obstacles, inf when none were near. Lets callers and
                     tests confirm the robot is keeping clear.
    speed_scale    — in [SPEED_FLOOR, 1.0]; a recommended multiplier on
                     forward speed. 1.0 with a clear path; ramps down as
                     the blocking obstacle nears, giving the turn
                     controller time to swing the heading across before
                     the robot arrives. Complementary to (not a
                     replacement for) the safety guard's own proximity
                     slowdown — the bridge can apply it, or rely on the
                     guard. Either way it never raises speed.
    """

    heading: float
    active: bool
    min_clearance: float
    speed_scale: float = 1.0


from sweetie.core.mathutil import clamp, wrap_angle as _wrap_pi


def steer(
    x: float,
    y: float,
    goal_x: float,
    goal_y: float,
    obstacles,
    cfg: AvoidanceConfig | None = None,
) -> SteerResult:
    """Goal-seeking heading that bends around the nearest blocking obstacle.

    Parameters
    ----------
    x, y            current robot position (world frame, meters).
    goal_x, goal_y  the nav target the LLM set.
    obstacles       iterable of (ox, oy, oradius) for *solid* obstacles
                    only — the caller filters out passable terrain. The
                    robot is a point; `cfg.clearance` is its body margin.
    cfg             tuning; defaults if None.

    Returns
    -------
    SteerResult(heading, active, min_clearance). With a clear corridor,
    `heading` is exactly the straight-line bearing and `active` is False —
    the reflex is invisible whenever the planner's path is already clear.
    """
    cfg = cfg or AvoidanceConfig()

    gdx = goal_x - x
    gdy = goal_y - y
    goal_dist = math.hypot(gdx, gdy)
    if goal_dist <= 1e-9:
        return SteerResult(heading=0.0, active=False, min_clearance=math.inf)

    straight = math.atan2(gdy, gdx)
    gux, guy = gdx / goal_dist, gdy / goal_dist
    # Left-normal of the goal direction, for signed lateral offsets.
    lnx, lny = -guy, gux

    min_clear = math.inf
    # The nearest obstacle that actually blocks the corridor ahead.
    best = None
    best_proj = math.inf

    for (ox, oy, orad) in obstacles:
        rx = ox - x
        ry = oy - y
        center_d = math.hypot(rx, ry)
        edge_d = center_d - orad - cfg.clearance
        if edge_d < min_clear:
            min_clear = edge_d

        # Padded radius: how wide we must swing to pass comfortably.
        eff = orad + cfg.clearance + cfg.pass_margin
        proj = rx * gux + ry * guy        # signed distance along goal ray
        perp = rx * lnx + ry * lny        # signed lateral offset (left +)

        if proj <= 0.0:
            continue                       # behind us; irrelevant to progress
        if proj > goal_dist + eff:
            continue                       # sits beyond the goal
        if edge_d >= cfg.lookahead:
            continue                       # too far ahead to matter yet
        if abs(perp) > eff:
            continue                       # outside the swept corridor

        if proj < best_proj:
            best_proj = proj
            best = (rx, ry, center_d, perp, eff, edge_d)

    if best is None:
        return SteerResult(
            heading=straight, active=False,
            min_clearance=min_clear, speed_scale=1.0,
        )

    rx, ry, center_d, perp, eff, edge_d = best
    ang_to_obs = math.atan2(ry, rx)
    # Angular half-width the obstacle subtends from here. clamp keeps asin
    # valid if we're already inside the padded radius (numerical edge).
    ratio = min(1.0, eff / max(center_d, 1e-6))
    half_ang = math.asin(ratio)

    # Pass on the side the obstacle is NOT on: obstacle to the left
    # (perp > 0) → swing right (aim clockwise of the obstacle bearing).
    # Dead-ahead (perp ≈ 0) → deterministic left, so the path never
    # dithers over the tie.
    if perp > 1e-3:
        deflected = ang_to_obs - half_ang   # go right of it
    elif perp < -1e-3:
        deflected = ang_to_obs + half_ang   # go left of it
    else:
        deflected = ang_to_obs + half_ang   # tie-break: left

    # Arrival attenuation: blend back toward the direct bearing as we
    # close on the goal, so a goal beside an obstacle is still reachable.
    att = min(1.0, goal_dist / cfg.arrival) if cfg.arrival > 0 else 1.0
    heading = _wrap_pi(straight + att * _wrap_pi(deflected - straight))

    # Speed recommendation: full speed while the blocker is a look-ahead
    # away, ramping to the floor as it closes, so the turn has time to
    # land before the robot reaches it.
    ramp = clamp(edge_d / cfg.lookahead, 0.0, 1.0)
    speed_scale = cfg.speed_floor + (1.0 - cfg.speed_floor) * ramp

    return SteerResult(
        heading=heading, active=True,
        min_clearance=min_clear, speed_scale=speed_scale,
    )
