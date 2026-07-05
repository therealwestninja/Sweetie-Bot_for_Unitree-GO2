import { describe, it, expect } from "vitest";
import { makeLobbyChat } from "../src/agents/lobby.js";

// a stub colony whose bots carry a fixed mood (or no psyche)
const stub = (moods) => ({ agents: Object.entries(moods).map(([n, m]) => ({ name: n, mind: m ? { mood: () => m } : null })) });
const lc = (moods) => makeLobbyChat({ colony: stub(moods), society: { opinion: () => ({ stance: 0 }) }, persona: {}, mouth: null, topic: "x" });

describe("mood → dialogue — the neurochemistry finally colours what a bot SAYS", () => {
  it("a flat/withdrawn depression (low valence, low arousal) reads low and drained", () => {
    expect(lc({ A: { valence: -0.5, arousal: 0.3 } }).moodClause("A")).toMatch(/low and flat, drained/);
  });
  it("an agitated depression (low valence, HIGH arousal) reads tense and on edge — a DIFFERENT voice", () => {
    expect(lc({ A: { valence: -0.5, arousal: 0.8 } }).moodClause("A")).toMatch(/agitated and on edge/);
  });
  it("a content vs an elated bot read warm vs buoyant (valence up; arousal splits them)", () => {
    expect(lc({ A: { valence: 0.5, arousal: 0.3 } }).moodClause("A")).toMatch(/content and warm/);
    expect(lc({ A: { valence: 0.5, arousal: 0.7 } }).moodClause("A")).toMatch(/buoyant, almost elated/);
  });
  it("an even-keeled bot gets NO clause (the prompt stays clean near baseline)", () => {
    expect(lc({ A: { valence: 0.0, arousal: 0.4 } }).moodClause("A")).toBe("");
  });
  it("a bot with no psyche gets no clause (mood-coupling is opt-in per bot)", () => {
    expect(lc({ A: null }).moodClause("A")).toBe("");
  });
});
