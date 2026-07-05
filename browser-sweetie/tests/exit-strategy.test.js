import { describe, it, expect } from "vitest";
import { makeBooth } from "../src/agents/booth.js";
import { makeWatch } from "../src/agents/watch.js";

// a colony stub where the summoned bot is already standing at the booth, so tick() advances idle→interacting fast
function boothWith(bot, onUser, config = {}) {
  const colony = { agents: [bot], sendTo() {}, zoneOf: () => "booth" };
  return makeBooth({ colony, gossip: { seed() {} }, boothZone: { name: "booth" }, onUser, respond: async () => "mm.", config });
}
const userTurnsIn = (convo) => convo.filter((m) => m.who === "user").length;
async function runAudience(booth) { await booth.tick(); await booth.tick(); return await booth.tick(); } // idle→summoned→interacting→run

describe("booth exit strategy + the Watch breaking up long conversations", () => {
  it("BOT EXIT: with an endless user, the bot runs out of patience and excuses ITSELF (not trapped)", async () => {
    const booth = boothWith({ name: "a", dominance: 0.5, mover: { pose: { x: 0, y: 0 } } }, async () => ({ action: "say", text: "go on…" }));
    const res = await runAudience(booth);
    expect(res.ended).toBe("bot-left");                 // the bot chose to leave
    expect(userTurnsIn(res.convo)).toBeLessThan(200);   // never the runaway guard
  });

  it("PATIENCE SCALES WITH DOMINANCE: a dominant bot holds the floor longer than a deferential one", async () => {
    const endless = async () => ({ action: "say", text: "…" });
    const dom = await runAudience(boothWith({ name: "d", dominance: 0.9, mover: { pose: { x: 0, y: 0 } } }, endless));
    const sub = await runAudience(boothWith({ name: "s", dominance: 0.1, mover: { pose: { x: 0, y: 0 } } }, endless));
    expect(userTurnsIn(dom.convo)).toBeGreaterThan(userTurnsIn(sub.convo));
  });

  it("WATCH BREAK-UP: forceRelease() mid-audience ends it as 'broken-up'", async () => {
    let booth, turns = 0;
    booth = boothWith({ name: "a", dominance: 1, mover: { pose: { x: 0, y: 0 } } }, async () => {
      if (++turns === 3) booth.forceRelease();           // the Watch steps in on the 3rd turn
      return { action: "say", text: "and another thing…" };
    });
    const res = await runAudience(booth);
    expect(res.ended).toBe("broken-up");
  });

  it("WATCH referee breaks up an audience once it passes convoCap", () => {
    let broken = 0;
    const watch = makeWatch({ colony: { agents: [] }, config: { convoCap: 3 },
      interaction: { who: () => "a", forceBreak: () => (broken++, true) } });
    let events = [];
    for (let i = 0; i < 5; i++) events = events.concat(watch.tick()); // ages 1,2,3,4(>cap→break),reset
    expect(broken).toBe(1);
    expect(events.some((e) => e.kind === "watch" && /wraps up/.test(e.text))).toBe(true);
  });
});
