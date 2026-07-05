# Sweetie-bot — Roadmap & Research Notes

> **Purpose of this file.** Durable, self-contained notes so we never re-research what we already
> learned — especially the **Mojo/MAX runtime investigation** (2026-07-01). Anyone (or future-me) should
> be able to act on this without re-reading the Modular monorepo or the brain source. Written
> 2026-07-01.

---

## 1. What Sweetie-bot is

Sweetie-bot is the **portable cognition core** for a **Unitree Go2** quadruped robot. The core is the
same digital brain built at `D:\Claude\brain` (the Izhikevich spiking substrate + neuromodulation +
governance + the P1–P7 personhood faculties).

Key framing (locked earlier):
- **Rook is the browser test-platform**; Sweetie-bot is the robot target. Same cognition core, different
  body. Rook surfaces (chat, page context) are *senses now*; robot hardware (cameras, IMU, lidar,
  actuators, mic/speaker) are *senses later*. Senses are **pluggable organs**.
- The bridge between the core and the world is the **Pilot + Sensorium** (the continuous
  perceive→decide→act loop + the organ-binding layer). A JS proof of this already exists in
  `D:\Claude\brain\src\sim\` (`world.js` 1-D corridor, `robotBrain.js` reactive sensorimotor organism,
  `pilot.js` the continuous loop) — the substrate is already proven **body-agnostic**.
- Organ transport idea on the board: **`rook-link`** — a small transport-agnostic protocol
  (line-delimited UTF-8 JSON, heartbeat + ~10s keepalive, prompt/response turns, capped events,
  device-rendered permission prompts). BLE (Nordic UART) now → the Go2's link later.

Cross-refs: brain roadmap `D:\Claude\brain\docs\plans\2026-07-01-improvement-roadmap.md` (physical /
robotics work is deliberately sequenced to the END, after the brain + personhood systems). Memories:
`rook-sweetiebot-core`, `samples-mining-2026-07`, `digital-brain-project`, `rook-ai-project`.

---

## 2. The runtime decision — **Mojo** (the headline thread)

**Question:** the brain is JS/ESM (perfect for the Rook browser test-platform), but what runs the
portable cognition core *on the robot*, where the real-time sensorimotor loop wants a fast, native,
GC-pause-free runtime?

**Answer under investigation:** **Mojo** (Modular's language — Python ergonomics, compiles to native,
targets CPU/GPU). Surfaced first by a toy `main.mojo` Markov-chain the user shared, then confirmed by
mining the full Modular SDK. This is **not a commitment** — it's the leading candidate, and the mining
below shows it's a *credible, de-risked path*, not a rewrite-the-world gamble.

**Why Mojo (not C++/Rust):** Python-family syntax (low porting friction from the JS + the robot's
Python/ROS2 world), native performance, first-class SIMD/GPU, and — critically — **it compiles to
Python-importable modules** (see §3.2), so a Mojo core drops straight into the Go2's Python stack.

---

## 3. Mojo/MAX SDK mining findings (2026-07-01)

Source mined: **`D:\Claude\_my_samples\modular-main`** = the Modular monorepo (open-source **Mojo
stdlib** + the **MAX** inference framework; Bazel-built; GPU-kernel-heavy). Large, professional
AI-infra codebase.

**Scope verdict up front:** almost none of this applies to **Rook** (JS/ESM, browser-first,
zero-runtime — you cannot ship Mojo or MAX in a Chrome extension or a Perchance pane). The value is
**entirely on the Sweetie-bot native-runtime side.** Rook's *only* optional mine is `max serve` as a
**dev-only** local embeddings/LLM backend, which conflicts with Rook's offline-first principle → keep it
opt-in, never a dependency.

### 3.1 stdlib inventory — what the language gives us for the port
`mojo/stdlib/std/` contains (relevant subset): `random` (seeded → **determinism preserved**),
`benchmark`, `testing`, `algorithm`, `gpu`, `math`, `bit`, `memory` (UnsafePointer, memcpy,
memset_zero), `complex`, `time` (`perf_counter_ns`), `simd` (via builtin), `python` (interop),
`collections` (List, Dict, Optional), `io`, `os`, `subprocess`.
→ **Our whole discipline ports natively:** seeded RNG (deterministic brain), a benchmark harness, and a
testing framework are all first-class. We do not lose determinism/validation/bench when we leave JS.

### 3.2 THE substrate-port template — `mojo/examples/life`  ⭐ highest value
A Conway's Game of Life implemented in **three progressively-optimized versions** — structurally
**identical to ticking a neuron population** (a grid `evolve()` == a network `tick()`):
- `gridv1.mojo` — naive baseline (dynamic dims).
- `gridv2.mojo` — `struct Grid[rows: Int, cols: Int]` = **comptime-parametric dimensions**; flat backing
  store `UnsafePointer[Int8]`; `memset_zero`/`memcpy`; seeded `random.seed(seed)` + `random.randint`;
  `__getitem__`/`__setitem__` over `row*cols+col`; **double-buffer** evolve (read old, write new).
- `gridv3.mojo` — vectorized/SIMD version.
- `benchmark.mojo` — times v1/v2/v3 with `perf_counter_ns` (warmup + N iterations).

**Why it matters:** this is a ready-made blueprint for porting the Izhikevich tick — comptime-sized
neuron/synapse arrays, flat buffers, seeded init, double-buffering, and the exact v1→v3 "make it fast"
progression + benchmark. Copy this shape.

### 3.3 Python interop = embeddability  ⭐ the single most important find (the de-risker)
`mojo/examples/python-interop/`:
- `person_module.mojo` — a Mojo `struct` exposed to Python via `PythonModuleBuilder` +
  `@export def PyInit_person_module() abi("C") -> PythonObject`; `add_type[Person]().def_py_init[...]`.
  → **A Mojo struct compiles to a Python-importable module.**
- `from std.python import PythonObject` + `hello_mojo.mojo` / `mandelbrot_mojo.mojo` — Mojo can also
  **call into Python**. Bidirectional.

**Consequence for the architecture:** the robot core is **"a Mojo hot-path substrate compiled to a
Python module, wrapped by Python/ROS2 glue on the Go2"** — NOT a full-stack rewrite. The fast tick loop
is Mojo; sensors/actuators/ROS2/orchestration stay Python. This is what turns "Mojo as the runtime"
from speculation into a real migration shape.

### 3.4 MAX serve = the on-device mouth + real memory embeddings
- `max serve --model <hf-model>` → an **OpenAI-compatible** local endpoint, quantized, GPU/CPU.
- `max/examples/embedding-knowledge-base/` → a reference **RAG** (embeddings + semantic search +
  clustering) via `max serve --model sentence-transformers/all-mpnet-base-v2` + a Python `kb_system`.
→ This is the **production path past the "Ollama on a laptop" stopgap**: the robot's LLM *mouth* and the
*real embeddings* for declarative memory, both served locally by MAX. Parallels Rook's
`declarativeStore` + `embedder` + hybrid recall.

### 3.5 What NOT to do (avoid the discovery-loop traps)
- **Do NOT rewrite Rook in Mojo** — wrong platform (browser/zero-runtime). Rook stays JS/ESM.
- **Do NOT pull MAX/Bazel into the JS brain repo** — keep the toolchains separate.
- **Do NOT chase GPU kernels yet** — the substrate is ~8k synapses; trivially CPU for years. SIMD on CPU
  is plenty; GPU is premature optimization.
- **Do NOT let MAX become a Rook dependency** — offline-first is a Rook principle; MAX is Sweetie-bot /
  dev-only.

---

## 4. The port target — the substrate core (~694 lines, 11 files)

The brain's **substrate** is small and highly portable. From `D:\Claude\brain\src\` (line counts):

| File | LOC | What it is | Port order |
|---|---|---|---|
| `rng.js` | 18 | seeded LCG deterministic RNG | 1 |
| `neuron.js` | 39 | Izhikevich spiking neuron (v,u,a,b,c,d; `step(I)`) | 2 |
| `synapse.js` | 13 | weighted/delayed edge `{pre,post,weight,delay}` | 3 |
| `delayQueue.js` | 24 | ring buffer for delayed spike delivery | 4 |
| `network.js` | 72 | neurons+synapses; `tick(inputs,{gain,noiseScale})`; `resetActivation` | 5 |
| `region.js` | 34 | a named neuron population/slice | 6 |
| `connectome.js` | 62 | the fixed wiring = genome (5 regions, channels, actions, receptive fields) | 7 |
| `codec.js` | 50 | population coding: `inject`, `driveInputs`, `observe`, `readAction` (WTA + quietFloor), `reset` | 8 |
| `neuromodulation.js` | 72 | 4 chemicals; setpoints/levels; `burst`/`tick`; `readout` (valence/arousal); `plasticityGate` | 9 |
| `plasticity.js` | 130 | gated STDP (traces, `observeSpikes`, `modulate`) + ledger | 10 |
| `organism.js` | 180 | composition root: `inject/tick/readAction/mood/feedback/settle/nudgeChem/serialize` | 11 |

Everything above the substrate (mind loop, memory/RAG, personhood P1–P7, reflex, backends) can stay in
Python/JS and call the Mojo `organism` — only the hot tick loop needs to be native.

---

## 5. Target architecture (on the Go2)

```
  Sensors (cam/IMU/lidar/mic)  ──┐
                                 ├─► Python/ROS2 glue (Sensorium: organ bindings, rook-link)
  Actuators / speaker  ◄─────────┘        │
                                          ├─► Mojo cognition core  (organism.tick, compiled to a
                                          │     Python-importable module — the real-time hot path)
                                          └─► MAX serve            (LLM mouth + memory embeddings,
                                                                     OpenAI-compatible, on-device)
