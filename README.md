# sweetie

A small tele-op platform for a Unitree Go2 quadruped. Sim-only for now.
Hybrid control: deterministic safety FSM, LLM for high-level chat/intent.

## What this actually does, today

Milestones shipped: **M1, M2, M3, M4, M5, M?-scene, M7, M?-reactive**.

- Behavioural simulator (`SimBridge`) that integrates commanded velocity into pose at 50 Hz, populates proximity readings (front/left/back/right) from a small fake world, ticks moving entities, supports closed-loop yaw goals for "look at this thing", and tracks per-entity quadrant transitions for perception events.
- Safety FSM (`SafetyGuard`) that gates every motion command and every action intent. States: `IDLE → ARMED → ACTIVE → ESTOP`. The guard also applies proximity-aware velocity scaling — operator joystick commands toward an obstacle are linearly slowed between 1.0 m and 0.3 m clearance, and zeroed below the hard floor. Driving away is always full-speed.
- Web operator console: drag joystick to drive, ARM/DISARM/STAND/SIT buttons, latching E-STOP, telemetry strip, and a top-down world map showing the room and the robot's pose live. Smart-assist interventions show up as ⚠ amber chat lines.
- Reactive LLM cognition: chat with Claude in the side panel. Six tools — `speak`, `stand_up`, `sit_down`, `halt`, `look_at`, `report_status` — all flowing through the same `SafetyGuard` the joystick does. `report_status` exposes proximity, recent assists, *and* — for each nearby object — its category and current motion (approaching/receding/stationary), plus a `recent_perceptions` log of meaningful transitions.
- A small fake world (`sim/world.py`) with five static objects and two moving ones — a `Wanderer` cat and a `PathWalker` person. Each object carries a category. Both dynamic entities are *reactive*: the cat scrambles away when the robot gets within 0.6 m, and the person pauses when the robot is in their walking path within 1 m. The robot's `range_obstacle[4]` matches the schema the real Go2 publishes.
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

- Talk to a real Go2.
- See, hear, or otherwise sense the simulated world (the world has no objects in it).
- Run any kind of behaviour tree, planner, or autonomy.
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

## Layout

```
sweetie/
├── core/
│   ├── bridge.py        # SimBridge + BridgeBase. The simulator.
│   ├── real_bridge.py   # RealBridge — wraps unitree_sdk2py. UNVERIFIED.
│   ├── safety.py        # FSM + command guard. Single source of truth for "may I move?"
│   └── bus.py           # Tiny async pub/sub.
├── cognition/
│   └── llm.py           # Anthropic client, tools, chat loop.
├── sim/
│   └── world.py         # Top-down world model: named objects, proximity, motion.
└── teleop/
    ├── server.py        # FastAPI: /ws telemetry+commands, /api/chat, /api/world, static UI.
    └── static/          # The operator console.
```

## Roadmap

These are aspirational — listed by what they unlock, not by version number.

**M? — bring-up on a real Go2.** The biggest open item. `RealBridge` exists but has never been runtime-tested. The first session with hardware will need someone to: confirm the network configuration, verify the SDK API surface still matches what we wrote against, validate the mode-code mapping, and exercise each command. Tracked work, not new feature work.

**M? — real perception.** `look_at_entity` returns "no_world" on real hardware because there's no perception layer. Plumbing in a vision/lidar pipeline (camera → detection → tracking → entity list) would let the existing `look_at` tool work, and would populate `recent_perceptions` from real sensor data instead of ground-truth shortcuts.

**M6 — physics sim.** Optional. Either revive the MuJoCo bridge from the original wreckage or stay kinematic. Decide based on whether you actually need to test stability/tipping/recovery — kinematic sim is fine for everything else.

**M? — ambient cognition.** LLM gets periodic world-state snapshots and can act on its own (not just suggest in response to prompts). The world is now dynamic, observable, *and* reactive enough that proactivity has things to react to. The most interesting variant: drive the LLM by perception events rather than on a clock. Adds real complexity (when does it run? what's the rate-limit story? cost?), so should only land when there's a clear use case.

**M? — entity goals beyond reactive.** The cat just flees; the person just yields. They have no purposes — the cat doesn't go to a food bowl, the person doesn't have errands. Adding entity-level "want" (the cat wants to nap on the rug; the person wants to reach the kitchen and back) would make the simulation feel less scripted. Easy to add but unclear value.

## License

MIT. Do whatever.
