# Goalpost — what we're actually building

*A north-star note for the Sweetie-bot / Harmony Hollow work. Vision, not spec — the build state lives in
`docs/RESEARCH-NOTES.md` and the auto-memory. Written 2026-07-04.*

## The shift

Early on we worked **inside the mind**: spiking neurons, the 4-chemical neuromodulation field, memory
records, personality setpoints. Working *on the organs*.

Somewhere we stopped doing that and started building **the world the mind lives in, and the seams that let a
mind be moved, copied, kept, and networked.** That change of altitude is the point of this note.

## The four seams we've actually been cutting

- **Portability** — the decider → `/decide` sidecar → the `frame ↔ Go2 driver` contract. The mind is now a
  *service*; the body is just a driver you swap (sim ↔ webcam face ↔ a real Go2). The cognition neither knows
  nor cares what it's wearing.
- **Persistence** — psyche + memory snapshots to IndexedDB. A *continuous self*: it remembers you between
  sessions, carries a grudge across a reload, misses you when you're gone. Not a chatbot that resets — an
  entity with a history.
- **Multiplicity** — the colony. From "a mind" to "many minds in a shared world," the same substrate instanced
  N times.
- **Culture** — gossip → reputation → language evolution. Emergent stuff that lives **between** minds, not in
  any one of them.

## What we're pre-wiring for

**A substrate-independent, persistent, social being — and the platform that hosts it.**

- Sweetie-on-a-Go2 is the first *tenant*.
- Harmony Hollow is the multi-agent *civilization* instance of the same kernel.
- The `frame ↔ driver` contract is the *constitution* — the fixed interface everything plugs into.

We're not building "a robot" or "a chatbot" anymore. We're building the **layer any embodied, remembering,
socializing companion plugs into.** A persona OS with a civilization mode.

## The tell

The tell is what the thing *did without being told to*:

- it **invented a word** and spread it into common usage;
- it **held a grudge** for days and acted on it, unprompted;
- it **got lonely** and said so.

Those aren't features — they're **personhood and civilization primitives**. When the feature list starts
reading like anthropology, you've changed altitude.

## The horizon (where it points if we keep extrapolating)

1. **The body dissolves into a driver.** Sim, webcam, Go2, screen-face — all interchangeable behind the contract.
2. **The self becomes the durable artifact.** Memory + psyche is the crown jewel; everything else is replaceable.
   Protect continuity of self above all.
3. **Culture feeds back into the minds.** A bot "raised" in the town inherits its dialect, its myths, its
   reputations — then reshapes them. *Culture shaping the individuals who reshape the culture* is the real
   frontier, and we're one or two modules from it (shared history/myth, roles, a "growing up" path for a new bot).

## Guardrail

This is **functional, not a claim of sentience** — simulated affect, simulated society. But the *architecture*
is real and genuinely general. We didn't set out to build a platform; we built one anyway, because
"give it a real inner life" forced every one of those seams.

## The one-liner

> We stopped programming a mind and started incubating a persistent, portable, cultured self —
> **Sweetie is the first citizen, the colony is the civilization, and the contract is the constitution.**

---

### Anchor artifacts (the seams, in code)

| Seam | Where it lives |
|---|---|
| Portable cognition | `src/decider.js`, `harness/sidecar.mjs` |
| Body-as-driver contract | `src/go2/driver.js`, `src/go2/companion.js`, `docs/GO2-CONTRACT.md` |
| Continuity of self | `src/agents/psyche.js`, `src/memoryGate.js`, `src/face/soul.js` (IndexedDB persistence) |
| Society of minds | `src/agents/colonyApp.js` + colony/gossip/booth/megaphone/charger/watch |
| Emergent culture | `src/agents/rumors.js` (reputation + dictionary), `src/agents/language.js` (word-game) |
| Self-generated goals | `src/agents/volition.js` |

---

## Addendum — the load-bearing gap (2026-07-04)

Of the four seams, three are already **bidirectional**: portability (mind→body *and* body→mind via the frame),
persistence (write *and* restore), multiplicity (N minds that actually interact). **Culture is the one that's
still one-directional.** It emerges *from* minds — gossip → reputation → a coined word entering the language —
but nothing yet flows *back into a mind's formation*. A civilization isn't culture that merely exists; it's
culture that **raises its members**. Right now a bot added to the town starts **blank**: it doesn't speak the
dialect, doesn't know the reputations, carries none of the town's myths. It learns them slowly by exposure, but
it isn't *enculturated*.

