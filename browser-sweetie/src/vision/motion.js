// Motion eyes — the zero-dependency vision organ. Frame differencing on the raw webcam pixels → "something is
// moving, and it's over THERE." No ML model, no CDN, works offline, and (crucially) pure enough to unit-test by
// feeding it synthetic frames. It gives presence + BEARING (where to look) + a rough activity magnitude — which
// is all the sensorium needs to make her notice you and turn toward you. Richer organs (BlazeFace/COCO-SSD via
// TF.js) can slot in behind the same `visibleFrom*` shape later; this is the free starting point for a C910.
//
// Honest limits: a 2-D cam has no depth, and motion ≠ distance (someone close but still barely moves). So
// `distance_m` is a ROUGH proxy and magnitude reads as ACTIVITY/salience, not range. Real distance needs
// face-size (TF.js) or a depth sensor.

const luma = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

export function makeMotionEyes({ fovDeg = 60, threshold = 20, minArea = 0.008, mirror = true } = {}) {
  let prev = null, wasPresent = false;

  return {
    // observe an ImageData-like frame { data:RGBA Uint8ClampedArray, width, height } → a detection.
    // Returns { present, bearingDeg, magnitude, cx, cy, entered }. bearingDeg: −left … +right (as the USER sees
    // it when mirror=true, matching a selfie view). `entered` = true on the frame presence first appears.
    observe(frame = {}) {
      const { data, width, height } = frame;
      const n = width * height;
      const gray = new Float32Array(n);
      for (let p = 0, i = 0; p < n; p++, i += 4) gray[p] = luma(data, i);
      if (!prev || prev.length !== n) { prev = gray; return { present: false, magnitude: 0 }; }

      let moved = 0, sx = 0, sy = 0;
      for (let p = 0; p < n; p++) {
        if (Math.abs(gray[p] - prev[p]) > threshold) { moved++; sx += p % width; sy += (p / width) | 0; }
      }
      prev = gray;
      const magnitude = moved / n;
      if (magnitude < minArea) { wasPresent = false; return { present: false, magnitude: +magnitude.toFixed(4) }; }

      let nx = (sx / moved / width) * 2 - 1;                    // −1 (left of frame) … +1 (right)
      if (mirror) nx = -nx;                                     // selfie view: what YOU see, so gaze matches
      const bearingDeg = +(nx * (fovDeg / 2)).toFixed(1);
      const entered = !wasPresent; wasPresent = true;
      return { present: true, bearingDeg, magnitude: +magnitude.toFixed(4), cx: +(sx / moved / width).toFixed(3), cy: +(sy / moved / height).toFixed(3), entered };
    },
    reset() { prev = null; wasPresent = false; },
  };
}

// Map a motion detection → the decider's `visible[]` + perception `events`. Presence = a friendly "visitor" in
// view (drives reward/attention); a first sighting emits an "entered view" event (novelty). distance is rough.
export function senseFromMotion(det, { name = "the visitor" } = {}) {
  if (!det || !det.present) return { visible: [], events: [] };
  const distance_m = +Math.max(0.6, Math.min(3, 2.4 - det.magnitude * 10)).toFixed(2); // rough: more motion ≈ nearer
  return {
    visible: [{ name, distance_m, bearing_deg: det.bearingDeg, category: "person", dynamic: true }],
    events: det.entered ? [`${name} entered view`] : [],
  };
}
