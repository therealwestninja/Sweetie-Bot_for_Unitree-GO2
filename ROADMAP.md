# Roadmap

What's shipped, what's planned, what isn't in scope. Items aren't
versioned because the project's milestone numbers stopped being
meaningful around M5.

## Status legend

- ✅ **Shipped** — in main, tested, working.
- 🟡 **Partial** — the seam exists, full implementation is open.
- ⏳ **Planned** — explicitly intended; nothing built yet.
- 🚫 **Out of scope** — considered, declined; reasons given so future
  contributors don't re-litigate.

## The product, plainly

Sweetie is an **autonomous companion** running on a Go2: she initiates,
acts, comments, and converses without prompting. A human supervises and
can override but is not in the driving loop. Sessions are 15-30 minutes
(battery-bound). The earlier "tele-op platform" framing was wrong; the
codebase has been re-shaped to match the actual product.

What this means for the roadmap:

- "Autonomy" is the primary capability area, not a feature.
- "Supervisor override" is the human's role; the joystick and arm
  buttons exist to support that, not as the main user surface.
- Hardware bring-up matters because that's where sweetie *lives*. Sim
  is for development and testing.

## Capability matrix

### Autonomy

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Idle + event-driven autonomy loop         | ✅       | `Autonomy` orchestrator runs default-on; idle every 15s, event triggers cut in |
| Full tool access in autonomy ticks        | ✅       | `autonomy_tick(trigger)` with the same toolset as `chat()` |
| Current goal state (`set_goal` tool)      | ✅       | Carries intention forward across ticks; visible on dashboard |
| Conversation continuity within a session  | ✅       | Sliding-window history, supervisor messages and autonomy ticks share the same transcript |
| Cooldown protection                       | ✅       | Prevents tick thrashing (8s default, tunable)              |
| Multi-step planning beyond one tool chain | ⏳       | LLM picks tool sequences within a tick; cross-tick plans are emergent only |
| Cross-session memory (facts + episodes)   | ✅       | SQLite at `~/.sweetie/memory.db`; supervisor curates via dashboard |
| Memory proposal-approval workflow         | ✅       | `remember` tool proposes; supervisor approves/rejects/edits — sweetie never writes unilaterally |
| Episode reflection at session end         | ✅       | One-paragraph summary on battery_low / recalled / shutdown |
| Memory edit history / audit trail         | ⏳       | Rejected facts stay for audit, but no per-fact change history |
| Memory search / category filters in UI    | ⏳       | Dashboard shows all by category; no search yet              |
| Learning from supervisor feedback         | ⏳       | Future work; would require feedback affordances we don't have yet |

### Control & safety

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Safety FSM (IDLE / ARMED / ACTIVE / ESTOP) | ✅       | Single source of truth for "may I move?"                   |
| Proximity-aware velocity scaling          | ✅       | Linear slowdown 1.0 m → 0.3 m, hard floor at 0.3 m         |
| Latching E-STOP (joystick + spacebar)     | ✅       | Cleared explicitly via UI                                  |
| Heartbeat-driven safety drop              | ✅       | WS connection loss → auto E-STOP                           |
| Smart-assist event log                    | ✅       | Visible in chat, queryable via `report_status`             |
| Battery-low → E-STOP threshold            | ✅       | Auto-trip at <15%; `predicate_tick` checks each frame      |
| Tilt → E-STOP threshold                   | ✅       | Auto-trip at \|roll\| or \|pitch\| > 0.6 rad (~34°)         |

### Motion

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Velocity-command joystick (vx, vy, vyaw)  | ✅       | Drag UI + WS protocol — supervisor override channel        |
| `stand_up` / `stand_down`                 | ✅       | Both autonomy tools and override buttons                   |
| `halt` (motion stop, stay armed)          | ✅       | Always allowed                                             |
| `look_at_entity` (closed-loop yaw)        | ✅       | Targets named world objects                                |
| `set_body_height` (crouch/tall, 0.18-0.34 m) | ✅    | LLM tool; clamped, not rejected                            |
| `go_to_pose(x, y)` (straight-line nav)    | ✅       | Smooth deceleration, cancellable; no path-planning         |
| `follow_path([(x,y), ...])` (waypoints)   | ✅       | Queued nav with smooth handoff                              |
| Real-hardware nav (Nav2 + costmap)        | ⏳       | `go_to_pose`/`follow_path` deliberately refuse on `RealBridge` until perception + planner exist |
| Gait switching (walk/trot/bound)          | ⏳       | API IDs known; mostly aesthetic without physics             |
| Tour-style multi-region exploration       | ⏳       | Composition over `follow_path`; autonomy could already do this with prompting, structural support deferred |

