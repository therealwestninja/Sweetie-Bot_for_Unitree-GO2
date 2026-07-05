# Sweetie-bot Phase-1 — Mojo substrate PoC

The first embodiment step from `../Roadmap.md`: port the RookAI spiking **substrate core** to Mojo so the
real-time tick loop can run natively on the Go2's compute (Phase-0 verdict: Mojo runs on the Go2-EDU's
Jetson Orin; the CPU-only substrate is the lowest-risk part — §10 of the roadmap).

**Scope (Phase 1):** `rng → neuron → synapse → delayQueue → network → region → connectome → codec`,
**noise-free and deterministic**. STDP + neuromodulation + `organism` are Phase 2.

## Files
- **`oracle.mjs`** — the JS reference (the substrate built exactly as `organism.js` does, minus neuromod/
  plasticity). **Runs today** (Node) and prints the golden values the Mojo must reproduce.
- **`substrate_poc.mojo`** — the Mojo port. A single self-contained file (per the roadmap's Phase-1
  definition-of-done) mirroring the JS module-for-module, with the golden values embedded.

## Golden values (verified — `node oracle.mjs`, seed=1, SMALL sizes, 30 ticks, noiseStd=0)
```
neurons = 170   synapses = 1160   (deterministic: true)
memory  = 1.0  -> RESPOND       rate 6.2894   156 total spikes
sensory = 1.0  -> REFLEX_REPLY  rate 0.592     85 total spikes
threat  = 1.0  -> ESCALATE      rate 2.2921    33 total spikes
```
Three different inputs → three different actions: this is the **receptive-field genome** (a spike drives an
action) *and* determinism, proven in the reference. The Mojo port must print the same neuron/synapse counts,
the same action per channel, and (for bit-parity) the same spike counts.

## Definition of done (from the roadmap)
> a single `.mojo` file that builds a tiny network, ticks it deterministically, reads an action via the
> codec, prints a benchmark.

`substrate_poc.mojo` does exactly this: builds the 170-neuron network, injects a channel, ticks 30×,
winner-take-all reads the action, and benchmarks the build+tick loop with `perf_counter_ns` (the
`life/benchmark.mojo` warmup+N pattern).

## How to run & verify parity (on a Mojo box)
Per Phase-0, install the toolchain with `magic` on a Linux/Jetson host (not the Win11 dev box):
```bash
magic run mojo substrate_poc.mojo
```
Then check the printed `neurons / synapses / action / spikes` against the golden block above. If the RNG +
wiring order are ported correctly, **spike counts match exactly**; if only the *actions* match, the dynamics
are right but a wiring-order or RNG detail differs — diff against `oracle.mjs`.

## Parity-critical details (where a port most easily drifts)
1. **RNG = mulberry32** (`rng.js`), not an LCG. `Math.imul` = 32-bit truncating multiply; `>>>` = logical
   shift. The Mojo `Rng` uses `UInt32` (wraps mod 2³²) to match JS bit-for-bit. **The wiring RNG seed is
   `seed*7+1 = 8`** (the network's own noise RNG is never drawn because `noiseStd = 0`).
2. **Wiring order.** `add_region` draws the recurrence RNG **only for `src != dst`** pairs (the JS `continue`
   happens *before* the draw). `drive_to` draws for **every** `(src,dst)` pair, src-outer. The connectome
   calls them in the exact sequence in `connectome.js`. Any reordering changes every downstream RNG value.
3. **Float math** is `Float64` throughout (JS numbers are f64) — the two-half-step Izhikevich integration.

## Honest status
- **The oracle is verified** (runs, deterministic, golden values recorded).
- **The Mojo file is written to match the oracle by construction but has NOT been executed on a Mojo
  toolchain** — there is no Mojo/`magic` on this Win11 box (that's a Linux/Jetson install per Phase 0). First
  execution is the remaining Phase-1 step. Likely first-run fixups are Mojo-version idioms (tuple return /
  `List` APIs / `String` compare); the *algorithm and RNG/wiring order* are the load-bearing parts and are
  faithful to the reference.
- Next after a green run: **Phase 2** (add neuromodulation + gated STDP + the `organism` composition, and a
  golden bit-parity test vs the JS across a full tick sequence), then the v2/v3 SIMD optimization pass
  (`life` gridv2→v3) if the tick budget needs it.
