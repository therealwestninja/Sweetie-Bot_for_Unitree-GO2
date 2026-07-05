// Cognition — the layer that puts the spiking brain in the sensorimotor loop. OFF BY DEFAULT: the body
// (simLoop) runs fine without it; the UI opts in. This is the W2 thesis payoff and the reconciliation of the
// "central design truth": the brain's winner-take-all actions are DIALOGUE MODES, so cognition is a two-layer
// split —
//   ONBOARD  (REFLEX_REPLY / HOLD / QUIET / emergency): resolved locally, NO LLM — reflex speech + safety
//            reflexes. This is what lets her react to the world fully offline, cheaply, every cycle.
//   OFFBOARD (RESPOND / ESCALATE): the LLM mouth speaks AND may emit motor intents, which the motor codec
//            routes through safety to the body. One in-flight mouth call at a time (gentle on the mouth).
// Commit-discipline wraps the raw router so the continuous loop doesn't twitch (see commit.js).
import { makeOrganism } from "../../../brain/src/organism.js";
import { makeSensorium } from "./sensorium.js";
import { makeCommitController } from "./commit.js";
import { makeMotorCodec } from "./motorCodec.js";

const DEFAULT_PERSONA = {
  name: "Sweetie",
  system: "You are Sweetie, a small, affectionate robotic dog. Curious, gentle, a little playful. Keep spoken lines to one short sentence, in character.",
};

// Onboard reflex utterances — templated, no LLM. Keyed by arc; t = a salient target name if any. The
// RESPOND/ESCALATE lines are the OFFLINE degrade (no mouth): a wordless gesture in place of a spoken reply.
const REFLEX_LINE = {
  REFLEX_REPLY: (t) => (t ? `*perks up at ${strip(t)}*` : "*ears twitch, alert*"),
  RESPOND:      (t) => (t ? `*tilts head, considering the ${strip(t)}*` : "*tilts head, thinking*"),
  ESCALATE:     (t) => (t ? `*tenses, wary of the ${strip(t)}*` : "*tenses, alert*"),
  HOLD:         () => "*waits, watching*",
  EMERGENCY:    (t) => (t ? `*freezes — ${strip(t)} too close!*` : "*freezes — too close!*"),
};
const strip = (n) => String(n).replace(/^the /, "");
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Idle thought-stream lines — the brain's quiet-time narration, INTERNAL by default (no speech/motor). Keyed
// by the seed the idle driver picked. Wordless + first-person so she "thinks" without chattering unprompted.
const IDLE_THOUGHT = {
  lull:    () => pick(["*settles into the quiet*", "*ears relax, listening to the room*", "*a slow, content blink*", "*sits with the stillness*"]),
  scan:    (q) => `*glances toward the ${q || "room"}*`,
  checkin: (who) => (who ? `*thinks about ${strip(who)}*` : "*wonders where everyone went*"),
  revisit: (fact) => (fact ? `*remembers: ${fact}*` : "*a half-formed thought drifts by*"),
};

