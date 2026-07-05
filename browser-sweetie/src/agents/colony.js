// Colony — the multi-agent stage. A shared arena of static obstacles + named ZONE circles (the chat lobbies)
// + N bots, each an independent navigator. Every tick, each bot is stepped with the OTHER bots injected as
// dynamic obstacles, so they route around one another — the "navigate between lobbies without collision"
// requirement. This module is the PHYSICAL + SPATIAL-SOCIAL substrate; the discussion/goals/tribes layer
// (Stage B, Ollama) sits on top and reads `lobbies()` / drives `sendTo()`.
//
// Zones carry a `purpose` (what the lobby is for) so the social layer — and the bots themselves — know what
// each circle does. A bot is "in" a zone when its pose is inside the circle.
import { makeMover } from "./mover.js";

export function makeColony({ statics = [], zones = [], bots = [], walls = [], openings = [], bounds = null, botRadius = 0.28, jitter = 0, rng = Math.random } = {}) {
  const nav = { walls, openings }; // building walls + doorway/crosswalk gaps, handed to the planner on every setGoal
  // bots: [{ name, persona?, goal?, pose? }]. Each gets a mover; extra fields are preserved for Stage B.
  const agents = bots.map((b, i) => ({
    ...b,
    mover: makeMover({ pose: b.pose ? { ...b.pose, yaw: b.pose.yaw ?? 0 } : { x: 0, y: 0, yaw: 0 }, radius: botRadius, speed: b.speed ?? 0.5, jitter, rng }),
    zone: null, targetZone: null, _slot: i,
  }));

  const AVOID_MARGIN = 0.06; // inflate a neighbour's radius a touch so bots keep a comfortable gap
  // Steering (unlike A*) doesn't know about walls, so a crowded bot can get shoved THROUGH a building facade. We can't
  // clamp against every wall — the ROAD bands are also "walls" (thick blocked rects with crosswalk openings) and must
  // stay under the crosswalk-gate logic, not be yanked out from under a crossing bot. So clamp only THIN solids
  // (building perimeters + the boundary): a bot whose centre lands inside one — and NOT inside a doorway opening — is
  // pushed out its nearest face. wallInflate keeps the bot's BODY off the facade, not just its centre.
  const WALL_MARGIN = botRadius * 0.6;
  const clampWalls = walls.filter((w) => Math.min(w.w, w.h) <= 0.5); // thin rects only → buildings + map boundary, never the roads
  const inRectM = (p, r, m = 0) => Math.abs(p.x - r.x) <= r.w / 2 + m && Math.abs(p.y - r.y) <= r.h / 2 + m;
  function clampOutOfWalls(p) {
    for (const w of clampWalls) {
      if (!inRectM(p, w)) continue;                                   // centre isn't in this wall
      if (openings.some((o) => inRectM(p, o))) continue;              // it's in a doorway / crosswalk gap → let it through
      const dl = p.x - (w.x - w.w / 2), dr = (w.x + w.w / 2) - p.x, db = p.y - (w.y - w.h / 2), dt = (w.y + w.h / 2) - p.y;
      const m = Math.min(dl, dr, db, dt);                             // nearest face → shortest way out
      if (m === dl) p.x = w.x - w.w / 2 - WALL_MARGIN;
      else if (m === dr) p.x = w.x + w.w / 2 + WALL_MARGIN;
      else if (m === db) p.y = w.y - w.h / 2 - WALL_MARGIN;
      else p.y = w.y + w.h / 2 + WALL_MARGIN;
    }
  }
  const zoneByName = (n) => zones.find((z) => z.name === n) || null;
  // A bot is "in" a zone if inside its footprint — a rectangle (a building, has w/h) or a circle (an open spot).
  const inZoneShape = (pose, z) => (z.w != null ? (Math.abs(pose.x - z.x) <= z.w / 2 && Math.abs(pose.y - z.y) <= z.h / 2) : Math.hypot(pose.x - z.x, pose.y - z.y) <= z.radius);
  const zoneOf = (pose) => { for (const z of zones) if (inZoneShape(pose, z)) return z.name; return null; };
  // The radius bots ring-slot within: a building's interior (away from its walls), or the circle's radius.
  const slotRadius = (z) => (z.w != null ? Math.max(0.3, Math.min(z.w, z.h) / 2 - 0.55) : z.radius * 0.85);

  // Re-slot every bot currently headed to a zone onto an EVENLY-spaced ring, sized so neighbours' standing
  // points clear each other (chord ≥ 2·radius + gap). Re-run whenever the cohort changes so a crowd spreads
  // out instead of fighting for the centre.
  function reslot(zoneName) {
    const z = zoneByName(zoneName); if (!z) return;
    const cohort = agents.filter((a) => a.targetZone === zoneName);
    const n = cohort.length;
    const ringR = n <= 1 ? 0 : Math.min(slotRadius(z), (botRadius + 0.1) / Math.sin(Math.PI / n));
    cohort.forEach((a, k) => {
      const ang = (k / n) * Math.PI * 2;
      const s = n <= 1 ? { x: z.x, y: z.y } : { x: z.x + Math.cos(ang) * ringR, y: z.y + Math.sin(ang) * ringR };
      a.mover.setGoal(s.x, s.y, statics, nav);
    });
  }

  // Everything a given bot must avoid THIS tick: nearby static obstacles + every other bot's (inflated) disk.
  function obstaclesFor(self) {
    const p = self.mover.pose;
    const near = statics.filter((o) => Math.hypot(o.x - p.x, o.y - p.y) - o.radius < 2.2);
    const others = agents.filter((a) => a !== self).map((a) => ({ x: a.mover.pose.x, y: a.mover.pose.y, radius: botRadius + AVOID_MARGIN }));
    return [...near, ...others];
  }

  return {
    agents, zones, statics, walls, openings, botRadius,
    zoneOf, zoneByName,

    // Send a bot to a zone (routes around statics; bots dodge each other en route). Re-slots both the old and
    // new zone cohorts so both spread evenly.
    sendTo(botName, zoneName) {
      const a = agents.find((x) => x.name === botName), z = zoneByName(zoneName);
      if (!a || !z) return false;
      const prev = a.targetZone;
      if (prev === zoneName) return true; // already heading here — re-slotting the whole cohort again would shuffle everyone's
      // target out from under them (bots then chase moving slots and JITTER). Only re-slot when the cohort actually changes.
      a.targetZone = zoneName;
      reslot(zoneName);
      if (prev && prev !== zoneName) reslot(prev);
      return true;
    },

    // Send a bot to an ARBITRARY point (not a zone-slot) — used for charger ports / queue positions.
    sendToPoint(botName, x, y) { const a = agents.find((z) => z.name === botName); if (!a) return false; a.targetZone = null; a.mover.setGoal(x, y, statics, nav); return true; },

    tick(dt = 0.02, isHeld = null) {
      // isHeld(agent) → true freezes that agent this tick (a bot waiting at a red crosswalk). It still updates its zone.
      for (const a of agents) { if (isHeld && isHeld(a)) continue; a.mover.step(dt, obstaclesFor(a)); }
      // Bulletproof containment: steering (unlike A*) doesn't know about walls, so a crowded bot can get shoved
      // THROUGH a boundary wall into the void. Clamp every pose back inside the world so nobody leaves the map.
      if (bounds) for (const a of agents) { const p = a.mover.pose; p.x = Math.max(bounds.minX, Math.min(bounds.maxX, p.x)); p.y = Math.max(bounds.minY, Math.min(bounds.maxY, p.y)); }
      if (clampWalls.length) for (const a of agents) clampOutOfWalls(a.mover.pose); // keep bots out of building facades (steering-proof, doorway-aware)
      for (const a of agents) a.zone = zoneOf(a.mover.pose);
    },

    // --- introspection (Stage B + tests + UI) ---
    state() { return agents.map((a) => ({ name: a.name, x: +a.mover.pose.x.toFixed(2), y: +a.mover.pose.y.toFixed(2), zone: a.zone, target: a.targetZone, arrived: !a.mover.hasGoal() })); },
    lobbies() { const m = {}; for (const a of agents) if (a.zone) (m[a.zone] = m[a.zone] || []).push(a.name); return m; },
    inZone(zoneName) { return agents.filter((a) => a.zone === zoneName).map((a) => a.name); },
    allArrived() { return agents.every((a) => !a.mover.hasGoal()); },
    // Closest approach between any two bots — the collision safety signal (should stay ≥ 2·botRadius).
    minSeparation() {
      let mn = Infinity;
      for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
        const d = Math.hypot(agents[i].mover.pose.x - agents[j].mover.pose.x, agents[i].mover.pose.y - agents[j].mover.pose.y);
        if (d < mn) mn = d;
      }
      return mn;
    },
  };
}
