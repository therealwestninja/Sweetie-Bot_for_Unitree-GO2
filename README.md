# Third-party reference materials

This directory contains files from other open-source Go2 projects, included
here verbatim for **reference**. They are not currently imported by the
`sweetie` package — they exist so that someone bringing up real hardware
can cross-check our `RealBridge` against authoritative sources without
having to re-clone the upstream repos.

Each subdirectory preserves the original project's LICENSE file at its
root. Individual files retain their original copyright and SPDX headers
where present. **Nothing here has been modified.**

## Provenance

### `go2_ros2_sdk/`

- **Source:** [github.com/abizovnuralem/go2_ros2_sdk](https://github.com/abizovnuralem/go2_ros2_sdk)
- **Snapshot:** master branch, 2025-01-13
- **License:** BSD 2-Clause
- **Copyright:** RoboVerse community, 2024

Note on a discrepancy: the project-level `LICENSE` is BSD 2-Clause, but
the SPDX-License-Identifier header on individual `.py` files reads
`BSD-3-Clause`. This appears to be an inconsistency in the upstream
source. We've preserved both notices unchanged. When in doubt, treat
these files as governed by the more restrictive of the two (BSD-3-Clause,
which adds a non-endorsement clause).

Files copied: `LICENSE`, `robot_commands.py`, `webrtc_topics.py`,
`command_generator.py`, `robot_data.py`.

### `go2_omniverse/`

- **Source:** [github.com/abizovnuralem/go2_omniverse](https://github.com/abizovnuralem/go2_omniverse)
- **Snapshot:** master branch, 2025-02-24
- **License:** BSD 2-Clause
- **Copyright:** RoboVerse community, 2024

Files copied: `LICENSE`, `terrain_cfg.py`, `terrain_generator_cfg.py`.

### `isaac_go2_ros2/`

- **Source:** [github.com/Zhefan-Xu/isaac-go2-ros2](https://github.com/Zhefan-Xu/isaac-go2-ros2)
  (`isaacsim-4.5` branch, per the upstream README)
- **Snapshot:** 2025-09-23
- **License:** BSD 2-Clause (LICENSE dated 2025-02-24, predates this
  archive's licensing update)
- **Copyright:** RoboVerse community, 2024
- **Public-facing maintainer:** Zhefan Xu

The `LICENSE` file dates from before this archive update. The README
acknowledges the RL controller is based on `go2_omniverse` (also
RoboVerse community), making the shared copyright plausible.

Files copied: `LICENSE`, `README.md`, `sim.yaml`, `sim_env.py`,
`terrain_cfg.py`, `go2_ros2_bridge.py`.

### `unitree_go2_nav/`

- **Source:** [github.com/Sayantani-Bhattacharya/unitree_go2_nav](https://github.com/Sayantani-Bhattacharya/unitree_go2_nav)
  (per the upstream README)
- **Snapshot:** main branch, 2025-03-18 (source files); LICENSE added 2025-04-30
- **License:** BSD 2-Clause (per the LICENSE.txt file)
- **Copyright on the LICENSE file:** RoboVerse community, 2024
- **Author stated in README:** Sayantani Bhattacharya

**Provenance note:** the `LICENSE.txt` file in this project's archive
was added on 2025-04-30 (concurrent with the second archive of these
projects shared with this codebase) and matches the RoboVerse community
boilerplate used by the other three projects. The upstream README, by
contrast, names Sayantani Bhattacharya as the sole author and links to
her personal GitHub repository, with no acknowledgment of RoboVerse
community heritage. We've preserved the `LICENSE` as supplied;
downstream users should make their own determination about whether the
licensing authority is what it appears to be.

Files copied: `LICENSE`, `README.md`, `nav2_params.yaml`,
`navigation.launch.py`, `mapping.launch.py`.

## How this relates to `sweetie`

See `docs/go2-references.md` in the repository root for cross-references:
which constants we actually use, where the upstream values disagree
with what we wrote in `sweetie/core/real_bridge.py`, and which transport
(native CycloneDDS vs WebRTC) each set of topic names applies to.
