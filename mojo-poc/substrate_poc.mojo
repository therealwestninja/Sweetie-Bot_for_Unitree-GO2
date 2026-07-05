# Sweetie-bot Phase-1 substrate PoC — a faithful Mojo port of the RookAI spiking substrate core
# (rng → neuron → synapse → delayQueue → network → region → connectome → codec), NOISE-FREE and
# deterministic. Skips STDP + neuromodulation (that's Phase 2). Mirrors the JS reference at
# D:\Claude\brain\src\*.js exactly, so the same seed + input reproduces the same spikes/action.
#
# GOLDEN (from oracle.mjs, seed=1, SMALL sizes, 30 ticks, noiseStd=0):
#   neurons=170  synapses=1160
#   memory=1.0  -> RESPOND       (rate 6.2894, 156 total spikes)
#   sensory=1.0 -> REFLEX_REPLY  (rate 0.592,   85 total spikes)
#   threat=1.0  -> ESCALATE      (rate 2.2921,  33 total spikes)
#
# Run (on a machine with Mojo/magic):  magic run mojo substrate_poc.mojo
# NOTE: authored against the JS reference; not yet executed on a Mojo toolchain (none on the dev box).

from time import perf_counter_ns
from math import sqrt, cos, log
from collections import List

# ---------------------------------------------------------------- RNG (mulberry32, exact JS port) ---
# JS: Math.imul is a 32-bit truncating multiply; `>>>` is a logical (unsigned) shift; `|0`/`>>>0` keep
# values in uint32. UInt32 arithmetic in Mojo wraps mod 2^32, matching the JS bit patterns exactly.
struct Rng(Copyable, Movable):
    var s: UInt32

    fn __init__(out self, seed: UInt32):
        self.s = seed

    fn next(mut self) -> Float64:
        self.s = self.s + 0x6d2b79f5
        var t: UInt32 = (self.s ^ (self.s >> 15)) * (1 | self.s)
        t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t
        var r: UInt32 = (t ^ (t >> 14))
        return Float64(r) / 4294967296.0

# ---------------------------------------------------------------- Network (neurons + synapses) ------
# Izhikevich neuron params by type. RS = excitatory (regular spiking), FS = inhibitory (fast spiking).
alias RS_A = 0.02
alias RS_B = 0.2
alias RS_C = -65.0
alias RS_D = 8.0
alias FS_A = 0.1
alias FS_B = 0.2
alias FS_C = -65.0
alias FS_D = 2.0
alias MAX_DELAY = 20

struct Network:
    # neurons as parallel flat arrays (the life-gridv2 flat-buffer style)
    var na: List[Float64]
    var nb: List[Float64]
    var nc: List[Float64]
    var nd: List[Float64]
    var nv: List[Float64]
    var nu: List[Float64]
    # synapses as parallel arrays
    var s_target: List[Int]
    var s_weight: List[Float64]
    var s_delay: List[Int]
    # outgoing adjacency: outgoing[i] = synapse indices from neuron i
    var outgoing: List[List[Int]]
    # delay ring buffer: slot -> pending (target, amount)
    var ring_target: List[List[Int]]
    var ring_amount: List[List[Float64]]
    var head: Int

    fn __init__(out self):
        self.na = List[Float64]()
        self.nb = List[Float64]()
        self.nc = List[Float64]()
        self.nd = List[Float64]()
        self.nv = List[Float64]()
        self.nu = List[Float64]()
        self.s_target = List[Int]()
        self.s_weight = List[Float64]()
        self.s_delay = List[Int]()
        self.outgoing = List[List[Int]]()
        self.ring_target = List[List[Int]]()
        self.ring_amount = List[List[Float64]]()
        self.head = 0
        for _ in range(MAX_DELAY + 1):
            self.ring_target.append(List[Int]())
            self.ring_amount.append(List[Float64]())

    fn neuron_count(self) -> Int:
        return len(self.na)

    fn synapse_count(self) -> Int:
        return len(self.s_target)

    # add an RS (exc=True) or FS neuron; returns its id
    fn add_neuron(mut self, exc: Bool) -> Int:
        if exc:
            self.na.append(RS_A); self.nb.append(RS_B); self.nc.append(RS_C); self.nd.append(RS_D)
        else:
            self.na.append(FS_A); self.nb.append(FS_B); self.nc.append(FS_C); self.nd.append(FS_D)
        var b = self.nb[len(self.nb) - 1]
        self.nv.append(-65.0)
        self.nu.append(b * -65.0)
        self.outgoing.append(List[Int]())
        return len(self.na) - 1

    fn connect(mut self, source: Int, target: Int, weight: Float64, delay: Int):
        var idx = len(self.s_target)
        self.s_target.append(target)
        self.s_weight.append(weight)
        self.s_delay.append(delay)
        self.outgoing[source].append(idx)

    fn schedule(mut self, target: Int, delay: Int, amount: Float64):
        var d = delay
        if d < 1: d = 1
        if d > MAX_DELAY: d = MAX_DELAY
        var idx = (self.head + d) % (MAX_DELAY + 1)
        self.ring_target[idx].append(target)
        self.ring_amount[idx].append(amount)

    # One Izhikevich half-step pair; returns True on spike (mirrors neuron.step, dt=1).
    fn step(mut self, i: Int, I: Float64) -> Bool:
        var v = self.nv[i]
        var u = self.nu[i]
        v += 0.5 * (0.04 * v * v + 5.0 * v + 140.0 - u + I)
        v += 0.5 * (0.04 * v * v + 5.0 * v + 140.0 - u + I)
        u += self.na[i] * (self.nb[i] * v - u)
        if v >= 30.0:
            self.nv[i] = self.nc[i]
            self.nu[i] = u + self.nd[i]
            return True
        self.nv[i] = v
        self.nu[i] = u
        return False

    # Advance one ms with a persistent external drive vector. Returns the spiked ids this tick.
    # noiseStd=0 -> no RNG in the tick (fully deterministic).
    fn tick(mut self, drive: List[Float64]) -> List[Int]:
        var n = self.neuron_count()
        var I = List[Float64]()
        for k in range(n): I.append(drive[k])
        # deliver synaptic currents due now
        self.head = (self.head + 1) % (MAX_DELAY + 1)
        var due_t = self.ring_target[self.head]
        var due_a = self.ring_amount[self.head]
        for j in range(len(due_t)):
            I[due_t[j]] += due_a[j]
        self.ring_target[self.head] = List[Int]()
        self.ring_amount[self.head] = List[Float64]()
        # integrate + collect spikes
        var spiked = List[Int]()
        for i in range(n):
            if self.step(i, I[i]):
                spiked.append(i)
        # relay spikes onto outgoing synapses (scheduled with delay)
        for si in range(len(spiked)):
            var src = spiked[si]
            for oi in range(len(self.outgoing[src])):
                var sIdx = self.outgoing[src][oi]
                self.schedule(self.s_target[sIdx], self.s_delay[sIdx], self.s_weight[sIdx])
        return spiked

