# Mining notes — "Robot Dogs Are A Security Nightmare"

Source: a security-focused teardown of consumer Unitree Go2 robot dogs (Sweetie's target
hardware). The video's value here is **defensive**: it shows how these systems fail, which
tells us what to design *for*. Notes below are framed as requirements/principles — no attack
recipes.

## The failures it shows (and the principle each implies)

1. **"I talked the dog into disabling its safety mechanisms"** (its ChatGPT chat-mode could be
   socially-engineered into turning off collision safety and leaking config).
   -> **Safety is a hard gate BELOW cognition.** The LLM/chat must never be able to disable or
   weaken safety, no matter what it's told — by the user, by injected text, or by its own
   reasoning. Safety limits are fixed; "disable safety" is not a capability that exists.

2. **LiDAR mounted on the head -> large rear blind spot; in avoidance mode it backs into
   whatever's behind it** ("a chicken or a little kid... injure it or worse").
   -> **Treat unsensed space as occupied.** Cap speed when moving toward blind zones; never
   execute a fast motion into space you can't sense.

3. **Overreacts, "fails very dramatically," can't hold a safety command >15s, modes conflict.**
   -> **Conservative, stable safety** with proximity-scaled speed and extra clearance for living
   things; degrade gracefully, don't thrash.

4. **Backdoor phoning home (sandbox-detecting, hiding its traffic); audio/video can be pulled;
   month-long activity logs exist on comparable surveillance gear.**
   -> **Local-first, minimal egress, no covert capture.** A home companion that remembers people
   is a privacy liability; data must stay on-device, be user-inspectable/exportable/erasable,
   and the only egress (the LLM call) must be explicit.

5. **The human-operated contrast ("Undaunted": no LiDAR, no persistent logging) is judged
   *better for residents*.**
   -> Autonomy and data-hoarding aren't free goods; **human override and data minimization** are
   features, not regressions.

## Implemented this pass (Perchance PoC)

- **Non-bypassable SafetyGuard.** A hard layer below cognition with FIXED limits no tool, chat
  message, or memory can change. It scales speed by proximity to the nearest thing, gives
  **living things (you, the pet) extra clearance**, hard-stops inside a minimum distance, and
  **caps speed when the nearest hazard is in the rear blind zone** (outside her forward FOV) —
  the LiDAR-blind-spot lesson. Gates every motion in the drive loop. (capFor/safetyScale
  verified.)
- **Injection-resistant dispatch.** Only whitelisted tools execute; any command that tries to
  disable/override/bypass safety (from the model, the user, or memory) is **refused, counted,
  and never executed** — she says "my safety stays on." Unknown tools are dropped and counted.
  Her persona also states safety is a hard layer she cannot turn off. (safeTool verified.)
- **Privacy controls.** Memory is local-only; a Safety & privacy card states it plainly ("no
  recording, nothing sent except your words to the AI"), with **Export** (download your data)
  and **Wipe** buttons, plus a **"forget that ..."** / **"forget everything"** chat command.
  (forgetFact verified.)
- **Safety/privacy HUD.** Live guard state (clear / slowing / blind-slow / STOP), blocked-command
  count, and the local-only / no-A/V indicators.

## Deferred (S-series backlog)

- **S1 Failsafe on anomaly.** On sensor loss, mode conflict, or anomalous control input, default
  to a controlled stop (not collapse, not thrash). Sim: stop + flag when safetyScale conflicts
  with the planner repeatedly.
- **S2 Sensor-coverage model.** Represent the real Go2's FOV/occlusion explicitly and plan to
  keep hazards in view (turn-to-look before moving into blind space).
- **S3 Human-in-the-loop for consequential actions.** A confirm/override gate for anything
  high-stakes; instant physical stop always available (sim has Stop + a hard guard).
- **S4 Egress allowlist + transparency.** Cognition seam exposes the single LLM egress; surface
  exactly what leaves the device and when; support a fully **local/offline model backend** so
  the companion can run with zero cloud egress (privacy + the no-backdoor principle).
- **S5 Network isolation.** No auto-trust of nearby devices; no self-propagation surface; treat
  the robot as untrusted on the LAN by default.
- **S6 Data minimization + retention.** Store the least memory needed; age out episodes; never
  persist raw audio/video; per-entity consent for remembering other people.

## IRL Go2 mapping (defensive posture)

- **Supply-chain / firmware caution.** The documented Go2 backdoor (publicly tracked for ~a year)
  means treat stock firmware/networking as untrusted: run Sweetie's stack on a **separate
  compute module**, keep the robot on an **isolated VLAN**, **block/audit egress** at the router,
  and prefer a **local model** so core behavior needs no cloud.
- **Safety in hardware/low-level, not the LLM.** The collision/contact/E-stop layer lives in the
  fast control loop and firmware-adjacent code; the LLM only *proposes* goals the guard may
  veto. This is exactly the PoC's "LLM proposes, SafetyGuard disposes."
- **Physical failsafe.** Define controlled-stop behavior for power/comms loss and an accessible
  E-stop; don't rely on vendor "safety modes" that the video shows are fragile.
- **Privacy by construction.** No persistent A/V; on-device memory the owner can export/wipe;
  explicit, minimal egress. A companion is trusted inside the home precisely because it is not a
  surveillance device.

The throughline with the GrowBot notes: the LLM is the slow planner and personality, but the
parts that keep people safe and private — the fast reflex/guard and the data boundary — must NOT
be things the language layer can talk its way past.
