# Hardware bring-up

How to bring sweetie up against an actual Unitree Go2 for the first
time. This document is **speculative** until somebody runs it; expect
to revise on contact with reality.

The order matters. Each step verifies a smaller thing than the one
after it, so a failure tells you specifically what's broken instead of
"something somewhere doesn't work." Don't skip ahead.

---

## Phase 0 — Before you plug anything in

**Read `docs/go2-references.md`.** It cross-references sweetie's
`RealBridge` against four other open-source Go2 projects (BSD-2-Clause).
If anything in the next phases doesn't match what you see, those
projects are your second opinion.

**Have a kill switch ready.** The Go2's physical E-STOP button is on
the body; know where it is. Set up the operator console (`python -m
sweetie` with `SWEETIE_BRIDGE=sim` first to confirm the UI works) and
practice hitting the spacebar E-STOP. Software E-STOP needs the WS
connection live; physical E-STOP works regardless. Use both.

**Clear floor space.** Ten feet by ten feet, soft floor (carpet or
yoga mat). Nothing breakable within fall radius. If the robot tips, you
want it to land on something forgiving.

**Fully charge the battery.** Below 15% sweetie's safety FSM auto-trips
to E-STOP; below 10% the robot's own firmware does. You don't want to
debug a power issue while debugging a comms issue.

## Phase 1 — Network and DDS (read-only)

Run the preflight diagnostic before sweetie ever sends a command:

```bash
python -m sweetie.tools.preflight --interface eth0 --domain 0
```

Substitute the interface name your machine actually has (`enp0s3`,
`wlan0`, etc.). The Go2 ships with DDS domain 0 by default; if yours
is different, set it.

Preflight checks, in order:

1. `unitree_sdk2py` is importable. If not, the install didn't take —
   `pip install -e ".[real]"` or fall back to the GitHub URL if PyPI
   doesn't have it for your region.
2. `ChannelFactoryInitialize` succeeds on the configured interface.
3. The robot is publishing on `rt/sportmodestate` and `rt/lowstate`
   within a 3-second window.
4. The first message on each topic carries the fields we read
   (`position[3]`, `imu_state.rpy[3]`, `velocity[3]`, `yaw_speed`,
   `body_height`, `range_obstacle[4]`, `mode`, `bms_state.soc`).
5. Logs the distinct `mode` values seen during the observation window.

Exit code 0 = pass; 1 = at least one check failed; 2 = preflight could
not run. Do not proceed until you see exit code 0.

If preflight fails on step 4 (field shape mismatch), upstream
`unitree_sdk2py` may have changed its message schema. Compare against
`third_party/go2_ros2_sdk/robot_data.py` and update sweetie's
`_on_sport_state` / `_on_low_state` callbacks if the field names have
shifted. This is a real risk — the upstream isn't versioned in a way
that gives us guarantees.

If preflight fails on step 5 with mode codes we don't know about, log
them and update `RealBridge._mode_to_str` to map them. The current
table is a guess from documentation, not from observation.

## Phase 2 — Telemetry-only sweetie boot

```bash
SWEETIE_BRIDGE=real \
SWEETIE_NETWORK_INTERFACE=eth0 \
SWEETIE_DDS_DOMAIN=0 \
python -m sweetie
```

Open the UI. **Do not arm yet.** Verify:

- The map is empty (no world model on real hardware — this is correct).
- Telemetry updates: pose, velocity, battery percent, body height all
  match what you can see / what the Go2's official app says.
- The 4-quadrant proximity bars on the UI move when you wave a hand
  near each side of the robot.
- The mode indicator says something sensible — if it says "unknown",
  go back to phase 1 step 5.
- `RealPerception` is generating events: walk a few feet from the
  robot and back. The chat panel should show entries like "obstacle
  in front quadrant (1.4 m)" and "front quadrant cleared".

If any of those are wrong, do not proceed. Telemetry is the foundation
for everything else.

## Phase 3 — Damp and E-STOP

Critical: **before any motion command, verify damp/E-STOP works.**

Click "arm" to move the safety FSM into ARMED. Press the spacebar.
The safety guard goes to ESTOP. On real hardware, this triggers
`SportClient.Damp()`, which makes the joints compliant — the robot
should settle softly, not collapse and not hold a rigid stand.

If the robot collapses hard, Damp() isn't being called or isn't doing
what we expect. Look at `RealBridge.emergency_stop()` and check
against `third_party/go2_ros2_sdk/robot_commands.py` — the SDK might
expose damp under a different name on your firmware version.

If the robot stays rigidly standing after E-STOP, the SDK call returned
non-zero. Check the log for "SDK call returned" warnings. Do not
proceed until E-STOP reliably softens the robot.

Clear E-STOP from the UI. Verify the safety FSM goes back to IDLE.
Re-arm.

## Phase 4 — Stand-up / stand-down

