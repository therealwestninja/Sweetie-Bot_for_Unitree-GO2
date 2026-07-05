// ============================================================================================================
//  FRAME ↔ GO2 DRIVER CONTRACT
//  The single seam between our portable cognition core (the /decide sidecar) and a real Unitree Go2. Two ways:
//    SENSORS → FRAME : the robot's raw telemetry → the { pose, ranges, visible, … } frame the decider eats.
//    DECISION → GO2  : the decider's motor INTENTS → Go2 sport-mode calls + Nav2 goals.
//
//  HARD SAFETY IS ONBOARD AND NEVER GATED BY THE NETWORK. E-STOP, tilt, battery-critical, foot-slip run on the
//  robot independent of /decide; this driver additionally re-checks every intent against the LIVE body state
//  before it moves (belt and suspenders). The SDK + nav are INJECTED — a mock in tests, `unitree_sdk2` /
//  Nav2 on hardware — so the whole contract is deterministically testable with zero robot in the loop.
//
//  Intent → Go2 mapping (sport-mode API is Unitree's high-level client; go_to_pose delegates to Nav2):
//    halt            → StopMove()                         (always allowed; also the network-loss fail-safe)
//    stand           → StandUp() then BalanceStand()
//    sit             → StandDown()
//    set_body_height → BodyHeight(m − nominal)            (Go2 takes a RELATIVE offset; input clamped 0.18–0.34)
//    look_at(name)   → resolve bearing from `visible`, orient (Euler for small yaw, Move-yaw for large)
//    go_to_pose(x,y) → Nav2 NavigateToPose goal           (Nav2 owns global path + obstacle avoidance)
//    gesture(name)   → a canned sport action (GESTURES table)
//    speak(text)     → TTS (handled outside this driver; not a motor command)
// ============================================================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const NOMINAL_HEIGHT = 0.30;          // Go2 nominal standing body height (m); BodyHeight() wants an offset
const TILT_LIMIT = 0.6, BATTERY_CRIT = 10;

// --- sensor → frame -----------------------------------------------------------------------------------------

// Reduce a LiDAR scan to the 4 quadrant ranges the sensorium expects: nearest obstacle per 90°, BODY frame,
// order [front, left, back, right]. `scan` = [{ angle:rad (0 = straight ahead, CCW +), range:m }]. Empty
// quadrant → maxRange. (On hardware you'd polarise the point cloud once and pass it in.)
export function rangesFromScan(scan = [], { maxRange = 3 } = {}) {
  const q = [maxRange, maxRange, maxRange, maxRange]; // f, l, b, r
  for (const p of scan) {
    if (p.range == null) continue;
    const a = Math.atan2(Math.sin(p.angle), Math.cos(p.angle)); // wrap to (−π, π]
    const i = Math.abs(a) <= Math.PI / 4 ? 0 : a > Math.PI / 4 && a <= 3 * Math.PI / 4 ? 1 : Math.abs(a) > 3 * Math.PI / 4 ? 2 : 3;
    if (p.range < q[i]) q[i] = Math.min(p.range, maxRange);
  }
  return q;
}

const CATEGORY = { person: "person", pedestrian: "person", dog: "animal", cat: "animal", animal: "animal", car: "vehicle", chair: "furniture", couch: "furniture", table: "furniture" };
const DYNAMIC = new Set(["person", "animal"]);
const mapDetection = (d) => { const cat = CATEGORY[String(d.label || d.category || "").toLowerCase()] || "object"; return { name: d.name || `the ${d.label || "thing"}`, distance_m: +(d.distance ?? d.distance_m ?? 0).toFixed(2), bearing_deg: +(d.bearing ?? d.bearing_deg ?? 0).toFixed(1), category: cat, dynamic: d.dynamic ?? DYNAMIC.has(cat) }; };

function deriveSafety(t) { if (t.estop) return "estop"; if (t.armed && t.mode && t.mode !== "down") return "active"; return "idle"; }

// Build the decider frame from a robot telemetry snapshot `t` (whatever the ROS node gathered this tick).
export function frameFromSensors(t = {}, cfg = {}) {
  return {
    pose: t.pose || { x: 0, y: 0, yaw: 0 },                       // Nav2/SLAM TF (map frame) or sport odom
    ranges: t.ranges || rangesFromScan(t.scan || [], cfg),        // LiDAR → 4 quadrant ranges
    battery: t.battery ?? 100,                                    // bms soc %
    imu: t.imu || { roll: 0, pitch: 0 },
    mode: t.mode || "standing",                                   // sport-mode state
    safety: deriveSafety(t),                                      // "active" | "idle" | "estop"
    visible: (t.detections || []).map(mapDetection),              // perception model → visible[]
    events: t.events || [],
  };
}

