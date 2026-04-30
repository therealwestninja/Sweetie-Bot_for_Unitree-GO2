"""
Cognition layer.

The LLM is reactive: a chat message comes in, it may call tools, then it
responds. It never has privileged access to the bridge — every tool that
can move the robot goes through SafetyGuard, exactly the same way the
joystick does.

Tools, M2:
    speak         — say a line through the (notional) speaker
    stand_up      — bring the robot to standing
    sit_down      — fold the robot back down
    halt          — stop motion immediately, stay armed
    report_status — read-only snapshot of robot + safety state

Each tool returns a short string to the LLM describing the outcome
("ok", "rejected: not armed"), so the LLM can react in its next reply.
Each tool also publishes an `intent` event on the bus so the operator
UI can show what the LLM attempted.

Adding more tools later is the same pattern: define it in TOOLS, add a
case in `_dispatch_tool`, decide whether it needs `guard_action()`, and
add a test in `tests/test_intents.py`.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Awaitable, Callable

from anthropic import AsyncAnthropic

from sweetie.core.bridge import BridgeBase
from sweetie.core.bus import bus
from sweetie.core.safety import SafetyGuard

logger = logging.getLogger(__name__)

MODEL = os.getenv("SWEETIE_MODEL", "claude-sonnet-4-5")
MAX_TOKENS = 1024
TOOL_LOOP_MAX = 8  # bound on tool calls per chat() to prevent runaway

SYSTEM_PROMPT = """You are Sweetie, the on-board assistant for a Unitree Go2 \
quadruped robot running in simulation. A human operator drives the robot \
with a joystick. You can do a few things yourself through tools, but every \
tool call still goes through the operator's safety system — if you try to \
do something while the robot isn't armed or is in E-STOP, your tool call \
will be rejected and you should tell the operator why in plain language.

The robot is in a small simulated room with named objects in it. Some are \
static furniture (couch, coffee table, kitchen counter, door, rug). Others \
move on their own — the cat wanders around, and a person walks a loop \
around the apartment. Their positions change over time, so don't rely on \
old report_status results when the operator asks where something is — \
call `report_status` again for fresh data.

The dynamic entities also react to the robot. The cat scrambles away when \
the robot gets within about 0.6 m. The person pauses when the robot is \
standing in their walking path within about 1 m. These reactions are part \
of the simulation, not commands you sent. If the operator's driving makes \
the cat flee or the person stop, you can mention it.

Each object has a `category` ('furniture', 'animal', 'person', 'fixture', \
'decor'). Use these to talk about the scene naturally rather than reciting \
names. For dynamic entities, `report_status` also includes a velocity and \
a `motion` field ('approaching', 'receding', 'parallel', 'stationary') \
relative to the robot — these are useful when the operator asks 'is that \
the cat coming toward me?'.

`recent_perceptions` lists transitions you've just noticed — entities \
entering/leaving range, or stepping in front of you. If the operator asks \
'did anything just happen?' or 'who's around?', check there too.

A smart-assist layer in the safety system automatically slows or blocks \
the operator's joystick commands when an obstacle is too close in the \
direction of motion. When this happens, it's recorded as an assist event. \
You can see recent assists in `report_status` under `recent_assists`. \
If the operator asks 'why did I just slow down?' or 'what's wrong?', \
check there and answer plainly.

Tools you can use:
- `speak`: say a short line through the robot's speaker.
- `stand_up`, `sit_down`: change posture (requires the operator to have armed).
- `halt`: stop motion immediately. Always allowed.
- `look_at`: rotate the robot to face a named object. Requires armed.
- `report_status`: get the current robot + safety state, what's around the \
  robot, proximity in each quadrant, and recent smart-assist interventions.

