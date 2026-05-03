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

# Pass the World directly to Cognition. The system prompt is then built
# from actual world contents — regions, objects, dynamic entities — so
# the LLM never describes things that aren't there. `world` is None for
# real hardware (RealBridge), which selects the real-hardware prompt.
cog = Cognition(bridge=bridge, safety=safety, world=world)

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

# Active WebSocket connections (one per tab). Speak events fan out to all.
_clients: set[WebSocket] = set()

# Debounce for smart-assist events: only publish when the *set* of active
# assists changes from one frame to the next. Otherwise the chat log floods.
_last_assists_key: str = ""


# ── Lifespan: start/stop the simulator and background tasks ─────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await bridge.connect()
    telemetry = asyncio.create_task(_telemetry_loop())
    safety_tick = asyncio.create_task(_safety_tick_loop())

    async def on_speak(payload: dict[str, Any]) -> None:
        await _broadcast({"type": "speak", "text": payload.get("text", "")})

    async def on_intent(payload: dict[str, Any]) -> None:
        # action: stand_up | sit_down | halt | report_status
        # outcome: ok | rejected | no-op | error
        await _broadcast({
            "type": "intent",
            "action": payload.get("action", ""),
            "outcome": payload.get("outcome", ""),
            "reason": payload.get("reason", ""),
        })

    async def on_assist(payload: dict[str, Any]) -> None:
        await _broadcast({"type": "assist", "events": payload.get("events", [])})

    bus.subscribe("speak", on_speak)
    bus.subscribe("intent", on_intent)
    bus.subscribe("assist", on_assist)

    # Attach autonomy AFTER the broadcast subscribers exist, so any
    # tick fired during startup correctly fans out to connected UIs.
    if _autonomy is not None:
        _autonomy.attach()

    try:
        yield
    finally:
        telemetry.cancel()
        safety_tick.cancel()
        if _autonomy is not None:
            await _autonomy.detach()
        await bridge.disconnect()


app = FastAPI(lifespan=lifespan)


# ── HTTP ─────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    return (STATIC_DIR / "index.html").read_text()


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


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
