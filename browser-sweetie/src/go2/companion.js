// Companion node loop — what runs on the Jetson beside the Go2, tying the contract together:
//   raw sensors → onboard safety check → frame → /decide → execute intents on the body.
// It is deliberately a PURE, INJECTED orchestrator (decide + driver injected) so the whole control loop is
// deterministically testable now, with no robot and no network. On hardware this logic lives inside a ROS 2
// timer callback (rclpy/rclnodejs): the callback reads topics into `sensors`, calls step(), and the driver's
// sdk/nav publish sport-mode + Nav2. Three non-negotiables, in order:
//   1. HARD SAFETY IS ONBOARD & FIRST — estop/tilt/battery-critical halt immediately, WITHOUT waiting on /decide.
//   2. THE BRAIN IS ADVISORY — any decide failure (timeout, network loss, bad reply) → fail-safe StopMove.
//   3. THE BODY HAS THE FINAL VETO — every returned intent is re-checked against live state inside the driver.

export function makeCompanion({ decide, driver, config = {} } = {}) {
  const C = { onboardTilt: 0.6, batteryCrit: 10, ...config };
  const liveOf = (s) => ({ estop: !!s.estop, roll: (s.imu && s.imu.roll) || 0, pitch: (s.imu && s.imu.pitch) || 0, battery: s.battery ?? 100, mode: s.mode || "standing" });
  // computed from RAW sensors, independent of the network — this is what keeps her safe if /decide never answers
  const onboardEmergency = (s) => s.estop || Math.abs((s.imu && s.imu.roll) || 0) > C.onboardTilt || Math.abs((s.imu && s.imu.pitch) || 0) > C.onboardTilt || (s.battery ?? 100) < C.batteryCrit;

  return {
    // One control cycle. `sensors` = this tick's raw robot telemetry; `prompt` only when a human spoke to her.
    async step(sensors = {}, { prompt = null } = {}) {
      const live = liveOf(sensors);
      // 1) hard safety FIRST — never wait on the network to stop
      if (onboardEmergency(sensors)) { const r = driver.execute({ emergency: true }, { live }); return { source: "onboard", halted: true, frame: null, decision: { arc: "SAFETY-HALT", emergency: true }, results: r.results, speech: null }; }
      const frame = driver.frameFrom(sensors);
      // 2) ask the brain — on ANY failure fail safe (the brain is advisory, never a single point of failure)
      let decision;
      try { decision = await decide(frame, { prompt }); if (!decision) throw new Error("empty decision"); }
      catch (e) { const r = driver.execute({ emergency: true }, { live }); return { source: "failsafe", halted: true, frame, decision: null, results: r.results, speech: null, error: e.message }; }
      // 3) act (the driver re-vetoes each intent vs. live state)
      const out = driver.execute(decision, { live, frame });
      return { source: "decide", halted: out.halted, frame, decision, results: out.results, speech: out.speech || decision.speech || null };
    },
  };
}

// Deployment glue: an HTTP client to the /decide sidecar with a HARD timeout. A network drop or a slow reply
// aborts and rejects → the companion's step() takes the fail-safe path. (Node 18+ / browser have fetch.)
export function makeDecideClient({ url = "http://localhost:8130", timeoutMs = 200, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  return async (frame, { prompt = null } = {}) => {
    if (!doFetch) throw new Error("no fetch available");
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(`${url}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frame, prompt }), signal: ac.signal });
      if (!res.ok) throw new Error(`/decide HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  };
}
