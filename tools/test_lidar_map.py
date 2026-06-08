"""LiDAR mapping tests — decode, planar occupancy, planner routing, bridge ingest.

All synthetic: no hardware. Validates the decode/project/grid math and that a
LiDAR-built obstacle is routed around.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from sweetie.core.lidar_map import decode_voxel_map, LidarMapper
from sweetie.core.planner import plan_path, line_of_sight


# ── decode tolerance ─────────────────────────────────────────────────────────


def test_decode_passthrough_point_list():
    pts = decode_voxel_map([(1.0, 2.0, 0.3), (4.0, 5.0, 0.6)])
    assert pts == [(1.0, 2.0, 0.3), (4.0, 5.0, 0.6)]


def test_decode_flat_positions_array():
    msg = SimpleNamespace(positions=[1, 2, 3, 4, 5, 6])
    assert decode_voxel_map(msg) == [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)]


def test_decode_point_objects():
    msg = SimpleNamespace(points=[SimpleNamespace(x=1, y=2, z=3)])
    assert decode_voxel_map(msg) == [(1.0, 2.0, 3.0)]


def test_decode_unknown_shape_is_empty():
    assert decode_voxel_map(SimpleNamespace(foo=1)) == []
    assert decode_voxel_map(None) == []


# ── occupancy + routing ──────────────────────────────────────────────────────


def _wall_points(x=3.0, ys=(-1.0, -0.5, 0.0, 0.5, 1.0), z=0.5):
    # a dense vertical wall at x, plus filler so the ray-cast can't slip between
    pts = []
    yy = -1.0
    while yy <= 1.0001:
        pts.append((x, round(yy, 3), z))
        yy += 0.1
    return pts


def test_mapper_marks_wall_occupied_and_ray_free():
    m = LidarMapper(resolution=0.1)
    for _ in range(3):  # LiDAR streams frames; free space needs >1 to cross threshold
        m.integrate(0.0, 0.0, 0.0, _wall_points())
    # the wall cell straight ahead is occupied; a cell on the ray to it is free
    assert m.grid.state(*m.grid.world_to_cell(3.0, 0.0)) == "occupied"
    assert m.grid.state(*m.grid.world_to_cell(1.5, 0.0)) == "free"


def test_floor_and_ceiling_points_ignored():
    m = LidarMapper(resolution=0.1, z_min=0.05, z_max=1.2)
    m.integrate(0.0, 0.0, 0.0, [(2.0, 0.0, 0.0), (2.0, 0.0, 2.0)])  # floor + ceiling
    assert m.grid.state(*m.grid.world_to_cell(2.0, 0.0)) != "occupied"


def test_planner_routes_around_lidar_wall():
    m = LidarMapper(resolution=0.1)
    m.integrate(0.0, 0.0, 0.0, _wall_points())
    gv = m.grid_view(inflate=0.2, unknown_blocked=False)
    route = plan_path(gv, (0.0, 0.0), (5.0, 0.0))
    assert route is not None and len(route) >= 2
    assert all(line_of_sight(gv, route[i][0], route[i][1], route[i + 1][0], route[i + 1][1])
            for i in range(len(route) - 1))
    assert any(abs(p[1]) > 0.3 for p in route)   # detoured around the wall


# ── RealBridge integration (mock SDK) ────────────────────────────────────────


def _fake_sdk():
    sport = MagicMock()
    for m in ("SetTimeout", "Init", "StopMove"):
        getattr(sport, m).return_value = 0
    return {
        "ChannelFactoryInitialize": MagicMock(),
        "ChannelSubscriber": MagicMock(return_value=MagicMock()),
        "SportClient": MagicMock(return_value=sport),
        "SportModeState_": MagicMock,
        "LowState_": MagicMock,
    }


@pytest.mark.asyncio
async def test_realbridge_lidar_map_backs_planner():
    from sweetie.core.real_bridge import RealBridge
    with patch("sweetie.core.real_bridge._import_sdk", return_value=_fake_sdk()):
        b = RealBridge(enable_lidar_map=True)
        await b.connect()
        # pose stays at origin (no telemetry in test); ingest a wall, then plan
        n = b.ingest_voxel_map(_wall_points())
        assert n > 0
        route = await b.plan_to(5.0, 0.0)
        assert route is not None and any(abs(p[1]) > 0.3 for p in route)
        await b.disconnect()
