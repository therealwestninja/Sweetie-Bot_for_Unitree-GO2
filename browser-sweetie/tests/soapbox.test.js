import { describe, it, expect } from "vitest";
import { makeMegaphone } from "../src/agents/megaphone.js";
import { makeColonyApp } from "../src/agents/colonyApp.js";

describe("megaphone — personal temp-ban stops one bot monopolising it", () => {
  it("bars the last speaker from the next lottery until their personal cooldown lapses", async () => {
    let t = 0;
    const mp = makeMegaphone({ now: () => t, cooldownMs: 0, personalCooldownMs: 1000, rng: () => 0 });
    const bots = [{ name: "a" }, { name: "b" }];
    t = 0; expect((await mp.fire(bots)).winner).toBe("a"); // rng 0 → picks the first eligible
    expect(mp.bannedNames(0)).toContain("a");
    t = 1; expect((await mp.fire(bots)).winner).toBe("b"); // a is barred → b gets it
    t = 2000; expect((await mp.fire(bots)).winner).toBe("a"); // both bans lapsed → a eligible again
  });
});

describe("megaphone — the physical SOAPBOX (one slot, walk to it, then barred)", () => {
  const scen = () => ({
    topic: "q",
    zones: [
      { name: "plaza", x: -2.5, y: 0, radius: 1.4, purpose: "meet" },
      { name: "soap", x: 2.5, y: 0, radius: 0.7, megaphone: true, purpose: "the soapbox" },
    ],
    bots: [
      { name: "a", startZone: "plaza", pose: { x: -2.5, y: 0.3 } },
      { name: "b", startZone: "plaza", pose: { x: -2.9, y: 0.3 } },
    ],
    seeds: [{ bot: "a", stance: 0.9, text: "change everything" }, { bot: "b", stance: -0.9, text: "keep it exactly as it is" }],
  });

  it("summons a speaker who must WALK to the post, blasts on arrival, then is barred; the audience is only partly swayed", async () => {
    let t = 0;
    const app = makeColonyApp({ scenario: scen(), mouth: null, now: () => (t += 100),
      config: { socialEvery: 1e9, homophilyEvery: 1e9, megaphoneCooldownMs: 0, megaphonePersonalCooldownMs: 1e7, rng: () => 0 } });

    const r1 = await app.serviceMegaphone();
    expect(r1.phase).toBe("summon");
    expect(r1.winner).toBe("a");                        // chosen, but hasn't spoken yet
    expect(app.state().megaphone.holder).toBe("a");
    expect(app.state().megaphone.lastWinner).toBeNull(); // nothing blasted while still walking

    // while it's still crossing the plaza, calls just report travel — no blast
    const mid = await app.serviceMegaphone();
    expect(mid.phase).toBe("traveling");

    for (let i = 0; i < 1200; i++) app.tick(0.02);      // let 'a' reach the soapbox
    const r2 = await app.serviceMegaphone();
    expect(r2 && r2.winner).toBe("a");                  // arrived → blast
    expect(app.state().megaphone.lastWinner).toBe("a");
    expect(app.state().megaphone.holder).toBeNull();    // stepped down
    expect(app.state().megaphone.banned).toContain("a"); // and is now barred from grabbing it again

    // b held the OPPOSITE view (-0.9). The blast pulled it toward a's stance but did NOT flip it wholesale to 0.9
    // — the softened influence is persuasion, not the old 100% sweep.
    const b = app.state().bots.find((x) => x.name === "b");
    expect(b.stance).toBeGreaterThan(-0.9); // it moved
    expect(b.stance).toBeLessThan(0.9);     // but wasn't force-converted
  });
});
