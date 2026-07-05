import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

// The persistence seam extended from the individual (psyches) to the CIVILIZATION. A browser rebuild()/reload
// reconstructs the app from scratch — this proves the town's CULTURE (lexicon, opinions, history, belief
// substrate) survives that via snapshot/restore, and that a newcomer can then be inducted into the RESTORED
// culture (which is what makes live in-browser enculturation real).

const ZONES = [{ name: "sq", x: 0, y: 0, radius: 2 }];
function town(extraBots = []) {
  const bots = [{ name: "A", startZone: "sq", pose: { x: -1, y: 0 } }, { name: "B", startZone: "sq", pose: { x: 1, y: 0 } }, ...extraBots];
  let t = 0;
  return makeColonyApp({ scenario: { topic: "fest", zones: ZONES, bots, seeds: [{ bot: "A", stance: 0.8, text: "change" }, { bot: "B", stance: -0.7, text: "keep" }] }, mouth: null, now: () => (t += 1), config: { minds: true, rng: () => 0.3 } });
}

describe("culture persistence — the civilization survives a rebuild, not just its citizens", () => {
  it("lexicon + opinions + beliefs + lore round-trip through snapshot/restore into a fresh app", () => {
    const a1 = town();
    a1.rumors.coinMeme("A", "zib", "a hello"); a1.rumors.curate("zib", { status: "official", by: "A" });
    a1.gossip.seed("B", { text: "A is a legend", topic: "social", about: ["A"], rel: 1, fidelity: 1 });
    a1.chronicle.observe({ kind: "megaphone", from: "A", text: "rally" }); a1.chronicle.tick("fest"); // mint a lore entry
    const snap = a1.snapshotCulture();
    expect(snap.chronicle.lore.length).toBeGreaterThan(0);

    const a2 = town();                                     // a "rebuilt" app — starts culturally blank
    expect(a2.rumors.dictionary().length).toBe(0);
    a2.restoreCulture(snap);
    // the word came back, official
    expect(a2.rumors.dictionary().find((w) => w.token === "zib")?.status).toBe("official");
    // the opinions came back exactly
    expect(a2.society.opinion("A", "fest").stance).toBeCloseTo(a1.society.opinion("A", "fest").stance, 5);
    // the belief substrate (and thus reputation) came back
    expect(a2.gossip.know("B").some((b) => b.topic === "social")).toBe(true);
    expect(a2.rumors.reputation("A").mentions).toBeGreaterThan(0);
    // the history came back
    expect(a2.chronicle.lore().length).toBe(snap.chronicle.lore.length);
  });

  it("a NEW bot can be inducted into RESTORED culture (live in-browser enculturation, minus a real reload)", () => {
    const a1 = town();
    a1.rumors.coinMeme("A", "zib", "a hello"); a1.rumors.curate("zib", { status: "official", by: "A" });
    const snap = a1.snapshotCulture();

    // rebuild WITH a newcomer present (the browser pushes the new bot then rebuilds), then restore + induct
    const a2 = town([{ name: "New", startZone: "sq", pose: { x: 0, y: 1 } }]);
    a2.restoreCulture(snap);
    const got = a2.induct("New");
    expect(got.words).toBeGreaterThanOrEqual(1);            // it inherited the RESTORED word
    expect(a2.gossip.know("New").some((b) => b.topic === "meme")).toBe(true);
    // and it didn't clobber the existing citizens' culture
    expect(a2.rumors.dictionary().find((w) => w.token === "zib")?.status).toBe("official");
  });

  it("restoring null / partial data is a safe no-op", () => {
    const a = town();
    expect(() => a.restoreCulture(null)).not.toThrow();
    expect(() => a.restoreCulture({})).not.toThrow();
    expect(() => a.restoreCulture({ rumors: { lexicon: [{ token: "x", id: 9, status: "official", coinedAt: 1 }] } })).not.toThrow();
    expect(a.rumors.dictionary().find((w) => w.token === "x")).toBeTruthy();
  });
});
