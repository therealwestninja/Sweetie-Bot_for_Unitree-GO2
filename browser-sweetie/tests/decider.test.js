import { describe, it, expect } from "vitest";
import { makeDecider } from "../src/decider.js";
import { makeMemoryGate } from "../src/memoryGate.js";
import { makeDeclarativeStore } from "../../../brain/src/declarativeStore.js";
import { makeMemoryStorage } from "../../../brain/src/storage.js";
import { makeHashEmbedder } from "../../../brain/src/embedder.js";

const mock = (reply) => ({ name: "mock", async generate() { return reply; } });
const frame = (over = {}) => ({ pose: { x: 0, y: 0, yaw: 0 }, ranges: [3, 3, 3, 3], battery: 90, safety: "active", mode: "standing", visible: [], events: [], ...over });

describe("decider — the portable Go2 cognition core (frame → decision)", () => {
  it("an obstacle in the bubble → an EMERGENCY halt intent, no LLM", async () => {
    const d = makeDecider({ backend: null });
    const r = await d.decide(frame({ ranges: [0.3, 3, 3, 3], visible: [{ name: "the wall", distance_m: 0.3, bearing_deg: 0, category: "fixture", dynamic: false }] }));
    expect(r.arc).toBe("EMERGENCY");
    expect(r.intents.some((i) => i.tool === "halt")).toBe(true);
    expect(r.speech).toMatch(/too close/);
  });

  it("a human line drives a safety-gated motor intent through the mouth (the /decide supervisor path)", async () => {
    const d = makeDecider({ backend: mock("I see you! look_at(the cat)") });
    const r = await d.decide(frame({ visible: [{ name: "the cat", distance_m: 1.2, bearing_deg: 5, category: "animal", dynamic: true }] }), { prompt: "look at the cat" });
    const look = r.intents.find((i) => i.tool === "look_at");
    expect(look).toBeTruthy(); expect(look.ok).toBe(true); expect(look.args[0]).toBe("the cat");
    expect(r.speech).toMatch(/see you/);
  });

  it("the SAME intent is gated OFF when the robot reports it is not armed (safety respected)", async () => {
    const d = makeDecider({ backend: mock("look_at(the cat)") });
    const r = await d.decide(frame({ safety: "idle" }), { prompt: "look at the cat" });
    const look = r.intents.find((i) => i.tool === "look_at");
    expect(look.ok).toBe(false); expect(look.reason).toMatch(/not armed/);
  });

  it("a remember(...) in the reply is captured into the approval tray (pending), never auto-trusted", async () => {
    let t = 0;
    const store = makeDeclarativeStore({ storage: makeMemoryStorage(), embedder: makeHashEmbedder({ dim: 128 }), now: () => ++t, id: () => "m" + t, key: "mem" });
    await store.load();
    const memory = makeMemoryGate({ store });
    const d = makeDecider({ backend: mock("okay! remember(the cat is named Mochi)"), memory });
    const r = await d.decide(frame(), { prompt: "her name is Mochi, note it" });
    expect(r.proposed).toContain("the cat is named Mochi");
    expect(memory.pending().map((p) => p.text)).toContain("the cat is named Mochi");
  });

  it("runs fully offline (no backend): a deliberative arc degrades to an onboard line, never crashes", async () => {
    const d = makeDecider({ backend: null });
    const r = await d.decide(frame({ visible: [{ name: "the person", distance_m: 1.5, bearing_deg: 0, category: "person", dynamic: true }] }), { prompt: "say hi" });
    expect(r.speech).toBeTruthy();          // an onboard reflex line
    expect(r.intents.every((i) => i.ok !== false)).toBe(true);
  });
});
