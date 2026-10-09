/** Orb/window and viewer rays only; no geographical conversion. */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "@foss-earth/images";
const RAD_TO_DEG = 180 / Math.PI;
// ─── Window mapping ────────────────────────────────────────────────────

/** Camera to displayed marker, the quantities every mapping and test shares. */
export interface OrbGeometry {
  /** Unit axis from the camera to the marker centre; null inside the sphere. */
  axis: Vec3 | null;
  distance: number;
  radius: number;
  /** asin(R/d), or π/2 at or inside the surface. */
  alpha: number;
  inside: boolean;
}

export function orbGeometry(cameraToMarker: Vec3, radius: number): OrbGeometry {
  const distance = length(cameraToMarker);
  if (distance <= radius) return { axis: distance > 0 ? scale(cameraToMarker, 1 / distance) : null, distance, radius, alpha: Math.PI / 2, inside: true };
  return { axis: scale(cameraToMarker, 1 / distance), distance, radius, alpha: Math.asin(radius / distance), inside: false };
}

/**
 * The flat (rectilinear) window: which world direction a covered view ray
 * shows. Identity inside the sphere and once α ≥ βR; otherwise
 * D ∝ a + (tan βR / tan α)(v − (a·v)a)/(a·v), which is
 * θ = atan(tan δ tan βR / tan α) written without angles. Null for a ray the
 * orb does not cover.
 */
export function flatWindowDirection(geometry: OrbGeometry, ray: Vec3, previewHalfAngleRad: number): Vec3 | null {
  if (!(previewHalfAngleRad > 0 && previewHalfAngleRad < Math.PI / 2)) throw new RangeError("the flat window's half angle must be in (0, 90) degrees");
  const v = normalize(ray);
  if (geometry.inside && geometry.distance < geometry.radius) return v;
  const a = geometry.axis!;
  const c = dot(a, v);
  if (geometry.inside) return c >= 0 ? v : null;
  if (c < Math.cos(geometry.alpha) - 1e-12) return null;
  if (geometry.alpha >= previewHalfAngleRad) return v;
  const k = sub(v, scale(a, c));
  if (length(k) < 1e-15) return a;
  const gain = Math.tan(previewHalfAngleRad) / Math.tan(geometry.alpha);
  return normalize(add(a, scale(k, gain / c)));
}

/** The reference's angular form of the same window, kept to cross-check the vector form. */
export function flatWindowTheta(delta: number, alpha: number, previewHalfAngleRad: number): number {
  if (alpha >= previewHalfAngleRad) return delta;
  const rho = Math.min(1, Math.max(0, Math.sin(delta) * Math.cos(alpha) / (Math.cos(delta) * Math.sin(alpha))));
  return Math.atan2(rho * Math.sin(previewHalfAngleRad), Math.cos(previewHalfAngleRad));
}

/**
 * The continuous fisheye-to-flat blend (§3). Part of the contract; the
 * fisheye appearance itself is a stage 3 renderer alternative.
 */
export function blendedWindowTheta(delta: number, alpha: number, options: {
  previewHalfAngleRad: number; fisheyeHalfAngleRad: number; blendStartRad: number; blendEndRad: number;
}): number {
  const { previewHalfAngleRad: betaR, fisheyeHalfAngleRad: betaF, blendStartRad, blendEndRad } = options;
  if (!(blendStartRad > 0 && blendStartRad < blendEndRad && blendEndRad <= betaR && betaF > 0 && betaF <= Math.PI / 2)) {
    throw new RangeError("blend needs 0 < start < end <= flat half angle and 0 < fisheye half angle <= 90 degrees");
  }
  const q = Math.min(1, Math.max(0, (alpha - blendStartRad) / (blendEndRad - blendStartRad)));
  const weight = q * q * (3 - 2 * q);
  if (weight === 1 && alpha >= betaR) return delta;
  const flat = flatWindowTheta(delta, alpha, betaR);
  if (weight === 1) return flat;
  const rho = Math.min(1, Math.max(0, Math.sin(delta) * Math.cos(alpha) / (Math.cos(delta) * Math.sin(alpha))));
  const fisheye = Math.asin(Math.min(1, rho * Math.sin(betaF)));
  return (1 - weight) * fisheye + weight * flat;
}

