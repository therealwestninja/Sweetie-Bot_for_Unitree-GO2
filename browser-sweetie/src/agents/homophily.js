// Homophily movement — the step that makes tribes PHYSICAL. Each bot prefers the lobby whose occupants it
// agrees with most (allies attract) and flees lobbies full of rivals (disagreement repels), so opinion
// clusters pull themselves into separate rooms. Affinity is mapped to a signed pull (2·a−1: >0 ally, <0
// rival), averaged over a lobby's occupants; an empty lobby is neutral (0). A margin adds hysteresis so a
// contented bot doesn't thrash between near-equal rooms.

export function preferredLobby(colony, society, botName, { margin = 0.15, current = null } = {}) {
  const lob = colony.lobbies();
  const score = (zoneName) => {
    const occ = (lob[zoneName] || []).filter((n) => n !== botName);
    let s = 0, n = 0;
    for (const other of occ) { const a = society.affinity(botName, other); if (a != null) { s += 2 * a - 1; n++; } }
    return n ? s / n : 0; // mean signed affinity; empty room = neutral
  };
  let best = null;
  for (const z of colony.zones) { const v = score(z.name); if (best === null || v > best.v) best = { zone: z.name, v }; }
  if (!best) return current;
  if (current && score(current) + margin >= best.v) return current; // stay unless a room is clearly better
  return best.zone;
}

// Convenience driver: migrate settled bots toward their preferred lobby. Uses SEQUENTIAL greedy assignment —
// a working occupancy updated as each bot decides — so within one round a bot sees its neighbours' fresh
// choices. That's what lets a balanced group actually break apart and converge (a purely simultaneous vote
// stalls: nobody moves first). Call periodically (not every tick) so bots finish a trip before re-deciding.
export function applyHomophily(colony, society, { margin = 0.05, onlyArrived = true, exclude = [], skip = () => false, affinity = null } = {}) {
  // affinity(a,b) override lets the caller blend in FEELINGS (a grudge) on top of opinion-affinity, so a wound
  // physically repels — you storm off from someone you can't stand, not just someone you disagree with.
  const aff = affinity || ((a, b) => society.affinity(a, b));
  const occ = {};
  for (const a of colony.agents) occ[a.name] = colony.zoneOf(a.mover.pose);
  const scoreFor = (botName, zoneName) => {
    let s = 0, n = 0;
    for (const other of colony.agents) { if (other.name === botName || occ[other.name] !== zoneName) continue; const a = aff(botName, other.name); if (a != null) { s += 2 * a - 1; n++; } }
    return n ? s / n : 0;
  };
  const moves = [];
  for (const a of colony.agents) {
    if (skip(a)) continue;                                  // e.g. a knight in the charge queue / on a port
    if (onlyArrived && a.mover.hasGoal()) continue;         // don't redirect a bot mid-walk
    const cur = occ[a.name];
    if (exclude.includes(cur)) continue;                    // leave bots in an excluded zone alone (e.g. the booth)
    let best = null;
    for (const z of colony.zones) { if (exclude.includes(z.name)) continue; const v = scoreFor(a.name, z.name); if (best === null || v > best.v) best = { zone: z.name, v }; }
    const stay = cur ? scoreFor(a.name, cur) : -Infinity;
    if (best && best.zone !== cur && best.v > stay + margin) { colony.sendTo(a.name, best.zone); occ[a.name] = best.zone; moves.push({ bot: a.name, from: cur, to: best.zone }); }
  }
  return moves;
}
