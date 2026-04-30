# Go2 reference materials

Notes for anyone bringing `sweetie` up against real hardware. Cross-references
between the `unitree_sdk2py` API surface I targeted in `RealBridge`, the
upstream Unitree ROS2 SDK schemas, and the community Go2 projects in
`third_party/`.

These are not authoritative — they are reading notes. The authoritative
source for a real Go2 is whatever firmware version the robot is actually
running, which may have moved on.

## Two transports, slightly different topic names

The Unitree ecosystem has two ways of talking to a Go2 from a host PC:

| Transport     | Used by                                              | Topic prefix              |
| ------------- | ---------------------------------------------------- | ------------------------- |
| Native DDS    | [`unitree_sdk2py`][sdk2py], `unitree_ros2`           | `rt/sportmodestate`, `rt/lowstate`     |
| WebRTC        | [`go2_webrtc_connect`][webrtc], `go2_ros2_sdk`       | `rt/lf/sportmodestate`, `rt/lf/lowstate` |

Our `RealBridge` uses **native DDS** via `unitree_sdk2py`, so the topics
in `sweetie/core/real_bridge.py` are:

- `rt/sportmodestate` — pose, IMU, velocity, range, mode
- `rt/lowstate` — battery (`bms_state.soc`)

If you're cross-referencing the WebRTC variants in
`third_party/go2_ros2_sdk/webrtc_topics.py`, note the `rt/lf/` prefix.
The two are not interchangeable — the same robot publishes on both, but
under different names depending on which transport you've subscribed to.

[sdk2py]: https://github.com/unitreerobotics/unitree_sdk2_python
[webrtc]: https://github.com/legion1581/go2_webrtc_connect

## Sport mode API IDs

`real_bridge.py` calls a small subset of the available API IDs through
`unitree_sdk2py.go2.sport.sport_client.SportClient`. The full list lives
in `third_party/go2_ros2_sdk/robot_commands.py` (BSD-2-Clause / RoboVerse
community 2024). The ones we use, with the upstream IDs for verification:

