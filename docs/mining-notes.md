# Mining GrowBot + Float-Knights for Sweetie improvements

A pass over both projects for ideas transferable to Sweetie, what got
built this round, and a prioritized backlog of the rest. Everything is
checked against Sweetie's `ROADMAP.md` so nothing here re-litigates a
deliberate out-of-scope decision.

## What each source actually offers

**GrowBot** ships only hardware drivers (`setup/growbot/*.py`); its
"LLM brain" is V1 and unreleased, so the AI value is *architectural*,
stated in its README:

- Perceive → LLM picks a goal & proposes an action → robot tries it →
  result feeds back in. Sweetie already does this (`autonomy_tick`
  unrolls a tool chain and the tool results re-enter `_history`).
- "Fast reflexes underneath as a safety floor." Sweetie's `SafetyGuard`
  is exactly that floor.
- "Logs its episodes, failures, and sensor traces so each run feeds the
  next pass." Sweetie logs episode *prose summaries* but not structured
  action/outcome traces — see backlog item B3.
- Graceful per-subsystem degradation (`hello_growbot.py`: a half-built
  robot still says hi). Sweetie mirrors this with `hasattr(...)` probes
  in `report_status`.

Net: GrowBot mostly *confirms* Sweetie's architecture rather than adding
to it. The one genuinely new seed is structured episode logging (B3).

**Float-Knights** is the high-value source. It explicitly models the
same robot — its config comments call the bots "the Unitree Go2 ... the
robot the Sweetie movement was adapted from," tuned to the Go2's ~2 rad/s
yaw and ~120° FOV. So its bot-AI patterns map to Sweetie *directly*, not
by analogy. The transferable patterns, all in its `decideAIState` /
`executeAIState` / `_applySteering` machinery:

1. **Emergency interrupt vs. commit window.** Bots hold a freshly chosen
   state for `botDecisionCommitFrames` to stop flip-flop jitter, but
   `_isEmergencyInterrupt` (took a hit / target died / projectile in the
   threat bubble) overrides the hold instantly.
2. **Target memory with TTL.** Losing FOV-sight of a target doesn't drop
   it for `botTargetMemoryFrames` — stops "rounding a pillar" from
   causing target flicker.
3. **Explicit decision-priority cascade** (stunned → idle → mercy →
   rally → melee → kite → seek-item → seek-core → engage), with sticky
   targeting so the plan doesn't ping-pong.
4. **Reynolds force-truncated steering + pivot-in-place**, with the
   steering force cap derived from the Go2 yaw spec, and local obstacle
   avoidance (wall repulsion + separation forces, arrival-attenuated).
5. **RALLY vs FLEE** (directed retreat toward a teammate vs. panic flee)
   and **SEEK_ITEM** (goal-seek when no threat is present).

## Shipped this round

**Urgency-tiered autonomy triggering** — Float-Knights pattern #1 ported
onto a real Sweetie gap.

Today the autonomy loop uses one flat cooldown (`SWEETIE_AUTONOMY_COOLDOWN_S`,
8 s) for *every* trigger. A smart-assist intervention arriving 1 s after
an idle tick therefore waits ~7 s before Sweetie reconsiders — exactly
the latency Float-Knights' emergency interrupt exists to kill.

The fix splits triggers into two tiers:

- **NORMAL** (idle ticks, region changes, "moved/left/cleared"
  perceptions) — gated by the full cooldown; this is the anti-spam budget.
- **URGENT** (smart-assist interventions, and perceptions meaning
  something got *closer*: entered a quadrant, stepped in front, came into
  view) — bypass the cooldown, subject only to a small hard floor
  (`urgent_min_gap_s`, default 1.5 s) so a burst still can't spam the API.

The cooldown is Sweetie's commit window; safety-relevant events are her
emergency interrupts. Misclassification is safe by construction: urgency
only ever *lowers* latency, so a near-miss at worst reverts to today's
behaviour — no regression path.

This also un-breaks the build: `cognition/autonomy.py` is imported by
`teleop/server.py` but was **absent from the snapshot**, so autonomy
couldn't import. The new file implements the exact interface the server
expects — `Autonomy(cog, idle_interval_s, cooldown_s)`, sync `attach()`,
async idempotent `detach()` — modelled on the proven cooldown/lock
discipline in `cognition/ambient.py`.

