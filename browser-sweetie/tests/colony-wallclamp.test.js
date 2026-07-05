import { describe, it, expect } from "vitest";
import { makeColony } from "../src/agents/colony.js";

// one shop at (0,4), 2.8×2, door on the SOUTH face — same shape colony.html's building() makes
const WT = 0.24;
const shopWalls = [
  { x: 0, y: 5, w: 2.8, h: WT },      // N
  { x: 0, y: 3, w: 2.8, h: WT },      // S (has the door)
  { x: -1.4, y: 4, w: WT, h: 2 },     // W
  { x: 1.4, y: 4, w: WT, h: 2 },      // E
];
const door = { x: 0, y: 3, w: 1.05, h: WT * 3 };            // doorway gap in the south wall
const road = { x: 0, y: 1, w: 26, h: 1.6 };                 // a THICK road band (must NOT be clamped)
const BOUNDS = { minX: -15, maxX: 15, minY: -15, maxY: 15 }; // wide, so bounds-clamp never interferes

const colonyWith = (pose) => makeColony({ walls: [...shopWalls, road], openings: [door], bounds: BOUNDS, bots: [{ name: "B", pose: { ...pose, yaw: 0 } }] });
const poseAfterTick = (pose) => { const c = colonyWith(pose); c.tick(0.02); return c.agents[0].mover.pose; };

describe("colony — steering-proof wall clamp (keeps bots out of building facades)", () => {
  it("pushes a bot shoved INTO a solid wall back out its nearest face", () => {
    const p = poseAfterTick({ x: -1.45, y: 4 });  // planted inside the WEST wall
    expect(p.x).toBeLessThan(-1.52);              // ejected out the west face (wall outer edge is -1.52)
  });

  it("leaves a bot passing through the DOORWAY opening untouched", () => {
    const p = poseAfterTick({ x: 0, y: 3 });      // dead centre of the south wall — but that's the door
    expect(p.x).toBeCloseTo(0, 6); expect(p.y).toBeCloseTo(3, 6);
  });

  it("does not touch a bot walking free on the sidewalk", () => {
    const p = poseAfterTick({ x: 0, y: 2 });      // below the shop, in no wall
    expect(p.x).toBeCloseTo(0, 6); expect(p.y).toBeCloseTo(2, 6);
  });

  it("does NOT clamp the thick ROAD band — that stays under the crosswalk gate, not the clamp", () => {
    const p = poseAfterTick({ x: 5, y: 1 });      // in the road, away from any crosswalk
    expect(p.x).toBeCloseTo(5, 6); expect(p.y).toBeCloseTo(1, 6);
  });
});
