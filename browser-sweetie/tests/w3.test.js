import { describe, it, expect } from "vitest";
import { makeSim } from "../src/simLoop.js";
import { makeCognition } from "../src/cognition.js";
import { makeMemoryGate } from "../src/memoryGate.js";
import { makeDeclarativeStore } from "../../../brain/src/declarativeStore.js";
import { makeMemoryStorage } from "../../../brain/src/storage.js";
import { makeHashEmbedder } from "../../../brain/src/embedder.js";

async function makeGate() {
  let t = 0;
  const store = makeDeclarativeStore({ storage: makeMemoryStorage(), embedder: makeHashEmbedder({ dim: 128 }), now: () => ++t, key: "mem" });
  await store.load();
  return makeMemoryGate({ store });
}

describe("W3 — memory grounding through cognition", () => {
  it("she proposes via remember() → pending → approve → it grounds the next reply's context", async () => {
    const sim = makeSim({ scene: "apartment" });
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    const gate = await makeGate();
    let lastSystem = null;
    const backend = { name: "mock", async generate({ system, messages }) {
      lastSystem = system;
      const u = messages[messages.length - 1].content;
      return /note|remember/i.test(u) ? "okay! remember(the cat is named Mochi)" : "her name is Mochi!";
    } };
    const cog = makeCognition({ sim, backend, memory: gate });

    // 1) she proposes the fact — it's quarantined as pending, not yet grounding
    const r1 = await cog.converse("the cat — please note her name");
    expect(r1.proposed).toContain("the cat is named Mochi");
    expect(gate.pending().map((p) => p.text)).toContain("the cat is named Mochi");
    const before = await gate.recall("cat name", 5);
    expect(before.some((h) => /Mochi/.test(h.text))).toBe(false); // pending never grounds

    // 2) supervisor approves → 3) the next turn's context now includes the approved fact
    await gate.approve(gate.pending()[0].id);
    await cog.converse("what is the cat's name?");
    expect(lastSystem).toMatch(/Mochi/);        // approved fact injected into the mouth context
    expect(gate.pendingCount()).toBe(0);
  });
});
