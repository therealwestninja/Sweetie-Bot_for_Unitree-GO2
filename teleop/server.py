"""
FastAPI server.

Wires the four M1 pieces together:
    bridge   ←  /ws  ←  joystick    (operator commands, gated by safety)
    bridge  →   /ws  →  telemetry   (50 Hz state push)
    bus     →   /ws  →  speak       (LLM-emitted speech lines)
    cognition  ← /api/chat ←  user  (chat box)

One process, one event loop, one WebSocket per browser tab.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from sweetie.cognition.llm import Cognition
from sweetie.core.bridge import BridgeBase, SimBridge
from sweetie.core.bus import bus
from sweetie.core.safety import SafetyGuard
from sweetie.sim.world import World, default_scene

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
# Layout fallback: if the assets dir is absent but the dashboard files sit
# alongside server.py (some checkout/packaging layouts flatten them), serve
# from here instead. No-op when teleop/static/ exists.
if not STATIC_DIR.is_dir() and (Path(__file__).parent / "index.html").exists():
    STATIC_DIR = Path(__file__).parent
TELEMETRY_HZ = 20


def _make_bridge() -> tuple[BridgeBase, World | None]:
    """
    Pick the bridge implementation based on `SWEETIE_BRIDGE`.

    `sim` (default): kinematic simulator. The scene is picked by
            `SWEETIE_SCENE` (default 'studio' = full backlot; other valid
            values: 'apartment', 'street', 'stairs', 'agility').
    `real`: connects to a real Go2 over DDS via unitree_sdk2py. Network
            interface is read from `SWEETIE_NETWORK_INTERFACE` (default
            'eth0'); DDS domain from `SWEETIE_DDS_DOMAIN` (default 0).

    Real hardware has no simulated world — the returned `world` is None,
    and the UI map will simply have no obstacles to draw.
    """
    kind = os.getenv("SWEETIE_BRIDGE", "sim").lower()
    if kind == "real":
        # Imported lazily so the simulator code path doesn't require
        # unitree_sdk2py to be installed.
        from sweetie.core.real_bridge import RealBridge
        interface = os.getenv("SWEETIE_NETWORK_INTERFACE")
        domain = int(os.getenv("SWEETIE_DDS_DOMAIN", "0"))
        logger.warning(
            "Using RealBridge (interface=%s, domain=%d). "
            "This integration is UNVERIFIED on real hardware — proceed with care.",
            interface or "eth0", domain,
        )
        return RealBridge(network_interface=interface, domain_id=domain), None

    if kind != "sim":
        logger.warning("Unknown SWEETIE_BRIDGE=%r, defaulting to 'sim'", kind)

    scene_name = os.getenv("SWEETIE_SCENE", "studio")
    from sweetie.sim.world import get_scene
    w = get_scene(scene_name)
    logger.info(
        "Using SimBridge with scene=%r (%d objects)",
        scene_name, len(w.objects),
    )
    return SimBridge(world=w), w


# ── Process-wide singletons ──────────────────────────────────────────────────
bridge, world = _make_bridge()
safety = SafetyGuard()

# Memory store — SQLite-backed persistent memory across sessions. Lives
# at ~/.sweetie/memory.db by default; override via SWEETIE_MEMORY_DB.
# Disable persistence entirely with SWEETIE_MEMORY=off (useful for tests
# and short-lived demo sessions).
from sweetie.cognition.memory import MemoryStore

_memory: MemoryStore | None = None
_episode_id: int | None = None
if os.getenv("SWEETIE_MEMORY", "on").lower() != "off":
    _memory = MemoryStore()
    _episode_id = _memory.start_episode()
    logger.info(
        "MemoryStore opened; started episode #%d "
        "(approved facts: %d, pending: %d, recent episodes: %d)",
        _episode_id,
        _memory.count_facts(status="approved"),
        _memory.count_facts(status="pending"),
        len(_memory.list_recent_episodes()),
    )

# Pass the World directly to Cognition. The system prompt is then built
# from actual world contents — regions, objects, dynamic entities — so
# the LLM never describes things that aren't there. `world` is None for
# real hardware (RealBridge), which selects the real-hardware prompt.
# The memory store, when present, contributes the "what you remember"
# block and lets the `remember` tool actually persist proposals.
cog = Cognition(
    bridge=bridge,
    safety=safety,
    world=world,
    memory_store=_memory,
    episode_id=_episode_id,
)

# Autonomy loop — Sweetie's primary cognition path. Default on; disable
# with SWEETIE_AUTONOMY=off (useful for tests, or for tele-op-only usage).
# When enabled, Sweetie acts on her own — bus events trigger ticks and an
# idle ticker fires periodically so she keeps initiative even when nothing
# external happens.
_autonomy = None
if os.getenv("SWEETIE_AUTONOMY", "on").lower() != "off":
    from sweetie.cognition.autonomy import Autonomy
    _autonomy = Autonomy(
        cog,
        idle_interval_s=float(os.getenv("SWEETIE_AUTONOMY_IDLE_S", "15")),
        cooldown_s=float(os.getenv("SWEETIE_AUTONOMY_COOLDOWN_S", "8")),
    )
    logger.info("Autonomy will be enabled at startup")

# Session state. Once a session ends (battery low, supervisor recall,
# or shutdown), the autonomy loop is detached and `cog.summarize_session()`
# is called once. We guard with a flag so the same session is never
# closed twice — the battery and shutdown paths can race.
_session_ended: bool = False
_session_lock: asyncio.Lock | None = None  # constructed at lifespan-start


async def _end_session(end_reason: str) -> None:
    """End the current session: detach autonomy, summarize, write episode.

    Idempotent — calling this a second time returns immediately. The
    `_session_lock` serializes concurrent end attempts (e.g. battery
    just dropped and the supervisor hit 'end' simultaneously).
    """
    global _session_ended
    assert _session_lock is not None, "lifespan must initialize the lock"
    async with _session_lock:
        if _session_ended:
            return
        _session_ended = True

        logger.info("Ending session (reason=%s)", end_reason)

        # Stop the autonomy idle ticker first so it doesn't fire while
        # we're writing the summary.
        if _autonomy is not None:
            await _autonomy.detach()

        # Reflect + persist. Returns None when no API key / no memory
        # store / no episode id; in those cases we still close the
        # episode with an empty summary so the row is bounded.
        summary: str | None = None
        try:
            summary = await cog.summarize_session(end_reason)
        except Exception:
            logger.exception("session summary generation failed")

        if _memory is not None and _episode_id is not None:
            try:
                _memory.end_episode_with_summary(
                    _episode_id,
                    summary or "(no summary — LLM unavailable or call failed)",
                    end_reason,
                )
            except Exception:
                logger.exception("episode write failed")

        # Tell the dashboard the session has ended so it can update UI.
        await bus.publish("session_ended", {"reason": end_reason, "summary": summary})

# Active WebSocket connections (one per tab). Speak events fan out to all.
_clients: set[WebSocket] = set()

# Debounce for smart-assist events: only publish when the *set* of active
# assists changes from one frame to the next. Otherwise the chat log floods.
_last_assists_key: str = ""

# Track battery transition so we end the session exactly once when battery
# drops below threshold. Without this, every safety tick after the drop
# would attempt to end again.
_battery_low_triggered: bool = False


# ── Lifespan: start/stop the simulator and background tasks ─────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _session_lock
    _session_lock = asyncio.Lock()

    await bridge.connect()
    telemetry = asyncio.create_task(_telemetry_loop())
    safety_tick = asyncio.create_task(_safety_tick_loop())

    async def on_speak(payload: dict[str, Any]) -> None:
        await _broadcast({"type": "speak", "text": payload.get("text", "")})

    async def on_intent(payload: dict[str, Any]) -> None:
        # action: stand_up | sit_down | halt | report_status | remember | …
        # outcome: ok | rejected | no-op | error
        await _broadcast({
            "type": "intent",
            "action": payload.get("action", ""),
            "outcome": payload.get("outcome", ""),
            "reason": payload.get("reason", ""),
        })

    async def on_assist(payload: dict[str, Any]) -> None:
        await _broadcast({"type": "assist", "events": payload.get("events", [])})

    async def on_memory_pending(payload: dict[str, Any]) -> None:
        # Tell connected dashboards to refresh their pending tray.
        await _broadcast({
            "type": "memory_pending",
            "id": payload.get("id"),
            "fact": payload.get("fact"),
            "category": payload.get("category"),
        })

    async def on_session_ended(payload: dict[str, Any]) -> None:
        await _broadcast({
            "type": "session_ended",
            "reason": payload.get("reason", ""),
            "summary": payload.get("summary"),
        })

    bus.subscribe("speak", on_speak)
    bus.subscribe("intent", on_intent)
    bus.subscribe("assist", on_assist)
    bus.subscribe("memory_pending", on_memory_pending)
    bus.subscribe("session_ended", on_session_ended)

    # Attach autonomy AFTER the broadcast subscribers exist, so any
    # tick fired during startup correctly fans out to connected UIs.
    if _autonomy is not None:
        _autonomy.attach()

    try:
        yield
    finally:
        telemetry.cancel()
        safety_tick.cancel()
        # Best-effort end-session on shutdown (Ctrl+C, supervisor closes
        # the process). May be a no-op if the session already ended via
        # battery_low or supervisor recall — `_end_session` is idempotent.
        if not _session_ended:
            await _end_session("shutdown")
        if _autonomy is not None:
            await _autonomy.detach()
        await bridge.disconnect()
        if _memory is not None:
            _memory.close()


app = FastAPI(lifespan=lifespan)

# Perchance fallback-AI bridge endpoints (browser userscript <-> cognition).
from sweetie.core.perchance_bridge import perchance_bridge
from sweetie.teleop.perchance_routes import make_perchance_router
app.include_router(make_perchance_router(perchance_bridge))


# ── HTTP ─────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return (STATIC_DIR / "index.html").read_text()


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
else:
    logger.warning("teleop static dir %s not found — dashboard assets not served", STATIC_DIR)


class ChatIn(BaseModel):
    text: str


class ChatOut(BaseModel):
    reply: str


@app.post("/api/chat", response_model=ChatOut)
async def chat(msg: ChatIn) -> ChatOut:
    reply = await cog.chat(msg.text)
    return ChatOut(reply=reply)


@app.get("/api/world")
async def get_world() -> dict:
    """Static snapshot of the world for the UI map. Fetched once on connect.

    Returns an empty object list when no simulated world exists (i.e. real
    hardware mode). The UI handles this by simply rendering no obstacles.
    """
    if world is None:
        return {"objects": []}
    return world.to_dict()


# ── Memory API ───────────────────────────────────────────────────────────────
#
# Surface for the dashboard's memory panel. The supervisor sees pending
# proposals, can approve/reject/edit individually or in batch, and can
# review/forget approved facts and past episodes.
#
# Every endpoint returns 200 with `{"ok": false, "error": "..."}` on
# anticipated failures (missing memory store, unknown id) rather than
# 4xx — keeps the dashboard's fetch logic simple.


def _memory_required() -> dict | None:
    """Return an error envelope if memory is disabled, else None."""
    if _memory is None:
        return {"ok": False, "error": "memory disabled (SWEETIE_MEMORY=off)"}
    return None


@app.get("/api/memory")
async def memory_overview() -> dict:
    """Full memory state for the dashboard panel."""
    err = _memory_required()
    if err:
        return err
    return {
        "ok": True,
        "pending":  _memory.list_facts(status="pending"),
        "approved": _memory.list_facts(status="approved"),
        "rejected": _memory.list_facts(status="rejected"),
        "episodes": _memory.list_all_episodes(),
        "current_episode": _episode_id,
        "session_ended":   _session_ended,
    }


class FactEditIn(BaseModel):
    content: str | None = None  # optional edit-then-approve / edit


@app.post("/api/memory/facts/{fact_id}/approve")
async def approve_fact(fact_id: int, body: FactEditIn | None = None) -> dict:
    err = _memory_required()
    if err:
        return err
    edited = body.content if body and body.content else None
    ok = _memory.approve_fact(fact_id, edited_content=edited)
    return {"ok": ok}


@app.post("/api/memory/facts/{fact_id}/reject")
async def reject_fact(fact_id: int) -> dict:
    err = _memory_required()
    if err:
        return err
    return {"ok": _memory.reject_fact(fact_id)}


@app.post("/api/memory/facts/{fact_id}/edit")
async def edit_fact(fact_id: int, body: FactEditIn) -> dict:
    """Edit content without changing status. Useful for refining
    approved facts. For edit-then-approve, hit /approve with content
    in the body."""
    err = _memory_required()
    if err:
        return err
    if not body.content:
        return {"ok": False, "error": "content required"}
    return {"ok": _memory.update_fact(fact_id, body.content)}


@app.post("/api/memory/facts/{fact_id}/delete")
async def delete_fact(fact_id: int) -> dict:
    err = _memory_required()
    if err:
        return err
    return {"ok": _memory.delete_fact(fact_id)}


@app.post("/api/memory/pending/approve_all")
async def approve_all_pending() -> dict:
    err = _memory_required()
    if err:
        return err
    return {"ok": True, "count": _memory.approve_all_pending()}


@app.post("/api/memory/pending/reject_all")
async def reject_all_pending() -> dict:
    err = _memory_required()
    if err:
        return err
    return {"ok": True, "count": _memory.reject_all_pending()}


@app.post("/api/memory/episodes/{episode_id}/delete")
async def delete_episode(episode_id: int) -> dict:
    err = _memory_required()
    if err:
        return err
    return {"ok": _memory.delete_episode(episode_id)}


# ── Session API ──────────────────────────────────────────────────────────────


@app.get("/api/session")
async def session_status() -> dict:
    """Current session state — used by the dashboard to show 'session
    ended' UI affordances."""
    return {
        "active": not _session_ended,
        "episode_id": _episode_id,
    }


