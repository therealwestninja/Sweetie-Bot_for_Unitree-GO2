import { describe, it, expect } from "vitest";
import { makePsyche } from "../src/agents/psyche.js";

// Regression guard for the "sim memory grows exponentially over ~3 min" bug. Root cause: ruminate() re-lived a
// wound by calling experience(), which STORED a fresh charged memory — itself re-livable → wounds bred without
// bound. Fixes: rumination relives WITHOUT recording; a hard cap; tick() drops faded memories. This test would
// have failed hard (memory count in the thousands) before the fix.
describe("psyche memory store stays bounded (memory-leak regression)", () => {
  it("rumination re-lives a wound WITHOUT minting new memories", () => {
    let t = 0;
    const p = makePsyche({ seed: 7, now: () => ++t });
    p.onSlighted("the watch", 0.8, "hauled off"); // one real wound → one stored memory
    const before = p.snapshot().memories.length;
    for (let i = 0; i < 500; i++) p.ruminate();    // brood on it 500 times
    const after = p.snapshot().memories.length;
    expect(before).toBe(1);
    expect(after).toBe(before);                    // NOT 501 — rumination must not breed memories
  });

  it("the store is hard-capped even under a flood of distinct charged events", () => {
    let t = 0;
    const p = makePsyche({ seed: 3, now: () => ++t });
    for (let i = 0; i < 5000; i++) { p.onSlighted("bot" + (i % 40), 0.9); if (i % 7 === 0) p.tick(); }
    expect(p.snapshot().memories.length).toBeLessThanOrEqual(64); // MEM_CAP — bounded no matter how long it runs
  });

  it("restore REPLACES rather than appends (rebuild must not duplicate the store)", () => {
    let t = 0;
    const p = makePsyche({ seed: 5, now: () => ++t });
    p.onSlighted("x", 0.8);
    const snap = p.snapshot();
    p.restore(snap); p.restore(snap); p.restore(snap); // three rebuilds in a row
    expect(p.snapshot().memories.length).toBe(snap.memories.length); // still 1, not 4+
  });
});
