// The User Booth — a special point on the map where the USER is reachable, one bot at a time. A curious free
// bot is summoned; it walks over, knocks + introduces itself; the human chooses to REPLY (and what) or REJECT.
// The other bots don't hear the exchange — they only become AWARE that it happened. Whatever the user said the
// bot carries away as a first-hand belief and spreads by word-of-mouth (→ gossip.js), so the user's words reach
// the colony only through the broken-telephone chain. Then the booth frees up and the next bot gets its turn.
// The user is, in effect, a one-seat lobby with a revolving cast.
//
// `onUser(bot, intro) -> {action:"reply"|"reject", text?}` is the human hook (a UI panel in the browser; a mock
// in tests). `introOf(bot)` and any handshake/translation live here too (Ollama in the browser).

export function makeBooth({ colony, gossip, boothZone, introOf = null, respond = null, onUser, curiosity = (a) => a.curiosity ?? 0.5, available = () => true, now = () => 0, config = {} } = {}) {
  // maxTurns = the bot's PATIENCE: after this many user exchanges it politely excuses itself, so a bot is never
  // trapped at the booth by a slow/absent user. A less-dominant bot runs out of patience sooner (it defers, then
  // slips away). This is the bot's own EXIT STRATEGY — the audience can end because the BOT chose to leave, not
  // only because the user dismissed it. The Watch's forceRelease() is a harder, external backstop on top.
  const C = { maxTurns: 8, ...config };
  let occupant = null, phase = "idle", last = null, forced = false;
  const awareness = [];            // {bot, at} — what other bots "see": an interaction occurred, no content
  const visits = new Map();
  let justReleased = null;         // don't immediately re-summon the bot that just left (fairness)

  // how many turns THIS bot will tolerate: base patience, trimmed for the deferential (low-dominance) — a
  // 0.1-dom bot bails ~3 turns sooner than a 0.9-dom bot who's happy to hold the floor.
  const patienceOf = (a) => Math.max(2, Math.round(C.maxTurns * (0.55 + 0.9 * (a.dominance != null ? a.dominance : 0.5))));

  // Pick who approaches next. Curiosity sets the BASE urge, but it's DAMPED by how often a bot has already
  // gone (÷(1+visits)) so the two keenest knights can't monopolise the booth — as they rack up visits their
  // score falls below the quieter ones, and everyone eventually cycles through. `available` lets the caller
  // exclude a bot that's busy (e.g. off charging).
  function eligible() {
    const pool = colony.agents.filter((a) => a.name !== justReleased && available(a));
    return (pool.length ? pool : colony.agents.filter(available))
      .map((a) => ({ a, s: curiosity(a) / (1 + (visits.get(a.name) || 0)) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)[0]?.a || null;
  }

  return {
    boothZone,
    occupant: () => (occupant ? occupant.name : null),
    phase: () => phase,
    lastInteraction: () => last,
    awarenessLog: () => [...awareness],
    visitCount: (name) => visits.get(name) || 0,
    isEngaged: () => phase === "interacting",
    forceRelease() { if (phase === "interacting") { forced = true; return true; } return false; }, // the Watch breaking up a dragging audience

    // One control cycle. Async: the human's decision is awaited in the "interacting" phase. Physical arrival
    // relies on the colony being ticked between calls. Returns a small status object.
    async tick() {
      if (phase === "idle") {
        const cand = eligible();
        if (!cand) return { phase };
        occupant = cand; phase = "summoned"; colony.sendTo(cand.name, boothZone.name);
        return { phase, summoned: cand.name };
      }
      if (phase === "summoned") {
        if (colony.zoneOf(occupant.mover.pose) === boothZone.name) phase = "interacting";
        return { phase };
      }
      if (phase === "interacting") {
        // A real, multi-turn conversation: the bot introduces itself, then it's a back-and-forth until the
        // USER decides to send it off. Each thing the user says the bot carries away as a first-hand belief;
        // the bot answers in character (respond → the mouth). onUser is called once per user turn with the
        // running transcript, and returns { action:"say", text } to continue or { action:"release" } to end.
        // The whole thing is wrapped so a throw from ANY hook (onUser/introOf/respond/gossip) can't wedge the
        // booth in "interacting" forever — it advances to "done" and releases the occupant on the next tick.
        const who = occupant.name, convo = [];
        let ended = "released";
        try {
          const intro = introOf ? await introOf(occupant) : `${who} knocks and introduces themselves.`;
          convo.push({ who, text: intro });
          awareness.push({ bot: who, at: now() });                     // the colony notices — but not the words
          while (awareness.length > 120) awareness.shift();            // bounded (one entry per interaction, never pruned before)
          const patience = patienceOf(occupant);
          let userTurns = 0;
          for (let guard = 0; guard < 200; guard++) {
            if (forced) { convo.push({ who, text: "— oh, I'm being waved off. Another time!" }); ended = "broken-up"; break; }  // the Watch stepped in
            if (userTurns >= patience) { convo.push({ who, text: "— I should let you go. It was lovely, truly." }); ended = "bot-left"; break; }  // patience spent → the bot's own exit
            const turn = (await onUser(occupant, { intro, convo })) || { action: "release" };
            if (forced) { convo.push({ who, text: "— oh, I'm being waved off. Another time!" }); ended = "broken-up"; break; }  // forced while we were waiting on a slow user
            if (turn.action !== "say" || !turn.text) break;            // release / reject / empty → end the audience
            convo.push({ who: "user", text: turn.text }); userTurns++;
            gossip.seed(who, { text: turn.text, source: "the user", topic: "from-the-user", fidelity: 1 });
            const reply = respond ? await respond(occupant, convo) : "…";
            convo.push({ who, text: reply });
          }
        } catch (e) { ended = "error"; }                              // a hook failed — don't wedge; just end the audience
        visits.set(who, (visits.get(who) || 0) + 1);
        last = { bot: who, convo, ended };
        forced = false;
        phase = "done";
        return { phase, bot: last.bot, convo, ended };
      }
      if (phase === "done") {
        justReleased = occupant.name; const freed = occupant.name;
        occupant = null; phase = "idle";
        return { phase: "released", freed };                          // caller sends `freed` off to spread the word
      }
      return { phase };
    },
  };
}
