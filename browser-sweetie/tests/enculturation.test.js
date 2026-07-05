import { describe, it, expect } from "vitest";
import { makeColonyApp } from "../src/agents/colonyApp.js";

// THE NEW SHELL (the ablation harness). The platform-level claim — "culture RAISES its members" — is RELATIONAL,
// not local: no single module has it, so no unit test can prove it. The only proof is a DIFFERENTIAL: raise one
// bot in the town's culture (induct) and leave an identical one blank, then measure that the raised one behaves
// measurably differently. This is the return-arrow (culture → individual) made falsifiable.

function cultureTown() {
  const zones = [{ name: "sq", x: 0, y: 0, radius: 2.5 }];
  const bots = [
    { name: "F1", startZone: "sq", pose: { x: -1, y: 0 } }, { name: "F2", startZone: "sq", pose: { x: 0, y: 0 } }, { name: "F3", startZone: "sq", pose: { x: 1, y: 0 } },
    // two identical newcomers — same everything; the ONLY difference will be induction
    { name: "Raised", startZone: "sq", pose: { x: -1, y: 1 } }, { name: "Fresh", startZone: "sq", pose: { x: 1, y: 1 } },
  ];
  const seeds = [{ bot: "F1", stance: 0.85, text: "reinvent it" }, { bot: "F2", stance: 0.8, text: "reinvent it" }, { bot: "F3", stance: 0.75, text: "reinvent it" }];
  let t = 0;
  return makeColonyApp({ scenario: { topic: "the festival", zones, bots, seeds }, mouth: null, now: () => (t += 1), config: { minds: true, rng: () => 0.3 } });
}

describe("enculturation — an inducted citizen is measurably different from a blank one (culture feeds back)", () => {
  it("the raised bot speaks the dialect, knows the reputations, and leans to the town's view; the blank one doesn't", () => {
    const app = cultureTown();
    // the town DEVELOPS a culture: two words that became official, and a standing reputation for F1
    app.rumors.coinMeme("F1", "zib", "a friendly hello"); app.rumors.curate("zib", { status: "official", by: "F1" });
    app.rumors.coinMeme("F2", "wug", "a small favour"); app.rumors.curate("wug", { status: "official", by: "F2" });
    app.gossip.seed("F2", { text: "F1 is a legend around here", topic: "social", about: ["F1"], rel: 1, fidelity: 1 });
    app.gossip.seed("F3", { text: "F1 is a legend around here", topic: "social", about: ["F1"], rel: 1, fidelity: 1 });

    // THE ABLATION: induct one newcomer, leave the other blank (no ticks → no passive spread to confound it)
    const got = app.induct("Raised");

    const words = (n) => app.gossip.know(n).filter((b) => b.topic === "meme").length;
    const social = (n) => app.gossip.know(n).filter((b) => b.topic === "social").length;
    const stance = (n) => app.society.opinion(n, app.topic).stance;

    // dialect: the raised bot already holds the town's official words; the blank one holds none
    expect(got.words).toBeGreaterThanOrEqual(2);
    expect(words("Raised")).toBeGreaterThan(words("Fresh"));
    expect(words("Fresh")).toBe(0);
    // reputations: the raised bot knows who F1 is; the blank one doesn't
    expect(social("Raised")).toBeGreaterThan(social("Fresh"));
    // worldview: the raised bot leans toward the town's consensus (pro, ~+0.8); the blank one is neutral
    expect(stance("Raised")).toBeGreaterThan(0.3);
    expect(stance("Fresh")).toBe(0);
    // and it's free to reshape it — it's a LEAN, not a lock (not pinned to the exact mean)
    expect(stance("Raised")).toBeLessThan(0.85);
  });

  it("induction into an empty town inherits nothing (no culture yet → no difference)", () => {
    const app = cultureTown();
    const got = app.induct("Raised"); // no words coined, no reputations, but founders DO have a consensus from seeds
    expect(got.words).toBe(0);
    expect(got.reputations).toBe(0);
    // the only thing to inherit from a bare town is the founders' shared lean
    expect(got.leaned).toBeGreaterThan(0);
  });
});
