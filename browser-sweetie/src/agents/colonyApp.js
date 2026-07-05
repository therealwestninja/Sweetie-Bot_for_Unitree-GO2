// Colony orchestrator — composes the whole society sim (bodies + minds + channels + mouth) into one thing the
// UI (or a test) drives. The design rule from C1/C2 holds: MECHANICS ARE DETERMINISTIC AND INSTANT (gossip
// spread, opinion updates, tribes, homophily, the megaphone's stance effect), and the model is FLAVOUR added
// asynchronously through the shared mouth (booth intros + megaphone manifestos), gated by the scheduler so it
// never stampedes and never blocks the physics. So the colony works with mouth:null; Ollama just gives it a
// voice. `tick(dt)` runs the deterministic loop; `serviceBooth()`/`serviceMegaphone()` are the async voice bits.
import { makeColony } from "./colony.js";
import { makeSociety } from "./society.js";
import { makeGossip } from "./gossip.js";
import { makeBooth } from "./booth.js";
import { makeMegaphone } from "./megaphone.js";
import { makeCharger } from "./charger.js";
import { makeWatch } from "./watch.js";
import { makePsyche } from "./psyche.js";
import { makeVolition } from "./volition.js";
import { makeRumors } from "./rumors.js";
import { makeLanguage } from "./language.js";
import { makeLexicographer } from "./lexicographer.js";
import { makeLobbyChat } from "./lobby.js";
import { makeColonyClock, PHASE_GLYPH } from "./clock.js";
import { makeChronicle } from "./chronicle.js";
import { makeTraffic } from "./traffic.js";
import { makeEconomy } from "./economy.js";
import { makeObservatory } from "./observatory.js";
import { stripSelfName } from "./textStream.js";
import { applyHomophily } from "./homophily.js";

