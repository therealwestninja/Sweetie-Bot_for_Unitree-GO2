"""
Navigator — the navigation layer that was missing.

`RealBridge.go_to_pose`/`follow_path` historically refused, with a note that a
"real Nav2 layer" would implement them. This is that layer, kept deliberately
small: planner (A* + string-pull over a grid) + a map (P-SLAM occupancy grid or
the sim's) + a closed-loop follower that drives a bridge to a goal.

Crucially it fits sweetie's safety architecture: **the SafetyGuard sits above
the bridge**, so the Navigator does NOT call `bridge.move` directly when a guard
is supplied — it routes every command through `guard.guard(vx, vy, vyaw, state)`
and uses the (proximity-scaled, envelope-clamped) result. If the guard rejects
the command (ESTOP / not armed / heartbeat lost), the Navigator stops. This is
the same gate the joystick and the LLM's move tool go through — autonomy gets no
privileged motion path.

Hardware-agnostic: it only needs a bridge with async `move`/`stop_move`/
`get_state` (RealBridge on metal, SimBridge or a mock in tests), an optional
`SafetyGuard`, and a callable that returns the current map as a planner GridView.
Body-frame velocities (vx forward, vy lateral, vyaw turn) match the Go2 `Move`.
"""

from __future__ import annotations

import math


def _wrap(a: float) -> float:
    while a > math.pi:
        a -= 2 * math.pi
    while a < -math.pi:
        a += 2 * math.pi
    return a


class Navigator:
    def __init__(self, bridge, grid_provider, *, guard=None,
                arrive: float = 0.18, cruise: float = 0.55,
                yaw_kp: float = 2.6, yaw_limit: float = 2.0,
                head_tol: float = 0.5, stall_ticks: int = 45,
                stall_eps: float = 0.01) -> None:
        """
        bridge:        async move/stop_move/get_state.
        grid_provider: zero-arg callable -> planner.GridView (the current map),
                       or a GridView, or a mapping.OccupancyGrid.
        guard:         optional SafetyGuard; when present every command is gated
                       through it (proximity scaling + state machine).
        """
        self.bridge = bridge
        self.grid_provider = grid_provider
        self.guard = guard
        self.arrive = arrive
        self.cruise = cruise
        self.yaw_kp = yaw_kp
        self.yaw_limit = yaw_limit
        self.head_tol = head_tol
        self.stall_ticks = stall_ticks
        self.stall_eps = stall_eps
        self.path: list[tuple[float, float]] = []
        self.wp = 0
        self.goal: tuple[float, float] | None = None
        self._last = None
        self._stall = 0
        self._replans = 0
        self._max_replans = 3  # give up after this many fruitless replans

    def _grid(self):
        g = self.grid_provider() if callable(self.grid_provider) else self.grid_provider
        if g is None:
            return None
        if hasattr(g, "blocked_grid"):  # an OccupancyGrid -> GridView, inflated for clearance
            from sweetie.core.planner import GridView, DEFAULT_ROBOT_R
            return GridView(g.blocked_grid(inflate_radius=DEFAULT_ROBOT_R),
                            g.res, g.origin_x, g.origin_y)
        return g

    async def goto(self, x: float, y: float) -> bool:
        """Plan a route from the current pose to (x, y). True if a path exists."""
        from sweetie.core.planner import plan_path
        grid = self._grid()
        if grid is None:
            return False
        st = await self.bridge.get_state()
        path = plan_path(grid, (st.x, st.y), (x, y))
        if not path:
            self.path, self.goal = [], None
            return False
        self.path, self.wp, self.goal = path, 0, (x, y)
        self._stall, self._last, self._replans = 0, None, 0
        return True

    async def follow(self, waypoints: list[tuple[float, float]]) -> bool:
        """Follow an externally-supplied path (what RealBridge.follow_path wanted)."""
        wps = [(float(x), float(y)) for (x, y) in waypoints]
        if not wps:
            return False
        self.path, self.wp, self.goal = wps, 0, wps[-1]
        self._stall, self._last, self._replans = 0, None, 0
        return True

    async def _replan(self) -> bool:
        if self.goal is None:
            return False
        from sweetie.core.planner import plan_path
        grid = self._grid()
        st = await self.bridge.get_state()
        path = plan_path(grid, (st.x, st.y), self.goal) if grid else None
        if not path:
            return False
        self.path, self.wp, self._stall = path, 0, 0
        return True

    async def _drive(self, vx: float, vy: float, vyaw: float, state) -> bool:
        """Issue one command, routed through the SafetyGuard if present.

        Returns True if some command reached the bridge, False if the guard
        rejected it outright (estop / not armed / heartbeat lost)."""
        if self.guard is not None:
            gr = self.guard.guard(vx, vy, vyaw, state)
            if not gr.allowed:
                await self.bridge.stop_move()
                return False
            vx, vy, vyaw = gr.vx, gr.vy, gr.vyaw
        await self.bridge.move(vx, vy, vyaw)
        return True

    async def step(self) -> str:
        """One control tick. Returns 'arrived'|'moving'|'blocked'|'gated'|'idle'."""
        if not self.path:
            return "idle"
        st = await self.bridge.get_state()
        x, y, yaw = st.x, st.y, getattr(st, "yaw", 0.0)

        while self.wp < len(self.path) and math.hypot(
                self.path[self.wp][0] - x, self.path[self.wp][1] - y) < self.arrive:
            self.wp += 1
        if self.wp >= len(self.path):
            await self.bridge.stop_move()
            self.path, self.goal = [], None
            return "arrived"

        # stall detection -> replan, then give up
        if self._last is not None and math.hypot(x - self._last[0], y - self._last[1]) < self.stall_eps:
            self._stall += 1
        else:
            self._stall = 0
            self._replans = 0
        self._last = (x, y)
        if self._stall > self.stall_ticks:
            self._replans += 1
            if self._replans > self._max_replans or not await self._replan():
                await self.bridge.stop_move()
                self.path, self.goal = [], None
                return "blocked"

        tx, ty = self.path[self.wp]
        yaw_err = _wrap(math.atan2(ty - y, tx - x) - yaw)
        vyaw = max(-self.yaw_limit, min(self.yaw_limit, self.yaw_kp * yaw_err))
        if abs(yaw_err) > self.head_tol:
            sent = await self._drive(0.0, 0.0, vyaw, st)          # turn in place
        else:
            sent = await self._drive(self.cruise, 0.0, vyaw * 0.5, st)  # walk, trim heading
        return "moving" if sent else "gated"

    async def run(self, max_ticks: int = 2000) -> str:
        for _ in range(max_ticks):
            r = await self.step()
            if r in ("arrived", "blocked", "idle", "gated"):
                return r
        await self.bridge.stop_move()
        return "timeout"

    async def cancel(self) -> None:
        self.path, self.goal = [], None
        await self.bridge.stop_move()
