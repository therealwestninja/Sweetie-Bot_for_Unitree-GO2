// The communal charger — a "gas station" with a FIXED number of ports, and the colony's forcing function for
// motion + mixing. Batteries drain (faster while walking); when a knight runs low it abandons its room and
// makes for the charger. If the ports are full it joins a QUEUE (a physical lineup → congestion). While it's
// there — charging OR waiting — it does "water-cooler" gossip with whoever else is there, and because low
// batteries strike knights from ALL rooms, the charger is where rumours jump between tribes. Without this the
// colony freezes: once a room agrees, gossip dries up and nobody has any reason to move. This keeps it churning.
//
// Owns the battery lifecycle; the orchestrator ticks it and must exclude charge-flow knights from homophily/booth.

export function makeCharger({ colony, gossip, zone, ports = 2, low = 22, full = 96, fairFull = 62, maxChargeTicks = 90, drainMove = 0.15, drainIdle = 0.05, chargeRate = 1.2, onRelease = null, rng = null, drainJitter = 0, batteryJitter = 0, now = () => 0 } = {}) {
  const portPts = Array.from({ length: ports }, (_, i) => ({ x: zone.x + (i - (ports - 1) / 2) * 0.62, y: zone.y + 0.35 }));
  const queuePt = (i) => ({ x: zone.x + ((i % 3) - 1) * 0.55, y: zone.y - 0.55 - Math.floor(i / 3) * 0.6 }); // a line behind the ports
  const occupants = new Array(ports).fill(null);   // bot name per port
  const since = new Array(ports).fill(0);          // ticks the current occupant has held the port
  let queue = [];                                  // bot names waiting, front = next served
  const byName = (n) => colony.agents.find((a) => a.name === n);
  // Live-tunable rates (the UI sliders mutate these via configure()).
  const P = { low, full, fairFull, maxChargeTicks, drainMove, drainIdle, chargeRate };

  // Stagger initial batteries (deterministic unless batteryJitter+rng → random start), and give each bot a
  // drain MULTIPLIER (varied when drainJitter+rng) so demand isn't perfectly synchronised → organic traffic.
  colony.agents.forEach((a, i) => {
    if (a.battery == null) a.battery = (batteryJitter && rng) ? 30 + rng() * 65 : 45 + (i * 29) % 55;
    if (a.charge == null) a.charge = "";
    if (a.drainMul == null) a.drainMul = (drainJitter && rng) ? (1 - drainJitter) + rng() * 2 * drainJitter : 1;
  });
  const reslotQueue = () => queue.forEach((n, i) => { const q = queuePt(i); colony.sendToPoint(n, q.x, q.y); });

  return {
    zone, ports,
    portsFree: () => occupants.filter((o) => !o).length,
    queueLength: () => queue.length,
    onPorts: () => occupants.slice(),
    queued: () => queue.slice(),
    inFlow: (name) => { const a = byName(name); return !!(a && a.charge); },
    configure: (patch) => Object.assign(P, patch),      // live slider hook
    rates: () => ({ ...P }),

    // One charge cycle (call on the social cadence). Returns events for the log.
    tick(dt = 1) {
      const events = [];
      // 1) drain knights who are OUT AND ABOUT; a fresh low reading sends them to the queue. A bot already in
      // the charge flow (queued in line OR on a port) is parked, not driving, so it doesn't drain — this is
      // what stops a bot from starving to 0% while it waits behind fuller bots.
      for (const a of colony.agents) {
        if (a.charge || a.asleep || a.onMic || a.atBooth) continue;   // a bot in the charge flow, asleep, or summoned to the soapbox/booth isn't draining (and mustn't be pulled into the queue mid-errand)
        a.battery = Math.max(0, a.battery - (a.mover.hasGoal() ? P.drainMove : P.drainIdle) * (a.drainMul || 1) * dt);
        if (a.charge === "" && a.battery <= P.low) { a.charge = "queued"; queue.push(a.name); reslotQueue(); events.push({ kind: "charge", from: a.name, text: `${a.name}'s battery is low (${Math.round(a.battery)}%) — heading to the charger` }); }
      }
      // 2) seat the queue into any free ports (FIFO = fair lineup)
      for (let p = 0; p < ports; p++) {
        if (!occupants[p] && queue.length) {
          const name = queue.shift(); reslotQueue(); occupants[p] = name; since[p] = 0;
          const a = byName(name); a.charge = "charging"; colony.sendToPoint(name, portPts[p].x, portPts[p].y);
          events.push({ kind: "charge", from: name, text: `${name} plugs into port ${p + 1}` });
        }
      }
      // 3) charge the seated; release when full → they rejoin colony life (homophily re-places them)
      for (let p = 0; p < ports; p++) {
        const name = occupants[p]; if (!name) continue; const a = byName(name);
        a.battery = Math.min(100, a.battery + P.chargeRate * dt); since[p] += dt;
        // FAIR-SHARE: if others are waiting, top up only to fairFull and YIELD the port (don't hog it to 100%).
        // A hard time cap evicts anyone who's held a port too long no matter what — the anti-camping backstop.
        const target = queue.length ? P.fairFull : P.full;
        if (a.battery >= target || since[p] >= P.maxChargeTicks) {
          const timedOut = a.battery < target;
          occupants[p] = null; a.charge = "";
          events.push({ kind: "charge", from: name, text: timedOut ? `⏱ ${name}'s charge time is up — yields port ${p + 1}` : `${name} tops up (${Math.round(a.battery)}%) and frees port ${p + 1}` });
          if (onRelease) onRelease(name); // leave the charger immediately so the next in line can reach the port
        }
      }
      // 4) water-cooler gossip among everyone AT the charger (seated + queued) — cross-tribe mixing
      const here = [...occupants.filter(Boolean), ...queue];
      for (let i = 0; i < here.length - 1; i++) {
        const b = gossip.relay(here[i], here[i + 1], { decay: 0.1 });
        if (b) events.push({ kind: "cooler", from: here[i], to: here[i + 1], belief: b, text: `at the charger, ${here[i]} tells ${here[i + 1]}: “${b.text}”` });
      }
      return events;
    },
  };
}
