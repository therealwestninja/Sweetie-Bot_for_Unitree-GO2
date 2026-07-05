# Sweetie-bot — Research Notes & Lessons

A living record of what we've learned from outside sources and from our own bugs, so it doesn't evaporate
between sessions. Engineering *decisions* live in code + tests; the brain-wide roadmap lives in the
auto-memory (`browser-sweetie.md`). This doc is the **field notebook**: where samples live, what external
repos are worth mining, and the hard-won lessons that aren't obvious from the diff.

Last updated: 2026-07-04.

---

## 1. Where the samples live

| Location | What's there |
|----------|--------------|
| `D:\Claude\_my_samples\` | The general sample/mining pile (arxiv PDFs, WebGPU LLM experiments, prior mines — see the `samples-mining-*` memories). |
| `D:\Claude\_my_samples\new\` | **Microsoft/GitHub repos** cloned for evaluation (see §2): `onnxruntime-genai-main`, `Sico-main`, `simplechat-main`. |
| `C:\Users\Fish\Documents\GitHub\` | Sibling repos we draw on: `float-knights` (steering/pathing/collision), `Chloe-bot` + `my-girl` (idle/agency engine), `Sweetie-Bot_for_Unitree-GO2` (the legacy 338-test Python companion). |
| `D:\Claude\brain\` | The spiking brain (Izhikevich substrate + neuromodulation + memory). Imported *by reference* — no vendored copy. |
| `D:\Claude\sweetie-bot\browser-sweetie\` | This project. |

---

## 2. External repos worth mining (Microsoft, all MIT)

Mined 2026-07 from `D:\Claude\_my_samples\new\`.

### onnxruntime-genai — **HIGH relevance** ⭐
- **What:** Microsoft's on-device *generative* LLM runtime on top of ONNX Runtime — tokenization, KV-cache,
  sampling, beam search, **grammar-constrained decoding** (tool calls), multi-LoRA. Runs Phi-3 / Llama /
  Mistral / Qwen / Whisper. APIs: C++/Python/C#/Java. Backends: CUDA, DirectML, OpenVINO, QNN (Qualcomm),
  **WebGPU (in progress)**.
- **Why it matters to us:**
  - **The Jetson-Orin "mouth."** Run an int4-quantized Phi-3-mini natively instead of (or beside) Ollama on
    the robot compute module. Token-by-token streaming maps straight onto our mouth's `onChunk` contract.
  - **Eventual browser mouth.** If the WebGPU path matures, browser-sweetie could serve a small model
    *client-side* — zero server, aligned with the zero-build thesis.
  - Grammar-constrained decode ↔ our motor tool-call routing (`/decide` sidecar).
- **Next action:** evaluate Phi-3-mini int4 as the Jetson mouth; watch the WebGPU build workflow.

### Sico — MEDIUM relevance (pattern donor, not a dependency)
- **What:** Microsoft agentic-BPO "digital workers" platform. Go backend + Python core + React front, gRPC,
  Redis/Kafka/MySQL/Qdrant, Kubernetes. Heavy microservice stack.
- **Mine, don't adopt:**
  - **Reverse-gRPC callback** pattern (Core ↔ Backend) — a model for syncing an off-robot brain (Jetson +
    laptop control loop) with the on-robot body.
  - **Mem0-style memory abstraction** — a structured backend to unify our facts + summaries later.
  - **Task-runtime state machine** — replayable, auditable cognition logs for supervisor oversight.
- **Do NOT adopt** the K8s/microservice infrastructure — against our single-process, zero-build grain.

### simplechat — MEDIUM relevance (pattern donor)
- **What:** Enterprise RAG chat (Flask + Azure Cosmos/Search/Doc-Intelligence/OpenAI + Semantic Kernel).
- **Mine, don't adopt:**
  - **Content-type-aware chunking + hybrid (semantic + BM25) retrieval** — useful for grounding vision/scene
    observations against learned facts.
  - **SSE streaming** and **plugin-validation** patterns for a growing tool ecosystem (vision/TTS/arm).
- **Do NOT adopt** the Azure services or Flask/Jinja stack — offline-first, vanilla-JS here.

**Bottom line:** ONNX-GenAI is the real get (on-device mouth + eventual WebGPU browser inference). The other
two donate patterns (memory abstraction, reverse-RPC, chunking) — not code we pull in.

---

## 3. Engineering lessons (hard-won, non-obvious)

### 3.1 The "memory grows over ~3 min" bug was TWO leaks; live heap-profiling found the bigger one
- **Symptom:** heap climbed steadily over ~3 min live (Reflex, no Ollama).
- **Leak A — psyche rumination bred memories (the exponential one).** `psyche.ruminate()` re-lived a wound by
  calling `experience()`, which **stored a new charged memory**. That memory was itself charged + unresolved →
  re-lived next pass → stored again → bred without bound. `memories[]` had no cap; `tick()` only *decayed*
  salience, never removed. Fixes (`psyche.js`): rumination relives with `record:false` (mints nothing); hard
  `MEM_CAP=64` + `pruneMemories()`; `tick()` drops faded (<0.02) memories; `restore()` **replaces** not appends
  (it runs every rebuild → was duplicating the whole store — a second, slower leak).
- **Leak B — the word-game lexicon grew UNBOUNDED (the dominant one, found by profiling).** The meta-word-game
  mints a fresh token whenever a word flops (~16 bots each cycling a new word every ~8 ticks). The code deleted
  flops from `pending` but **never removed them from the lexicon or from every bot's gossip store** — the design
  comment says "losers are abandoned" but the code didn't actually abandon them. Live: **2534 lexicon entries**
  and **7158 belief-holdings** after 18k ticks, still climbing. Fixes: `language.js` flop path now calls
  `rumors.remove(t)` (mine the replacement FIRST so it doesn't re-pick the freed token, THEN retire the loser);
  `rumors.remove()` deletes the lexicon entry + `gossip.forget(id)` erases the belief from every bot;
  `LEX_CAP=50` backstop evicts the oldest non-official word.
- **VERIFIED live in Chrome (heap profiling, the reason to use Claude-Chrome):**
  | metric @ 18k ticks | before | after |
  |---|---|---|
  | lexicon | 2534 (unbounded) | **50 (capped)** |
  | belief-holdings | 7158 & climbing | **716 & decelerating** |
  | run time (18k ticks) | 14,402 ms | **548 ms** (26× faster) |
  | heap | ~50 MB @18k | **4.3 MB @58k** |
  At 40k ticks memories pin at exactly **1024 = 16×64** (dead flat); lexicon flat at 50; heap settled ~4 MB.
- **Lessons:** (1) In a system where "memories/words persist by design," any path that *feeds a stored item back
  in* can breed — audit re-entrant `experience()`/coin writes. (2) A store that only decays is unbounded —
  always pair decay/mint with eviction. (3) **Profile the live heap, don't trust the tight-loop number** — the
  50 MB reading was inflated by deferred GC; the reliable signal was the object *counts*. (4) A comment claiming
  cleanup ("losers are abandoned") is not cleanup — grep for the actual `delete`/`remove`.
- **False lead:** a per-bot gossip belief cap that evicts by fidelity destroyed first-hand fidelity-1 beliefs
  (they tie at 1) → broke booth fairness. Reverted; the fix belonged at the *source* (retire flops), not a cap.

### 3.2 The "one loud voice wins 100%" megaphone bug
- Broadcasting the winner's stance at **`fidelity:1`** was a guaranteed sweep — it overrode openness/conviction.
- Fix: a resistible `megaphoneInfluence` (0.55). The message is still *heard* exactly (gossip fidelity 1); the
  *opinion shift* is persuasion, filtered by each bot's openness + prior conviction.
- **Subtlety:** a blank-slate bot still adopts fully — "the first thing heard is adopted" is correct society
  behavior. Softened influence only bites against an *existing* conviction. (Tests must seed an opposing prior
  to observe resistance.)

### 3.3 Physical resources need a slot + travel + a personal cooldown, not just a global one
- The megaphone is now a **physical soapbox zone** (1 slot): `pick()` a speaker → walk them there → `fireWith()`
  on arrival → **personal temp-ban** on top of the global cooldown so no one monopolises it. A walker is flagged
  `onMic` so booth/homophily/volition don't divert it; a watchdog aborts an unreachable trip.
- This mirrors the booth and charger — the town's recurring pattern is **contended physical resources with a
  lifecycle**, which is exactly the robot-runtime problem (one body, one voice, fair arbitration).

### 3.4 Day/night dormancy is the *rationing* lever for a big cast
- The mouth (one serialized Ollama slot, ~1 utterance / 2–4 s) caps "lively" bots at ~12–20 regardless of
  population. A `clock.js` phase machine + chronotypes puts ~⅔ of the cast asleep at home (holding mood/grudges),
  so a 16–30 roster stays within the voice budget. Dormancy is *default-off* (eternal day) so tests are unchanged.

### 3.5 The framing that keeps us honest
This sim is **not** "just a routing/networking problem." Who-hears-what (gossip → society → megaphone) is the
solved sub-layer. The recurring *bugs* — the leak, the monopoly, charger starvation, dormancy — are
**scheduling, lifecycle, and state-ownership** problems: one serialized mouth, contended physical resources,
bounded memory, graceful degradation. That's an **embodied-agent runtime**, and it's the same hard core the
real Go2 must solve. The town is the rehearsal rig for the robot's runtime.

---

## 4. Environment gotchas (this machine)
- **Preview renderer keeps crashing to `chrome-error://`** most sessions. Logic is verified by the vitest suite
  (Node); live render is the flaky surface. Claude-Chrome MCP (user has it installed) is the fallback for live
  verification + heap profiling.
