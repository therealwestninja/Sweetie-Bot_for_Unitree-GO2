// An Ollama-driven character (a human or another bot) that Sweetie meets in the nav harness. Its lines come
// from the local model, not a script — so "bot/human interactions" are genuinely generated. Kept GENTLE per
// the project rules: gemma (8B) by default, a tiny num_predict cap, one call at a time, and the harness only
// calls it at discrete encounter moments (never per tick).
export function makeActor({ name, persona, model = "gemma4:latest", url = "http://localhost:11434", numPredict = 48 } = {}) {
  let calls = 0;
  return {
    name, persona,
    calls: () => calls,
    // Generate one short in-character line for the current situation. Returns "" on any failure (the harness
    // degrades to a scripted note) so a flaky mouth never crashes a run.
    async react(situation) {
      calls++;
      const system = `You are ${name}, ${persona}. A small quadruped robot dog is nearby. Reply with ONE short spoken line (max 14 words), in character, reacting to it. No stage directions, no quotes, no narration.`;
      const body = { model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: situation }], options: { num_predict: numPredict, temperature: 0.8 } };
      try {
        const res = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) return "";
        const d = await res.json();
        return String((d.message && d.message.content) || "").trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, "");
      } catch { return ""; }
    },
  };
}

// A gentle Ollama backend for Sweetie's own mouth (her side of an interaction), same care as the actor.
export function makeOllamaMouth({ model = "gemma4:latest", url = "http://localhost:11434", numPredict = 56 } = {}) {
  return {
    name: "ollama",
    async generate({ system, messages, options } = {}) {
      const body = { model, stream: false, messages: [...(system ? [{ role: "system", content: system }] : []), ...(messages || [])], options: { num_predict: (options && options.num_predict) || numPredict, temperature: (options && options.temperature) ?? 0.7 } };
      const res = await fetch(`${url}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("ollama HTTP " + res.status);
      const d = await res.json();
      return String((d.message && d.message.content) || "");
    },
  };
}
