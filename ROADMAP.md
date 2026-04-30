# Roadmap

What's shipped, what's planned, what isn't in scope. Items aren't versioned
because the project's milestone numbers stopped being meaningful around
M5 — too many small additions to keep numbering tidy. Categories are
more useful than version numbers anyway.

## Status legend

- ✅ **Shipped** — in main, tested, working.
- 🟡 **Partial** — the seam exists, full implementation is open.
- ⏳ **Planned** — explicitly intended; nothing built yet.
- 🚫 **Out of scope** — considered, declined; reasons given so future
  contributors don't re-litigate.

## Capability matrix

### Control & safety

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Safety FSM (IDLE / ARMED / ACTIVE / ESTOP) | ✅       | Single source of truth for "may I move?"                   |
| Proximity-aware velocity scaling          | ✅       | Linear slowdown 1.0 m → 0.3 m, hard floor at 0.3 m         |
| Latching E-STOP (joystick + spacebar)     | ✅       | Cleared explicitly via UI                                  |
| Heartbeat-driven safety drop              | ✅       | WS connection loss → auto E-STOP                           |
| Smart-assist event log                    | ✅       | Visible in chat, queryable via `report_status`             |
| Battery-low → E-STOP threshold            | ⏳       | Hardware-only concern; sim drains 0.001%/move-tick         |
| Tilt-tilted → E-STOP threshold            | ⏳       | Hardware-only concern                                      |

### Motion

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Velocity-command joystick (vx, vy, vyaw)  | ✅       | Drag UI + WS protocol                                       |
| `stand_up` / `stand_down`                 | ✅       | Both as LLM tools and operator buttons                     |
| `halt` (motion stop, stay armed)          | ✅       | LLM tool; always allowed                                   |
| `look_at_entity` (closed-loop yaw)        | ✅       | Targets named world objects                                |
| `set_body_height` (crouch/tall, 0.18-0.34 m) | ✅    | LLM tool; clamped, not rejected                            |
| `go_to_pose(x, y)` (straight-line nav)    | ✅       | Smooth deceleration, cancellable; no path-planning         |
| Real-hardware nav (Nav2 + costmap)        | ⏳       | `RealBridge.go_to_pose` deliberately refuses for safety    |
| Gait switching (walk/trot/bound)          | ⏳       | API IDs known; no use case yet                             |
| Trajectory following / waypoint sequences | ⏳       | Future composition over `go_to_pose`                       |

### Perception & vision

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| 360° proximity sensor (4 quadrants)       | ✅       | Mirrors Go2's `range_obstacle[4]` field shape              |
| Quadrant-transition events                | ✅       | Filtered to "interesting" (range entry/exit, into-front)   |
| Forward-camera FOV cone (70°)             | ✅       | Sim-only; ground-truth shortcut                            |
| Ray-traced occlusion                      | ✅       | Solid obstacles block sight; passable terrain doesn't      |
| Vision-entry/exit events                  | ✅       | Streamed to bus for ambient cognition                      |
| Real-camera detector / tracker            | 🟡       | `PerceptionBase` interface exists; no `RealPerception` yet |
| Lidar voxel-map decoding                  | ⏳       | Upstream decoder shape known (BSD-2 reference); not adopted |
| Semantic segmentation                     | ⏳       | Sim could fake; real-hardware would need an external model |
| Depth from camera                         | ⏳       | Real Go2 RealSense publishes depth; not consumed yet       |