# ---------------------------------------------------------------- Region + Connectome (the genome) --
# Mirror makeRegion: add `size` neurons (first nExc are RS/excitatory), then sparse recurrence with the
# sign of the SOURCE type — drawing rng ONLY for src != dst pairs (matching the JS `continue` before draw).
fn add_region(mut net: Network, mut rng: Rng, size: Int, recurrence: Float64,
              exc_w: Float64, inh_w: Float64) -> List[Int]:
    var start = net.neuron_count()
    var n_exc = Int(round(Float64(size) * 0.8))
    var ids = List[Int]()
    for i in range(size):
        ids.append(net.add_neuron(i < n_exc))
    for a in range(size):
        for b in range(size):
            if a == b:
                continue
            if rng.next() < recurrence:
                var src = ids[a]
                var is_exc = (src - start) < n_exc
                var w = exc_w if is_exc else -inh_w
                net.connect(src, ids[b], w, 1)
    # return [start, n_exc, ...ids] packed: we return ids; caller derives exc via index < n_exc
    return ids

# Excitatory directed projection (mirror driveTo): draw rng for EVERY (s,d) pair, in src-outer order.
fn drive_to(mut net: Network, mut rng: Rng, src_ids: List[Int], dst_ids: List[Int],
            prob: Float64, weight: Float64, delay: Int):
    for si in range(len(src_ids)):
        for di in range(len(dst_ids)):
            if rng.next() < prob:
                net.connect(src_ids[si], dst_ids[di], weight, delay)

# slice helper: ids[lo:hi]
fn slice_ids(ids: List[Int], lo: Int, hi: Int) -> List[Int]:
    var out = List[Int]()
    for i in range(lo, hi):
        out.append(ids[i])
    return out

