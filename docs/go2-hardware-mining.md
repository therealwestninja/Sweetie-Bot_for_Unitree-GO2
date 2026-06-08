# Mining notes — Unitree Go2 hardware (teardown + product overview + sim2real RL talk)

Three subtitles, all on Sweetie's actual target hardware. Together they pin down her real
**body**, her real **action vocabulary**, and the real **low-level locomotion layer** that sits
under the LLM planner.

## Her real body (from the teardown)

- **12 actuated joints, 3 per leg** (hip / thigh / calf-knee), each leg >270deg range and
  **back-drivable** (movable when unpowered).
- **Modular legs with a deliberate weak-link** (a low-strength break point so a hard yank fails
  one cheap part instead of the chassis); **feet are consumables** (spares included).
- **Head module = LiDAR + camera**, the **most expensive, most fragile** part: a spinning
  dual-axis **4D LiDAR** (360deg, 3D point cloud) buried behind a welded steel cage; the neck is
  crack-prone and the robot faceplants a lot.
- **Jetson-class compute** with heat pipes + multiple fans (Pro/Edu add more compute + cooling)
  -> real **thermal** load. 32x 18650-cell battery + BMS. GNSS, Wi-Fi/BT, an internal ethernet
  debug port, attachment ports (e.g. a robotic arm).
- One main logic board; 12 motors + head sensors + battery plug into it -> simple system
  architecture, good repairability.

## Her real action vocabulary + SDK surface (from the product overview)

- **Trick/pose set:** sit, stand, stretch, pose (free flex), rollover, greet, show-heart,
  pounce, dance, handshake (paw), lock-on (hold), **damping** (go limp / safe stop),
  **stand-up-from-fall**, keep-walking, run, climb. Obstacle-avoidance toggle (voice-confirmable).
- **Beacon side-follow** (carries a beacon; walks beside you) -- a hardware-native follow that's
  distinct from vision-follow.
- FPV camera + photo/video; built-in speaker; voice interaction + wake-words; headlight colors.
- **BenBen chat** (paid LLM mode) is **disconnected from locomotion** -- it literally says "as a
  virtual pet I can't physically move to hide." Sweetie's unified chat+`<do>` action closes
  exactly this gap: her words and her body are one brain.
- **Blockly visual programming with a simulator** -- test a routine in sim before applying it to
  the robot. App exposes data readouts (battery %, comm quality, calibration offset, alarms),
  AP/Wi-Fi modes.
- Reality check: **stairs are weak** (fails normal steps, manages small ones), fast on flat /
  off-road, sturdy against pushes.

## The low-level locomotion layer (from the deep-dive talk)

- Procedural/algorithmic gaits (CHAMP, OCS2) work but are brittle and "march in place."
- The modern path is **RL trained in Isaac Sim / Isaac Gym**: thousands of parallel sims, a
  reward function, deriving control policies that look **biological**; then **sim2real** onto the
  robot. Unitree ships a **URDF** (Go1 == Go2 hardware) you import into Isaac in minutes.
- This is the **System-1 / cerebellum fast layer** from the GrowBot notes, made concrete: a
  learned policy does balance/gait/get-up; the LLM planner rides on top emitting goals + gestures.

## Implemented this pass (Perchance PoC)

- **Expression / gesture vocabulary** mapped to the real Go2 trick set: `greet`, `heart`,
  `dance`, `stretch`, `sit`, `stand`, `shake`, `pose`, `rollover`, `lookaround`, `recover`. Mood
  triggers them when idle (bonded -> greet/heart; restless -> stretch/dance; tired -> sit), the
  LLM can call them via `<do>greet</do>`, and they render as a pulse + an in-character action
  line. This is the **expression layer (G2)** realized and hardware-grounded. (verified)
- **Thermal model.** Compute warms under motion and cools at rest; surfaced in her body sense and
  a Body chip; flavors her self-talk when hot. (verified)
- **Hardware-grounded self-model.** Her persona now knows her real body: twelve joints (three per
  leg), a fragile head/LiDAR she instinctively protects, wearing feet, a warm compute brain.
  (verified)

## Backlog (H-series, hardware-grounded)

- **H1** fuller gesture set + mood->delivery *timing* (Disney-mode overlap of motion/sound/light).
- **H2** fall-state + `recover` get-up + **`damping` as the controlled-stop failsafe primitive**
  (ties the security S1 failsafe to a real Go2 mode).
- **H3** thermal-aware behavior: throttle speed / seek rest when hot (close the loop, not just
  display it).
- **H4** joint + feet wear and self-protection: protect the head on falls, don't yank the
  weak-link leg, report a worn-foot.
- **H5** beacon-follow vs vision-follow as distinct modes.
- **H6** dry-run / "rehearse" a plan in the sim before executing it on the real body (the Blockly
  simulator idea; also a safety win).
- **H7** attachment actions (robotic-arm pick/place) via the attachment ports.

## IRL pipeline (how the layers compose)

Low-level locomotion = an **RL policy trained in Isaac Sim/Gym on the Unitree Go2 URDF** (reward
functions, massively parallel, sim2real). On top sits the **LLM planner + personality** (GrowBot
notes) emitting goals and gestures; between them and the world sits the **SafetyGuard + damping
failsafe** in the fast loop, plus the **local-first data boundary** (security notes). The three
mined threads now line up: a learned fast body, a slow smart planner, and a hard safety/privacy
gate the language layer can't cross.