### Perception & vision

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| 360° proximity sensor (4 quadrants)       | ✅       | Mirrors Go2's `range_obstacle[4]` field shape              |
| Quadrant-transition events                | ✅       | Filtered to "interesting" (range entry/exit, into-front)   |
| Forward-camera FOV cone (70°)             | ✅       | Sim-only; ground-truth shortcut                            |
| Ray-traced occlusion                      | ✅       | Solid obstacles block sight; passable terrain doesn't      |
| Vision-entry/exit events                  | ✅       | Streamed to bus for autonomy reactions                     |
| Real-camera detector / tracker            | 🟡       | `RealPerception` ships proximity-only events; semantic detector still needed |
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
| Procedurally generated obstacle fields    | ✅       | Sparse / medium / dense — for autonomy stress-testing      |
| Named regions with zone-change events     | ✅       | Bus topic `zone_changed`; surfaced in dashboard            |
| Apple boxes (full / half / quarter / eighth) | ✅    | Standard film-industry stage props                         |
| Stairs (2/3/5/8-step + L-bend)            | ✅       | Spatially represented; not physically simulated            |
| Slopes / hills / moguls / gravel          | ✅       | Passable terrain; not physically simulated                 |
| Entity goals beyond reactive              | ⏳       | Cat to-rug, person-with-errands; mostly polish             |
| Multi-floor scenes                        | 🚫       | Out of scope: no Z axis. See "kinematic vs physics" below  |

### Cognition

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| LLM (Claude) as the primary mind          | ✅       | All decisions route through `autonomy_tick` or `chat()`    |
| 9 tools: motion, posture, navigation, perception, goals, speech | ✅ | All gated by `SafetyGuard` where motion-affecting           |
| Autonomy-initiated speech distinct from prompted | ✅ | `chat-autonomy` line variant in dashboard                  |
| Scene-aware system prompt                 | ✅       | Built from world contents; doesn't fabricate              |
| Sliding-window history (token budget)     | ✅       | Trim threshold 50 → target 30 messages; respects tool_use/tool_result pairing |
| Onboard / offboard split                  | ⏳       | Currently one Claude call per tick; future split may put a fast onboard policy in front of Claude for routine decisions |
| Multi-LLM (e.g. local model fallback)     | 🚫       | Out of scope: keeps the architecture simple                |

### Real hardware

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| `RealBridge` (DDS over `unitree_sdk2py`)  | 🟡       | Code exists, **not runtime-tested** against a Go2          |
| Sport mode commands (StandUp/Down/Move/Damp etc.) | 🟡 | Mock-tested integration shape; needs hardware verification |
| `BodyHeight` SDK call                     | 🟡       | Wired to `set_body_height`; absolute → relative offset     |
| Pre-flight bring-up diagnostic            | ✅       | `python -m sweetie.tools.preflight` — read-only            |
| WebRTC transport (alternative to DDS)     | 🚫       | Reference materials kept; transport choice is firmly DDS   |
| Audio hub (TTS through robot speaker)     | 🟡       | Bridge seam wired (`speak_through_robot`); audio block encoding unimplemented |
| Camera frame ingestion                    | ⏳       | Required prerequisite for real semantic vision              |
| First-time hardware bring-up doc          | ✅       | See [`docs/hardware-bringup.md`](docs/hardware-bringup.md) — speculative until run |

### Supervisor dashboard

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Top-down map (primary surface)            | ✅       | Category-aware styling; live dynamic-entity tracking       |
| Goal strip (current sweetie intention)    | ✅       | Updated from `set_goal` tool calls                         |
| Region badge (current region)             | ✅       | In header status strip                                     |
| Supervisor chat channel                   | ✅       | Distinct chat-line variants for autonomy-initiated vs. supervisor-prompted |
| Override panel (joystick + posture + arm + E-STOP) | ✅ | Collapsed by default; spacebar E-STOP works regardless     |
| Map zoom / pan controls                   | ✅       | Wheel zoom (cursor-anchored), drag pan, +/-/0 keys         |
| Memory panel (pending tray + approved + episodes) | ✅ | Collapsible; auto-expands on first proposal of a session   |
| Session bar with recall button            | ✅       | "Recall sweetie" ends session immediately + writes summary |
| Persistent supervisor settings (UI prefs) | ⏳       | UI panel-open state, etc. don't survive reload yet         |
| Begin-new-session-without-restart button  | ⏳       | After session ends, server restart required for now        |
| Mobile-friendly UI                        | 🚫       | Supervisor needs a real screen and keyboard                |

### Sim-to-real transition

This is its own category because it's the path from "speculative" to
"shipped" for the real-hardware capabilities.