# ---------------------------------------------------------------- main -------------------------------
fn build_and_run(channel: String, value: Float64, ticks: Int) -> (Int, Int, Int, String, Float64):
    var net = Network()
    var rng = Rng(1 * 7 + 1)  # wiring rng = seed*7+1 = 8 (matches organism.js)

    # SMALL sizes: sensory 30, memory 20, association 60, salience 30, decision 30
    var sensory = add_region(net, rng, 30, 0.02, 8.0, 12.0)
    var memory = add_region(net, rng, 20, 0.02, 8.0, 12.0)
    var association = add_region(net, rng, 60, 0.08, 8.0, 12.0)
    var salience = add_region(net, rng, 30, 0.04, 8.0, 12.0)
    var decision = add_region(net, rng, 30, 0.05, 8.0, 12.0)

    # excitatory subsets (first 0.8*size of each region)
    var sensory_exc = slice_ids(sensory, 0, 24)
    var association_exc = slice_ids(association, 0, 48)
    var salience_exc = slice_ids(salience, 0, 24)
    var decision_exc = slice_ids(decision, 0, 24)

    # reward = first half of salience_exc (12), threat = second half (12)
    var reward = slice_ids(salience_exc, 0, 12)
    var threat = slice_ids(salience_exc, 12, 24)

    # actions carved from decision_exc (24): per=6. RESPOND/ESCALATE/REFLEX_REPLY/HOLD
    var a_respond = slice_ids(decision_exc, 0, 6)
    var a_escalate = slice_ids(decision_exc, 6, 12)
    var a_reflex = slice_ids(decision_exc, 12, 18)
    var a_hold = slice_ids(decision_exc, 18, 24)

    # input pathways (exact order + params from connectome.js)
    drive_to(net, rng, sensory_exc, reward, 0.30, 9.0, 1)
    drive_to(net, rng, sensory_exc, association, 0.06, 3.0, 2)
    drive_to(net, rng, memory_exc(memory), association, 0.35, 8.0, 1)
    # receptive fields
    drive_to(net, rng, reward, a_reflex, 0.55, 8.0, 1)
    drive_to(net, rng, association_exc, a_respond, 0.62, 9.0, 2)
    drive_to(net, rng, threat, a_escalate, 0.70, 9.0, 1)
    drive_to(net, rng, salience_exc, a_hold, 0.08, 4.0, 1)

    # ---- inject the requested channel (driveScale = 12) ----
    var n = net.neuron_count()
    var drive = List[Float64]()
    for _ in range(n): drive.append(0.0)
    var chan = channel_ids(channel, sensory, memory, reward, threat)
    for ci in range(len(chan)):
        drive[chan[ci]] = value * 12.0

    # ---- run + observe (codec rate coding, decay 0.9) ----
    var rate_respond = 0.0
    var rate_escalate = 0.0
    var rate_reflex = 0.0
    var rate_hold = 0.0
    var total_spikes = 0
    for _ in range(ticks):
        var spiked = net.tick(drive)
        total_spikes += len(spiked)
        rate_respond *= 0.9; rate_escalate *= 0.9; rate_reflex *= 0.9; rate_hold *= 0.9
        for si in range(len(spiked)):
            var id = spiked[si]
            if in_list(a_respond, id): rate_respond += 1.0
            elif in_list(a_escalate, id): rate_escalate += 1.0
            elif in_list(a_reflex, id): rate_reflex += 1.0
            elif in_list(a_hold, id): rate_hold += 1.0

    # ---- winner-take-all (quietFloor 0.5) ----
    var top = -1.0
    var second = 0.0
    var top_name = String("QUIET")
    var pairs_n = List[String]()
    pairs_n.append("RESPOND"); pairs_n.append("ESCALATE"); pairs_n.append("REFLEX_REPLY"); pairs_n.append("HOLD")
    var pairs_v = List[Float64]()
    pairs_v.append(rate_respond); pairs_v.append(rate_escalate); pairs_v.append(rate_reflex); pairs_v.append(rate_hold)
    for pi in range(4):
        var v = pairs_v[pi]
        if v > top:
            second = top; top = v; top_name = pairs_n[pi]
        elif v > second:
            second = v
    var action = String("QUIET")
    var confidence = 0.0
    if top >= 0.5:
        action = top_name
        confidence = (top - second) / top if top > 0.0 else 0.0
    return (net.neuron_count(), net.synapse_count(), total_spikes, action, confidence)

# memory excitatory subset (first 16 of the 20 memory ids)
fn memory_exc(memory: List[Int]) -> List[Int]:
    return slice_ids(memory, 0, 16)

fn in_list(ids: List[Int], id: Int) -> Bool:
    for i in range(len(ids)):
        if ids[i] == id: return True
    return False

fn channel_ids(channel: String, sensory: List[Int], memory: List[Int],
               reward: List[Int], threat: List[Int]) -> List[Int]:
    if channel == "sensory": return sensory
    if channel == "memory": return memory
    if channel == "reward": return reward
    if channel == "threat": return threat
    return List[Int]()

fn round(x: Float64) -> Int:
    return Int(x + 0.5)

fn main():
    print("Sweetie-bot substrate PoC (Mojo) — deterministic, noise-free\n")
    var cases_c = List[String]()
    cases_c.append("memory"); cases_c.append("sensory"); cases_c.append("threat")
    for ci in range(3):
        var r = build_and_run(cases_c[ci], 1.0, 30)
        print(cases_c[ci], "-> neurons:", r[0], " synapses:", r[1],
              " spikes:", r[2], " action:", r[3], " conf:", r[4])

    # benchmark: perf_counter_ns, warmup + N iterations (life/benchmark.mojo pattern)
    print("\nbenchmark (memory tick loop, 30 ticks/iter):")
    for _ in range(3):  # warmup
        var _w = build_and_run("memory", 1.0, 30)
    var iters = 200
    var t0 = perf_counter_ns()
    for _ in range(iters):
        var _b = build_and_run("memory", 1.0, 30)
    var t1 = perf_counter_ns()
    var per = Float64(t1 - t0) / Float64(iters)
    print("  build+30-tick:", per / 1000.0, "us/iter  (", per / 30000.0, "us/tick)")
