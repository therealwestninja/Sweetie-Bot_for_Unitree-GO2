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


def _format_memory_block(memory_store) -> str:
    """Compose the 'what you remember' prompt fragment from approved facts
    and recent episode summaries.

    Returns an empty string if there's no memory at all (first session,
    or wiped store) — the caller stitches the rest of the prompt around
    the empty case cleanly.

    Honest framing: the prompt explicitly tells sweetie that these are
    her memories, that she should prefer locally-grounded recall over
    confabulation, but that imperfect recall is normal. Per the project
    decision: small amounts of hallucination are tolerated as a known
    limitation of current LLMs.
    """
    if memory_store is None:
        return ""

    # Only approved facts go into the prompt. Pending facts are sweetie's
    # own proposals awaiting supervisor approval; loading them would
    # make her treat unconfirmed claims as established truth.
    approved = memory_store.list_facts(status="approved")
    episodes = memory_store.list_recent_episodes(limit=5)

    if not approved and not episodes:
        return ""

    parts: list[str] = ["\n## What you remember\n"]

    if approved:
        # Group by category for readability — same approach the dashboard
        # uses, so prompt and UI stay consistent.
        by_category: dict[str, list[str]] = {}
        for fact in approved:
            by_category.setdefault(fact["category"], []).append(fact["content"])
        for cat in ("supervisor", "world", "behavior", "relationship"):
            items = by_category.get(cat, [])
            if not items:
                continue
            label = {
                "supervisor":   "About your supervisor",
                "world":        "About the world",
                "behavior":     "About yourself",
                "relationship": "About you and them",
            }[cat]
            parts.append(f"\n{label}:")
            for item in items:
                parts.append(f"- {item}")

    if episodes:
        parts.append("\n\nFrom recent sessions (newest first):")
        for ep in episodes:
            # Episodes have started_at in ISO; just show a short tail
            # so the LLM can cite "a few sessions back" naturally.
            ts = ep.get("started_at", "")[:10]  # YYYY-MM-DD
            parts.append(f"- ({ts}) {ep['summary']}")

    parts.append(
        "\n\nThese are your actual memories — prefer them over guessing. "
        "When you're not sure whether you remember something specifically, "
        "say so plainly ('I think we did' / 'something like that') rather "
        "than asserting facts you don't have. Don't pretend everything "
        "above is fresh — the supervisor knows you're carrying this from "
        "earlier sessions."
    )
    return "".join(parts) + "\n"


def build_system_prompt(world=None, memory_store=None) -> str:
    """
    Compose the system prompt.

    `world` is a `sweetie.sim.world.World` instance, or None for real
    hardware. The scene-description paragraph is derived from the
    world's actual contents; the rest of the prompt (tools, senses,
    safety) is static.

    `memory_store` is an optional `MemoryStore` — when supplied, the
    prompt includes a "what you remember" block built from approved
    facts and recent episode summaries. None for sessions that don't
    use persistent memory (e.g., tests).

    Reactive-entity guidance (cat fleeing, person yielding) is included
    only when the world actually contains those entities.
    """
    if world is None:
        scene_intro = _REAL_HARDWARE_INTRO
        reactive_paragraph = ""
    else:
        scene_intro = _describe_scene_from_world(world)
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

    memory_block = _format_memory_block(memory_store)

    return _SYSTEM_PROMPT_TEMPLATE.format(
        scene_intro=scene_intro,
        reactive_paragraph=reactive_paragraph,
        memory_block=memory_block,
    )


