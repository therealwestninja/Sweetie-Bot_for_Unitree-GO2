"""Tests: world->grid rasterization + planner routing around sim obstacles."""

from __future__ import annotations

import pytest

from sweetie.core.sim_grid import grid_from_world
from sweetie.core.planner import line_of_sight
from sweetie.sim.world import World, WorldObject


def test_grid_marks_obstacles_blocked_and_free_space_open():
    w = World([WorldObject("box", x=2.0, y=0.0, radius=0.4)])
    g = grid_from_world(w, res=0.1, inflate=0.2)
    bi, bj = g.cell_of(2.0, 0.0)
    assert not g.passable(bi, bj)          # obstacle center is blocked
    fi, fj = g.cell_of(2.0, 3.0)
    assert g.passable(fi, fj)              # open space well away is free


def test_passable_terrain_is_not_blocked():
    w = World([WorldObject("hill", x=1.0, y=0.0, radius=0.6,
                        obstacle=False, category="terrain")])
    g = grid_from_world(w)
    i, j = g.cell_of(1.0, 0.0)
    assert g.passable(i, j)                # passable terrain doesn't block planning


@pytest.mark.asyncio
async def test_sim_plan_route_avoids_obstacle():
    """A wall between start and goal forces a detour; the planned route must
    be collision-free and not the straight line through the wall."""
    from sweetie.core.bridge import SimBridge
    # a vertical wall of boxes at x≈2 spanning y∈[-1,1], gap left open above/below
    wall = [WorldObject(f"w{k}", x=2.0, y=yy, radius=0.25)
            for k, yy in enumerate([-1.0, -0.5, 0.0, 0.5, 1.0])]
    b = SimBridge(World(wall))
    await b.connect()
    await b.stand_up()
    # robot starts near origin (default sim pose); go to the far side of the wall
    route = await b.plan_route(4.0, 0.0)
    assert route is not None and len(route) >= 2
    # every segment collision-free against the same grid
    from sweetie.core.sim_grid import grid_from_world
    g = grid_from_world(b.world)
    assert all(line_of_sight(g, route[i][0], route[i][1], route[i+1][0], route[i+1][1])
            for i in range(len(route) - 1))
    # the route must leave y=0 at some point (detour around the wall)
    assert any(abs(p[1]) > 0.5 for p in route)
    await b.disconnect()