| Item                                      | Status    | Notes                                                      |
| ----------------------------------------- | --------- | ---------------------------------------------------------- |
| Sim and real bridges share `BridgeBase`   | ✅       | Same toolset, same safety, same dashboard                  |
| Hardware bring-up checklist               | ✅       | `docs/hardware-bringup.md` — needs a real Go2 to validate  |
| First-pass bring-up against a real Go2    | ⏳       | The single highest-leverage open item                      |
| Mode-code calibration on real hardware    | ⏳       | Documented as preflight step; will produce concrete values to update `RealBridge._mode_to_str` |
| Audio block format discovery              | ⏳       | Sample rate / encoding / chunk size for `SEND_AUDIO_BLOCK` — undocumented in BSD-2 references |
| Camera frame subscription                 | ⏳       | Subscribe to RealSense topics; required for real semantic vision |
| Real-hardware Nav2 integration            | ⏳       | Multi-week project; out of scope for sweetie itself, sweetie hands off |

## What's deliberately not in scope

These came up during development and were declined for explicit reasons.
Re-litigate only with new information.

- **Multi-process / microservices.** The whole point is one process,
  one event loop, one chokepoint. Splitting cognition into its own
  service would buy isolation we don't need and complicate the safety
  story.
- **External state stores beyond local SQLite.** No Redis, no Postgres.
  Persistent memory lives in `~/.sweetie/memory.db` — embedded SQLite,
  zero network surface. Adding a real database server is unjustified
  at the volume of data a single supervisor accumulates.
- **Behaviour trees / planners as a separate layer.** The LLM is the
  planner. Adding a separate BT layer would create two minds with
  different opinions about what to do next. The safety FSM is enough.
- **Custom RL controllers.** Real Go2 firmware ships with its own
  controllers and the SportClient wraps them. We don't need to ship
  policies; we just need to drive the SportClient correctly.
- **Multi-supervisor / multi-user memory.** One profile per install,
  for now. Authentication, conflict resolution, role permissions — all
  real work, no use case yet.
- **Vector embeddings / RAG over memory.** SQL `LIKE` and category
  filters are plenty at the volumes a single supervisor produces over
  a year of sessions. Adding embeddings would buy worse retrieval and
  a real dependency. Easy to revisit later — the schema doesn't lock us in.
- **Recording/replay system.** Useful eventually, but not until first
  hardware bring-up exposes the things actually worth replaying.

## The big choice ahead: kinematic vs physics

Sweetie's simulator is **kinematic** — it integrates commanded velocity
into pose with no Z axis, no foot dynamics, no contact forces. That
keeps it cheap, tests fast, the architecture clean.

The cost is honesty: stairs and terrain are *represented* on the map
and named for navigation/conversation, but the robot doesn't actually
traverse them. Sweetie is told this in her system prompt.

The decision point is whether to add a physics layer (likely MuJoCo).
It would unlock actual stair traversal, slope handling, tipping
recovery, etc. Costs: significant new dependency, slower tests, and a
rabbit hole of URDF / gait / RL training.

The honest position: **kinematic is enough until hardware bring-up
proves otherwise.** Most of what we currently test (safety FSM,
smart-assist, perception events, autonomy) doesn't benefit from
physics in sim.

## Hardware bring-up

Step-by-step procedure for the first time someone has a Go2 to plug
in: [`docs/hardware-bringup.md`](docs/hardware-bringup.md). It's
**speculative until somebody runs it** — every step makes assumptions
that only hardware can confirm. The doc opens with explicit guidance
on revising it from experience.

The high-level flow:

- **Phase 0** — preparation (kill switch, floor space, full battery)
- **Phase 1** — preflight (`python -m sweetie.tools.preflight`)
- **Phase 2** — telemetry-only sweetie boot (verify everything you can
  read before sending anything)
- **Phase 3** — Damp / E-STOP first (before any motion command)
- **Phase 4-5** — stand-up/down, body height (low-risk SDK calls)
- **Phase 6-7** — low-velocity move + smart-assist on real proximity
- **Phase 8** — tilt and battery auto-trip
- **Phase 9** — what to expect from compositional tools (`look_at`,
  `go_to_pose`, `follow_path` — all deliberately reduced on hardware)
- **Phase 10** — what's still unimplemented (audio hub, camera, Nav2)
- **Phase 11** — update sweetie based on what surprised you

## Cross-references

- [`README.md`](README.md) — what sweetie is and how to run it
- [`docs/go2-references.md`](docs/go2-references.md) — cross-reference
  vs upstream Go2 projects
- [`third_party/README.md`](third_party/README.md) — provenance and
  licensing of reference materials
