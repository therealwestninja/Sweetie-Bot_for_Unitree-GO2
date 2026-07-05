# Browser Sweetie — architecture & build roadmap

A single-page, zero-build browser reimplementation of the legacy Sweetie companion (`../Legacy_Sweetie-Bot`),
with the **new JS spiking brain** (`D:\Claude\brain`) as cognition instead of the legacy's Claude-tool-loop.
This is the **embodiment test-platform** — "Rook for a robot body" — runnable today, no hardware, no Mojo.
Derived from a 4-agent study of the legacy (body / world+perception / dashboard / cognition).

## Why this is the sharp move
- The legacy already **is** a complete, tested (338 tests), sim-working companion; its *body* (safety FSM,
  kinematic sim, perception, dashboard) is gold and **ports 1:1 to JS** (pure logic/geometry — the agents
  confirmed almost none is Python-specific).
- The new brain already **is** the cognition core (512 tests) with declarativeStore, personhood, safety veto,
  volition, and the memory/safety upgrades built this session.
- The browser is the seam where they meet with zero external deps — and it **validates the brain-as-robot-
  cognition thesis** in something we can watch move.

## The architecture — 4 swapped singletons around the brain
The legacy is FastAPI(server) + WebSocket(browser). We drop the server: an **in-browser bus + sim tick loop**
feed the *unchanged* UI. Four singletons get browser equivalents; the **telemetry frame is the one seam**.

