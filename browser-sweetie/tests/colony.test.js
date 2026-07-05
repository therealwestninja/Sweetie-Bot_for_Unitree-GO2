import { describe, it, expect } from "vitest";
import { makeColony } from "../src/agents/colony.js";

function arena() {
  const statics = [{ name: "table", x: 0, y: 0, radius: 0.7 }];
  const zones = [
    { name: "north", x: 0, y: 3.2, radius: 1.3, purpose: "plans" },
    { name: "east", x: 3.2, y: 0, radius: 1.3, purpose: "lore" },
    { name: "south", x: 0, y: -3.2, radius: 1.3, purpose: "strategy" },
    { name: "west", x: -3.2, y: 0, radius: 1.3, purpose: "rest" },
  ];
  const bots = ["a", "b", "c", "d", "e", "f"].map((name, i) => ({ name, pose: { x: -2.5 + i * 1.0, y: 1.5 } })); // clear of table + zones
  return makeColony({ statics, zones, bots });
}

// step until all arrive (or cap), tracking the closest approach between any two bots the whole time
function settle(colony, cap = 4000) {
  let minSep = Infinity;
  for (let i = 0; i < cap; i++) { colony.tick(0.02); minSep = Math.min(minSep, colony.minSeparation()); if (colony.allArrived()) break; }
  return minSep;
}

describe("colony — bots navigate between lobbies without collision", () => {
  it("a distributed assignment: everyone reaches their lobby, no overlaps en route", () => {
    const c = arena();
    [["a", "north"], ["b", "north"], ["c", "east"], ["d", "east"], ["e", "south"], ["f", "south"]].forEach(([b, z]) => c.sendTo(b, z));
    const minSep = settle(c);
    expect(minSep).toBeGreaterThan(2 * c.botRadius - 0.04); // never meaningfully overlapped (2·r ≈ 0.56)
    expect(c.allArrived()).toBe(true);
    // each bot ended up inside the lobby it was sent to
    for (const a of c.agents) expect(c.zoneOf(a.mover.pose)).toBe(a.targetZone);
    expect(c.lobbies().north.sort()).toEqual(["a", "b"]);
  });

  it("cross-traffic migration: swapping two lobbies' groups stays collision-free while paths intersect", () => {
    const c = arena();
    [["a", "west"], ["b", "west"], ["c", "east"], ["d", "east"]].forEach(([b, z]) => c.sendTo(b, z));
    c.sendTo("e", "north"); c.sendTo("f", "south");
    settle(c);
    // now swap east<->west (the two groups must cross the arena through the middle)
    ["a", "b"].forEach((b) => c.sendTo(b, "east"));
    ["c", "d"].forEach((b) => c.sendTo(b, "west"));
    const minSep = settle(c);
    expect(minSep).toBeGreaterThan(2 * c.botRadius - 0.04); // no collision during the crossing
    expect(c.zoneOf(c.agents.find((a) => a.name === "a").mover.pose)).toBe("east");
    expect(c.zoneOf(c.agents.find((a) => a.name === "c").mover.pose)).toBe("west");
  });

  it("knows which lobby each bot is in and groups them", () => {
    const c = arena();
    [["a", "north"], ["b", "north"], ["c", "east"], ["d", "south"], ["e", "south"], ["f", "west"]].forEach(([b, z]) => c.sendTo(b, z));
    settle(c);
    const lob = c.lobbies();
    expect(lob.north.sort()).toEqual(["a", "b"]);
    expect(lob.east).toEqual(["c"]);
    expect(lob.west).toEqual(["f"]);
  });
});