You have no camera, microphone, or lidar — your awareness of the room \
comes only from `report_status`. Be honest about that. When you act on a \
request, prefer to also `speak` a short acknowledgement so the operator \
knows what you're doing. Don't volunteer unsolicited commentary on the \
operator's driving — they're in charge."""


TOOLS: list[dict[str, Any]] = [
    {
        "name": "speak",
        "description": (
            "Say a short line out loud through the robot's speaker. "
            "Keep it under ~20 words. Use for acknowledgements or short "
            "reactions; for longer answers just reply in chat."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "What to say."}
            },
            "required": ["text"],
        },
    },
    {
        "name": "stand_up",
        "description": (
            "Bring the robot from a folded posture up to standing. Requires "
            "the operator to have armed the safety system. Returns 'ok' or "
            "a rejection reason."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "sit_down",
        "description": (
            "Fold the robot back down to a low/resting posture. Stops any "
            "current motion. Requires the operator to have armed the "
            "safety system."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "halt",
        "description": (
            "Stop the robot's motion immediately, but stay armed and "
            "standing. Always allowed (it is always safe to stop). "
            "Different from E-STOP, which only the operator can trigger."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "look_at",
        "description": (
            "Rotate the robot in place to face a named world object "
            "(e.g. 'couch', 'cat', 'door'). The robot will turn until its "
            "front is pointing at the target. Requires the operator to "
            "have armed the safety system. If you don't know what objects "
            "exist, call `report_status` first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Name of the object to face (case-insensitive).",
                }
            },
            "required": ["target"],
        },
    },
    {
        "name": "report_status",
        "description": (
            "Get a snapshot of the robot's current state: safety FSM state, "
            "mode, velocity, pose, battery, tilt, the proximity reading in "
            "each of the four quadrants (front/left/back/right), a list of "
            "nearby world objects with their bearings and distances, and "
            "recent smart-assist interventions ('slowed' or 'blocked' "
            "events from the safety system). Read-only; always allowed."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]


# Action-name → bridge-method mapping. Cognition uses semantic names
# (sit_down, halt); the bridge uses its existing names. This is the only
# place that translation lives.
ACTION_TO_BRIDGE_METHOD: dict[str, str] = {
    "stand_up": "stand_up",
    "sit_down": "stand_down",
    "halt": "stop_move",
}


class Cognition:
    """
    Holds the LLM client + chat history + the safety/bridge handles
    needed to actually carry out tool calls.

    Conversation history grows unbounded — fine for an MVP. Sliding
    window or summarization is a future concern.
    """

    def __init__(self, bridge: BridgeBase, safety: SafetyGuard) -> None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            logger.warning(
                "ANTHROPIC_API_KEY not set — cognition will return canned replies"
            )
            self._client: AsyncAnthropic | None = None
        else:
            self._client = AsyncAnthropic(api_key=api_key)
        self._bridge = bridge
        self._safety = safety
        self._history: list[dict[str, Any]] = []

    async def chat(self, user_text: str) -> str:
        """Send a user message, run any tool calls, return the final text reply."""
        if self._client is None:
            return f"(no API key — would have replied to: {user_text!r})"

        self._history.append({"role": "user", "content": user_text})

        for _ in range(TOOL_LOOP_MAX):
            resp = await self._client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=self._history,
            )

            self._history.append({"role": "assistant", "content": resp.content})

            tool_uses = [b for b in resp.content if b.type == "tool_use"]

            if not tool_uses:
                # Pure text reply — we're done.
                text_blocks = [b.text for b in resp.content if b.type == "text"]
                return "\n".join(text_blocks).strip() or "(no reply)"

            tool_results = []
            for tu in tool_uses:
                result = await self._dispatch_tool(tu.name, tu.input)
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": result,
                    }
                )
            self._history.append({"role": "user", "content": tool_results})

            if resp.stop_reason != "tool_use":
                break

        return "(tool loop exhausted)"

    # ── Tool dispatch ────────────────────────────────────────────────────────

    async def _dispatch_tool(self, name: str, args: dict[str, Any]) -> str:
        try:
            if name == "speak":
                return await self._do_speak(args)
            if name == "report_status":
                return await self._do_report()
            if name == "look_at":
                return await self._do_look_at(args)
            if name in ACTION_TO_BRIDGE_METHOD:
                return await self._do_action(name)
        except Exception as e:
            logger.exception("tool %s raised", name)
            await self._announce_intent(name, "error", str(e))
            return f"error: {e}"
        return f"error: unknown tool {name!r}"

    async def _do_speak(self, args: dict[str, Any]) -> str:
        text = str(args.get("text", "")).strip()
        if not text:
            return "error: empty text"
        await bus.publish("speak", {"text": text})
        logger.info("speak: %s", text)
        return "ok"

    async def _do_action(self, action: str) -> str:
        """Action tools: safety check → bridge call → announce → return outcome."""
        result = self._safety.guard_action(action)
        if not result.allowed:
            await self._announce_intent(action, "rejected", result.reason)
            return f"rejected: {result.reason}"

        bridge_method_name = ACTION_TO_BRIDGE_METHOD[action]
        method: Callable[[], Awaitable[bool]] = getattr(self._bridge, bridge_method_name)
        ok = await method()
        outcome = "ok" if ok else "no-op"
        await self._announce_intent(action, outcome, "")
        logger.info("action %s: %s", action, outcome)
        return outcome

    async def _do_report(self) -> str:
        """Snapshot of robot + safety + world state, returned as JSON for the LLM."""
        state = await self._bridge.get_state()
        snapshot: dict[str, Any] = {
            "safety": self._safety.state.value,
            "mode": state.mode,
            "battery_percent": round(state.battery_percent, 2),
            "velocity": {
                "vx": round(state.vx, 3),
                "vy": round(state.vy, 3),
                "vyaw": round(state.vyaw, 3),
            },
            "pose": {
                "x": round(state.x, 3),
                "y": round(state.y, 3),
                "yaw_deg": round(state.yaw * 57.2958, 1),
            },
            "tilt": {
                "roll_deg": round(state.roll * 57.2958, 1),
                "pitch_deg": round(state.pitch * 57.2958, 1),
            },
            "body_height": round(state.body_height, 3),
            "proximity_m": {
                "front": round(state.range_obstacle[0], 2),
                "left":  round(state.range_obstacle[1], 2),
                "back":  round(state.range_obstacle[2], 2),
                "right": round(state.range_obstacle[3], 2),
            },
            "recent_assists": self._safety.recent_assists(),
            # Perception events come from the bridge (sim only for now —
            # RealBridge would compute these from camera/lidar). Tolerated
            # absence keeps this robust as bridge implementations evolve.
            "recent_perceptions": (
                self._bridge.recent_perceptions()
                if hasattr(self._bridge, "recent_perceptions")
                else []
            ),
        }
        # Include nearby world objects when a world is attached.
        world = getattr(self._bridge, "world", None)
        if world is not None:
            snapshot["nearby_objects"] = world.visible_summary(state.x, state.y)
        await self._announce_intent("report_status", "ok", "")
        return json.dumps(snapshot)

    async def _do_look_at(self, args: dict[str, Any]) -> str:
        """look_at: safety check → bridge.look_at_entity → announce → outcome."""
        target = str(args.get("target", "")).strip()
        if not target:
            await self._announce_intent("look_at", "error", "empty target")
            return "error: empty target"

        guard = self._safety.guard_action("look_at")
        if not guard.allowed:
            await self._announce_intent("look_at", "rejected", guard.reason)
            return f"rejected: {guard.reason}"

        outcome = await self._bridge.look_at_entity(target)
        # outcome is one of: ok | no_world | no_target | wrong_mode
        if outcome == "ok":
            await self._announce_intent("look_at", "ok", target)
            return f"ok: turning to face {target!r}"
        await self._announce_intent("look_at", "rejected", outcome)
        if outcome == "no_target":
            return f"rejected: no object named {target!r}"
        if outcome == "wrong_mode":
            return "rejected: robot must be standing"
        return f"rejected: {outcome}"

    async def _announce_intent(self, action: str, outcome: str, reason: str) -> None:
        """Publish an intent event so the UI can show what the LLM tried."""
        await bus.publish(
            "intent",
            {"action": action, "outcome": outcome, "reason": reason},
        )
