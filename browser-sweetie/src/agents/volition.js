// Volition — a townsperson's INNER STATE becomes a self-generated GOAL it verifiably carries out. This is the
// fusion of the psyche (grudges/mood/curiosity) with the pursuit discipline (verify-against-reality + a
// watchdog + means-matter), in the colony's TICK form. (The async pursuit executive is the ROBOT's; N
// synchronous bots get the same principles per tick, which is the architecturally-right call for a multi-agent
// loop.) Four impulses, each self-generated from who the bot IS right now:
//   RECONCILE — you hold a grudge but you're feeling big (mood up, cooperative) → go MEND the rift.
//   CONFRONT  — you hold a grudge and you're sore + wound-up (volatile) → go HAVE IT OUT.
//   NOVELTY   — bored (flat mood, curious) → go somewhere you're NOT, meet who you don't know.
//   WHIMSY    — light and lively → a pointless, happy wander.
// The outcome is only applied once the bot has PHYSICALLY reached the target (you can't mend a rift from across
// the square — means matter); if it can't get there, the watchdog abandons the quest (and a failed reconcile
// stings a little). Each outcome feeds back into the psyche, closing the loop.
const REACH = 0.95;          // how close counts as "reached them"
const WATCH = 14;            // volition-ticks of no progress → give up (loop-of-death guard)

