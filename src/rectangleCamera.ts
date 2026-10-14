/**
 * The camera of a rectangle image surface: one for every source it shows.
 *
 * The plane is the comparison's canonical extent, origin at the top left, x
 * right and y down. A surface-local CSS point `p` shows the plane point `q`
 * where `p = t + s q`: `s` is CSS pixels per plane unit and `t` where the
 * plane's origin is. Surface-local CSS is measured from the surface's
 * framebuffer rectangle's corner, in that rectangle's pixels divided by the
 * pixels per CSS pixel, so drawing and input share one conversion.
 */

export interface RectangleExtent {
  readonly width: number;
  readonly height: number;
}

export interface RectangleViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface RectanglePoint {
  readonly x: number;
  readonly y: number;
}

export interface RectangleCamera {
  /** CSS pixels per plane unit. */
  readonly scale: number;
  /** Where the plane's origin is, in surface-local CSS pixels. */
  readonly x: number;
  readonly y: number;
}

export interface RectangleScaleLimits {
  readonly min: number;
  readonly max: number;
}

/** The scale range a surface allows: from a twentieth of a fit to 64 framebuffer pixels per texel of the densest source. */
export function rectangleScaleLimits(extent: RectangleExtent, viewport: RectangleViewportSize, densest: { readonly width: number; readonly pixelsPerCss: number }): RectangleScaleLimits {
  const fit = fitScale(extent, viewport);
  const native = densest.width / (extent.width * Math.max(densest.pixelsPerCss, 1e-6));
  const max = Math.max(native * 64, fit * 4);
  return { min: Math.min(fit / 20, max), max };
}

function fitScale(extent: RectangleExtent, viewport: RectangleViewportSize): number {
  if (!(extent.width > 0 && extent.height > 0 && viewport.width > 0 && viewport.height > 0)) return 1;
  return Math.min(viewport.width / extent.width, viewport.height / extent.height);
}

/** The whole plane, as large as it fits, centred. Fit is the only command that recentres. */
export function fitRectangleCamera(extent: RectangleExtent, viewport: RectangleViewportSize): RectangleCamera {
  const scale = fitScale(extent, viewport);
  return { scale, x: (viewport.width - scale * extent.width) / 2, y: (viewport.height - scale * extent.height) / 2 };
}

export function rectanglePlanePointAt(camera: RectangleCamera, local: RectanglePoint): RectanglePoint {
  return { x: (local.x - camera.x) / camera.scale, y: (local.y - camera.y) / camera.scale };
}

export function rectangleLocalPointOf(camera: RectangleCamera, plane: RectanglePoint): RectanglePoint {
  return { x: camera.x + camera.scale * plane.x, y: camera.y + camera.scale * plane.y };
}

function clampScale(scale: number, limits: RectangleScaleLimits): number {
  return Math.min(Math.max(scale, limits.min), limits.max);
}

/**
 * Zooms to `requestedScale` keeping the plane point under `anchor` there. The
 * scale is clamped first and the translation solved from it, so a clamped
 * step still keeps the anchor; nothing recentres the plane afterwards.
 */
export function zoomRectangleCamera(camera: RectangleCamera, anchor: RectanglePoint, requestedScale: number, limits: RectangleScaleLimits): RectangleCamera {
  if (!Number.isFinite(requestedScale) || requestedScale <= 0) return camera;
  const scale = clampScale(requestedScale, limits);
  const plane = rectanglePlanePointAt(camera, anchor);
  return { scale, x: anchor.x - scale * plane.x, y: anchor.y - scale * plane.y };
}

/** Moves the plane by a surface-local CSS displacement. */
export function panRectangleCamera(camera: RectangleCamera, dx: number, dy: number): RectangleCamera {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return camera;
  return { scale: camera.scale, x: camera.x + dx, y: camera.y + dy };
}

/**
 * One pinch step: the plane point under the old midpoint goes to the new
 * midpoint while the scale follows the change in finger separation.
 */
