import { describe, expect, it } from "vitest";
import { angleDifferenceDeg, interpolateView } from "../src/index.js";

describe("view interpolation", () => {
  it("turns the shorter way between headings", () => {
    expect(angleDifferenceDeg(350, 10)).toBe(20);
    expect(angleDifferenceDeg(10, 350)).toBe(-20);
    expect(interpolateView({ headingDeg: 350, pitchDeg: 10, rollDeg: 4, verticalFovDeg: 60 }, { headingDeg: 10, pitchDeg: 0, rollDeg: 0, verticalFovDeg: 60 }, 0.5))
      .toEqual({ headingDeg: 0, pitchDeg: 5, rollDeg: 2, verticalFovDeg: 60 });
  });
});
