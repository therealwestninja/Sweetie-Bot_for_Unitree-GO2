"""
Perception interface — hardware-neutral.

`PerceptionBase` defines the surface every perception layer exposes: sim,
real-hardware, future replays, recordings, etc. All implementations share it so
the rest of the codebase doesn't care which is running.

Both `SimPerception` (in `sweetie.sim.perception`) and `RealPerception` (in
`sweetie.core.real_perception`) inherit from this. The base lives in `core/`
rather than `sim/` so real-hardware code never has to import sim modules —
which would transitively pull in `World` and the whole simulator.
"""

from __future__ import annotations


class PerceptionBase:
    """The interface a perception layer exposes."""

    def tick(
        self,
        robot_x: float,
        robot_y: float,
        robot_yaw: float,
        range_obstacle: tuple[float, float, float, float] | None = None,
    ) -> None:
        """Advance one frame of perception given the current robot pose.

        `range_obstacle` is the latest 4-quadrant proximity reading
        (front, left, back, right) in meters. Real implementations use it;
        sim implementations read the World directly and ignore it.
        """
        raise NotImplementedError

    def recent_events(self, window_s: float = 30.0) -> list[dict]:
        """Return events in the last `window_s` seconds, newest last."""
        raise NotImplementedError

    def vision_summary(
        self, robot_x: float, robot_y: float, robot_yaw: float,
    ) -> list[dict]:
        """Return entities currently visible (in-FOV, not occluded)."""
        raise NotImplementedError

    def drain_new_events(self) -> list[str]:
        """Return events generated since the last drain; clears the buffer.

        Used by the bridge's tick loop to forward fresh events to the bus.
        Default is no-op for implementations that don't track new-event streams.
        """
        return []
