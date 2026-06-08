"""Shared navigation-grid plumbing for bridges.

Both RealBridge (DDS) and WebRTCBridge hold a map and plan routes on it
identically. The bridge is intentionally "dumb" — it plans and reports, but
never drives; `core.navigator.Navigator` executes routes through SafetyGuard.
This mixin factors out the duplicated set/resolve/plan trio. Requires the host
to provide `self._nav_grid` and an async `get_state()`.
"""

from __future__ import annotations

from sweetie.core.planner import plan_path, to_grid_view


class NavGridMixin:
    _nav_grid = None

    def set_nav_grid(self, grid_or_provider) -> None:
        """Give the bridge a map to plan on: a planner GridView, a
        mapping.OccupancyGrid (LiDAR/SLAM), or a zero-arg callable returning
        one. Execution stays with core.navigator.Navigator (gated by SafetyGuard)."""
        self._nav_grid = grid_or_provider

    def _resolve_grid(self):
        g = self._nav_grid() if callable(self._nav_grid) else self._nav_grid
        return to_grid_view(g)

    async def plan_to(self, x: float, y: float):
        """Plan a route from the current pose to (x, y); world waypoints or None.
        Pure planning — does not move the robot."""
        grid = self._resolve_grid()
        if grid is None:
            return None
        st = await self.get_state()
        return plan_path(grid, (st.x, st.y), (x, y))
