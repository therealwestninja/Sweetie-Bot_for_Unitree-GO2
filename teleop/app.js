/* sweetie operator console — vanilla JS, no framework */
(() => {
  'use strict';

  // ── Element refs ─────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    conn:    $('stat-conn'),
    safety:  $('stat-safety'),
    mode:    $('stat-mode'),
    region:  $('stat-region'),
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
    map:        $('map'),
    zoomIn:     $('zoom-in'),
    zoomOut:    $('zoom-out'),
    zoomFit:    $('zoom-fit'),
    goalStrip:  $('goal-strip'),
    goalValue:  $('goal-value'),
    memPanel:    $('memory-panel'),
    memCountPending:   $('mem-count-pending'),
    memCountApproved:  $('mem-count-approved'),
    memCountEpisodes:  $('mem-count-episodes'),
    memListPending:    $('mem-list-pending'),
    memListApproved:   $('mem-list-approved'),
    memListEpisodes:   $('mem-list-episodes'),
    sessionBar:    $('session-bar'),
    sessionStatus: $('session-status'),
    btnRecall:     $('btn-recall'),
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
      // Fresh memory state every time we (re)connect — covers reload
      // mid-session and reconnection after a brief drop.
      refreshMemory();
      refreshSession();
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
      case 'telemetry':       applyTelemetry(m); break;
      case 'speak':           logChat('spk', m.text); pulseBrand(); break;
      case 'intent':          logIntent(m); pulseBrand(); break;
      case 'assist':          logAssist(m); pulseBrand(); break;
      case 'autonomy':        logChat('autonomy', m.text); pulseBrand(); break;
      case 'memory_pending':  onMemoryPending(m); pulseBrand(); break;
      case 'session_ended':   onSessionEnded(m); break;
      case 'estop':           logSys('E-STOP latched'); pulseBrand(); break;
      case 'rejected':        logErr(`command rejected: ${m.reason}`); break;
      case 'ack':             markEvent(`ack:${m.of}=${m.ok ? 'ok' : 'fail'}`); break;
      case 'error':           logErr(m.reason || 'unknown error'); break;
    }
  }

  function logAssist({ events }) {
    for (const e of events || []) logChat('assist', e);
  }

  function logIntent({ action, outcome, reason }) {
    // set_goal is special — it both updates the goal strip and emits
    // a dedicated chat-line variant (not a generic intent line).
    if (action === 'set_goal') {
      if (outcome === 'ok' && reason) {
        setCurrentGoal(reason);
        logChat('goal-set', reason);
      } else if (outcome === 'cleared') {
        setCurrentGoal(null);
        logChat('goal-cleared', reason || '(prior goal)');
      } else if (outcome === 'noop') {
        // Tried to clear when nothing was set — silent, no log entry
      } else {
        // Error case (rare; set_goal is always allowed)
        logChat('intent-rej', `set_goal ✗ ${outcome}: ${reason || ''}`);
      }
      return;
    }

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

  function setCurrentGoal(goal) {
    if (goal && goal.trim()) {
      els.goalValue.textContent = goal;
      els.goalStrip.classList.remove('is-empty');
    } else {
      els.goalValue.textContent = 'no active goal';
      els.goalStrip.classList.add('is-empty');
    }
  }

  // ── Telemetry → DOM ──────────────────────────────────────────────────────
  function applyTelemetry({ state, safety, dynamic_objects, current_region }) {
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
    setStat('region', current_region || '—',
            current_region ? null : 'info');
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
      const classes = ['map-object'];
      if (o.dynamic) classes.push('is-dynamic');
      if (o.category) classes.push(`cat-${o.category.replace(/[^a-z]/gi, '_')}`);
      if (o.obstacle === false) classes.push('passable');
      g.setAttribute('class', classes.join(' '));
      g.setAttribute('data-name', o.name);
      g.setAttribute('transform', `translate(${o.x}, ${-o.y})`);

      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('class', 'body');
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      // Items with radius 0 (e.g. the rug) still want a tiny visible mark.
      c.setAttribute('r', String(Math.max(o.radius, 0.10)));
      g.appendChild(c);

      // Only label "important" things to keep the map from getting cluttered.
      // Curbs, fence posts, etc. get position only — their identity comes
      // from context (a row of dots = a curb).
      const labelable = ['furniture', 'animal', 'person', 'fixture',
                         'vehicle', 'stairs', 'terrain', 'prop'];
      if (labelable.includes(o.category) || o.dynamic) {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', '0');
        t.setAttribute('y', String(-(Math.max(o.radius, 0.10) + 0.18)));
        t.textContent = o.name;
        g.appendChild(t);
      }

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
    body.setAttribute('r', '0.30');
    g.appendChild(body);
    // pointing triangle
    const tri = document.createElementNS(NS, 'polygon');
    tri.setAttribute('points', '0.50,0  -0.18,0.24  -0.18,-0.24');
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
    // Map zoom shortcuts — only when not typing in the chat box.
    if (document.activeElement === els.chatText) return;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      zoomMap(1 / 1.25);          // bigger view = smaller box (zoom IN)
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      zoomMap(1.25);
    } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
      e.preventDefault();
      resetMapView();
    }
  });

  // ── Map zoom / pan ──────────────────────────────────────────────────────
  //
  // ViewBox is `[x, y, w, h]` in world-meter units. Default is the
  // `-10 -10 20 20` square set in HTML. Wheel scales centred on cursor;
  // drag pans by translating origin by the cursor delta in world units.

  const DEFAULT_VIEW = [-10, -10, 20, 20];
  let view = [...DEFAULT_VIEW];

  function applyView() {
    els.map.setAttribute('viewBox', view.join(' '));
  }

  function zoomMap(scale, cursor) {
    // Clamp to a sensible range — wider than 80 m or narrower than 2 m
    // is rarely useful and risks numeric issues with stroke widths.
    const newW = Math.max(2, Math.min(80, view[2] * scale));
    const newH = Math.max(2, Math.min(80, view[3] * scale));
    if (cursor) {
      // Keep the world point under the cursor stationary while zooming.
      const fx = (cursor.x - view[0]) / view[2];
      const fy = (cursor.y - view[1]) / view[3];
      view[0] = cursor.x - fx * newW;
      view[1] = cursor.y - fy * newH;
    } else {
      // Centre-anchored zoom — keep the centre of the view fixed.
      const cx = view[0] + view[2] / 2;
      const cy = view[1] + view[3] / 2;
      view[0] = cx - newW / 2;
      view[1] = cy - newH / 2;
    }
    view[2] = newW;
    view[3] = newH;
    applyView();
  }

  function resetMapView() {
    view = [...DEFAULT_VIEW];
    applyView();
  }

  function clientToWorld(evt) {
    // Convert a pointer event in client pixels to world-meter coordinates
    // using the SVG's CTM. Single source of truth — used for both wheel
    // zoom and drag pan.
    const pt = els.map.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(els.map.getScreenCTM().inverse());
  }

  // Wheel: zoom in/out, anchored on the cursor.
  els.map.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cursor = clientToWorld(e);
    // deltaY > 0 = scroll down = zoom out.
    zoomMap(e.deltaY > 0 ? 1.15 : 1 / 1.15, cursor);
  }, { passive: false });

  // Drag-to-pan. Track in world coords for stable movement at any zoom.
  let panning = null;  // { start: SVGPoint, viewStart: [x,y,w,h] }
  els.map.addEventListener('pointerdown', (e) => {
    panning = { start: clientToWorld(e), viewStart: [...view] };
    els.map.classList.add('is-panning');
    els.map.setPointerCapture(e.pointerId);
  });
  els.map.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const cur = clientToWorld(e);
    // Naive delta wouldn't be stable because the CTM moves with the
    // viewBox during the drag. Anchor on the original viewStart.
    view[0] = panning.viewStart[0] - (cur.x - panning.start.x);
    view[1] = panning.viewStart[1] - (cur.y - panning.start.y);
    applyView();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = null;
    els.map.classList.remove('is-panning');
    if (e.pointerId !== undefined) {
      try { els.map.releasePointerCapture(e.pointerId); } catch {}
    }
  };
  els.map.addEventListener('pointerup',     endPan);
  els.map.addEventListener('pointercancel', endPan);
  els.map.addEventListener('pointerleave',  endPan);

  // Buttons.
  els.zoomIn?.addEventListener('click',  () => zoomMap(1 / 1.25));
  els.zoomOut?.addEventListener('click', () => zoomMap(1.25));
  els.zoomFit?.addEventListener('click', resetMapView);

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
      autonomy: 'sweetie',
      'goal-set': 'goal', 'goal-cleared': 'goal',
      'memory-pending': 'remember',
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

  // ── Memory panel ──────────────────────────────────────────────────────────

  // Cache the last-known memory state so live `memory_pending` events
  // can prepend without doing a full GET each time. The full GET happens
  // on connect and after every action, so drift is bounded.
  let memoryState = {
    pending: [],
    approved: [],
    rejected: [],
    episodes: [],
    session_ended: false,
  };

  async function refreshMemory() {
    try {
      const r = await fetch('/api/memory');
      const data = await r.json();
      if (data.ok) {
        memoryState = data;
        renderMemory();
      } else {
        // Memory disabled — leave panel empty, keep counts at 0.
        memoryState = {
          pending: [], approved: [], rejected: [], episodes: [],
          session_ended: false,
        };
        renderMemory();
      }
    } catch (err) {
      console.warn('refreshMemory failed', err);
    }
  }

  function renderMemory() {
    // Counts in the summary row.
    const np = memoryState.pending.length;
    const na = memoryState.approved.length;
    const ne = memoryState.episodes.length;
    els.memCountPending.textContent  = `${np} pending`;
    els.memCountApproved.textContent = `${na} known`;
    els.memCountEpisodes.textContent = `${ne} sessions`;
    els.memCountPending.classList.toggle('has-items', np > 0);

    renderFactList(els.memListPending,  memoryState.pending,  'pending');
    renderFactList(els.memListApproved, memoryState.approved, 'approved');
    renderEpisodeList(els.memListEpisodes, memoryState.episodes);
  }

  function renderFactList(ul, facts, status) {
    ul.innerHTML = '';
    for (const f of facts) {
      const li = document.createElement('li');
      li.className = 'mem-item';
      li.dataset.factId = String(f.id);

      const text = document.createElement('div');
      text.className = 'mem-item-text';
      const cat = document.createElement('span');
      cat.className = `mem-item-cat cat-${f.category}`;
      cat.textContent = f.category;
      text.appendChild(cat);
      text.appendChild(document.createTextNode(f.content));
      li.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'mem-item-actions';
      if (status === 'pending') {
        actions.appendChild(makeBtn('approve', 'btn-approve',
          () => factAction(f.id, 'approve')));
        actions.appendChild(makeBtn('edit', 'btn-edit',
          () => beginEdit(li, f, /*alsoApprove=*/true)));
        actions.appendChild(makeBtn('reject', 'btn-reject',
          () => factAction(f.id, 'reject')));
      } else if (status === 'approved') {
        actions.appendChild(makeBtn('edit', 'btn-edit',
          () => beginEdit(li, f, /*alsoApprove=*/false)));
        actions.appendChild(makeBtn('forget', 'btn-reject',
          () => factAction(f.id, 'delete')));
      }
      li.appendChild(actions);
      ul.appendChild(li);
    }
  }

  function renderEpisodeList(ul, episodes) {
    ul.innerHTML = '';
    // Most-recent first
    const sorted = [...episodes].sort(
      (a, b) => (b.started_at || '').localeCompare(a.started_at || '')
    );
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = 'mem-item';
      li.dataset.episodeId = String(e.id);

      const text = document.createElement('div');
      text.className = 'mem-item-text';
      const meta = document.createElement('span');
      meta.className = 'mem-item-cat';
      const dt = (e.started_at || '').slice(0, 10);
      const reason = e.end_reason || (e.ended_at ? 'closed' : 'open');
      meta.textContent = `${dt} · ${reason}`;
      text.appendChild(meta);
      text.appendChild(document.createTextNode(
        e.summary || (e.ended_at ? '(no summary)' : '(in progress)')
      ));
      li.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'mem-item-actions';
      // Don't allow deleting the in-progress episode.
      if (e.ended_at) {
        actions.appendChild(makeBtn('forget', 'btn-reject',
          () => episodeDelete(e.id)));
      }
      li.appendChild(actions);
      ul.appendChild(li);
    }
  }

  function makeBtn(label, cls, handler) {
    const b = document.createElement('button');
    b.className = `btn-small ${cls}`;
    b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  }

  function beginEdit(li, fact, alsoApprove) {
    // Replace the actions row with an inline textarea + save/cancel.
    if (li.querySelector('.mem-item-edit')) return;  // already editing
    const edit = document.createElement('div');
    edit.className = 'mem-item-edit';
    const ta = document.createElement('textarea');
    ta.value = fact.content;
    ta.rows = 2;
    edit.appendChild(ta);
    const actions = document.createElement('div');
    actions.className = 'mem-item-actions';
    actions.appendChild(makeBtn(alsoApprove ? 'save & approve' : 'save',
      'btn-approve', async () => {
        await factEdit(fact.id, ta.value, alsoApprove);
      }));
    actions.appendChild(makeBtn('cancel', '',
      () => { edit.remove(); }));
    edit.appendChild(actions);
    li.appendChild(edit);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  async function factAction(id, action) {
    try {
      await fetch(`/api/memory/facts/${id}/${action}`, { method: 'POST' });
      await refreshMemory();
    } catch (err) {
      logErr(`memory action failed: ${err.message}`);
    }
  }

  async function factEdit(id, content, alsoApprove) {
    const url = alsoApprove
      ? `/api/memory/facts/${id}/approve`
      : `/api/memory/facts/${id}/edit`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      await refreshMemory();
    } catch (err) {
      logErr(`memory edit failed: ${err.message}`);
    }
  }

  async function episodeDelete(id) {
    try {
      await fetch(`/api/memory/episodes/${id}/delete`, { method: 'POST' });
      await refreshMemory();
    } catch (err) {
      logErr(`episode forget failed: ${err.message}`);
    }
  }

  // Batch ops on the pending tray
  document.querySelectorAll('[data-mem-batch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const op = btn.dataset.memBatch;  // 'approve_all' | 'reject_all'
      try {
        await fetch(`/api/memory/pending/${op}`, { method: 'POST' });
        await refreshMemory();
      } catch (err) {
        logErr(`batch op failed: ${err.message}`);
      }
    });
  });

  function onMemoryPending(m) {
    // Live feedback: prepend to the pending list and bump the count
    // immediately, then re-fetch for the canonical state.
    if (m.id != null) {
      memoryState.pending.unshift({
        id: m.id,
        content: m.fact || '',
        category: m.category || 'world',
      });
      renderMemory();
    }
    // Show in chat too — distinct line variant in case the panel is collapsed.
    logChat('memory-pending',
      `${m.category || 'world'}: ${m.fact || ''}`);
    // Auto-open the panel once on the first pending fact, so a new
    // supervisor sees the workflow without hunting for it.
    if (!els.memPanel.dataset.openedOnce) {
      els.memPanel.open = true;
      els.memPanel.dataset.openedOnce = '1';
    }
    // Background reconcile.
    refreshMemory();
  }

  // ── Session control ───────────────────────────────────────────────────────

  let sessionEnded = false;

  async function refreshSession() {
    try {
      const r = await fetch('/api/session');
      const data = await r.json();
      sessionEnded = !data.active;
      updateSessionBar();
    } catch (err) { /* ignore */ }
  }

  function updateSessionBar(endReason, summary) {
    if (sessionEnded) {
      els.sessionBar.classList.add('is-ended');
      const reasonLabel = endReason
        ? `session ended · ${endReason}`
        : 'session ended';
      els.sessionStatus.textContent = reasonLabel;
    } else {
      els.sessionBar.classList.remove('is-ended');
      els.sessionStatus.textContent = 'session active';
    }
  }

  function onSessionEnded(m) {
    sessionEnded = true;
    updateSessionBar(m.reason);
    if (m.summary) {
      logChat('sys', `session summary: ${m.summary}`);
    } else {
      logSys(`session ended (${m.reason || 'unknown'})`);
    }
    // Reload the memory panel — the just-closed episode is now in the list.
    refreshMemory();
  }

  els.btnRecall.addEventListener('click', async () => {
    if (sessionEnded) return;
    if (!confirm("End the session and recall sweetie?")) return;
    try {
      await fetch('/api/session/end', { method: 'POST' });
      // The actual end happens server-side; UI updates via session_ended bus event.
    } catch (err) {
      logErr(`recall failed: ${err.message}`);
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  connect();
})();