```
- **Mojo core** = the substrate tick (native, deterministic, benchmarked).
- **Python/ROS2** = Sensorium/Pilot: reads sensors → `inject`, ticks, `readAction` → actuators; hosts
  the personhood faculties (working memory, self, volition, etc. — can stay Python) and the memory
  store.
- **MAX** = the mouth + embeddings, served locally.
- Maps onto the existing `src/sim/` PoC: `robotBrain`'s substrate → the Mojo core; `pilot`'s loop →
  Python; `world` → the real Go2 sensors.

### 5.1 Sensorium concurrency — the "Semantic Race Condition" (added 2026-07-02)

From the SDD review (`brain/docs/user-files/003.txt` §7.1). The spec frames this as *multiple users*
writing a shared workspace; the **Sweetie-bot analog is multiple ORGANS writing the brain state at
once** — vision + audio + proprioception + interoception all `inject`-ing and mutating the shared
substrate/memory concurrently on the Go2's real-time loop. Without ordering guarantees, a slow organ
operating on a stale snapshot can clobber a fast organ's update (the robot "sees" then "forgets it
saw" because a later-resolving sensor overwrote the state).

**We already own the primitive the fix needs.** The brain's **monotonic plasticity-ledger IDs +
governance snapshot marks** (`plasticity.js` `nextId`/`mark`, `governance.js` `ledgerMark`) are exactly
a **state epoch/version hash** — the basis for *Optimistic Semantic Concurrency Control (OSCC)*: each
organ's write carries the epoch it read; the Pilot rejects a write whose epoch is stale, re-reads, and
re-derives. Design the **Sensorium as a single serializing writer** (organs enqueue observations; the
Pilot applies them in tick order against the current epoch) rather than letting organs mutate the
substrate directly in parallel.

**Sequencing:** not needed for the single-writer sim PoC (turn/tick-serial already). It becomes real at
**Phase 5 (organs + hardware)** when ≥2 asynchronous sensor organs run concurrently — carry it as an
explicit design constraint on `rook-link` + the Sensorium, not a later retrofit.

---

## 6. Phased roadmap (build order when embodiment work starts)

> Sequenced AFTER the brain + personhood systems (per the master roadmap). Physical/sim work is the tail.

- **Phase 0 — feasibility — RESEARCHED 2026-07-03: conditional GO.** See §10 for the full findings.
  Headline: Mojo + MAX **do** run on the Jetson Orin (the Go2-EDU's compute), *experimentally*, installed
  via `magic`; the CPU-only substrate port is low-risk on any aarch64; a fully-supported companion-module
  fallback exists. The gate is cleared enough to proceed — with eyes open to the experimental caveats.
- **Phase 1 — Mojo substrate PoC — WRITTEN 2026-07-03 (`mojo-poc/`).** Ported `rng → neuron → synapse →
  delayQueue → network → region → connectome → codec` (noise-free, deterministic; STDP+neuromod deferred to
  Phase 2). Anchored to a **verified JS oracle** (`mojo-poc/oracle.mjs`, runs today): 170 neurons / 1160
  synapses, and `memory→RESPOND`, `sensory→REFLEX_REPLY`, `threat→ESCALATE` (three inputs → three actions =
  the receptive-field genome + determinism, proven). `substrate_poc.mojo` mirrors it module-for-module with
  golden values embedded + a `perf_counter_ns` benchmark. **REMAINING:** first execution on a Mojo toolchain
  (`magic run mojo …` on a Linux/Jetson box — none on the Win11 dev box) → confirm spike-count bit-parity vs
  the oracle. Parity-critical bits documented in `mojo-poc/README.md` (mulberry32 RNG exact port; wiring-RNG
  seed=8; the src≠dst draw-skip + drive_to order).
- **Phase 2 — full substrate parity.** Add `neuromodulation` + gated `plasticity` (STDP) + `organism`
  (settle/feedback/serialize). Golden-test against the JS reference (same seed + inputs → same spikes)
  to prove bit-parity / behavioural parity.
- **Phase 3 — Python embedding.** Expose the Mojo `organism` as a Python module (person_module pattern);
  drive it from a Python Pilot loop over the existing `sim/world` before real hardware.
- **Phase 4 — MAX mouth + memory.** Stand up `max serve` for the LLM mouth + real embeddings; wire the
  memory recall to it.
- **Phase 5 — organs + hardware.** rook-link transport; real Go2 sensors/actuators; interoception
  (battery/state → chemistry); spatial memory; safety-veto organ; voice (mic/speaker). **Concurrency
  constraint (§5.1):** ≥2 async organs → Sensorium as single serializing writer + OSCC epoch checks on
  organ writes (reuse the ledger/snapshot epoch). Design in, don't retrofit.

**Definition of done for the PoC (Phase 1):** a single `.mojo` file that builds a tiny network, ticks
it deterministically, reads an action via the codec, prints a benchmark — mirroring `main.mojo`'s
train→loop shape but running the real substrate primitive.

---

## 7. Discipline that carries over (don't lose it in the port)
- **Determinism** — seeded RNG everywhere; same seed+inputs → same output (Mojo `random.seed`).
- **Validation** — the ablation harness proves claims; port the key claims as Mojo tests.
- **Benchmarks** — `perf_counter_ns` warmup+N pattern from `life/benchmark.mojo`; track tick latency as
  the real-time budget.
- **Governance** — the plasticity ledger / snapshot / factory-reset story should survive (serialize).

---

## 8. Quick reference (commands, paths, patterns)
- Modular repo (mined): `D:\Claude\_my_samples\modular-main` (`mojo/` = language+stdlib, `max/` = engine).
- Substrate template: `mojo/examples/life/{gridv1,gridv2,gridv3,benchmark}.mojo`.
- Python interop: `mojo/examples/python-interop/{person_module,hello_mojo,mandelbrot_mojo}.mojo`.
- Mojo→Python module: `PythonModuleBuilder` + `@export def PyInit_<name>() abi("C") -> PythonObject`.
- Python→Mojo: `from std.python import PythonObject`; `String(py=...)`, `Int(py=...)`.
- Local model serving: `max serve --model <hf-model>` (OpenAI-compatible); RAG ref:
  `max/examples/embedding-knowledge-base/`.
- stdlib to lean on: `std.{random, benchmark, testing, math, memory, simd, algorithm, time, python}`.
- The brain substrate to port: `D:\Claude\brain\src\{rng,neuron,synapse,delayQueue,network,region,
  connectome,codec,neuromodulation,plasticity,organism}.js` (~694 LOC).
- The JS sensorimotor PoC to mirror: `D:\Claude\brain\src\sim\{world,robotBrain,pilot}.js`.

---

## 8b. Research-mined additions (2026-07-02)

From the 7-agent mine of `D:\Claude\_my_samples\` (see `brain/docs/plans/2026-07-02-research-mined-roadmap.md`
Track B + memory `samples-mining-arxiv-2026-07`). All sequenced to the embodiment tail, after the brain track:

- **SB-RM1 Embodied.cpp multi-rate runtime contract** (`02501`) ⭐ — a five-layer pluggable-organ split
  (input adapters → sequence builders → backbone → head plugins → deployment adapters) + **multi-rate
  execution** (perception/backbone/action heads at different Hz, latency-first batch-1). Adopt as the **Mojo
  runtime skeleton** (§3.2/§5) and make the perceive→decide→act loop MULTI-RATE, not one synchronous tick.
  Folds into Phase 1 (substrate PoC) + Phase 3 (Python/runtime embedding).
- **SB-RM2 TAP task-agnostic motor pretraining** (`02466`) — motor/procedural layer from cheap unlabeled
  robot "play" via self-supervised inverse dynamics (zero teleop), grounded by thin task language. Phase 3-5.
- **SB-RM3 imagination-trust gates: WorldSample PPL + ACID** (`02431`, `02403`) — sample-scheduling gate +
  inverse-dynamics realizability gate on the decide stage / forward simulation. Robot-learning phase.
- **SB-RM4 VisionAId offline vision organs** (`02371`) — quantized ONNX depth/seg/embeddings + few-shot
  personal-object registration; instance retrieval → associative memory. Phase 5 (hardware-gated).
- **SB-RM5 hardware-enforced semantic coordination** (`02376`) — safety veto + motor-authorization in a
  deterministic tier BENEATH adaptive cognition (real-time failures are coordination, not reasoning). The
  brain's V4 behavioral-veto split realized on the Go2. Design early, verify on hardware (relates to §5.1).
- **SB-RM6 VT-WAM contact-gated attention** (`02503`) — gate foot-force/tactile organ weight by a contact
  signal (tactile dominates only during contact). Neuromodulation pattern for pluggable force organs.
- **SB-RM7 selective sound localization organ** (`02343`) — top-down goal steers which sound to localize.
  Hardware-gated auditory organ.

---

## 10. Phase-0 feasibility findings (RESEARCHED 2026-07-03)

Desk research (no Go2 on hand). Answers the gating question: **can Mojo + MAX run on the Go2's compute?**
Verdict: **conditional GO** — the substrate port is low-risk; the GPU/LLM pieces are experimental-but-real.

### 10.1 What compute the Go2 actually has
- **Go2 EDU / EDU-Plus** (the research/dev tier): 8-core CPU **+ an NVIDIA Jetson Orin module** — Orin **NX
  16GB (~100 TOPS)** on EDU-Plus, Orin **Nano** on the standard EDU docking station. Ampere GPU, **CUDA
  sm_87**, Tegra (unified CPU/GPU memory).
- **Consumer Go2 (AIR / PRO):** 8-core ARM CPU, **no Jetson**. The Jetson is an EDU-tier feature/module.
- Implication: the Mojo/MAX target is the **EDU's Jetson Orin** — OR a companion module we carry (§10.4).
- The Go2's **low-level locomotion is Unitree's own RL policy** (Isaac-Sim-trained, sim2real); we do NOT
  replace it — Sweetie rides on top via the SDK (SportClient). Matches the legacy's declined "custom RL".

### 10.2 Mojo + MAX on Jetson Orin — EXPERIMENTAL but real (2026)
- **It works, experimentally.** MAX **nightlies** support GPU programming on Jetson Orin; install with
  **`magic`** (Modular's installer). **Verified on a Jetson Orin Nano 8GB** — builds + runs custom ops and
  GPU function examples, CPU *and* GPU Mojo code. (This supersedes an OLD "closed as not planned" issue that
  was about the *older Xavier*, not Orin.)
- **Known blocker:** **bfloat16 models fail to build/run on Orin Nano** (the ARM-CPU-+-NVIDIA-GPU combo) —
  "being worked on." → the MAX-serve **LLM mouth must use fp16 / int8 / q4 weights, NOT bf16** (a real
  constraint on §3.4). Quantized models are the norm on-device anyway, so this is a config constraint, not
  a wall.
- **GPU-kernel maturity is young:** a hand-written NMS kernel crashed — but it *also* crashed on an RTX 4060,
  i.e. it was a Mojo `Layout` API misuse, **not** a Jetson-specific fault. Mildly reassuring.

### 10.3 The key disaggregation — risk is NOT uniform across phases
Split the port by what actually needs the GPU/MAX:
- **Cognition SUBSTRATE (Phases 1-2 — the Izhikevich tick, ~8k synapses): LOWEST RISK.** It's tiny, CPU-only,
  no GPU, no MAX. Plain CPU Mojo on aarch64 — the part with the *most* support. Runs on the EDU Jetson's
  Arm cores, on the consumer Go2's 8-core CPU, or any companion aarch64/x86. **This is the part the roadmap
  actually wants to port, and it's the safest.**
- **MAX mouth + embeddings (Phase 4): MEDIUM RISK.** Needs MAX-GPU on the Orin → experimental + bf16-blocked
  → use quantized models; expect nightly churn. Or offload the mouth to a companion module (§10.4).
- So the roadmap's Phase-1 PoC is **de-risked**: it's CPU Mojo, the best-supported path. The experimental
  caveats only bite the *mouth*, which is sequenced later (Phase 4) and has a fallback.

### 10.4 The escape hatch — companion compute module (already our stated architecture)
Our own security/poc docs (`Legacy_Sweetie-Bot/docs/poc-roadmap.md`, `security-video-mining.md`) already
recommend a **separate companion compute module on an isolated VLAN, local model preferred**. If Sweetie
carries her own compute instead of using the EDU Jetson:
- **x86 mini-PC + NVIDIA GPU:** Mojo x86-64 + MAX-GPU are **fully supported (not experimental)** — sidesteps
  every Jetson caveat (incl. bf16). Cost: weight/power/an extra module.
- **Jetson Orin dev kit as companion:** same experimental status as the EDU onboard.
- **CPU-only companion (any aarch64/x86 SBC):** runs the substrate + a small CPU mouth; no GPU risk at all.
This makes the whole plan **hardware-agnostic**: nothing forces us onto the experimental Jetson-GPU path.

### 10.5 Phase-0 recommendation
1. **Proceed with Phase 1 (Mojo substrate PoC) — it's CPU-only and the best-supported path.** Don't wait on
   the GPU/MAX questions; they don't gate the substrate.
2. **Pin toolchain to `magic` + a dated MAX nightly** (experimental = moving target; record the exact
   version for reproducibility — matches our determinism discipline §7).
3. **Defer the MAX-GPU mouth (Phase 4) decision** until Phase 1-3 prove the core; when we get there, choose
   EDU-Jetson-MAX (quantized, no bf16) vs a companion module vs a CPU/remote mouth.
4. **Buy target: Go2-EDU (Orin NX 16GB)** if going onboard; else spec a companion module. Either way the
   substrate port is identical.

**Sources:** [Modular forum — Experimental GPU support on Jetson Orin](https://forum.modular.com/t/experimental-gpu-support-on-nvidia-jetson-orin-devices/1184) · [Modular forum — Mojo on Jetson Orin](https://forum.modular.com/t/mojo-on-jetson-orin/1657) · [modular/modular#923 (old Xavier, not-planned)](https://github.com/modular/modular/issues/923) · [Go2-EDU Plus 100 TOPS / Jetson Orin NX](https://robostore.com/products/go2-edu-plus-100-tops-computing-quadruped-robot-dog) · [Go2 EDU buyer's guide (Orin NX/Nano)](https://www.k-robotic.com/blogs/product-support/unitree-go2-buyer-guide) · [CUDA sm_87 for Orin (CUDA-for-Tegra)](https://docs.nvidia.com/cuda/cuda-for-tegra-appnote/).

---

## 9. TL;DR
The Modular SDK doesn't hand Sweetie-bot *features* — it hands it a **credible native runtime (Mojo) and
a concrete migration shape**: port the ~694-line substrate using the `life` pattern, compile it to a
Python module (python-interop), wrap it in Python/ROS2 on the Go2, and serve the mouth + memory with
MAX. Rook stays JS. Nothing here is built yet; Phase 0 feasibility gates the rest.
