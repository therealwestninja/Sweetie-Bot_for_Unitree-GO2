"""
Gesture vocabulary — expressive names mapped to real Go2 sport-mode commands.

Single source of truth shared by the sim bridge, the real bridge, and the
cognition `gesture` tool, grounded in the vendored RoboVerse ROBOT_CMD table
(`teleop/robot_commands.py`). Each entry records the `unitree_sdk2py`
SportClient method name, the upstream API id (cross-reference + the WebRTC
path), whether it's "risky" (acrobatic — gated behind an explicit enable so the
LLM/operator can't casually backflip the robot), and a short description.

This reconciles the earlier PoC's free-text gesture set to the actual command
table, so a name like "moonwalk" maps to a real command (MoonWalk=1305) instead
of being treated as unknown.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Gesture:
    method: str   # unitree_sdk2py SportClient method name
    api_id: int   # ROBOT_CMD id, for cross-reference / the WebRTC transport
    risky: bool   # acrobatic / could hurt the robot — needs enable_risky
    desc: str


GESTURES: dict[str, Gesture] = {
    # ── expressive, safe on flat ground ──────────────────────────────────────
    "hello":   Gesture("Hello", 1016, False, "wave a front paw"),
    "stretch": Gesture("Stretch", 1017, False, "a big stretch"),
    "wiggle":  Gesture("WiggleHips", 1033, False, "wiggle the hips"),
    "heart":   Gesture("FingerHeart", 1036, False, "make a little heart"),
    "sit":     Gesture("Sit", 1009, False, "sit down on haunches"),
    "rise":    Gesture("RiseSit", 1010, False, "rise back up from sitting"),
    "dance":   Gesture("Dance1", 1022, False, "a short dance"),
    "dance2":  Gesture("Dance2", 1023, False, "a longer dance"),
    "content": Gesture("Content", 1020, False, "look pleased / content"),
    "scrape":  Gesture("Scrape", 1029, False, "scrape a paw like a happy dog"),
    "pounce":  Gesture("FrontPounce", 1032, False, "a playful little pounce"),
    # ── acrobatic / risky — gated behind enable_risky ───────────────────────
    "frontflip": Gesture("FrontFlip", 1030, True, "front flip"),
    "frontjump": Gesture("FrontJump", 1031, True, "front jump"),
    "handstand": Gesture("Handstand", 1301, True, "handstand"),
    "moonwalk":  Gesture("MoonWalk", 1305, True, "moonwalk backwards"),
    "bound":     Gesture("Bound", 1304, True, "bounding gait"),
    "wallow":    Gesture("Wallow", 1021, True, "roll over / wallow"),
}

# Names safe to expose to the LLM tool (acrobatics are operator-only).
SAFE_GESTURES: list[str] = [n for n, g in GESTURES.items() if not g.risky]


def resolve(name: str) -> Gesture | None:
    return GESTURES.get((name or "").strip().lower())
