"""Tiny shared math helpers used across motion/perception/safety code."""

from __future__ import annotations

import math

TWO_PI = 2.0 * math.pi


def clamp(value: float, lo: float, hi: float) -> float:
    """Clamp value into [lo, hi]."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def wrap_angle(a: float) -> float:
    """Wrap an angle (radians) into (-pi, pi]."""
    return ((a + math.pi) % TWO_PI) - math.pi