export function makeCognition({ sim, backend = null, persona = {}, config = {}, memory = null } = {}) {
  persona = { ...DEFAULT_PERSONA, ...persona };
  const ticksPerCycle = config.ticksPerCycle ?? 3;
  const numPredict = config.numPredict ?? 64;
  // Autonomous mouth calls are OFF by default: a RESPOND arc she reaches on her own degrades to an onboard
  // line, so the loop never hammers the mouth. The mouth is reserved for explicit converse() (a supervisor
  // turn). Flip on only when you accept unprompted LLM traffic. (Respects the "be gentle with Ollama" rule.)
  const autoMouth = config.autoMouth ?? false;

  const organism = makeOrganism({ seed: config.seed ?? 1, noiseStd: config.noiseStd ?? 0.6, personality: persona.traits || {} });
  const sensorium = makeSensorium({ organism });
  const commit = makeCommitController(config.commit || {});
  const motor = makeMotorCodec({ bridge: sim.bridge, safety: sim.safety });

  // Buffer perception events off the bus between cognition cycles (the body ticks faster than we think).
  let evBuf = [];
  const onPerc = (p) => evBuf.push(p.event);
  sim.bus.subscribe("perception", onPerc);

  let thinking = false;         // single in-flight mouth call
  // Onboard-chatter throttle: a drive sitting near a threshold (a person pacing across the threat/reward
  // boundary) makes the arc flip every few cycles; without this she'd narrate every flip. She comments at
  // most once per speechCooldown cycles — EXCEPT emergencies, which always announce. Purely cosmetic (body
  // effects like halt still run every cycle); it just stops the voice log from spamming.
  const speechCooldown = config.speechCooldown ?? 30; // cycles (~2.4s at 12.5Hz)
  let sinceSpoke = speechCooldown, lastLine = null;
  const emit = (frame) => { config.onThought && config.onThought(frame); return frame; };
  const say = (text, kind) => { if (text && config.onSpeech) config.onSpeech(text, kind); };

  function visibleNow() {
    const p = sim.bridge.state.pose;
    return sim.perc.visionSummary(p.x, p.y, p.yaw);
  }
  function worldSummary(visible, frame) {
    const who = visible.slice(0, 4).map((v) => `${strip(v.name)} ${v.distance_m}m ${v.bearing_deg}°`).join(", ") || "nothing in view";
    const near = Math.min(...frame.state.range_obstacle).toFixed(2);
    return `In view: ${who}. Nearest obstacle ${near}m. You are ${frame.state.mode}.`;
  }

  // The OFFBOARD arc: ask the mouth to speak + optionally act; route motor through safety. Async; a single
  // call runs at a time. Returns { speech, intents, motor }. Used by both the autonomous RESPOND path and the
  // supervisor converse() path.
  async function think({ prompt = null, arc = "RESPOND" } = {}) {
    if (thinking || !backend) return null;
    thinking = true;
    try {
      const frame = sim.telemetryFrame();
      const visible = visibleNow();
      // Ground the reply in APPROVED memory only (the gate's recall serves current facts; pending never leaks).
      let known = "";
      if (memory) { const facts = await memory.recall(prompt || "", 3); if (facts.length) known = `\n\nWhat you know (approved facts): ${facts.map((f) => f.text).join("; ")}.`; }
      const system = `${persona.system}\n\n${motor.schema()}\n\nYou may also propose a memory with remember(a short fact) — it stays PENDING until your human approves it.\n\n${worldSummary(visible, frame)}${known}`;
      const user = prompt || (arc === "ESCALATE" ? "Something alarming is happening. React." : "You notice something. React briefly.");
      const raw = String(await backend.generate({ system, messages: [{ role: "user", content: user }], options: { num_predict: numPredict, temperature: 0.7 } }));
      // Capture remember(...) proposals → the approval tray (pending); strip them from the spoken text.
      const proposed = [...raw.matchAll(/remember\(([^)]*)\)/gi)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      for (const p of proposed) if (memory) await memory.proposeModel(p);
      const text = raw.replace(/remember\([^)]*\)/gi, "");
      const { speech, intents } = motor.parse(text);
      for (const it of intents) if (it.tool === "look_at" && it.args[0]) commit.setTarget(it.args[0]); // attention lock
      const results = motor.dispatch(intents, { world: sim.world });
      say(speech || REFLEX_LINE.REFLEX_REPLY(commit.target()), arc.toLowerCase());
      if (config.onMotor) config.onMotor(results);
      if (proposed.length && config.onPropose) config.onPropose(proposed);
      return { speech, intents, motor: results, proposed };
    } finally { thinking = false; }
  }

  return {
    organism, sensorium, commit, motor, memory,
    // Propose a fact she formed (from observation or a supervisor teaching her) → the approval tray (pending).
    remember(text) { return memory ? memory.proposeModel(text) : null; },

    // One cognition cycle. Autonomous by default; pass { prompt } for a supervisor-driven turn (also see
    // converse). Non-blocking: if the OFFBOARD arc fires, the mouth call is kicked and exposed as
    // frame.thinkPromise (await it in tests); the body keeps ticking meanwhile.
    step({ addressed = false, prompt = null, bumped = false } = {}) {
      const frame = sim.telemetryFrame();
      const events = evBuf; evBuf = [];
      const visible = visibleNow();
      const emergency = commit.emergencyInterrupt(frame, { bumped });

      const drive = sensorium.observe(frame, events, { addressed, prompt, visible });
      for (let i = 0; i < ticksPerCycle; i++) organism.tick({ tags: ["embodied"] });
      const reading = organism.readAction();
      sensorium.clearPhasic();

      const chosen = commit.chooseArc(reading, { emergency: emergency.tripped, emergencyArc: "EMERGENCY" });
      const liveTarget = commit.tickTargets(visible.map((v) => v.name));
      const out = { arc: chosen.arc, action: reading.action, confidence: +(reading.confidence || 0).toFixed(3), drive, emergency, target: liveTarget, commit: chosen, speech: null, motor: null, thinking, thinkPromise: null };

      // route → set out.speech + kind; ONBOARD speech is announced only on an arc TRANSITION (chosen.switched),
      // so a held arc doesn't spam the same line every cycle. Body effects (halt) run every cycle regardless.
      let kind = null;
      if (emergency.tripped) {
        sim.command({ type: "move", vx: 0, vy: 0, vyaw: 0 }); // halt: safety-gated, always allowed — every cycle
        out.speech = REFLEX_LINE.EMERGENCY(nearestName(visible)); kind = "emergency";
      } else if (chosen.arc === "REFLEX_REPLY") {
        // onboard snap: a reflex line, and orient toward a friendly (dynamic) face if one is present
        const friend = visible.find((v) => v.dynamic);
        out.speech = REFLEX_LINE.REFLEX_REPLY(friend && friend.name); kind = "reflex";
        if (friend && sim.safety.state === "active" && chosen.switched) { commit.setTarget(friend.name); out.motor = motor.dispatch([{ tool: "look_at", args: [friend.name] }], { world: sim.world }); }
      } else if (chosen.arc === "HOLD") {
        out.speech = REFLEX_LINE.HOLD(); kind = "reflex";
      } else if (chosen.arc === "RESPOND" || chosen.arc === "ESCALATE") {
        if (autoMouth && backend && !thinking) {
          out.thinkPromise = think({ prompt, arc: chosen.arc }); // unprompted LLM (opt-in)
        } else {
          // default: degrade to an onboard gesture so she still reacts, offline and cheap
          out.speech = REFLEX_LINE[chosen.arc](nearestName(visible)); kind = chosen.arc === "ESCALATE" ? "emergency" : "reflex";
        }
      }
      sinceSpoke++;
      if (out.speech && chosen.switched && (kind === "emergency" || (sinceSpoke >= speechCooldown && out.speech !== lastLine))) {
        say(out.speech, kind); sinceSpoke = 0; lastLine = out.speech;
      }
      return emit(out);
    },

    // A supervisor chat turn: force deliberation through the mouth and AWAIT it (the DoD path — "look at the
    // cat" → look_at tool-call, safety-gated). Injects the prompt as a deliberation demand first so the arc
    // reflects being addressed, then runs the offboard mouth.
    async converse(prompt) {
      sensorium.observe(sim.telemetryFrame(), [], { addressed: true, prompt, visible: visibleNow() });
      for (let i = 0; i < ticksPerCycle; i++) organism.tick({ tags: ["embodied", "addressed"] });
      const reading = organism.readAction();
      sensorium.clearPhasic();
      const res = await think({ prompt, arc: reading.action === "ESCALATE" ? "ESCALATE" : "RESPOND" });
      return { reading, ...(res || { speech: null, intents: [], motor: [] }) };
    },

    // A synthetic [idle] turn — what she does when left alone. Runs one onboard cognition cycle with a faint
    // ambient drive + a curiosity flicker (the seed), then narrates an INTERNAL thought. No mouth, so it's
    // cheap by construction. Escalates to a small exploratory MOTOR only under the driving-frame gate (roam)
    // AND a fresh context (isCurrent) — so she thinks freely but doesn't move/chatter unprompted unless allowed.
    // Self-limiting: the thought depletes the dopamine that drove it, so idle activity comes in bursts, not a
    // runaway. `kind` is the seed the idle driver picked (lull/scan/checkin/revisit).
    async idleTick({ kind = "lull", roam = false, isCurrent = () => true } = {}) {
      const frame = sim.telemetryFrame();
      const visible = visibleNow();
      sensorium.observe(frame, [], { visible });          // ambient sense, nothing addressed
      if (organism.curiosity) organism.curiosity(0.3);    // a flicker of curiosity seeds exploration
      for (let i = 0; i < ticksPerCycle; i++) organism.tick({ tags: ["idle"] });
      const reading = organism.readAction();
      sensorium.clearPhasic();

      // pick internal thought content by seed (offline; no LLM)
      let thought, acted = null;
      const friend = visible.find((v) => v.dynamic) || visible[0];
      if (kind === "scan") thought = IDLE_THOUGHT.scan(friend ? classifyDir(friend.bearing_deg) : null);
      else if (kind === "checkin") thought = IDLE_THOUGHT.checkin(friend && friend.name);
      else if (kind === "revisit") { const facts = memory ? memory.facts() : []; thought = IDLE_THOUGHT.revisit(facts.length ? pick(facts).text : null); }
      else thought = IDLE_THOUGHT.lull();

      if (organism.nudgeChem) organism.nudgeChem("dopamine", -0.15); // self-limiting: deplete what drove it

      // driving-frame escalation: a gentle orient toward whoever's around, gated on roam + safety + freshness
      if (roam && sim.safety.state === "active" && isCurrent() && friend && (kind === "checkin" || kind === "scan")) {
        commit.setTarget(friend.name);
        acted = motor.dispatch([{ tool: "look_at", args: [friend.name] }], { world: sim.world });
      }
      if (isCurrent()) { if (config.onIdleThought) config.onIdleThought(thought, { kind, action: reading.action, acted }); }
      return { kind, thought, acted, action: reading.action };
    },

    // A rotating seed picker for the idle driver (setSeedPicker target). Biases toward checking on a visible
    // companion, else scanning, else a memory revisit, else just sitting with the quiet.
    seedPicker() {
      const visible = visibleNow();
      if (visible.some((v) => v.dynamic)) return Math.random() < 0.6 ? "checkin" : "scan";
      if (memory && memory.facts().length && Math.random() < 0.4) return "revisit";
      return Math.random() < 0.5 ? "scan" : "lull";
    },

    isThinking: () => thinking,
    reset() { organism.settle(); sensorium.reset(); commit.reset(); evBuf = []; },
    dispose() { sim.bus.unsubscribe && sim.bus.unsubscribe("perception", onPerc); },
  };
}

function nearestName(visible) { return visible.length ? visible[0].name : null; }
function classifyDir(deg) { const a = Math.abs(deg); if (a < 20) return "ahead"; if (a > 160) return "behind"; return deg > 0 ? "left" : "right"; }
