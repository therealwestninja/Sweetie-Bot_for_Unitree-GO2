// Mouth service — the ONE place the colony talks to a model. Every intro, gossip re-wording, megaphone
// manifesto and lobby line goes through here, so they all share the scheduler's gentleness (serialised,
// prioritised, rate-limited) instead of each subsystem firing its own fetch. It's backend-agnostic: hand it
// any { name, async generate({system,messages,options}) } — the mock backend, the brain's Ollama backend, or
// the inline adapter — and swap without touching callers.
//
// RECORD / REPLAY: in record mode every call's (tag, prompt, output) is logged; in replay mode the logged
// output is returned WITHOUT touching the backend, so a whole colony run reproduces bit-for-bit — essential
// once non-deterministic Ollama (or non-obvious emergent behaviour) is in the loop.

// Priority tiers (higher = spoken sooner). A human waiting at the booth beats idle gossip re-phrasing.
export const PRIORITY = { booth: 100, megaphone: 80, converse: 60, lobby: 50, gossip: 20, idle: 10 };

export function makeMouth({ backend = null, scheduler = null, mode = "live", log = [] } = {}) {
  let replayIdx = 0;
  const record = [];

  async function callBackend({ system, messages, options, onChunk, signal }) {
    if (!backend) throw new Error("mouth: no backend");
    // onChunk/signal are optional — a streaming backend calls onChunk({textChunk,fullTextSoFar}) as tokens arrive
    // and honours the abort signal (barge-in); a non-streaming backend simply ignores them and returns the string.
    return String(await backend.generate({ system, messages, options, onChunk, signal }));
  }

  return {
    mode, record, PRIORITY,

    // Generate a line. In "replay" mode returns the next recorded output for this tag (deterministic); in
    // "live"/"record" mode routes the backend call through the scheduler at the given priority. Never blocks
    // the physics loop — returns a promise; the caller attaches the result when it resolves.
    async generate({ system = "", messages = [], options = {}, priority = PRIORITY.lobby, tag = null, stale = null, onChunk = null, signal = null } = {}) {
      if (mode === "replay") {
        const hit = tag != null ? log.find((e, i) => i >= replayIdx && e.tag === tag) : log[replayIdx];
        replayIdx = (hit ? log.indexOf(hit) : replayIdx) + 1;
        return hit ? hit.output : "";
      }
      const run = async () => {
        const output = await callBackend({ system, messages, options, onChunk, signal });
        if (mode === "record") record.push({ tag, system, user: messages.map((m) => m.content).join("\n"), output });
        return output;
      };
      if (!scheduler) return run();                       // no scheduler → just run (tests / simple use)
      return scheduler.enqueue({ run, priority, stale, tag });
    },

    // Convenience: a one-shot line from a prompt.
    line(prompt, { system = "", priority = PRIORITY.lobby, tag = null, onChunk = null } = {}) {
      return this.generate({ system, messages: [{ role: "user", content: prompt }], priority, tag, onChunk });
    },

    // Export what was recorded (feed back as `log` with mode:"replay" to reproduce a run).
    transcript: () => record.slice(),
    stats: () => (scheduler ? scheduler.stats() : { queued: 0, inFlight: 0 }),
  };
}
