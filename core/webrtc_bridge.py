"""
WebRTC transport bridge — account-free control on base Go2 models.

`RealBridge` talks DDS via `unitree_sdk2py` (EDU, or AIR/PRO with custom
firmware). `WebRTCBridge` talks the **same WebRTC protocol the Unitree Go app
uses**, which works on AIR/PRO/EDU out of the box with **no account and no
firmware modification** when connecting locally (LocalAP / LocalSTA). See
`docs/transport-and-firmware-policy.md`.

It presents the same `BridgeBase` surface as `RealBridge`, so cognition/teleop
don't care which transport is live. High-level sport commands are published to
`rt/api/sport/request` with the same api-ids as DDS (`core.gestures` / the
ROBOT_CMD table); state is read from `rt/lf/sportmodestate` and `rt/lf/lowstate`.

Honesty notes:
  * The live connection is created through a small factory seam
    (`_default_factory`) that wraps `go2_webrtc_connect` / `unitree_webrtc_connect`.
    Those libraries' exact pub/sub method names vary by version, so the wrapper
    is the one place to adjust on bring-up. Everything else — command
    construction (correct api-id + parameters), state parsing, gesture/risk
    gating, planning — is transport-agnostic and unit-tested with a mock
    connection (no hardware, no network).
  * WebRTC is high-level only (no `rt/lowcmd`); fine for sweetie's behaviour set.
"""

from __future__ import annotations
from sweetie.core.mathutil import clamp

import json
import logging

from sweetie.core.bridge import (
    BridgeBase, RobotState, VX_LIMIT, VY_LIMIT, VYAW_LIMIT,
    BODY_HEIGHT_MIN, BODY_HEIGHT_MAX, BODY_HEIGHT_DEFAULT,
)
from sweetie.core.gestures import resolve as resolve_gesture
from sweetie.core.navgrid import NavGridMixin

logger = logging.getLogger(__name__)

# Topics
SPORT_REQ_TOPIC = "rt/api/sport/request"
SPORT_STATE_TOPIC = "rt/lf/sportmodestate"   # WebRTC low-frequency state
LOW_STATE_TOPIC = "rt/lf/lowstate"

# Sport api-ids we use (subset of the ROBOT_CMD table; kept local so core/ does
# not depend on teleop/). Gestures resolve their own ids via core.gestures.
CMD = {
    "Damp": 1001, "BalanceStand": 1002, "StopMove": 1003, "StandUp": 1004,
    "StandDown": 1005, "RecoveryStand": 1006, "Move": 1008, "BodyHeight": 1013,
}

_MODE_MAP = {0: "down", 1: "standing", 2: "moving"}  # coarse; verify on hardware


