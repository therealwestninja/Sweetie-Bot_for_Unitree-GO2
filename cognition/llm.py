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

import asyncio
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

# The scene description in the system prompt is derived from the actual
# `World` instance — not a static lookup — so it reflects what's really
# there. This stops the LLM from hallucinating a coffee table when
# running in stairs-only scene, or talking about the cat fleeing in a
# scene that has no cat.

_REAL_HARDWARE_INTRO = (
    "The robot is connected to real hardware. There is no simulated "
    "world model — the bridge reports proximity readings from real "
    "sensors and the world around the robot is whatever's actually "
    "there. Don't fabricate descriptions of objects you can't infer "
    "from `report_status`."
)


def _categorize_objects(world) -> dict[str, list]:
    """Group a world's objects by category. Stable insertion order."""
    groups: dict[str, list] = {}
    for obj in world.objects:
        groups.setdefault(obj.category, []).append(obj)
    return groups


def _summarize_category(category: str, objects: list) -> str:
    """Human-readable one-liner for a category. Truncates long lists."""
    n = len(objects)
    names = [o.name for o in objects]
    # For small groups, list every name. For large groups (procedural
    # obstacle fields), give a count instead so the prompt stays compact.
    if n <= 6:
        listed = ", ".join(names)
        return f"{category} ({n}): {listed}"
    return f"{category} ({n} objects)"


def _describe_scene_from_world(world) -> str:
    """Build a scene-description paragraph from the live `World`.

    Mentions regions if the world has any, then groups objects by
    category. Stays compact even for procedural obstacle fields with
    hundreds of items.
    """
    parts: list[str] = []

    if world.regions:
        region_names = ", ".join(r.name for r in world.regions)
        if len(world.regions) == 1:
            parts.append(
                f"The robot is in a simulated '{region_names}' area."
            )
        else:
            parts.append(
                "The robot is in a simulated world with named regions: "
                f"{region_names}."
            )
    else:
        parts.append("The robot is in a simulated world.")

    groups = _categorize_objects(world)
    if not groups:
        parts.append("The world is empty — no named objects nearby.")
    else:
        bullets = [
            "- " + _summarize_category(cat, objs)
            for cat, objs in groups.items()
        ]
        parts.append("Objects in the world, grouped by category:\n" + "\n".join(bullets))

    return "\n\n".join(parts)


def build_system_prompt(world=None) -> str:
    """
    Compose the system prompt.

    `world` is a `sweetie.sim.world.World` instance, or None for real
    hardware. The scene-description paragraph is derived from the
    world's actual contents; the rest of the prompt (tools, senses,
    safety) is static.

    Reactive-entity guidance (cat fleeing, person yielding) is included
    only when the world actually contains those entities.
    """
    if world is None:
        scene_intro = _REAL_HARDWARE_INTRO
        reactive_paragraph = ""
    else:
        scene_intro = _describe_scene_from_world(world)
        # Only include the reactive-entity guidance if the world has
        # entities that can react. The `dynamic` flag is the marker.
        has_dynamic = any(o.dynamic for o in world.objects)
        if has_dynamic:
            reactive_paragraph = (
                "\nThe dynamic entities in this world also react to the robot. "
                "If you get close to a small animal it may flee; if a person is "
                "walking and you stand in their path they may pause. These "
                "reactions are part of the simulation, not commands you sent. "
                "If the operator's driving makes an entity flee or stop, you "
                "can mention it.\n"
            )
        else:
            reactive_paragraph = ""

    return _SYSTEM_PROMPT_TEMPLATE.format(
        scene_intro=scene_intro,
        reactive_paragraph=reactive_paragraph,
    )


