import { describe, it, expect } from "vitest";
import { makeLexicographer } from "../src/agents/lexicographer.js";
import { makeWatch } from "../src/agents/watch.js";

// a fake dictionary so we can drive reach directly, without the whole gossip stack
function fakeRumors(entries) {
  const map = new Map(entries.map((e) => [e.token, { status: "proposed", meaning: "(no agreed meaning yet)", coinedAt: 1, ...e }]));
  return {
    dictionary: () => [...map.values()].map((e) => ({ token: e.token, meaning: e.meaning, coiner: e.coiner, status: e.status, reach: e.reach })),
    entry: (t) => { const e = map.get(t); return e ? { ...e } : null; },
    curate: (t, p = {}) => { const e = map.get(t); if (!e) return false; if (p.meaning) e.meaning = p.meaning; if (p.status) e.status = p.status; if (p.by) e.curatedBy = p.by; return true; },
    _get: (t) => map.get(t),
  };
}

describe("lexicographer — a bot whose job is keeping the dictionary", () => {
  it("promotes a word the town has taken up to OFFICIAL and records a gloss + curator", () => {
    const rumors = fakeRumors([{ token: "wug", coiner: "Sprinkles", reach: 0.7 }]);
    const colony = { agents: [{ name: "Sage", curiosity: 0.2 }, { name: "Sprinkles", curiosity: 0.9 }] };
    const lex = makeLexicographer({ colony, rumors });
    const evs = lex.tick();
    const e = rumors._get("wug");
    expect(e.status).toBe("official");
    expect(e.curatedBy).toBe("Sage");                 // the calmest bot took the post
    expect(e.meaning).not.toMatch(/no agreed meaning/);
    expect(evs.some((x) => x.kind === "lexicon" && /enters/.test(x.text))).toBe(true);
  });

  it("retires a word that was coined and never caught on as OBSOLETE", () => {
    const rumors = fakeRumors([{ token: "flop", coiner: "Cinder", reach: 0 }]);
    const lex = makeLexicographer({ colony: { agents: [{ name: "Sage", curiosity: 0.2 }] }, rumors, config: { obsoleteAfter: 3 } });
    let evs = [];
    for (let i = 0; i < 5; i++) evs = evs.concat(lex.tick());  // needs to sit un-adopted past obsoleteAfter rounds
    expect(rumors._get("flop").status).toBe("obsolete");
    expect(evs.some((x) => /obsolete/.test(x.text))).toBe(true);
  });

  it("a flagged bot holds the post over the calm-bot default", () => {
    const rumors = fakeRumors([{ token: "x", coiner: "a", reach: 0.6 }]);
    const colony = { agents: [{ name: "Quiet", curiosity: 0.1 }, { name: "Scribe", curiosity: 0.9, lexicographer: true }] };
    expect(makeLexicographer({ colony, rumors }).keeper()).toBe("Scribe");
  });
});

describe("the Watch closes a lobby and churns the town", () => {
  it("taking a post evicts that lobby's residents to other open lobbies", () => {
    const agents = [
      { name: "a", charge: "", quest: null, zone: "garden", targetZone: "garden", mover: { pose: { x: 3, y: 0 }, hasGoal: () => false } },
      { name: "b", charge: "", quest: null, zone: "forge", targetZone: "forge", mover: { pose: { x: -3, y: 0 }, hasGoal: () => false } },
    ];
    const sent = [];
    const colony = { agents, sendTo: (n, z) => { const a = agents.find((x) => x.name === n); a.targetZone = z; sent.push([n, z]); return true; } };
    const watch = makeWatch({ colony, lobbyZones: [{ name: "garden" }, { name: "forge" }], config: { patrol: true, patrolEvery: 1, rng: () => 0 } });
    const evs = watch.tick();                          // rng()=>0 → posts at "garden" (first open)
    expect(watch.post()).toBe("garden");
    expect(watch.isClosed("garden")).toBe(true);
    expect(sent).toContainEqual(["a", "forge"]);        // the garden resident was moved out
    expect(agents.find((x) => x.name === "b").targetZone).toBe("forge"); // the forge resident untouched
    expect(evs.some((e) => /takes up a post/.test(e.text))).toBe(true);
  });
});
