import { describe, it, expect } from "vitest";
import { makeWorld, obj, wanderer } from "../src/world.js";
import { makeSimPerception } from "../src/perception.js";

describe("perception — FOV cone + occlusion", () => {
  it("sees objects inside the forward cone, not behind or outside it", () => {
    const w = makeWorld({ objects: [obj("ahead", 2, 0, { radius: 0.3 }), obj("behind", -2, 0, { radius: 0.3 }), obj("wayleft", 0, 3, { radius: 0.3 })] });
    const p = makeSimPerception({ world: w });
    expect(p.isVisible(w.byName("ahead"), 0, 0, 0)).toBe(true);
    expect(p.isVisible(w.byName("behind"), 0, 0, 0)).toBe(false);  // outside 70° cone
    expect(p.isVisible(w.byName("wayleft"), 0, 0, 0)).toBe(false); // 90° off-axis
  });

  it("a closer solid obstacle occludes the one behind it", () => {
    const withBlock = makeWorld({ objects: [obj("target", 4, 0, { radius: 0.3 }), obj("blocker", 2, 0, { radius: 0.5 })] });
    const p1 = makeSimPerception({ world: withBlock });
    expect(p1.isVisible(withBlock.byName("target"), 0, 0, 0)).toBe(false); // blocked
    const noBlock = makeWorld({ objects: [obj("target", 4, 0, { radius: 0.3 })] });
    const p2 = makeSimPerception({ world: noBlock });
    expect(p2.isVisible(noBlock.byName("target"), 0, 0, 0)).toBe(true);
  });

  it("hides tiny static clutter but not tiny dynamic entities", () => {
    const w = makeWorld({ objects: [obj("speck", 2, 0, { radius: 0.05 }), wanderer("bug", 2, 0.2, { radius: 0.05 })] });
    const p = makeSimPerception({ world: w });
    expect(p.isVisible(w.byName("speck"), 0, 0, 0)).toBe(false); // static + tiny
    expect(p.isVisible(w.byName("bug"), 0, 0, 0)).toBe(true);    // dynamic
  });
});

describe("perception — quadrants + events", () => {
  it("classifies quadrants relative to heading, 'far' beyond range", () => {
    const p = makeSimPerception({ world: makeWorld({}) });
    expect(p.classifyQuadrant(0, 0, 0, 2, 0)).toBe("front");
    expect(p.classifyQuadrant(0, 0, 0, 0, 2)).toBe("left");
    expect(p.classifyQuadrant(0, 0, 0, -2, 0)).toBe("back");
    expect(p.classifyQuadrant(0, 0, 0, 0, -2)).toBe("right");
    expect(p.classifyQuadrant(0, 0, 0, 20, 0)).toBe("far");
  });

  it("emits enter/exit-view events as the robot turns", () => {
    const w = makeWorld({ objects: [obj("box", 2, 0, { radius: 0.3 })] });
    const p = makeSimPerception({ world: w });
    p.tick(0, 0, 0);                         // facing +x -> box in view
    expect(p.drainNewEvents()).toContain("box entered view");
    p.tick(0, 0, 0);                         // same pose -> no new events
    expect(p.drainNewEvents()).toEqual([]);
    p.tick(0, 0, Math.PI);                   // turned around -> box out of view
    expect(p.drainNewEvents()).toContain("box left view");
  });

  it("visionSummary lists visible objects nearest-first with bearing", () => {
    // non-collinear so neither occludes the other; both inside the 70° cone
    const w = makeWorld({ objects: [obj("side", 3, 1.5, { radius: 0.3 }), obj("near", 1.5, 0, { radius: 0.3 })] });
    const p = makeSimPerception({ world: w });
    const s = p.visionSummary(0, 0, 0);
    expect(s.map((r) => r.name)).toEqual(["near", "side"]);   // nearest first
    expect(s[0].bearing_deg).toBeCloseTo(0, 1);                // near is dead ahead
    expect(s[1].bearing_deg).toBeCloseTo(26.6, 0);             // side ~ atan2(1.5,3)
  });
});