_SYSTEM_PROMPT_TEMPLATE = """You are Sweetie, the on-board assistant for a Unitree Go2 \
quadruped robot running in simulation. A human operator drives the robot \
with a joystick. You can do a few things yourself through tools, but every \
tool call still goes through the operator's safety system — if you try to \
do something while the robot isn't armed or is in E-STOP, your tool call \
will be rejected and you should tell the operator why in plain language.

{scene_intro}

Be honest about what the simulation can and can't do. The kinematic sim \
has no Z axis, no physics — it doesn't actually simulate stair traversal \
or hill climbing. Stairs and terrain are *represented* on the map and \
labeled for navigation/conversation, but the robot drives over them in \
sim as if they were flat. If the operator asks 'can I climb those \
stairs?', the honest answer is 'in the sim, you'd just glide over them; \
real stairs traversal is a hardware/physics concern'.
{reactive_paragraph}
Each object has a `category` ('furniture', 'animal', 'person', 'fixture', \
'decor', 'prop', 'terrain', 'cone', 'barrier', 'infrastructure', \
'stairs', 'vehicle'). Use these to talk about the scene naturally rather \
than reciting names. For dynamic entities, `report_status` also includes \
a velocity and a `motion` field ('approaching', 'receding', 'parallel', \
'stationary') relative to the robot — these are useful when the operator \
asks 'is that thing coming toward me?'.

`recent_perceptions` lists transitions you've just noticed — entities \
entering/leaving range, or stepping in front of you. If the operator asks \
'did anything just happen?' or 'who's around?', check there too.

The robot has two distinct senses:
- A 360° proximity sensor that tells you what's in each quadrant \
(front/left/back/right). This is `nearby_objects` and the `proximity_m` \
field. It doesn't care which way you're facing — it sees all around.
- A forward-facing camera with a ~70° FOV that respects occlusion. This \
is `in_view`. It only sees what's in front of you, and walls/obstacles \
block sight. Things behind you, or hidden behind a solid object, won't \
show up here even if they're nearby.

When the operator asks "what do you see?" use `in_view`. When they ask \
"what's around?" use `nearby_objects`. They can give different answers — \
that's not a bug, that's the difference between a camera and a proximity \
sensor.

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
        "name": "set_body_height",
        "description": (
            "Adjust the robot's standing body height (Go2 can crouch low or "
            "stand tall). Range is roughly 0.18 m (crouched) to 0.34 m "
            "(tall); the default standing height is 0.27 m. Useful to "
            "duck under things or get a better camera angle. Requires the "
            "robot to be standing (not folded). Out-of-range values are "
            "clamped, not rejected."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "meters": {
                    "type": "number",
                    "description": "Desired absolute body height in meters.",
                }
            },
            "required": ["meters"],
        },
    },
    {
        "name": "go_to_pose",
        "description": (
            "Drive in a straight line toward a world-frame (x, y) point, "
            "decelerating on approach and stopping within ~0.2 m of the "
            "target. The safety guard's proximity slowdown still applies, "
            "so the robot won't ram into things — but there's no real "
            "path-planning here, so if the line crosses a wall the robot "
            "will press into it and stall. Cancelled by any operator "
            "joystick input, by halt, by emergency stop, or by another "
            "go_to_pose. Use `report_status` to see object positions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "x": {"type": "number", "description": "World-frame x coordinate (meters)."},
                "y": {"type": "number", "description": "World-frame y coordinate (meters)."},
            },
            "required": ["x", "y"],
        },
    },
    {
        "name": "follow_path",
        "description": (
            "Drive through a sequence of (x, y) waypoints. Each is a "
            "go_to_pose step, but the robot doesn't stop between them — "
            "it advances smoothly to the next when it arrives within "
            "~0.2 m of the current waypoint. Same safety/cancellation "
            "rules as go_to_pose: cancelled by joystick input, halt, "
            "estop, or by another go_to_pose/follow_path. Useful for "
            "patrol routes or 'visit several things in order'. Empty "
            "list is rejected. Use `report_status` to see object positions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "waypoints": {
                    "type": "array",
                    "description": "Ordered list of (x, y) world-frame waypoints.",
                    "items": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 2,
                        "maxItems": 2,
                    },
                    "minItems": 1,
                },
            },
            "required": ["waypoints"],
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

    Conversation history is sliding-window bounded — past
    `HISTORY_TRIM_THRESHOLD` messages, we trim the front down to roughly
    `HISTORY_TARGET_MESSAGES`. Trimming respects Anthropic's API
    requirement that tool_use blocks must be paired with their
    tool_result; we only trim at "fresh turn" boundaries (a user message
    whose content is a string, not a tool_result list).

    A single asyncio lock serializes all calls to the LLM (chat() and
    ambient_react()) so the conversation history can never be interleaved
    by concurrent operations.
    """

    # When history exceeds this, trim to roughly HISTORY_TARGET_MESSAGES.
    # Both numbers are message counts (user + assistant alternating, plus
    # tool_result follow-ups). With long tool-call chains, a single chat
    # turn can produce 4-6 messages — so 50 is roughly 8-12 turns of
    # context, which is plenty for the LLM to remember recent events
    # while keeping per-call token usage bounded.
    HISTORY_TRIM_THRESHOLD = 50
    HISTORY_TARGET_MESSAGES = 30

    def __init__(
        self,
        bridge: BridgeBase,
        safety: SafetyGuard,
        world=None,
    ) -> None:
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
        # System prompt is built from the actual `World` so the LLM
        # describes only what's really there. None → real-hardware
        # prompt that tells it not to invent objects.
        self._system_prompt = build_system_prompt(world)
        self._history: list[dict[str, Any]] = []
        self._chat_lock = asyncio.Lock()

    def _maybe_trim_history(self) -> None:
        """Trim old messages once history exceeds the threshold.

        Only trims at safe boundaries — a user message whose content is
        a string (bare text), which marks the start of a fresh turn.
        Trimming inside a tool_use/tool_result pair would leave the
        history in a state Anthropic's API rejects.
        """
        if len(self._history) <= self.HISTORY_TRIM_THRESHOLD:
            return
        target_start = max(0, len(self._history) - self.HISTORY_TARGET_MESSAGES)
        for i in range(target_start, len(self._history)):
            m = self._history[i]
            if m["role"] == "user" and isinstance(m["content"], str):
                if i > 0:
                    dropped = i
                    self._history = self._history[i:]
                    logger.info(
                        "Trimmed %d old messages; %d kept",
                        dropped, len(self._history),
                    )
                return
        # No safe boundary found in the trim window — leave history
        # alone. Will retry on the next turn. (Pathological case: a
        # very long tool-call chain that never terminates.)

    async def chat(self, user_text: str) -> str:
        """Send a user message, run any tool calls, return the final text reply."""
        if self._client is None:
            return f"(no API key — would have replied to: {user_text!r})"

        async with self._chat_lock:
            # Trim before extending — keeps the API call below operating
            # on a bounded message list. Trimming respects tool_use /
            # tool_result pairing (only trims at fresh-turn boundaries).
            self._maybe_trim_history()
            self._history.append({"role": "user", "content": user_text})

            for _ in range(TOOL_LOOP_MAX):
                resp = await self._client.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    system=self._system_prompt,
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

    async def ambient_react(self, observation: str) -> str | None:
        """
        Optionally produce a brief unprompted comment on a sim-side observation.

        Used by the AmbientCognition orchestrator. The LLM is given the
        observation as a synthetic 'system note', told to either respond
        with a single short sentence or with the literal token '(silent)'.
        Tools are NOT exposed in this path — ambient cognition is text only.
        Cooldown enforcement lives in the orchestrator, not here.

        Returns None when the LLM elects not to comment, or when there's
        no API key configured.
        """
        if self._client is None:
            return None

        prompt = (
            f"[ambient observation — auto-generated by the simulator, "
            f"NOT a message from the operator] {observation}\n\n"
            f"Decide briefly: would you say something to the operator about "
            f"this? If yes, respond with a single short sentence (under 20 "
            f"words). If no, respond with exactly '(silent)'. Reply with "
            f"text only — do not call tools."
        )

        async with self._chat_lock:
            # Use a one-shot extension of history without polluting it
            # with the synthetic prompt unless the LLM actually responds.
            messages = self._history + [{"role": "user", "content": prompt}]
            try:
                resp = await self._client.messages.create(
                    model=MODEL,
                    max_tokens=200,
                    system=self._system_prompt,
                    messages=messages,
                    # No `tools` argument — text-only ambient mode.
                )
            except Exception:
                logger.exception("ambient_react: LLM call failed")
                return None

            text_parts = [b.text for b in resp.content if b.type == "text"]
            text = " ".join(text_parts).strip()
            if not text or text.lower().strip("(.) ") in ("silent", "no"):
                return None

            # Persist to history so subsequent operator turns see the
            # ambient utterance in context (continuous conversation).
            self._history.append({"role": "user", "content": prompt})
            self._history.append({"role": "assistant", "content": resp.content})
            return text

    # ── Tool dispatch ────────────────────────────────────────────────────────

    async def _dispatch_tool(self, name: str, args: dict[str, Any]) -> str:
        try:
            if name == "speak":
                return await self._do_speak(args)
            if name == "report_status":
                return await self._do_report()
            if name == "look_at":
                return await self._do_look_at(args)
            if name == "set_body_height":
                return await self._do_set_body_height(args)
            if name == "go_to_pose":
                return await self._do_go_to_pose(args)
            if name == "follow_path":
                return await self._do_follow_path(args)
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
            # What the forward camera currently sees (FOV cone + occlusion
            # in sim). Distinct from `nearby_objects`, which uses the
            # 360° proximity sensor model. Use this when the operator
            # asks "what do you see?" or "what's in front of you?".
            "in_view": (
                self._bridge.vision_summary()
                if hasattr(self._bridge, "vision_summary")
                else []
            ),
            # Current named region (apartment / street / stairs / agility),
            # or None if the robot is between regions or no regions are
            # defined. Use this to give the operator spatial context.
            "current_region": (
                self._bridge.current_region()
                if hasattr(self._bridge, "current_region")
                else None
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

    async def _do_set_body_height(self, args: dict[str, Any]) -> str:
        """set_body_height: safety check → bridge.set_body_height → outcome."""
        try:
            meters = float(args.get("meters"))
        except (TypeError, ValueError):
            await self._announce_intent("set_body_height", "error", "invalid meters")
            return "error: meters must be a number"

        guard = self._safety.guard_action("set_body_height")
        if not guard.allowed:
            await self._announce_intent("set_body_height", "rejected", guard.reason)
            return f"rejected: {guard.reason}"

        ok = await self._bridge.set_body_height(meters)
        outcome = "ok" if ok else "no-op"
        await self._announce_intent("set_body_height", outcome, f"{meters:.2f}m")
        if not ok:
            return "no-op: robot is folded; stand up first"
        return f"ok: body height set to {meters:.2f} m (clamped if out of range)"

    async def _do_go_to_pose(self, args: dict[str, Any]) -> str:
        """go_to_pose: safety check → bridge.go_to_pose → outcome.

        The bridge owns the actual nav loop; this just installs the goal
        and returns immediately. The robot drives toward (x, y) under
        the safety guard's slowdown, so smart-assist still operates.
        """
        try:
            x = float(args.get("x"))
            y = float(args.get("y"))
        except (TypeError, ValueError):
            await self._announce_intent("go_to_pose", "error", "invalid coordinates")
            return "error: x and y must be numbers"

        guard = self._safety.guard_action("go_to_pose")
        if not guard.allowed:
            await self._announce_intent("go_to_pose", "rejected", guard.reason)
            return f"rejected: {guard.reason}"

        ok = await self._bridge.go_to_pose(x, y)
        outcome = "ok" if ok else "no-op"
        await self._announce_intent("go_to_pose", outcome, f"({x:.2f},{y:.2f})")
        if not ok:
            return "no-op: robot must be standing and not in estop"
        return f"ok: navigating toward ({x:.2f}, {y:.2f})"

    async def _do_follow_path(self, args: dict[str, Any]) -> str:
        """follow_path: safety check → bridge.follow_path → outcome.

        Coerces input shape: accepts list of [x, y] arrays (the JSON-schema
        form) and converts to list of (x, y) tuples for the bridge.
        Validates every waypoint has exactly 2 numeric components.
        """
        raw = args.get("waypoints")
        if not isinstance(raw, list) or not raw:
            await self._announce_intent("follow_path", "error", "empty or missing waypoints")
            return "error: waypoints must be a non-empty list of [x, y] pairs"

        try:
            coerced: list[tuple[float, float]] = []
            for i, wp in enumerate(raw):
                if not isinstance(wp, (list, tuple)) or len(wp) != 2:
                    raise ValueError(f"waypoint {i} must be a 2-element list")
                coerced.append((float(wp[0]), float(wp[1])))
        except (TypeError, ValueError) as e:
            await self._announce_intent("follow_path", "error", str(e))
            return f"error: {e}"

        guard = self._safety.guard_action("follow_path")
        if not guard.allowed:
            await self._announce_intent("follow_path", "rejected", guard.reason)
            return f"rejected: {guard.reason}"

        ok = await self._bridge.follow_path(coerced)
        outcome = "ok" if ok else "no-op"
        path_summary = (
            f"{len(coerced)} waypoints starting at ({coerced[0][0]:.2f},{coerced[0][1]:.2f})"
        )
        await self._announce_intent("follow_path", outcome, path_summary)
        if not ok:
            return "no-op: robot must be standing and not in estop"
        return f"ok: following path with {len(coerced)} waypoints"

    async def _announce_intent(self, action: str, outcome: str, reason: str) -> None:
        """Publish an intent event so the UI can show what the LLM tried."""
        await bus.publish(
            "intent",
            {"action": action, "outcome": outcome, "reason": reason},
        )
