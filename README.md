# sweetie

A small tele-op platform for a Unitree Go2 quadruped. Sim-only for now.
Hybrid control: deterministic safety FSM, LLM for high-level chat/intent.

## What this actually does, today (M1 + M2 + M3 + M4 + M5)

- Behavioural simulator (`SimBridge`) that integrates commanded velocity into pose at 50 Hz, populates proximity readings (front/left/back/right) from a small fake world, ticks moving entities, and supports closed-loop yaw goals for "look at this thing".
- Safety FSM (`SafetyGuard`) that gates every motion command and every action intent. States: `IDLE → ARMED → ACTIVE → ESTOP`. The guard also applies proximity-aware velocity scaling — operator joystick commands toward an obstacle are linearly slowed between 1.0 m and 0.3 m clearance, and zeroed below the hard floor. Driving away is always full-speed.
- Web operator console: drag joystick to drive, ARM/DISARM/STAND/SIT buttons, latching E-STOP, telemetry strip, and a top-down world map showing the room and the robot's pose live. Static furniture is fetched once on connect; dynamic entities (the cat, the person) are repositioned on every telemetry frame and outlined in blue. Smart-assist interventions show up as ⚠ amber chat lines.
- Reactive LLM cognition: chat with Claude in the side panel. It has six tools — `speak`, `stand_up`, `sit_down`, `halt`, `look_at`, `report_status` — and every action tool flows through the same `SafetyGuard` the joystick does. `report_status` exposes proximity, nearby objects (with current positions, since they move), and recent smart-assist events.
- A small fake world (`sim/world.py`) with five static objects and two moving ones — a `Wanderer` cat that random-walks within 0.8 m of its home, and a `PathWalker` person who walks a counter-clockwise loop of seven waypoints around the apartment. The robot's `range_obstacle[4]` matches the schema the real Go2 publishes.

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

**M6 — physics sim.** Either revive the MuJoCo bridge from the original wreckage (after verifying it actually runs) or stay kinematic. Decide based on whether physics matters for what you want to test next. The simulator we have works fine for testing motion control and smart-assist; physics matters more if you want to test stability, tipping, and recovery behaviors.

**M7 — real hardware.** Drop in a `RealBridge` that wraps `unitree_sdk2py`. The seam is already in place — `BridgeBase` is the only thing the rest of the codebase knows about, and our `range_obstacle[4]` and command shapes already mirror what the Go2 publishes.

**M? — ambient cognition.** LLM gets periodic world-state snapshots and can act on its own (not just suggest in response to prompts). Adds a lot of complexity (when does it run? what's the rate-limit story? cost?). The world is now dynamic enough that proactivity has things to react to — but be honest about whether it's actually useful before building it.

**M? — more sensors / scene understanding.** Right now the LLM "sees" via `report_status` which lists nearby objects with positions. Adding categories (people vs furniture vs pets), intent inference ("the person is walking toward the door"), or a notion of audio/visual events would make the cognition richer without needing a real camera. Lightweight vs ambient-cognition's heaviness.

## License

MIT. Do whatever.
