// The Watch — the town's law enforcement / cityguard. A continuous social sim drifts into pathologies:
// bots CAMP (park somewhere and never move), SQUAT a charger port, BLOCK a chokepoint, or get STUCK orbiting
// a nav local-minimum and look like loiterers. Left alone these gum up traffic (the charger lineup that never
// clears). The Watch patrols the rules: it tracks how long each bot has been stationary and, if a bot is
// loitering somewhere it has no business resting — the open, a chokepoint, or the charger without actually
// charging — it MOVES THEM ALONG (re-routes them to a lobby, which also hands a stuck bot a fresh path).
//
// Legit resting (settled in a lobby) and legit charging/queueing are never harassed. Repeat offenders are
// counted, so the UI can show who keeps getting told to move.

// `interaction` (optional) lets the Watch police SOCIAL duration too, not just physical loitering: it's
// { who: () => name|null, forceBreak: () => bool } — the current long-form conversation (the booth audience) and
// a way to end it. Past convoCap ticks the Watch steps in and breaks it up, the social mirror of moving a camper
// along. Without it the Watch behaves exactly as before.
export function makeWatch({ colony, chargerZone = null, lobbyZones = [], interaction = null, config = {} } = {}) {
  const C = { moveEps: 0.08, campTicks: 26, convoCap: 20, patrol: false, patrolEvery: 30, ...config }; // "stationary" = moved < moveEps since last check; campTicks before action; convoCap = max audience ticks; patrol = the Watch occupies a lobby and rotates
  const rng = config.rng || Math.random;
  const lobbyNames = lobbyZones.map((z) => z.name);
  const dwell = new Map(), lastPos = new Map(), offenses = new Map();
  const chargerName = chargerZone && chargerZone.name;
  let convoWho = null, convoAge = 0;   // whose audience is running, and for how many ticks
  let post = null, patrolClock = 0;    // the lobby the Watch is standing in (closed to others), + rotation clock

  return {
    // Call on the social cadence. Returns intervention events.
    tick() {
      const events = [];
      for (const a of colony.agents) {
        const p = a.mover.pose, lp = lastPos.get(a.name);
        const moved = lp ? Math.hypot(p.x - lp.x, p.y - lp.y) : 999;
        lastPos.set(a.name, { x: p.x, y: p.y });
        dwell.set(a.name, moved < C.moveEps ? (dwell.get(a.name) || 0) + 1 : 0);

        // Only two things are actually illegal loitering: SQUATTING the charger while not charging, or being
        // parked in the deep OPEN (no zone at all — blocking a path). Resting in a lobby, or being anywhere WITH
        // a goal (still travelling), is fine. This keeps the Watch invisible during normal life + jostling.
        // never harass a bot another subsystem OWNS right now: charging, asleep at home, summoned to the soapbox
        // (onMic) or the booth (atBooth). Moving those along would yank them out from under that subsystem.
        const illegal = !a.charge && !a.asleep && !a.onMic && !a.atBooth && !a.mover.hasGoal() && (a.zone === chargerName || !a.zone);
        if (dwell.get(a.name) >= C.campTicks && illegal) {
          const z = lobbyNames.length ? lobbyNames[Math.floor(rng() * lobbyNames.length)] : null;
          if (z) colony.sendTo(a.name, z);
          offenses.set(a.name, (offenses.get(a.name) || 0) + 1);
          dwell.set(a.name, 0);
          const where = (chargerName && a.zone === chargerName) ? "loitering at the spa" : a.zone ? `loitering in the ${a.zone}` : "blocking the way"; // guard chargerName: it's null with the economy on, so a no-zone open-blocker must read "blocking the way", not "at the spa"
          events.push({ kind: "watch", from: a.name, text: `🛡 the watch moves ${a.name} along — ${where}` });
        }
      }

      // Break up a booth audience that has dragged on past convoCap (the social loiterer).
      if (interaction) {
        const who = interaction.who();
        if (who && who === convoWho) convoAge++; else { convoWho = who; convoAge = who ? 1 : 0; }
        if (who && convoAge > C.convoCap) {
          if (interaction.forceBreak()) { offenses.set(who, (offenses.get(who) || 0) + 1); events.push({ kind: "watch", from: who, text: `🛡 the watch gently wraps up ${who}'s long visit at the booth` }); }
          convoWho = null; convoAge = 0;
        }
      }
      // PATROL: the Watch takes a post inside a lobby, which CLOSES it — the residents are moved along to other
      // open rooms and routing keeps others out. As the Watch rotates its post it churns the whole town, quite
      // apart from any rule it's enforcing. Emergent, unintended disruption — exactly the point.
      if (C.patrol && lobbyNames.length >= 2) {
        patrolClock++;
        if (post === null || patrolClock >= C.patrolEvery) {
          patrolClock = 0;
          const openFrom = lobbyNames.filter((n) => n !== post);
          post = openFrom[Math.floor(rng() * openFrom.length)];      // move to a NEW lobby (never re-pick the same)
          const elsewhere = lobbyNames.filter((n) => n !== post);
          events.push({ kind: "watch", from: "watch", text: `🛡 the watch takes up a post in the ${post}` });
          for (const a of colony.agents) {
            if (a.charge || a.quest || a.asleep || a.onMic || a.atBooth) continue; // don't yank charge-flow / quest / asleep / soapbox-bound / booth-bound bots
            if (a.targetZone === post || a.zone === post) {
              const to = elsewhere[Math.floor(rng() * elsewhere.length)];
              colony.sendTo(a.name, to);
              events.push({ kind: "watch", from: a.name, text: `🛡 ${a.name} is moved out of the ${post} → heads to the ${to}` });
            }
          }
        }
      }
      return events;
    },
    post: () => post,
    isClosed: (zoneName) => C.patrol && zoneName === post,
    closedLobbies: () => (C.patrol && post ? [post] : []),
    offenses: (name) => offenses.get(name) || 0,
    totalOffenses: () => [...offenses.values()].reduce((s, n) => s + n, 0),
  };
}
