// The headless sim app — composes the W0 body (world + bridge + safety + perception + bus) into a fixed-dt
// loop that PRODUCES telemetry frames and CONSUMES commands. This is the single integration seam: the W1 UI
// renders these frames + sends these commands, and the W2 brain reads the same frames + issues the same
// commands. No DOM here — fully Node-testable; the browser only supplies the tick driver (rAF/setInterval).
import { makeScene } from "./world.js";
import { makeBridge } from "./bridge.js";
import { makeSafety, SafetyState } from "./safety.js";
import { makeSimPerception } from "./perception.js";
import { makeBus } from "./bus.js";

export function makeSim({ scene = "apartment", now = () => 0, dt = 0.02 } = {}) {
  const world = makeScene(scene);
  const bridge = makeBridge({ world, now });
  const safety = makeSafety({ now, wallNow: now });
  const perc = makeSimPerception({ world, now });
  const bus = makeBus();
  let region = null; // current named region (for zone-change events)

  // The telemetry frame the dashboard consumes (shape from the legacy WS protocol).
  function telemetryFrame() {
    return {
      type: "telemetry",
      state: bridge.toDict(),
      safety: safety.toDict(),
      dynamic_objects: world.objects.filter((o) => o.dynamic).map((o) => ({ name: o.name, x: o.x, y: o.y })),
      current_region: region,
    };
  }

  // one fixed-dt step: predicates → integrate (ticks world + republishes proximity) → perception → events.
  function step() {
    safety.tick(bridge.state);
    // sync an auto-trip (battery/tilt/heartbeat-loss → ESTOP) down to the body
    if (safety.state === SafetyState.ESTOP && bridge.state.mode !== "estop") bridge.emergencyStop();

    bridge.integrate(dt);

    const { x, y, yaw } = bridge.state.pose;
    perc.tick(x, y, yaw);
    for (const e of perc.drainNewEvents()) bus.publish("perception", { event: e });

    const r = world.regionAt(x, y);
    const rname = r ? r.name : null;
    if (rname !== region) { bus.publish("zone_changed", { from: region, to: rname }); region = rname; }

    const frame = telemetryFrame();
    bus.publish("telemetry", frame);
    return frame;
  }

  // Handle a UI/brain command. Motion routes through the safety chokepoint; a `move` is an implicit heartbeat.
  function command(msg = {}) {
    switch (msg.type) {
      case "heartbeat": safety.heartbeat(); return { ok: true };
      case "arm": return { ok: safety.arm() };
      case "disarm": return { ok: safety.disarm() };
      case "estop": safety.estop(); bridge.emergencyStop(); bus.publish("estop", {}); return { ok: true };
      case "clear_estop": { const ok = safety.clearEstop(); if (ok) bridge.clearEstop(); return { ok }; }
      case "stand_up": { const g = safety.guardAction("stand_up"); return { ok: g.allowed && bridge.standUp(), reason: g.reason }; }
      case "stand_down": { const g = safety.guardAction("sit_down"); return { ok: g.allowed && bridge.standDown(), reason: g.reason }; }
      case "move": {
        safety.heartbeat(); // a joystick command keeps the link alive
        const g = safety.guard(msg.vx || 0, msg.vy || 0, msg.vyaw || 0, bridge.state);
        if (!g.allowed) { bus.publish("rejected", { reason: g.reason }); return { ok: false, reason: g.reason }; }
        bridge.move(g.vx, g.vy, g.vyaw);
        if (g.assists.length) { g.assists.forEach((a) => safety.recordAssist(a)); bus.publish("assist", { events: g.assists }); }
        return { ok: true, assists: g.assists };
      }
      default: return { ok: false, reason: `unknown command '${msg.type}'` };
    }
  }

  return { world, bridge, safety, perc, bus, step, command, telemetryFrame, dt,
    // static scene payload (the legacy /api/world) for the UI to draw furniture once
    worldPayload() { return { objects: world.objects.map((o) => ({ name: o.name, x: o.x, y: o.y, radius: o.radius, category: o.category, obstacle: o.obstacle, dynamic: o.dynamic })) }; },
  };
}