// --- decision → Go2 -----------------------------------------------------------------------------------------

export const GESTURES = { nod: "Hello", wag: "WiggleHips", tilt_head: "Stretch", perk_ears: "Hello", crouch: "Sit", bow: "Stretch", shake: "Scrape" };

export function makeGo2Driver({ sdk, nav = null, config = {} } = {}) {
  const gestures = { ...GESTURES, ...(config.gestures || {}) };
  const smallYaw = config.smallYaw ?? 0.5, turnRate = config.turnRate ?? 1.0;
  const bearingOf = (name, frame) => { const v = (frame && frame.visible || []).find((x) => new RegExp(String(name).replace(/^the /, ""), "i").test(x.name)); return v ? (v.bearing_deg * Math.PI) / 180 : null; };

  // The BODY's final veto — even if the decider said ok, the live state can refuse (onboard safety wins).
  function bodyAllows(tool, live = {}) {
    if (tool === "halt" || tool === "speak") return { ok: true };
    if (live.estop) return { ok: false, reason: "estop (onboard)" };
    if (Math.abs(live.roll || 0) > TILT_LIMIT || Math.abs(live.pitch || 0) > TILT_LIMIT) return { ok: false, reason: "tilt limit" };
    if ((live.battery ?? 100) < BATTERY_CRIT) return { ok: false, reason: "battery critical" };
    if (live.mode === "down" && tool !== "stand") return { ok: false, reason: "folded" };
    return { ok: true };
  }

  function executeIntent(it, live, frame) {
    const g = bodyAllows(it.tool, live); if (!g.ok) return { tool: it.tool, ok: false, reason: g.reason };
    const ok = (detail) => ({ tool: it.tool, args: it.args, ok: true, detail });
    const no = (reason) => ({ tool: it.tool, args: it.args, ok: false, reason });
    switch (it.tool) {
      case "halt": sdk.StopMove(); return ok("StopMove");
      case "stand": sdk.StandUp(); sdk.BalanceStand && sdk.BalanceStand(); return ok("StandUp+BalanceStand");
      case "sit": sdk.StandDown(); return ok("StandDown");
      case "set_body_height": { const m = clamp(+it.args[0], 0.18, 0.34); sdk.BodyHeight(+(m - NOMINAL_HEIGHT).toFixed(3)); return ok(`BodyHeight ${(m - NOMINAL_HEIGHT).toFixed(2)}`); }
      case "look_at": { const b = bearingOf(it.args[0], frame); if (b == null) return no("target not visible"); if (Math.abs(b) <= smallYaw) sdk.Euler(0, 0, b); else sdk.Move(0, 0, Math.sign(b) * turnRate); return ok(`face ${(b).toFixed(2)}rad`); }
      case "go_to_pose": { if (!nav) return no("no Nav2 available"); nav.navigateToPose({ x: +it.args[0], y: +it.args[1] }); return ok(`Nav2 goal (${it.args[0]}, ${it.args[1]})`); }
      case "gesture": { const cmd = gestures[it.args[0]]; if (!cmd || !sdk[cmd]) return no(`unknown/unsupported gesture '${it.args[0]}'`); sdk[cmd](); return ok(`gesture ${cmd}`); }
      default: return no("unmapped tool");
    }
  }

  return {
    frameFrom: (t) => frameFromSensors(t, config),

    // Execute a whole /decide decision against the body. EMERGENCY → immediate StopMove and skip everything
    // else (safety first, always). `live` = the current body state (estop/roll/pitch/battery/mode); `frame` =
    // the frame the decision was made on (for resolving look_at bearings).
    execute(decision = {}, { live = {}, frame = null } = {}) {
      const results = [];
      if (decision.emergency || decision.arc === "EMERGENCY") { sdk.StopMove(); return { halted: true, speech: decision.speech, results: [{ tool: "halt", ok: true, reason: "EMERGENCY" }] }; }
      for (const it of decision.intents || []) {
        if (it.ok === false) { results.push({ ...it, skipped: "decider-gated" }); continue; } // already refused upstream
        results.push(executeIntent(it, live, frame));
      }
      return { halted: false, speech: decision.speech, results };
    },
  };
}