export function makeVolition({ colony, agentOf, lobbyZones = [], zoneByName, rng = Math.random } = {}) {
  const zoneOf = (a) => a.zone;
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

  function novelZone(a) { const here = zoneOf(a); const others = lobbyZones.filter((z) => z.name !== here); return others.length ? others[Math.floor(rng() * others.length)] : null; }

  // Read the psyche → maybe a spontaneous goal. Returns a quest or null.
  function impulse(a) {
    const m = a.mind; if (!m) return null;
    const d = m.disposition(), mood = m.mood(), grudges = m.grudges();
    if (grudges.length && mood.valence > 0.2 && d.cooperation > 0.58 && rng() < 0.3) return { kind: "reconcile", target: grudges[0].who, bestDist: Infinity, since: 0, ticks: 0 };
    if (grudges.length && d.volatility > 0.5 && rng() < 0.25) return { kind: "confront", target: grudges[0].who, bestDist: Infinity, since: 0, ticks: 0 };
    if (d.curiosity > 0.6 && mood.valence < 0.12 && rng() < 0.18) { const z = novelZone(a); if (z) return { kind: "novelty", targetZone: z.name, bestDist: Infinity, since: 0, ticks: 0 }; }
    if (mood.valence > 0.45 && mood.arousal > 0.5 && rng() < 0.12) { const z = novelZone(a); if (z) return { kind: "whimsy", targetZone: z.name, bestDist: Infinity, since: 0, ticks: 0 }; }
    return null;
  }

  function targetPos(q) { if (q.target) { const t = agentOf(q.target); return t ? t.mover.pose : null; } const z = zoneByName(q.targetZone); return z || null; }

  // The outcome is TWO-SIDED for reconcile/confront: the target's own state decides how it lands (an olive branch
  // can be spurned; a confrontation can be defused), instead of a one-shot the target has no say in.
  function outcome(a, q, events) {
    const m = a.mind, t = agentOf(q.target), tm = t && t.mind;
    if (q.kind === "reconcile") {
      // does the target accept? someone who still resents YOU back may spurn the gesture.
      const receptive = tm ? tm.feabout(a.name) > -0.5 : true;
      if (receptive) {
        m.reconcile(q.target);
        if (tm) { tm.reconcile(a.name); tm.experience({ who: a.name, valence: 0.45, arousal: 0.3, kind: "amends" }); }
        events.push({ kind: "amends", from: a.name, to: q.target, text: `${a.name} seeks out ${q.target} and makes amends — it's welcomed` });
      } else {
        m.experience({ who: q.target, valence: -0.25, arousal: 0.5, kind: "rebuffed" }); // the spurned olive branch stings
        if (tm) tm.experience({ who: a.name, valence: -0.05, arousal: 0.3, kind: "spurned" });
        events.push({ kind: "rebuffed", from: a.name, to: q.target, text: `${a.name} reaches out to ${q.target} — and is rebuffed` });
      }
    } else if (q.kind === "confront") {
      // a calm, cooperative target DEFUSES it (the air clears); anyone else escalates and both dig in.
      const d = tm && tm.disposition(); const defuses = d ? (d.cooperation > 0.6 && d.volatility < 0.3) : false;
      if (defuses) {
        m.reconcile(q.target); m.experience({ who: q.target, valence: 0.12, arousal: 0.3, kind: "aired" }); // getting it off your chest to someone who stays calm clears the air
        if (tm) tm.experience({ who: a.name, valence: 0.05, arousal: 0.3, kind: "de-escalated" });
        events.push({ kind: "amends", from: a.name, to: q.target, text: `${a.name} confronts ${q.target}, who stays calm — the air clears` });
      } else {
        m.onSlighted(q.target, 0.4, "had it out"); if (tm) tm.onSlighted(a.name, 0.4, "was confronted");
        events.push({ kind: "confront", from: a.name, to: q.target, text: `${a.name} storms up to ${q.target} to have it out — and it blows up` });
      }
    }
    else if (q.kind === "novelty") { m.experience({ valence: 0.4, arousal: 0.5, kind: "novelty" }); events.push({ kind: "wander", from: a.name, text: `${a.name}, restless, goes to the ${q.targetZone} to see something new` }); }
    else if (q.kind === "whimsy") { m.experience({ valence: 0.3, arousal: 0.4, kind: "whimsy" }); events.push({ kind: "wander", from: a.name, text: `${a.name} skips off to the ${q.targetZone} on a whim` }); }
  }

  return {
    // Directly hand a bot a quest (tests / a future UI). kind + target|targetZone.
    assign(botName, quest) { const a = agentOf(botName); if (a) a.quest = { bestDist: Infinity, since: 0, ticks: 0, ...quest }; },
    hasQuest: (botName) => { const a = agentOf(botName); return !!(a && a.quest); },

    // One volition tick (call on the social cadence). Returns events. Generates impulses for the idle, advances
    // active quests with a verify-arrival + watchdog, applies outcomes only on a real physical arrival.
    tick() {
      const events = [];
      for (const a of colony.agents) {
        if (!a.mind || a.charge || a.asleep || a.onMic || a.atBooth || a.atBank || a.goingHome) continue; // survival (charging), sleep, soapbox/booth summons, and a bank/home errand override volition
        if (!a.quest) { if (!a.mover.hasGoal()) { const q = impulse(a); if (q) { a.quest = q; } } continue; }
        const q = a.quest; q.ticks++;
        if (q.target) { const tgt = agentOf(q.target); if (tgt && (tgt.asleep || tgt.charge || tgt.onMic || tgt.atBooth)) { a.quest = null; continue; } } // can't mend/confront someone who's asleep, charging, or busy at the mic/booth — drop it
        const tp = targetPos(q);
        if (!tp) { a.quest = null; continue; }                   // target vanished
        const d = dist(a.mover.pose, tp);
        if (d < REACH) { outcome(a, q, events); a.quest = null; continue; } // VERIFIED arrival → outcome
        colony.sendToPoint(a.name, tp.x, tp.y);                  // chase the (possibly moving) target
        if (d < q.bestDist - 0.05) { q.bestDist = d; q.since = 0; }
        else if (++q.since >= WATCH) {                            // watchdog: can't reach → abandon
          if (q.kind === "reconcile") a.mind.experience({ who: q.target, valence: -0.2, arousal: 0.4, kind: "rebuffed" }); // a failed olive branch stings
          events.push({ kind: "give-up", from: a.name, text: `${a.name} gives up trying to reach ${q.target || "the " + q.targetZone}` });
          a.quest = null;
        }
      }
      return events;
    },
  };
}