So horizon #3 isn't "one or two modules away" as a nice-to-have — it's the **missing return path** that turns
"a society of minds" into "a civilization." The two modules that close it:

1. **A Chronicle (shared history / myth).** The town remembers its own salient events as transmissible lore — the
   great festival schism, the word that swept through, the legendary grudge, who the megaphone rallied. Today
   those events happen and scroll off the log; nothing crystallizes them into shared memory. Raw material already
   exists in `rumors.js` (reputation), `society.js` (polarization/consensus history), `language.js` (adopted
   words) — what's missing is the aggregator that turns events into *lore*.
2. **An enculturation / "growing up" path.** A newcomer inherits the current official lexicon, the standing
   reputations, and a digest of the Chronicle — it arrives already fluent, then reshapes what it inherited. This
   is the feedback arrow: the culture shapes the individual who then reshapes the culture.

Build these and the "civilization" claim stops being aspirational. Everything upstream (gossip, society,
language, reputation) already produces the inputs; these two modules are the consumer that was never wired.

### Status: the return arrow is wired (2026-07-04)

- **Chronicle built** (`src/agents/chronicle.js`) — the town edge-detects its own schisms/healings and crystallizes
  word-adoptions & rallies into bounded, weighted **lore**; a `digest()` is the headline legends. Verified live: an
  8000-tick run recorded *"the town split over the Summer Festival"* then *"the town came back together"* — the town
  remembering its own history. Surfaced in the 📜 "Town's Story" panel.
- **Enculturation built** (`colonyApp.induct(name)`) — a newcomer inherits the official lexicon, the lore digest, the
  standing reputations, and a lean toward the town's consensus, then is free to reshape it.
- **The new shell: an ablation harness** (`tests/enculturation.test.js`). The platform claim "culture raises its
  members" is *relational* — no unit test can hold it. The proof is a **differential**: raise one bot (induct) and
  leave an identical one blank, then measure that the raised one speaks the dialect, knows the reputations, and leans
  to the town's view while the blank one holds none of it. It does. Culture-feedback is now *falsifiable*, not asserted.

**The hermit-crab molt this implies:** unit tests (mechanics) + heap profiling (bounded) were the old shell; the
platform-level claims need a **differential/observatory** shell — ablations (enculturated vs blank), and eventually
longitudinal civilization metrics (dialect drift, myth persistence, reputation stability over long runs). The
ablation test is the first cell of that new shell.

### The persistence molt — culture now survives, not just selves (2026-07-04)

The persistence seam is extended from the individual (psyches) to the **civilization**. Each cultural module got
`snapshot()`/`restore()` (`society` opinions, `gossip` beliefs, `rumors` lexicon, `chronicle` history), composed by
`colonyApp.snapshotCulture()`/`restoreCulture()`. The browser now: restores culture on boot from IndexedDB
(`harmony-culture`), **carries it in-memory across every `rebuild()`** (so changing a setting no longer wipes the
town), and saves it periodically. **Verified live:** a forced rebuild left the lexicon (36 words), the lore (2
legends), and every opinion *byte-identical*; and a newly-added bot ("Pebble") was **inducted into the live
restored culture** — it arrived knowing the town's two legends, four reputations, and its consensus lean.

So the loop is closed: culture emerges → crystallizes into lore → **persists** → **raises the next citizen**. The
town, not just its citizens, now has continuity.

### The observatory shell — measuring civilization (2026-07-04)

`src/agents/observatory.js` + `harness/observatory.mjs` are the second cell of the new shell: a longitudinal
instrument (dialect churn, myth persistence, how-split-over-time, and the goalpost metric — *inheritability*) plus
a runnable "civilization run" that prints the report and a closing raised-vs-blank ablation. It immediately earned
its keep the way the nav harness did — **measure → diagnose → fix → re-measure**: the first run showed the dialect
churned at **8.7 words/round with 0 ever canonizing** (words culled on a fixed timer before they could spread), so
we made a catching-on word reset its stall clock (momentum ≠ stalled) — and re-measured **0 → 12 → 40 official
words**, richer lore, and newcomers now inheriting *vocabulary*, not just stories. That's the shell doing what unit
tests structurally cannot: surfacing an emergent property and driving a design fix.

**The civilization is now legibly deep:** a live town (culture persisted across sessions) reports 40 official
words, 16 legends, and 72 inheritable cultural units — an *old* town a newcomer is measurably raised by. Remaining
observatory cells: reputation-stability metrics, and a proper time-series export for offline analysis.
