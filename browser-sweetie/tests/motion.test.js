import { describe, it, expect } from "vitest";
import { makeMotionEyes, senseFromMotion } from "../src/vision/motion.js";

// build an ImageData-like frame with an optional bright block (a "moving thing")
function frame(width, height, block = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (block) for (let y = block.y0; y < block.y1; y++) for (let x = block.x0; x < block.x1; x++) { const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = block.v ?? 220; data[i + 3] = 255; }
  return { data, width, height };
}
const W = 64, H = 48, blank = () => frame(W, H);

describe("motion eyes — presence + where to look", () => {
  it("no change between frames → nothing present", () => {
    const eyes = makeMotionEyes({ mirror: false });
    eyes.observe(blank());                         // primes prev
    expect(eyes.observe(blank()).present).toBe(false);
  });

  it("a thing appearing on the RIGHT of the frame → present, positive bearing", () => {
    const eyes = makeMotionEyes({ mirror: false, fovDeg: 60 });
    eyes.observe(blank());
    const d = eyes.observe(frame(W, H, { x0: 48, x1: 64, y0: 16, y1: 32 }));
    expect(d.present).toBe(true);
    expect(d.bearingDeg).toBeGreaterThan(0);       // right of centre
    expect(d.entered).toBe(true);                  // first sighting
  });

  it("a thing on the LEFT → negative bearing; mirror flips it (selfie view)", () => {
    const left = { x0: 0, x1: 16, y0: 16, y1: 32 };
    const raw = makeMotionEyes({ mirror: false }); raw.observe(blank());
    expect(raw.observe(frame(W, H, left)).bearingDeg).toBeLessThan(0);
    const sel = makeMotionEyes({ mirror: true }); sel.observe(blank());
    expect(sel.observe(frame(W, H, left)).bearingDeg).toBeGreaterThan(0); // mirrored → user sees it on their right
  });

  it("more motion → larger magnitude", () => {
    const small = makeMotionEyes({ mirror: false }); small.observe(blank());
    const mSmall = small.observe(frame(W, H, { x0: 30, x1: 34, y0: 22, y1: 26 })).magnitude;
    const big = makeMotionEyes({ mirror: false }); big.observe(blank());
    const mBig = big.observe(frame(W, H, { x0: 8, x1: 56, y0: 8, y1: 40 })).magnitude;
    expect(mBig).toBeGreaterThan(mSmall);
  });

  it("senseFromMotion maps a detection to the decider's visible[] + an entered event", () => {
    const s = senseFromMotion({ present: true, bearingDeg: 18, magnitude: 0.1, entered: true });
    expect(s.visible[0]).toMatchObject({ category: "person", dynamic: true, bearing_deg: 18 });
    expect(s.events).toContain("the visitor entered view");
    expect(senseFromMotion({ present: false }).visible).toEqual([]);
  });
});
