import { describe, it, expect } from "vitest";
import { makeColonyClock, PHASES } from "../src/agents/clock.js";

describe("colony clock — deterministic day/night phase machine", () => {
  it("is a no-op when disabled (eternal day, everyone awake)", () => {
    const c = makeColonyClock();                       // enabled defaults to false
    expect(c.phase()).toBe("day");
    for (const t of ["lark", "default", "owl", "whatever"]) expect(c.isAwake(t)).toBe(true);
    const r = c.tick();
    expect(r.changed).toBe(false);
    expect(c.phase()).toBe("day");                     // still day, never advances
  });

  it("walks the four equal-width phases across one cycle", () => {
    const c = makeColonyClock({ enabled: true, cycleTicks: 8 }); // 2 ticks per phase
    const seen = [c.phase()];
    for (let i = 0; i < 8; i++) seen.push(c.tick().phase);
    // ticks 0..1 dawn, 2..3 day, 4..5 dusk, 6..7 night, then wraps to dawn
    expect(seen).toEqual(["dawn", "dawn", "day", "day", "dusk", "dusk", "night", "night", "dawn"]);
  });

  it("reports a phase change exactly on the boundary", () => {
    const c = makeColonyClock({ enabled: true, cycleTicks: 8 });
    expect(c.tick().changed).toBe(false); // 0→1 still dawn
    expect(c.tick().changed).toBe(true);  // 1→2 dawn→day
    expect(c.tick().changed).toBe(false); // 2→3 still day
  });

  it("staggers chronotypes so dawn and night are single-group, day/dusk overlap", () => {
    const c = makeColonyClock({ enabled: true, cycleTicks: 4 }); // 1 tick per phase, start at dawn
    const awakeAt = () => PHASES.filter(() => true) && ["lark", "default", "owl"].filter((ct) => c.isAwake(ct));
    expect(awakeAt()).toEqual(["lark"]);            // dawn — only larks
    c.tick(); expect(awakeAt()).toEqual(["lark", "default"]); // day
    c.tick(); expect(awakeAt()).toEqual(["default", "owl"]);  // dusk
    c.tick(); expect(awakeAt()).toEqual(["owl"]);   // night — only owls
  });

  it("honours a startTick (resume mid-cycle) and wraps negatives", () => {
    expect(makeColonyClock({ enabled: true, cycleTicks: 4, startTick: 3 }).phase()).toBe("night");
    expect(makeColonyClock({ enabled: true, cycleTicks: 4, startTick: -1 }).phase()).toBe("night");
  });
});
