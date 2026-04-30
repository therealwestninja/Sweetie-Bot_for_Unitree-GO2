# sweetie

A small tele-op platform for a Unitree Go2 quadruped. Sim-only for now.
Hybrid control: deterministic safety FSM, LLM for high-level chat/intent.

## What this actually does, today

Milestones shipped: **M1, M2, M3, M4, M5, M?-scene, M7, M?-reactive, M?-extra-scene, M?-real-perception, M?-ambient**.

- Behavioural simulator (`SimBridge`) that integrates commanded velocity into pose at 50 Hz, populates proximity readings (front/left/back/right) from a small fake world, ticks moving entities, supports closed-loop yaw goals for "look at this thing", and tracks per-entity quadrant transitions for perception events.
- Safety FSM (`SafetyGuard`) that gates every motion command and every action intent. States: `IDLE → ARMED → ACTIVE → ESTOP`. The guard also applies proximity-aware velocity scaling — operator joystick commands toward an obstacle are linearly slowed between 1.0 m and 0.3 m clearance, and zeroed below the hard floor. Driving away is always full-speed.
- Web operator console: drag joystick to drive, ARM/DISARM/STAND/SIT buttons, latching E-STOP, telemetry strip, and a top-down world map showing the room and the robot's pose live. Smart-assist interventions show up as ⚠ amber chat lines.
- Reactive LLM cognition: chat with Claude in the side panel. Six tools — `speak`, `stand_up`, `sit_down`, `halt`, `look_at`, `report_status` — all flowing through the same `SafetyGuard` the joystick does. `report_status` exposes proximity, recent assists, *and* — for each nearby object — its category and current motion (approaching/receding/stationary), plus a `recent_perceptions` log of meaningful transitions.
- A "studio backlot" world (`sim/world.py`) with 38 named objects in 12 categories — apartment area (couch, table, kitchen, door, rug, plus a wandering cat and a path-walking person), a street scene to the east (parked car, fire hydrant, lamp post, traffic cones, fence line, sidewalk curbs), stairs to the north (2/3/5/8-step straight runs plus an L-bend with a turn platform), and an agility area to the south-west (apple boxes in four standard film-prop sizes, plus passable terrain — gentle slope, hill, moguls, gravel patch). Stairs and terrain are honestly *represented*, not simulated — our kinematic sim has no Z axis, no traversal physics. Both dynamic entities are reactive: the cat scrambles away within 0.6 m, the person yields when the robot is in their walking path.
- Perception is its own module (`sim/perception.py`) behind a clean `PerceptionBase` interface. `SimPerception` cheats with ground-truth positions; a future `RealPerception` (camera + lidar + tracker) would slot into the same surface and feed `RealBridge`. The bridge owns one perception instance and exposes `recent_perceptions()`, which the LLM reads via `report_status`.
- Ambient cognition (`cognition/ambient.py`) lets the LLM react unprompted to bus events — smart-assist interventions and perception transitions. Strict cooldown (default 20 s) prevents spam; `(silent)` responses don't burn the cooldown. Off by default — opt in with `SWEETIE_AMBIENT=on`.
- A `RealBridge` (`core/real_bridge.py`) for connecting to an actual Unitree Go2 over DDS via `unitree_sdk2py`. **This integration is unverified on hardware — see the warning below.** Selectable at startup via `SWEETIE_BRIDGE=real`.

## Hardware integration status

The `RealBridge` has been written against the documented `unitree_sdk2py` Python API and the published schemas in the upstream `unitree_ros2` repository. It has **not** been runtime-tested against an actual Go2.

What's been verified:
- Integration shape — every SDK call I make is structured against the documented surface, validated by 25 mock-based tests.
- Wire protocol — DDS topic names (`rt/sportmodestate`, `rt/lowstate`) and message field accesses match the upstream schemas.
- Architectural seams — `RealBridge` implements `BridgeBase` cleanly. The safety guard, cognition, and operator UI all work identically against either bridge.
- Failure modes — calling commands before `connect()` returns False, SDK errors return False, missing SDK gives a clear actionable error.

