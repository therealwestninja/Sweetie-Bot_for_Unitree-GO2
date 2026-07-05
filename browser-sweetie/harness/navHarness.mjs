// Navigation test harness — drops Sweetie into a scene with a go_to_pose goal, runs the body headless, and
// measures whether she gets there AND how cleanly (clearance / collisions), since the world has no collision
// physics: without avoidance she reaches goals by clipping straight THROUGH obstacles, so clearance is the
// real nav-quality signal. At encounter moments she talks with an Ollama-driven actor (her mouth is Ollama
// too), so the run also exercises bot/human interaction — gently (capped, on cooldown, never per tick).
import { makeSim } from "../src/simLoop.js";
import { makeCognition } from "../src/cognition.js";
import { makeOllamaMouth } from "./actor.mjs";

const ROBOT_R = 0.25;

export async function runEnv({ scene, goalName = "the far exit", start, goal, actors = [], maxSteps = 4000, dt = 0.02, useMouth = true, maxInteractions = 3, log = () => {} }) {
  let mono = 0;
  const sim = makeSim({ scene, now: () => mono });
  const backend = useMouth ? makeOllamaMouth() : null;
  const cog = makeCognition({ sim, backend });
  sim.command({ type: "arm" }); sim.command({ type: "heartbeat" }); sim.command({ type: "stand_up" });
  sim.bridge.state.pose = { x: start.x, y: start.y, yaw: start.yaw ?? 0 };
  sim.bridge.goToPose(goal.x, goal.y);

  const obstacles = sim.world.objects.filter((o) => o.obstacle);
  const collided = new Set();
  let minClear = Infinity, collisionSteps = 0, steps = 0, reached = false, stuck = false, pathLen = 0;
  let prev = { x: start.x, y: start.y };
  let bestDistToGoal = Infinity, sinceProgress = 0;
  const interactions = [];
  const cooldown = new Map();

  for (let i = 0; i < maxSteps; i++) {
    mono += dt;
    sim.command({ type: "heartbeat" });                                  // keep safety ACTIVE
    if (!sim.bridge.hasNavTarget() && !reached) sim.bridge.goToPose(goal.x, goal.y); // keep aiming at the goal
    sim.step();
    steps++;
    const p = sim.bridge.state.pose;
    pathLen += Math.hypot(p.x - prev.x, p.y - prev.y); prev = { x: p.x, y: p.y };

    // clearance to the nearest obstacle SURFACE (negative = the robot disk overlaps it)
    let clear = Infinity, near = null;
    for (const o of obstacles) { const d = Math.hypot(o.x - p.x, o.y - p.y) - o.radius - ROBOT_R; if (d < clear) { clear = d; near = o; } }
    if (clear < minClear) minClear = clear;
    if (clear < 0) { collisionSteps++; if (near) collided.add(near.name); }

    // progress / stuck (local-minimum) detection
    const dg = Math.hypot(goal.x - p.x, goal.y - p.y);
    if (dg < bestDistToGoal - 0.05) { bestDistToGoal = dg; sinceProgress = 0; } else sinceProgress++;
    if (dg < 0.4) { reached = true; break; }
    if (sinceProgress > 700) { stuck = true; break; }                    // ~14s with no progress → give up

    // encounter → a genuine (Ollama) interaction, gated hard for gentleness
    if (useMouth && interactions.length < maxInteractions) {
      for (const a of actors) {
        const e = sim.world.byName(a.name); if (!e) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < (a.dist ?? 1.6) && mono - (cooldown.get(a.name) ?? -1e9) > 6) {
          cooldown.set(a.name, mono);
          const line = await a.actor.react(`It is about ${d.toFixed(1)} meters away in a ${scene}, on its way to ${goalName}.`);
          let reply = null;
          if (line && backend) { try { const r = await cog.converse(`${a.name} says: "${line}"`); reply = r.speech ? String(r.speech).trim() : null; } catch {} }
          sim.bridge.goToPose(goal.x, goal.y);                            // resume nav (converse may have set a look_at)
          interactions.push({ actor: a.name, dist: +d.toFixed(2), line, reply });
          log(`  💬 ${a.name}: ${line || "(silent)"}` + (reply ? `\n     🐾 Sweetie: ${reply}` : ""));
          break;
        }
      }
    }
  }

  const seconds = +(steps * dt).toFixed(1);
  const verdict = stuck ? "STUCK" : (!reached ? "TIMEOUT" : (collided.size ? "REACHED (clipped)" : "REACHED (clean)"));
  return { scene, verdict, reached, stuck, steps, seconds, pathLen: +pathLen.toFixed(2), minClear: +minClear.toFixed(2), collisionSteps, collided: [...collided], interactions, finalPose: { x: +sim.bridge.state.pose.x.toFixed(2), y: +sim.bridge.state.pose.y.toFixed(2) } };
}
