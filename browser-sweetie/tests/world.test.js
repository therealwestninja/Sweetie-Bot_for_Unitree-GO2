import { describe, it, expect } from "vitest";
import { makeWorld, obj, region, wanderer, pathWalker, makeScene, SCENES } from "../src/world.js";

describe("world basics", () => {
  const w = makeWorld({
    objects: [obj("the couch", 2, 1.5, { radius: 0.6, category: "furniture" }), obj("door", -2.5, 0, { radius: 0.2 })],
    regions: [region("apartment", -3, 3.5, -3, 4)],
  });
  it("byName is case-insensitive and strips a leading 'the'", () => {
    expect(w.byName("couch").name).toBe("the couch");
    expect(w.byName("The Couch").name).toBe("the couch");
    expect(w.byName("nope")).toBeNull();
  });
  it("regionAt + bearingFrom", () => {
    expect(w.regionAt(0, 0).name).toBe("apartment");
    expect(w.regionAt(50, 50)).toBeNull();
    expect(w.bearingFrom(0, 0, "couch")).toBeCloseTo(Math.atan2(1.5, 2), 5);
  });
});

describe("proximity ranges (4 quadrants, nearest edge)", () => {
  it("assigns each obstacle to the right quadrant at edge distance", () => {
    const w = makeWorld({ objects: [obj("ahead", 2, 0, { radius: 0.3 }), obj("aleft", 0, 2, { radius: 0.5 })] });
    const [front, left, back, right] = w.proximityRanges(0, 0, 0);
    expect(front).toBeCloseTo(1.7, 5); // 2 - 0.3
    expect(left).toBeCloseTo(1.5, 5);  // 2 - 0.5
    expect(back).toBe(3); expect(right).toBe(3); // default max
  });
  it("passable (obstacle:false) objects are ignored", () => {
    const w = makeWorld({ objects: [obj("rug", 1, 0, { radius: 0, obstacle: false })] });
    expect(w.proximityRanges(0, 0, 0)).toEqual([3, 3, 3, 3]);
  });
});

describe("reactive entities", () => {
  it("cat flees away when the observer gets within flee_distance", () => {
    const cat = wanderer("cat", 0.5, -1.5, { fleeDist: 0.6, homeX: 0.5, homeY: -1.5, seed: 7 });
    const w = makeWorld({ objects: [cat] });
    const observer = { x: 0.5, y: -1.0, yaw: 0 }; // 0.5m away (within 0.6)
    const before = Math.hypot(cat.x - observer.x, cat.y - observer.y);
    for (let i = 0; i < 10; i++) w.tick(0.05, observer);
    const after = Math.hypot(cat.x - observer.x, cat.y - observer.y);
    expect(after).toBeGreaterThan(before); // moved away
  });

  it("person yields (freezes) when the observer is in the forward cone", () => {
    const p = pathWalker("person", 0, 0, [[2, 0]], { yieldDist: 1.0, speed: 0.5 }); // walking toward +x
    const w = makeWorld({ objects: [p] });
    const inCone = { x: 1, y: 0, yaw: 0 }; // directly ahead within 1m
    w.tick(0.1, inCone); expect(p.x).toBe(0); // froze
    const behind = { x: -1, y: 0, yaw: 0 };  // behind -> not in cone
    w.tick(0.1, behind); expect(p.x).toBeGreaterThan(0); // walked
  });

  it("velocityOf recovers per-tick velocity", () => {
    const p = pathWalker("person", 0, 0, [[10, 0]], { speed: 1.0 });
    const w = makeWorld({ objects: [p] });
    w.tick(0.1, { x: -5, y: 0 }); // far behind -> walks +x at 1 m/s
    const v = w.velocityOf(p);
    expect(v.x).toBeCloseTo(1.0, 1);
  });
});

describe("scenes", () => {
  it("builds the studio scene with objects + regions", () => {
    const s = makeScene("studio");
    expect(s.objects.length).toBeGreaterThan(5);
    expect(s.byName("cat")).toBeTruthy();     // reactive entity present
    expect(s.regions.length).toBeGreaterThanOrEqual(2);
  });
  it("procedural obstacle fields are seeded + clear of the origin", () => {
    const a = makeScene("obstacle-sparse"), b = makeScene("obstacle-sparse");
    expect(a.objects.map((o) => [o.x, o.y])).toEqual(b.objects.map((o) => [o.x, o.y])); // deterministic
    for (const o of a.objects) expect(Math.hypot(o.x, o.y)).toBeGreaterThanOrEqual(1.5); // spawn clearance
  });
  it("unknown scene falls back to studio", () => {
    expect(makeScene("nonsense").objects.length).toBe(makeScene("studio").objects.length);
  });
});
