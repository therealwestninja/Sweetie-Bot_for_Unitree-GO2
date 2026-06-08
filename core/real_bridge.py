"""
Real-hardware bridge for the Unitree Go2.

Talks to a real robot over Cyclone DDS using the `unitree_sdk2py` Python
SDK. Topic names and message schemas come from the upstream `unitree_ros2`
reference (BSD-3-Clause, Unitree Robotics, 2016-2024).

----------------------------------------------------------------------
HARDWARE-VERIFICATION STATUS: NONE.

This file has not been runtime-tested against an actual Go2. It was
written from documented SDK surface area and published message schemas.
First hardware bring-up should be treated as bring-up: expect to debug
mode-code mappings, network configuration, command timing, and any
quirks the docs don't mention.

The integration *shape* is verified by `tests/test_real_bridge.py`,
which mocks the SDK. Those tests catch refactor regressions but cannot
catch incorrect SDK semantics.
----------------------------------------------------------------------

Usage:
    pip install -e ".[real]"
    SWEETIE_BRIDGE=real \\
    SWEETIE_NETWORK_INTERFACE=eth0 \\
    python -m sweetie

The robot must be on the same network and the DDS domain ID must match.

What this bridge intentionally does NOT do:
- Look-at-entity tool: returns "no_world" because there's no perception
  layer yet for real hardware. M7's natural successor is a perception
  pipeline (camera + lidar + tracking) that would populate equivalents
  of the simulator's world model.
- Recent perceptions: not implemented. Cognition's report_status falls
  back to an empty list when the bridge doesn't expose this, so the
  LLM gets a consistent schema either way.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import threading
import time
from typing import Any, Callable

from sweetie.core.bridge import (
    BridgeBase,
    RobotState,
    VX_LIMIT,
    VY_LIMIT,
    VYAW_LIMIT,
)
from sweetie.core.bus import bus

logger = logging.getLogger(__name__)


# DDS topic names (from upstream unitree_ros2).
TOPIC_SPORT_STATE = "rt/sportmodestate"
TOPIC_LOW_STATE = "rt/lowstate"

# Sport mode integer codes — subset we care about. The full list lives in
# unitree_ros2/cyclonedds_ws/src/unitree/unitree_go/msg/SportModeState.msg
# as `uint8 mode`. These specific values are best-effort and need
# verification on hardware.
SPORT_MODE_IDLE = 0
SPORT_MODE_BALANCE_STAND = 1
SPORT_MODE_DAMP = 5
SPORT_MODE_STAND_DOWN = 7


def _import_sdk() -> dict[str, Any]:
    """
    Lazy SDK import. Raises with a clear message if not installed.

    Tests substitute this entire function via mock, which lets the test
    suite run without `unitree_sdk2py` being installed.
    """
    try:
        from unitree_sdk2py.core.channel import (  # type: ignore[import-not-found]
            ChannelFactoryInitialize,
            ChannelSubscriber,
        )
        from unitree_sdk2py.go2.sport.sport_client import (  # type: ignore[import-not-found]
            SportClient,
        )
        from unitree_sdk2py.idl.unitree_go.msg.dds_ import (  # type: ignore[import-not-found]
            LowState_,
            SportModeState_,
        )
    except ImportError as e:
        raise RuntimeError(
            "unitree_sdk2py is not installed. Install with `pip install -e .[real]` "
            "or directly from GitHub: "
            "`pip install git+https://github.com/unitreerobotics/unitree_sdk2_python`. "
            f"Original error: {e}"
        ) from e
    # Onboard audio is optional: not every SDK/firmware build exposes AudioClient,
    # and speech is non-critical (the chat broadcast is the primary channel). Import
    # best-effort so its absence never blocks connect(); speak_through_robot degrades.
    try:
        from unitree_sdk2py.go2.audio.audio_client import (  # type: ignore[import-not-found]
            AudioClient,
        )
    except Exception:
        AudioClient = None
    return {
        "ChannelFactoryInitialize": ChannelFactoryInitialize,
        "ChannelSubscriber": ChannelSubscriber,
        "SportClient": SportClient,
        "SportModeState_": SportModeState_,
        "LowState_": LowState_,
        "AudioClient": AudioClient,
    }


class RealBridge(BridgeBase):
    """
    Bridge to a real Unitree Go2 over DDS via unitree_sdk2py.

    Threading model:
        - DDS callbacks (`_on_sport_state`, `_on_low_state`) fire on a
          background thread owned by the SDK.
        - Reads/writes to `self._state` go through `self._state_lock`.
        - `get_state()` returns a deep copy so the caller has an isolated
          snapshot with no risk of mid-read mutation.
        - SDK command methods (`StandUp`, `Move`, etc.) are synchronous
          and block. We dispatch them via `run_in_executor` so the asyncio
          event loop is never blocked.

    Coordinate frames:
        - Position is world frame (whatever the Go2's odometry origin is).
        - Velocity is body frame (vx forward, vy left, vyaw counter-CW).
        - IMU rpy is radians.
    """

    DEFAULT_NETWORK_INTERFACE = "eth0"
    DEFAULT_DOMAIN_ID = 0
    SDK_TIMEOUT_S = 10.0
    TTS_SPEAKER_ID = 0  # default onboard voice for AudioClient.TtsMaker

    def __init__(
        self,
        network_interface: str | None = None,
        domain_id: int = 0,
        *,
        enable_risky: bool = False,
        enable_lidar_map: bool = False,
    ) -> None:
        self._network_interface = network_interface or self.DEFAULT_NETWORK_INTERFACE
        self._domain_id = domain_id
        self._connected = False
        # Gate for acrobatic gestures (flips, handstand…). Off by default so
        # neither the LLM nor a stray dashboard tap can hurt the robot.
        self._enable_risky = bool(enable_risky)
        # Optional LiDAR occupancy mapping (rt/utlidar/voxel_map). When on, the
        # nav grid is the live LiDAR map so go_to_pose/plan_to route on it.
        self._enable_lidar_map = bool(enable_lidar_map)
        self._lidar_mapper = None

        # Populated in connect().
        self._sport: Any = None
        self._sport_state_sub: Any = None
        self._low_state_sub: Any = None
        self._sdk: dict[str, Any] | None = None

        # Cached telemetry. Updated by DDS callbacks under _state_lock.
        self._state = RobotState()
        self._state.mode = "down"  # safe assumption at startup
        self._state_lock = threading.Lock()

        # Perception layer: derived from range_obstacle over time.
        # See `core/real_perception.py` for what it does and doesn't.
        from sweetie.core.real_perception import RealPerception
        self._perception = RealPerception()
        # Background task: feeds the perception layer with each LowState
        # update. Started in connect(), cancelled in disconnect().
        self._perception_task: asyncio.Task | None = None

        # Optional planner map (a planner.GridView, a mapping.OccupancyGrid, or
        # a callable returning one). When set, plan_to() can compute routes and
        # the Navigator layer can execute them through SafetyGuard. See
        # set_nav_grid(). None = no map, navigation refused (legacy behaviour).
        self._nav_grid = None

        # Optional onboard audio client (TTS). Set in connect() when the SDK
        # exposes one; None disables speak_through_robot's physical path.
        self._audio: Any = None

    # ── Lifecycle ───────────────────────────────────────────────────────────

    async def connect(self) -> None:
        if self._connected:
            return
        self._sdk = _import_sdk()
        sdk = self._sdk

        sdk["ChannelFactoryInitialize"](self._domain_id, self._network_interface)

        self._sport_state_sub = sdk["ChannelSubscriber"](
            TOPIC_SPORT_STATE, sdk["SportModeState_"]
        )
        self._sport_state_sub.Init(self._on_sport_state, 10)

        self._low_state_sub = sdk["ChannelSubscriber"](
            TOPIC_LOW_STATE, sdk["LowState_"]
        )
        self._low_state_sub.Init(self._on_low_state, 10)

        self._sport = sdk["SportClient"]()
        self._sport.SetTimeout(self.SDK_TIMEOUT_S)
        self._sport.Init()

        # Optional onboard audio (TTS). Absent in older SDK builds and in the
        # test SDK mock; speak_through_robot falls back to chat when None.
        audio_cls = sdk.get("AudioClient")
        if audio_cls is not None:
            try:
                self._audio = audio_cls()
                self._audio.SetTimeout(self.SDK_TIMEOUT_S)
                self._audio.Init()
                logger.info("RealBridge: onboard audio client ready")
            except Exception:
                logger.exception("RealBridge: audio client init failed — voice disabled")
                self._audio = None

        self._connected = True

        # Bring up LiDAR occupancy mapping if requested. The grid auto-backs the
        # planner (set_nav_grid), so go_to_pose/plan_to route on the live map.
        if self._enable_lidar_map and self._lidar_mapper is None:
            from sweetie.core.lidar_map import LidarMapper
            self._lidar_mapper = LidarMapper()
            if self._nav_grid is None:
                self._nav_grid = lambda: (
                    self._lidar_mapper.grid_view() if self._lidar_mapper else None
                )
            logger.info("RealBridge: LiDAR occupancy mapping enabled "
                        "(subscribe rt/utlidar/voxel_map -> ingest_voxel_map)")
        # Start the perception forwarder. Reads cached state under lock,
        # drives `RealPerception`, publishes new events to the bus —
        # same shape SimBridge does in its tick loop.
        self._perception_task = asyncio.create_task(self._perception_loop())
        logger.info(
            "RealBridge connected on %s (DDS domain=%d)",
            self._network_interface, self._domain_id,
        )

    async def disconnect(self) -> None:
        # The unitree_sdk2py docs don't expose a clean shutdown for
        # ChannelFactory — it tears down at process exit. Here we just
        # mark ourselves closed and drop our handles.
        self._connected = False
        if self._perception_task is not None:
            self._perception_task.cancel()
            try:
                await self._perception_task
            except (asyncio.CancelledError, Exception):
                pass
            self._perception_task = None
        self._sport_state_sub = None
        self._low_state_sub = None
        self._sport = None
        self._audio = None
        self._lidar_mapper = None
        logger.info("RealBridge disconnected")

    # ── Perception loop ─────────────────────────────────────────────────────

    PERCEPTION_HZ = 10  # 10 Hz is plenty for transition events.

    async def _perception_loop(self) -> None:
        """Drive `RealPerception` from cached telemetry at `PERCEPTION_HZ`.

        Runs in the asyncio loop (not the SDK thread). Reads `range_obstacle`
        from the cached state under lock, ticks perception, drains and
        publishes new events. Mirrors `SimBridge._tick_loop`'s perception
        forwarding so cognition / ambient / UI all consume the same shape.
        """
        dt = 1.0 / self.PERCEPTION_HZ
        while self._connected:
            try:
                await asyncio.sleep(dt)
                with self._state_lock:
                    s = self._state
                    x, y, yaw = s.x, s.y, s.yaw
                    ro = tuple(s.range_obstacle)
                self._perception.tick(x, y, yaw, ro)
                for event in self._perception.drain_new_events():
                    await bus.publish("perception", {"event": event})
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("RealBridge perception loop error")

    # ── DDS callbacks (run on SDK thread) ───────────────────────────────────

    def _on_sport_state(self, msg: Any) -> None:
        try:
            with self._state_lock:
                s = self._state
                s.timestamp = time.time()
                s.x = float(msg.position[0])
                s.y = float(msg.position[1])
                s.roll = float(msg.imu_state.rpy[0])
                s.pitch = float(msg.imu_state.rpy[1])
                s.yaw = float(msg.imu_state.rpy[2])
                s.vx = float(msg.velocity[0])
                s.vy = float(msg.velocity[1])
                s.vyaw = float(msg.yaw_speed)
                s.body_height = float(msg.body_height)
                s.range_obstacle = [float(r) for r in msg.range_obstacle]
                s.mode = self._mode_to_str(int(msg.mode))
        except Exception:
            # Don't let an SDK message format quirk crash the listener thread.
            logger.exception("RealBridge: error in sport-state callback")

    def _on_low_state(self, msg: Any) -> None:
        try:
            with self._state_lock:
                # bms_state.soc is integer 0-100 percent. Field name lifted
                # from the upstream LowState.msg → bms_state field, which
                # contains a BmsState whose `soc` is uint8.
                self._state.battery_percent = float(msg.bms_state.soc)
        except Exception:
            logger.exception("RealBridge: error in low-state callback")

    def _mode_to_str(self, mode: int) -> str:
        """Map the uint8 sport mode to our internal vocabulary.

        Note: mode mapping is unverified. If real hardware reports modes
        we don't recognize, we fall through to "standing" or "moving"
        based on commanded velocity, which is a safe default for the
        rest of the codebase (the safety FSM still gates everything).
        """
        if mode == SPORT_MODE_DAMP:
            return "estop"
        if mode == SPORT_MODE_STAND_DOWN:
            return "down"
        # IDLE and BALANCE_STAND both mean the robot is up. Distinguish
        # standing vs moving by velocity.
        s = self._state
        if any((abs(s.vx) > 0.02, abs(s.vy) > 0.02, abs(s.vyaw) > 0.02)):
            return "moving"
        return "standing"

    # ── BridgeBase implementation ───────────────────────────────────────────

    async def get_state(self) -> RobotState:
        with self._state_lock:
            # Deep copy so the caller has an isolated snapshot. Mutable
            # fields like `range_obstacle` get fully detached.
            return copy.deepcopy(self._state)

    async def stand_up(self) -> bool:
        if self._sport is None:
            return False
        return await self._sdk_call(self._sport.StandUp)

    async def stand_down(self) -> bool:
        if self._sport is None:
            return False
        return await self._sdk_call(self._sport.StandDown)

    async def move(self, vx: float, vy: float, vyaw: float) -> bool:
        if self._sport is None:
            return False
        # Bridge-side clamp as defense-in-depth. The safety guard already
        # clamped, but a buggy caller shouldn't be able to floor it.
        cvx = max(-VX_LIMIT, min(VX_LIMIT, float(vx)))
        cvy = max(-VY_LIMIT, min(VY_LIMIT, float(vy)))
        cvyaw = max(-VYAW_LIMIT, min(VYAW_LIMIT, float(vyaw)))
        return await self._sdk_call(self._sport.Move, cvx, cvy, cvyaw)

    async def stop_move(self) -> bool:
        if self._sport is None:
            return False
        return await self._sdk_call(self._sport.StopMove)

    async def emergency_stop(self) -> bool:
        # Damp() is the canonical emergency stop on Unitree quadrupeds:
        # joints go to a damped state and the robot settles to the floor
        # softly. Strictly safer than StopMove() in true emergencies
        # because the motors stop holding posture.
        if self._sport is None:
            return False
        ok = await self._sdk_call(self._sport.Damp)
        with self._state_lock:
            self._state.mode = "estop"
        return ok

    async def clear_estop(self) -> bool:
        # After Damp(), the robot is on the ground. We do NOT auto-stand
        # it — the operator must explicitly call stand_up. Just clear our
        # mode flag so the FSM can advance normally.
        with self._state_lock:
            if self._state.mode == "estop":
                self._state.mode = "down"
        return True

    async def look_at_entity(self, name: str) -> str:
        # Same response shape as SimBridge.look_at_entity when no world
        # is attached. Real-hardware perception is a separate milestone.
        return "no_world"

    async def set_body_height(self, meters: float) -> bool:
        """Crouch/stand by calling SportClient.BodyHeight.

        The SDK's `BodyHeight` takes a *relative* offset from the default
        standing height (~0.27 m), in meters, in roughly ±0.10 m.
        We accept absolute heights from the operator/LLM and convert.
        Range clamped to [BODY_HEIGHT_MIN, BODY_HEIGHT_MAX].
        """
        if self._sport is None:
            return False
        from sweetie.core.bridge import (
            BODY_HEIGHT_DEFAULT, BODY_HEIGHT_MIN, BODY_HEIGHT_MAX,
        )
        clamped = max(BODY_HEIGHT_MIN, min(BODY_HEIGHT_MAX, float(meters)))
        offset = clamped - BODY_HEIGHT_DEFAULT
        ok = await self._sdk_call(self._sport.BodyHeight, offset)
        if ok:
            with self._state_lock:
                self._state.body_height = clamped
        return ok

    def ingest_voxel_map(self, msg) -> int:
        """Feed one raw LiDAR voxel-map message into the occupancy map, using the
        latest cached robot pose. Returns the number of points integrated (0 if
        LiDAR mapping is off). On hardware, subscribe `rt/utlidar/voxel_map` (see
        teleop/webrtc_topics.py) and call this from the callback; in tests, pass
        a synthetic message. The voxel-map IDL type is firmware-specific, so the
        DDS subscription is left to bring-up rather than guessed here."""
        if self._lidar_mapper is None:
            return 0
        with self._state_lock:
            x, y, yaw = self._state.x, self._state.y, self._state.yaw
        return self._lidar_mapper.ingest(msg, x, y, yaw)

    def set_nav_grid(self, grid_or_provider) -> None:
        """Give the bridge a map so it can plan routes. Accepts a planner
        GridView, a mapping.OccupancyGrid (LiDAR/SLAM), or a zero-arg callable
        returning one. Execution of a planned route is done by
        `core.navigator.Navigator`, which routes motion through SafetyGuard."""
        self._nav_grid = grid_or_provider

    def _resolve_grid(self):
        g = self._nav_grid() if callable(self._nav_grid) else self._nav_grid
        if g is None:
            return None
        if hasattr(g, "blocked_grid"):  # OccupancyGrid -> inflated GridView
            from sweetie.core.planner import GridView, DEFAULT_ROBOT_R
            return GridView(g.blocked_grid(inflate_radius=DEFAULT_ROBOT_R),
                            g.res, g.origin_x, g.origin_y)
        return g

    async def plan_to(self, x: float, y: float):
        """Plan a route from the current pose to (x, y); world waypoints or None.
        Pure planning — does not move the robot. The Navigator follows the path
        and is the only thing that issues motion (through SafetyGuard)."""
        grid = self._resolve_grid()
        if grid is None:
            return None
        from sweetie.core.planner import plan_path
        st = await self.get_state()
        return plan_path(grid, (st.x, st.y), (x, y))

    async def go_to_pose(self, x: float, y: float) -> bool:
        # The bridge is intentionally "dumb": it never runs a motion loop,
        # because every command must pass SafetyGuard, which lives ABOVE the
        # bridge. So go_to_pose plans (when a map is set) and reports whether a
        # route exists; `core.navigator.Navigator` executes it safely.
        if self._nav_grid is None:
            logger.warning(
                "RealBridge.go_to_pose(%.2f, %.2f) refused — no map set "
                "(call set_nav_grid; Navigator executes the route).", x, y,
            )
            return False
        path = await self.plan_to(x, y)
        if not path:
            logger.info("RealBridge.go_to_pose: no route to (%.2f, %.2f)", x, y)
            return False
        logger.info("RealBridge.go_to_pose: route found (%d waypoints) — hand to Navigator",
                    len(path))
        return True

    async def follow_path(self, waypoints: list[tuple[float, float]]) -> bool:
        # As above: the bridge validates the path is collision-free against the
        # map (if one is set) but does not drive it; the Navigator does, gated
        # by SafetyGuard. Without a map we can't validate, so we refuse.
        if self._nav_grid is None:
            logger.warning(
                "RealBridge.follow_path(%d waypoints) refused — no map set "
                "(Navigator executes; call set_nav_grid).", len(waypoints),
            )
            return False
        grid = self._resolve_grid()
        from sweetie.core.planner import line_of_sight
        clear = all(
            line_of_sight(grid, waypoints[i][0], waypoints[i][1],
                        waypoints[i + 1][0], waypoints[i + 1][1])
            for i in range(len(waypoints) - 1)
        ) if len(waypoints) >= 2 else bool(waypoints)
        if not clear:
            logger.info("RealBridge.follow_path: path crosses an obstacle — rejected")
        return clear

    # ── Perception delegation ──────────────────────────────────────────────

    def recent_perceptions(self, window_s: float = 30.0) -> list[dict]:
        """Return perception events from the last `window_s` seconds."""
        return self._perception.recent_events(window_s=window_s)

    def vision_summary(self) -> list[dict]:
        """Currently always [] on real hardware (no semantic detector wired)."""
        with self._state_lock:
            x, y, yaw = self._state.x, self._state.y, self._state.yaw
        return self._perception.vision_summary(x, y, yaw)

    def current_region(self) -> str | None:
        """No region tracking on real hardware (no world model)."""
        return None

    async def perform_gesture(self, name: str) -> bool:
        """Play an expressive gesture by calling the matching SportClient
        method (Hello, Stretch, WiggleHips, FingerHeart, Dance1…). Names and
        ids come from `core.gestures` / the vendored ROBOT_CMD table.

        Acrobatic gestures (flips, handstand, moonwalk…) are refused unless the
        bridge was constructed with `enable_risky=True`. Unknown names, a
        firmware without the method, or a disconnected bridge all return False.
        """
        from sweetie.core.gestures import resolve
        g = resolve(name)
        if g is None:
            logger.info("perform_gesture: unknown gesture %r", name)
            return False
        if g.risky and not self._enable_risky:
            logger.warning("perform_gesture: %r is acrobatic; risky gestures disabled", name)
            return False
        if not self._connected or self._sport is None:
            return False
        fn = getattr(self._sport, g.method, None)
        if fn is None:
            logger.info("perform_gesture: SDK SportClient lacks %s", g.method)
            return False
        return await self._sdk_call(fn)

    # ── Audio hub ──────────────────────────────────────────────────────────

    async def speak_through_robot(self, text: str) -> bool:
        """Speak `text` out of the Go2's own speaker via onboard TTS.

        Primary path: the SDK's `AudioClient.TtsMaker(text, speaker_id)`, which
        runs synthesis on the robot — no host-side TTS engine or PCM chunking
        needed. Same call convention as the sport API (0 = success), run through
        `_sdk_call`. Returns True only if the robot accepted the utterance.

        Degrades cleanly: if audio is unavailable (no client, older firmware,
        or the SDK mock), returns False and the caller's chat broadcast remains
        the delivery channel. As with the sport API, the exact TtsMaker
        signature/speaker ids depend on firmware — verify on bring-up; this is
        the one line to adjust.

        Alternative for firmware without TtsMaker: stream PCM blocks through the
        raw audio hub (`AUDIO_HUB_COMMANDS`: START_AUDIO 4001 → SEND_AUDIO_BLOCK
        4003* → STOP_AUDIO 4002), see teleop/webrtc_topics.py and
        docs/hardware-bringup.md.
        """
        text = (text or "").strip()
        if not text:
            return False
        if not self._connected or self._audio is None:
            logger.info("speak_through_robot(%r) — no onboard audio; using chat fallback", text)
            return False
        tts = getattr(self._audio, "TtsMaker", None)
        if tts is None:
            logger.info("speak_through_robot — audio client lacks TtsMaker; chat fallback")
            return False
        return await self._sdk_call(tts, text, self.TTS_SPEAKER_ID)

    # ── Internals ───────────────────────────────────────────────────────────

    async def _sdk_call(self, fn: Callable[..., int], *args: Any) -> bool:
        """
        Run a synchronous SDK function in the default executor.

        Unitree SDK convention: 0 = success, nonzero = error code.
        We log and return False on any exception or nonzero return so
        the caller (safety guard or LLM tool) sees a clean bool.
        """
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(None, fn, *args)
        except Exception:
            logger.exception("RealBridge: SDK call %s raised", getattr(fn, "__name__", fn))
            return False
        if result != 0:
            logger.warning(
                "RealBridge: SDK call %s returned error code %d",
                getattr(fn, "__name__", fn), result,
            )
        return result == 0
