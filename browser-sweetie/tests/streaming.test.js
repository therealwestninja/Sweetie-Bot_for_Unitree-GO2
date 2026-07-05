import { describe, it, expect } from "vitest";
import { makeNdjson, ollamaDelta, earlyStopReady, cleanText, pumpStream, stripSelfName } from "../src/agents/textStream.js";
import { makeMouth } from "../src/agents/mouth.js";

describe("textStream — NDJSON framing", () => {
  it("reassembles JSON objects split ACROSS reader chunks", () => {
    const nd = makeNdjson();
    expect(nd.push('{"message":{"content":"Hel')).toEqual([]);          // partial line → nothing yet
    const out = nd.push('lo"}}\n{"message":{"content":" there"},"done":true}\n');
    expect(out.map((o) => ollamaDelta(o))).toEqual(["Hello", " there"]);
    expect(out[1].done).toBe(true);
  });
  it("skips a malformed line without throwing", () => {
    const nd = makeNdjson();
    expect(nd.push('not json\n{"message":{"content":"ok"}}\n').map(ollamaDelta)).toEqual(["ok"]);
  });
  it("flush() returns a trailing newline-less object", () => {
    const nd = makeNdjson();
    nd.push('{"a":1}\n{"message":{"content":"tail"}}');
    expect(ollamaDelta(nd.flush())).toBe("tail");
  });
});

describe("textStream — early-stop at a sentence boundary", () => {
  it("waits for minChars AND the required sentence count", () => {
    expect(earlyStopReady("short.", { minChars: 48, maxSentences: 1 })).toBe(false);       // too short
    expect(earlyStopReady("a".repeat(50), { minChars: 48, maxSentences: 1 })).toBe(false); // long but no ender
    expect(earlyStopReady("This is quite a long enough first sentence indeed.", { minChars: 48, maxSentences: 1 })).toBe(true);
  });
  it("respects maxSentences", () => {
    const two = "This first part runs on for a good while, yes. And here is the second!";
    expect(earlyStopReady(two, { minChars: 48, maxSentences: 2 })).toBe(true);
    expect(earlyStopReady("This first part runs on for a good long while, yes.", { minChars: 48, maxSentences: 2 })).toBe(false);
  });
  it("ollamaDelta falls back through content → thinking → response", () => {
    expect(ollamaDelta({ message: { content: "c" } })).toBe("c");
    expect(ollamaDelta({ message: { thinking: "t" } })).toBe("t");
    expect(ollamaDelta({ response: "r" })).toBe("r");
    expect(ollamaDelta(null)).toBe("");
  });
});

describe("textStream — pumpStream drives a source to completion", () => {
  // a fake reader: hands out these raw chunks in order, then null (EOF)
  const reader = (chunks) => { let i = 0; return () => (i < chunks.length ? chunks[i++] : null); };

  it("emits deltas and returns the cleaned full text", async () => {
    const chunks = ['{"message":{"content":"Hello"}}\n', '{"message":{"content":" world"},"done":true}\n'];
    const seen = [];
    const out = await pumpStream({ read: reader(chunks), onChunk: (c) => seen.push(c.fullTextSoFar) });
    expect(out).toBe("Hello world");
    expect(seen).toEqual(["Hello", "Hello world"]);
  });

  it("stops early at a sentence boundary and doesn't consume the rest", async () => {
    const chunks = [
      '{"message":{"content":"This is a complete and sufficiently long first sentence."}}\n',
      '{"message":{"content":" This second one should never be read."}}\n', // pump should bail before here
    ];
    let reads = 0;
    const src = reader(chunks);
    const out = await pumpStream({ read: () => { reads++; return src(); }, earlyStop: { minChars: 40, maxSentences: 1 } });
    expect(out).toBe("This is a complete and sufficiently long first sentence.");
    expect(reads).toBe(1); // only pulled the first chunk, then stopped
  });
});

describe("mouth — onChunk is threaded through to the caller", () => {
  it("passes onChunk to a streaming backend and still returns the full string", async () => {
    // a backend that streams two deltas via onChunk, then resolves the whole line
    const backend = { name: "fake-stream", async generate({ onChunk }) { onChunk && onChunk({ textChunk: "Hi", fullTextSoFar: "Hi" }); onChunk && onChunk({ textChunk: " you", fullTextSoFar: "Hi you" }); return "Hi you"; } };
    const m = makeMouth({ backend });
    const seen = [];
    const out = await m.generate({ messages: [{ role: "user", content: "x" }], onChunk: (c) => seen.push(c.fullTextSoFar) });
    expect(out).toBe("Hi you");
    expect(seen).toEqual(["Hi", "Hi you"]);
  });
  it("cleanText collapses whitespace", () => {
    expect(cleanText("  a\n  b   c ")).toBe("a b c");
  });
  it("stripSelfName drops a single leading 'Name:' the model echoes", () => {
    expect(stripSelfName("Solara: the traditions matter.", "Solara")).toBe("the traditions matter.");
    expect(stripSelfName("Solara: Solara: hi", "Solara")).toBe("Solara: hi"); // only once
    expect(stripSelfName("Ada - let's change it", "Ada")).toBe("let's change it");
    expect(stripSelfName("I, Solara, say no", "Solara")).toBe("I, Solara, say no"); // not a leading prefix → untouched
    expect(stripSelfName("", "Ada")).toBe("");
  });
});