What has NOT been verified:
- Whether the `unitree_sdk2py` API surface I targeted matches the current upstream package. (Tested SDK methods: `ChannelFactoryInitialize`, `ChannelSubscriber.Init`, `SportClient.SetTimeout/Init/StandUp/StandDown/Move/StopMove/Damp`.)
- The mode-code mapping (`uint8 mode` → our internal vocabulary). Specific values used: `5` = damp/estop, `7` = stand_down, `0/1` = idle/balance. Other modes fall through to "standing" or "moving" by velocity heuristic.
- Network configuration (interface, domain ID).
- Any of the timing/latency assumptions.

First hardware bring-up should be treated as bring-up. Expect to debug.

That's it. No autonomy. No vision. The LLM does not act unprompted.

## What it does *not* do yet

- Talk to a real Go2 (the integration is written but unverified).
- See or hear via real sensors (the perception layer cheats with ground-truth from the simulated world).
- Run any kind of behaviour tree, planner, or autonomy. Ambient cognition is reactive commentary, not autonomous action.
- Persist anything across restarts.

These are roadmap items below, not features hiding in the code.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Optional but strongly recommended:
cp .env.example .env
# edit .env and add ANTHROPIC_API_KEY

python -m sweetie
```

Then open <http://127.0.0.1:8000>.

Click **arm**, then drag the joystick. Press **space** for E-STOP at any time.

## Tests

```bash
pytest
```

Tests are real and they all run against the sim — there's no real-hardware path to break.

## Reference materials

`docs/go2-references.md` cross-references our `RealBridge` against
upstream Unitree and community Go2 projects (sport mode API IDs, DDS
topic names, mode-code mapping, robot-state field surface). The
upstream files are preserved verbatim under `third_party/`, with
their original copyright headers and LICENSE files intact (BSD 2-Clause
for both projects we drew from).

If you're bringing `sweetie` up against real hardware, start with that
doc — it lists what's verified against published sources vs what's
guessed.

## Layout

```
sweetie/
├── core/
│   ├── bridge.py        # SimBridge + BridgeBase. The simulator.
│   ├── real_bridge.py   # RealBridge — wraps unitree_sdk2py. UNVERIFIED.
│   ├── safety.py        # FSM + command guard. Single source of truth for "may I move?"
│   └── bus.py           # Tiny async pub/sub.
├── cognition/
│   ├── llm.py           # Anthropic client, tools, chat loop, ambient_react.
│   └── ambient.py       # Bus-event-driven unprompted commentary (opt-in).
├── sim/
│   ├── world.py         # Top-down world model: 38 named objects, motion, reactive entities.
│   └── perception.py    # SimPerception behind PerceptionBase — the seam for real perception.
└── teleop/
    ├── server.py        # FastAPI: /ws telemetry+commands, /api/chat, /api/world, static UI.
    └── static/          # The operator console.
```

## Roadmap

These are aspirational — listed by what they unlock, not by version number.

**M? — bring-up on a real Go2.** The biggest open item. `RealBridge` exists but has never been runtime-tested. The first session with hardware will need someone to: confirm the network configuration, verify the SDK API surface still matches what we wrote against, validate the mode-code mapping, and exercise each command. Tracked work, not new feature work.

**M? — real-perception implementation.** The seam is in place — `PerceptionBase` interface, bridge ownership, cognition consumption — but the actual `RealPerception` class doesn't exist yet. It would consume camera/lidar output, run a detector and tracker, and produce the same shape of events that `SimPerception` produces from ground truth. Slots into `RealBridge` exactly the way `SimPerception` slots into `SimBridge`.

**M6 — physics sim.** Optional. Either revive the MuJoCo bridge from the original wreckage or stay kinematic. This is what would let the simulator actually *simulate* stair traversal, slope handling, and stability. Right now those features are represented on the map but not exercised.

**M? — ambient cognition tuning.** Ambient is shipped but minimally tuned. Real-world questions: does the 20s cooldown feel right? Does the LLM say useful things or filler? Should ambient watch additional bus topics (e.g. battery dropping below threshold, telemetry tilt warnings)? Should it have a "quiet hours" mode? Best answered by actually using the thing.

**M? — entity goals beyond reactive.** The cat just flees; the person just yields. They have no purposes. Adding entity-level "want" (cat wants to nap on the rug; person wants to reach the kitchen) would make the simulation feel less scripted. Easy to add but unclear value.

## License

MIT. Do whatever.
