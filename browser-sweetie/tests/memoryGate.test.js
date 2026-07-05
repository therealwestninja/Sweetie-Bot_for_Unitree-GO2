import { describe, it, expect } from "vitest";
import { makeDeclarativeStore } from "../../../brain/src/declarativeStore.js";
import { makeMemoryStorage } from "../../../brain/src/storage.js";
import { makeHashEmbedder } from "../../../brain/src/embedder.js";
import { makeMemoryGate } from "../src/memoryGate.js";

// Collision-resistant id (mirrors index.html): the store's default counter resets to 0 per session, so a
// fact added after a reload would reuse a persisted id and update() would corrupt the wrong record.
let idSeq = 0;
const genId = () => `m${Date.now().toString(36)}-${idSeq++}`;
async function freshGate(storage = makeMemoryStorage()) {
  let t = 0;
  const store = makeDeclarativeStore({ storage, embedder: makeHashEmbedder({ dim: 128 }), now: () => ++t, id: genId, key: "mem" });
  await store.load();
  return { gate: makeMemoryGate({ store }), store, storage };
}

describe("memoryGate — approval gate (new-build #1)", () => {
  it("a model-proposed fact is pending and does NOT ground recall until approved", async () => {
    const { gate } = await freshGate();
    const prop = await gate.proposeModel("the cat is named Mochi");
    expect(prop.stateRole).toBe("pending");
    expect(gate.pending().map((r) => r.text)).toContain("the cat is named Mochi");
    // pending → recall (current only) must not surface it
    let hits = await gate.recall("cat name Mochi", 5);
    expect(hits.some((h) => /Mochi/.test(h.text))).toBe(false);
    // approve → now it grounds
    await gate.approve(prop.id);
    expect(gate.pendingCount()).toBe(0);
    hits = await gate.recall("cat name Mochi", 5);
    expect(hits.some((h) => /Mochi/.test(h.text))).toBe(true);
    expect(gate.facts().map((r) => r.text)).toContain("the cat is named Mochi");
  });

  it("rejecting drops the fact entirely; user-authored facts are trusted immediately", async () => {
    const { gate } = await freshGate();
    const bad = await gate.proposeModel("the floor is lava");
    await gate.reject(bad.id);
    expect(gate.pendingCount()).toBe(0);
    expect(gate.facts().length).toBe(0);
    // a supervisor fact skips the tray
    await gate.addUserFact("home base is the charging dock by the door");
    expect(gate.pendingCount()).toBe(0);
    const hits = await gate.recall("where is home base charging dock", 5);
    expect(hits.some((h) => /charging dock/.test(h.text))).toBe(true);
  });

  it("approved facts persist across a reload (sessions persist)", async () => {
    const storage = makeMemoryStorage();
    const a = await freshGate(storage);
    const p = await a.gate.proposeModel("the couch is by the window");
    await a.gate.approve(p.id);
    // simulate a new session on the SAME storage
    const b = await freshGate(storage);
    expect(b.gate.facts().map((r) => r.text)).toContain("the couch is by the window");
    const hits = await b.gate.recall("couch window", 5);
    expect(hits.some((h) => /couch/.test(h.text))).toBe(true);
  });

  it("proposing a NEW fact after reload doesn't corrupt the existing approved fact (id-collision guard)", async () => {
    const storage = makeMemoryStorage();
    const a = await freshGate(storage);
    const keep = await a.gate.proposeModel("home base is the dock by the door");
    await a.gate.approve(keep.id);
    // new session, SAME storage — then propose a fresh fact (the reload-collision scenario)
    const b = await freshGate(storage);
    await b.gate.proposeModel("the rug is new");
    expect(b.gate.facts().map((r) => r.text)).toContain("home base is the dock by the door"); // still approved
    expect(b.gate.pending().map((r) => r.text)).toEqual(["the rug is new"]);                    // only the new one pends
    const hits = await b.gate.recall("home base dock door", 5);
    expect(hits.some((h) => /home base/.test(h.text))).toBe(true); // grounding intact
  });
});