```
  ┌─────────────────────── UI (ported VERBATIM from legacy teleop/) ───────────────────────┐
  │  SVG top-down map · goal strip · chat (autonomy/supervisor variants) · override panel   │
  │  (joystick/E-STOP/arm) · memory panel (pending tray) · session bar · stat strip         │
  └───────────────▲ telemetry frames ────────────────────────── commands ▼─────────────────┘
                  │                                                        │
  ┌───────────────┴──────────────── BUS (emit/command) ────────────────────┴────────────────┐
  │  SIM (world+bridge+perception, 20Hz)   SAFETY (FSM chokepoint)   MEMORY (store+approval)  │
  │            │  proximity/vision/events           ▲ guard()                ▲ pending/approved │
  │            ▼                                     │                        │                 │
  │  ┌──────────────────────────── BRAIN (D:\Claude\brain, vendored JS) ─────────────────────┐ │
  │  │  perceive (features from sim) → organism.tick → readAction (the ARC router):          │ │
  │  │    REFLEX_REPLY / QUIET / HOLD  → handled ONBOARD (no LLM): reflex speech, halt, wait  │ │
  │  │    RESPOND / ESCALATE          → escalate to the MOUTH (Perchance/local LLM), which    │ │
  │  │                                   does deliberate MOTOR tool-calls via the motor codec │ │
  │  │  memory = declarativeStore · goals = volition · affect = neuromodulation · veto=safety │ │
  │  └───────────────────────────────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

### The central design truth (from the reconciliation study)
The brain's actions are **dialogue modes, not robot verbs** — so cognition is a genuine **two-layer split**
(exactly the legacy roadmap's ⏳ "fast onboard policy in front of Claude"):
- **Onboard reflex/routing layer = the brain's winner-take-all router.** Decides the *arc* every tick.
  `REFLEX_REPLY`/`QUIET`/`HOLD` resolve **locally, no LLM** (the metabolism/load-shedding already in `mind.js`
  is the cost governor). This is where reflexive **speak** and hard **halt** live.
- **Offboard deliberate layer = the LLM mouth**, reached only on `RESPOND`/`ESCALATE`, which then does the
  spatial/semantic **motor tool-calls** (look_at/go_to_pose/stand/gesture…) through a new motor codec +
  `safety.check()` physical envelope.

### Tool mapping (legacy 12 → new homes)
| onboard (brain) | offboard (LLM mouth, RESPOND-arc, via safety) | native brain faculty |
|---|---|---|
| `speak` (reflex/respond text), `halt` (reflex) | `look_at`, `set_body_height`, `stand_up`, `sit_down`, `gesture`, `go_to_pose`, `follow_path` | `set_goal`→**volition**, `remember`→**declarativeStore**, `report_status`→**feature injection** |

### Three genuinely-NEW builds (do not exist yet — flagged honestly)
1. **Supervisor-approval gate on memory.** `declarativeStore.addFact` writes immediately; the legacy's
   "supervisor approves what I write to long-term memory" invariant needs a **pending→approved status** on
   top. Reuse the NM2a `stateRole` mechanism: model-proposed facts land `"pending"`; `recall` serves only
   `"current"` until the supervisor approves. (W3)
2. **Idle/autonomy driver.** The brain is **turn-driven** — there is no idle ticker inside it. Port the
   legacy `Autonomy` loop (idle ticker + bus-event gate + two-tier cooldown/lock) as a browser driver that
   fires synthetic `[idle]` turns into `mind.respond()`; volition supplies the *content* of initiative. (W4)
3. **Motor codec + host tool-dispatch.** RESPOND-arc LLM tool-calls must reach the bridge through
   `safety.check()`; the brain's 4 WTA actions are dialogue modes, so a small host-side dispatcher maps
   LLM tool-calls → bridge commands → safety envelope. (W2)

## Build order — walking-skeleton first
Body modules are pure logic → **built + unit-tested in Node** (like the brain) before any DOM.

- **W0 — Body core (Node-tested, no UI) — DONE (2026-07-03).** Ported `mathutil.js`, `safety.js` (FSM +
  guard + proximity scaling), `bridge.js` (kinematic integrate + nav/look-at + commands), `world.js`
  (objects/regions/scenes + reactive cat/person + proximity), `perception.js` (FOV cone + occlusion + events),
  `bus.js`. **41 vitest tests across 6 files**, incl. an integration test proving the DoD: an armed robot
  drives under the guard, proximity scales it near obstacles, the cat flees as it approaches (closed
  sensorimotor loop), perception events flow onto the bus. Run: `npm test` (reuses the brain's vitest via
  `--root`). Scenes so far: apartment (cat+person), street, obstacle-sparse/medium/dense, studio; more in W5.
- **W1 — UI shell + manual drive — DONE (2026-07-03).** `index.html` (single file, zero-build): imports the W0
  `src/*` modules as ES modules, composes them via `simLoop.js` (the telemetry/command seam — 8 vitest tests),
  and renders each frame into an SVG map (grid, labelled furniture, robot triangle + rotating FOV cone, the
  reactive cat/person as live dynamic markers). A 50 Hz `setInterval` drives `sim.step()`; a drag joystick maps
  vertical→vx / horizontal→vyaw and pushes `move` commands (implicit heartbeat), with Arm/Stand/Sit/E-STOP/clear
  buttons and spacebar E-STOP. **DoD met, verified live in the preview** (python `http.server` on :8017, launch
  cfg `browser-sweetie`): world renders; manual drive advances the pose and the **smart-assist proximity
  slowdown scales velocity down near furniture** (0.77 m ahead → vx 1.0→0.69); **E-STOP latches from `moving`,
  zeroes velocity, disarms**; clear recovers to idle/down. Serve for HTTP (ES-module imports need it, not
  `file://`); a dev-only `window.__sweetie` handle exposes `{sim, armed, cmd, drive()}` for the W2 harness.
  *Full legacy-dashboard parity (memory tray, zoom/pan, override drawer) is deferred to W5 — W1 is the
  watchable skeleton.*
- **W2 — Brain in the loop + motor tools — DONE (2026-07-03).** Four Node-tested modules + browser wiring:
  - `src/sensorium.js` — the afferent nerve: telemetry+events → the brain's four channels (proximity→**threat**
    tonic + looming bonus, events→**sensory** phasic, addressed/novelty→**memory**, friendly-in-view→**reward**).
  - `src/motorCodec.js` — **new-build #3**, the efferent nerve: parses the mouth's `tool(args)` intents, routes
    each through `safety.guardAction`, calls the bridge. speak/halt are onboard (no armed-gate); look_at/go_to/
    stand/sit/gesture/body_height are armed-gated. `schema()` = the terse tool menu for the mouth prompt.
  - `src/commit.js` — commit-discipline (float-knights): arc-commit hold ≥6 ticks (instant from idle), target-
    memory TTL 25 ticks through occlusion, emergency-interrupt on a 0.45 m proximity bubble / bump.
  - `src/cognition.js` — the integrator (OFF by default): vendors the brain via `../../../brain/src/organism.js`,
    runs the two-layer split — ONBOARD (REFLEX_REPLY/HOLD/QUIET/emergency = reflex speech + halt, no LLM,
    announced only on arc TRANSITION) vs OFFBOARD (RESPOND/ESCALATE → mouth → motor codec). `converse(prompt)`
    is the supervisor turn (awaits the mouth); autonomous mouth calls are opt-in (`autoMouth`, default off) to
    stay gentle. An onboard-chatter throttle (`speechCooldown`, ~30 cycles; emergencies exempt) stops her
    narrating every arc flip when a moving entity paces across the threat/reward boundary — behavior unchanged,
    just a quieter voice log. **12 new vitest tests (suite now 59).**
  - **UI:** `index.html` gains a `🧠 brain` toggle, a mouth selector (none/ollama, num_predict-capped), a live
    **mind** readout (arc/conf/focus + threat/sensory/memory/reward drive bars), a voice/perception stream, and
    a supervisor chat box. Served from the `D:\Claude` root (:8017 `/sweetie-bot/browser-sweetie/`) so the brain
    import resolves. **DoD met, verified live:** the full spiking organism instantiates in-browser; approaching
    furniture routes threat→ESCALATE (conf 1.0) with smart-assist slowdown, then the onboard **emergency reflex
    halts her and names the obstacle** ("*freezes — couch too close!*"), no LLM; arcs don't flip-flop (commit
    hold); a supervisor `look_at(the cat)` through the mouth is safety-gated and locks attention (Node-tested;
    browser needs Ollama with `OLLAMA_ORIGINS=*`). Vendoring is by relative import (no copy) — one source of
    truth for Node + browser, whitelisted via `vitest.config.js` `server.fs.allow`.
- **W3 — Memory + approval gate — DONE (2026-07-03).** `src/memoryGate.js` (**new-build #1**) wraps the brain's
  `declarativeStore`, reusing NM2a `stateRole`: a model-proposed fact lands **`pending`** (the store's default
  `state:"current"` recall already filters it out, so it can't ground a reply), `approve(id)` flips it to
  `current`, `reject(id)` drops it, `retract(id)` → `historical` (reversible). User-authored facts skip the
  tray (trusted → `current`). `recall()` is the same hybrid recall the chat brain uses, so approved facts
  ground replies unchanged. Wired into `cognition.js`: `think()` injects approved-fact recall into the mouth
  context and captures `remember(fact)` proposals (→ pending); `cognition.remember()`/`.memory` exposed.
  **UI:** a memory panel — pending tray (✓approve/✗), approved-fact list, a "teach her" input, a pending
  badge — persisted across sessions via **IndexedDB** (`makeIndexedDbStorage`) with a zero-dep
  **`makeHashEmbedder`** (offline semantic vectors). **+5 vitest tests (suite now 64). DoD met, verified live:**
  propose→tray→approve→moves to known→**survives a full page reload** (loaded from IndexedDB); Node-tested that
  pending never grounds and an approved fact enters the next reply's context. **Bug found & fixed in-browser:**
  the store's default `genId` counter resets to 0 per session, so a fact added AFTER reload reused a persisted
  id and `update()` corrupted the wrong record (approved↔pending flip) — fixed with a collision-resistant
  `genId` (`m`+time+rand), covered by an id-collision regression test.
- **W4 — Autonomy driver — DONE (2026-07-03).** `src/idleDriver.js` (**new-build #2**) ports the Chloe/my-girl
  async-agency engine: a **self-scheduling adaptive pacer** (`defer`-injected, floor 250 / ceil 1200 ms, NOT
  setInterval), a **Jacobson/TCP-RTT idle trigger** (`silenceZ = (silentFor − avgGap)/max(gapVar, floor)`,
  idle at `z ≥ idleZ`) so idle is measured against THIS human's tempo, an **AI-cadence floor** (autonomous turns
  can't out-run the poll), a **spin-up settle guard** (observe ≥1 cycle, no fire from boot state), and
  **commit-point revalidation** (a `deferGen` epoch bumped on every input → an in-flight turn that self-
  interrupts is discarded = clean interrupt-on-input). Fully DI (clock+defer) → **6 vitest tests** with a fake
  scheduler. Wired into `cognition.js`: `idleTick({kind,roam,isCurrent})` = a synthetic `[idle]` cycle → an
  **INTERNAL thought-stream line by default** (lull/scan/checkin/revisit templates, no mouth → cheap, resolves
  QUIET), **self-limiting** (the thought depletes the dopamine that drove it), escalating to a **safety-gated
  `look_at`** only under the **driving-frame gate** (roam) + a fresh context; `seedPicker()` biases toward a
  visible companion. **UI:** a `💤 autonomy` toggle cycling off → **watch** (internal only) → **🐾 roam** (may
  look around); chat input calls `driver.notifyInput()`. **+4 tests (suite now 74). DoD met, verified live:**
  left alone she initiates ~1 thought/2–3 s on an adaptive cadence (all ARC QUIET, zero mouth); a chat turn
  drops `silenceZ` 22.7→−1.4 and snaps the poll 1200→250 ms (instant preempt); in roam+active she dispatched a
  safety-gated `look_at(the person)` (ok, attention TTL 25). *Volition standing-goal seeds fold in at W5.*
- **W5 — Parity/polish + real nav.** *In progress.* **Nav DONE (2026-07-03):**
  - `src/steering.js` — layered steering (float-knights): Reynolds seek + **per-obstacle separation** (two-tier,
    arrival-attenuated) + **holonomic** body-frame output (vx/vy/vyaw, face-travel, so she side-steps instead
    of pivoting) + **local-minimum escape** (committed perpendicular strafe, held until she's physically
    relocated past the blocker). Fixes the naive reactive field that oscillated/grazed.
  - `src/planner.js` — **A\* grid** over rasterised static-obstacle disks (8-connected octile, no corner-cut,
    line-of-sight string-pull, nearest-free fallback). `go_to_pose` plans a static route → steering executes
    each leg and dodges DYNAMIC entities. Hybrid global-plan + local-reactive.
  - **Proven on the nav harness** (`harness/run.mjs` + `actor.mjs` + `navHarness.mjs`): three environments —
    apartment / city street / **parking-lot** (new scene) — with an **Ollama-driven character** met en route
    (gemma4; her mouth is Ollama too). Reactive-only steering measured **2/3 clean** (stuck in the apartment
    cluster) → **A\*+steering = 3/3 clean, zero clipping**. `+6 tests` (nav + planner). Honest finding logged:
    pure reactive local-minimums on clutter; the planner is what makes it robust.
  - `src/mission.js` — **behaviour-mode layer** (scaffolded): patrol A/B/C · search-pattern (lawnmower/spiral)
    · follow \<actor\> · search \<thing\> · roam — all working over nav+perception (`+5 tests`,
    `harness/missions.mjs` runs the matrix); **junkyard-dog** + **sleuth** structured as Ollama-hooked stubs.
  - **Still TODO:** wire modes to volition standing-goals; the two social modes' language hooks; gestures,
    session reflection, full dashboard parity (memory tray / zoom-pan / waypoint overlay), local/Perchance mouth.

## Colony / Round-Table roadmap (multi-agent society)
Built on the colony (bots + zones + collision-free nav) + the comms layer (booth · gossip · megaphone). The
channels move messages, but nothing yet CONSUMES them — the flywheel `message → belief → opinion → alliance →
movement → message` is open. This roadmap closes it, dynamics-first (deterministic/cheap) before live/flashy.
- **C1 — Social dynamics core (deterministic, LLM-optional). ← BUILDING NOW.** Structured beliefs
  `{topic, stance∈[-1,1], confidence}`; opinion updates on receipt (weighted by fidelity × openness); **affinity
  → emergent TRIBES** (union-find over the agreement graph); **homophily movement** (bots migrate to like-minded
  lobbies → the colony physically self-sorts); **advocacy** (each bot's strongest opinion = its cause/manifesto
  seed); instrumentation (polarization, tribe count over time, rumor reach/half-life). This makes the booth /
  gossip / megaphone actually CHANGE MINDS, and gives each bot a real brain (`makeOrganism` for affect/engagement,
  the belief model for opinions).
- **C2 — Backend: generation scheduler + mouth service + record/replay. ✅ DONE (`scheduler.js` + `mouth.js`,
  7 tests).** One async PRIORITY queue serialising
  all Ollama (booth > megaphone > lobby chatter > gossip re-wording), single-in-flight per model, the physics
  loop NEVER awaits it (bodies move; mouths resolve in the background + attach when ready). One shared mouth
  service replacing the inline `fetch`es (index.html / actor.mjs / cognition.js). Record/replay log of every
  `(prompt, output, rng)` → reproducible runs. Generalises the W4 idle-driver discipline to the whole colony.
- **C3 — Live voices + watchable UI. ✅ DONE (`colonyApp.js` + `colony.html`, +3 tests, 110 total; verified
  live via eval — bots settle, gossip spreads, tribes form, booth panel + megaphone work).** Ollama flavour on the deterministic dynamics (persona intros, gossip
  re-wording, megaphone manifestos, opinion→utterance). Browser colony UI: zones + bots + live per-lobby chat,
  the **booth reply/reject panel** (you, the user oracle), a megaphone banner, tribe colouring. Playable.
- **C4 — Lobby proximity discussion.** Turn-based in-lobby dialogue (round-robin, scheduler-gated) where bots
  argue and that argument drives the C1 opinion updates — the conversation layer gossip/megaphone feed on.
- **C5 — Scenarios + polish.** Seeded set-pieces (a schism, a rumor cascade, a charismatic megaphone demagogue),
  tribe timeline viz, tuning knobs, save/replay.

## Honest scoping
This is a multi-session build. W0-W1 give a *watchable* skeleton fast; W2 is the thesis payoff (brain drives
a body); W3-W4 are the genuinely-new subsystems. Each phase is independently demoable. Determinism + a test
suite carry over from the brain's discipline. The mouth is optional per-arc (reflex arc needs no LLM), so it
runs fully offline until a RESPOND turn.

## W4-design — the idle/autonomy driver (mined from Chloe-bot + my-girl, 2026-07-03)
The user's prior projects already solved async-chat + agency + idle/spin-up. Both are the SAME engine
(`createEngine(deps)`) at two timescales — the Chloe **bot** is Discord-paced, the **my-girl solo** build is
already companion-paced (poll 100–700ms, `paceQuietZ 1.2`). We port that design, not the legacy Python loop.

**Core principle: ONE adaptive clock, activity-gated behaviors hung off it — no separate idle ticker.**
"Idle" is a *state derived from input rhythm*, not a fixed timeout. It re-weights what each tick does.

**Components to port (near-verbatim):**
1. **Self-scheduling adaptive pacer** (`computeNextDelay` + `setTimeout(tick, curDelay)`; NOT `setInterval`).
   Each tick recomputes its own next delay. Floor≈100ms / ceil≈700ms for a responsive companion. A pending
   real input snaps to floor (addressed-priority override).
2. **Rhythm-relative idle** — a Jacobson/TCP-RTT EWMA over input gaps (`avgGap` α=0.3, `gapVar` β=0.25);
   `silenceZ = (silentFor − avgGap)/max(gapVar,1000)`; **idle when `silenceZ ≥ Z` (start Z≈1.2)**. Adapts to
   *this* user's tempo — a fast user is declared idle sooner (in ms) than a slow one. This is the idle TRIGGER.
3. **AI-cadence floor** (`paceMinAIIntervalMs` + `aiPassDue`/`markRan`) — the anti-cost-multiplier: adaptive
   polling can't over-run the expensive mouth passes. Each *kind* of idle turn gets its own wall-clock floor.
   Composes with the brain's own metabolism/load-shedding (the substrate is already a cost governor).
4. **Gating ladder** — global cooldown → per-entity cooldown → single lane lock → debounce, then **commit-point
   revalidation**: after composing any idle output, re-check idle (epoch counter `deferGen`); if the user spoke,
   **discard unsent**. This IS clean interrupt-on-input — reproduce it verbatim.
5. **Spin-up settle guard** (`inProactiveSettle`) — observe ≥1 cycle before any unprompted turn; **seed schedules
   at boot, don't fire** (so nothing autonomous fires from stale persisted timestamps).
6. **Brain-latency meter + circuit breaker** (RFC 6298 `srtt+4·rttvar`, 10–90s adaptive timeout; open after 3
   fails → half-open probe) around `mind.respond()` so a stalled/looping brain trips open instead of hammering.

**Content of an unprompted turn — the seed picker + activity-gated beats:**
- **Seed priority** (what to think/act on when idle): a due *self-revisit* → a volition standing goal → a
  working topic → deepen a known entity. Drive this from the brain's own salient state (volition + declarativeStore).
- **Proactive beats**, all activity-gated (never act into a dead context; only a *recently-active-but-now-quiet*
  one): scheduled beat · **lull-filler** ("room went quiet, gently re-open") · **check-in** on a most-missed
  entity (`interactionCount*1e9 + absentMs`). Retune the Discord day-scale constants to companion seconds/minutes.
- **Self-limiting via a neuromodulator**: an idle thought DEPLETES the drive that triggered it (curiosity/
  dopamine −drop on completion) so idle activity self-paces in bursts, not runaway. Sweetie's brain already has
  the 4-chemical field for exactly this.
- **Deferred self-intent**: a spontaneous conclusion may schedule ONE future revisit (never a loop).

**The synthetic `[idle]` turn** = the "empty-author context" trick: assemble a turn with no user message +
an `idle`/`lull` hint, and call `mind.respond(syntheticTurn)`. Most such turns resolve **QUIET/REFLEX onboard
(no mouth)** by the brain's own router — cheap by construction.

**Output is INTERNAL by default; escalation is gated.** Idle `mind.respond()` results default to internal state
+ a **thought-stream** (the brain's idle spikes narrated: pipe its log lines, filter routine ticks, prettify to
first-person — "sitting with the quiet", "wondering how you're doing"; snaps to attention on the first real
thought after input). Idle turns only escalate to **speech / motor action** under an explicit gate (the legacy
"driving frame" analog) — so she thinks freely but doesn't chatter/move unprompted unless allowed.

**Wires to the brain's existing faculties** (this is why it fits): volition = seed source; neuromodulation =
the self-limiting drive; imagination/forward-sim = the "deliberate" map; declarativeStore = write-back target
(idle conclusions → facts/episodes, not speech); metabolism = the cost governor. The driver is the
**scheduler + gating + interrupt discipline** wrapping faculties the brain already has.

**DI contract (testable, no real timers):** `makeIdleDriver({ respond, act, clock:{now}, defer:(fn,ms), store,
config })` — `respond` wraps `mind.respond`, `defer` is injected (rAF/setTimeout) so it's deterministically
Node-testable exactly like the mined engine. Sources: `Chloe-bot/Tampermonkey/chloe-bridge.user.js`,
`my-girl/solo-app-html.txt` (solo constants L12051/12086–12103), memory `browser-sweetie`.

## Commit-discipline & steering (mined from Float-knights, 2026-07-03)
Float-knights is a team-combat sim whose bots are **explicitly modeled on the Unitree Go2** (FOV cone, turn
radius, pivot-in-place, vision range) — so this transfers directly. It solves the "**dither**" (per-tick
flip-flop) that a *continuous* perceive→decide→act loop is prone to. This is a **cross-cutting discipline**
that lands in **W2** (decide/attention) and **W5** (nav) — and unifies with W4's commit-window+interrupt.

**The anti-dither stack (every layer overridable by an EMERGENCY INTERRUPT):**
- **State/arc commit** — hold a chosen action-mode ≥N ticks (`botDecisionCommitFrames≈6`, ~150–250ms) before
  a competing mode can win. For the spiking substrate = **winner-take-all with a lateral-inhibition hold**:
  the active arc gets a decaying self-excitation bias so a marginally-higher competitor can't preempt it.
- **Target commit + opportunity-break** — a chosen target is held ~30 ticks unless it's invalidated or an
  urgent better one appears (kill-confirm analog).
- **Target-memory decoupled from acquisition** ⭐ — acquire only within the camera FOV cone, but **retain a
  lost-sight target for `botTargetMemoryFrames≈25` ticks** (TTL counts down only while sight is lost). This is
  the exact fix for **look-at/go-to twitch when a person steps behind furniture** — Sweetie keeps orienting to
  last-known pose instead of dropping it. Wire into `bridge.lookAtEntity`/`goToPose` + perception.
- **Heading commit (~8 ticks) + distance-bracket hysteresis (enter 0.50·ideal / exit 0.65·ideal) + turn-rate
  cap (~0.35 rad/tick)** — stops stutter-stepping at the standoff distance.
- **Hold-track drift-match**: at range, `v = unit·rangeErr·0.12 + target.velocity`, dead-band |v|<0.25 → a
  *stationary* target yields a clean rest, not idle creep.

**Emergency interrupt** (`_isEmergencyInterrupt`, port literally): (1) took a hit / bump (nociception),
(2) current goal/target invalidated, (3) a **looming obstacle inside a threat bubble** (the 90px projectile
check → a **time-to-collision** cutoff on Sweetie's proximity/depth). Maps onto the brain's graduated safety
veto + a fast subcortical **flee/avoid reflex** that preempts the committed arc. Keep a **90-tick time-cap
escape** so no retreat/avoid loop can trap her.

**Target selection = a salience map** (`_scoreFocusTarget`/`pickTarget`): a weighted sum — proximity, urgency
(novelty/low-HP → for Sweetie: newness/motion), role/class priority (person > object), **social attention**
("who's engaging me"), and recency/revenge (short-term memory bias) — with **sticky attention** (retain
current focus if ≥80% of the best score; kill-confirm override for a suddenly-urgent stimulus). Feed as
excitatory drive into an attention WTA layer; the stickiness is the same lateral-inhibition hold as the arc lock.

**Layered steering for W5 nav** (Reynolds force-truncated — smooth, turn-radius-limited, natural for a
quadruped; the code derives `MAX_FORCE` from Go2 yaw): reactive layer under the deliberative goal = two-tier
**separation** (overlap 22px + mid-range 60px, linear falloff, force ≤0.70·speed, arrival-attenuated so it
doesn't jiggle at the goal) + **wall/obstacle repulsion** (150px, ≤1.20·speed, not during a hard approach) +
**perpendicular-strafe-on-block** (18-tick local-minimum escape) + **pivot-in-place** when the turn exceeds a
threshold and the arc is blocked (Go2-legal) + **kiting brackets** (back/close/hold with hysteresis). Sweetie's
`bridge.js` already has `goToPose`/`lookAtEntity` + an avoidance hook — this is what fills that hook (upgrades
the current bare `atan2` nav).

**Team/roles — now vs. future.** *Now (single robot):* the transfer is **internal drive coordination**, not
multi-agent — competing drives (explore/socialize/self-preserve/seek-charge) converge like team focus-fire on
one shared salience target, and the `inTrouble`/`lastStand`/`pursuing` posture flags become **global mode
modifiers** (low-battery = "lastStand": suppress exploration, prioritize survival/charge; strong opportunity =
"pursuing": commit hard). The per-team "style" table = **mood/personality presets** (cautious vs. bold
thresholds) — and `chaoticRetargetEveryFrame` is a deliberate *anti*-pattern that proves removing the commit
discipline reproduces jitter. *Future (multi-Sweetie):* frontline/backline roles, rally points, drop
reservation, velocity-tagged team centroid = literal swarm primitives.

**Carry-over constants (retune to loop rate):** state-commit ≥6 ticks · target-commit ~30 · target-memory ~25
· heading-commit ~8 · bracket hysteresis 0.50/0.65 · separation force ≤0.70·speed linear-to-0 · turn cap
~0.35 rad/tick · emergency = time-to-collision cutoff. Source: `float-knights/perchance_2.txt` (AI/sim
~L20900–28200, v38.x); memory `browser-sweetie`.

## Source specs
The 4 agent port-specs (safety FSM constants/transitions, kinematic integration, world/scene schemas,
perception math, dashboard frame contract, tool surface, reconciliation) are the build reference. Legacy at
`../Legacy_Sweetie-Bot/`; brain at `D:\Claude\brain\src\`.
