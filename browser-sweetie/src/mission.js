// Mission layer — the behaviour/task modes that sit ON TOP of nav (planner+steering) + perception + cognition.
// Each mode is a tiny state machine advanced by tick(); it issues go_to_pose goals and reads pose/vision to
// decide progress + success, exposing { status, phase, metrics }. The point: point-to-point nav tests one
// faculty; these modes exercise the whole stack, and they're written to be REAL robot behaviours (seed-able
// from volition later), not harness-only scaffolding.
//
// Implemented (geometry-only, no LLM): patrol · search-pattern · follow · search · roam.
// Scaffolded (need Ollama, structured with hooks): junkyard-dog · sleuth.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (dx, dy) => { const m = Math.hypot(dx, dy) || 1; return [dx / m, dy / m]; };

// --- coverage pattern generators (world coords) ---
function lawnmower({ minX, maxX, minY, maxY }, lane = 1.0) {
  const pts = []; let dir = 1;
  for (let y = minY; y <= maxY + 1e-6; y += lane) {
    pts.push({ x: dir > 0 ? minX : maxX, y }); pts.push({ x: dir > 0 ? maxX : minX, y }); dir = -dir;
  }
  return pts;
}
function spiral(center, rings = 4, step = 0.7) {
  const pts = []; let r = step, a = 0;
  for (let i = 0; i < rings * 8; i++) { pts.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r }); a += Math.PI / 4; r += step / 8; }
  return pts;
}

