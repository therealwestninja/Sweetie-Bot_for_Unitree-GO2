/* sweetie operator console — vanilla JS, no framework */
(() => {
  'use strict';

  // ── Element refs ─────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    conn:    $('stat-conn'),
    safety:  $('stat-safety'),
    mode:    $('stat-mode'),
    batt:    $('stat-batt'),
    pose:    $('stat-pose'),
    vel:     $('stat-vel'),
    joystick: $('joystick'),
    knob:    $('joystick-knob'),
    readout: $('joystick-readout'),
    btnArm:  $('btn-arm'),
    chatLog: $('chat-log'),
    chatForm:$('chat-form'),
    chatText:$('chat-text'),
    lastEvt: $('last-event'),
    brand:   document.querySelector('.brand-mark'),
    mapObjects: $('map-objects'),
    mapRobot: $('map-robot'),
  };

  // World data, fetched once on connect. Shape: { objects: [...] }
  let world = null;
  // Name of the object currently being looked-at (highlighted on the map).
  let lookAtTarget = null;
  let lookAtTimer = null;

  // ── WebSocket ────────────────────────────────────────────────────────────
  let ws = null;
  let wsRetry = 0;
  let armed = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setStat('conn', 'connecting…', 'info');

    ws.onopen = () => {
      wsRetry = 0;
      setStat('conn', 'live', 'ok');
      logSys('link established');
      if (!world) loadWorld();
    };
    ws.onclose = () => {
      setStat('conn', 'down', 'err');
      const wait = Math.min(8000, 500 * Math.pow(2, wsRetry++));
      setTimeout(connect, wait);
    };
    ws.onerror = () => {
      setStat('conn', 'error', 'err');
    };
    ws.onmessage = (ev) => {
      try { handleServerMsg(JSON.parse(ev.data)); }
      catch { /* ignore malformed frames */ }
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleServerMsg(m) {
    switch (m.type) {
      case 'telemetry':  applyTelemetry(m); break;
      case 'speak':      logChat('spk', m.text); pulseBrand(); break;
      case 'intent':     logIntent(m); pulseBrand(); break;
      case 'assist':     logAssist(m); pulseBrand(); break;
      case 'estop':      logSys('E-STOP latched'); pulseBrand(); break;
      case 'rejected':   logErr(`command rejected: ${m.reason}`); break;
      case 'ack':        markEvent(`ack:${m.of}=${m.ok ? 'ok' : 'fail'}`); break;
      case 'error':      logErr(m.reason || 'unknown error'); break;
    }
  }

  function logAssist({ events }) {
    for (const e of events || []) logChat('assist', e);
  }

  function logIntent({ action, outcome, reason }) {
    // outcome is one of: ok | rejected | no-op | error
    const kindByOutcome = {
      ok: 'intent-ok',
      'no-op': 'intent-noop',
      rejected: 'intent-rej',
      error: 'intent-rej',
    };
    const kind = kindByOutcome[outcome] || 'intent-noop';
    const arrow = outcome === 'rejected' || outcome === 'error' ? '✗' : '→';
    const tail = reason ? ` ${arrow} ${outcome}: ${reason}` : ` ${arrow} ${outcome}`;
    logChat(kind, `${action}${tail}`);

    // For look_at, the `reason` field carries the target name on success.
    if (action === 'look_at' && outcome === 'ok' && reason) {
      highlightObject(reason);
    }
  }

  // ── Telemetry → DOM ──────────────────────────────────────────────────────
  function applyTelemetry({ state, safety, dynamic_objects }) {
    const safetyState = safety.state;
    let cls = 'info';
    if (safetyState === 'active') cls = 'ok';
    else if (safetyState === 'armed') cls = 'warn';
    else if (safetyState === 'estop') cls = 'err';
    setStat('safety', safetyState, cls);

    // Sync arm button visual
    armed = (safetyState === 'armed' || safetyState === 'active');
    els.btnArm.classList.toggle('is-armed', armed);
    els.btnArm.textContent = armed ? '✓ armed' : 'arm';
    els.knob.classList.toggle('is-disarmed', !armed);

    setStat('mode', state.mode, state.mode === 'estop' ? 'err' : null);
    const pct = state.battery_percent.toFixed(1) + '%';
    setStat('batt', pct, state.battery_percent < 20 ? 'err' : null);

    setStat('pose',
      `${state.pose.x.toFixed(2)} ${state.pose.y.toFixed(2)} ` +
      `${(state.pose.yaw * 57.296).toFixed(0)}°`);

    setStat('vel',
      `${state.velocity.x.toFixed(2)} ${state.velocity.y.toFixed(2)} ${state.velocity.yaw.toFixed(2)}`);

    drawRobot(state);
    updateDynamicObjects(dynamic_objects);
  }

  // ── World map rendering ──────────────────────────────────────────────────
  // Coordinate system: world x → svg x, world y → -svg y (flip so +y is up).
  // Robot at (0,0) facing yaw=0 (= +x) appears at center facing right.

  async function loadWorld() {
    try {
      const r = await fetch('/api/world');
      world = await r.json();
      drawWorldObjects();
    } catch (err) {
      logErr(`world fetch failed: ${err.message}`);
    }
  }

  function drawWorldObjects() {
    if (!world) return;
    const NS = 'http://www.w3.org/2000/svg';
    els.mapObjects.replaceChildren();
    for (const o of world.objects) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `map-object${o.dynamic ? ' is-dynamic' : ''}`);
      g.setAttribute('data-name', o.name);
      g.setAttribute('transform', `translate(${o.x}, ${-o.y})`);

      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('class', 'body');
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      // Items with radius 0 (e.g. the rug) still want a tiny visible mark.
      c.setAttribute('r', String(Math.max(o.radius, 0.08)));
      g.appendChild(c);

      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', '0');
      t.setAttribute('y', String(-(Math.max(o.radius, 0.08) + 0.12)));
      t.textContent = o.name;
      g.appendChild(t);

      els.mapObjects.appendChild(g);
    }
  }

  function updateDynamicObjects(items) {
    if (!els.mapObjects || !items) return;
    for (const d of items) {
      const g = els.mapObjects.querySelector(`[data-name="${CSS.escape(d.name)}"]`);
      if (g) g.setAttribute('transform', `translate(${d.x}, ${-d.y})`);
    }
  }

  function drawRobot(state) {
    const NS = 'http://www.w3.org/2000/svg';
    const yawDeg = -state.pose.yaw * 57.296;  // CSS rotates the OPPOSITE way

    els.mapRobot.replaceChildren();
    els.mapRobot.classList.toggle('is-estop', state.mode === 'estop');
    els.mapRobot.classList.toggle('is-down',  state.mode === 'down');

    const g = document.createElementNS(NS, 'g');
    g.setAttribute(
      'transform',
      `translate(${state.pose.x}, ${-state.pose.y}) rotate(${yawDeg})`,
    );
    // body
    const body = document.createElementNS(NS, 'circle');
    body.setAttribute('cx', '0');
    body.setAttribute('cy', '0');
    body.setAttribute('r', '0.18');
    g.appendChild(body);
    // pointing triangle
    const tri = document.createElementNS(NS, 'polygon');
    tri.setAttribute('points', '0.30,0  -0.10,0.14  -0.10,-0.14');
    g.appendChild(tri);
    els.mapRobot.appendChild(g);
  }

  function highlightObject(name) {
    if (!els.mapObjects) return;
    els.mapObjects.querySelectorAll('.body').forEach((el) =>
      el.classList.remove('is-target')
    );
    if (!name) return;
    const g = els.mapObjects.querySelector(`[data-name="${CSS.escape(name)}"]`);
    if (g) g.querySelector('.body')?.classList.add('is-target');
    // Auto-clear after a few seconds.
    if (lookAtTimer) clearTimeout(lookAtTimer);
    lookAtTimer = setTimeout(() => highlightObject(null), 4000);
  }

  function setStat(key, value, cls) {
    const el = els[key];
    if (!el) return;
    el.textContent = value;
    el.classList.remove('is-ok', 'is-warn', 'is-err', 'is-info');
    if (cls) el.classList.add(`is-${cls}`);
  }

  // ── Joystick ─────────────────────────────────────────────────────────────
  // vertical axis → vx (forward/back), max 1.0 m/s
  // horizontal axis → vyaw (turn), max 1.5 rad/s
  // strafe (vy) intentionally unused in MVP

  const JOY_R = 110;       // max knob travel from center, in px
  const VX_MAX = 1.0;
  const VYAW_MAX = 1.5;

  let dragging = false;
  let dragId = null;

  function getCenter() {
    const r = els.joystick.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }

  function moveKnob(dx, dy) {
    els.knob.style.transform =
      `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const vx = -(dy / JOY_R) * VX_MAX;        // up = forward
    const vyaw = -(dx / JOY_R) * VYAW_MAX;    // left = turn left (positive yaw)
    els.readout.children[0].textContent = `vx ${vx.toFixed(2)}`;
    els.readout.children[1].textContent = `vyaw ${vyaw.toFixed(2)}`;
    send({ type: 'move', vx: vx, vy: 0, vyaw: vyaw });
  }

  function clampToCircle(dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d <= JOY_R) return [dx, dy];
    return [(dx / d) * JOY_R, (dy / d) * JOY_R];
  }

  function onPointerDown(e) {
    if (dragging) return;
    dragging = true;
    dragId = e.pointerId;
    els.knob.setPointerCapture(e.pointerId);
    onPointerMove(e);
  }

  function onPointerMove(e) {
    if (!dragging || e.pointerId !== dragId) return;
    const { cx, cy } = getCenter();
    const [dx, dy] = clampToCircle(e.clientX - cx, e.clientY - cy);
    moveKnob(dx, dy);
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    dragId = null;
    moveKnob(0, 0);
    send({ type: 'move', vx: 0, vy: 0, vyaw: 0 });
  }

  els.knob.addEventListener('pointerdown', onPointerDown);
  els.knob.addEventListener('pointermove', onPointerMove);
  els.knob.addEventListener('pointerup', onPointerUp);
  els.knob.addEventListener('pointercancel', onPointerUp);

  // Heartbeat tick — keeps SafetyState ACTIVE while UI is alive.
  setInterval(() => send({ type: 'heartbeat' }), 400);

  // ── Buttons ──────────────────────────────────────────────────────────────
  document.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      send({ type: action });
      markEvent(action);
    });
  });

  // Keyboard shortcut: spacebar = e-stop.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== els.chatText) {
      e.preventDefault();
      send({ type: 'estop' });
      markEvent('estop (kbd)');
    }
  });

  // ── Chat ─────────────────────────────────────────────────────────────────
  els.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.chatText.value.trim();
    if (!text) return;
    els.chatText.value = '';
    logChat('user', text);

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        logErr(`chat ${r.status}`);
        return;
      }
      const data = await r.json();
      if (data.reply) logChat('bot', data.reply);
    } catch (err) {
      logErr(`chat error: ${err.message}`);
    }
  });

  function logChat(kind, text) {
    const line = document.createElement('div');
    line.className = `chat-line chat-${kind}`;
    const tag = {
      user: 'you', bot: 'sweetie', sys: 'sys', spk: 'speak', err: 'err',
      'intent-ok': 'do', 'intent-noop': 'do', 'intent-rej': 'do✗',
      assist: 'assist',
    }[kind] || kind;
    line.innerHTML =
      `<span class="chat-tag">${tag}</span><span class="chat-body"></span>`;
    line.querySelector('.chat-body').textContent = text;
    els.chatLog.appendChild(line);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }
  function logSys(t) { logChat('sys', t); }
  function logErr(t) { logChat('err', t); }

  function markEvent(s) {
    const stamp = new Date().toLocaleTimeString();
    els.lastEvt.textContent = `${stamp} · ${s}`;
  }

  function pulseBrand() {
    els.brand.classList.remove('is-pulse');
    void els.brand.offsetWidth;
    els.brand.classList.add('is-pulse');
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  connect();
})();
