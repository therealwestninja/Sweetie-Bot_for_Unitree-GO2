# browser-sweetie

A zero-build, browser-native embodiment platform for the [RookAI spiking brain](../../brain). Two apps run on
one shared substrate; the brain is imported directly from `../../brain/src` (single source of truth — no
vendored copy), so it must be served from the `D:\Claude` repo root (see **Running**).

Everything is plain ES modules + vanilla JS. No bundler, no framework, no install. **306 tests** (vitest,
borrowed from the brain).

---

## The two apps

| App | File | What it is |
|-----|------|-----------|
| **Sweetie** (the hero robot) | [`index.html`](index.html) | One Unitree-Go2-style companion: drive her, watch her sense the world, turn the spiking brain on and she reacts / remembers / idles. |
| **Harmony Hollow** (the colony) | [`colony.html`](colony.html) | A town of ~9 brained bots that navigate between lobbies, gossip, form tribes, queue at a charger, visit *you* at the well, and each run their own mood. |

Both are driven by a headless, deterministic core (`makeSim` / `makeColonyApp`) with the DOM as a thin render
layer, so the logic is unit-tested and the browser only supplies timers + pixels.

---

## Layers (src/)

**Body & world** — a 1:1 JS port of the legacy Python Go2 sim; pure logic, clocks injected.
- `mathutil.js` clamp/wrapAngle · `bus.js` pub/sub · `safety.js` FSM + guard chokepoint (IDLE/ARMED/ACTIVE/ESTOP)
- `bridge.js` kinematic integrate + commands + nav · `world.js` objects/regions/scenes + reactive cat/person
- `perception.js` FOV cone + occlusion + events · `simLoop.js` composes it all → telemetry frames + commands
- `planner.js` A* grid route · `steering.js` float-knights layered steering (seek + per-obstacle separation +
  local-minimum escape, holonomic)

**Cognition** (the brain in the loop) — the "central design truth": brain actions are DIALOGUE MODES, so it's a
two-layer split (onboard reflexes, no LLM / offboard mouth for RESPOND-ESCALATE).
- `sensorium.js` telemetry+events → 4 brain channels · `motorCodec.js` LLM tool-calls → safety-gated bridge
- `commit.js` anti-dither (arc-hold + target-memory) · `cognition.js` the integrator
- `memoryGate.js` supervisor-approval memory · `idleDriver.js` adaptive-cadence autonomy · `mission.js` mode
  battery (patrol / search-pattern / follow / roam …)

**Colony / society** (src/agents/) — the multi-agent stage.
- `mover.js` per-NPC nav (planner+steering, no safety FSM) · `colony.js` shared arena + zones + bot-bot avoidance
- `society.js` opinions/affinity/tribes · `homophily.js` opinion → physical migration · `gossip.js` beliefs +
  broken-telephone relay
- `booth.js` the user embassy (multi-turn chat) · `megaphone.js` lottery global broadcast · `charger.js`
  battery + limited ports + queue + water-cooler · `watch.js` law enforcement (anti-camp/block)
- `temperament.js` a neuromodulated **brain per bot** (mood → curiosity/openness) · `scheduler.js` +
  `mouth.js` the shared, rate-limited generation queue (record/replay)
- `colonyApp.js` orchestrates all of the above into one `tick()` + `state()`

---

## Running

Served from the **repo root** so `../../brain/src` resolves (the launch config `browser-sweetie` does
`python -m http.server 8017 --directory .`):

- Hero robot: `http://localhost:8017/sweetie-bot/browser-sweetie/index.html`
- Colony: `http://localhost:8017/sweetie-bot/browser-sweetie/colony.html`

The LLM ("voices"/mouth) is optional and uses local **Ollama** (`gemma4:latest`) — needs `OLLAMA_ORIGINS=*`
for browser CORS. Everything runs fully offline without it (onboard reflexes + deterministic social mechanics;
the LLM is flavour on top). **Run in a FOREGROUND tab** — background tabs throttle `setInterval` to ~1 Hz.

## Tests & harnesses

- `npm test` (runs the brain's vitest against this root via `--root`; `vitest.config.js` whitelists `../..` so
  the sibling brain imports resolve). **306 passing.**
- `node harness/run.mjs` — nav across environments (Ollama actors) · `node harness/colony.mjs` — colony demo ·
  `harness/comms.mjs` / `society.mjs` / `missions.mjs` — subsystem demos.

## Conventions

- **Mechanics are deterministic + instant; the LLM is async flavour** layered on top (so tests are deterministic
  and the sim never blocks on the model). Randomness (motor jitter, drain jitter, gossip shuffle) is rng-gated,
  off in tests.
- `window.__sweetie` / `window.__colony` are dev-only debug handles.
- Roadmap + phase history: [`ROADMAP.md`](ROADMAP.md).
- North-star / what we're actually building (vision): [`docs/GOALPOST.md`](docs/GOALPOST.md).
- Field notebook (external repos worth mining, where the samples live, hard-won lessons): [`docs/RESEARCH-NOTES.md`](docs/RESEARCH-NOTES.md).