export function pinchRectangleCamera(camera: RectangleCamera, from: RectanglePoint, to: RectanglePoint, ratio: number, limits: RectangleScaleLimits): RectangleCamera {
  if (!Number.isFinite(ratio) || ratio <= 0) return panRectangleCamera(camera, to.x - from.x, to.y - from.y);
  const scale = clampScale(camera.scale * ratio, limits);
  const plane = rectanglePlanePointAt(camera, from);
  return { scale, x: to.x - scale * plane.x, y: to.y - scale * plane.y };
}

/** A surface resize keeps the scale and the plane point at the viewport's centre. */
export function resizeRectangleCamera(camera: RectangleCamera, from: RectangleViewportSize, to: RectangleViewportSize): RectangleCamera {
  const centre = rectanglePlanePointAt(camera, { x: from.width / 2, y: from.height / 2 });
  return { scale: camera.scale, x: to.width / 2 - camera.scale * centre.x, y: to.height / 2 - camera.scale * centre.y };
}

/** A source's place on the canonical plane: its own pixels per plane unit along each axis. */
export interface RectangleSourceRegistration {
  /** The source's native pixel size. */
  readonly width: number;
  readonly height: number;
}

/** Framebuffer pixels per CSS pixel the surface measured along each axis. */
export interface RectanglePixelRatio {
  readonly x: number;
  readonly y: number;
}

const RATIO_TOLERANCE = 1e-9;

export type RectangleNativeInspection =
  | { readonly ok: true; readonly camera: RectangleCamera }
  | { readonly ok: false; readonly reason: string };

/**
 * One texel of `source` on one framebuffer pixel, its centres on pixel
 * centres, keeping the plane point at the viewport's centre as near as the
 * alignment allows. The CSS scale is `Wi / (Wc × r)`. The measured ratios
 * must be equal: an anisotropic surface cannot show one texel per pixel on
 * both axes.
 */
export function nativeRectangleCamera(camera: RectangleCamera, extent: RectangleExtent, source: RectangleSourceRegistration, ratio: RectanglePixelRatio, viewport: RectangleViewportSize): RectangleNativeInspection {
  if (!(ratio.x > 0 && ratio.y > 0)) return { ok: false, reason: "The surface has no measured pixels." };
  if (Math.abs(ratio.x - ratio.y) > RATIO_TOLERANCE * Math.max(ratio.x, ratio.y)) {
    return { ok: false, reason: `The surface has ${ratio.x} framebuffer pixels per CSS pixel across and ${ratio.y} down, so no scale shows one texel per pixel on both axes.` };
  }
  if (source.width * extent.height !== source.height * extent.width) {
    return { ok: false, reason: "The source does not have the comparison's aspect ratio." };
  }
  const r = ratio.x;
  const scale = source.width / (extent.width * r);
  const centred = zoomRectangleCamera(camera, { x: viewport.width / 2, y: viewport.height / 2 }, scale, { min: scale, max: scale });
  // A texel centre lands at r·t + (i + ½) framebuffer pixels: r·t whole puts it on a pixel centre.
  return { ok: true, camera: { scale, x: Math.round(centred.x * r) / r, y: Math.round(centred.y * r) / r } };
}

export interface RectangleNativeStatus {
  /** One texel of the source per framebuffer pixel. */
  readonly scale: boolean;
  /** Texel centres on framebuffer pixel centres. */
  readonly aligned: boolean;
}

/** Whether the camera still shows `source` at one texel per framebuffer pixel, centred on pixels. */
export function rectangleNativeStatus(camera: RectangleCamera, extent: RectangleExtent, source: RectangleSourceRegistration, ratio: RectanglePixelRatio, tolerancePx = 1e-3): RectangleNativeStatus {
  const texelX = camera.scale * extent.width / source.width * ratio.x;
  const texelY = camera.scale * extent.height / source.height * ratio.y;
  const scale = Math.abs(texelX - 1) <= tolerancePx / Math.max(source.width, source.height) && Math.abs(texelY - 1) <= tolerancePx / Math.max(source.width, source.height);
  const offset = (value: number): number => Math.abs(value - Math.round(value));
  const aligned = scale && offset(camera.x * ratio.x) <= tolerancePx && offset(camera.y * ratio.y) <= tolerancePx;
  return { scale, aligned };
}

/** Whether two cameras are the same view. */
export function sameRectangleCamera(a: RectangleCamera, b: RectangleCamera): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y;
}