- **Stale module cache:** the no-cache dev server (`serve-nocache.py`, port 8018, serves the `D:\Claude` root)
  can still serve a stale build; when in doubt restart the preview server and cache-bust the URL (`?v=…`).
- Ollama browser CORS needs `OLLAMA_ORIGINS=*`; "thinking" models (gemma4 etc.) need `think:false` or `content`
  comes back empty.

---

### 3.6 Streaming the mouth: the win is early-stop, not the typing effect
- Ollama `stream:true` returns NDJSON (one JSON/line, `{message:{content}, done}`). A reader chunk can hold a
  partial trailing line, so buffer across pushes (`makeNdjson`).
- Streaming *alone* only improves perceived latency. The real lever is **early-stop**: cut the generation at a
  sentence boundary instead of running to `num_predict`. The mouth is one serialized slot — freeing it sooner
  raises utterances/min *and* generates fewer tokens (gentler on Ollama).
- Keep it model-agnostic: the pure logic (NDJSON framing, early-stop, delta extraction, `pumpStream` with an
  injectable `read()`) lives in `textStream.js` and is Node-tested; only the `fetch`+reader is browser. Because
  the streaming backend has the same `{generate}` shape (now with optional `onChunk`/`signal`), the Ollama and a
  future Perchance mouth are **drop-in swappable** — the same `onChunk({textChunk, fullTextSoFar})` contract.