### World & scene

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Named world objects with categories       | ✅       | 38 objects, 12 categories                                  |
| Reactive entities (cat flee, person yield) | ✅      | Both via `update(dt, observer)` hook                       |
| Studio-backlot scene (apartment + street + stairs + agility) | ✅ | Default `SWEETIE_SCENE=studio`           |
| Focused practice scenes                   | ✅       | `apartment` / `street` / `stairs` / `agility`              |
| Named regions with zone-change events     | ✅       | Bus topic `zone_changed`; surfaced in `report_status`      |
| Apple boxes (full / half / quarter / eighth) | ✅    | Standard film-industry stage props                         |
| Stairs (2/3/5/8-step + L-bend)            | ✅       | Spatially represented; not physically simulated            |
| Slopes / hills / moguls / gravel          | ✅       | Passable terrain; not physically simulated                 |
| Entity goals beyond reactive              | ⏳       | Cat to-rug, person-with-errands; mostly polish             |
| Multi-floor scenes                        | 🚫       | Out of scope: no Z axis. See "kinematic vs physics" below  |
| Procedurally generated obstacle fields    | ⏳       | Pattern from `isaac_go2_ros2/sim_env.py`                   |

### Cognition

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Reactive chat (Claude as operator co-pilot) | ✅      | 8 tools; all gated by `SafetyGuard`                        |
| Tool calls visible to operator            | ✅       | "do" / "do✗" lines in chat                                 |
| `report_status` snapshot (proximity, vision, region, perception, assists) | ✅ | Single read-only window |
| Ambient cognition (LLM speaks unprompted) | ✅       | Opt-in via `SWEETIE_AMBIENT=on`; cooldown-protected        |
| Scene-aware system prompt                 | ⏳       | Currently describes full backlot regardless of scene       |
| Sliding-window history (token budget)     | ⏳       | History grows unbounded today; fine for short sessions     |
| Multi-LLM (e.g. local model fallback)     | 🚫       | Out of scope: keeps the architecture simple                |

### Real hardware

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| `RealBridge` (DDS over `unitree_sdk2py`)  | 🟡       | Code exists, **not runtime-tested** against a Go2          |
| Sport mode commands (StandUp/Down/Move/Damp etc.) | 🟡 | Mock-tested integration shape; needs hardware verification |
| `BodyHeight` SDK call                     | 🟡       | Wired to `set_body_height`; absolute → relative offset     |
| WebRTC transport (alternative to DDS)     | 🚫       | Reference materials kept; transport choice is firmly DDS   |
| Audio hub (TTS through robot speaker)     | ⏳       | API IDs known (`AUDIO_HUB_COMMANDS`)                       |
| Camera frame ingestion                    | ⏳       | Required prerequisite for real perception                  |
| First-time hardware bring-up checklist    | ⏳       | Most important open item once a robot is available         |

### Operator UX

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Top-down map with category-aware styling  | ✅       | Stairs dashed, terrain striped, cones orange, etc.         |
| Live dynamic-entity tracking on map       | ✅       | Cat and person update each telemetry frame                 |
| Chat panel with tool-call visibility      | ✅       | "do" / "spk" / "assist" / "ambient" line variants           |
| Joystick + heartbeat                      | ✅       | Slows/centers on inactivity                                 |
| Spacebar E-STOP                           | ✅       | Always works                                                |
| Map zoom / pan controls                   | ⏳       | Currently fixed at viewBox `-10 -10 20 20`                 |
| Persistent operator settings              | ⏳       | No state survives restart                                   |
| Mobile-friendly UI                        | 🚫       | Tele-op needs a real screen and keyboard                   |

## What's deliberately not in scope

These came up during development and were declined for explicit reasons.
Re-litigate only with new information.

- **Multi-process / microservices.** The whole point is one process,
  one event loop, one chokepoint. Splitting cognition into its own
  service would buy isolation we don't need and complicate the safety
  story — actions could land out-of-order with respect to telemetry.
- **External state stores.** No Redis, no Postgres, no SQLite. State
  lives in the running process. If you want persistence, log the
  WebSocket traffic.
- **Behaviour trees / planners.** The LLM is the planner. Adding a
  separate BT layer would create two minds with different opinions
  about what to do next. The safety FSM is enough.
- **Custom RL controllers.** Real Go2 firmware ships with its own
  controllers and the SportClient wraps them. We don't need to ship
  policies; we just need to drive the SportClient correctly.