class WebRTCBridge(NavGridMixin, BridgeBase):
    def __init__(self, *, method: str = "sta", ip: str | None = None,
                serial: str | None = None, aes_128_key: str | None = None,
                username: str | None = None, password: str | None = None,
                enable_risky: bool = False, factory=None) -> None:
        """
        method: "ap" (robot's own Wi-Fi), "sta" (same LAN; needs ip or serial),
                or "remote" (TURN relay — REQUIRES a Unitree account; avoid).
        aes_128_key: per-device key for firmware >= 1.1.15 (see core.go2_keys);
                     None for legacy firmware. Resolved via go2_keys at connect.
        factory: optional callable(config) -> connection, for tests/custom wiring.
        """
        self._method = method
        self._ip = ip
        self._serial = serial
        self._aes_key_in = aes_128_key
        self._username = username
        self._password = password
        self._enable_risky = bool(enable_risky)
        self._factory = factory
        self._conn = None
        self._connected = False
        self._state = RobotState()
        self._state.mode = "down"
        self._nav_grid = None
        self._lidar_mapper = None

    # ── lifecycle ───────────────────────────────────────────────────────────

    def _conn_config(self) -> dict:
        from sweetie.core.go2_keys import resolve_aes_key
        key = resolve_aes_key(self._aes_key_in)  # explicit -> env -> None
        if self._method == "remote":
            logger.warning("WebRTCBridge: 'remote' uses Unitree's TURN relay and "
                        "requires an account — prefer 'ap'/'sta' for offline use")
        return {"method": self._method, "ip": self._ip, "serial": self._serial,
                "aes_128_key": key, "username": self._username,
                "password": self._password}

    async def connect(self) -> None:
        if self._connected:
            return
        factory = self._factory or _default_factory
        self._conn = factory(self._conn_config())
        await self._conn.connect()
        await self._conn.subscribe(SPORT_STATE_TOPIC, self._on_sport_state)
        await self._conn.subscribe(LOW_STATE_TOPIC, self._on_low_state)
        self._connected = True
        logger.info("WebRTCBridge connected (method=%s)", self._method)

    async def disconnect(self) -> None:
        self._connected = False
        if self._conn is not None:
            try:
                await self._conn.disconnect()
            except Exception:
                logger.exception("WebRTCBridge: disconnect raised")
        self._conn = None
        self._lidar_mapper = None
        logger.info("WebRTCBridge disconnected")

    # ── command plumbing ──────────────────────────────────────────────────────

    async def _sport(self, api_id: int, parameter=None) -> bool:
        """Publish a sport request. Returns False if not connected / on error."""
        if not self._connected or self._conn is None:
            return False
        payload = {"api_id": int(api_id)}
        if parameter is not None:
            payload["parameter"] = parameter
        try:
            await self._conn.publish(SPORT_REQ_TOPIC, payload)
            return True
        except Exception:
            logger.exception("WebRTCBridge: publish api_id=%s failed", api_id)
            return False

    # ── motion / posture ──────────────────────────────────────────────────────

    async def move(self, vx: float, vy: float, vyaw: float) -> bool:
        cvx = clamp(float(vx), -VX_LIMIT, VX_LIMIT)
        cvy = clamp(float(vy), -VY_LIMIT, VY_LIMIT)
        cvyaw = clamp(float(vyaw), -VYAW_LIMIT, VYAW_LIMIT)
        return await self._sport(CMD["Move"], {"x": cvx, "y": cvy, "z": cvyaw})

    async def stop_move(self) -> bool:
        return await self._sport(CMD["StopMove"])

    async def stand_up(self) -> bool:
        return await self._sport(CMD["StandUp"])

    async def stand_down(self) -> bool:
        return await self._sport(CMD["StandDown"])

    async def emergency_stop(self) -> bool:
        return await self._sport(CMD["Damp"])

    async def clear_estop(self) -> bool:
        return await self._sport(CMD["RecoveryStand"])

    async def set_body_height(self, meters: float) -> bool:
        clamped = clamp(float(meters), BODY_HEIGHT_MIN, BODY_HEIGHT_MAX)
        offset = clamped - BODY_HEIGHT_DEFAULT  # SDK takes a relative offset
        return await self._sport(CMD["BodyHeight"], {"data": offset})

    async def perform_gesture(self, name: str) -> bool:
        g = resolve_gesture(name)
        if g is None:
            logger.info("WebRTCBridge: unknown gesture %r", name)
            return False
        if g.risky and not self._enable_risky:
            logger.warning("WebRTCBridge: %r is acrobatic; risky gestures disabled", name)
            return False
        return await self._sport(g.api_id)

    # ── state ───────────────────────────────────────────────────────────────

    async def get_state(self) -> RobotState:
        return self._state

    def _on_sport_state(self, msg) -> None:
        """Parse a WebRTC sportmodestate payload into RobotState (defensive)."""
        d = _as_dict(msg)
        s = self._state
        pos = d.get("position") or []
        if len(pos) >= 2:
            s.x, s.y = float(pos[0]), float(pos[1])
        vel = d.get("velocity") or []
        if len(vel) >= 3:
            s.vx, s.vy, s.vyaw = float(vel[0]), float(vel[1]), float(vel[2])
        imu = d.get("imu_state") or d.get("imu") or {}
        rpy = (imu.get("rpy") if isinstance(imu, dict) else None) or []
        if len(rpy) >= 3:
            s.roll, s.pitch, s.yaw = float(rpy[0]), float(rpy[1]), float(rpy[2])
        rng = d.get("range_obstacle")
        if rng and len(rng) >= 4:
            s.range_obstacle = [float(v) for v in rng[:4]]
        if "body_height" in d:
            s.body_height = float(d["body_height"])
        if "mode" in d:
            m = d["mode"]
            s.mode = _MODE_MAP.get(int(m), s.mode) if isinstance(m, (int, float)) else str(m)

    def _on_low_state(self, msg) -> None:
        d = _as_dict(msg)
        bms = d.get("bms_state") or d.get("bms") or {}
        if isinstance(bms, dict) and "soc" in bms:
            self._state.battery_percent = float(bms["soc"])

    # ── navigation (parity with RealBridge) ───────────────────────────────────

    async def go_to_pose(self, x: float, y: float) -> bool:
        if self._nav_grid is None:
            return False
        return bool(await self.plan_to(x, y))

    async def follow_path(self, waypoints) -> bool:
        if self._nav_grid is None or not waypoints:
            return False
        from sweetie.core.planner import line_of_sight
        grid = self._resolve_grid()
        if len(waypoints) < 2:
            return True
        return all(
            line_of_sight(grid, waypoints[i][0], waypoints[i][1],
                        waypoints[i + 1][0], waypoints[i + 1][1])
            for i in range(len(waypoints) - 1)
        )

    def ingest_voxel_map(self, msg) -> int:
        if self._lidar_mapper is None:
            from sweetie.core.lidar_map import LidarMapper
            self._lidar_mapper = LidarMapper()
            if self._nav_grid is None:
                self._nav_grid = lambda: (
                    self._lidar_mapper.grid_view() if self._lidar_mapper else None)
        return self._lidar_mapper.ingest(msg, self._state.x, self._state.y, self._state.yaw)

    # ── read-only helpers (perception over WebRTC is a future seam) ───────────

    async def look_at_entity(self, name: str) -> str:
        return "no_world"

    def recent_perceptions(self, window_s: float = 30.0) -> list[dict]:
        return []

    def vision_summary(self) -> list[dict]:
        return []

    def current_region(self):
        return None

    async def speak_through_robot(self, text: str) -> bool:
        # WebRTC speech would go through the VUI / AudioHub channel; left as a
        # documented seam (verify per firmware). Returns False so cognition's
        # chat broadcast remains the delivery channel.
        logger.info("WebRTCBridge.speak_through_robot(%r) — VUI/AudioHub seam not wired", text)
        return False


