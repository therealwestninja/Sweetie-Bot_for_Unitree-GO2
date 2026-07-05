import { describe, it, expect } from "vitest";
import { makeProgress } from "../src/agents/progress.js";
import { makePsyche } from "../src/agents/psyche.js";

describe("progress — the reusable bar for long runs", () => {
  it("renders a growing bar with %, count, and reaches 100% on done", () => {
    const lines = []; let t = 0;
    const p = makeProgress({ total: 10, label: "run", sink: (s) => lines.push(s), now: () => (t += 1000) });
    p.tick(3);
    expect(lines.at(-1)).toMatch(/^run \[/);
    expect(lines.at(-1)).toMatch(/30% · 3\/10/);
    p.set(10);
    expect(lines.at(-1)).toMatch(/100% · 10\/10/);
    const final = p.done("healed");
    expect(final).toMatch(/100%/);
    expect(final).toMatch(/healed/);
  });

  it("shows an ETA computed from elapsed time", () => {
    const seen = []; let t = 0;
    const p = makeProgress({ total: 100, sink: (s) => seen.push(s), now: () => (t += 1000) });
    p.set(25);
    expect(seen.at(-1)).toMatch(/ETA/);
  });
});

describe("psyche lesion/heal — the Disorders Lab perturbation", () => {
  it("lowers a channel's setpoint; homeostasis pulls the level toward it; heal restores it exactly", () => {
    const p = makePsyche({ seed: 7 });
    const before = p.channel("dopamine").setpoint;
    expect(p.lesion("dopamine", 0.02)).toBe(true);
    expect(p.channel("dopamine").setpoint).toBeCloseTo(0.02, 3);
    for (let i = 0; i < 40; i++) p.chem.tick();                 // let the field decay toward the new setpoint
    expect(p.channel("dopamine").level).toBeLessThan(before);   // the level actually fell (the "lesion" took hold)
    expect(p.channel("dopamine").level).toBeCloseTo(0.02, 1);
    expect(p.lesioned().dopamine).toBeCloseTo(before, 3);       // it remembers the healthy value
    p.heal("dopamine");
    expect(p.channel("dopamine").setpoint).toBeCloseTo(before, 3);
    expect(Object.keys(p.lesioned()).length).toBe(0);
  });

  it("dopamine depletion drives mood valence DOWN — the cascade the lab visualises", () => {
    const p = makePsyche({ seed: 3 });
    const v0 = p.mood().valence;
    p.lesion("dopamine", 0.02);
    for (let i = 0; i < 60; i++) p.chem.tick();
    expect(p.mood().valence).toBeLessThan(v0);                  // channel-loss → mood follows it down
  });

  it("heal() with no argument lifts every active lesion", () => {
    const p = makePsyche({ seed: 5 });
    p.lesion("dopamine", 0.02); p.lesion("serotonin", 0.1);
    expect(Object.keys(p.lesioned()).length).toBe(2);
    p.heal();
    expect(Object.keys(p.lesioned()).length).toBe(0);
  });
});
