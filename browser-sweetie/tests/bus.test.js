import { describe, it, expect } from "vitest";
import { makeBus } from "../src/bus.js";

describe("bus", () => {
  it("delivers to subscribers; unsubscribe stops delivery", () => {
    const bus = makeBus();
    const seen = [];
    const off = bus.subscribe("perception", (p) => seen.push(p.event));
    bus.publish("perception", { event: "cat entered view" });
    bus.publish("other", { event: "ignored" });
    off();
    bus.publish("perception", { event: "after unsub" });
    expect(seen).toEqual(["cat entered view"]);
  });

  it("a throwing handler is isolated — others still run", () => {
    const bus = makeBus();
    const seen = [];
    bus.subscribe("t", () => { throw new Error("bad handler"); });
    bus.subscribe("t", (p) => seen.push(p));
    expect(() => bus.publish("t", 42)).not.toThrow();
    expect(seen).toEqual([42]);
  });
});
