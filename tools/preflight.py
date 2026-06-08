"""
Pre-flight diagnostic for real-Go2 bring-up.

Run before letting `RealBridge` send anything to the robot. Verifies:
- `unitree_sdk2py` is importable (we have a clean error if not).
- DDS factory can initialize on the configured network interface.
- The robot is publishing on the topics we expect (`rt/sportmodestate`,
  `rt/lowstate`).
- The first message on each topic carries the fields we expect to read.
- What sport-mode codes the robot actually emits at idle.

What this tool does NOT do:
- Send anything to the robot. It is strictly read-only.
- Verify motion behaviour. That requires actually moving the robot,
  which is a separate (riskier) test.
- Test the whole API surface. It checks the topics `RealBridge` reads,
  not (for example) the audio hub or arm-control topics.

Usage:
    python -m sweetie.tools.preflight
    python -m sweetie.tools.preflight --interface eth0 --domain 0
    python -m sweetie.tools.preflight --window 5.0    # observe each topic for 5s
    python -m sweetie.tools.preflight --json          # machine-readable output

Exit code:
    0 — every check passed
    1 — at least one check failed
    2 — preflight could not run (e.g. SDK missing)

The tool re-uses `_import_sdk()` from `sweetie.core.real_bridge` so the
same import path that gates production bridge startup gates this one.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("sweetie.preflight")


# ── Result types ────────────────────────────────────────────────────────────


@dataclass
class CheckResult:
    """Outcome of a single pre-flight check."""

    name: str
    passed: bool
    detail: str = ""
    # Free-form structured payload for `--json` output. Keep small —
    # this is a CLI tool, not a telemetry pipe.
    data: dict[str, Any] = field(default_factory=dict)


# ── Topics we expect the robot to publish ───────────────────────────────────
#
# Names from upstream `unitree_ros2` and our `RealBridge`. If you target
# a different transport (WebRTC), the names differ — see
# `docs/go2-references.md` and `third_party/go2_ros2_sdk/webrtc_topics.py`.

EXPECTED_TOPICS = {
    "rt/sportmodestate": {
        "schema_key": "SportModeState_",
        # Field paths we read in `RealBridge._on_sport_state`.
        "expected_fields": [
            "position", "imu_state", "velocity", "yaw_speed",
            "body_height", "range_obstacle", "mode",
        ],
    },
    "rt/lowstate": {
        "schema_key": "LowState_",
        "expected_fields": ["bms_state"],
    },
}


# ── Topic probe ─────────────────────────────────────────────────────────────


def _probe_topic(
    sdk: dict[str, Any],
    topic_name: str,
    msg_class: Any,
    duration_s: float,
) -> tuple[int, list[Any]]:
    """
    Subscribe to `topic_name` for `duration_s` seconds, return (count, samples).

    Samples is up to 5 messages — enough for schema inspection without
    holding much memory if the topic is high-rate.
    """
    received: list[Any] = []
    counter = [0]

    def callback(msg: Any) -> None:
        counter[0] += 1
        if len(received) < 5:
            received.append(msg)

    sub = sdk["ChannelSubscriber"](topic_name, msg_class)
    sub.Init(callback, 10)
    time.sleep(duration_s)
    return counter[0], received


def _has_field(msg: Any, dotted: str) -> bool:
    """Walk a dotted attribute path; return True if every segment exists."""
    obj = msg
    for part in dotted.split("."):
        if not hasattr(obj, part):
            return False
        obj = getattr(obj, part)
    return True


# ── Individual checks ───────────────────────────────────────────────────────


def check_sdk_importable() -> CheckResult:
    """Step 1: can we import unitree_sdk2py?"""
    try:
        from sweetie.core.real_bridge import _import_sdk
        sdk = _import_sdk()
    except RuntimeError as e:
        return CheckResult(
            name="SDK importable", passed=False,
            detail=str(e).split(". Original error:")[0] + ".",
        )
    classes = sorted(sdk.keys())
    return CheckResult(
        name="SDK importable", passed=True,
        detail=f"{len(classes)} symbols available",
        data={"classes": classes},
    )


def check_dds_init(sdk: dict[str, Any], interface: str, domain: int) -> CheckResult:
    """Step 2: can ChannelFactoryInitialize succeed?

    Cyclone DDS is process-global; if this fails we usually can't recover
    inside the same Python process, so the tool should exit afterwards.
    """
    try:
        sdk["ChannelFactoryInitialize"](domain, interface)
    except Exception as e:
        return CheckResult(
            name="DDS factory init", passed=False,
            detail=f"interface={interface} domain={domain}: {type(e).__name__}: {e}",
        )
    return CheckResult(
        name="DDS factory init", passed=True,
        detail=f"interface={interface} domain={domain}",
    )


def check_topic(
    sdk: dict[str, Any],
    topic: str,
    schema_key: str,
    expected_fields: list[str],
    duration_s: float,
) -> CheckResult:
    """Subscribe; verify messages arrive; verify the expected fields are present."""
    msg_class = sdk.get(schema_key)
    if msg_class is None:
        return CheckResult(
            name=f"Topic: {topic}", passed=False,
            detail=f"SDK is missing schema class {schema_key!r}",
        )
    try:
        count, samples = _probe_topic(sdk, topic, msg_class, duration_s)
    except Exception as e:
        return CheckResult(
            name=f"Topic: {topic}", passed=False,
            detail=f"subscribe failed: {type(e).__name__}: {e}",
        )
    if count == 0:
        return CheckResult(
            name=f"Topic: {topic}", passed=False,
            detail=(
                f"no messages received in {duration_s:.1f}s — robot not "
                "publishing, network down, or wrong topic name"
            ),
        )
    rate_hz = count / duration_s
    sample = samples[0]
    missing = [f for f in expected_fields if not _has_field(sample, f)]
    if missing:
        return CheckResult(
            name=f"Topic: {topic}", passed=False,
            detail=(
                f"received {count} messages ({rate_hz:.1f} Hz) but schema "
                f"is missing fields: {', '.join(missing)}"
            ),
            data={"rate_hz": round(rate_hz, 2), "missing_fields": missing},
        )
    return CheckResult(
        name=f"Topic: {topic}", passed=True,
        detail=f"received {count} messages ({rate_hz:.1f} Hz); all expected fields present",
        data={"rate_hz": round(rate_hz, 2), "count": count},
    )


def check_mode_codes(sdk: dict[str, Any], duration_s: float) -> CheckResult:
    """Log every distinct `mode` value seen in SportModeState during the window.

    Useful for hardware bring-up because our `RealBridge._mode_to_str`
    mapping is unverified; running this and seeing what codes the robot
    actually emits at idle / standing / walking lets you fill in the
    table.
    """
    msg_class = sdk.get("SportModeState_")
    if msg_class is None:
        return CheckResult(
            name="Sport mode observation", passed=False,
            detail="SDK is missing SportModeState_ class",
        )
    counts: dict[int, int] = {}

    def callback(msg: Any) -> None:
        try:
            m = int(msg.mode)
        except Exception:
            return
        counts[m] = counts.get(m, 0) + 1

    try:
        sub = sdk["ChannelSubscriber"]("rt/sportmodestate", msg_class)
        sub.Init(callback, 10)
        time.sleep(duration_s)
    except Exception as e:
        return CheckResult(
            name="Sport mode observation", passed=False,
            detail=f"{type(e).__name__}: {e}",
        )
    if not counts:
        return CheckResult(
            name="Sport mode observation", passed=False,
            detail="no SportModeState messages received during the window",
        )
    formatted = ", ".join(f"mode={m} ×{n}" for m, n in sorted(counts.items()))
    return CheckResult(
        name="Sport mode observation", passed=True,
        detail=f"observed: {formatted}",
        data={"counts": counts},
    )


# ── Orchestration ──────────────────────────────────────────────────────────


def run_preflight(
    interface: str = "eth0",
    domain: int = 0,
    window_s: float = 3.0,
) -> list[CheckResult]:
    """
    Run all preflight checks in order. Stop early if SDK or DDS fails —
    every later check depends on them.
    """
    results: list[CheckResult] = []

    sdk_check = check_sdk_importable()
    results.append(sdk_check)
    if not sdk_check.passed:
        return results

    # SDK is importable; load it for the remaining checks.
    from sweetie.core.real_bridge import _import_sdk
    sdk = _import_sdk()

    dds_check = check_dds_init(sdk, interface, domain)
    results.append(dds_check)
    if not dds_check.passed:
        return results

    for topic, spec in EXPECTED_TOPICS.items():
        results.append(check_topic(
            sdk, topic, spec["schema_key"], spec["expected_fields"], window_s,
        ))

    results.append(check_mode_codes(sdk, window_s))
    return results


# ── Output formatting ───────────────────────────────────────────────────────


_GREEN = "\033[32m"
_RED = "\033[31m"
_DIM = "\033[2m"
_RESET = "\033[0m"


def render_text(results: list[CheckResult], use_color: bool = True) -> str:
    """Human-readable report. Emoji-free; ANSI-color optional."""
    g = _GREEN if use_color else ""
    r = _RED if use_color else ""
    d = _DIM if use_color else ""
    z = _RESET if use_color else ""

    lines: list[str] = []
    lines.append("sweetie preflight diagnostic")
    lines.append("============================")
    lines.append("")
    for i, c in enumerate(results, start=1):
        status = f"{g}OK {z}" if c.passed else f"{r}FAIL{z}"
        lines.append(f"[{i}/{len(results)}] {c.name:<48s} {status}")
        if c.detail:
            for line in c.detail.split("\n"):
                lines.append(f"        {d}{line}{z}")
        lines.append("")
    passed = sum(1 for c in results if c.passed)
    failed = len(results) - passed
    summary = f"{passed} checks passed, {failed} failed"
    if failed:
        summary = f"{r}{summary}{z}"
    lines.append(summary)
    return "\n".join(lines)


def render_json(results: list[CheckResult]) -> str:
    return json.dumps(
        [
            {
                "name": c.name,
                "passed": c.passed,
                "detail": c.detail,
                "data": c.data,
            }
            for c in results
        ],
        indent=2,
    )


# ── CLI ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sweetie.tools.preflight",
        description="Read-only DDS preflight check for Unitree Go2 bring-up.",
    )
    parser.add_argument(
        "--interface", default="eth0",
        help="Network interface for DDS (default: eth0).",
    )
    parser.add_argument(
        "--domain", type=int, default=0,
        help="DDS domain ID (default: 0).",
    )
    parser.add_argument(
        "--window", type=float, default=3.0,
        help="Per-topic observation window in seconds (default: 3.0).",
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Emit machine-readable JSON instead of the text report.",
    )
    parser.add_argument(
        "--no-color", action="store_true",
        help="Disable ANSI colors in the text report.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(message)s")

    results = run_preflight(
        interface=args.interface,
        domain=args.domain,
        window_s=args.window,
    )

    if args.json:
        print(render_json(results))
    else:
        print(render_text(results, use_color=not args.no_color))

    if not results:
        return 2  # no checks ran at all
    if not results[0].passed:
        return 2  # SDK missing — couldn't even start
    return 0 if all(c.passed for c in results) else 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
