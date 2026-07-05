import { describe, it, expect } from "vitest";
import { planPath } from "../src/planner.js";

const clearOf = (wp, obstacles, clearance) => Math.min(...obstacles.map((o) => Math.hypot(wp.x - o.x, wp.y - o.y) - o.radius)) >= clearance - 0.26; // grid tolerance ~1 cell

describe("planner — A* global path", () => {
  it("routes AROUND an obstacle on the direct line, with every waypoint clear", () => {
    const obstacles = [{ x: 1.5, y: 0, radius: 0.5 }];
    const path = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, obstacles, { clearance: 0.4 });
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThan(1);
    expect(Math.max(...path.map((w) => Math.abs(w.y)))).toBeGreaterThan(0.4); // detoured off the centre line
    for (const w of path.slice(0, -1)) expect(clearOf(w, obstacles, 0.4)).toBe(true); // no waypoint inside an obstacle
    const end = path[path.length - 1];
    expect(Math.hypot(end.x - 3, end.y)).toBeLessThan(0.01); // ends at the true goal
  });

  it("finds a route through a gap in a wall", () => {
    const wall = [];
    for (let y = -2; y <= 2; y += 0.4) if (Math.abs(y) > 0.5) wall.push({ x: 1.5, y, radius: 0.25 }); // gap around y=0
    const path = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, wall, { clearance: 0.3 });
    expect(path).not.toBeNull();
    for (const w of path.slice(0, -1)) expect(clearOf(w, wall, 0.3)).toBe(true);
  });

  it("returns null when the goal is boxed in", () => {
    const box = [];
    for (let a = 0; a < Math.PI * 2; a += 0.3) box.push({ x: 3 + Math.cos(a) * 0.8, y: Math.sin(a) * 0.8, radius: 0.3 }); // ring around the goal
    expect(planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, box, { clearance: 0.3 })).toBeNull();
  });

  it("a clear field yields a near-straight path (few waypoints)", () => {
    const path = planPath({ x: 0, y: 0 }, { x: 3, y: 0 }, [], { clearance: 0.4 });
    expect(path).not.toBeNull();
    expect(path.length).toBeLessThanOrEqual(2);            // string-pulled to ~just the goal
    expect(Math.max(...path.map((w) => Math.abs(w.y)))).toBeLessThan(0.3); // straight
  });
});
