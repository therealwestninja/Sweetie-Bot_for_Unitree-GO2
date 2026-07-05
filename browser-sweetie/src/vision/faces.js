// Face perception — the PROCESSING half of "sharper eyes". A face detector (BlazeFace / face-api.js in the
// browser, loaded from a CDN) gives boxes + expression scores; these pure functions turn that into the frame
// the decider eats and into an affect signal the soul can MIRROR. Kept model-free so it's deterministically
// testable in Node — the browser just feeds real detector output through the same two functions.
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// faces = [{ cx, cy, w, h }] with cx,cy,w,h NORMALISED to [0,1] (center + size in the frame). Bigger face =
// closer (rough monocular distance). The nearest is "the visitor" (you); the rest are "a person". bearing is
// the horizontal angle off-centre given the camera's FOV (~60° for a Logitech C910).
export function facesToVisible(faces = [], { fovDeg = 60, distK = 0.35, primaryName = "the visitor" } = {}) {
  return faces
    .map((f) => ({ bearing_deg: +(((f.cx ?? 0.5) - 0.5) * fovDeg).toFixed(1), distance_m: +clamp(distK / Math.max(f.h ?? 0.15, 0.02), 0.4, 6).toFixed(2) }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .map((v, i) => ({ name: i === 0 ? primaryName : "a person", distance_m: v.distance_m, bearing_deg: v.bearing_deg, category: "person", dynamic: true }));
}

// Expression scores (face-api gives { happy, sad, angry, surprised, neutral, fearful, disgusted }) → a
// PAD-ish affect. valence: happy lifts, sad/angry/fear/disgust sink; arousal: surprise/anger/fear raise, neutral
// lowers. The soul mirrors this (dampened) so YOUR mood colours hers — you smile, she brightens; you look upset,
// she goes quiet and concerned (concern, not resentment — the mirror shifts her MOOD, never her feeling for you).
export function emotionToAffect(expr = {}) {
  const g = (k) => expr[k] || 0;
  const valence = clamp(g("happy") - g("sad") - 0.8 * g("angry") - 0.7 * g("fearful") - 0.5 * g("disgusted") + 0.1 * g("surprised"), -1, 1);
  const arousal = clamp(g("surprised") + g("angry") + g("fearful") + 0.4 * g("happy") - 0.5 * g("neutral"), 0, 1);
  const entries = Object.entries(expr);
  const label = entries.length ? entries.sort((a, b) => b[1] - a[1])[0][0] : "neutral";
  return { valence: +valence.toFixed(2), arousal: +arousal.toFixed(2), label };
}
