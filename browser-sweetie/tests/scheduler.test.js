import { describe, it, expect } from "vitest";
import { makeScheduler } from "../src/agents/scheduler.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("scheduler — priority, concurrency, stale, rate-limit", () => {
  it("runs queued jobs highest-priority first (behind a held slot)", async () => {
    const s = makeScheduler({ concurrency: 1 });
    const order = [];
    let release; const blocker = new Promise((r) => (release = r));
    const pB = s.enqueue({ run: () => blocker, priority: 1000 });        // hold the only slot while we queue
    const ps = [
      s.enqueue({ run: async () => order.push("low"), priority: 10 }),
      s.enqueue({ run: async () => order.push("high"), priority: 100 }),
      s.enqueue({ run: async () => order.push("mid"), priority: 50 }),
    ];
    release();
    await Promise.all([pB, ...ps]);
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("respects the concurrency cap", async () => {
    const s = makeScheduler({ concurrency: 2 });
    const gates = [0, 1, 2].map(() => { let rel; const pr = new Promise((r) => (rel = r)); return { pr, rel }; });
    const ps = gates.map((g) => s.enqueue({ run: () => g.pr }));
    await flush();
    expect(s.inFlight).toBe(2);
    expect(s.queued).toBe(1);
    gates.forEach((g) => g.rel());
    await Promise.all(ps);
    expect(s.stats().ran).toBe(3);
  });

  it("drops a stale job unrun (commit-point revalidation)", async () => {
    const s = makeScheduler({ concurrency: 1 });
    let ran = false;
    let release; const blocker = new Promise((r) => (release = r));
    const pB = s.enqueue({ run: () => blocker, priority: 100 });
    const pStale = s.enqueue({ run: async () => { ran = true; }, priority: 50, stale: () => true });
    release();
    const res = await pStale; await pB;
    expect(ran).toBe(false);
    expect(res).toBeNull();
    expect(s.stats().dropped).toBe(1);
  });

  it("rate-limits starts to a minimum interval", async () => {
    let now = 0; const timers = [];
    const s = makeScheduler({ concurrency: 1, minIntervalMs: 100, now: () => now, defer: (fn, ms) => { const it = { fn, at: now + ms, c: false }; timers.push(it); return () => (it.c = true); } });
    const starts = [];
    const ps = [0, 1, 2].map(() => s.enqueue({ run: async () => { starts.push(now); } }));
    async function advance(ms) { const target = now + ms; for (;;) { await flush(); const due = timers.filter((t) => !t.c && t.at <= target).sort((a, b) => a.at - b.at); if (!due.length) break; const t = due[0]; t.c = true; now = t.at; t.fn(); } now = target; }
    await advance(500);
    await Promise.all(ps);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThanOrEqual(100);
    expect(starts[2]).toBeGreaterThanOrEqual(200);
  });
});