export function makeMission({ type, params = {}, sim, cog = null } = {}) {
  const pose = () => sim.bridge.state.pose;
  const goTo = (p) => sim.bridge.goToPose(p.x, p.y);
  const seesName = (name) => sim.perc.visionSummary(pose().x, pose().y, pose().yaw).some((v) => new RegExp(name.replace(/^the /, ""), "i").test(v.name));
  const arriveR = params.arriveR ?? 0.4;

  let status = "running", phase = "init", ticks = 0, issued = false;
  const M = {};                 // per-mode mutable state
  const metrics = { ticks: 0 };

  // ---- per-mode tick handlers ----
  const modes = {
    // Cycle waypoints A→B→C…, dwelling at each; succeed after `laps` loops.
    patrol() {
      const pts = params.points || []; if (!pts.length) return fail("no points");
      if (M.i === undefined) { M.i = 0; M.lap = 0; M.dwell = 0; goTo(pts[0]); }
      if (M.dwell > 0) { M.dwell--; if (M.dwell === 0) { M.i = (M.i + 1) % pts.length; if (M.i === 0) M.lap++; if (M.lap >= (params.laps ?? 1)) return done("patrolled"); goTo(pts[M.i]); } return set(`dwell@${M.i}`); }
      if (dist(pose(), pts[M.i]) < arriveR) { M.dwell = params.dwell ?? 30; return set(`reached ${M.i}`); }
      if (!sim.bridge.hasNavTarget()) goTo(pts[M.i]);
      return set(`transit→${M.i}`);
    },
    // Sweep a coverage pattern over an area; succeed when the last waypoint is reached.
    "search-pattern"() {
      if (!M.wp) { M.wp = (params.pattern === "spiral") ? spiral(params.center || { x: 0, y: 0 }, params.rings, params.step) : lawnmower(params.area, params.lane); M.i = 0; goTo(M.wp[0]); metrics.waypoints = M.wp.length; }
      if (dist(pose(), M.wp[M.i]) < arriveR) { M.i++; metrics.covered = M.i; if (M.i >= M.wp.length) return done("area swept"); goTo(M.wp[M.i]); }
      else if (!sim.bridge.hasNavTarget()) goTo(M.wp[M.i]);
      return set(`sweep ${M.i}/${M.wp.length}`);
    },
    // Trail a moving actor at a standoff distance; succeed if kept in range for `duration` ticks.
    follow() {
      const e = sim.world.byName(params.target); if (!e) return fail("no target");
      const d = dist(pose(), e);
      metrics.inRange = (metrics.inRange || 0) + (d <= (params.maxDist ?? 3) ? 1 : 0);
      metrics.samples = (metrics.samples || 0) + 1; metrics.lastDist = +d.toFixed(2);
      const [ux, uy] = unit(pose().x - e.x, pose().y - e.y);            // stand off on the near side
      if (ticks % 8 === 0) goTo({ x: e.x + ux * (params.standoff ?? 1.0), y: e.y + uy * (params.standoff ?? 1.0) });
      if (ticks >= (params.duration ?? 500)) return metrics.inRange / metrics.samples > 0.6 ? done("kept up") : fail("lost them");
      return set(`follow ${d.toFixed(1)}m`);
    },
    // Explore a search route until the target enters view; succeed on first sighting.
    search() {
      if (!M.wp) { M.wp = params.route || lawnmower(params.area || { minX: -3, maxX: 3, minY: -3, maxY: 3 }, params.lane || 1.5); M.i = 0; goTo(M.wp[0]); }
      if (seesName(params.target)) { metrics.foundAtTick = ticks; return done(`spotted ${params.target}`); }
      if (dist(pose(), M.wp[M.i]) < arriveR) { M.i++; if (M.i >= M.wp.length) return fail("swept, not found"); goTo(M.wp[M.i]); }
      else if (!sim.bridge.hasNavTarget()) goTo(M.wp[M.i]);
      return set(`searching ${M.i}/${M.wp.length}`);
    },
    // Wander random reachable points indefinitely (harness-level roam; the real one is the W4 idle driver).
    roam() {
      if (M.next === undefined || dist(pose(), M.next) < arriveR || !sim.bridge.hasNavTarget()) {
        const a = params.area || { minX: -4, maxX: 4, minY: -4, maxY: 4 };
        // deterministic-ish pseudo-random from the tick counter (no Math.random dependency for tests)
        const r = (n) => ((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1;
        M.next = { x: a.minX + r(ticks + 1) * (a.maxX - a.minX), y: a.minY + r(ticks + 7) * (a.maxY - a.minY) };
        goTo(M.next); metrics.waypointsVisited = (metrics.waypointsVisited || 0) + 1;
      }
      if (ticks >= (params.duration ?? 800)) return done("roamed");
      return set("roaming");
    },

    // ---- SCAFFOLDED (Ollama) — structured FSMs; the language hooks are marked TODO ----
    // Guard a zone: patrol its perimeter; on an intruder, investigate → challenge (bark/ESCALATE via cog).
    "junkyard-dog"() {
      const zone = params.zone; const intruder = params.intruder && sim.world.byName(params.intruder);
      const inZone = intruder && zone && intruder.x >= zone.minX && intruder.x <= zone.maxX && intruder.y >= zone.minY && intruder.y <= zone.maxY;
      if (inZone) {
        M.state = "challenge";
        goTo({ x: intruder.x, y: intruder.y }); // move to confront
        // TODO(Ollama): cog.converse(`An intruder entered your territory: ${params.intruder}`) → a bark/ESCALATE
        //   line; escalate the brain's threat channel; back off when they leave. One call, on cooldown.
        return set(`CHALLENGE ${params.intruder}`);
      }
      // patrol the perimeter when clear
      if (!M.perim) { M.perim = zone ? [{ x: zone.minX, y: zone.minY }, { x: zone.maxX, y: zone.minY }, { x: zone.maxX, y: zone.maxY }, { x: zone.minX, y: zone.maxY }] : []; M.i = 0; if (M.perim[0]) goTo(M.perim[0]); }
      if (M.perim.length && dist(pose(), M.perim[M.i]) < arriveR) { M.i = (M.i + 1) % M.perim.length; goTo(M.perim[M.i]); }
      return set("guarding");
    },
    // Approach an NPC, ask for directions (Ollama), parse a destination, navigate there.
    sleuth() {
      const npc = sim.world.byName(params.npc); if (!npc) return fail("no npc");
      if (!M.phase2) {
        if (dist(pose(), npc) > (params.talkDist ?? 1.4)) { if (!sim.bridge.hasNavTarget()) goTo({ x: npc.x, y: npc.y }); return set("approaching NPC"); }
        M.phase2 = "asked";
        // TODO(Ollama): const r = await cog.converse("Excuse me — which way to <thing>?"); then parse a
        //   {x,y} destination or a landmark name out of r.speech (structured-output prompt), set M.dest.
        M.dest = params.fallbackDest || null;               // until the language hook lands
        return set("asking directions");
      }
      if (M.dest) { if (!M.went) { goTo(M.dest); M.went = true; } if (dist(pose(), M.dest) < arriveR) return done("followed directions"); return set("heading where told"); }
      return set("no directions yet");
    },
  };

  function set(p) { phase = p; return { status, phase }; }
  function done(p) { status = "succeeded"; phase = p; return { status, phase }; }
  function fail(p) { status = "failed"; phase = p; return { status, phase }; }

  const handler = modes[type];
  return {
    type, params,
    get status() { return status; },
    get phase() { return phase; },
    tick() {
      if (status !== "running") return { status, phase };
      if (!handler) return fail(`unknown mode '${type}'`);
      ticks++; metrics.ticks = ticks;
      return handler();
    },
    metrics: () => ({ ...metrics }),
    reset() { status = "running"; phase = "init"; ticks = 0; issued = false; for (const k of Object.keys(M)) delete M[k]; for (const k of Object.keys(metrics)) delete metrics[k]; metrics.ticks = 0; },
  };
}
