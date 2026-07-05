import { describe, it, expect } from "vitest";
import { facesToVisible, emotionToAffect } from "../src/vision/faces.js";
import { makeEars } from "../src/audio/ears.js";
import { makeSoul } from "../src/face/soul.js";
import { makePsyche } from "../src/agents/psyche.js";

describe("faces → visible[] + emotion → affect", () => {
  it("maps face boxes to bearing (from x) and distance (from size); nearest is 'the visitor'", () => {
    const vis = facesToVisible([{ cx: 0.75, cy: 0.5, w: 0.1, h: 0.1 }, { cx: 0.5, cy: 0.5, w: 0.3, h: 0.3 }], { fovDeg: 60 });
    expect(vis[0].name).toBe("the visitor");            // the bigger (closer) face is you
    expect(vis[0].distance_m).toBeLessThan(vis[1].distance_m);
    expect(vis[1].bearing_deg).toBeCloseTo(15, 0);      // cx 0.75 → +25%·60° ≈ +15°
    expect(vis[0].category).toBe("person");
  });

  it("reads expression scores into valence/arousal + a label", () => {
    expect(emotionToAffect({ happy: 0.9, neutral: 0.1 }).valence).toBeGreaterThan(0.5);
    expect(emotionToAffect({ sad: 0.8, angry: 0.2 }).valence).toBeLessThan(-0.3);
    expect(emotionToAffect({ happy: 0.9, neutral: 0.1 }).label).toBe("happy");
    expect(emotionToAffect({ surprised: 0.9 }).arousal).toBeGreaterThan(0.5);
  });
});

describe("ears — startle from loudness", () => {
  it("flinches at a sudden rise, but habituates to steady noise", () => {
    const ears = makeEars({ startleRise: 0.2 });
    for (let i = 0; i < 10; i++) ears.hear(0.1);                 // quiet ambient
    expect(ears.hear(0.5).some((e) => e.kind === "startle")).toBe(true);   // BANG
    const loud = makeEars({ startleRise: 0.2 });
    for (let i = 0; i < 20; i++) loud.hear(0.6);                 // constant loud → habituated
    expect(loud.hear(0.62).length).toBe(0);
  });
});

describe("soul — mirrors YOUR mood (concern, not blame)", () => {
  const soul = () => makeSoul({ decider: { async decide() { return { arc: "QUIET", drive: {}, speech: null }; } }, psyche: makePsyche({ seed: 9 }), config: { warmEvery: 5 } });
  const seen = (affect) => ({ present: true, bearingDeg: 0, yourAffect: affect });

  it("your happy face lifts her mood; your sad face lowers it", async () => {
    const happy = soul(); for (let i = 0; i < 15; i++) await happy.tick({}, seen({ valence: 0.8, arousal: 0.4 }));
    const sad = soul(); for (let i = 0; i < 15; i++) await sad.tick({}, seen({ valence: -0.8, arousal: 0.3 }));
    expect(happy.mood().valence).toBeGreaterThan(sad.mood().valence);
  });

  it("mirroring your SADNESS does not make her resent you (she still warms to your presence)", async () => {
    const s = soul();
    for (let i = 0; i < 20; i++) await s.tick({}, seen({ valence: -0.7, arousal: 0.3 }));
    expect(s.feelAboutYou()).toBeGreaterThan(0);   // being there for her > her mood dipping in sympathy
  });
});
