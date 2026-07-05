import { describe, it, expect } from "vitest";
import { makeSoul } from "../src/face/soul.js";
import { makePsyche } from "../src/agents/psyche.js";

// a mock decider: quiet by default so the soul's OWN lines (greet/lonely) are what surface
const quietDecider = { async decide() { return { arc: "QUIET", drive: {}, speech: null, intents: [], proposed: [] }; } };
const seen = { present: true, bearingDeg: 5 }, gone = { present: false };
const soul = (over = {}) => makeSoul({ decider: quietDecider, psyche: makePsyche({ seed: 3 }), config: { lonelyAfter: 20, lonelyEvery: 20, warmEvery: 5 }, ...over });

describe("soul — the webcam companion's inner life", () => {
  it("being seen for a while WARMS how she feels about you", async () => {
    const s = soul(); const before = s.feelAboutYou();
    for (let i = 0; i < 30; i++) await s.tick({}, seen);
    expect(s.feelAboutYou()).toBeGreaterThan(before);
    expect(s.feelAboutYou()).toBeGreaterThan(0.1);
  });

  it("a long absence makes her LONELY — mood drops and she says so, unprompted", async () => {
    const s = soul();
    for (let i = 0; i < 10; i++) await s.tick({}, seen);        // together a bit
    const moodWith = s.mood().valence;
    let lonelyLine = null;
    for (let i = 0; i < 40; i++) { const r = await s.tick({}, gone); if (r.kind === "lonely") lonelyLine = r.line; }
    expect(lonelyLine).toMatch(/watching the door/);
    expect(s.mood().valence).toBeLessThan(moodWith);
  });

  it("when you return after being missed, she GREETS you warmly", async () => {
    const s = soul();
    for (let i = 0; i < 30; i++) await s.tick({}, seen);        // build fondness first
    for (let i = 0; i < 30; i++) await s.tick({}, gone);        // then you leave long enough to be missed
    const r = await s.tick({}, seen);                          // …and come back
    expect(r.kind).toBe("greet");
    expect(r.line).toMatch(/back/i);
  });

  it("she REMEMBERS you across a session (snapshot → restore into a fresh soul)", async () => {
    const a = soul();
    for (let i = 0; i < 30; i++) await a.tick({}, seen);
    const snap = a.snapshot();
    const b = soul(); expect(b.feelAboutYou()).toBe(0);         // a stranger, at first
    b.restore(snap);
    expect(b.feelAboutYou()).toBeGreaterThan(0.1);              // …now she knows you
  });

  it("talking to her routes a reply through the mouth and warms her toward you", async () => {
    const mouth = { async decide(f, o) { return { arc: "RESPOND", drive: {}, speech: "hi friend!", intents: [], proposed: o && o.prompt ? ["you like tea"] : [] }; } };
    const s = soul({ decider: mouth });
    const before = s.feelAboutYou();
    const r = await s.converse("hello, I like tea", {});
    expect(r.speech).toBe("hi friend!");
    expect(r.proposed).toContain("you like tea");
    expect(s.feelAboutYou()).toBeGreaterThan(before);
  });
});
