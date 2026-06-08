# Sweetie-bot — Proof-of-Concept Roadmap

**Short-term goal.** A small **browser-based Perchance generator** running Sweetie as an
autonomous companion roaming a 2-D map, in real time. The user can talk to her, interact,
and assign tasks/goals; she paths around the map and behaves with personality. This is a
**proof-of-concept for pathing and personality**, built deliberately *before* buying the
(expensive) Unitree Go2 hardware, to de-risk the two things hardware won't fix on its own:
does she *navigate* believably, and does she *feel* like someone.

## Architecture stance

- **The Perchance generator IS the app** for the PoC: one process, in the browser, with a
  free built-in LLM (`aiTextPlugin`, DeepSeek), 10 GB storage, image generation, and the
  Weld Skybridge available if we later want to swap in a stronger keyed model. No Python
  server, no localhost bridge.
- **The Python repo stays the source of truth for the eventual IRL build.** The generator
  is a *parallel implementation of the same architecture*, not a replacement. The two are
  reconciled by keeping module boundaries identical (world / nav / avoidance / mood /
  cognition) so logic and lessons port both ways.
- **The reconciling abstraction is the cognition-backend seam** (see backlog C-seam):
  `Anthropic` for IRL, `aiTextPlugin` for the PoC, a deterministic `Mock` for tests — all
  behind one `complete(system, history, tools)` interface.
- **"The LLM is the planner" still holds.** Everything below that decides *how to walk*
  (A\*, smoothing, avoidance) or supplies *context* (mood, memory) sits **under** the LLM,
  which still decides *what to do and where to go*. Nothing here is a competing planner.

## PyScript decision — assessed, **not** for the Perchance PoC

We evaluated running the actual Python repo in the browser via PyScript/Pyodide
(`offline_2026.3.1`). Verdict: **it hinders the Perchance PoC; keep it as a possible later
track for a self-hosted hi-fi sim.** Rationale, from the official docs + Perchance's sandbox
constraints:

- **No `crossOriginIsolated` in the Perchance sandbox** (`SharedArrayBuffer` unavailable).
  PyScript strongly prefers Pyodide in a *worker*, but sync worker↔main comms need
  `SharedArrayBuffer` + `Atomics`, which need COOP/COEP isolation — which Perchance can't
  give us. That leaves main-thread Pyodide (freezes the UI during compute) or async-only
  worker comms (awkward for a real-time loop).
- **Startup cost.** Pyodide core is ~6.4 MB and 4–5 s to initialize on first load — a
  multi-second freeze before the PoC even starts, every cold load.
- **Runtime cost.** Pyodide runs ~3–5× slower than native Python. Fine for our light
  per-tick math, but no headroom to waste.