// ─── Views, coverage and handoff ───────────────────────────────────────

/** A perspective view: orthonormal forward, right and up, vertical FOV and aspect (width / height). */
export interface ViewBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  verticalFovRad: number;
  aspect: number;
}

/** The ray through normalized viewport coordinates, x right and y down, both 0 to 1. */
export function viewRay(view: ViewBasis, x: number, y: number): Vec3 {
  if (!(view.verticalFovRad > 0 && view.verticalFovRad < Math.PI) || !(view.aspect > 0)) {
    throw new RangeError("a perspective view needs 0 < vertical FOV < 180 degrees and a positive aspect");
  }
  const tanHalf = Math.tan(view.verticalFovRad / 2);
  return normalize(add(view.forward, add(scale(view.right, (2 * x - 1) * tanHalf * view.aspect), scale(view.up, (1 - 2 * y) * tanHalf))));
}

export const VIEWPORT_CORNERS: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];

/**
 * Whether the orb's silhouette covers the whole viewport: every corner ray in
 * the cap a·v ≥ cos α (hemisphere at the surface, everything inside).
 */
export function viewportCovered(geometry: OrbGeometry, view: ViewBasis): boolean {
  if (geometry.inside && geometry.distance < geometry.radius) return true;
  const a = geometry.axis;
  if (!a) return true;
  const threshold = geometry.inside ? 0 : Math.cos(geometry.alpha);
  return VIEWPORT_CORNERS.every(([x, y]) => dot(a, viewRay(view, x, y)) >= threshold - 1e-12);
}

/** Largest angle from the axis to a viewport corner, radians; ≥ π/2 means an exterior sphere can never cover it. */
export function maximumCornerAngle(axis: Vec3, view: ViewBasis): number {
  return Math.max(...VIEWPORT_CORNERS.map(([x, y]) => Math.acos(Math.max(-1, Math.min(1, dot(axis, viewRay(view, x, y)))))));
}

/** Coverage and ray equality: the frame where the orb can hand off to fullscreen rendering. */
export function handoffReady(geometry: OrbGeometry, view: ViewBasis, previewHalfAngleRad: number): boolean {
  if (!viewportCovered(geometry, view)) return false;
  return geometry.inside || geometry.alpha >= previewHalfAngleRad;
}

/**
 * The virtual radius at which a fixed-axis exterior expansion first hands
 * off: α must reach both βR and every corner angle. Null when a corner is at
 * or beyond 90° from the axis: then only a fade can enter.
 */
export function expansionTargetRadius(distance: number, axis: Vec3, view: ViewBasis, previewHalfAngleRad: number, margin = 1e-4): number | null {
  const corner = maximumCornerAngle(axis, view);
  const needed = Math.max(previewHalfAngleRad, corner) + margin;
  if (needed >= Math.PI / 2) return null;
  return distance * Math.sin(needed);
}

// ─── Sizes ─────────────────────────────────────────────────────────────

/** On-axis projected diameter in the viewport's pixels: H R / (d tan(vFov/2)). A centre-density approximation. */
export function projectedDiameterPx(radius: number, distance: number, verticalFovRad: number, viewportHeightPx: number): number {
  return viewportHeightPx * radius / (Math.max(distance, radius) * Math.tan(verticalFovRad / 2));
}

/** The radius whose projected diameter is `diameterPx`: the inverse of the above. */
export function radiusForDiameterPx(diameterPx: number, distance: number, verticalFovRad: number, viewportHeightPx: number): number {
  return diameterPx * distance * Math.tan(verticalFovRad / 2) / viewportHeightPx;
}
