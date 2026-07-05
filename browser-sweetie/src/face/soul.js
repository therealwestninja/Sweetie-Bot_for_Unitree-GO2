// Soul — the inner life for the WEBCAM companion (one Sweetie, real perception). It wraps the bodyless decider
// (immediate reflex arc + drive → her expression this instant) with a PERSISTENT psyche + memory, plus the one
// relationship that matters here: how she feels about "you", the person the camera sees. So she's not a mirror
// that reacts and forgets — she accrues a mood, remembers you across sessions, gets lonely when you leave and
// does something about it, and greets you by how she's come to feel about you. The colony's psyche/volition,
// aimed at a single companion who can actually see the room.
//
// `decider` is injected (the real makeDecider on the page; a mock in tests). Persistence is snapshot/restore
// of the psyche; the memory gate persists itself through its own (IndexedDB) store.

export function makeSoul({ decider, psyche, memory = null, config = {} } = {}) {
  const C = { warmEvery: 25, seeWarmth: 0.12, lonelyAfter: 120, lonelyEvery: 120, ...config }; // ticks (~10/s)
  let present = false, seenTicks = 0, awayTicks = 0, lastDrive = {};
  const YOU = "you";

  return {
    psyche, memory,

    // One perception tick. `frame` = the decider frame built from the camera; `det` = the motion detection
    // (present, bearingDeg). Returns what the face needs to render + say this frame.
    async tick(frame = {}, det = {}) {
      const nowPresent = !!det.present;
      let line = null, kind = null;

      if (nowPresent && !present) {                              // you just appeared
        const warm = psyche.feabout(YOU), missed = awayTicks > C.lonelyAfter;
        psyche.experience({ who: YOU, valence: 0.25 + (missed ? 0.3 : 0), arousal: 0.5, kind: "reunion" });
        line = missed ? (warm > 0.15 ? "*lights up* — you're back! I missed you." : "oh — you're back.") : null;
        kind = "greet"; awayTicks = 0;
      }
      if (nowPresent) { seenTicks++; awayTicks = 0; if (seenTicks % C.warmEvery === 0) psyche.experience({ who: YOU, valence: C.seeWarmth, arousal: 0.3, kind: "company" }); }
      else { seenTicks = 0; awayTicks++; if (awayTicks === C.lonelyAfter || (awayTicks > C.lonelyAfter && awayTicks % C.lonelyEvery === 0)) { psyche.experience({ valence: -0.15, arousal: 0.2, kind: "lonely" }); line = "*sighs, watching the door*"; kind = "lonely"; } }
      // MIRROR your mood: your read emotion shifts HER mood (who omitted → no feeling change; concern, not blame)
      if (det.yourAffect) psyche.experience({ valence: 0.4 * det.yourAffect.valence, arousal: 0.3 + 0.4 * det.yourAffect.arousal, kind: "empathy" });
      present = nowPresent;
      psyche.tick();

      const dec = await decider.decide(frame);                  // immediate reflex arc + drive (for expression)
      lastDrive = dec.drive || {};
      if (!line && dec.speech && dec.arc !== "QUIET") { line = dec.speech; kind = dec.arc.toLowerCase(); }
      return { arc: dec.arc, drive: lastDrive, mood: psyche.mood(), line, kind, present: nowPresent, bearing: det.bearingDeg || 0 };
    },

    // You spoke to her. She warms, recalls what she knows, replies (via the decider's mouth), and files any
    // remember(…) as a pending memory about you.
    async converse(prompt, frame = {}) {
      psyche.experience({ who: YOU, valence: 0.22, arousal: 0.45, kind: "talked" });
      const dec = await decider.decide(frame, { prompt });
      return { speech: dec.speech, intents: dec.intents, proposed: dec.proposed, mood: psyche.mood() };
    },

    mood: () => psyche.mood(),
    feelAboutYou: () => +psyche.feabout(YOU).toFixed(2),
    // persistence: the relationship IS the durable self → survives a reload ("she remembers you")
    snapshot: () => ({ psyche: psyche.snapshot() }),
    restore: (s) => { if (s && s.psyche) psyche.restore(s.psyche); },
    state: () => ({ present, awayTicks, mood: psyche.mood(), feelAboutYou: +psyche.feabout(YOU).toFixed(2), grudges: psyche.grudges() }),
  };
}
