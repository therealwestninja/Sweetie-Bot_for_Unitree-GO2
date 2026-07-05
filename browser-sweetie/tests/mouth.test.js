import { describe, it, expect } from "vitest";
import { makeMouth } from "../src/agents/mouth.js";
import { makeScheduler } from "../src/agents/scheduler.js";

const mockBackend = (fn) => ({ name: "mock", async generate({ messages }) { return fn ? fn(messages) : "ok:" + messages[messages.length - 1].content; } });

describe("mouth — shared service + record/replay", () => {
  it("routes generation through the scheduler and returns the backend output", async () => {
    const s = makeScheduler({ concurrency: 1 });
    const m = makeMouth({ backend: mockBackend(), scheduler: s, mode: "record" });
    const out = await m.line("hello", { tag: "greet" });
    expect(out).toBe("ok:hello");
    expect(m.transcript()).toHaveLength(1);
    expect(m.transcript()[0].tag).toBe("greet");
  });

  it("serialises many callers through one slot (no backend stampede)", async () => {
    let active = 0, maxActive = 0;
    const backend = { name: "slow", async generate() { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return "x"; } };
    const s = makeScheduler({ concurrency: 1 });
    const m = makeMouth({ backend, scheduler: s });
    await Promise.all([m.line("a"), m.line("b"), m.line("c"), m.line("d")]);
    expect(maxActive).toBe(1); // never two backend calls at once
  });

  it("replay reproduces recorded outputs without touching the backend", async () => {
    const rec = makeMouth({ backend: mockBackend((m) => "live:" + m[0].content), mode: "record" });
    await rec.line("a", { tag: "x" });
    await rec.line("b", { tag: "y" });
    const log = rec.transcript();

    const dead = { name: "dead", generate() { throw new Error("backend must not be called during replay"); } };
    const rep = makeMouth({ backend: dead, mode: "replay", log });
    expect(await rep.line("a", { tag: "x" })).toBe("live:a");
    expect(await rep.line("b", { tag: "y" })).toBe("live:b");
  });
});
