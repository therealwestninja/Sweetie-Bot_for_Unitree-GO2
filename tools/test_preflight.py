"""Preflight diagnostic tests.

Like RealBridge tests, these mock the SDK entirely. Every callback path
is exercised by injecting fake messages into the captured callback. No
real DDS, no real network.

Time control: `time.sleep` is patched to be instantaneous so the 3-second
windows don't actually take 3 seconds during the test run.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from sweetie.tools import preflight


# ── Fake SDK builders ───────────────────────────────────────────────────────


def _make_sport_state(mode: int = 1):
    return SimpleNamespace(
        position=[0.0, 0.0, 0.27],
        imu_state=SimpleNamespace(rpy=[0.0, 0.0, 0.0]),
        velocity=[0.0, 0.0, 0.0],
        yaw_speed=0.0,
        body_height=0.27,
        range_obstacle=[3.0, 3.0, 3.0, 3.0],
        mode=mode,
    )


def _make_low_state(soc: int = 80):
    return SimpleNamespace(bms_state=SimpleNamespace(soc=soc))


class _FakeSubscriber:
    """A subscriber whose Init() captures the callback and immediately delivers messages.

    We override `time.sleep` in tests so the "duration" never actually
    elapses; instead we feed messages synchronously from setup.
    """

    # Class attribute so all instances created during one check share scripted messages.
    _scripted_messages: dict[str, list] = {}

    def __init__(self, topic: str, _msg_class: type) -> None:
        self.topic = topic
        self._cb = None

    def Init(self, callback, _queue_len: int) -> None:
        self._cb = callback
        # Deliver any pre-scripted messages for this topic now.
        for msg in self._scripted_messages.get(self.topic, []):
            callback(msg)


def _make_fake_sdk(*, dds_init_raises: bool = False):
    """Build the dict that `_import_sdk()` would return."""
    sdk = {
        "ChannelFactoryInitialize": MagicMock(),
        "ChannelSubscriber": _FakeSubscriber,
        "SportClient": MagicMock(),
        "SportModeState_": MagicMock,
        "LowState_": MagicMock,
    }
    if dds_init_raises:
        sdk["ChannelFactoryInitialize"].side_effect = RuntimeError(
            "no such network interface"
        )
    return sdk


@pytest.fixture(autouse=True)
def _instant_sleep():
    """Make time.sleep a no-op so 3s windows complete instantly."""
    with patch("sweetie.tools.preflight.time.sleep"):
        yield


@pytest.fixture(autouse=True)
def _reset_subscriber_script():
    """Clear scripted messages between tests."""
    _FakeSubscriber._scripted_messages = {}
    yield
    _FakeSubscriber._scripted_messages = {}


# ── SDK import check ────────────────────────────────────────────────────────


def test_check_sdk_missing_returns_clean_failure():
    """When _import_sdk raises, the check fails with the actionable message."""
    err_msg = "unitree_sdk2py is not installed. Install with `pip install -e .[real]`."
    with patch(
        "sweetie.core.real_bridge._import_sdk",
        side_effect=RuntimeError(err_msg),
    ):
        result = preflight.check_sdk_importable()
    assert result.passed is False
    assert "unitree_sdk2py is not installed" in result.detail


def test_check_sdk_present_reports_class_count():
    sdk = _make_fake_sdk()
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        result = preflight.check_sdk_importable()
    assert result.passed is True
    assert "SportClient" in result.data["classes"]


# ── DDS init check ──────────────────────────────────────────────────────────


def test_check_dds_init_success():
    sdk = _make_fake_sdk()
    result = preflight.check_dds_init(sdk, interface="eth0", domain=0)
    assert result.passed is True
    sdk["ChannelFactoryInitialize"].assert_called_once_with(0, "eth0")


def test_check_dds_init_failure_includes_diagnostic():
    sdk = _make_fake_sdk(dds_init_raises=True)
    result = preflight.check_dds_init(sdk, interface="bogus0", domain=0)
    assert result.passed is False
    assert "bogus0" in result.detail
    assert "no such network interface" in result.detail


# ── Topic check ─────────────────────────────────────────────────────────────


def test_check_topic_no_messages_fails():
    sdk = _make_fake_sdk()
    # No scripted messages for this topic
    result = preflight.check_topic(
        sdk, "rt/sportmodestate", "SportModeState_",
        expected_fields=["position"], duration_s=3.0,
    )
    assert result.passed is False
    assert "no messages received" in result.detail


def test_check_topic_messages_present_success():
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [_make_sport_state() for _ in range(150)],
    }
    result = preflight.check_topic(
        sdk, "rt/sportmodestate", "SportModeState_",
        expected_fields=["position", "imu_state", "mode"], duration_s=3.0,
    )
    assert result.passed is True
    assert result.data["count"] == 150
    assert "rate_hz" in result.data


def test_check_topic_missing_field_fails_with_specifics():
    sdk = _make_fake_sdk()
    bad_msg = SimpleNamespace(position=[0, 0, 0])  # missing imu_state, mode
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [bad_msg],
    }
    result = preflight.check_topic(
        sdk, "rt/sportmodestate", "SportModeState_",
        expected_fields=["position", "imu_state", "mode"], duration_s=3.0,
    )
    assert result.passed is False
    assert "imu_state" in result.detail
    assert "mode" in result.detail
    assert result.data["missing_fields"] == ["imu_state", "mode"]


def test_check_topic_validates_nested_fields():
    """`imu_state.rpy` requires walking the dotted path."""
    sdk = _make_fake_sdk()
    msg_no_rpy = SimpleNamespace(
        position=[0, 0, 0], imu_state=SimpleNamespace(),
    )
    _FakeSubscriber._scripted_messages = {"rt/sportmodestate": [msg_no_rpy]}
    result = preflight.check_topic(
        sdk, "rt/sportmodestate", "SportModeState_",
        expected_fields=["imu_state.rpy"], duration_s=3.0,
    )
    assert result.passed is False
    assert "imu_state.rpy" in result.detail


def test_check_topic_missing_schema_class_fails_cleanly():
    sdk = _make_fake_sdk()
    del sdk["LowState_"]  # simulate SDK that doesn't expose the schema
    result = preflight.check_topic(
        sdk, "rt/lowstate", "LowState_",
        expected_fields=["bms_state"], duration_s=3.0,
    )
    assert result.passed is False
    assert "missing schema class" in result.detail


# ── Mode-code observation ───────────────────────────────────────────────────


def test_check_mode_codes_aggregates_distinct_values():
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": (
            [_make_sport_state(mode=0)] * 100
            + [_make_sport_state(mode=1)] * 50
        ),
    }
    result = preflight.check_mode_codes(sdk, duration_s=5.0)
    assert result.passed is True
    assert result.data["counts"] == {0: 100, 1: 50}
    assert "mode=0" in result.detail and "mode=1" in result.detail


def test_check_mode_codes_no_messages_fails():
    sdk = _make_fake_sdk()
    result = preflight.check_mode_codes(sdk, duration_s=5.0)
    assert result.passed is False
    assert "no SportModeState" in result.detail


# ── Orchestration: run_preflight ────────────────────────────────────────────


def test_run_preflight_short_circuits_on_missing_sdk():
    """If the SDK isn't importable, no further checks run."""
    with patch(
        "sweetie.core.real_bridge._import_sdk",
        side_effect=RuntimeError("not installed"),
    ):
        results = preflight.run_preflight(window_s=0.0)
    assert len(results) == 1
    assert results[0].name == "SDK importable"
    assert results[0].passed is False


