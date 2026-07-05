// Streaming-text helpers — the model-agnostic, Node-testable core of the streaming "mouth". The browser wires
// these to fetch() + ReadableStream (Ollama) or to Perchance's onChunk; the logic here (NDJSON line framing +
// sentence-boundary early-stop + delta extraction) is pure, so it's unit-tested without a network.
//
// Why streaming matters here: the mouth is one serialized slot (scheduler concurrency 1). Streaming alone only
// improves PERCEIVED latency (a line types itself out). But EARLY-STOP — cutting the generation at a natural
// sentence boundary instead of grinding out every num_predict token — frees that single slot sooner, which
// actually RAISES the town's utterances-per-minute ceiling, and generates fewer tokens (gentler on Ollama).

// Ollama /api/chat with stream:true returns NDJSON: one JSON object per line, each { message:{content}, done }.
// A reader chunk can hold 0..n complete lines plus a partial trailing line, so we buffer across pushes.
export function makeNdjson() {
  let buf = "";
  return {
    // push a raw string chunk → the array of parsed JSON objects for the lines it COMPLETED (partial line held)
    push(chunk) {
      buf += chunk;
      const out = [];
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { out.push(JSON.parse(line)); } catch (e) { /* skip a malformed/partial line */ } }
      }
      return out;
    },
    // parse any trailing complete JSON left without a newline at EOF (Ollama usually ends with one, but be safe)
    flush() { const line = buf.trim(); buf = ""; if (!line) return null; try { return JSON.parse(line); } catch (e) { return null; } },
  };
}

// The content delta from one Ollama stream object — message.content, tolerant of "thinking" models and the
// non-stream /api/generate shape.
export function ollamaDelta(obj) {
  if (!obj) return "";
  const m = obj.message || {};
  return String(m.content || m.thinking || obj.response || "");
}

// Should we stop generating now? True once we have at least `minChars` AND have closed `maxSentences` sentence-
// enders (. ! ? …). Lets a line end on a natural boundary instead of running to the token cap.
export function earlyStopReady(text, { minChars = 48, maxSentences = 2 } = {}) {
  if (!text || text.length < minChars) return false;
  const enders = (text.match(/[.!?…]["')\]]?(\s|$)/g) || []).length;
  return enders >= maxSentences;
}

// Normalise a finished line (collapse whitespace, trim) — the boxed/streamed text the callers expect.
export const cleanText = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

// Strip a leading "Name:" / "Name -" the model often echoes when the system prompt says "You are <Name>". Only
// removes it once (so "Ada: Ada: hi" → "Ada: hi", and a real quoted line isn't over-stripped).
export function stripSelfName(text, name) {
  if (!text || !name) return text;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text).replace(new RegExp("^\\s*" + esc + "\\s*[:\\-–—]\\s*", "i"), "").trim();
}

// Drive a streaming source to completion, model-agnostically. `read()` returns the next raw string chunk (or
// null at EOF); `onChunk({textChunk, fullTextSoFar})` is called per delta; early-stop cuts it short at a natural
// boundary. Node-testable with a fake read(); the browser passes a reader-backed read(). Returns the full text.
export async function pumpStream({ read, onChunk = null, delta = ollamaDelta, isDone = (o) => !!o.done, earlyStop = null } = {}) {
  const nd = makeNdjson();
  let full = "";
  const emit = (objs) => {
    for (const obj of objs) {
      const d = delta(obj);
      if (d) { full += d; if (onChunk) onChunk({ textChunk: d, fullTextSoFar: full }); }
      if (isDone(obj)) return "done";
    }
    return null;
  };
  for (;;) {
    const chunk = await read();
    if (chunk == null) { emit([nd.flush()].filter(Boolean)); break; }
    if (emit(nd.push(chunk)) === "done") return cleanText(full);
    if (earlyStop && earlyStopReady(full, earlyStop)) break; // natural stop → free the slot early
  }
  return cleanText(full);
}