- **Perchance template-parser collision.** The HTML panel parser intercepts `{word}` and
  `[word]` patterns in the raw source *before* JS runs — and Python is saturated with `[...]`
  indexing and `{...}` literals. Inline Python would be mangled; we'd be forced to load all
  Python from external files, adding hosting + MIME/CORS complexity the offline bundle
  expects you to serve yourself (which perchance.org won't host for us).
- **Net:** for a PoC whose entire point is fast iteration on pathing + personality, PyScript
  spends our time fighting the platform. The logic we need (world, nav, avoidance, mood) is
  small and ports to JS cleanly.
- **Where PyScript could still earn a place (later):** a *self-hosted* desktop/dev harness
  (served with COOP/COEP, workers + SAB enabled) that runs the **unmodified Python repo** for
  higher-fidelity sim testing — preserving single-source-of-truth and skipping the JS port
  for the serious sim. That's a parallel track, not the browser PoC.

---

## Pathing roadmap (Sim **and** IRL)

The local avoidance reflex we already shipped is *local* and stalls at walls — not enough for
a goal-driven roamer. The fix is a three-layer stack, which is also the decomposition the
real Go2 uses (so adding it makes the sim **more** IRL-faithful, not less — the Go2's onboard
nav already paths around obstacles, so today's straight-line sim is *less* capable than the
hardware it models).

1. **Global route — grid A\*** over an occupancy grid of the solid obstacles (inflated by the
   robot radius), producing a waypoint list to the LLM's chosen destination. Locomotion, not
   cognition — "the LLM is the planner" intact. *[PoC slice: building now]*
2. **Smooth execution — line-of-sight string-pulling + Reynolds steering** (backlog C5;
   MAX_FORCE tied to the Go2's ~2 rad/s yaw) so paths read as natural arcs, not grid steps.
   *[PoC slice: string-pulling now; full Reynolds later]*
3. **Local reflex — tangent-steering avoidance** for *dynamic* obstacles the global plan
   didn't know about (a wandering pet, the user's avatar). **Done** (`core/avoidance.py`);
   ports to the PoC. IRL this is the layer that handles people moving.

Additions, all Sim + IRL:

- **Predictive dynamic avoidance** — velocity-aware lead-prediction on moving entities (the
  Float-Knights target-lead idea) so "follow me" and dodging a walking person work. Static-
  only avoidance looks robotic against motion.
- **Stall recovery** — when forward progress flatlines for N ticks (the documented local-
  stall case), back up and wall-follow or pick a nearby free cell instead of freezing.
  Cheap, and exactly what real nav stacks do.
- **Terrain cost (IRL-leaning)** — `obstacle=False` terrain (slopes, gravel) becomes
  *passable-but-costly* in the A\* cost layer, not free. This is where the sim starts teaching
  us about the real robot (slopes slow it; stairs need a gait change).

---

## Personality roadmap (Sim **and** IRL)

Today personality = LLM + system prompt + memory. The missing ingredient is an internal
state that gives roaming and voice a *why*.

- **Needs/mood engine** — a small, pure, deterministic, unit-testable state vector (energy,
  bond, curiosity, restlessness; 0–100) that decays/regenerates with time and interaction
  (spirit of `pet-engine.js`). It (a) biases **which autonomy triggers fire** (low bond →
  comes to find you; high curiosity + idle → explores; low energy → settles at the charger),
  (b) **colors the LLM's voice** via a mood line in the system prompt, and (c) gives roaming
  *intent* instead of random waypoints. Planner *context*, not a competing planner →
  ROADMAP-safe. Identical Sim and IRL. *[PoC slice: building now]*
- **Intrinsic goals** — the mood engine proposes candidate goals ("curious about that new
  object", "haven't checked on you in a while"); the LLM picks and voices them. (This is
  backlog B4, finally with a driver.)
- **Expression layer** — mood → movement style + posture (excited = faster/bouncier, tired =
  slower/lower) plus proactive `speak`. Sim: sprite animation + bubbles. IRL: Go2
  posture/gesture commands + TTS. Design once, render twice.
- **Latency-graceful reflexes (critical for IRL)** — the LLM is slow and Sweetie is moving;
  she must never freeze waiting on a token. Fast mood-driven reflexive expression + idle
  behaviors run **under** the slow LLM-driven speech — same "reflexes under the planner"
  philosophy as the avoidance work. We should fake LLM latency in the sim so personality
  design accounts for it from day one.
- **Memory continuity** — hierarchical summarization + the memory-extraction prompt pattern
  so Sweetie remembers the user across sessions ("last time you had me patrol the kitchen").
  Personality continuity *is* remembered shared history. Text summaries, not vectors →
  ROADMAP-safe.

---

## Carried-over backlog (from the mining passes)

- **C-seam. Pluggable cognition backend + deterministic mock.** Extract
  `complete(system, history, tools)` behind `Cognition`; `Anthropic` / `Mock` / `aiTextPlugin`
  implementations. Validated by `weld.agent`'s own scripted-reasoner fallback. Foundation for
  the PoC and for keyless offline tests. **High priority.**
- **A1 / G1 / S2. Perception + tracked-entity working memory.** **Done (PoC).** She now sees you
  and the pet through a forward **camera FOV cone** (half-angle ~57 deg, ~5.5 m) with **line-of-
  sight occlusion** — step behind her or behind the sofa and she loses sight. A tracked-entity
  store keeps a **last-known position with a 12 s TTL** and decaying trust, so she remembers where
  you were when she can't see you (A1, the Float-Knights target-memory pattern; G1 per-entity).
  Behaviour follows: seek/follow head to your **last-known** spot (not your true position), and on
  arriving without a sighting she **turns to look** to reacquire (S2 turn-to-look), giving up a
  search after a few seconds ("where did you go?"). Her body sense reports the difference ("I can
  see you" vs "I last saw you ~6 s ago near the kitchen" vs "I've lost track of you"); the map
  draws the FOV cone + a "last seen" ghost marker; HUD shows see/saw/lost. (`canSee`/`trackTick`/
  `perceivedPos`, 18 tests green.) IRL: maps to LiDAR-360 presence vs camera-cone recognition and
  real occlusion.
- **A2. Explicit decision-priority cascade / energy-aware goal arbiter.** **Done (PoC).** Fixes
  the "seeks a goal, ignores low battery" bug. Battery now drains by activity (idle ~0.16/s vs
  moving up to ~1.5/s), so distance and task duration cost real charge. Every candidate goal
  (rest / seek / explore / wander) is scored as value minus travel cost, and a hard
  RETURN-TO-HOME reserve preempts ANY goal — including a user-assigned one, with a spoken
  heads-up — the moment remaining charge is only just enough to reach the charger (distance-aware
  `energyToCharger()` x margin, with a floor). Goals are tagged user vs auto; the arbiter freely
  swaps its own auto goals when idle but only overrides a user task for the critical RTH case.
  HUD shows home-cost + a "return NOW" flag. (`arbiterTick`/`chooseAction`/`needsCharge`,
  17 tests green.) IRL: same reserve logic guards the real Go2's 32-cell pack; charger pose is a
  known dock.
- **B3. Structured episode trace** for richer post-session summaries.
- **C6. Local obstacle avoidance.** **Done** — `core/avoidance.py`, tangent-steering reflex.
- **Bugfix — "stalls, slows to a stop, refuses to move" (Reset/Wipe didn't help).** **Done.** Root
  cause: the SafetyGuard scaled speed *omnidirectionally*, so anything inside her stop radius (a
  wall corner, the pet, you) throttled her to zero **in every direction** — she couldn't even drive
  away from the thing pinning her, and since stall-recovery only fired while she was moving, nothing
  rescued her; Reset re-spawned her (and could re-pin) without clearing transient flags. Fixes:
  (1) **direction-aware safety** — only brake for entities ahead in the path of travel, tapered by
  how directly ahead; things behind the heading never freeze her (retreat always allowed) while the
  "never drive into things" guarantee holds; (2) **seek/follow proximity-arrival** — she counts as
  "with you" at a sociable ~1 m instead of trying to reach your exact spot (which the soft-stop made
  impossible, deadlocking seek); follow now holds facing you; (3) a safety-pin now counts as a stall
  (re-plans out), follow gives up a lost search instead of spinning forever, and **Reset clears all
  transient state** (scan/RTH/gesture/dwell/timers/track) and unpins positions. Verified by a
  multi-scenario frame-loop simulation (longest-stuck dropped from ~28 s to normal idle dwell;
  user-on-top clears in 0.6 s; low-battery now recharges instead of dying at 0) + 11 behaviour/
  regression tests.
- **Improvement 1. Autonomy orchestrator with urgency-tiered triggering.** **Done** —
  `cognition/autonomy.py`.

---

## Milestones

- **M-PoC-0 (now): roaming + goals + mood vertical slice.** Standalone HTML (environment-
  agnostic JS): canvas map with obstacles + labeled regions; Sweetie roams via A\* +
  string-pulling + local avoidance; mood engine drives idle roaming and goal selection; a
  goal/chat box with a stubbed command parser (the seam where `aiTextPlugin` slots in);
  HUD with mood bars, state, and an event log. Runs in the browser; ports to Perchance by
  swapping the stubbed parser for `aiTextPlugin`.
- **M-PoC-1: Perchance port. — DONE.** DSL + HTML-panel generator with `aiTextPlugin`
  through the cognition seam, scripted fallback, non-blocking, parser-safe.
- **M-PoC-2: personality + selfhood depth. — largely DONE (this pass).** Added a **physical
  sense of self** (proprioception module: room, motion, battery, nearest-thing-and-bearing,
  proximity of you/pet — fed to the brain each turn and shown in a Body readout; maps to Go2
  pose/range/battery/contacts); **persistent memory** (IndexedDB facts + episodes + rolling
  summary that survives reloads, injected into context, with greet-on-return continuity and
  a "remember that …" command); **imagination** (`text-to-image-plugin` idle daydreams +
  on-request/`<image>`-tag illustrated replies); and a **real streaming ai-chat** (persona,
  history, bracket-free wire format, memory injection, summarization). **Still ahead:**
  intrinsic-goal proposals voiced by the LLM, the expression layer (mood → posture/gesture,
  IRL Go2 mapping), auto memory-fact extraction, deeper latency-graceful reflexes.
- **M-PoC-3: pathing depth.** Predictive dynamic avoidance **(DONE — velocity-lead: steers
  around where the pet will be, not where it is)**, stall recovery (basic version shipped),
  terrain cost (todo); moving entities (pet shipped; user avatar is movable).

Mined from the GrowBot video ("I Gave ChatGPT a Body"), see docs/growbot-video-mining.md:
- **DONE this pass:** brain trace (inner `<think>` voice in its own card), dream consolidation
  at the charger (folds memory -> cleaner facts + a narrated dream), predictive velocity-lead
  avoidance, felt-sensation surfaced in body sense.
- **Backlog (G-series):** G1 per-entity memory profiles (DONE - tracked-entity store, see A1/G1/S2); G2 expression layer / "Disney mode"
  (mood -> posture/gesture/light + animation-principle timing); G3 tiered models in the seam
  (fast turn model vs smart dream model — Gemini Flash vs Claude Sonnet IRL); G4 skill/strategy
  memory (remember what worked, reuse it); G5 reinforcement from praise/scolding -> durable
  preference; G6 richer rolling sensor-stream feeling. North star: the System-1/2 split with a
  learned fast "physical imagination" (cerebellum / world model) under the LLM planner.

Mined from the security video ("Robot Dogs Are A Security Nightmare"), see
docs/security-video-mining.md:
- **DONE this pass:** non-bypassable SafetyGuard (proximity-scaled speed, extra clearance for
  living things, blind-zone speed cap) gating all motion; injection-resistant dispatch (tool
  whitelist + refuse/count any "disable safety" attempt, never executed); privacy controls
  (local-only memory, Export/Wipe, "forget that ..." command, no-A/V statement); Safety &
  privacy HUD. Core principle: the language layer can never talk its way past the safety gate
  or the data boundary.
- **Backlog (S-series):** S1 failsafe-on-anomaly (controlled stop, not thrash); S2 sensor-coverage / turn-to-look (DONE - camera FOV + occlusion + turn-to-look reacquire, see A1/G1/S2); S3 human-in-the-loop for
  consequential actions; S4 egress allowlist + a fully local/offline model backend; S5 network
  isolation / no self-propagation surface; S6 data minimization + retention, per-entity consent.
- **IRL Go2 posture:** treat stock firmware/networking as untrusted (documented backdoor) ->
  separate compute module, isolated VLAN, audited/blocked egress, local model preferred; safety
  in the fast control loop and firmware-adjacent code, not the LLM; defined physical failsafe +
  E-stop; privacy by construction (no persistent A/V, owner-controlled on-device memory).

Mined from the Go2 hardware subtitles (teardown + product overview + sim2real RL talk), see
docs/go2-hardware-mining.md:
- **DONE this pass:** expression/gesture vocabulary mapped to the real Go2 trick set (greet,
  heart, dance, stretch, sit, shake, pose, rollover, lookaround, recover) -- mood-triggered when
  idle + LLM-callable via <do>...</do> + rendered as a pulse; a thermal model (compute warms with
  motion, cools at rest) surfaced in her body sense; and a hardware-grounded self-model (twelve
  joints/3-per-leg, fragile head+LiDAR she protects, wearing feet, warm compute brain).
- **Backlog (H-series):** H1 fuller gestures + mood->delivery timing (Disney overlap); H2
  fall-state + get-up + damping as the controlled-stop failsafe (ties security S1); H3
  thermal-aware behavior (throttle/seek-rest when hot); H4 joint+feet wear and self-protection;
  H5 beacon-follow vs vision-follow modes; H6 dry-run/"rehearse" a plan in sim before executing
  (Blockly-simulator idea, also a safety win); H7 attachment/robotic-arm actions.
- **IRL low-level layer:** locomotion = an RL policy trained in Isaac Sim/Gym on the Unitree Go2
  URDF (reward functions, massively parallel, sim2real) -- the System-1 fast layer under the LLM
  planner. The three mined threads compose: a learned fast body, a slow smart planner, and a hard
  safety/privacy gate the language layer can't cross.
- **M-IRL-0 (later, gated on hardware):** reconcile lessons back into the Python repo;
  RealBridge capability negotiation (Skybridge-style graceful degradation).

Mined from the decompiled Unitree Go app APK (`com.unitree.doggo2`), see docs/unitree-app-mining.md:
- **Confirms the real comms model:** local WiFi **UDP + multicast -> DDS/RTPS** (manifest requests
  `CHANGE_WIFI_MULTICAST_STATE`, ships a `TestUdpActivity`; assets reference dds/udp/rtps/.proto),
  plus **BLE** (`lib_ble`) for pairing/remote and OTA firmware. Matches the public `unitree_sdk2`
  (CycloneDDS). Telemetry/control surface from the app's diagnostic screens = `LowState` (12 motors
  incl. **temperature**) + `BmsState` (battery) + IMU + sport-mode API -> exactly Sweetie's body /
  energy / thermal models. Stock app is cloud-connected + hardened (baiduprotect/aliyun/iFlytek/Baidu)
  -> reinforces "treat firmware + stock app as untrusted; isolated VLAN; audited egress".
- **Validates the design:** the app embeds a **Three.js + ammo physics + Go2-GLB simulator with a
  Blockly "program the robot" UI** + a **LiDAR SLAM voxel map** + an ffmpeg FPV pipeline -- i.e. a
  sim-first, program-then-run loop, exactly Sweetie's approach (and the AgentWeb JS->native bridge IS
  the RealBridge seam: keep the JS brain, put DDS behind a thin native bridge).
- **New backlog from the app:**
  - **R1. RealBridge seam (concrete).** `drive(vx,vy,vyaw)->Move`, `gesture(name)->sport primitive`,
    `recover()/damp()->RecoveryStand/Damp` (fast loop, never the LLM), `state()<-LowState/BmsState/IMU`,
    `lidar()/camera()<-L1 + stream`. Mock for tests, `unitree_sdk2_python` for IRL. **High priority,
    buildable now (against the public SDK).**
  - **P-SLAM. Build the occupancy grid from LiDAR SLAM** (voxel map) instead of a hand-authored grid;
    A*/smoothing/avoidance ride unchanged on top.
  - **V3D. Optional 3D view** using the repo's reusable `Go2.glb` / `charge.glb` / `environment.glb`
    assets (real robot + charger dock + room) -- a richer rehearse-in-sim surface (ties H6).
