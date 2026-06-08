# Mining notes — "I Gave ChatGPT a Body" (GrowBot video)

Source: creator's narration of building GrowBot (the $100 RL-on-chip + LLM-brain robot whose
codebase is one of our sibling uploads). Below: what we lifted into Sweetie this pass, what's
queued, and the deep architecture the video argues for.

## Implemented this pass (Perchance PoC)

1. **Brain trace (inner voice).** The video opens with the creator reading the robot's *brain
   trace* — "it was wondering when I would be back because it didn't want to be alone."
   Sweetie's brain now emits an optional private thought in `<think>...</think>` separate from
   her spoken reply; it shows in a Brain-trace card and the event log, never in the bubble.
   Gives the same "there's someone in there" effect, and is honest about the slow layer's
   reasoning. (parseReply extracts it; verified.)

2. **Dream consolidation at the charger.** The video's "dreams": occasionally send *all* of
   memory to the smartest model, have it dedupe/resolve contradictions and extract lessons,
   then narrate ("I dreamed that a clumsy giant petted me into blissful purring..."). When
   Sweetie reaches the charger to rest, `dreamConsolidate()` folds her facts + episodes into a
   cleaner fact set and voices a one-line dream. This is the video's "self-improvement at the
   highest abstraction level: language" — refining memory and personality while idle. The
   GrowBot creator used Claude Sonnet for this specific call (tiny models missed subtleties);
   noted for the IRL tiered-model plan below. (parseDream verified.)

3. **Predictive (velocity-lead) dynamic avoidance.** The deepest thread: smooth action despite
   slow thinking requires a *fast physical imagination* — the cerebellum predicts ~0.1s ahead
   and aims at the predicted position ("when you catch a ball, you're catching a prediction").
   Sweetie now tracks the pet's velocity and steers around where it *will be* (`predictPos`,
   lead 0.5s), not where it is. Verified: avoidance heading shifts for a moving obstacle and is
   unchanged for a still one. This is the M-PoC-3 predictive-avoidance item, motivated directly
   by the video.

4. **Felt sensation in body sense.** The video fed the raw IMU stream to the LLM and it
   described what it *feels* ("being gently rocked like a baby"; "I feel contact on my right
   side"). Sweetie's proprioception now surfaces recent *events* ("just now I felt weaving
   around the pet"; "I bumped something and had to find another way"), not just a static
   snapshot — a step toward narrating a short sensor *history* rather than one frame.

## Deep architecture the video argues for (our north star)

- **System 1 / System 2 (Kahneman).** Fast unconscious motor layer (RL policy at ~50 Hz) +
  slow LLM "prefrontal" reasoner. Sweetie already splits reflex (local avoidance + drive loop)
  from planner (LLM); the video confirms this is the architecture nature lands on.
- **Action chunks cover the latency.** The motor cortex emits a *chunk* of action long enough
  to bridge the sensorimotor delay, aimed at an imagined future; when prediction matches
  reality it's smooth, on mismatch you "start to think." Sweetie's LLM emits goals (chunks) the
  reflex layer runs while the next call is in flight; mismatch (stall / unexpected block) should
  escalate back to the planner. Backlog: make the mismatch->rethink trigger explicit.
- **Predict next *states*, not just next action (Daydreamer 2022).** Forcing a net to predict
  the next states makes it absorb physics/objects/momentum. Sim analogue = the predictive
  avoidance above + earlier collision-lookahead replanning.
- **The converging architecture.** One shared encoder of all senses -> a latent thought ->
  branches into (a) fast mini-nets predicting immediate actions+states and (b) a slow looped
  reasoner; prediction error from the fast branch trains the whole stack. This is the IRL
  target for the Go2 cognition stack; the LLM-as-planner stays, with a learned fast layer under
  it (we currently hand-code that fast layer).

## Queued ideas (backlog tags)

- **G1 Per-entity memory profiles.** GrowBot kept a memory *area per person/thing* ("an area
  for me as well as other people"). Upgrade flat facts -> profiles keyed by entity (you, the
  pet, each room); inject the relevant profile. Dream consolidation should sort facts by
  subject. (Extends A1 tracked-entity memory.)
- **G2 Expression layer / "Disney mode."** Same thought, different *delivery* per emotional
  state (regular / loving / anger / purring), and animation-principle timing where motions,
  words, sounds and the light ring overlap like a character. Sweetie's mood already colors
  voice; add mood -> posture/gesture + (IRL) light-ring/pose, and coordinated timing.
- **G3 Tiered models in the cognition seam.** Fast cheap model for per-turn chat/decisions
  (video: Gemini Flash ~1s, ~100x cheaper than Opus), smart model for the periodic dream
  consolidation (video: Claude Sonnet). On Perchance there's one model, but the seam should
  expose a `fastBackend` vs `deepBackend` so the IRL build maps cleanly.
- **G4 Skill / strategy memory.** "Took a while to learn to tip over, but once learned, did it
  right away." Remember *which approach worked* for a task and reuse it; the language-level
  half of self-improvement. (Pairs with the IRL cerebellum's weight-level half.)
- **G5 Reinforcement from touch/feedback.** Petting = "good boy" shaped behavior. Sweetie bumps
  bond on praise; extend so praise/scolding writes a durable preference fact that biases future
  choices.
- **G6 Richer sensor-stream feeling.** Feed a short rolling *history* of body states (not just
  the latest) so she can describe motion arcs the way the video's robot did.

## IRL Go2 mapping

- Brain trace -> the LLM's logged reasoning channel (already how we'd debug the planner).
- Dreams -> overnight/idle batch consolidation on the smart model; cheap because infrequent.
- Predictive avoidance -> fuse range + tracked-object velocity; aim foot placement / yaw at the
  predicted obstacle state. The video's whole point: the Go2-class gap is the *fast physical
  imagination* (both halves of the cerebellum), which is learned from real experience and can't
  be reached by language alone — so the hand-coded reflex layer is a stand-in until a learned
  world-model fast layer replaces it.
- Feasibility: the video's napkin math ($15 chip, $5 camera, sub-$10 IMU, ~$100 total) confirms
  the compute for a generally-intelligent small robot is already commodity; the Go2 is the
  pre-built version of the same stack.