def test_run_preflight_short_circuits_on_dds_failure():
    sdk = _make_fake_sdk(dds_init_raises=True)
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        results = preflight.run_preflight(window_s=0.0)
    names = [r.name for r in results]
    assert names == ["SDK importable", "DDS factory init"]
    assert results[1].passed is False


def test_run_preflight_full_path_with_healthy_robot():
    """All checks run and pass when SDK + DDS + topics are healthy."""
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [_make_sport_state(mode=1)] * 60,
        "rt/lowstate":       [_make_low_state(soc=80)] * 12,
    }
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        results = preflight.run_preflight(window_s=3.0)
    assert all(r.passed for r in results), [
        f"{r.name}: {r.detail}" for r in results if not r.passed
    ]
    # Expected: SDK + DDS + 2 topics + mode observation
    assert len(results) == 5


# ── Output rendering ────────────────────────────────────────────────────────


def test_render_text_marks_status():
    results = [
        preflight.CheckResult(name="ok thing", passed=True, detail="all good"),
        preflight.CheckResult(name="bad thing", passed=False, detail="went wrong"),
    ]
    out = preflight.render_text(results, use_color=False)
    assert "OK" in out and "FAIL" in out
    assert "all good" in out and "went wrong" in out
    assert "1 checks passed, 1 failed" in out


def test_render_json_round_trip():
    import json
    results = [
        preflight.CheckResult(
            name="x", passed=True, detail="d",
            data={"rate_hz": 50.0, "count": 150},
        ),
    ]
    parsed = json.loads(preflight.render_json(results))
    assert parsed[0]["name"] == "x"
    assert parsed[0]["data"]["count"] == 150


# ── CLI ─────────────────────────────────────────────────────────────────────


def test_main_returns_2_when_sdk_missing(capsys):
    with patch(
        "sweetie.core.real_bridge._import_sdk",
        side_effect=RuntimeError("not installed"),
    ):
        rc = preflight.main(["--no-color"])
    assert rc == 2
    out = capsys.readouterr().out
    assert "FAIL" in out


def test_main_returns_0_when_all_pass(capsys):
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [_make_sport_state(mode=1)] * 60,
        "rt/lowstate":       [_make_low_state(soc=80)] * 12,
    }
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        rc = preflight.main(["--no-color", "--window", "1.0"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "FAIL" not in out
    assert "checks passed" in out


def test_main_returns_1_when_a_topic_check_fails(capsys):
    """SDK + DDS pass but a topic isn't publishing."""
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [_make_sport_state(mode=1)] * 60,
        # No messages for rt/lowstate
    }
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        rc = preflight.main(["--no-color", "--window", "1.0"])
    assert rc == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "rt/lowstate" in out


def test_main_json_output_is_valid_json(capsys):
    import json
    sdk = _make_fake_sdk()
    _FakeSubscriber._scripted_messages = {
        "rt/sportmodestate": [_make_sport_state()] * 30,
        "rt/lowstate":       [_make_low_state()] * 6,
    }
    with patch("sweetie.core.real_bridge._import_sdk", return_value=sdk):
        rc = preflight.main(["--json"])
    assert rc == 0
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert isinstance(parsed, list)
    assert all(isinstance(r["name"], str) for r in parsed)
