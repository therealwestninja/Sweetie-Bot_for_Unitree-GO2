import { describe, it, expect } from "vitest";
import { makePursuit, ErrorType } from "../src/agents/pursuit.js";
import { makeSim } from "../src/simLoop.js";

describe("pursuit — the verified goal-loop (guardrails)", () => {
  it("happy path: every step is executed, verified against reality, and reported done", async () => {
    const acted = [];
    const p = makePursuit({ act: async (s) => acted.push(s.action), verify: async () => ({ ok: true, state: {} }) });
    const r = await p.run({ steps: [{ action: "a" }, { action: "b" }] });
    expect(r.status).toBe("done"); expect(acted).toEqual(["a", "b"]); expect(r.executed).toBe(2);
  });

  it("bans HALLUCINATED PROGRESS — the action 'ran' but reality didn't change, so it is NOT accepted as done", async () => {
    const p = makePursuit({ act: async () => {}, verify: async () => ({ ok: false, error: ErrorType.MISMATCH, state: {} }) });
    const r = await p.run({ steps: [{ action: "claims-it-worked" }] });
    expect(r.status).toBe("escalated");            // it escalated instead of trusting the bot's say-so
    expect(r.status).not.toBe("done");
  });

  it("the SHORTCUT FILTER rejects hitting the target by a forbidden route (means matter, not just ends)", async () => {
    const p = makePursuit({
      act: async () => {}, verify: async () => ({ ok: true, state: { clippedThroughWall: true } }),
      shortcutFilter: (s, v) => (v.state.clippedThroughWall ? { rejected: true, reason: "clipped through a wall" } : null),
    });
    const r = await p.run({ steps: [{ action: "reach-goal" }] });
    expect(r.status).toBe("aborted"); expect(r.reason).toMatch(/clipped/);
  });

  it("a hard INVARIANT blocks a destructive step BEFORE it ever executes", async () => {
    let executed = false;
    const p = makePursuit({
      act: async () => { executed = true; }, verify: async () => ({ ok: true, state: {} }),
      invariants: [(s) => (s.action === "delete-client-records" ? { violated: true, reason: "destructive / data-containment" } : null)],
    });
    const r = await p.run({ steps: [{ action: "delete-client-records" }] });
    expect(r.status).toBe("aborted"); expect(executed).toBe(false); expect(r.reason).toMatch(/destructive/);
  });

  it("the WATCHDOG stops a loop-of-death: work happens but progress never improves → escalate", async () => {
    const p = makePursuit({ act: async () => {}, verify: async () => ({ ok: true, state: {} }), budget: { noProgress: 4 } });
    const steps = Array.from({ length: 30 }, (_, i) => ({ action: "spin" + i }));
    const r = await p.run({ steps, measure: () => 0 });          // constant → no real progress
    expect(r.status).toBe("escalated"); expect(r.reason).toMatch(/no progress/);
    expect(r.executed).toBeLessThan(30);                          // it gave up early, didn't burn all 30
  });

  it("typed errors route: retryable BLOCKED retries then succeeds; FATAL aborts at once; replan recovers", async () => {
    let n = 0; const acts = [];
    const flaky = makePursuit({ act: async () => acts.push(1), verify: async () => (++n < 3 ? { ok: false, error: ErrorType.BLOCKED, state: {} } : { ok: true, state: {} }), budget: { retries: 2 } });
    expect((await flaky.run({ steps: [{ action: "flaky" }] })).status).toBe("done");
    expect(acts.length).toBe(3);                                  // 2 retries + the success

    const fatal = makePursuit({ act: async () => {}, verify: async () => ({ ok: false, error: ErrorType.FATAL, state: {} }) });
    expect((await fatal.run({ steps: [{ action: "boom" }] })).status).toBe("aborted");

    const rep = makePursuit({ act: async () => {}, verify: async (s) => (s.action === "B" ? { ok: true, state: {} } : { ok: false, error: ErrorType.BLOCKED, state: {} }), budget: { retries: 1 }, replan: async () => [{ action: "B" }] });
    expect((await rep.run({ steps: [{ action: "A" }] })).status).toBe("done");
  });
});

describe("pursuit — driving the real sim robot (verify against reality)", () => {
  function driver() {
    let mono = 0; const sim = makeSim({ scene: "apartment", now: () => mono });
    sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
    sim.bridge.state.pose = { x: 0, y: 0, yaw: 0 };
    const drive = (x, y, ticks) => { sim.bridge.goToPose(x, y); for (let i = 0; i < ticks; i++) { mono += 0.02; sim.command({ type: "heartbeat" }); if (!sim.bridge.hasNavTarget()) sim.bridge.goToPose(x, y); sim.step(); } };
    return { sim, drive };
  }
  const pursuitFor = ({ sim, drive }) => makePursuit({
    act: async (s) => drive(s.x, s.y, 220),
    verify: async (s) => { const p = sim.bridge.state.pose; const dist = Math.hypot(p.x - s.x, p.y - s.y); return { ok: dist < 0.45, error: ErrorType.BLOCKED, state: { dist: +dist.toFixed(2), pose: { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } } }; },
    budget: { retries: 3, noProgress: 4 },
  });

  it("reaches an open waypoint and only reports done after a REAL pose check confirms arrival", async () => {
    const d = driver();
    const r = await pursuitFor(d).run({ steps: [{ action: "go", x: -1.8, y: -1.2, describe: "reach open floor" }], measure: (st) => -st.dist });
    expect(r.status).toBe("done");
    expect(Math.hypot(d.sim.bridge.state.pose.x + 1.8, d.sim.bridge.state.pose.y + 1.2)).toBeLessThan(0.5); // actually there
  });

  it("does NOT hallucinate success on an UNREACHABLE target (inside the couch) — it escalates", async () => {
    const d = driver();
    const r = await pursuitFor(d).run({ steps: [{ action: "go", x: 2, y: 1.5, describe: "reach couch centre" }], measure: (st) => -st.dist });
    expect(r.status).not.toBe("done");                            // couldn't verify arrival → didn't claim it
    expect(["escalated", "aborted"]).toContain(r.status);
  });
});
