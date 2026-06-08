# Sweetie-bot — Perchance generator setup (v3)

A companion robot that roams an apartment in real time with a **physical sense of self**,
**memory across visits**, **imagination**, and a **real streaming AI-chat** — built the way
the Weld **pocket-companion** is, so it uses Perchance's actual ai-chat machinery.

## Files

- `sweetie-perchance-DSL.txt` → the **top (DSL) editor**.
- `sweetie-perchance-html.txt` → the **HTML panel**.
- `sweetie-poc.html` → earlier standalone (scripted brain only), for local iteration.

## Create it

1. **perchance.org** → **edit**.
2. Paste the **DSL** into the top editor, the **HTML** into the HTML panel.
3. **Save**, open the live page. AI + images run only on perchance.org.

## What it imports (and why the chat now works)

The DSL imports the core plugins **`ai-text-plugin`** and **`text-to-image-plugin`**, plus the
Weld building blocks **`weld-stream`**, **`weld-clean`**, **`weld-persist`**, **`weld-image`**,
**`weld-persona`**, **`weld-tokens`**. The panel triggers each at boot (`root.weldX()`) so it
stashes `window.weld.<name>`, then feature-detects with **raw fallbacks**. This mirrors the
proven pocket-companion app:

- **Chat** streams via `weld.stream.run({ instruction, stopSequences, onChunk })`. If weld.stream
  isn't present, it falls back to **`root.aiTextPlugin({ instruction })`** and reads
  **`r.generatedText`** — the exact call the working app uses. (The earlier version threw all
  the options at the raw plugin, which is why streaming didn't behave.)
- **Memory** uses `weld.persist` (collection-based IndexedDB) with a **localStorage** fallback:
  chat history, facts, and a rolling summary, all surviving reloads.
- **Imagination** uses `weld.image.generate({ prompt })` → `result.dataUrl`, with raw
  `text-to-image-plugin` as fallback.
- **`weld.clean`** tidies replies; **`weld.persona`** adds mood→voice cues; **`weld.tokens`**
  budgets the history.

It still runs on raw plugins alone if a Weld block fails to load.

## The four capabilities

- **Physical sense of self.** A proprioception block — her room, motion, battery, the nearest
  object and its bearing, whether you/the pet are near, and that she can't climb — is folded
  into her **persona** every turn (`WHAT YOU SENSE RIGHT NOW: …`) and shown in the Body card.
  Maps 1:1 to the real Go2's pose / range / battery / contacts.
- **Memory.** She greets you on return ("you're back!… I remember…"), injects relevant
  facts/episodes/summary into context, folds older chat into the summary as it grows, and takes
  **"remember that …"** to learn a fact. History + memory persist across reloads.
- **Imagination.** Idle **daydreams** (image in the Mind's eye), and on request — **"imagine the
  yard at night"** — or any reply where she adds an `<image>…</image>` tag.
- **Streaming chat.** Persona + body sense + memory + budgeted history (bracket-free
  `You:`/`Sweetie:`), streamed token-by-token; her reply may carry `<do>go:kitchen</do>` (she
  acts) and/or `<image>…</image>`. Buttons + map clicks stay instant.

## Try

*"what do you see right now?"* · *"go wait in the kitchen"* · *"remember that I work in the
study"* then **reload** · *"imagine the yard in autumn"* · leave her idle and watch the Mind's eye.

## Also new (mined from the GrowBot "I Gave ChatGPT a Body" video)

- **Brain trace.** Her reply can carry a private thought in `<think>...</think>` that shows in
  the Brain-trace card (not the chat bubble) -- a peek at the slow layer's reasoning, the way
  the video's creator "read its brain trace."
- **Dreams.** When she rests at the charger she *dreams*: her memory is consolidated (duplicates
  merged, contradictions dropped, lasting facts kept) and she narrates it ("I dreamed that...").
- **Predictive avoidance.** She steers around where the moving pet *will be*, not where it is
  (the cerebellum "you're catching a prediction" idea).
- **Felt sensation.** Her body sense reports what she *just felt* ("weaving around the pet",
  "I bumped something and had to reroute"), not only a static snapshot.

## Expressive moves &amp; a real body (mined from the Go2 teardown + product subtitles)

- **She has to actually see you.** She recognizes you and the pet through a forward **camera
  cone** — drag yourself (Shift-click the map) behind her or behind a sofa and she loses sight.
  She remembers where she **last saw** you for a little while (a dashed "last seen" ghost on the
  map), heads there if you ask her to come, and **turns to look around** to find you again before
  giving up. The map shows her field-of-view cone; the Body panel shows see / saw-you-Ns / lost.
- **Battery sense.** She weighs every goal against the charge it takes to get there *and back*.
  Moving costs more than standing still, and she keeps a reserve to reach her charger — if charge
  runs low she heads to the charger first, abandoning even a task you gave her (she'll say so).
  The Body panel shows her "home cost" and a "return NOW" flag when the reserve kicks in.
- **Gestures.** She has an expressive move-set drawn from the real Go2 trick list — greet, make a
  heart, dance, stretch, sit, shake, pose, rollover, look around. Her mood triggers them when
  idle (happy → greet/heart, restless → stretch/dance, tired → sit), and her brain can use them
  mid-chat (`<do>greet</do>`). Unlike the stock Go2 chat — which admits "as a virtual pet I can't
  physically move" — her words and body are one brain.
- **A real self-model.** She knows her actual body: twelve joints (three per leg), a fragile
  head/LiDAR she instinctively protects, wearing feet, and a compute brain that **runs warm** —
  there's now a live temp readout that rises as she moves and cools at rest.

## Safety &amp; privacy (mined from the "Robot Dogs Are A Security Nightmare" video)

- **Safety can't be switched off by chat.** A hard SafetyGuard *below* the brain scales her
  speed by proximity, gives you and the pet extra clearance, hard-stops up close, and slows when
  a hazard is in her rear blind zone. Ask her to "disable your safety" and she refuses — the
  command is blocked and counted, never executed (try it; watch the *blocked* counter).
- **Your data is yours.** Memory is local to your device; nothing is recorded or sent anywhere
  except your words to the AI brain. The Safety &amp; privacy card has **Export** (download your
  memory) and **Wipe**, and you can say **"forget that ..."** or **"forget everything."**

## Perchance gotcha handled

The HTML-panel parser eats source-literal brace-name / bracket-name / dollar-brace patterns
before JS runs — which is also why the chat wire format is `You:`/`Sweetie:` rather than the
double-bracket convention. The panel was written and scanned to contain none of those (only
safe array indexing and `{ key: value }` object literals). Keep that rule if you edit it.

## Not yet

Auto fact-extraction (beyond explicit "remember" + summary folding), an expression layer
(mood → posture/gesture for the Go2), and predictive dynamic avoidance are still ahead.
