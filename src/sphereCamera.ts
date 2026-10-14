/**
 * The sphere camera, with no DOM, scene or device
 * (docs/proposals/shared-image-viewer-implementation.md §7).
 *
 * The common frame is X right, Y forward and Z up: the same heading and pitch
 * the live view stores, before any geographic conversion. Heading is clockwise
 * from forward and pitch is above the horizon. The basis has no roll: its
 * right axis stays level. A source's `contentFromCommon` is not applied here.
 */
import { cross, dot, length, normalize, type Vec3 } from "@foss-earth/images";
import { viewRay, type ViewBasis } from "./math.js";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface SphereCamera {
  readonly headingDeg: number;
  readonly pitchDeg: number;
  readonly verticalFovDeg: number;
}

/** The measured view, in CSS pixels. Aspect and pointer conversion both use it. */
export interface SphereViewport {
  readonly width: number;
  readonly height: number;
}

/** A point in that view: x right and y down, CSS pixels from its top-left corner. */
export interface SpherePoint {
  readonly x: number;
  readonly y: number;
}

export interface SpherePoseLimits {
  readonly fovDeg: { readonly min: number; readonly max: number };
  readonly pitchDeg: { readonly min: number; readonly max: number };
}

/** A heading and pitch in the common frame, as a unit direction. */
export function sphereDirection(headingDeg: number, pitchDeg: number): Vec3 {
  const h = headingDeg * DEG_TO_RAD, p = pitchDeg * DEG_TO_RAD;
  return [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];
}

function wrapHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function wrapPitch(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

function headingDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function clampRange(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** The level basis of a sphere camera for a measured view. */
export function sphereViewBasis(camera: SphereCamera, viewport: SphereViewport): ViewBasis {
  const forward = sphereDirection(camera.headingDeg, camera.pitchDeg);
  const up = sphereDirection(camera.headingDeg, camera.pitchDeg + 90);
  return {
    forward,
    up,
    right: normalize(cross(forward, up)),
    verticalFovRad: camera.verticalFovDeg * DEG_TO_RAD,
    aspect: viewport.width / viewport.height,
  };
}

/** The common-space ray through a CSS point of the measured view. */
export function sphereRay(camera: SphereCamera, viewport: SphereViewport, point: SpherePoint): Vec3 {
  return viewRay(sphereViewBasis(camera, viewport), point.x / viewport.width, point.y / viewport.height);
}

/**
 * Where a common-space ray meets the view, in CSS pixels. Null when the ray
 * is not in front of the camera.
 */
export function projectSphereRay(camera: SphereCamera, viewport: SphereViewport, ray: Vec3): SpherePoint | null {
  const basis = sphereViewBasis(camera, viewport);
  const forward = dot(ray, basis.forward);
  if (!(forward > 1e-8)) return null;
  const tanHalf = Math.tan(basis.verticalFovRad / 2);
  if (!(tanHalf > 0) || !(basis.aspect > 0)) return null;
  const ndcX = dot(ray, basis.right) / (forward * tanHalf * basis.aspect);
  const ndcY = dot(ray, basis.up) / (forward * tanHalf);
  return { x: (ndcX + 1) / 2 * viewport.width, y: (1 - ndcY) / 2 * viewport.height };
}

function cameraSpace(viewport: SphereViewport, point: SpherePoint, fovDeg: number): { cx: number; cy: number; cz: number } | null {
  if (!(fovDeg > 0 && fovDeg < 180)) return null;
  const tanHalf = Math.tan(fovDeg * DEG_TO_RAD / 2);
  const aspect = viewport.width / viewport.height;
  if (!(tanHalf > 0) || !(aspect > 0)) return null;
  const sx = (2 * point.x / viewport.width - 1) * tanHalf * aspect;
  const sy = (1 - 2 * point.y / viewport.height) * tanHalf;
  const span = Math.hypot(sx, 1, sy);
  return { cx: sx / span, cy: 1 / span, cz: sy / span };
}

function forwardAngleDeg(from: SphereCamera, to: SphereCamera): number {
  const a = sphereDirection(from.headingDeg, from.pitchDeg);
  const b = sphereDirection(to.headingDeg, to.pitchDeg);
  return Math.atan2(length(cross(a, b)), Math.min(1, Math.max(-1, dot(a, b)))) * RAD_TO_DEG;
}

function pitchAllowed(pitchDeg: number, range: { min: number; max: number }): boolean {
  return pitchDeg >= range.min && pitchDeg <= range.max;
}

/**
 * Heading and pitch that put `ray` on `point` at `fovDeg`, on the branch
 * nearest `reference`. Null when that branch is not a legal no-roll pose:
 * the other mathematical branch is not a substitute.
 */
function solveAnchoredPose(reference: SphereCamera, viewport: SphereViewport, ray: Vec3, point: SpherePoint, fovDeg: number, limits: SpherePoseLimits): SphereCamera | null {
  const space = cameraSpace(viewport, point, fovDeg);
  if (!space) return null;
  const { cx, cy, cz } = space;
  const rho = Math.hypot(ray[0], ray[1]);
  const vertical = Math.hypot(cy, cz);
  if (!(vertical > 1e-8) || Math.abs(ray[2]) > vertical + 1e-8) return null;
  const phi = Math.atan2(cz, cy);
  const lambda = Math.asin(Math.min(1, Math.max(-1, ray[2] / vertical)));
  const alpha = rho < 1e-8 ? reference.headingDeg * DEG_TO_RAD : Math.atan2(ray[0], ray[1]);
  const candidates: SphereCamera[] = [];
  for (const pitch of [lambda - phi, Math.PI - lambda - phi]) {
    const cosine = Math.cos(pitch);
    const sine = Math.sin(pitch);
    const aligned = cy * cosine - cz * sine;
    let headingDeg: number;
    if (rho < 1e-8) {
      if (Math.abs(cx) > 1e-5) continue;
      headingDeg = reference.headingDeg;
    } else {
      const sinPsi = -cx / rho;
      const cosPsi = aligned / rho;
      if (Math.abs(sinPsi * sinPsi + cosPsi * cosPsi - 1) > 1e-3) continue;
      headingDeg = wrapHeading((alpha + Math.atan2(sinPsi, cosPsi)) * RAD_TO_DEG);
    }
    const pose: SphereCamera = { headingDeg, pitchDeg: wrapPitch(pitch * RAD_TO_DEG), verticalFovDeg: fovDeg };
    const ahead = dot(sphereDirection(pose.headingDeg, pose.pitchDeg), ray);
    if (ahead > 1e-6) candidates.push(pose);
  }
  candidates.sort((a, b) => {
    const angle = forwardAngleDeg(reference, a) - forwardAngleDeg(reference, b);
    if (Math.abs(angle) > 1e-4) return angle;
    return Math.abs(headingDelta(reference.headingDeg, a.headingDeg)) - Math.abs(headingDelta(reference.headingDeg, b.headingDeg));
  });
  const nearest = candidates[0];
  if (!nearest || forwardAngleDeg(reference, nearest) > 90 || !pitchAllowed(nearest.pitchDeg, limits.pitchDeg)) return null;
  const projected = projectSphereRay(nearest, viewport, ray);
  if (!projected) return null;
  if (Math.hypot(projected.x - point.x, projected.y - point.y) > 0.25) return null;
  return nearest;
}

/**
 * Keeps `ray` on the way from `from` to `to` while the field of view moves
 * toward `requestedFovDeg`. The request is clamped before any solve. When the
 * clamped pose has no legal no-roll solution, the result is the last feasible
 * pose on the way there: pitch is not clamped afterwards, and a distant legal
 * branch is not used.
 *
 * `ray` is the common-space direction the current camera shows at `from`.
 */
export function anchorSphereCamera(camera: SphereCamera, viewport: SphereViewport, ray: Vec3, to: SpherePoint, requestedFovDeg: number, limits: SpherePoseLimits, from: SpherePoint = to): SphereCamera {
  if (!(viewport.width > 0 && viewport.height > 0) || !Number.isFinite(requestedFovDeg)) return camera;
  const requested = clampRange(requestedFovDeg, limits.fovDeg);
  const direction = normalize(ray);
  if (!direction.every(Number.isFinite)) return camera;
  if (Math.abs(requested - camera.verticalFovDeg) < 1e-9 && Math.abs(from.x - to.x) < 1e-9 && Math.abs(from.y - to.y) < 1e-9) {
    return camera.verticalFovDeg === requested ? camera : { ...camera, verticalFovDeg: requested };
  }
  const direct = solveAnchoredPose(camera, viewport, direction, to, requested, limits);
  if (direct) return direct;
  let best = camera;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 28; step++) {
    const t = (low + high) / 2;
    const fov = camera.verticalFovDeg + (requested - camera.verticalFovDeg) * t;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    const pose = solveAnchoredPose(camera, viewport, direction, point, fov, limits);
    if (pose) { best = pose; low = t; }
    else high = t;
  }
  return best;
}