def _as_dict(msg) -> dict:
    """WebRTC payloads arrive as dicts or JSON strings; normalize to dict."""
    if isinstance(msg, dict):
        return msg.get("data", msg) if "data" in msg else msg
    if isinstance(msg, (bytes, str)):
        try:
            d = json.loads(msg)
            return d.get("data", d) if isinstance(d, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _default_factory(config: dict):
    """Wrap go2_webrtc_connect / unitree_webrtc_connect into the minimal
    connection interface this bridge uses (connect/disconnect/publish/subscribe).

    This is the single hardware-integration seam: the underlying driver's exact
    pub/sub method names vary by version, so adjust here on bring-up. Raises with
    guidance if no driver is installed."""
    try:
        from go2_webrtc_connect import (  # type: ignore[import-not-found]
            Go2WebRTCConnection, WebRTCConnectionMethod,
        )
    except Exception as e:
        raise RuntimeError(
            "No WebRTC driver installed. `pip install go2-webrtc-connect` (or "
            "unitree_webrtc_connect), then this factory wraps it. For firmware "
            ">= 1.1.15 supply the per-device key via core.go2_keys / "
            "UNITREE_AES_128_KEY."
        ) from e

    method = config["method"]
    if method == "ap":
        raw = Go2WebRTCConnection(WebRTCConnectionMethod.LocalAP)
    elif method == "remote":
        raw = Go2WebRTCConnection(WebRTCConnectionMethod.Remote,
                                serialNumber=config.get("serial"),
                                username=config.get("username"),
                                password=config.get("password"))
    else:  # sta
        kwargs = {}
        if config.get("ip"):
            kwargs["ip"] = config["ip"]
        elif config.get("serial"):
            kwargs["serialNumber"] = config["serial"]
        if config.get("aes_128_key"):
            kwargs["aes_128_key"] = config["aes_128_key"]
        raw = Go2WebRTCConnection(WebRTCConnectionMethod.LocalSTA, **kwargs)

    return _DriverAdapter(raw)


class _DriverAdapter:
    """Adapts a go2_webrtc_connect connection to connect/disconnect/publish/
    subscribe. Method names below are the bring-up adjustment point."""

    def __init__(self, raw):
        self.raw = raw

    async def connect(self):
        await self.raw.connect()

    async def disconnect(self):
        disc = getattr(self.raw, "disconnect", None)
        if disc:
            await disc()

    async def publish(self, topic, payload):
        # go2_webrtc_connect: conn.datachannel.pub_sub.publish_request_new(topic, payload)
        pub = self.raw.datachannel.pub_sub
        fn = getattr(pub, "publish_request_new", None) or getattr(pub, "publish")
        await fn(topic, payload)

    async def subscribe(self, topic, cb):
        await self.raw.datachannel.pub_sub.subscribe(topic, cb)
