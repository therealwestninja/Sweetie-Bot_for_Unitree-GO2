"""
Tests for sweetie.core.navigator — the back-ported navigation layer, including
its integration with the real SafetyGuard. Kinematic mock bridge, no hardware.
Run: PYTHONPATH=<repo-parent> python sweetie/tools/test_navigator.py
"""

from __future__ import annotations

import asyncio
import math
import sys

from sweetie.core.navigator import Navigator
from sweetie.core.planner import GridView
from sweetie.core.safety import SafetyGuard


class State:
    def __init__(self, x, y, yaw):
        self.x, self.y, self.yaw = x, y, yaw
        # fields the SafetyGuard reads:
        self.range_obstacle = [5.0, 5.0, 5.0, 5.0]  # front, left, back, right
        self.battery_percent = 90.0
        self.roll = 0.0
        self.pitch = 0.0


class KinematicMock:
    """Integrates the last Move command into a pose; optional obstacle ahead."""

    def __init__(self, x=0.0, y=0.0, yaw=0.0, dt=1 / 30, front_range=5.0):
        self.x, self.y, self.yaw = x, y, yaw
        self.dt = dt
        self._cmd = (0.0, 0.0, 0.0)
        self.stops = 0
        self.moves = 0
        self.front_range = front_range

    async def move(self, vx, vy, vyaw):
        self._cmd = (vx, vy, vyaw)
        self.moves += 1
        return True

    async def stop_move(self):
        self._cmd = (0.0, 0.0, 0.0)
        self.stops += 1
        return True

    async def get_state(self):
        vx, vy, vyaw = self._cmd
        self.yaw += vyaw * self.dt
        self.x += (vx * math.cos(self.yaw) - vy * math.sin(self.yaw)) * self.dt
        self.y += (vx * math.sin(self.yaw) + vy * math.cos(self.yaw)) * self.dt
        st = State(self.x, self.y, self.yaw)
        st.range_obstacle = [self.front_range, 5.0, 5.0, 5.0]
        return st


def _grid(rows, res=1.0):
    return GridView([[1 if c == '#' else 0 for c in r] for r in rows], res)


def main():
    R = []
    ok = lambda n, c: R.append((n, bool(c)))

    # 1. open field, no guard -> drives to goal
    gv = _grid(["." * 10, "." * 10, "." * 10])
    bot = KinematicMock(0.5, 0.5, 0.0)
    nav = Navigator(bot, lambda: gv)
    assert asyncio.run(nav.goto(9.5, 0.5))
    ok("no-guard run arrives", asyncio.run(nav.run(4000)) == "arrived")
    ok("reached goal", math.hypot(bot.x - 9.5, bot.y - 0.5) < 0.25)

    # 2. follow(waypoints) — the path RealBridge.follow_path would hand over
    bot2 = KinematicMock(0.5, 0.5, 0.0)
    nav2 = Navigator(bot2, lambda: gv)
    assert asyncio.run(nav2.follow([(3.5, 0.5), (6.5, 0.5), (9.5, 0.5)]))
    ok("follow(waypoints) arrives", asyncio.run(nav2.run(4000)) == "arrived")

    # 3. SafetyGuard integration: when guard is IDLE, no motion ('gated')
    g = SafetyGuard()  # starts IDLE
    bot3 = KinematicMock(0.5, 0.5, 0.0)
    nav3 = Navigator(bot3, lambda: gv, guard=g)
    asyncio.run(nav3.goto(9.5, 0.5))
    r3 = asyncio.run(nav3.step())
    ok("guard IDLE -> step gated, robot not commanded", r3 == "gated" and bot3.moves == 0)

    # 4. guard ARMED+ACTIVE -> motion flows through the guard and reaches goal
    g4 = SafetyGuard(); g4.arm(); g4.heartbeat()  # IDLE->ARMED->ACTIVE
    bot4 = KinematicMock(0.5, 0.5, 0.0)
    nav4 = Navigator(bot4, lambda: gv, guard=g4)
    # keep heartbeats alive across the run by re-beating each tick via a wrapper
    async def run_with_heartbeat(nav, g, n=4000):
        for _ in range(n):
            g.heartbeat()
            r = await nav.step()
            if r in ("arrived", "blocked", "idle", "gated"):
                return r
        return "timeout"
    assert asyncio.run(nav4.goto(9.5, 0.5))
    ok("guarded run arrives", asyncio.run(run_with_heartbeat(nav4, g4)) == "arrived")
    ok("guarded run reached goal", math.hypot(bot4.x - 9.5, bot4.y - 0.5) < 0.25)

    # 5. proximity gate: an obstacle dead ahead scales forward speed toward 0,
    #    so the robot can't reach a goal that requires driving into it -> blocked
    g5 = SafetyGuard(); g5.arm(); g5.heartbeat()
    bot5 = KinematicMock(0.5, 0.5, 0.0, front_range=0.25)  # < HARD_FLOOR (0.3m)
    nav5 = Navigator(bot5, lambda: gv, guard=g5, stall_ticks=20)
    asyncio.run(nav5.goto(9.5, 0.5))
    r5 = asyncio.run(run_with_heartbeat(nav5, g5, n=400))
    ok("obstacle ahead -> guard blocks forward, navigator gives up (blocked)",
    r5 == "blocked" and bot5.x < 1.0)
    ok("never drove into the obstacle", bot5.x < 1.0)

    p = sum(1 for _, c in R if c)
    f = sum(1 for _, c in R if not c)
    for n, c in R:
        print(("  [PASS] " if c else "  [FAIL] ") + n)
    print(f"{p} passed, {f} failed")
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