- **Latent-bug pattern found here:** a *summoned* actor (booth/soapbox) walking to a zone is NOT protected by
  excluding that zone from migration — it isn't there yet. Flag it while travelling (`onMic`, `atBooth`) so
  homophily/volition don't divert it. Audit every summon-then-travel for this.

### 3.7 The recurring bug class: a new state-flag not respected *everywhere*
Every time we add a flag that means "this bot is owned by subsystem X right now" (`charge`, `asleep`, `onMic`,
`atBooth`, `quest`), EVERY other subsystem that can move/claim a bot must learn to skip it — and we keep missing
one. The booth-diversion bug (homophily/volition), then the Watch (move-along AND patrol), then the charger
(enqueuing a mic-bound bot). **When you add an ownership flag, grep every `sendTo`/`sendToPoint`/migration/enqueue
site and add the skip.** A parallel-agent review found the Watch + charger misses in one pass — cheap insurance
for a fast-built codebase.

Also: **a comment claiming cleanup is not cleanup** (booth "the caller sends freed off" had no `finally`; language
"losers are abandoned" didn't `remove()`). And **any `async` method holding a lock/phase needs `try/finally`** — a
throw from an LLM hook must not wedge the booth/soapbox. When reviewing, verify claims against the code: several
"bugs" flagged by reviewers were deliberate designs (bounded-[0,1] certainty; abort-via-reader.cancel).

## 5. Open threads (see auto-memory `browser-sweetie.md` for the full roadmap)
- **F — Code-review pass: DONE.** 3-agent review → fixed the Watch/charger owner-flag misses, the booth & soapbox
  throw-wedges, and the gossip opinion/fact/broadcast belief leak; bounded firstSeen/witnessed; +regression tests.
- **B — Streaming mouth: DONE** (`textStream.js` + `ollamaStreamBackend`, early-stop, typing bubble, Perchance-
  shaped `onChunk`; live-verified). Optional follow-on: stream the lobby lines too (the callback is generic).
- **C — Interaction depth: DONE.** Lobby is now a multi-turn debate (positions drift per turn, the dominant voice
  wins over the arc, early-bail on common ground); confront/reconcile are two-sided (an olive branch can be
  *rebuffed*, a confrontation *defused* — the target's disposition decides). Tuned so a neutral target reproduces
  the old one-shot behavior. **Env note:** gemma4 intermittently returns empty content on *follow-up* conversational
  turns (first prompt lands, replies-to-X less so, even with `think:false`) → live multi-turn debates often show
  just the opener. Model quirk, not the mechanics (Node-tested). Try qwen3.6 for multi-turn; strip a leading
  self-name prefix the model sometimes echoes ("Name: Name: …").
- **D — Spatial:** Watch as a literal moving body w/ right-of-way; pathing heatmap; movable lobbies.
- **E — Robot/Go2:** on-device ONNX-GenAI mouth; ROS2 node loop; unitree_sdk2/Nav2 swap.
- **F — Code-review pass** over the ~45 fast-built modules.