@app.post("/api/session/end")
async def session_end_endpoint() -> dict:
    """Supervisor-initiated session end ('recall the robot'). Triggers
    reflection + episode write. Idempotent: returns ok even if already
    ended."""
    if _session_ended:
        return {"ok": True, "already_ended": True}
    # Schedule rather than await so the HTTP request returns promptly;
    # summarization may take a few seconds.
    asyncio.create_task(_end_session("recalled"))
    return {"ok": True, "already_ended": False}


# ── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    _clients.add(websocket)
    logger.info("ws connected (%d total)", len(_clients))
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps({"type": "error", "reason": "bad json"})
                )
                continue
            await _handle_client_msg(websocket, msg)
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
        logger.info("ws disconnected (%d remaining)", len(_clients))


async def _handle_client_msg(ws: WebSocket, msg: dict[str, Any]) -> None:
    t = msg.get("type")

    if t == "heartbeat":
        safety.heartbeat()
        return

    if t == "arm":
        ok = safety.arm()
        await ws.send_text(json.dumps({"type": "ack", "of": "arm", "ok": ok}))
        return

    if t == "disarm":
        safety.disarm()
        await bridge.stop_move()
        await ws.send_text(json.dumps({"type": "ack", "of": "disarm", "ok": True}))
        return

    if t == "estop":
        safety.estop()
        await bridge.emergency_stop()
        await _broadcast({"type": "estop"})
        return

    if t == "clear_estop":
        ok_safety = safety.clear_estop()
        ok_bridge = await bridge.clear_estop()
        await ws.send_text(
            json.dumps({"type": "ack", "of": "clear_estop", "ok": ok_safety and ok_bridge})
        )
        return

    if t == "stand_up":
        await bridge.stand_up()
        return

    if t == "stand_down":
        await bridge.stand_down()
        return

    if t == "move":
        safety.heartbeat()  # joystick frames are implicit heartbeats
        state = await bridge.get_state()
        result = safety.guard(
            float(msg.get("vx", 0.0)),
            float(msg.get("vy", 0.0)),
            float(msg.get("vyaw", 0.0)),
            state=state,
        )
        if not result.allowed:
            await ws.send_text(
                json.dumps({"type": "rejected", "reason": result.reason})
            )
            return
        # Smart-assist: publish only when the active assist set changes,
        # so chat doesn't flood at joystick rate.
        global _last_assists_key
        new_key = "|".join(sorted(result.assists))
        if new_key != _last_assists_key:
            _last_assists_key = new_key
            if result.assists:
                for a in result.assists:
                    safety.record_assist(a)
                await bus.publish("assist", {"events": list(result.assists)})
        await bridge.move(result.vx, result.vy, result.vyaw)
        return

    await ws.send_text(json.dumps({"type": "error", "reason": f"unknown type {t!r}"}))


