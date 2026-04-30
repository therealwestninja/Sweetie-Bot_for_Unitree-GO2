# sweetie

A small tele-op platform for a Unitree Go2 quadruped. Sim-only for now.
Hybrid control: deterministic safety FSM, LLM for high-level chat/intent.

## What this actually does, today

Milestones shipped: **M1, M2, M3, M4, M5, M?-scene**.

- Behavioural simulator (`SimBridge`) that integrates commanded velocity into pose at 50 Hz, populates proximity readings (front/left/back/right) from a small fake world, ticks moving entities, supports closed-loop yaw goals for "look at this thing", and tracks per-entity quadrant transitions for perception events.
- Safety FSM (`SafetyGuard`) that gates every motion command and every action intent. States: `IDLE → ARMED → ACTIVE → ESTOP`. The guard also applies proximity-aware velocity scaling — operator joystick commands toward an obstacle are linearly slowed between 1.0 m and 0.3 m clearance, and zeroed below the hard floor. Driving away is always full-speed.
- Web operator console: drag joystick to drive, ARM/DISARM/STAND/SIT buttons, latching E-STOP, telemetry strip, and a top-down world map showing the room and the robot's pose live. Static furniture is fetched once on connect; dynamic entities (the cat, the person) are repositioned on every telemetry frame and outlined in blue. Smart-assist interventions show up as ⚠ amber chat lines.
- Reactive LLM cognition: chat with Claude in the side panel. Six tools — `speak`, `stand_up`, `sit_down`, `halt`, `look_at`, `report_status` — all flowing through the same `SafetyGuard` the joystick does. `report_status` exposes proximity, recent assists, *and* — for each nearby object — its category and current motion (approaching/receding/stationary), plus a `recent_perceptions` log of meaningful transitions.
- A small fake world (`sim/world.py`) with five static objects and two moving ones — a `Wanderer` cat that random-walks within 0.8 m of its home, and a `PathWalker` person who walks a counter-clockwise loop of seven waypoints around the apartment. Each object carries a category (`furniture`, `animal`, `person`, `fixture`, `decor`). The robot's `range_obstacle[4]` matches the schema the real Go2 publishes.

That's it. No autonomy. No vision. No real hardware path. The LLM does not act unprompted.

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
│   ├── bridge.py     # SimBridge + BridgeBase. Swap in RealBridge later, here.
│   ├── safety.py     # FSM + command guard. Single source of truth for "may I move?"
│   └── bus.py        # Tiny async pub/sub.
├── cognition/
│   └── llm.py        # Anthropic client, tools, chat loop.
├── sim/
│   └── world.py      # Top-down world model: named objects, proximity queries.
└── teleop/
    ├── server.py     # FastAPI: /ws telemetry+commands, /api/chat, /api/world, static UI.
    └── static/       # The operator console (now with a top-down map).
```

## Roadmap

These are aspirational — listed by what they unlock, not by version number.

**M6 — physics sim.** Either revive the MuJoCo bridge from the original wreckage (after verifying it actually runs) or stay kinematic. Decide based on whether physics matters for what you want to test next. The simulator we have works fine for testing motion control, smart-assist, and scene awareness; physics matters more if you want to test stability, tipping, and recovery behaviors.

**M7 — real hardware.** Drop in a `RealBridge` that wraps `unitree_sdk2py`. The seam is already in place — `BridgeBase` is the only thing the rest of the codebase knows about, and our `range_obstacle[4]` and command shapes already mirror what the Go2 publishes. The `recent_perceptions` would be replaced by a real vision/lidar pipeline.

**M? — ambient cognition.** LLM gets periodic world-state snapshots and can act on its own (not just suggest in response to prompts). Adds real complexity (when does it run? what's the rate-limit story? cost?). The world is now dynamic and observable enough that proactivity has things to react to — but be honest about whether it's actually useful before building it. The most interesting variant: drive the LLM by perception events (entity entered front quadrant) rather than on a clock.

**M? — reactive entities.** Right now entities move along their own patterns regardless of the robot. Making the cat dart away when the robot gets close, or the person look up when called, would give the world a sense of being inhabited rather than scripted. Crosses into "entities have goals" territory.

## License

MIT. Do whatever.
