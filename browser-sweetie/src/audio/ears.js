// Ears — the PROCESSING half of "sharper hearing". The browser's WebAudio gives a running loudness (RMS 0..1);
// this turns a SUDDEN RISE into a startle event (a bang, a door slam) → a phasic input to the brain's threat/
// arousal, exactly like a real animal flinching at a noise. A separate STT stream carries WORDS (→ the prompt);
// this is for non-verbal sound. Model-free + stateful-but-tiny → deterministically testable in Node.
export function makeEars({ startleRise = 0.22, alpha = 0.25, floor = 0.06 } = {}) {
  let avg = null;
  return {
    // Feed the current loudness. Returns events for this frame (a startle if it jumped well above the ambient).
    hear(rms = 0) {
      const events = [];
      if (avg == null) avg = rms;
      if (rms > floor && rms - avg > startleRise) events.push({ kind: "startle", text: "a sudden loud sound", rms: +rms.toFixed(2) });
      avg = avg + alpha * (rms - avg);          // EWMA of the ambient level, so she habituates to steady noise
      return events;
    },
    ambient: () => +(avg ?? 0).toFixed(3),
    // A classified sound (YAMNet etc, browser) → a named event ("bark", "doorbell").
    sound: (label) => ({ kind: "sound", label, text: `heard: ${label}` }),
  };
}
