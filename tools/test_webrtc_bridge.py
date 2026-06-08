"""WebRTCBridge tests with a mock connection — no hardware, no network.

Verifies the transport-agnostic parts: correct api-id/parameters per command,
state parsing, gesture/risk gating, nav planning, and that the AES key flows
into the connection config. The live driver wrapper is not exercised."""

from __future__ import annotations


import pytest

from sweetie.core.webrtc_bridge import WebRTCBridge, SPORT_REQ_TOPIC, CMD
from sweetie.core.planner import GridView


class MockConn:
    """Records published sport requests; lets tests inject state messages."""
    def __init__(self, config):
        self.config = config
        self.published = []          # list of (topic, payload)
        self.subs = {}               # topic -> callback
        self.connected = False

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def publish(self, topic, payload):
        self.published.append((topic, payload))

    async def subscribe(self, topic, cb):
        self.subs[topic] = cb


def _bridge(**kw):
    """A WebRTCBridge whose factory returns a MockConn (captured for asserts)."""
    holder = {}

    def factory(config):
        holder["conn"] = MockConn(config)
        return holder["conn"]

    b = WebRTCBridge(factory=factory, **kw)
    return b, holder


@pytest.mark.asyncio
async def test_connect_subscribes_state_topics():
    b, h = _bridge(method="ap")
    await b.connect()
    assert h["conn"].connected
    assert "rt/lf/sportmodestate" in h["conn"].subs
    assert "rt/lf/lowstate" in h["conn"].subs
    await b.disconnect()


@pytest.mark.asyncio
async def test_move_publishes_correct_api_and_params():
    b, h = _bridge()
    await b.connect()
    assert await b.move(0.5, -0.1, 0.3) is True
    topic, payload = h["conn"].published[-1]
    assert topic == SPORT_REQ_TOPIC
    assert payload["api_id"] == CMD["Move"]
    assert payload["parameter"] == {"x": 0.5, "y": -0.1, "z": 0.3}


@pytest.mark.asyncio
async def test_move_clamps_to_envelope():
    b, h = _bridge()
    await b.connect()
    await b.move(99.0, 0.0, 0.0)
    assert h["conn"].published[-1][1]["parameter"]["x"] <= 1.5  # VX_LIMIT


@pytest.mark.asyncio
async def test_posture_and_estop_api_ids():
    b, h = _bridge()
    await b.connect()
    for call, name in [(b.stand_up(), "StandUp"), (b.stand_down(), "StandDown"),
                    (b.stop_move(), "StopMove"), (b.emergency_stop(), "Damp"),
                    (b.clear_estop(), "RecoveryStand")]:
        await call
        assert h["conn"].published[-1][1]["api_id"] == CMD[name]


@pytest.mark.asyncio
async def test_gesture_resolves_api_id_and_gates_risky():
    b, h = _bridge()
    await b.connect()
    assert await b.perform_gesture("hello") is True
    assert h["conn"].published[-1][1]["api_id"] == 1016  # Hello
    n = len(h["conn"].published)
    assert await b.perform_gesture("frontflip") is False  # risky, disabled
    assert len(h["conn"].published) == n                  # nothing sent

    b2, h2 = _bridge(enable_risky=True)
    await b2.connect()
    assert await b2.perform_gesture("frontflip") is True
    assert h2["conn"].published[-1][1]["api_id"] == 1030  # FrontFlip


@pytest.mark.asyncio
async def test_state_parsing_from_sportmodestate():
    b, h = _bridge()
    await b.connect()
    cb = h["conn"].subs["rt/lf/sportmodestate"]
    cb({"position": [1.5, -2.0, 0.3], "velocity": [0.2, 0.0, 0.1],
        "imu_state": {"rpy": [0.01, -0.02, 1.57]},
        "range_obstacle": [3.0, 5.0, 5.0, 1.2], "mode": 2, "body_height": 0.30})
    st = await b.get_state()
    assert (round(st.x, 2), round(st.y, 2)) == (1.5, -2.0)
    assert round(st.yaw, 2) == 1.57
    assert st.range_obstacle[3] == 1.2
    assert st.mode == "moving"


@pytest.mark.asyncio
async def test_low_state_battery_parsing():
    b, h = _bridge()
    await b.connect()
    h["conn"].subs["rt/lf/lowstate"]({"bms_state": {"soc": 42.0}})
    assert (await b.get_state()).battery_percent == 42.0


@pytest.mark.asyncio
async def test_aes_key_flows_into_connection_config(monkeypatch):
    monkeypatch.delenv("UNITREE_AES_128_KEY", raising=False)
    key = "00112233445566778899aabbccddeeff"
    b, h = _bridge(method="sta", ip="192.168.10.225", aes_128_key=key)
    await b.connect()
    assert h["conn"].config["aes_128_key"] == key
    assert h["conn"].config["ip"] == "192.168.10.225"


@pytest.mark.asyncio
async def test_nav_plan_to_routes_with_grid():
    b, h = _bridge()
    await b.connect()
    open_grid = GridView([[0] * 8 for _ in range(8)], resolution=1.0)
    b.set_nav_grid(open_grid)
    route = await b.plan_to(6.0, 0.0)
    assert route and route[-1][0] > 5.0
    await b.disconnect()


@pytest.mark.asyncio
async def test_not_connected_commands_are_noops():
    b, _ = _bridge()
    # never connected
    assert await b.move(0.1, 0, 0) is False
    assert await b.stand_up() is False
