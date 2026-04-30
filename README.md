# sweetie

A small tele-op platform for a Unitree Go2 quadruped, with a deterministic
safety FSM, an LLM for chat and high-level intent, and a kinematic
simulator that lets you exercise everything without hardware. **Sim-only
today** — the real-hardware bridge exists but is unverified against an
actual robot.

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Tests: 298](https://img.shields.io/badge/tests-298%20passing-brightgreen.svg)](#tests)
[![Status: sim-only](https://img.shields.io/badge/status-sim%20only-yellow.svg)](#hardware-integration-status)

---

## What it is

Sweetie is a **single-process** application that wires four pieces together:

- A **simulator** of a small studio-backlot world (apartment, street,
  stairs, agility area; 38 named objects across 12 categories) that
  publishes the same state-shape as a real Go2 — pose, velocity,
  4-quadrant proximity, body height.
- A **safety FSM** (`IDLE → ARMED → ACTIVE → ESTOP`) with proximity-aware
  velocity scaling. Every motion command — joystick or LLM — is gated
  through it. The same code runs against sim and hardware.
- A **web operator console** with a top-down map, a virtual joystick, a
  latching E-STOP, telemetry, and a chat panel.
- An **LLM cognition layer** (Claude) with eight tools for control and
  reporting, optional ambient commentary on bus events, and honest
  separation between proximity (360°) and vision (forward-camera FOV +
  occlusion).

The runtime is FastAPI + a single WebSocket per browser tab. No ROS,
no microservices, no external state stores — at any moment, the entire
robot's "mind" fits in one process.

## Quick start

```bash
git clone https://github.com/<YOU>/sweetie.git
cd sweetie
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Optional but strongly recommended:
cp .env.example .env
# edit .env and add ANTHROPIC_API_KEY

python -m sweetie
```

Then open <http://127.0.0.1:8000>. Click **arm**, then drag the joystick.
Press **space** for E-STOP at any time. Wheel-zoom and click-drag-pan
the map (useful at high obstacle densities); the **+/−/⊙** buttons
zoom in, out, and reset.

### Configuration

All knobs are environment variables. Everything has sensible defaults.

| Variable                    | Default       | What it does                                                                 |
| --------------------------- | ------------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | _(unset)_     | Required for the cognition layer; without it `/api/chat` returns canned replies |
| `SWEETIE_HOST` / `SWEETIE_PORT` | `127.0.0.1` / `8000` | Where the FastAPI server binds |
| `SWEETIE_MODEL`             | `claude-sonnet-4-5` | Anthropic model name |
| `SWEETIE_BRIDGE`            | `sim`         | `sim` (kinematic simulator) or `real` (Unitree Go2 over DDS) |
| `SWEETIE_SCENE`             | `studio`      | `studio`/`apartment`/`street`/`stairs`/`agility`/`obstacle-sparse`/`obstacle-medium`/`obstacle-dense` (sim only) |
| `SWEETIE_NETWORK_INTERFACE` | `eth0`        | DDS network interface (real bridge only) |
| `SWEETIE_DDS_DOMAIN`        | `0`           | DDS domain ID (real bridge only) |
| `SWEETIE_AMBIENT`           | `off`         | `on` enables LLM commenting unprompted on bus events |
| `SWEETIE_AMBIENT_COOLDOWN_S`| `20`          | Minimum seconds between ambient utterances |

### Scenes

Pick one with `SWEETIE_SCENE=…`. The default `studio` is the full
backlot; the others are focused practice areas:

| Scene             | Objects | Best for                                                |
| ----------------- | -------:| ------------------------------------------------------- |
| `studio`          | 38      | The full world, four named regions, both dynamic entities |
| `apartment`       |  7      | Reactive entities (cat scrambles, person yields), basic safety |
| `street`          | 16      | Static obstacle navigation: car, hydrant, lamp, cones, fence, curbs |
| `stairs`          |  7      | Spatial reasoning around 2/3/5/8-step runs and the L-bend |
| `agility`         |  8      | Apple boxes plus passable terrain (slope/hill/moguls/gravel) |
| `obstacle-sparse` | 50      | Light random obstacle field — easy navigation         |
| `obstacle-medium` | 100     | Moderate density — realistic outdoor stress test      |
| `obstacle-dense`  | 200     | Dense field — many rocks, tight gaps, smart-assist workout |

The named-scene-registry pattern is borrowed from
[`isaac_go2_ros2/sim_env.py`](third_party/isaac_go2_ros2/sim_env.py)
(BSD-2-Clause, RoboVerse community).

## Capabilities

### LLM tools

| Tool              | Effect                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `speak`           | Emit a short line through the robot's speaker (in sim, just chat)       |
| `stand_up`        | Bring the robot from folded to standing                                 |
| `sit_down`        | Fold the robot back down                                                |
| `halt`            | Stop motion immediately, stay armed                                     |
| `look_at`         | Rotate to face a named world object                                     |
| `set_body_height` | Crouch (0.18 m) or stand tall (0.34 m); default standing is 0.27 m      |
| `go_to_pose`      | Drive in a straight line toward (x, y), decelerating on approach        |
| `follow_path`     | Queue a sequence of waypoints; smooth handoff between them              |
| `report_status`   | Snapshot of safety, mode, pose, proximity, vision, region, recent events |

All action tools route through the `SafetyGuard`. `report_status` is
read-only and always allowed.

### Two senses, distinguished

The LLM can see the world two different ways and the prompt is explicit
that they can disagree:

- **Proximity (360°, no occlusion)** — `nearby_objects` and
  `proximity_m`. The 4-quadrant ultrasonic-style sensor model. Sees in
  every direction at once.
- **Vision (forward 70° cone, occluded by solid obstacles)** —
  `in_view`. The forward-camera model. A box behind the couch won't
  appear here even if it's nearby.

When the operator asks "what do you see?", the LLM uses `in_view`. When
they ask "what's around?", it uses `nearby_objects`.

### Reactive entities

The cat scrambles away when the robot gets within ~0.6 m. The person
pauses when the robot is in their walking path within ~1 m. Both
behaviors emerge from passing the robot's pose to entities each tick;
neither cat nor person has agency beyond that.

### Ambient cognition

Off by default. With `SWEETIE_AMBIENT=on`, the LLM subscribes to bus
events (smart-assist interventions, perception transitions, region
changes) and may comment unprompted. Strict cooldown (default 20 s)
prevents spam. Cooldown only consumes when the LLM actually speaks —
`(silent)` decisions don't burn the budget.

## Architecture

```
                ┌─────────────────────────────────┐
                │  Web operator console (browser) │
                │  joystick · map · chat · E-STOP │
                └──────────────┬──────────────────┘
                               │  WebSocket + REST
                ┌──────────────▼──────────────────┐
   ┌──────┐    │       FastAPI server (one process)
   │ LLM  │◄──►│  ┌──────────────────────────────┐ │
   │(Claude)│  │  │     Cognition (chat + tools) │ │
   └──────┘   │  └────────┬─────────────┬───────┘ │
              │           │             │         │
              │  ┌────────▼─┐    ┌──────▼─────┐  │
              │  │ Safety   │    │  Bus       │  │
              │  │  guard   │    │  pub/sub   │  │
              │  └────────┬─┘    └──────┬─────┘  │
              │           │             │         │
              │   ┌───────▼─────────────▼──────┐ │
              │   │     BridgeBase (interface) │ │
              │   ├────────────────────────────┤ │
              │   │ SimBridge        RealBridge│ │
              │   │ (kinematic)      (Go2 DDS) │ │
              │   └────┬───────────────────────┘ │
              │        │                         │
              │   ┌────▼──────┐    ┌──────────┐  │
              │   │   World   │    │ Perception│ │
              │   │  + scenes │    │  (FOV +   │ │
              │   │  + regions│    │ occlusion)│ │
              │   └───────────┘    └──────────┘  │
              └──────────────────────────────────┘
```

The single most important architectural decision: **every command goes
through `SafetyGuard`, regardless of source.** Joystick, LLM tool calls,
ambient utterances proposing actions — all routed through the same
chokepoint.

## Hardware integration status

The `RealBridge` has been written against the documented `unitree_sdk2py`
Python API and the published schemas in the upstream `unitree_ros2`
repository. **It has not been runtime-tested against an actual Go2.**

What's verified by tests:

- Integration shape: each SDK call structured against the documented
  surface, validated by 25 mock-based tests
- Wire protocol: DDS topic names (`rt/sportmodestate`, `rt/lowstate`)
  match upstream schemas
- Architectural seams: `RealBridge` implements `BridgeBase` cleanly;
  safety guard, cognition, and operator UI work identically against
  either bridge
- `RealPerception` generates proximity-quadrant transition events from
  the live `range_obstacle` field with hysteresis; same event shape
  the cognition layer sees from `SimPerception`
- Failure modes: commands before `connect()` return False, SDK errors
  return False, missing SDK gives a clear actionable error

What is NOT verified, and what's deliberately not yet implemented:

- Whether the upstream `unitree_sdk2py` API surface still matches what
  we wrote against
- The mode-code mapping (`uint8 mode` → our internal vocabulary)
- Network configuration (interface, domain ID)
- Timing/latency assumptions
- Real-hardware navigation: `go_to_pose` and `follow_path` are
  **deliberately refused** on `RealBridge` — there's no perception or
  planner on hardware yet, so driving blindly toward a coordinate
  would be unsafe
- Audio hub TTS: the `speak_through_robot` seam exists on `RealBridge`
  but the audio block encoding is unimplemented (needs an external
  TTS engine + chunked SEND_AUDIO_BLOCK sequencing). `speak` falls
  back to the chat panel cleanly.
- Camera frames + semantic detection: `RealPerception.vision_summary()`
  returns `[]` honestly; an on-board model or external service would
  fill that in.

First hardware bring-up should be treated as bring-up. The full
procedure is documented in
[`docs/hardware-bringup.md`](docs/hardware-bringup.md), with explicit
guidance to revise the doc from experience as you go. The cross-reference
at [`docs/go2-references.md`](docs/go2-references.md) maps our
integration against four other open-source Go2 projects (BSD-2-Clause)
for second opinions.

There's also a read-only diagnostic tool:

```bash
python -m sweetie.tools.preflight --interface eth0 --domain 0
```

It checks SDK import, DDS init, topic publishing on `rt/sportmodestate`
and `rt/lowstate`, and observes mode codes the robot is actually emitting
— without sending any commands. Run this before letting `RealBridge`
issue motion commands. Exit code 0 = all checks passed.

## Tests

```bash
pytest
```

298 tests, all passing as of this README. Coverage includes:

- Safety FSM transitions, predicate ticks, proximity-aware scaling,
  battery-low and tilt auto-trip
- Bridge: connect/disconnect, command dispatch, integration, look_at,
  reactive entities, perception, region tracking, body height,
  navigation, waypoint queues
- World: lookups, geometry, categories, velocity, motion classification,
  reactive flee/yield, scene registry, regions, procedural obstacle fields
- SimPerception: quadrant transitions, FOV cone, occlusion, vision events
- RealPerception: hysteresis, near/far thresholds, per-quadrant
  independence, drain semantics, empty vision summary
- Cognition: tool dispatch, safety integration, look_at outcomes,
  report_status structure, scene-aware system prompt, sliding-window
  history trimming, speak-through-bridge wiring
- Real bridge: 25 mock-based tests against the documented SDK surface
- Preflight diagnostic: SDK init, DDS connect, topic publishing, schema
  validation, mode-code observation
- Ambient: cooldown, lock, silent-response handling, bus subscription

## Layout

```
sweetie/
├── core/
│   ├── bridge.py            # SimBridge + BridgeBase. The simulator.
│   ├── real_bridge.py       # RealBridge — wraps unitree_sdk2py. UNVERIFIED.
│   ├── perception.py        # PerceptionBase — hardware-neutral interface.
│   ├── real_perception.py   # RealPerception — proximity events from LowState.
│   ├── safety.py            # FSM + command guard. Single source of truth.
│   └── bus.py               # Tiny async pub/sub.
├── cognition/
│   ├── llm.py               # Anthropic client, tools, chat loop, ambient_react.
│   └── ambient.py           # Bus-event-driven unprompted commentary (opt-in).
├── sim/
│   ├── world.py             # Named objects + regions + scene registry (8 scenes).
│   └── perception.py        # SimPerception: quadrants + vision FOV + occlusion.
├── teleop/
│   ├── server.py            # FastAPI: /ws + /api/chat + /api/world + static UI.
│   └── static/              # The operator console (HTML + CSS + vanilla JS).
└── tools/
    └── preflight.py         # Read-only hardware bring-up diagnostic.

docs/
├── go2-references.md        # Cross-reference vs upstream Go2 projects.
└── hardware-bringup.md      # Step-by-step first-Go2 procedure (speculative).

third_party/
├── go2_ros2_sdk/        # BSD-2 reference: WebRTC SDK, sport mode IDs.
├── go2_omniverse/       # BSD-2 reference: Isaac Sim terrain configs.
├── isaac_go2_ros2/      # BSD-2 reference: ROS2 sim integration.
└── unitree_go2_nav/     # BSD-2 reference: Nav2 integration.
```

## Reference materials

[`docs/go2-references.md`](docs/go2-references.md) cross-references
sweetie's `RealBridge` against four BSD-2-Clause community projects
(sport mode API IDs, DDS topic names, mode-code mapping, ROS2
conventions). The upstream files are preserved verbatim under
`third_party/`, with their original copyright headers and LICENSE files
intact. Start there if you're bringing this up on real hardware.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for what's planned and what's deliberately
out of scope.

## License

MIT. See `LICENSE`. Third-party reference materials under `third_party/`
retain their original BSD-2-Clause licenses; see
[`third_party/README.md`](third_party/README.md) for per-project terms.