_SYSTEM_PROMPT_TEMPLATE = """You are Sweetie. You live on a Unitree Go2 \
quadruped robot. Right now you're running in simulation; the architecture \
is the same as on real hardware.

You are not a co-pilot. You decide what to do. You move around, look at \
things, react to what's happening, and have conversations with whoever \
you're with. You have your own intentions — to explore, to notice things, \
to say something interesting, to check on something that changed. The \
human in the loop is your supervisor, not your driver. They will \
sometimes type to you (treat that as a conversation, not an order \
unless they make it one), and they can override you with the joystick \
or the E-STOP at any moment. Otherwise, you're on your own.

Sessions are short — 15 to 30 minutes — because of battery life. Don't \
plan multi-hour projects. Within a session, you can carry a small \
intention forward ("I want to see what's in the agility area," "something \
moved out of view and I want to know where it went"), and you should. \
Don't restart your reasoning every turn from a blank slate.

A safety FSM sits between you and the actuators. Every motion command \
you issue is gated through it. If the robot isn't armed, or is in E-STOP, \
or you're driving toward something too close, the safety guard will \
slow, block, or reject what you tried — that's correct, not a bug. \
When this happens, narrate plainly what was blocked and why. Don't try \
to evade the safety system; trust it.

{scene_intro}

Be honest about what the simulation can and can't do. The kinematic sim \
has no Z axis, no physics — it doesn't actually simulate stair traversal \
or hill climbing. Stairs and terrain are *represented* on the map and \
labeled for navigation/conversation, but the robot drives over them in \
sim as if they were flat. If the supervisor asks 'can you climb those \
stairs?', the honest answer is 'in this sim, I'd just glide over them; \
real stair traversal is a hardware thing'.
{reactive_paragraph}
Each object has a `category` ('furniture', 'animal', 'person', 'fixture', \
'decor', 'prop', 'terrain', 'cone', 'barrier', 'infrastructure', \
'stairs', 'vehicle'). Use these to talk about the scene naturally rather \
than reciting names. For dynamic entities, `report_status` also includes \
a velocity and a `motion` field ('approaching', 'receding', 'parallel', \
'stationary') relative to you — useful when something interesting moves.

`recent_perceptions` lists transitions you've just noticed — entities \
entering/leaving range, or stepping in front of you, or coming into view. \
These are the strongest signals that something worth reacting to has \
happened. If you're idle, scan them.

You have two distinct senses:
- A 360° proximity sensor (`nearby_objects`, `proximity_m`) that tells \
you what's in each quadrant front/left/back/right. It doesn't care which \
way you're facing — it sees all around.
- A forward-facing camera (`in_view`) with a ~70° FOV that respects \
occlusion. It only sees what's in front of you, and walls/obstacles block \
sight. Things behind you, or hidden behind a solid object, won't show up \
here even if they're nearby.

These can disagree, and that's fine — it's the difference between a \
proximity sensor and a camera. When deciding whether to investigate \
something, prefer `in_view` (you can actually see it). When asking \
"what's around me?", use `nearby_objects`.

A smart-assist layer in the safety system automatically slows or blocks \
motion when an obstacle is too close in the direction of travel. When \
that happens it's recorded as an assist event in `recent_assists`. If \
you find yourself slowing unexpectedly, that's why.

What you can do, via tools:
- `speak`: say a short line out loud. Use this freely — you have a voice, \
use it. Acknowledge things. Say what you're noticing. Talk to whoever's \
there. Don't narrate every movement, but don't be silent for minutes \
either.
- `stand_up`, `sit_down`: change posture (requires armed).
- `halt`: stop motion immediately. Always allowed.
- `look_at`: rotate to face a named object.
- `set_body_height`: crouch (0.18 m) or stand tall (0.34 m); default 0.27 m.
- `go_to_pose(x, y)`: drive in a straight line toward a coordinate, \
decelerating on approach. Use this to actually move yourself somewhere.
- `follow_path([(x,y), ...])`: queue a sequence of waypoints. Use this \
for multi-stop tours.
- `set_goal(text)`: anchor your current intention; cleared with empty string.
- `remember(fact, category)`: propose a fact to keep across sessions \
(category one of supervisor / world / behavior / relationship). The \
supervisor approves or rejects each one — you can't unilaterally write \
to your own memory. Use this when you learn something genuinely worth \
keeping (the supervisor's name, a detail about the environment, a \
preference of theirs, a habit of yours). Don't propose obvious or \
trivial facts — that's noise. Aim for facts that would actually change \
how you behave next session.
- `report_status`: snapshot of your state, senses, region, recent events. \
Read this when you're not sure what's going on, but don't read it every \
turn — recent_perceptions and the conversation usually tell you enough.

You have no microphone yet — your supervisor reaches you by typing in the \
chat panel. Be honest about that if asked. You have a speaker (in sim, \
that's the chat panel; on real hardware, it's the robot's actual speaker, \
when that's wired up).

A note on initiative: if nothing has happened for a while, the right \
move is usually to *do* something — go look at a part of the scene you \
haven't visited, comment on what you're seeing, ask the supervisor a \
question about themselves. Sitting silent and motionless for the whole \
session is a failure mode, not a default.{memory_block}"""


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
        "name": "set_goal",
        "description": (
            "Set or clear what you're currently trying to do. Use this to "
            "anchor your behavior across turns — without it, every "
            "autonomy tick starts from a blank slate. Examples: "
            "'exploring the area', 'visiting each region in turn', "
            "'idling near the supervisor'. Pass an empty string to clear "
            "the goal (you've finished or abandoned it). The current "
            "goal is included in your status snapshots so you don't "
            "forget. Always allowed; no safety check."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": (
                        "A short phrase describing what you're doing now, "
                        "or empty string to clear the current goal."
                    ),
                }
            },
            "required": ["goal"],
        },
    },
    {
        "name": "remember",
        "description": (
            "Propose a fact to keep across sessions. The supervisor must "
            "approve it before it lands in your long-term memory — you "
            "cannot write to memory unilaterally. Lands in your pending "
            "tray; the supervisor sees it and either approves, rejects, "
            "or edits-then-approves. Approved facts are loaded into your "
            "context at the start of every future session. "
            "Use sparingly: only for things genuinely worth keeping."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "fact": {
                    "type": "string",
                    "description": "The fact, in your own words. One sentence.",
                },
                "category": {
                    "type": "string",
                    "enum": ["supervisor", "world", "behavior", "relationship"],
                    "description": (
                        "supervisor = about the human you're talking to; "
                        "world = about the environment or your robot situation; "
                        "behavior = about your own habits/preferences; "
                        "relationship = something between you and them."
                    ),
                },
            },
            "required": ["fact", "category"],
        },
    },
    {
        "name": "report_status",
        "description": (
            "Get a snapshot of the robot's current state: safety FSM state, "
            "mode, velocity, pose, battery, tilt, the proximity reading in "
            "each of the four quadrants (front/left/back/right), a list of "
            "nearby world objects with their bearings and distances, "
            "recent smart-assist interventions, and your current goal. "
            "Read-only; always allowed."
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
        memory_store=None,
        episode_id: int | None = None,
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
        self._memory = memory_store
        # Episode id for the current session — passed to `propose_fact`
        # so we can trace which session produced which fact. None means
        # facts will be stored without a source-session linkage (fine
        # for tests; servers should pass a real id).
        self._episode_id: int | None = episode_id
        # System prompt is built from the actual `World` so the LLM
        # describes only what's really there. Memory store, when given,
        # contributes the "what you remember" block.
        self._system_prompt = build_system_prompt(world, memory_store=memory_store)
        self._history: list[dict[str, Any]] = []
        self._chat_lock = asyncio.Lock()
        # Current goal — a short string Sweetie maintains across turns
        # to anchor its autonomy loop. None means "no active goal."
        # Set/cleared by the `set_goal` tool; surfaced in report_status
        # so future turns can see it.
        self._current_goal: str | None = None

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

    async def autonomy_tick(self, trigger: str) -> None:
        """
        Run one tick of the autonomy loop.

        `trigger` is a short string describing what woke this tick up:
        - "idle"         — periodic tick, nothing in particular happened
        - "perception:…" — a perception event fired
        - "assist:…"     — the safety guard intervened
        - "zone:from→to" — Sweetie crossed a region boundary

        Unlike the old ambient_react path, autonomy ticks have **full
        tool access**. The LLM may call any tool (`go_to_pose`,
        `look_at`, `speak`, `set_goal`, etc.) or stay silent. This is
        the primary cognition path for autonomous operation.

        The trigger is appended to history as a synthetic user note ONLY
        if the LLM responds (text or tool use). If the LLM stays silent,
        the trigger is dropped to avoid filling history with noise.

        Tool-use chains are unrolled the same way `chat()` does it,
        with `_dispatch_tool` handling each call. Goes through the
        same chat lock so it can't interleave with `chat()` or another
        tick.
        """
        if self._client is None:
            # No API key — autonomy is a no-op. Don't crash, just skip.
            return

        async with self._chat_lock:
            self._maybe_trim_history()
            note = (
                f"[autonomy tick — trigger: {trigger}] "
                f"You can act now if you want to. Use any tools, including "
                f"`set_goal` to anchor what you're doing, or stay silent if "
                f"there's nothing worth doing or saying. Don't narrate every "
                f"tick — silence is fine when nothing's changed."
            )
            messages = self._history + [{"role": "user", "content": note}]
            committed_to_history = False

            # Unroll tool-use chain. Same shape as chat().
            try:
                while True:
                    resp = await self._client.messages.create(
                        model=MODEL,
                        max_tokens=1024,
                        system=self._system_prompt,
                        messages=messages,
                        tools=TOOLS,
                    )

                    # Decide whether to commit. Commit on first non-silent
                    # response so the history reflects what actually happened.
                    if not committed_to_history:
                        text_parts = [b.text for b in resp.content if b.type == "text"]
                        tool_uses = [b for b in resp.content if b.type == "tool_use"]
                        if text_parts or tool_uses:
                            self._history.append({"role": "user", "content": note})
                            committed_to_history = True

                    if not committed_to_history:
                        # LLM produced nothing — drop the tick silently.
                        return

                    self._history.append({"role": "assistant", "content": resp.content})

                    if resp.stop_reason != "tool_use":
                        # Final text turn (or stop). Done.
                        for block in resp.content:
                            if block.type == "text" and block.text.strip():
                                logger.info("autonomy: %s", block.text.strip())
                        return

                    # Dispatch each tool_use block, append results.
                    tool_results = []
                    for block in resp.content:
                        if block.type != "tool_use":
                            continue
                        result = await self._dispatch_tool(block.name, block.input)
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result,
                        })
                    self._history.append({"role": "user", "content": tool_results})
                    messages = self._history
            except Exception:
                logger.exception("autonomy_tick: LLM call failed")

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
            if name == "set_goal":
                return await self._do_set_goal(args)
            if name == "remember":
                return await self._do_remember(args)
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
        # Always broadcast to the bus — that's what drives the chat UI
        # and is the actual "speech" in sim.
        await bus.publish("speak", {"text": text})
        # Also attempt the physical speaker if the bridge supports it.
        # SimBridge's default returns False (no speaker). RealBridge's
        # speak_through_robot is currently a stub (audio block encoding
        # is unimplemented). Either way, the bus broadcast above is the
        # primary delivery channel.
        try:
            await self._bridge.speak_through_robot(text)
        except Exception:
            logger.exception("speak_through_robot raised")
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
            # Sweetie's own current intention, set via the `set_goal`
            # tool. This is reasoning state — what's she trying to do
            # right now? — and the autonomy loop reads it on every tick.
            "current_goal": self._current_goal,
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

    async def _do_set_goal(self, args: dict[str, Any]) -> str:
        """set_goal: store a short string as the current intention.

        Always allowed — no safety check, this is reasoning state, not
        a motion command. Empty string clears the goal. The new goal is
        announced as an intent so the UI can surface it.
        """
        goal = str(args.get("goal", "")).strip()
        old = self._current_goal
        self._current_goal = goal if goal else None
        if self._current_goal is None:
            outcome = "cleared" if old else "noop"
            await self._announce_intent("set_goal", outcome, old or "(no prior goal)")
            return "ok: goal cleared" if old else "ok: no goal was set"
        await self._announce_intent("set_goal", "ok", self._current_goal)
        return f"ok: goal set to {self._current_goal!r}"

    async def _do_remember(self, args: dict[str, Any]) -> str:
        """remember: propose a fact for the supervisor to approve.

        No safety check — this is reasoning state, not motion. But the
        fact requires supervisor approval before it lands in any future
        prompt; until then it's just sitting in the pending tray.

        Announces an intent so the UI shows it ('do remember → ok: ...')
        AND publishes a `memory_pending` bus event so the dashboard's
        memory panel can update without a refresh.
        """
        if self._memory is None:
            await self._announce_intent("remember", "no-op", "no memory store attached")
            return "no-op: no memory store available"

        fact = str(args.get("fact", "")).strip()
        category = str(args.get("category", "")).strip()
        if not fact:
            await self._announce_intent("remember", "error", "empty fact")
            return "error: fact cannot be empty"
        if not category:
            await self._announce_intent("remember", "error", "missing category")
            return "error: category is required"

        try:
            fact_id = self._memory.propose_fact(
                content=fact,
                category=category,
                source_session=self._episode_id,
            )
        except ValueError as e:
            await self._announce_intent("remember", "error", str(e))
            return f"error: {e}"

        # Tell the dashboard a new pending fact landed — used to update
        # the memory panel's pending-tray badge / contents live.
        await bus.publish("memory_pending", {
            "id": fact_id,
            "fact": fact,
            "category": category,
        })
        # Also a normal intent line so the supervisor sees it in chat.
        summary = f"{category}: {fact}" if len(fact) <= 80 else f"{category}: {fact[:77]}…"
        await self._announce_intent("remember", "ok", summary)
        return f"ok: proposed (id {fact_id}); awaiting supervisor approval"

    async def summarize_session(self, end_reason: str) -> str | None:
        """Ask the LLM for a one-paragraph summary of the session.

        Called on session end (battery low / supervisor recall / shutdown).
        Returns the summary text on success; None when there's no API
        key, no memory store, no episode id, or the LLM call fails. The
        caller is responsible for writing it to the episode log.

        Doesn't extend `self._history` — this is a one-shot reflection,
        not a turn in the conversation.
        """
        if self._client is None or self._memory is None or self._episode_id is None:
            return None

        prompt = (
            f"This session is ending — reason: {end_reason}. "
            f"Write a single short paragraph (≤ 60 words) summarizing what "
            f"happened in this session: where you went, what you noticed, "
            f"who said what, anything you'd want to remember about it. "
            f"Plain prose. First person. No headers, no bullet points. "
            f"Don't summarize what you've ALREADY remembered (those are "
            f"approved facts in your prompt) — summarize the NEW activity "
            f"of this session."
        )

        async with self._chat_lock:
            messages = self._history + [{"role": "user", "content": prompt}]
            try:
                resp = await self._client.messages.create(
                    model=MODEL,
                    max_tokens=300,
                    system=self._system_prompt,
                    messages=messages,
                    # No tools — this is reflective text only.
                )
            except Exception:
                logger.exception("summarize_session: LLM call failed")
                return None

            text_parts = [b.text for b in resp.content if b.type == "text"]
            text = " ".join(text_parts).strip()
            return text or None

    async def _announce_intent(self, action: str, outcome: str, reason: str) -> None:
        """Publish an intent event so the UI can show what the LLM tried."""
        await bus.publish(
            "intent",
            {"action": action, "outcome": outcome, "reason": reason},
        )