export function makeColonyApp({ scenario, mouth = null, onUser = null, now = () => 0, config = {} } = {}) {
  const TOPIC = scenario.topic || "the-question";
  const lobbyZones = scenario.zones.filter((z) => !z.booth && !z.charger && !z.home && !z.megaphone);
  const boothZone = scenario.zones.find((z) => z.booth) || null;
  const chargerZone = scenario.zones.find((z) => z.charger) || null;
  const homeZones = scenario.zones.filter((z) => z.home); // apartments — where dormant bots sleep off their off-shift
  const megaphoneZone = scenario.zones.find((z) => z.megaphone) || null; // the SOAPBOX — one slot; a speaker must walk here to blast (opt-in; without it the megaphone fires globally as before)

  const colony = makeColony({ statics: scenario.statics || [], zones: scenario.zones, bots: scenario.bots, walls: scenario.walls || [], openings: scenario.openings || [], bounds: scenario.bounds || null, jitter: config.jitter ?? 0, rng: config.rng || Math.random });
  // --- traffic lights at the 4-way: bots WAIT at a crosswalk whose pedestrian signal is red, then cross on green.
  const crossings = scenario.crossings || [], roads = scenario.roads || null;
  const traffic = makeTraffic({ ...(config.traffic || {}), enabled: (config.traffic && config.traffic.enabled != null) ? config.traffic.enabled : crossings.length > 0 });
  function heldAtLight(a) { // hold a bot at the curb of a crosswalk that's WAIT and it's about to step into that road
    if (!traffic.enabled || !roads || !a.mover.hasGoal()) return false;
    const p = a.mover.pose, g = a.mover.goal;
    for (const c of crossings) {
      if (traffic.walk(c.axis)) continue;
      if (c.axis === "H") { const R = roads.h, sp = Math.sign(p.y - R.y), sg = Math.sign(g.y - R.y);
        if (Math.abs(p.x - c.x) < c.w / 2 + 0.25 && Math.abs(p.y - R.y) > R.h / 2 - 0.05 && Math.abs(p.y - R.y) < R.h / 2 + 0.6 && sg !== 0 && sg !== sp && Math.abs(g.y - R.y) > R.h / 2) return true; }
      else { const R = roads.v, sp = Math.sign(p.x - R.x), sg = Math.sign(g.x - R.x);
        if (Math.abs(p.y - c.y) < c.w / 2 + 0.25 && Math.abs(p.x - R.x) > R.w / 2 - 0.05 && Math.abs(p.x - R.x) < R.w / 2 + 0.6 && sg !== 0 && sg !== sp && Math.abs(g.x - R.x) > R.w / 2) return true; }
    }
    return false;
  }
  // give each townsperson a BRAIN (neuromodulated temperament) — off by default so tests stay deterministic
  const useMinds = config.minds ?? false;
  const nameHash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619) >>> 0; return x; };
  if (useMinds) for (const a of colony.agents) a.mind = makePsyche({ traits: a.traits || null, seed: nameHash(a.name), now });
  const agentOf = (name) => colony.agents.find((a) => a.name === name);
  const society = makeSociety({
    openness: (b) => { const a = agentOf(b); return ((scenario.openness && scenario.openness[b]) ?? 0.4) * (a && a.mind ? a.mind.opennessMul() : 1); },
    // ECONOMY → SOCIETY: a bot's NET WORTH (cash minus rent owed) is its class; society folds class similarity into
    // affinity so the town's tribes + physical clustering partly sort along economic lines. Inert unless economy is on.
    classOf: (b) => { const a = agentOf(b); return (a && a.money != null) ? a.money - (a.rentDue || 0) : null; },
    classWeight: config.economy ? (config.classWeight ?? 0.3) : 0,
    classScale: config.classScale ?? 20,
  });
  const gossip = makeGossip();
  const persona = Object.fromEntries((scenario.bots || []).map((b) => [b.name, `You are ${b.name}, ${b.persona || "a townsperson"}`]));
  // the town's memory of itself — salient moments crystallize into inheritable LORE (the culture→individual arrow)
  const chronicle = makeChronicle({ society, agentNames: () => colony.agents.map((a) => a.name), config: config.chronicle || {} });

  const events = [];
  const emit = (e) => { const ev = { ts: now(), ...e }; events.push(ev); while (events.length > 240) events.shift(); chronicle.observe(ev); if (config.onEvent) config.onEvent(ev); return ev; };
  // ask the mouth for display text, filling the event when it resolves (never blocks the sim)
  function voice(ev, { system, user, priority, tag }) {
    if (!mouth) return;
    Promise.resolve(mouth.generate({ system, messages: [{ role: "user", content: user }], priority, tag }))
      .then((t) => { if (t) ev.text = String(t).trim(); }).catch(() => {});
  }

  // --- booth: the user oracle. intro is flavour (mouth); the reply/reject is the human (onUser). ---
  // Mood COLOURS a bot's WORDS at the well (matches the lobby's moodClause) — so a lesioned/depressed bot doesn't just
  // ACT withdrawn, it SPEAKS low and flat to you. Empty near baseline so an even-keeled bot's prompt stays clean.
  const moodClause = (a) => { const m = a && a.mind && a.mind.mood ? a.mind.mood() : null; if (!m) return ""; const v = m.valence, ar = m.arousal; let f = "";
    if (v > 0.25) f = ar > 0.55 ? "Right now you feel buoyant, almost elated" : "Right now you feel content and warm";
    else if (v < -0.25) f = ar > 0.55 ? "Right now you feel agitated and on edge — tense and short-fused" : "Right now you feel low and flat, drained of energy";
    else if (ar > 0.62) f = "Right now you feel restless and keyed-up";
    return f ? " " + f + ", and it colours how you speak." : ""; };
  const booth = boothZone ? makeBooth({
    colony, gossip, boothZone, now,
    curiosity: (a) => (a.curiosity ?? 0.5) * (a.mind ? a.mind.curiosityMul() : 1), // mood-modulated: an aroused bot seeks the well more
    available: (a) => !a.charge && !a.quest && !a.asleep && !a.onMic, // busy charging, on a quest, asleep, or heading to the soapbox → not summonable to the booth
    introOf: async (bot) => {
      const fallback = `${bot.name} knocks: "A word, good user?"`;
      if (!mouth) return fallback;
      try { const line = await mouth.generate({ system: persona[bot.name] + moodClause(bot) + " Speak in first person, one short line, no stage directions.", messages: [{ role: "user", content: "You walk up to the user's booth and knock. Greet them and introduce yourself in one short line." }], priority: mouth.PRIORITY.booth, tag: `intro:${bot.name}` }); return String(line || "").trim() || fallback; }
      catch (e) { emit({ kind: "system", text: "⚠ mouth error (is Ollama up with OLLAMA_ORIGINS=*?): " + e.message }); return fallback; }
    },
    respond: async (bot, convo) => {
      const fallback = `${bot.name} considers your words.`;
      if (!mouth) return fallback;
      try {
        const messages = convo.map((m) => ({ role: m.who === "user" ? "user" : "assistant", content: m.text }));
        // stream the reply out live to the UI (typing effect) when a streaming backend + a chunk sink are wired
        const onChunk = config.onSpeechChunk ? (c) => config.onSpeechChunk(bot.name, c.fullTextSoFar) : null;
        const line = await mouth.generate({ system: persona[bot.name] + moodClause(bot) + " You are speaking with the user at the well. Reply in character, one or two short sentences — no stage directions.", messages, priority: mouth.PRIORITY.booth, tag: `say:${bot.name}`, onChunk });
        return stripSelfName(String(line || "").trim(), bot.name) || fallback;
      } catch (e) { emit({ kind: "system", text: "⚠ mouth error: " + e.message }); return fallback; }
    },
    onUser: onUser || (async () => ({ action: "release" })),
    config: config.booth || {},
  }) : null;

  // --- megaphone: rare global blast; the winner's stance moves everyone, the words are flavour. ---
  const megaphone = makeMegaphone({
    now, cooldownMs: config.megaphoneCooldownMs ?? 20000, personalCooldownMs: config.megaphonePersonalCooldownMs ?? 0, rng: config.rng || Math.random, gossip,
    compose: async (w) => {
      const adv = society.advocacy(w.name); const cause = adv ? `${adv.stance >= 0 ? "for" : "against"} ${adv.topic}` : "the colony";
      const fallback = `Rally to me — ${cause}!`;
      if (!mouth) return fallback;
      try { const line = await mouth.generate({ system: persona[w.name] + " Speak in first person, one short rousing line.", messages: [{ role: "user", content: `You seized the megaphone — every knight and the user can hear you. In ONE short line, rally the whole colony ${cause}.` }], priority: mouth.PRIORITY.megaphone, tag: `mega:${w.name}` }); return String(line || "").trim() || fallback; }
      catch (e) { emit({ kind: "system", text: "⚠ mouth error: " + e.message }); return fallback; }
    },
  });

  // the communal charger — battery drain + limited ports + queue + water-cooler gossip (keeps the colony moving)
  const randomLobby = () => { const open = lobbyZones.filter((z) => !(watch && watch.isClosed(z.name))); const pool = open.length ? open : lobbyZones; return pool.length ? pool[Math.floor((config.rng || Math.random)() * pool.length)].name : null; }; // never route a bot into the lobby the Watch has closed
  // The charger and the ECONOMY are alternative forcing functions: with the economy on, the charger zone becomes the
  // BANK (no battery, no queue) and money/rent replace battery/recharge as the reason bots keep moving.
  const useEconomy = config.economy ?? false;
  const charger = (chargerZone && !useEconomy) ? makeCharger({ colony, gossip, zone: chargerZone, ports: chargerZone.ports ?? 2, rng: config.rng, ...(config.charger || {}), onRelease: (name) => { const z = randomLobby(); if (z) colony.sendTo(name, z); const a = agentOf(name); if (a && a.mind) a.mind.onCharged(); } }) : null;
  // volition: inner state → a self-generated goal the bot verifiably carries out (mend a rift, seek novelty, …)
  const volition = useMinds ? makeVolition({ colony, agentOf, lobbyZones, zoneByName: colony.zoneByName, rng: config.rng || Math.random }) : null;
  const rumors = makeRumors({ colony, gossip, society, rng: config.rng || Math.random }); // second-hand knowledge: gossip about PEOPLE + memes
  const language = useMinds ? makeLanguage({ colony, rumors, agentOf, rng: config.rng || Math.random, config: config.language || {} }) : null; // the meta-word-game (needs psyches for the rewards)
  const lexicographer = makeLexicographer({ colony, rumors, agentOf, config: config.lexicon || {} }); // a bot whose job is grooming the dictionary
  // the civilization instrument — longitudinal metrics (dialect churn, myth persistence, how split, inheritability)
  const observatory = makeObservatory({ society, rumors, chronicle, colony, topic: TOPIC, config: config.observatory || {} });
  // the Watch — moves campers / squatters / stuck bots along (law enforcement)
  // Only hand the Watch a charger zone when a charger ACTUALLY exists (battery mode). With the economy on that same
  // zone is the BANK — policing it as an anti-camp spot ("loitering at the spa") would harass legit bank customers.
  const watch = makeWatch({ colony, chargerZone: charger ? chargerZone : null, lobbyZones, config: config.watch || {},
    interaction: booth ? { who: () => (booth.isEngaged() ? booth.occupant() : null), forceBreak: () => booth.forceRelease() } : null });
  // lobby conversations — co-located townsfolk actually debate via the mouth; opinions shift from what's said
  const lobbyChat = makeLobbyChat({ colony, society, persona, mouth, topic: TOPIC, now, config: {
    rng: config.rng || Math.random,
    onLine: (zone, ln) => { if (ln.text) emit({ kind: "chat", from: ln.who, zone, text: `${ln.who}: ${ln.text}` }); }, // emit each debate turn as it lands (unfolds in the log)
    onLobbyChunk: config.onLobbyChunk || null, // optional live-typing hook for the browser
    ...(config.lobby || {}) } });

  // --- day/night clock + dormancy: off-shift bots sleep at home (holding their mood/grudges) and rotate in at
  // their phase. This is how the town supports a big cast without every bot competing for the mouth at once. ---
  const clock = makeColonyClock({ enabled: config.dayNight ?? false, ...(config.clock || {}) });
  for (const a of colony.agents) a.chronotype = a.chronotype || "default";
  // Assign homes ROUND-ROBIN by roster slot, not by name-hash: hashing clumped 9 of 16 bots into one apartment (which
  // then can't fit its cohort's slot-ring → they crowd and jitter). Slot index spreads them evenly (≈6/5/5 over 3 homes).
  const homeOf = (a) => (homeZones.length ? homeZones[(a._slot != null ? a._slot : nameHash(a.name)) % homeZones.length].name : null);
  // ECONOMY (opt-in): the charger zone is the BANK; bots work → cash out at the bank → pay rent at home.
  const economy = useEconomy && chargerZone ? makeEconomy({ colony, bankZone: chargerZone.name, homeOf, jobs: scenario.jobs || {}, psycheOf: (a) => a.mind, rng: config.rng || Math.random, config: config.economyCfg || {} }) : null;
  const REST = { lark: "night", default: "night", owl: "day" }; // what an off-shift bot is resting through
  function applyDormancy() {
    if (!clock.enabled) return;
    for (const a of colony.agents) {
      const shouldSleep = !clock.isAwake(a.chronotype);
      if (shouldSleep && !a.asleep && !a.atBank && !a.goingHome) { // don't send a bot to sleep mid-errand (bank run or heading home to pay rent)
        a.asleep = true; a.quest = null;                     // drop any in-flight quest; you're turning in
        const home = homeOf(a); if (home) colony.sendTo(a.name, home);
        emit({ kind: "sleep", from: a.name, text: `😴 ${a.name} turns in for the ${REST[a.chronotype] || "night"}` });
      } else if (!shouldSleep && a.asleep) {
        a.asleep = false;
        const lob = randomLobby(); if (lob) colony.sendTo(a.name, lob);
        emit({ kind: "wake", from: a.name, text: `${a.name} is up and about` });
      }
    }
  }

  // seed initial first-hand beliefs (e.g. two opinion leaders)
  for (const s of scenario.seeds || []) { const b = gossip.seed(s.bot, { topic: TOPIC, stance: s.stance, text: s.text || "", source: s.source || "the user" }); society.absorb(s.bot, b); if (s.zone) colony.sendTo(s.bot, s.zone); }
  for (const b of scenario.bots || []) if (b.startZone) colony.sendTo(b.name, b.startZone);
  applyDormancy(); // if we boot mid-cycle (or into night), off-shift bots start asleep at home

  let frame = 0; let mpBusy = false; let mpHolder = null, mpTravel = 0;
  const SOCIAL_EVERY = config.socialEvery ?? 25;   // frames between gossip rounds
  const HOMOPHILY_EVERY = config.homophilyEvery ?? 4; // social rounds between migrations
  let socialRounds = 0, ruminateClock = 0;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const rng = config.rng || Math.random;
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
  function socialStep() {
    // A bot the booth has SUMMONED is walking to the well — flag it so homophily/volition don't yank it off course
    // before it arrives (a summoned bot isn't in the booth zone yet, so the zone-exclude alone doesn't protect it).
    const bOcc = booth ? booth.occupant() : null;
    for (const a of colony.agents) a.atBooth = (a.name === bOcc);
    for (const z of lobbyZones) {
      // SHUFFLE who talks to whom each round (so rumours don't spread in a fixed, predictable chain), and
      // exchange BOTH ways per pair (a conversation is two-sided → also makes it order-independent).
      const occ = shuffle(colony.inZone(z.name));
      for (let i = 0; i < occ.length - 1; i++) {
        for (const [x, y] of [[occ[i], occ[i + 1]], [occ[i + 1], occ[i]]]) {
          const ax = agentOf(x), ay = agentOf(y);
          // grudge-gated: you don't share news with someone you resent — a snub the colony can witness
          if (useMinds && ax && ax.mind && ax.mind.feabout(y) < -0.35) { if (rng() < 0.15) emit({ kind: "snub", from: x, to: y, text: `${x} turns away from ${y}, saying nothing` }); continue; }
          const b = gossip.relay(x, y, { decay: config.gossipDecay ?? 0.15 });
          if (b) { society.absorb(y, b); if (ay && ay.mind) ay.mind.onGossip(); emit({ kind: "gossip", from: x, to: y, zone: z.name, text: `“${b.text}”`, fidelity: b.fidelity }); }
        }
      }
      // FRICTION: two townsfolk stuck together who see the topic oppositely grate → it seeds interpersonal grudges
      if (useMinds) for (let i = 0; i < occ.length - 1; i++) {
        const a = agentOf(occ[i]), c = agentOf(occ[i + 1]); if (!a || !c || !a.mind || !c.mind) continue;
        const disagree = Math.abs(society.opinion(occ[i], TOPIC).stance - society.opinion(occ[i + 1], TOPIC).stance);
        if (disagree > 1.1 && rng() < 0.08) { a.mind.onSlighted(occ[i + 1], 0.3 * disagree); c.mind.onSlighted(occ[i], 0.3 * disagree); emit({ kind: "friction", from: occ[i], to: occ[i + 1], text: `${occ[i]} and ${occ[i + 1]} bicker over the ${TOPIC}` }); }
      }
    }
    // second-hand knowledge: a witness starts a rumour ABOUT a pair it sees ("I saw A and B together"); it then
    // spreads + degrades through the same lobby gossip above → reputation. (No-op unless a lobby has 3+.)
    for (const e of rumors.witness({ chance: config.rumorChance ?? 0.15 })) emit(e);
    if (config.gossipAge) gossip.age(config.gossipAge === true ? {} : config.gossipAge); // fade stale reputation rumours so a bad name isn't permanent (an unreinforced echo chamber heals)
    if (config.opinionDecay) society.decay(config.opinionDecay === true ? {} : config.opinionDecay); // soften unreinforced convictions so opinions can't calcify into permanent castes
    // the meta-word-game: reward adoption/curiosity, retire winners, make flops reflect+retry; a curious bot may coin
    if (language) { for (const e of language.tick()) emit(e); const cw = language.maybeCoin(); if (cw) emit(cw); }
    for (const e of lexicographer.tick()) emit(e); // the keeper grooms the dictionary: promote/retire words, record glosses
    for (const e of chronicle.tick(TOPIC)) emit(e);  // the town remembers its own salient moments as lore
    observatory.tick();                              // sample the civilization's longitudinal metrics
    // battery / charger cycle (drains, forms the queue, charges, water-cooler gossip). Its gossip crosses tribes.
    if (charger) { for (const e of charger.tick()) { if (e.kind === "cooler") { if (e.belief) society.absorb(e.to, e.belief); if (useMinds) { const af = agentOf(e.from), at = agentOf(e.to); af && af.mind && af.mind.onChat(); at && at.mind && at.mind.onChat(); } } emit(e); } }
    if (economy) for (const e of economy.tick()) emit(e); // work → cash out at the bank → pay rent; the money churn
    // the Watch patrols for camping / squatting / stuck bots and moves them along (which frays their temper)
    if (watch) for (const e of watch.tick()) { const a = agentOf(e.from); if (a && a.mind) a.mind.onMovedAlong(); emit(e); }
    if (useMinds) for (const a of colony.agents) a.mind.tick(); // let moods drift back toward each bot's baseline
    // VOLITION: an inner impulse becomes a self-generated goal the bot verifiably carries out (mend/confront/roam)
    if (volition) for (const e of volition.tick()) emit(e);
    // RUMINATION: an idle, settled bot dwells on its worst unhealed wound → the mood re-sours UNPROMPTED (and
    // days-old, if it persisted). This is what makes a bot snap or storm off later "for no reason you can see".
    if (useMinds && ++ruminateClock % 3 === 0) for (const a of colony.agents) {
      if (a.charge || a.asleep || a.mover.hasGoal() || !a.mind) continue;   // only the idle stew (sleepers rest undisturbed)
      if (rng() < 0.25) { const m = a.mind.ruminate(); if (m && rng() < 0.5) emit({ kind: "brood", from: a.name, text: m.who ? `${a.name} broods over ${m.who}${m.text ? ` — ${m.text}` : ""}` : `${a.name} sits with an old sting` }); }
    }
    // migrate on affinity — but leave charge-flow knights (queue/port) and the booth occupant alone. When minds
    // are on, a GRUDGE is blended into the affinity, so a wound physically repels: you storm off from who you resent.
    if (++socialRounds % HOMOPHILY_EVERY === 0) {
      const affinity = useMinds ? (x, y) => { const base = society.affinity(x, y); if (base == null) return null; const ax = agentOf(x); return clamp01(base + 0.45 * (ax && ax.mind ? ax.mind.feabout(y) : 0)); } : null;
      const closed = watch ? watch.closedLobbies() : [];
      const moves = applyHomophily(colony, society, { margin: config.homophilyMargin ?? 0.06, exclude: [...[boothZone, chargerZone, megaphoneZone].filter(Boolean).map((z) => z.name), ...homeZones.map((z) => z.name), ...closed], skip: (a) => !!a.charge || !!a.quest || !!a.asleep || !!a.onMic || !!a.atBooth || !!a.atBank || !!a.goingHome, affinity }); // a bot charging, on a quest, asleep, heading to the soapbox/booth, running to the bank, or home to pay rent — or a lobby the Watch has closed — isn't a migration target
      for (const m of moves) emit({ kind: "move", from: m.bot, text: `${m.bot} leaves ${m.from || "the open"} for ${m.to}` });
    }
  }

  return {
    colony, society, gossip, booth, megaphone, charger, watch, lobbyChat, volition, rumors, language, lexicographer, clock, chronicle, observatory, traffic, economy, topic: TOPIC, events,

    // Deterministic loop: bodies every frame, the social layer on a slower cadence. The clock advances on the
    // social cadence; a phase boundary re-evaluates who's awake (dormant bots go home / risers rejoin the town).
    tick(dt = 0.02) {
      traffic.tick();
      colony.tick(dt, traffic.enabled ? heldAtLight : null);
      if (++frame % SOCIAL_EVERY === 0) {
        const adv = clock.tick();
        if (adv.changed) { emit({ kind: "phase", text: `${PHASE_GLYPH[adv.phase] || ""} the ${adv.phase} settles over the town` }); applyDormancy(); }
        socialStep();
      }
    },

    // Autonomous lobby conversation: pick a ready lobby with >=2 townsfolk and run a short debate (async, mouth).
    async serviceLobbies() {
      const lobs = colony.lobbies();
      for (const name of Object.keys(lobs)) {
        if (lobs[name].length >= 2 && lobbyChat.ready(name)) {
          const res = await lobbyChat.chat(name, lobs[name]); // lines are emitted per-turn via onLine as they land
          return res;
        }
      }
      return null;
    },

    // Async voice services — call these on their own cadence (the browser does; a test can await them).
    async serviceBooth() {
      if (!booth) return null;
      const r = await booth.tick();
      if (r.phase === "released") { const home = randomLobby(); if (home) colony.sendTo(r.freed, home); emit({ kind: "booth", from: r.freed, text: `${r.freed} rejoins the ${home || "colony"}, full of news` }); }
      else if (r.convo && r.bot) { const said = r.convo.filter((m) => m.who === "user").length; emit({ kind: "booth", from: r.bot, text: said ? `${r.bot} spoke with the user (${said} exchange${said > 1 ? "s" : ""})` : `the user sent ${r.bot} away` }); }
      return r;
    },
    async serviceMegaphone() {
      const eligible = () => colony.agents.filter((a) => !a.asleep && !a.charge && !a.quest);
      // Apply the blast's EFFECT. The message is heard exactly (gossip fidelity 1), but the OPINION shift is a
      // resistible influence (not a guaranteed 100% sweep — that was the bug): the audience still filters it
      // through their openness + existing conviction, and being blasted a view you hate breeds a grudge.
      const applyBlast = (winner) => {
        const adv = society.advocacy(winner) || { topic: TOPIC, stance: 0 };
        const infl = config.megaphoneInfluence ?? 0.55;
        colony.agents.forEach((a) => {
          if (a.asleep) return;
          society.absorb(a.name, { topic: adv.topic, stance: adv.stance, fidelity: infl });
          if (useMinds && a.name !== winner && a.mind) { const dislike = -adv.stance * society.opinion(a.name, TOPIC).stance; if (dislike > 0.35) a.mind.onSlighted(winner, 0.4 * dislike, "shoved that at the whole town"); }
        });
      };

      // PHYSICAL SOAPBOX (opt-in): a speaker must WALK to the megaphone zone — one slot, no queue — and only
      // blasts on arrival, then is barred (personal cooldown) so nobody monopolises it.
      if (megaphoneZone) {
        if (mpHolder) {
          const a = agentOf(mpHolder);
          if (!a) { mpHolder = null; mpTravel = 0; return null; }
          if (a.zone !== megaphoneZone.name) {                 // still en route
            if (++mpTravel > 45) { a.onMic = false; mpHolder = null; mpTravel = 0; } // watchdog: gave up reaching the soapbox
            return { phase: "traveling", winner: mpHolder };
          }
          if (mpBusy) return null; mpBusy = true;
          try {
            const res = await megaphone.fireWith(mpHolder, eligible().map((x) => ({ name: x.name })));
            if (res) { applyBlast(res.winner); emit({ kind: "megaphone", from: res.winner, text: `📣 ${res.message}` }); }
            const home = randomLobby(); if (home) colony.sendTo(mpHolder, home);
            return res;
          } finally { a.onMic = false; mpHolder = null; mpTravel = 0; mpBusy = false; } // ALWAYS release the holder — a throw in fireWith/applyBlast must not wedge the soapbox

        }
        if (!megaphone.ready()) return null;
        const winner = megaphone.pick(eligible().map((x) => ({ name: x.name })), { weight: (b) => 0.5 + Math.abs(society.opinion(b.name, TOPIC).stance) });
        if (!winner) return null;
        mpHolder = winner; mpTravel = 0; const wa = agentOf(winner); if (wa) wa.onMic = true;
        colony.sendTo(winner, megaphoneZone.name);
        emit({ kind: "megaphone", from: winner, text: `📣 ${winner} strides to the soapbox…` });
        return { phase: "summon", winner };
      }

      // LEGACY immediate global blast (no soapbox zone configured — used by tests + the simple scenario).
      if (mpBusy || !megaphone.ready()) return null; mpBusy = true;
      try {
        const res = await megaphone.fire(colony.agents.filter((a) => !a.asleep).map((a) => ({ name: a.name })), { weight: (b) => 0.5 + Math.abs(society.opinion(b.name, TOPIC).stance) });
        if (res) { applyBlast(res.winner); emit({ kind: "megaphone", from: res.winner, text: `📣 ${res.message}` }); }
        return res;
      } finally { mpBusy = false; }
    },

    state() {
      const names = colony.agents.map((a) => a.name);
      const tribes = society.tribes(names, config.tribeThreshold ?? 0.62);
      const tribeOf = {}; tribes.forEach((t, i) => t.forEach((n) => (tribeOf[n] = i)));
      return {
        topic: TOPIC, zones: scenario.zones, boothZone: boothZone && boothZone.name,
        bots: colony.agents.map((a) => { const o = society.opinion(a.name, TOPIC); return { name: a.name, x: +a.mover.pose.x.toFixed(2), y: +a.mover.pose.y.toFixed(2), yaw: +a.mover.pose.yaw.toFixed(3), zone: a.zone, tribe: tribeOf[a.name] ?? 0, stance: +o.stance.toFixed(2), confidence: +o.confidence.toFixed(2), advocacy: society.advocacy(a.name), battery: charger ? Math.round(a.battery ?? 100) : null, charge: charger ? (a.charge || "") : "", chronotype: a.chronotype || "default", asleep: !!a.asleep, money: economy ? Math.round(a.money ?? 0) : null, job: a.job || null, rentDue: economy ? Math.round(a.rentDue ?? 0) : null, mood: a.mind ? a.mind.mood() : null, grudges: a.mind ? a.mind.grudges() : [], quest: a.quest ? { kind: a.quest.kind, target: a.quest.target || a.quest.targetZone } : null, reputation: rumors.reputation(a.name) }; }),
        lobbies: colony.lobbies(),
        tribes: tribes.map((t) => t.slice()),
        metrics: { polarization: society.polarization(names, TOPIC), consensus: society.consensus(names, TOPIC), tribeCount: tribes.length },
        charger: charger ? { zone: chargerZone.name, ports: charger.ports, portsFree: charger.portsFree(), queue: charger.queueLength(), onPorts: charger.onPorts() } : null,
        watch: watch ? { offenses: watch.totalOffenses(), post: watch.post() } : null,
        clock: clock.enabled ? { phase: clock.phase(), glyph: clock.glyph(), fraction: +clock.fraction().toFixed(3) } : null,
        traffic: traffic.enabled ? { phase: traffic.phase(), carH: traffic.carSignal("H"), carV: traffic.carSignal("V"), walkH: traffic.walk("H"), walkV: traffic.walk("V") } : null,
        economy: economy ? { treasury: Math.round(economy.treasury()), supply: economy.supply() } : null,
        lexicon: { keeper: lexicographer.keeper(), entries: rumors.dictionary() },
        chronicle: { lore: chronicle.lore().slice(-10), digest: chronicle.digest() },
        rumors: gossip.rumorStats().slice(0, 6).map((r) => ({ ...r, reach: +(r.holders / (names.length || 1)).toFixed(2) })),
        booth: booth ? { occupant: booth.occupant(), phase: booth.phase() } : null,
        megaphone: { ready: megaphone.ready(), cooldownLeft: Math.round(megaphone.cooldownLeft()), lastWinner: megaphone.lastWinner(), lastMessage: megaphone.lastMessage(), holder: mpHolder, banned: megaphone.bannedNames() },
        dictionary: rumors.dictionary().slice(0, 6),
        events: events.slice(-40),
      };
    },

    // Persistence for the inner life: a bot's grudges/wounds ARE the durable self, so "days ago" survives a
    // reload. The browser stashes this in IndexedDB and restores on boot; rumination re-creates the mood from it.
    // ENCULTURATION — the culture→individual return arrow. A newcomer doesn't arrive BLANK: it inherits the town's
    // official words (already speaks the dialect), its lore (knows the myths), the standing reputations (knows who's
    // who), and a lean toward the dominant view (grew up hearing it) — then it's free to reshape all of it. This is
    // what turns "a society of minds" into a civilization that RAISES its members. Returns what was inherited.
    induct(name) {
      const a = agentOf(name); if (!a) return null;
      const got = { words: 0, lore: 0, reputations: 0, leaned: 0 };
      // 1) the town's established words — it already speaks the dialect
      for (const w of rumors.dictionary()) if (w.status === "official" || w.reach >= 0.5) { gossip.seed(name, { text: w.token, topic: "meme", source: "the town", attribution: "the town", fidelity: 0.85 }); got.words++; }
      // 2) the town's lore — it knows the stories
      for (const s of chronicle.digest(6)) { gossip.seed(name, { text: s, topic: "lore", source: "town history", attribution: "everyone", fidelity: 0.9 }); got.lore++; }
      // 3) standing reputations — it knows who's who, and how they're regarded
      const rep = colony.agents.filter((x) => x.name !== name).map((x) => ({ who: x.name, r: rumors.reputation(x.name) })).filter((x) => x.r.mentions > 0).sort((x, y) => y.r.mentions - x.r.mentions).slice(0, 4);
      for (const { who, r } of rep) { const text = r.sentiment > 0.2 ? `${who} is well thought of` : r.sentiment < -0.2 ? `${who} has a rough name` : `everyone knows ${who}`; gossip.seed(name, { text, topic: "social", about: [who], rel: Math.sign(r.sentiment), source: "the town", attribution: "the town", fidelity: 0.8 }); got.reputations++; }
      // 4) it grew up hearing the dominant view → it starts LEANING toward consensus (but free to reshape it)
      const others = colony.agents.map((x) => x.name).filter((n) => n !== name);
      const mean = others.length ? others.reduce((s, n) => s + society.opinion(n, TOPIC).stance, 0) / others.length : 0;
      if (Math.abs(mean) > 0.05) { society.absorb(name, { topic: TOPIC, stance: mean, fidelity: 0.5 }); got.leaned = +mean.toFixed(2); }
      if (a.mind && a.mind.experience) a.mind.experience({ valence: 0.15, arousal: 0.3, kind: "belonging" }); // arriving into a town you already know feels like belonging
      emit({ kind: "lore", from: name, text: `✦ ${name} is welcomed in — already knowing the town's words${got.lore ? " and its stories" : ""}` });
      return got;
    },

    // CULTURE PERSISTENCE — the persistence seam extended from the individual (psyches) to the CIVILIZATION: the
    // shared lexicon, the collective opinions, the town's history, and the raw belief substrate. Snapshot this to
    // IndexedDB (like psyches) and a rebuild()/reload no longer wipes the culture — the town, not just its citizens,
    // has continuity. It's also what lets a live newcomer be inducted into REAL accumulated culture.
    snapshotCulture() { return { gossip: gossip.snapshot(), society: society.snapshot(), rumors: rumors.snapshot(), chronicle: chronicle.snapshot(), economy: economy ? economy.snapshot() : null }; },
    restoreCulture(data) { if (!data) return; if (data.gossip) gossip.restore(data.gossip); if (data.society) society.restore(data.society); if (data.rumors) rumors.restore(data.rumors); if (data.chronicle) chronicle.restore(data.chronicle); if (data.economy && economy) economy.restore(data.economy); },

    snapshotPsyches() { const out = {}; for (const a of colony.agents) if (a.mind && a.mind.snapshot) out[a.name] = a.mind.snapshot(); return out; },
    restorePsyches(data) { if (!data) return; for (const a of colony.agents) if (a.mind && a.mind.restore && data[a.name]) a.mind.restore(data[a.name]); },
  };
}
