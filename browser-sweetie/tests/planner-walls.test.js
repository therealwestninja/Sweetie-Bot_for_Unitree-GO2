import { describe, it, expect } from "vitest";
import { planPath } from "../src/planner.js";

// The street redesign relies on the planner routing through building doorways + the crosswalk. These pin that:
// a wall blocks, a doorway/crosswalk opening carves a passable gap, and the route goes THROUGH the gap.
describe("planner — walls block, openings (doorways / crosswalk) let bots through", () => {
  const bounds = { minX: -4, maxX: 4, minY: -3, maxY: 3 };
  const wall = { x: 0, y: 0, w: 0.3, h: 6.5 };   // a full-height wall across the middle (can't go around it)

  it("routes THROUGH a doorway gap in the wall", () => {
    const door = { x: 0, y: 0, w: 0.3, h: 1.2 }; // a gap around y=0
    const p = planPath({ x: -3, y: 2 }, { x: 3, y: 2 }, [], { bounds, cell: 0.2, walls: [wall], openings: [door], wallClear: 0.25 });
    expect(p).toBeTruthy();
    expect(p.some((w) => Math.abs(w.y) < 0.9)).toBe(true); // detoured down to the door near y=0 to cross
  });

  it("a wall with NO opening is impassable (null)", () => {
    const p = planPath({ x: -3, y: 2 }, { x: 3, y: 2 }, [], { bounds, cell: 0.2, walls: [wall], openings: [], wallClear: 0.25 });
    expect(p).toBeNull();
  });

  it("with no walls it's a straight shot (backward compatible)", () => {
    const p = planPath({ x: -3, y: 2 }, { x: 3, y: 2 }, [], { bounds, cell: 0.2 });
    expect(p).toBeTruthy();
    expect(p[p.length - 1]).toEqual({ x: 3, y: 2 });
  });
});