| Method (Python SDK) | API ID | Notes                                            |
| ------------------- | ------ | ------------------------------------------------ |
| `Damp`              | 1001   | Our `emergency_stop()`. Joints go compliant; robot settles. |
| `BalanceStand`      | 1002   | Implicit — what the robot does when `mode=1`.    |
| `StopMove`          | 1003   | Our `stop_move()`.                               |
| `StandUp`           | 1004   | Our `stand_up()`.                                |
| `StandDown`         | 1005   | Our `stand_down()`.                              |
| `RecoveryStand`     | 1006   | Available, not currently used (we don't auto-recover from estop). |
| `Move`              | 1008   | Our `move(vx, vy, vyaw)`.                        |

API IDs we deliberately don't use: `Dance1`/`Dance2` (1022/1023),
`FrontFlip` (1030), `Wallow` (1021), `Hello` (1016), `WiggleHips`
(1033). These are demo behaviours; if you want them, the
`unitree_sdk2py` `SportClient` exposes them and the integration is
mechanical (one-shot SDK call wrapped in `_sdk_call`).

## Sport mode integer codes

The `mode` field on `SportModeState` is a `uint8` with codes that aren't
fully documented anywhere I've found. Our `real_bridge._mode_to_str`
maps a small subset:

| Code | Our string | Confidence    | Notes                              |
| ---- | ---------- | ------------- | ---------------------------------- |
| 0    | `standing` | low           | Idle. May actually be "balance off". |
| 1    | `standing` | low           | Balance stand. Distinguished from "moving" by velocity heuristic. |
| 5    | `estop`    | medium        | After `Damp()`. Verified by what we send, not what the robot reports back. |
| 7    | `down`     | low           | Stand-down complete. |

Other codes fall through to "standing" (if velocity ~ 0) or "moving".
This is a known soft spot; first hardware bring-up should log every
distinct mode value and update the table.

## Stair dimensions, for terrain reference

From `third_party/go2_omniverse/terrain_cfg.py`:

```python
"pyramid_stairs": terrain_gen.MeshPyramidStairsTerrainCfg(
    step_height_range=(0.05, 0.23),
    step_width=0.3,
    platform_width=3.0,
    ...
)
```

Step heights of 5–23 cm, step width 30 cm. For context: residential code
in most of the US is ~17–19 cm step height with ~28 cm tread; commercial
is ~14–18 cm. The Unitree training range covers more than residential,
which is why the Go2 can handle most household stairs.

Our simulator scene includes 2/3/5/8-step runs and an L-bend (see
`sweetie/sim/world.py`). The labels reference step counts, not heights —
remember our kinematic sim has no Z axis, so step dimensions are
narrative only. If/when M6 (physics) ships, these numbers are the right
range to feed it.

## Robot state field surface

`third_party/go2_ros2_sdk/robot_data.py` documents the fields the
community SDK extracts from the robot. Our `RobotState` is narrower —
we only carry what the safety guard, telemetry, or LLM actually use:

| Upstream field      | Our `RobotState`     | Why we have/don't                |
| ------------------- | -------------------- | -------------------------------- |
| `position[3]`       | `x`, `y`             | Yes, drop z (kinematic 2D sim).  |
| `imu_state.rpy[3]`  | `roll`, `pitch`, `yaw` | Yes.                            |
| `velocity[3]`       | `vx`, `vy`           | Yes, drop vz.                    |
| `yaw_speed`         | `vyaw`               | Yes.                             |
| `body_height`       | `body_height`        | Yes (for telemetry).             |
| `range_obstacle[4]` | `range_obstacle`     | Yes (front/left/back/right).     |
| `foot_force[4]`     | —                    | No — no use case yet.            |
| `foot_position_body[12]` | —              | No — no use case yet.            |
| `foot_speed_body[12]`    | —              | No — no use case yet.            |
| `gait_type`         | —                    | No — we don't switch gaits.      |
| `progress`          | —                    | No — relates to action progress, not currently consumed. |

If a future milestone needs gait switching or foot-force feedback, the
fields are right there — we'd just expand `RobotState` and the
`_on_sport_state` callback in `real_bridge.py`.

## What's deliberately NOT in this project

Some capabilities the upstream SDKs offer that we have no plans to add:

- **WebRTC transport.** Our integration is DDS-only. Adding WebRTC
  would mean a second bridge implementation and a second set of topic
  constants. The community projects show how, but it doubles the
  surface area for no clear win in our use case.
- **Lidar voxel maps.** The Go2 publishes a compressed voxel map on
  `rt/utlidar/voxel_map_compressed`. Decoding is non-trivial (see
  `third_party/go2_ros2_sdk/...sensors/lidar_decoder.py` upstream).
  When `RealPerception` ships, this is a candidate input.
- **Audio hub.** `AUDIO_HUB_COMMANDS` exists upstream for sending TTS
  to the robot's speaker. Our `speak` tool currently emits text to the
  operator's chat; routing it to the robot's speaker is a small future
  feature and would use `rt/api/audiohub/request`.
- **WebRTC encryption.** The upstream `infrastructure/webrtc/crypto/`
  module deals with the WebRTC handshake. Not relevant for DDS.

## License attribution

All files under `third_party/` retain their original copyright headers
and the upstream LICENSE file at the project root. They are governed by
their respective licenses (BSD 2-Clause for all four projects we drew
from), not by the `sweetie` license. See `third_party/README.md` for
the per-project breakdown, including a provenance note about
`unitree_go2_nav` whose LICENSE was applied later than the source files.

## ROS2 topic conventions for a Unitree Go2 sim (from `isaac_go2_ros2`)

Our `RealBridge` is DDS-direct (via `unitree_sdk2py`), but the
`isaac_go2_ros2` project shows the topic naming convention an Isaac Sim
+ ROS2 bridge typically uses for the Go2. Useful if `sweetie` ever grows
a ROS2 path for a simulator-in-the-loop setup:

| ROS2 topic                                              | Direction | Purpose                          |
| ------------------------------------------------------- | --------- | -------------------------------- |
| `/unitree_go2/cmd_vel`                                  | sub       | Velocity commands (`Twist`)      |
| `/unitree_go2/odom`                                     | pub       | Odometry (`nav_msgs/Odometry`)   |
| `/unitree_go2/pose`                                     | pub       | World-frame pose (`PoseStamped`) |
| `/unitree_go2/lidar/point_cloud`                        | pub       | Lidar point cloud                |
| `/unitree_go2/front_cam/color_image`                    | pub       | Front camera RGB                 |
| `/unitree_go2/front_cam/depth_image`                    | pub       | Front camera depth               |
| `/unitree_go2/front_cam/semantic_segmentation_image`    | pub       | Per-pixel semantics              |
| `/unitree_go2/front_cam/info`                           | pub       | Camera intrinsics                |

The `cmd_vel` shape (`Twist`) maps cleanly onto our `move(vx, vy, vyaw)`
— a future ROS2 bridge for `sweetie` would just need to convert.

## Named simulation environments — a pattern worth borrowing

`isaac_go2_ros2/sim_env.py` is a simple registry of named environment
constructors:

```
obstacle-sparse / obstacle-medium / obstacle-dense   # generated terrain
warehouse / warehouse-forklifts / warehouse-shelves  # USD assets
full-warehouse / hospital / office                   # USD assets
```

Selected via `cfg/sim.yaml` (`env_name: obstacle-dense`). This is a
cleaner version of what we informally do with the single
`default_scene()` in `sweetie/sim/world.py` — a `SWEETIE_SCENE` env var
picking from a registry of scene constructors would let us keep the
"studio backlot" world as default while adding focused practice scenes
(stairs-only, agility-only, street-only) without bloating the default.
Roadmap candidate.

## Frame conventions for navigation (from `unitree_go2_nav`)

For when/if a real navigation stack lands on top of `sweetie`,
`unitree_go2_nav/nav2_params.yaml` shows the frame names a Nav2 setup
expects on a Go2:

| Frame              | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `map`              | Global frame, fixed by SLAM                        |
| `odom`             | Continuous odometry frame                          |
| `base_link`        | Robot body frame                                   |
| `base_footprint`   | Body frame projected to ground (used by AMCL)      |

Our `RealBridge` reports pose in whatever frame the Go2's odometry uses
(probably `odom`). A future Nav2 integration would need a TF tree
publishing `map → odom → base_footprint → base_link` plus the rest.