# ── Background loops ─────────────────────────────────────────────────────────

async def _telemetry_loop() -> None:
    period = 1.0 / TELEMETRY_HZ
    while True:
        try:
            await asyncio.sleep(period)
            state = await bridge.get_state()
            # Just the moving entities — static furniture was sent once via /api/world.
            # On real hardware (world is None) there are no simulated entities.
            dynamic = (
                [
                    {"name": o.name, "x": round(o.x, 3), "y": round(o.y, 3)}
                    for o in world.objects
                    if o.dynamic
                ]
                if world is not None
                else []
            )
            await _broadcast(
                {
                    "type": "telemetry",
                    "state": state.to_dict(),
                    "safety": safety.to_dict(),
                    "dynamic_objects": dynamic,
                    "current_region": (
                        bridge.current_region()
                        if hasattr(bridge, "current_region")
                        else None
                    ),
                }
            )
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("telemetry loop error")


async def _safety_tick_loop() -> None:
    period = 0.1  # 10 Hz is plenty for predicate checks
    while True:
        try:
            await asyncio.sleep(period)
            state = await bridge.get_state()
            safety.tick(state)
            # If safety just latched estop, stop the bridge too.
            if safety.state.value == "estop" and state.mode != "estop":
                await bridge.emergency_stop()
                await _broadcast({"type": "estop"})

            # Battery low → end the session. Latched: once we trip we
            # don't fire again, even if battery somehow rises (it won't
            # in sim, but supervisor could plug in IRL). The actual
            # `_end_session` is also idempotent as a belt-and-braces.
            global _battery_low_triggered
            from sweetie.core.safety import BATTERY_LOW_PERCENT
            if (
                not _battery_low_triggered
                and state.battery_percent < BATTERY_LOW_PERCENT
            ):
                _battery_low_triggered = True
                logger.info(
                    "Battery low (%.1f%% < %.1f%%) — ending session",
                    state.battery_percent, BATTERY_LOW_PERCENT,
                )
                # Schedule rather than await — the safety-tick loop
                # shouldn't block on the LLM call inside summarize.
                asyncio.create_task(_end_session("battery_low"))
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("safety tick error")


async def _broadcast(payload: dict[str, Any]) -> None:
    if not _clients:
        return
    text = json.dumps(payload)
    dead: list[WebSocket] = []
    for c in _clients:
        try:
            await c.send_text(text)
        except Exception:
            dead.append(c)
    for c in dead:
        _clients.discard(c)
