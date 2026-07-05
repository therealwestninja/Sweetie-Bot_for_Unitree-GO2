import { describe, it, expect } from "vitest";
import { makeIdleDriver } from "../src/idleDriver.js";

// A deterministic scheduler: advance(ms) runs due callbacks (including async ones) in time order.
function fakeSched() {
  let now = 0; let q = [];
  return {
    now: () => now,
    defer: (fn, ms) => { const item = { fn, at: now + ms, cancelled: false }; q.push(item); return () => { item.cancelled = true; }; },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const live = q.filter((i) => !i.cancelled && i.at <= target).sort((a, b) => a.at - b.at);
        if (!live.length) break;
        const next = live[0]; next.cancelled = true; now = next.at;
        const r = next.fn(); if (r && r.then) await r;
      }
      now = target;
    },
  };
}

describe("idleDriver — adaptive pacer", () => {
  it("polls near the floor right after input and relaxes toward the ceil as silence grows", () => {
    const s = fakeSched();
    const d = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => {}, config: { floorMs: 100, ceilMs: 700, seedAvgGapMs: 500, seedGapVarMs: 400 } });
    d.notifyInput(0);
    expect(d.nextDelay(0)).toBeLessThanOrEqual(120);   // just spoke → responsive
    const relaxed = d.nextDelay(3000);                 // long silence → relaxed
    expect(relaxed).toBeGreaterThan(d.nextDelay(0));
    expect(relaxed).toBeLessThanOrEqual(700);
  });

  it("declares a FAST-tempo human idle sooner (in ms) than a SLOW-tempo one", () => {
    const s = fakeSched();
    const fast = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => {}, config: { seedAvgGapMs: 400, seedGapVarMs: 200, idleZ: 1.2 } });
    const slow = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => {}, config: { seedAvgGapMs: 8000, seedGapVarMs: 3000, idleZ: 1.2 } });
    fast.notifyInput(0); slow.notifyInput(0);
    // find the ms at which each first reads idle
    const idleAt = (drv) => { for (let t = 100; t <= 30000; t += 100) if (drv.isIdle(t)) return t; return Infinity; };
    expect(idleAt(fast)).toBeLessThan(idleAt(slow));
  });
});

describe("idleDriver — gating & interrupt discipline", () => {
  it("the spin-up settle guard suppresses the first would-be turn (no fire from boot state)", async () => {
    const s = fakeSched();
    let turns = 0;
    const d = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => { turns++; }, config: { floorMs: 100, ceilMs: 300, seedAvgGapMs: 100, seedGapVarMs: 50, minGapVarMs: 50, aiFloorMs: 0, settleCycles: 1 } });
    d.start(0);          // schedules first tick at ceil (300) — that tick only observes
    await s.advance(350);
    expect(turns).toBe(0); // settle cycle consumed, nothing fired yet
    await s.advance(400);  // next tick may fire
    expect(turns).toBeGreaterThanOrEqual(1);
  });

  it("the AI-cadence floor stops autonomous turns from out-running the poll", async () => {
    const s = fakeSched();
    let turns = 0;
    const d = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => { turns++; }, config: { floorMs: 50, ceilMs: 50, seedAvgGapMs: 10, seedGapVarMs: 10, minGapVarMs: 10, aiFloorMs: 1000, settleCycles: 0 } });
    d.start(0);
    await s.advance(1200); // ~24 poll ticks, but aiFloor=1000ms
    expect(turns).toBeGreaterThanOrEqual(1); // it DID fire (idle reached)
    expect(turns).toBeLessThanOrEqual(2);    // at most ~1 per 1000ms, not one per tick
  });

  it("an input WHILE an autonomous turn composes discards it (commit-point revalidation)", async () => {
    const s = fakeSched();
    let committed = 0, discarded = 0;
    const d = makeIdleDriver({
      clock: s, defer: s.defer,
      onIdleTurn: async ({ isCurrent }) => {
        // simulate a slow compose; a real input arrives mid-flight
        d.notifyInput(s.now());       // interrupt during composition → bumps epoch
        if (isCurrent()) committed++; else discarded++;
      },
      config: { floorMs: 50, ceilMs: 200, seedAvgGapMs: 20, seedGapVarMs: 10, minGapVarMs: 15, aiFloorMs: 0, settleCycles: 0 },
    });
    d.start(0);
    await s.advance(600);
    expect(discarded).toBeGreaterThanOrEqual(1);
    expect(committed).toBe(0); // every turn that self-interrupted was correctly discarded
  });

  it("notifyInput updates the rhythm EWMA and bumps the interrupt epoch", () => {
    const s = fakeSched();
    const d = makeIdleDriver({ clock: s, defer: s.defer, onIdleTurn: async () => {}, config: { seedAvgGapMs: 1000, seedGapVarMs: 500 } });
    const e0 = d.epoch();
    d.notifyInput(0); d.notifyInput(200); d.notifyInput(400); // steady 200ms tempo
    expect(d.rhythm().avgGap).toBeLessThan(1000); // pulled down toward the observed 200ms
    expect(d.epoch()).toBeGreaterThan(e0);
  });
});
