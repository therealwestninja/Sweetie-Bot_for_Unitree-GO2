// Motor codec — the efferent nerve, and W2's genuinely-new build. The brain's RESPOND/ESCALATE arc goes to
// the LLM mouth, which speaks AND may emit spatial motor intents; this codec parses those intents out of the
// mouth's text, validates each through the SAME safety.guardAction chokepoint the joystick uses, and calls
// the bridge. Cognition is body-agnostic: the mouth proposes "look_at(the cat)", the codec decides whether
// the body may, and how. speak/halt are the two onboard verbs (no armed-gate); everything else is armed-gated.
//
// Grammar (what the mouth is told to emit, see schema()): a short spoken line, then zero+ tool calls, one per
// line, `name(arg, ...)`. Anything not a recognized call is speech. Deliberately forgiving — small local models
// are sloppy — but every motor effect still passes safety, so a hallucinated tool can talk, never lunge.
const GESTURES = new Set(["nod", "wag", "tilt_head", "perk_ears", "crouch", "bow", "shake"]);

// tool name → { action: safety.guardAction key (null = onboard/no-gate), arity, numeric arg indices }
const TOOLS = {
  speak:           { action: null,             nums: [] },
  halt:            { action: "halt",           nums: [] },
  look_at:         { action: "look_at",        nums: [] },
  go_to_pose:      { action: "go_to_pose",     nums: [0, 1] },
  stand:           { action: "stand_up",       nums: [] },
  sit:             { action: "sit_down",       nums: [] },
  gesture:         { action: "gesture",        nums: [] },
  set_body_height: { action: "set_body_height",nums: [0] },
  follow_path:     { action: "follow_path",    nums: [] },
};
const TOOL_RE = /\b(speak|halt|look_at|go_to_pose|stand|sit|gesture|set_body_height|follow_path)\s*\(([^)]*)\)/gi;

function splitArgs(raw) {
  if (!raw.trim()) return [];
  return raw.split(",").map((a) => a.trim().replace(/^['"]|['"]$/g, "")).filter((a) => a.length);
}

export function makeMotorCodec({ bridge, safety } = {}) {
  return {
    // Pull tool intents out of mouth text; return { speech, intents:[{tool,args,raw}] }. The leftover prose
    // (with tool-call substrings stripped) plus any speak(...) args become the spoken line.
    parse(text = "") {
      const intents = [];
      const speakParts = [];
      let m;
      TOOL_RE.lastIndex = 0;
      while ((m = TOOL_RE.exec(text)) !== null) {
        const tool = m[1].toLowerCase();
        let args = splitArgs(m[2]);
        for (const i of TOOLS[tool].nums) if (args[i] !== undefined) args[i] = Number(args[i]);
        if (tool === "speak") { speakParts.push(args.join(" ")); }
        else intents.push({ tool, args, raw: m[0] });
      }
      const prose = text.replace(TOOL_RE, "").replace(/\s+/g, " ").trim();
      const speech = [prose, ...speakParts].filter(Boolean).join(" ").trim();
      return { speech, intents };
    },

    // Route parsed intents through safety → bridge, in order. Returns per-intent verdicts. A rejected intent
    // never touches the body. Unknown args / bad types fail closed (ok:false) rather than throwing.
    dispatch(intents = [], { world = null, gestures = GESTURES } = {}) {
      const results = [];
      for (const { tool, args } of intents) {
        const spec = TOOLS[tool];
        if (!spec) { results.push({ tool, ok: false, reason: "unknown tool" }); continue; }
        // numeric-arg validation
        if (spec.nums.some((i) => args[i] === undefined || Number.isNaN(args[i]))) { results.push({ tool, ok: false, reason: "bad numeric arg" }); continue; }
        if (spec.action) {
          const g = safety.guardAction(spec.action);
          if (!g.allowed) { results.push({ tool, ok: false, reason: g.reason }); continue; }
        }
        let ok = false, detail = null;
        switch (tool) {
          case "halt":            ok = bridge.stopMove(); break;
          case "look_at":         { const r = bridge.lookAtEntity(args[0]); ok = r === "ok"; detail = r; break; }
          case "go_to_pose":      ok = bridge.goToPose(args[0], args[1]); break;
          case "stand":           ok = bridge.standUp(); break;
          case "sit":             ok = bridge.standDown(); break;
          case "gesture":         ok = bridge.performGesture(args[0], gestures); detail = ok ? null : "unsafe/unknown gesture"; break;
          case "set_body_height": ok = bridge.setBodyHeight(args[0]); break;
          case "follow_path":     ok = false; detail = "not_implemented (W5 nav)"; break;
          default:                ok = false;
        }
        results.push({ tool, args, ok, reason: ok ? "ok" : (detail || "rejected by body") });
      }
      return results;
    },

    // The tool menu handed to the mouth's system prompt. Kept terse on purpose (small local models + the
    // "be gentle with the mouth" budget) — one spoken line, then optional calls.
    schema() {
      return [
        "You control a small quadruped robot's BODY. Reply with ONE short spoken line (in character).",
        "Then, ONLY if action is warranted, add tool calls on their own lines:",
        "  look_at(name)         orient toward a visible thing",
        "  go_to_pose(x, y)      walk to a map coordinate",
        "  stand() / sit()       posture",
        "  gesture(name)         one of: nod, wag, tilt_head, perk_ears, crouch, bow, shake",
        "  set_body_height(m)    0.18–0.34",
        "  halt()                stop moving now",
        "Emit no tool call if speaking is enough. Never invent tools or coordinates you can't see.",
      ].join("\n");
    },

    gestures: GESTURES,
  };
}