- **Multiple operators per session.** Authentication, conflict
  resolution, role permissions — all real work, no use case yet.
- **Recording/replay system.** Useful eventually, but not until first
  hardware bring-up exposes the things actually worth replaying.

## The big choice ahead: kinematic vs physics

Sweetie's simulator is **kinematic** — it integrates commanded velocity
into pose with no Z axis, no foot dynamics, no contact forces. That
keeps it cheap (50 Hz tick, ~5 ms per integration step), tests fast,
and the architecture clean.

The cost is honesty: stairs and terrain are *represented* on the map
and named for navigation/conversation, but the robot doesn't actually
traverse them. The LLM is told this explicitly in the system prompt.

The decision point is whether to add a physics layer (likely MuJoCo,
borrowed from `go2_omniverse` patterns). It would unlock:

- Actual stair traversal — the Go2's defining capability
- Slope handling, mogul recovery, gravel slip
- Tipping / falling / recovery behaviors that justify ESTOP-on-tilt
- Foot contact forces useful to a future RL controller

Costs:

- Significant new dependency
- Tests that take seconds, not milliseconds
- A rabbit hole: physics needs URDF, URDF needs joint configuration,
  joint config needs gait parameters, gait parameters need an RL
  policy, the RL policy needs training, ad infinitum
- Most of what we currently test (safety FSM, smart-assist, perception
  events, ambient cognition) doesn't benefit

The honest position: **kinematic is enough until hardware bring-up
proves otherwise.** If/when a real Go2 is available and the bring-up
checklist exposes specific issues that need physics in sim to debug,
that's the right time to add MuJoCo. Speculatively building it before
then would slow everything else for no clear gain.

## Hardware bring-up checklist (sketch)

When a Go2 is available, this is the rough order of operations. Don't
treat as authoritative; revise on contact with reality.

1. **Network and DDS.** Confirm interface name (`eth0` / `enp0s3` /
   `wlan0`) and domain ID. Verify `ros2 topic list` shows
   `/rt/sportmodestate` and `/rt/lowstate`. Resolve any firewall issues.

2. **`unitree_sdk2py` install.** `pip install -e .[real]` may not work
   if the upstream package isn't on PyPI in your region; fall back to
   the GitHub URL. Verify imports in a Python REPL before running
   sweetie.

3. **Static state subscription only.** First boot with everything
   commanded disabled: `SWEETIE_BRIDGE=real` but no STAND_UP, no MOVE.
   Confirm `RobotState` populates correctly on telemetry.

4. **Mode-code calibration.** Log every distinct `mode` value seen
   over a few minutes of normal robot operation. Update
   `RealBridge._mode_to_str` if the values disagree with our table.

5. **Safe-side commands.** `stand_up` and `stand_down` first. Watch
   for SDK error returns. Map them to clean reject reasons in our
   logs.

6. **`Damp()` test in safe space.** Critical: verify emergency_stop()
   actually does what we want (joints compliant, robot settles softly).

7. **`Move()` at low velocity.** 0.1 m/s forward only. Check that
   safety guard's slowdown still applies. Verify the proximity readings
   come from the robot's own sensors, not our cached zeros.

8. **`BodyHeight` calibration.** Confirm the absolute → relative offset
   conversion in `RealBridge.set_body_height` matches what the SDK
   expects. The default is 0.27 m offset from 0.0; if the SDK takes a
   different baseline, adjust.

9. **`go_to_pose` deferred.** Stays refused on `RealBridge` until a
   real perception layer (camera + vision) and a planner exist.
   Anything else is pretending.

10. **Update the README.** Once hardware-verified, change the badge
    from `sim only` to `hardware-tested`. Document what was different.

## Cross-references

- [`README.md`](README.md) — what sweetie is and how to run it
- [`docs/go2-references.md`](docs/go2-references.md) — cross-reference
  vs upstream Go2 projects
- [`third_party/README.md`](third_party/README.md) — provenance and
  licensing of reference materials