Files:

- `cognition/autonomy.py` — the orchestrator.
- `tools/test_autonomy.py` — 21 tests (classifier, cooldown gating,
  urgent bypass + floor, single-tick lock, idle start/stop, idempotency,
  failing-tick survival). All passing.

> If your full repo already has an `autonomy.py`, port the *idea* — the
> two-tier `_fire(trigger, urgent=...)` gate plus `_perception_is_urgent`
> — into it rather than replacing wholesale; this file reconstructs the
> documented behaviour from `server.py` + `README`, so it may differ from
> your original in incidental ways.

## Backlog (prioritized, not yet built)

**A — Cognition continuity (Float-Knights #2, #3)**

- **A1. Tracked-entity memory with TTL.** When Sweetie is attending to an
  entity that leaves `in_view` (occluded by the couch, turned away),
  carry a "last seen \<entity\> at \<x,y\>, \<n\>s ago" note for a TTL
  rather than dropping it. Small surface in `Cognition`; surfaces in
  `report_status`. Directly Float-Knights `botTargetMemoryFrames`.
- **A2. Explicit priority cascade in the system prompt.** Sweetie's
  prompt lists tools but not an ordering for *when nothing is asked*.
  Add a short cascade (safety/assist → answer supervisor → pursue
  `current_goal` → react to a fresh perception → explore) so autonomy
  behaviour is legible and consistent. Prompt-only; no code risk.
  Mirrors the documented `decideAIState` cascade.

**B — Initiative & learning (GrowBot, Float-Knights #5)**

- **B3. Structured episode trace.** Alongside the prose episode summary,
  persist a compact action/outcome trace (tool, outcome, reason — the
  `intent` events already exist on the bus). GrowBot's "log failures so
  each run feeds the next." Enables later review without a replay system
  (which the ROADMAP defers — this is the cheap precursor).
- **B4. Curiosity target ("SEEK_ITEM").** A lightweight "go look at the
  most interesting thing I haven't visited" when idle and goal-less,
  composing over existing `look_at` / `go_to_pose`. The ROADMAP's
  "tour-style multi-region exploration ⏳" is the structured version.

**C — Sim motion fidelity (Float-Knights #4)** — lower priority

- **C5. Reynolds steering in the sim nav loop.** `SimBridge._integrate`
  currently turns-then-drives (bang-bang on heading tolerance).
  Float-Knights' force-truncated model — with `MAX_FORCE` tied to the Go2
  yaw, and a pivot-in-place exception — produces smooth arcs and an
  emergent turn radius. Polish; only matters once nav matters.
- **C6. Local obstacle avoidance for `go_to_pose`. — BUILT (this pass).**
  Straight-line nav + safety slowdown means a waypoint behind furniture
  made the robot press in and stall. Added `core/avoidance.py`: a local
  **nearest-blocker tangent-steering** reflex that bends the nav heading
  around the one solid obstacle in the path corridor and recommends a
  slowdown for tight passes, with the safety guard's proximity scaling
  still underneath. Wired into `SimBridge._integrate` (flag
  `SWEETIE_NAV_AVOIDANCE`, default on). Held to the **scope caution**
  below: it is a local steering helper *under* the LLM's waypoints, not a
  planner. It reaches isolated obstacles and passable fields; it can
  stall (never collide) against a wall or in a concave pocket, where the
  LLM re-plans. 20 tests in `tools/test_avoidance.py`. (Originally a
  summed potential field — that stalled in local minima even in sparse
  fields; tangent steering replaced it.)

## What was checked and *not* pursued

Float-Knights leans on team formations, KOTH/CTF/Tag modes, projectile
dodging, and multi-agent coordination — all single-robot-irrelevant for
Sweetie. GrowBot's LED-ring expression and learned-locomotion policies
are out of scope (no LED on the Go2 path; the ROADMAP rejects custom RL
controllers since Go2 firmware ships its own). None of these are in the
backlog on purpose.