Still in ARMED. From the chat: `stand up`. The LLM emits the
`stand_up` tool call, which routes through `SafetyGuard.guard_action`
("stand_up" requires armed — it's gated). RealBridge calls
`SportClient.StandUp()`.

What you should see:
- LLM chat shows `do stand_up · ok`.
- Robot rises into the standing posture (~0.27 m body height).
- Telemetry mode flips to "standing".

`sit down` does the inverse. Repeat 3-4 times. Watch for:
- Mode telemetry follows what the robot is actually doing.
- No SDK errors in the log.
- Body height telemetry is roughly 0.27 m standing, ~0.10 m folded.

If mode telemetry diverges from reality, your mode-code mapping is
wrong (back to phase 1 step 5).

## Phase 5 — Body height (low risk)

`set body height to 0.20` (crouched). Robot should drop into a
half-crouch.

`set body height to 0.32` (tall). Robot should rise.

`set body height to 0.27` (default).

This is the lowest-risk way to verify SDK calls are reaching the
firmware — it's a posture change, not motion. If body height telemetry
moves but the robot doesn't, your `BodyHeight` SDK call is talking to
the wrong API. If the robot moves but telemetry doesn't update, the
read-side schema is wrong.

`RealBridge.set_body_height` converts your absolute height to a
relative offset from `BODY_HEIGHT_DEFAULT = 0.27`. If the robot moves
to the wrong height (e.g., you ask for 0.20 and it crouches further to
0.13), the SDK is taking absolutes, not offsets — flip the conversion.

## Phase 6 — Move at low velocity

This is the first real motion test. Tighten the floor space if you
hadn't already.

Joystick a tiny forward motion: `vx = 0.1 m/s` for one second, then
release. Robot walks one step forward. Watch for:

- `range_obstacle` updates as the robot moves.
- The safety guard's proximity slowdown kicks in if you walk toward a
  wall (it should — `SafetyGuard.guard()` applies the same scaling on
  real hardware as in sim).
- Stop on release.
- No drift after stop.

If the robot doesn't stop on release, the heartbeat path is broken.
Look at how `move(0, 0, 0)` translates through `SportClient.Move()` —
upstream may require an explicit `StopMove()` after `Move()` returns
to zero.

Now sideways (vy = 0.1) and yaw (vyaw = 0.1). Same checks.

## Phase 7 — Smart-assist on real proximity

Drive the robot toward a wall slowly. The safety guard's proximity
scaling should slow it as it approaches and stop it before contact.

This is where sim and reality diverge most. In sim, `range_obstacle`
comes from world objects; on hardware it comes from the Go2's
ultrasonic sensors. They report differently on different surfaces:
glass, mirrors, dark fabrics, and very low obstacles confuse them.

If smart-assist doesn't engage, the proximity field is reading wrong
or all zeros. Verify in the UI that the front bar lights up as you
approach the wall. If it doesn't, the read-side `range_obstacle`
field isn't being populated — back to phase 1 step 4.

## Phase 8 — Tilt and battery auto-trip

Pick the robot up gently and tilt it past 34° (`TILT_LIMIT_RAD`). The
safety FSM should auto-trip to E-STOP. Set down. Clear E-STOP.

For battery: there's no easy way to fake low battery — wait until the
robot drains to <15%. The sim covers this path, hardware just confirms
the same `predicate_tick` runs.

## Phase 9 — `look_at` and other compositional tools

`look_at_entity` requires a world model — `RealBridge.look_at_entity`
returns "no_world" because we don't have one on hardware. **This is
correct, not a bug.** Sweetie's named-object lookup needs a SLAM /
mapping layer that doesn't exist yet. The LLM will tell the operator
"I can't see specific objects on real hardware yet."

`go_to_pose` and `follow_path` are similarly **deliberately refused**
on `RealBridge` because they'd need real perception + a planner. The
log message tells you why.

`set_body_height` works, `halt` works, `stand_up`/`sit_down` work,
`speak` falls back to the chat panel (the audio hub TTS path is
unimplemented — see Phase 10).

`report_status` works — the snapshot returned just has fewer fields
populated (no `nearby_objects`, no `current_region`, empty
`in_view`). Cognition's system prompt for the real-hardware case is
already aware of this and tells the LLM not to fabricate.

## Phase 10 — What's still unimplemented

These features are **architecturally wired but not functional** on
real hardware. Each needs its own bring-up.

**Audio hub / TTS through robot speaker.** `RealBridge.speak_through_robot`
is currently a logging stub. Implementing requires:
1. An external TTS engine (espeak / festival / pyttsx3 / a cloud API)
2. Encoding to whatever audio format `AUDIO_HUB_COMMANDS.SEND_AUDIO_BLOCK`
   accepts (sample rate, encoding, chunk size — not documented in the
   BSD-2 references, must be discovered empirically)
3. Sequencing `START_AUDIO` (4001) → `SEND_AUDIO_BLOCK` (4003)*  →
   `STOP_AUDIO` (4002).

Until this lands, `speak` works in the chat panel only.

**Camera frame ingestion.** The Go2's RealSense publishes RGB and
depth on dedicated topics; we don't subscribe. Without it,
`RealPerception.vision_summary()` returns `[]` and the LLM's `in_view`
field is always empty.

**Semantic detector / tracker.** Even with frames, identifying objects
by name needs an on-board model or an external service. The
architectural seam is in place (`RealPerception` would generate
detection events analogous to sim's vision events) but the model is
out of scope.

**Nav2 + costmap.** `go_to_pose` and `follow_path` need a local
costmap and a planner. ROS2 Nav2 is the obvious choice; integration
is non-trivial and out of scope for sweetie itself — this is where
sweetie hands off to a separate process.

## Phase 11 — Update the docs

When you've worked through these, **update sweetie**:

- README badge: change `sim only` to `hardware-tested` with the
  firmware version you tested against.
- `RealBridge` docstring: remove the UNVERIFIED warning where it no
  longer applies; keep it where it does.
- `ROADMAP.md`: flip rows from 🟡 to ✅ for the things you actually
  verified. Add notes about quirks discovered ("the Go2 we tested
  reports `mode=8` for damp, not `mode=0` as we assumed").
- This document: rewrite the steps that surprised you. Future you
  will thank present you.

The most valuable thing you can do is **write down what was different
from what we expected.** Sweetie was built carefully against
documented sources, but the gap between "structurally plausible" and
"actually works" can only be closed by you, on the floor, with a
robot.
