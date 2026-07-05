// The Megaphone — one shared, pristine, GLOBAL channel with a long cooldown. When it's charged, a lottery picks
// one bot; that bot PLANS a single message (a question, a relay, a goal, a manifesto — its choice, via the
// injected `compose`), blasts it verbatim to every lobby AND the user at once, then steps down. Cooldown,
// re-lottery. The counterpoint to gossip: gossip is local and lossy; the megaphone is universal and exact.
//
// Two fairness controls (both bugfixes):
//  - PERSONAL TEMP-BAN: after you've used it, you're barred from the lottery for `personalCooldownMs` (on TOP of
//    the global cooldown), so the same loud bot can't monopolise it. Default 0 = off (legacy/tests).
//  - PHYSICAL POST (opt-in, driven by the orchestrator): instead of the immediate `fire()`, the caller uses
//    `pick()` to choose a speaker, walks them to a megaphone ZONE (1 slot, no queue), and calls `fireWith()` on
//    arrival. `fire()` stays as the legacy immediate path.
//
// `now` (wall ms) and `rng` are injected for deterministic tests; `compose(bot)` is the Ollama hook; `gossip`
// (optional) records the blast as a fidelity-1 belief for everyone (everyone HEARD it exactly — whether they're
// PERSUADED is the society layer's call, at a lower influence, so the megaphone is loud but not mind-control).

export function makeMegaphone({ now = () => 0, cooldownMs = 30000, personalCooldownMs = 0, rng = Math.random, compose = null, gossip = null } = {}) {
  let lastFired = -Infinity, lastWinner = null, lastMessage = null, fires = 0;
  const banned = new Map(); // name → wall-time they may use it again (personal temp-ban)

  const canUse = (name, t = now()) => (banned.get(name) ?? -Infinity) <= t;
  function lottery(bots, weight, t) {
    const pool = bots.filter((b) => canUse(b.name, t));
    const use = pool.length ? pool : bots;                // everyone banned? fall back to all so it never deadlocks
    const ws = use.map((b) => Math.max(0, weight ? weight(b) : 1));
    const total = ws.reduce((s, w) => s + w, 0) || use.length;
    let r = rng() * total, idx = 0;
    for (; idx < use.length; idx++) { r -= (weight ? ws[idx] : 1); if (r <= 0) break; }
    return use[Math.min(idx, use.length - 1)];
  }
  function record(winnerName, message, bots, t) {
    if (gossip) gossip.broadcast({ text: message, source: `${winnerName} 📣`, topic: "megaphone", fidelity: 1 }, bots.map((b) => b.name));
    lastFired = t; lastWinner = winnerName; lastMessage = message; fires++;
    if (personalCooldownMs > 0) banned.set(winnerName, t + personalCooldownMs); // this speaker is barred for a while
  }

  return {
    ready(t = now()) { return t - lastFired >= cooldownMs; },
    cooldownLeft(t = now()) { return Math.max(0, cooldownMs - (t - lastFired)); },
    lastWinner: () => lastWinner,
    lastMessage: () => lastMessage,
    fires: () => fires,
    canUse,
    bannedUntil: (name) => banned.get(name) ?? 0,
    bannedNames(t = now()) { return [...banned.entries()].filter(([, u]) => u > t).map(([n]) => n); },

    // PHYSICAL MODE step 1 — choose a speaker WITHOUT firing (so the caller can walk them to the post first).
    // Returns a name, or null if still on global cooldown / no eligible bots.
    pick(bots, { weight } = {}) {
      const t = now();
      if (t - lastFired < cooldownMs || !bots || !bots.length) return null;
      return lottery(bots, weight, t).name;
    },

    // PHYSICAL MODE step 2 — record the blast for an ALREADY-CHOSEN speaker (on arrival at the post). Composes if
    // a hook is set. Returns { winner, message, at } or null if the global cooldown re-closed meanwhile.
    async fireWith(winnerName, bots, { onBroadcast } = {}) {
      const t = now();
      if (t - lastFired < cooldownMs) return null;
      const winner = bots.find((b) => b.name === winnerName) || { name: winnerName };
      const message = compose ? await compose(winner) : `${winner.name} has taken the megaphone.`;
      record(winner.name, message, bots, t);
      if (onBroadcast) onBroadcast(winner, message);
      return { winner: winner.name, message, at: t };
    },

    // LEGACY immediate fire (non-physical): pick + compose + record in one call. Still honours the personal ban.
    async fire(bots, { onBroadcast, weight } = {}) {
      const t = now();
      if (t - lastFired < cooldownMs || !bots || !bots.length) return null;
      const winner = lottery(bots, weight, t);
      const message = compose ? await compose(winner) : `${winner.name} has taken the megaphone.`;
      record(winner.name, message, bots, t);
      if (onBroadcast) onBroadcast(winner, message);
      return { winner: winner.name, message, at: t };
    },
  };
}
