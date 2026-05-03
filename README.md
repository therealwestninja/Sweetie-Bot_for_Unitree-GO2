# sweetie

An autonomous companion running on a Unitree Go2 quadruped — Claude-driven
cognition, kinematic simulator for now, hardware path designed-in.
A human supervises and may override; otherwise sweetie acts on her own:
moves around, looks at things, comments on what she's seeing, holds
short conversations. **Sim-only today** — the real-hardware bridge
exists but is unverified against an actual robot.

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Tests: 338](https://img.shields.io/badge/tests-338%20passing-brightgreen.svg)](#tests)
[![Status: sim-only](https://img.shields.io/badge/status-sim%20only-yellow.svg)](#hardware-integration-status)

---

## What it is

Sweetie is a **single-process** application that wires four pieces together:

- An **autonomy loop** (Claude) that runs continuously during a session.
  Bus events trigger immediate ticks; an idle ticker fires periodically
  so sweetie keeps initiative even when nothing happens. The LLM has
  full tool access — it can move, look, set goals, speak — and decides
  what to do without prompting.
- A **safety FSM** (`IDLE → ARMED → ACTIVE → ESTOP`) with proximity-aware
  velocity scaling. Every motion command — supervisor override or
  sweetie's own tool call — is gated through it. Same code runs in sim
  and hardware.
- A **simulator** of a small studio-backlot world (apartment, street,
  stairs, agility area; 38 named objects across 12 categories) that
  publishes the same state-shape as a real Go2 — pose, velocity,
  4-quadrant proximity, body height.
- A **supervisor dashboard** with a top-down map (primary), a goal strip
  showing what sweetie is currently trying to do, a chat panel for
  talking to her, and a collapsible override panel containing the
  joystick, posture controls, arm/disarm, and E-STOP.

Sessions are 15-30 minutes — limited by battery on the real robot, so
designed around that constraint in sim too. Within a session, sweetie
carries a small intention forward (`current_goal` field, `set_goal`
tool). Across sessions, she carries forward what the supervisor has
approved: a profile of facts she's learned and short summaries of
recent sessions. See [Memory](#memory) below.

The runtime is FastAPI + a single WebSocket per browser tab. No ROS,
no microservices — but **state does persist** between sessions in a
small SQLite database (`~/.sweetie/memory.db`), holding approved
facts and episode summaries.

## Quick start

```bash
git clone https://github.com/<YOU>/sweetie.git
cd sweetie
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Required for autonomy to actually do anything:
cp .env.example .env
# edit .env and add ANTHROPIC_API_KEY

python -m sweetie
```

Then open <http://127.0.0.1:8000>. Sweetie is autonomous by default —
she'll start initiating ticks ~15 seconds after the bridge connects.
Watch the goal strip below the header to see what she's working on.
Type in the supervisor channel to talk to her; expand the override
panel if you need to drive manually. **Spacebar = E-STOP** at any time,
even if the override panel is collapsed.

### Configuration

All knobs are environment variables. Everything has sensible defaults.

| Variable                       | Default       | What it does                                                                 |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | _(unset)_     | Required for cognition; without it autonomy is a no-op and `/api/chat` returns canned replies |
| `SWEETIE_HOST` / `SWEETIE_PORT`| `127.0.0.1` / `8000` | Where the FastAPI server binds |
| `SWEETIE_MODEL`                | `claude-sonnet-4-5` | Anthropic model name |
| `SWEETIE_BRIDGE`               | `sim`         | `sim` (kinematic simulator) or `real` (Unitree Go2 over DDS) |
| `SWEETIE_SCENE`                | `studio`      | `studio` / `apartment` / `street` / `stairs` / `agility` / `obstacle-sparse|medium|dense` (sim only) |
| `SWEETIE_NETWORK_INTERFACE`    | `eth0`        | DDS network interface (real bridge only) |
| `SWEETIE_DDS_DOMAIN`           | `0`           | DDS domain ID (real bridge only) |
| `SWEETIE_AUTONOMY`             | `on`          | Set to `off` to disable the autonomy loop (pure tele-op mode) |
| `SWEETIE_AUTONOMY_IDLE_S`      | `15`          | Seconds between idle autonomy ticks |
| `SWEETIE_AUTONOMY_COOLDOWN_S`  | `8`           | Minimum gap between any two ticks (event or idle) |
| `SWEETIE_MEMORY`               | `on`          | Set to `off` to disable persistent memory (no DB, no cross-session recall) |
| `SWEETIE_MEMORY_DB`            | `~/.sweetie/memory.db` | Override the SQLite path |

### Scenes

Pick one with `SWEETIE_SCENE=…`. The default `studio` is the full
backlot; the named-area scenes are focused practice areas; the
`obstacle-*` scenes are procedurally generated stress tests:

| Scene             | Objects | Best for                                                |
| ----------------- | -------:| ------------------------------------------------------- |
| `studio`          | 38      | The full world, four named regions, both dynamic entities |
| `apartment`       |  7      | Reactive entities (cat scrambles, person yields), basic safety |
| `street`          | 16      | Static obstacle navigation: car, hydrant, lamp, cones, fence, curbs |
| `stairs`          |  7      | Spatial reasoning around 2/3/5/8-step runs and the L-bend |
| `agility`         |  8      | Apple boxes plus passable terrain (slope/hill/moguls/gravel) |
| `obstacle-sparse` |  50     | Light-density rock field — easy for autonomy to navigate |
| `obstacle-medium` | 100     | Realistic outdoor density — meaningful nav planning needed |
| `obstacle-dense`  | 200     | Stress test — proximity slowdown, vision occlusion at scale |

## How sweetie thinks

The autonomy loop runs in `sweetie/cognition/autonomy.py`. Two trigger
sources, both gated by a shared cooldown and lock:

1. **Bus events.** Perception transitions, smart-assist interventions,
   and region changes immediately schedule a tick. These are "something
   happened, react if it matters."

2. **Idle ticks.** Every `SWEETIE_AUTONOMY_IDLE_S` seconds, a tick fires
   with trigger `"idle"`. This is the difference between a reactive
   system and an autonomous one — without idle ticks, sweetie would
   only think when poked.

Either way, control reaches `Cognition.autonomy_tick(trigger)`, which
synthesizes a prompt note ("autonomy tick — trigger: …") and calls
Claude with full tool access. Claude can do nothing, speak, set or
clear a goal, navigate, look at something, or any combination.

If Claude produces no text and calls no tools, the synthetic note is
**not** committed to history — that keeps the transcript clean across
a 30-minute session.

A typed message from the supervisor cuts in via the same `chat_lock`,
so it can never interleave with an autonomy tick. The supervisor's
message is just another input to the same conversation; sweetie may
respond with text, with a tool call, or both.

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
| `set_goal`        | Set or clear sweetie's current intention; surfaced in the dashboard     |
| `remember`        | Propose a fact to keep across sessions; supervisor approves before it lands |
| `report_status`   | Snapshot of safety, mode, pose, proximity, vision, region, goal, recent events |

All action tools route through the `SafetyGuard`. `set_goal` and
`report_status` are read/write reasoning state and skip the safety
check.

### Two senses, distinguished

Sweetie can see the world two different ways and the prompt is explicit
that they can disagree:

- **Proximity (360°, no occlusion)** — `nearby_objects` and
  `proximity_m`. The 4-quadrant ultrasonic-style sensor model. Sees
  in every direction at once.
- **Vision (forward 70° cone, occluded by solid obstacles)** —
  `in_view`. The forward-camera model. A box behind the couch won't
  appear here even if it's nearby.

When the supervisor asks "what do you see?", sweetie uses `in_view`.
When asked "what's around?", she uses `nearby_objects`.

### Reactive entities

The cat scrambles away when the robot gets within ~0.6 m. The person
pauses when the robot is in their walking path within ~1 m. Both
behaviors emerge from passing the robot's pose to entities each tick;
neither cat nor person has agency beyond that.

## Architecture

```
              ┌──────────────────────────────────────┐
              │  Supervisor dashboard (browser)      │
              │  goal strip · map · chat · override  │
              └────────────────┬─────────────────────┘
                               │  WebSocket + REST
              ┌────────────────▼─────────────────────┐
   ┌──────┐   │       FastAPI server (one process)
   │ LLM  │◄──┤  ┌───────────────────────────────┐  │
   │(Claude)│  │  │   Autonomy (idle + events)   │  │
   └──────┘   │  │   ↓ autonomy_tick(trigger)    │  │
              │  │   Cognition (chat + tools)    │  │
              │  └────────┬─────────────┬────────┘  │
              │           │             │           │
              │  ┌────────▼─┐     ┌─────▼──────┐    │
              │  │ Safety   │     │  Bus       │    │
              │  │  guard   │     │  pub/sub   │    │
              │  └────────┬─┘     └──────┬─────┘    │
              │           │              │          │
              │   ┌───────▼──────────────▼───────┐  │
              │   │     BridgeBase (interface)   │  │
              │   ├──────────────────────────────┤  │
              │   │ SimBridge          RealBridge│  │
              │   │ (kinematic)        (Go2 DDS) │  │
              │   └────┬─────────────────────────┘  │
              │        │                            │
              │   ┌────▼──────┐    ┌──────────┐     │
              │   │   World   │    │ Perception│    │
              │   │  + scenes │    │  (FOV +   │    │
              │   │  + regions│    │ occlusion)│    │
              │   └───────────┘    └──────────┘     │
              └──────────────────────────────────────┘
```

The single most important architectural decision: **every motion
command goes through `SafetyGuard`, regardless of source.** Supervisor
joystick, autonomy tool calls, anything — all routed through the same
chokepoint.

## Memory

Sweetie remembers things across sessions through a small SQLite
database at `~/.sweetie/memory.db` (override with `SWEETIE_MEMORY_DB`,
disable entirely with `SWEETIE_MEMORY=off`). Two tables:

- **Facts** — short statements categorized as `supervisor` (about the
  person), `world` (about the environment), `behavior` (sweetie's own
  habits), or `relationship` (between her and the supervisor).
- **Episodes** — one-paragraph summaries of past sessions, with start/end
  timestamps and an end reason (`battery_low`, `recalled`, `shutdown`,
  `manual`).

### How facts get added

Sweetie can't write to her own memory unilaterally. The flow is:

1. She calls the `remember` tool. The fact lands in the database with
   `status='pending'` — invisible to her future prompts.
2. The dashboard's memory panel shows a **pending tray** with each
   proposal, marked by category. The supervisor can approve, reject,
   or edit-then-approve each one — single ops or batch ("approve all").
3. Approved facts get loaded into the system prompt at the start of
   every future session, grouped by category.

This means **the supervisor curates sweetie's long-term memory**.
Sweetie proposes; the supervisor disposes. Pending facts persist
across sessions until acted on, so a busy session doesn't lose
proposals.

### Honest framing

The system prompt explicitly tells sweetie that her memories are
hers — to be preferred over guessing — but that imperfect recall is
normal. Quoting the prompt:

> Prefer them over guessing. When you're not sure whether you remember
> something specifically, say so plainly ('I think we did' / 'something
> like that') rather than asserting facts you don't have.

Some hallucination is expected and tolerated as a known limitation
of current LLMs. The countermeasure is grounding: the more approved
facts in the prompt, the less room for confabulation.

### Session lifecycle

A session starts when the server boots (a new row in `episodes`) and
ends one of three ways:

- **Battery low** — when the simulated (or real) battery drops below
  15%, the safety FSM trips ESTOP and sweetie's session ends. A
  reflection is written to the episode log.
- **Supervisor recall** — the "recall sweetie" button on the dashboard
  ends the session immediately. `POST /api/session/end`.
- **Shutdown** — best-effort: if the server is stopped before either
  of the above, an end-reason of `shutdown` is recorded. Reflection
  may not run if no API key.

When a session ends, autonomy detaches, sweetie writes a one-paragraph
summary to the episode log, and the dashboard updates to show the
end-reason and summary. No new sessions start until the server is
restarted.

### Forgetting

Three ways to remove memories:

- **Reject from the dashboard** — pending facts marked rejected stay
  in the DB for audit but never load into prompts.
- **Forget from the dashboard** — approved facts can be hard-deleted
  with the "forget" button. Same for episodes (except the in-progress
  one).
- **CLI bulk-forget** — `python -m sweetie.tools.forget [--all |
  --pending | --episodes]`. Confirmation prompt unless `--yes`.

The SQLite database is human-readable; you can also `sqlite3
~/.sweetie/memory.db` and edit directly if you want surgical control.

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
  safety guard, autonomy, dashboard work identically against either bridge
- `RealPerception` generates proximity-quadrant transition events from
  the live `range_obstacle` field with hysteresis; same event shape
  cognition sees from `SimPerception`
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
  planner on hardware yet
- Audio hub TTS: the `speak_through_robot` seam exists on `RealBridge`
  but the audio block encoding is unimplemented. `speak` falls back to
  the chat panel cleanly.
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
and `rt/lowstate`, and observes mode codes the robot is actually
emitting — without sending any commands. Run this before letting
`RealBridge` issue motion commands. Exit code 0 = all checks passed.

## Tests

```bash
pytest
```

338 tests, all passing as of this README. Coverage includes:

- Safety FSM transitions, predicate ticks, proximity-aware scaling,
  battery-low and tilt auto-trip
- Bridge: connect/disconnect, command dispatch, integration, look_at,
  reactive entities, perception, region tracking, body height,
  navigation, waypoint queues
- World: lookups, geometry, categories, velocity, motion classification,
  reactive flee/yield, scene registry, regions, procedural obstacle fields
- SimPerception: quadrant transitions, FOV cone, occlusion, vision events
- RealPerception: hysteresis, near/far thresholds, per-quadrant
  independence, drain semantics
- Cognition: tool dispatch, safety integration, look_at outcomes,
  report_status structure, scene-aware system prompt, sliding-window
  history trimming, speak-through-bridge wiring, set_goal round-trip,
  remember tool round-trip
- Autonomy: idle ticker, bus subscriptions, cooldown drops/releases,
  lock serializes, empty payloads dropped, detach stops idle loop
- Memory: SQLite schema bring-up, propose/approve/reject/edit flow,
  batch ops, episode lifecycle (start/end/idempotent close), forget
  ops, prompt-block construction with category grouping, source-session
  linkage, session-lifecycle integration (battery_low, recalled paths)
- Real bridge: 25 mock-based tests against the documented SDK surface
- Preflight diagnostic: SDK init, DDS connect, topic publishing, schema
  validation, mode-code observation

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
│   ├── llm.py               # Anthropic client, tools, chat loop, autonomy_tick.
│   ├── autonomy.py          # Idle + event-driven primary cognition loop.
│   └── memory.py            # SQLite-backed cross-session memory (facts + episodes).
├── sim/
│   ├── world.py             # Named objects + regions + scene registry (8 scenes).
│   └── perception.py        # SimPerception: quadrants + vision FOV + occlusion.
├── teleop/
│   ├── server.py            # FastAPI: /ws + /api/chat + /api/world + /api/memory + /api/session + UI.
│   └── static/              # The supervisor dashboard (HTML + CSS + vanilla JS).
└── tools/
    ├── preflight.py         # Read-only hardware bring-up diagnostic.
    └── forget.py            # CLI for bulk memory deletion.

docs/
├── go2-references.md        # Cross-reference vs upstream Go2 projects.
└── hardware-bringup.md      # Step-by-step first-Go2 procedure (speculative).
```

The `teleop/` directory is named for historical reasons — it's the
dashboard server, not a tele-op-only thing. Renaming it is a roadmap
item, not yet done.

## Reference materials

[`docs/go2-references.md`](docs/go2-references.md) cross-references
sweetie's `RealBridge` against four BSD-2-Clause community projects.
The upstream files are preserved verbatim under `third_party/`, with
their original copyright headers and LICENSE files intact.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for what's planned and what's
deliberately out of scope.

## License

MIT. See `LICENSE`. Third-party reference materials under `third_party/`
retain their original BSD-2-Clause licenses; see
[`third_party/README.md`](third_party/README.md) for per-project terms.
