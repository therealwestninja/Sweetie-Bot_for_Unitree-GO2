// Decider — the portable cognition core, BODYLESS. The sim proved the brain drives a body; this exposes the
// same brain as a pure function of a sensor frame → a decision, so a REAL robot (a Unitree Go2) can outsource
// its thinking: it POSTs its telemetry, the decider runs the spiking organism + sensorium + commit-discipline
// (+ the LLM mouth for the RESPOND/ESCALATE arc), and returns motor INTENTS the robot executes itself. No local
// bridge, no shadow world — motor intents (look_at(the cat), go_to_pose(x,y), halt) are returned as data and
// safety-gated by the robot's reported state, because the robot owns its own actuators + perception.
//
// This is the onboard/offboard split, made portable: onboard reflexes resolve here with no LLM; the offboard
// mouth is one gated call. Same code path as cognition.js, minus the body — that's the whole test-platform bet.
import { makeOrganism } from "../../../brain/src/organism.js";
import { makeSensorium } from "./sensorium.js";
import { makeCommitController } from "./commit.js";
import { makeMotorCodec } from "./motorCodec.js";

const strip = (n) => String(n).replace(/^the /, "");
const REFLEX = { REFLEX_REPLY: (t) => (t ? `*perks up at ${strip(t)}*` : "*ears twitch, alert*"), HOLD: () => "*waits, watching*", EMERGENCY: (t) => (t ? `*freezes — ${strip(t)} too close!*` : "*freezes — too close!*") };
const DEFAULT_PERSONA = "You are Sweetie, a small affectionate robotic dog. Curious, gentle, playful. One short spoken line, in character.";

// A frame the robot sends: { pose:{x,y,yaw}, ranges:[front,left,back,right], battery, safety:"active"|"idle"|
// "estop", mode, visible:[{name,distance_m,bearing_deg,category,dynamic}], events:[string] }.
export function makeDecider({ backend = null, persona = DEFAULT_PERSONA, memory = null, config = {} } = {}) {
  const ticksPerCycle = config.ticksPerCycle ?? 3, bubble = config.bubble ?? 0.45, numPredict = config.numPredict ?? 64;
  const organism = makeOrganism({ seed: config.seed ?? 1, noiseStd: config.noiseStd ?? 0.6, personality: config.traits || {} });
  const sensorium = makeSensorium({ organism });
  const commit = makeCommitController(config.commit || {});
  const codec = makeMotorCodec({ bridge: null, safety: null });   // used for parse()/schema() only (bodyless)

  // Gate an intent by the robot's REPORTED safety state (the robot still owns the final say on its actuators).
  const gate = (tool, frame) => (tool === "halt" || tool === "speak" ? { ok: true } : frame.safety === "estop" ? { ok: false, reason: "estop latched" } : frame.safety !== "active" ? { ok: false, reason: "not armed" } : { ok: true });
  const worldSummary = (f) => { const who = (f.visible || []).slice(0, 4).map((v) => `${strip(v.name)} ${v.distance_m}m ${v.bearing_deg}°`).join(", ") || "nothing in view"; return `In view: ${who}. Nearest obstacle ${Math.min(...(f.ranges || [3, 3, 3, 3])).toFixed(2)}m. You are ${f.mode || "standing"}.`; };

  return {
    organism, commit, schema: () => codec.schema(),

    // The core: a sensor frame → a decision. opts.prompt = a supervisor/human line (forces the offboard arc).
    async decide(frame = {}, { prompt = null, addressed = false } = {}) {
      const ranges = frame.ranges || [3, 3, 3, 3];
      const vframe = { state: { range_obstacle: ranges, mode: frame.mode || "standing", pose: frame.pose || { x: 0, y: 0, yaw: 0 } } };
      const emergency = Math.min(...ranges) <= bubble;
      const drive = sensorium.observe(vframe, frame.events || [], { addressed, prompt, visible: frame.visible || [] });
      for (let i = 0; i < ticksPerCycle; i++) organism.tick({ tags: ["decide"] });
      const reading = organism.readAction();
      sensorium.clearPhasic();
      const chosen = commit.chooseArc(reading, { emergency, emergencyArc: "EMERGENCY" });
      // a human line (prompt) is a direct request to deliberate → force the offboard/mouth arc (like converse)
      let arc = chosen.arc;
      if (prompt && !emergency) arc = reading.action === "ESCALATE" ? "ESCALATE" : "RESPOND";
      const nearest = (frame.visible || [])[0];
      const out = { arc, action: reading.action, confidence: +(reading.confidence || 0).toFixed(3), emergency, drive, speech: null, intents: [], proposed: [] };

      if (emergency) { out.arc = "EMERGENCY"; out.intents = [{ tool: "halt", args: [], ok: true }]; out.speech = REFLEX.EMERGENCY(nearest && nearest.name); return out; }
      if (arc === "REFLEX_REPLY") {
        const friend = (frame.visible || []).find((v) => v.dynamic);
        out.speech = REFLEX.REFLEX_REPLY(friend && friend.name);
        if (friend) { const g = gate("look_at", frame); if (g.ok) { commit.setTarget(friend.name); out.intents.push({ tool: "look_at", args: [friend.name], ok: true }); } }
        return out;
      }
      if (arc === "HOLD") { out.speech = REFLEX.HOLD(); return out; }
      if ((arc === "RESPOND" || arc === "ESCALATE")) {
        if (!backend) { out.speech = REFLEX.REFLEX_REPLY(nearest && nearest.name); return out; } // degrade to onboard, offline
        let known = "";
        if (memory) { const facts = await memory.recall(prompt || "", 3); if (facts.length) known = `\n\nWhat you know: ${facts.map((f) => f.text).join("; ")}.`; }
        const system = `${persona}\n\n${codec.schema()}\n\nYou may also propose a memory with remember(a short fact).\n\n${worldSummary(frame)}${known}`;
        const raw = String(await backend.generate({ system, messages: [{ role: "user", content: prompt || (arc === "ESCALATE" ? "Something alarming — react." : "You notice something. React briefly.") }], options: { num_predict: numPredict, temperature: 0.7 } }));
        out.proposed = [...raw.matchAll(/remember\(([^)]*)\)/gi)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        for (const p of out.proposed) if (memory) await memory.proposeModel(p);
        const { speech, intents } = codec.parse(raw.replace(/remember\([^)]*\)/gi, ""));
        out.speech = speech;
        for (const it of intents) { const g = gate(it.tool, frame); out.intents.push({ ...it, ok: g.ok, ...(g.ok ? {} : { reason: g.reason }) }); if (it.tool === "look_at" && it.args[0] && g.ok) commit.setTarget(it.args[0]); }
        return out;
      }
      return out; // QUIET
    },
  };
}
