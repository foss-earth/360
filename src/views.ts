import type { ViewerLook } from "./ports.js";
/** Original shortest geographic-heading interpolation, independent of a globe. */
export function angleDifferenceDeg(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}
export function interpolateView(from: ViewerLook, to: ViewerLook, t: number): ViewerLook {
  const lerp = (a: number, b: number): number => a + (b - a) * t;
  return {
    headingDeg: (((from.headingDeg + angleDifferenceDeg(from.headingDeg, to.headingDeg) * t) % 360) + 360) % 360,
    pitchDeg: lerp(from.pitchDeg, to.pitchDeg), rollDeg: lerp(from.rollDeg, to.rollDeg),
    verticalFovDeg: lerp(from.verticalFovDeg, to.verticalFovDeg),
  };
}
