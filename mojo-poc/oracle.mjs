// Substrate-only ORACLE: builds network+connectome+codec exactly as organism does (minus neuromod/
// plasticity), noise-free, and prints deterministic golden outputs the Mojo port must reproduce.
import { makeNetwork } from "../../brain/src/network.js";
import { buildConnectome } from "../../brain/src/connectome.js";
import { makeCodec } from "../../brain/src/codec.js";
import { makeRng } from "../../brain/src/rng.js";

const SMALL = { sensory: 30, memory: 20, association: 60, salience: 30, decision: 30 };
const SEED = 1, TICKS = 30;

function run(channel, value) {
  const net = makeNetwork({ seed: SEED, noiseStd: 0 });
  const conn = buildConnectome(net, makeRng(SEED * 7 + 1), { sizes: SMALL });
  const codec = makeCodec({ channels: conn.channels, actions: conn.actions });
  codec.inject(channel, value);
  const drive = codec.driveInputs();
  let totalSpikes = 0;
  for (let t = 0; t < TICKS; t++) { const s = net.tick(drive); codec.observe(s); totalSpikes += s.length; }
  const r = codec.readAction();
  return { channel, value, neurons: net.neuronCount, synapses: net.synapseCount, totalSpikes, action: r.action, confidence: +r.confidence.toFixed(6), rates: Object.fromEntries(Object.entries(r.rates).map(([k, v]) => [k, +v.toFixed(4)])) };
}

const cases = [["memory", 1.0], ["sensory", 1.0], ["threat", 1.0]];
const out = cases.map(([c, v]) => run(c, v));
const a = JSON.stringify(run("memory", 1.0)), b = JSON.stringify(run("memory", 1.0));
console.log(JSON.stringify({ seed: SEED, ticks: TICKS, sizes: SMALL, cases: out, deterministic: a === b }, null, 2));
