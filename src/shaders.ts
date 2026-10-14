import { SRGB_ENCODE_WGSL } from "@foss-earth/images/shaders";
import { CUBE_VECTOR_WGSL } from "@foss-earth/sphere-cubemap/shaders";
import { EQUIRECT_UV_WGSL, EQUIRECT_SAMPLE_WGSL } from "@foss-earth/sphere-equirectangular/shaders";
import { TILE_LOOKUP_WGSL } from "@foss-earth/sphere-tiled-cubemap/shaders";
import { RECTANGLE_IMAGE_WGSL } from "@foss-earth/rectangle-image/shaders";
/**
 * WGSL for sphere orbs and immersion (docs/proposals/panorama-scenes.md §3).
 *
 * Positions are relative to the camera's eye, computed on the CPU in float64,
 * so no uniform is named world/view/viewProjection and Babylon's floating
 * origin leaves them alone. `viewRotProj` is the camera's rotation times its
 * projection, the same matrices the globe is drawn with this frame.
 *
 * The orb's window is the flat (rectilinear) window of sphereMath.ts:
 * for a covered ray v with cap half-angle α < βR it shows
 * D ∝ a + (tan βR / tan α)(v − (a·v)a)/(a·v), and v itself once α ≥ βR.
 * Content is then rotated from ECEF into the image's frame, and the cube is
 * sampled with (x, z, y): the format's faces are WebGPU's with Y and Z
 * exchanged (GPU_LAYER_SOURCE_FACES).
 *
 * An outline, when there is one, is a ring `outlineWidth` rendered pixels
 * wide just outside the silhouette, measured along the gradient of sin δ;
 * the probes' outputs leave it out, so they cover the image alone.
 *
 * SOURCE_TILES and NEXT_TILES draw a tiled cube (src/scenes/tiles/) over the
 * preview cube the same draw samples: sphereTiles looks the direction's cell
 * up in the display table and takes one level-0 tap from the atlas, whose
 * rgba8unorm-srgb samples arrive in linear light like the cube's.
 *
 * Every texture is sampled once, outside any branch, so derivatives are
 * taken in uniform control flow from rays that are all finite. Textures are
 * rgba8unorm-srgb, so samples arrive in linear light; blending between two
 * sources happens there, and the one conversion back to sRGB is at output.
 */

/** Shared WGSL: the window mapping and the sRGB encoding. */
const COMMON = /* wgsl */ `
${SRGB_ENCODE_WGSL}

fn sphereImageDirection(world: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(uniforms.content0, world), dot(uniforms.content1, world), dot(uniforms.content2, world));
}

${CUBE_VECTOR_WGSL}

${EQUIRECT_UV_WGSL}

${TILE_LOOKUP_WGSL}

// Gradients across the longitude seam: of u and of u shifted by half a
// turn, whichever is smaller, so the seam does not drop to the coarsest mip.
${EQUIRECT_SAMPLE_WGSL}
`;

const CONTENT_UNIFORMS = `
uniform content0 : vec3<f32>;
uniform content1 : vec3<f32>;
uniform content2 : vec3<f32>;
`;

/**
 * The orb: a quad perpendicular to the camera-to-marker axis, or covering the
 * view near and inside the orb. It samples the orb's preview cube, or,
 * with SOURCE_EQUIRECT, an equirectangular image, as when a flight out of a
 * sphere starts from the image on screen.
 */
export const ORB_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform viewRotProj : mat4x4<f32>;
uniform quadCenter : vec3<f32>;
uniform quadU : vec3<f32>;
uniform quadV : vec3<f32>;
varying vRel : vec3<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let rel = uniforms.quadCenter + vertexInputs.position.x * uniforms.quadU + vertexInputs.position.y * uniforms.quadV;
  vertexOutputs.vRel = rel;
  vertexOutputs.position = uniforms.viewRotProj * vec4<f32>(rel, 1.0);
}
`;

export const ORB_FRAGMENT = /* wgsl */ `
uniform viewRotProj : mat4x4<f32>;
uniform markerRel : vec3<f32>;
uniform radius : f32;
uniform tanPreviewHalfAngle : f32;
uniform opacity : f32;
uniform outlineColor : vec4<f32>;
uniform outlineWidth : f32;
${CONTENT_UNIFORMS}
#ifdef SOURCE_EQUIRECT
var sphereEquirect : texture_2d<f32>;
var sphereEquirectSampler : sampler;
#else
var sphereCube : texture_cube<f32>;
var sphereCubeSampler : sampler;
#endif
#ifdef SOURCE_TILES
var tileAtlas : texture_2d<f32>;
var tileAtlasSampler : sampler;
var tileTable : texture_2d<f32>;
var tileTableSampler : sampler;
uniform tileLayout : vec4<f32>;
uniform tileAtlasInfo : vec4<f32>;
#endif
varying vRel : vec3<f32>;
${COMMON}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let v = normalize(fragmentInputs.vRel);
  let d = length(uniforms.markerRel);
  let a = uniforms.markerRel / d;
  let c = dot(a, v);
  let k = v - c * a;
  let sinDelta = length(k);
  let radius = uniforms.radius;
  let inside = d <= radius;
  let sinAlpha = min(radius / d, 1.0);
  let cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  let tanAlpha = sinAlpha / max(cosAlpha, 1e-7);

  // Coverage: the cap sin δ < sin α on the near side, with a one-pixel edge.
  let edge = sinAlpha - sinDelta;
  let edgeWidth = max(fwidth(sinDelta), 1e-7);
  let front = select(0.0, 1.0, c > 0.0);
  let exterior = clamp(edge / edgeWidth + 0.5, 0.0, 1.0) * front;
  let coverage = select(exterior, 1.0, inside);
  // The outline's share of the pixel: out to its width beyond the edge, none from inside.
  let pixelStep = max(length(vec2<f32>(dpdx(sinDelta), dpdy(sinDelta))), 1e-9);
  let ringOuter = clamp(edge / pixelStep + uniforms.outlineWidth + 0.5, 0.0, 1.0) * front;
  let ring = select(max(ringOuter - exterior, 0.0), 0.0, inside) * uniforms.outlineColor.a;

  // The flat window; identity inside and once α ≥ βR. Finite for every ray.
  let gain = uniforms.tanPreviewHalfAngle / max(tanAlpha, 1e-7);
  let windowed = normalize(a + k * (gain / max(c, 1e-4)));
  let identity = inside || tanAlpha >= uniforms.tanPreviewHalfAngle;
  let world = select(windowed, v, identity);
  let image = sphereImageDirection(world);
#ifdef SOURCE_EQUIRECT
  let sampled = sphereSeamlessSample(sphereEquirect, sphereEquirectSampler, sphereEquirectUv(image));
#else
  let sampled = textureSample(sphereCube, sphereCubeSampler, sphereCubeVector(image));
#endif
  var sampledColor = sampled.rgb;
#ifdef SOURCE_TILES
  sampledColor = sphereTiles(tileAtlas, tileAtlasSampler, tileTable, tileTableSampler, sampledColor, image, uniforms.tileLayout, uniforms.tileAtlasInfo);
#endif

  // Depth where the ray meets the orb: the near side from outside, the far side inside.
  let b = c * d;
  let root = sqrt(max(radius * radius - d * d + b * b, 0.0));
  let t = select(b - root, b + root, inside);
  let clip = uniforms.viewRotProj * vec4<f32>(v * max(t, 0.0), 1.0);

#ifdef OUTPUT_DIRECTION
  if (coverage <= 0.0) {
    discard;
  }
  fragmentOutputs.color = vec4<f32>(image, coverage);
#else
#ifdef OUTPUT_RAY
  if (coverage <= 0.0) {
    discard;
  }
  fragmentOutputs.color = vec4<f32>(v, coverage);
#else
  let shown = coverage + ring;
  if (shown <= 0.0) {
    discard;
  }
  let rgb = (sphereSrgbEncode(sampledColor) * coverage + uniforms.outlineColor.rgb * ring) / shown;
  fragmentOutputs.color = vec4<f32>(rgb, shown * uniforms.opacity);
#endif
#endif
  fragmentOutputs.fragDepth = clamp(clip.z / clip.w, 0.0, 1.0);
}
`;

/**
 * Immersion: one triangle covering the view. `inverseViewRotProj` turns the
 * clip-space corner into an eye-relative direction, interpolated
 * projectively and normalized per fragment. The first source is the current
 * image; the second, weighted by `mixWeight`, the incoming one.
 */
export const IMMERSION_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform inverseViewRotProj : mat4x4<f32>;
varying vRay : vec4<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let clip = vec4<f32>(vertexInputs.position.xy, 0.5, 1.0);
  vertexOutputs.vRay = uniforms.inverseViewRotProj * clip;
  vertexOutputs.position = clip;
}
`;

export const IMMERSION_FRAGMENT = /* wgsl */ `
uniform inverseViewRotProj : mat4x4<f32>;
uniform opacity : f32;
uniform mixWeight : f32;
${CONTENT_UNIFORMS}
uniform nextContent0 : vec3<f32>;
uniform nextContent1 : vec3<f32>;
uniform nextContent2 : vec3<f32>;
#ifdef SOURCE_EQUIRECT
var sphereEquirect : texture_2d<f32>;
var sphereEquirectSampler : sampler;
#else
var sphereCube : texture_cube<f32>;
var sphereCubeSampler : sampler;
#endif
#ifdef NEXT_EQUIRECT
var nextEquirect : texture_2d<f32>;
var nextEquirectSampler : sampler;
#endif
#ifdef NEXT_CUBE
var nextCube : texture_cube<f32>;
var nextCubeSampler : sampler;
#endif
#ifdef SOURCE_TILES
var tileAtlas : texture_2d<f32>;
var tileAtlasSampler : sampler;
var tileTable : texture_2d<f32>;
var tileTableSampler : sampler;
uniform tileLayout : vec4<f32>;
uniform tileAtlasInfo : vec4<f32>;
#endif
#ifdef NEXT_TILES
var nextTileAtlas : texture_2d<f32>;
var nextTileAtlasSampler : sampler;
var nextTileTable : texture_2d<f32>;
var nextTileTableSampler : sampler;
uniform nextTileLayout : vec4<f32>;
uniform nextTileAtlasInfo : vec4<f32>;
#endif
varying vRay : vec4<f32>;
${COMMON}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let v = normalize(fragmentInputs.vRay.xyz / fragmentInputs.vRay.w);
  let image = sphereImageDirection(v);
#ifdef SOURCE_EQUIRECT
  var color = sphereSeamlessSample(sphereEquirect, sphereEquirectSampler, sphereEquirectUv(image)).rgb;
#else
  var color = textureSample(sphereCube, sphereCubeSampler, sphereCubeVector(image)).rgb;
#endif
#ifdef SOURCE_TILES
  color = sphereTiles(tileAtlas, tileAtlasSampler, tileTable, tileTableSampler, color, image, uniforms.tileLayout, uniforms.tileAtlasInfo);
#endif
  let nextImage = vec3<f32>(dot(uniforms.nextContent0, v), dot(uniforms.nextContent1, v), dot(uniforms.nextContent2, v));
#ifdef NEXT_EQUIRECT
  color = mix(color, sphereSeamlessSample(nextEquirect, nextEquirectSampler, sphereEquirectUv(nextImage)).rgb, uniforms.mixWeight);
#endif
#ifdef NEXT_CUBE
  var nextColor = textureSample(nextCube, nextCubeSampler, sphereCubeVector(nextImage)).rgb;
#ifdef NEXT_TILES
  nextColor = sphereTiles(nextTileAtlas, nextTileAtlasSampler, nextTileTable, nextTileTableSampler, nextColor, nextImage, uniforms.nextTileLayout, uniforms.nextTileAtlasInfo);
#endif
  color = mix(color, nextColor, uniforms.mixWeight);
#endif
#ifdef OUTPUT_DIRECTION
  fragmentOutputs.color = vec4<f32>(image, 1.0);
#else
#ifdef OUTPUT_RAY
  fragmentOutputs.color = vec4<f32>(v, 1.0);
#else
  fragmentOutputs.color = vec4<f32>(sphereSrgbEncode(color), uniforms.opacity);
#endif
#endif
}
`;

export const ORB_UNIFORMS = ["viewRotProj", "quadCenter", "quadU", "quadV", "markerRel", "radius", "tanPreviewHalfAngle", "opacity", "outlineColor", "outlineWidth", "content0", "content1", "content2", "tileLayout", "tileAtlasInfo"] as const;
export const IMMERSION_UNIFORMS = ["inverseViewRotProj", "opacity", "mixWeight", "content0", "content1", "content2", "nextContent0", "nextContent1", "nextContent2", "tileLayout", "tileAtlasInfo", "nextTileLayout", "nextTileAtlasInfo"] as const;
/** A tiled source's atlas and display table; a tiled next source's. */
export const TILE_SAMPLERS = ["tileAtlas", "tileTable"] as const;
export const NEXT_TILE_SAMPLERS = ["nextTileAtlas", "nextTileTable"] as const;

/**
 * A rectangle image surface (docs/proposals/shared-image-viewer-implementation.md
 * §6): a quad filling the surface's own viewport. The CPU gives the plane
 * point at the surface's top-left corner and the plane size it spans, in
 * float64; the plane point interpolates exactly because the map is affine.
 * Both sources share that plane and are sampled outside any branch, with
 * gradients of the continuous coordinate, before the wipe chooses between
 * them on surface-local x. A nearest view samples level 0 at the texel's
 * centre, which needs no sampler state of its own. Samples arrive in linear
 * light from rgba8unorm-srgb; the background is linear too, and the one
 * conversion back to sRGB is at output.
 */
export const RECTANGLE_SURFACE_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
uniform planeRect : vec4<f32>;
varying vLocal : vec2<f32>;
varying vPlane : vec2<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let local = vec2<f32>(vertexInputs.position.x, 1.0 - vertexInputs.position.y);
  vertexOutputs.vLocal = local;
  vertexOutputs.vPlane = uniforms.planeRect.xy + local * uniforms.planeRect.zw;
  vertexOutputs.position = vec4<f32>(vertexInputs.position.xy * 2.0 - vec2<f32>(1.0), 0.5, 1.0);
}
`;

export const RECTANGLE_SURFACE_FRAGMENT = /* wgsl */ `
uniform planeRect : vec4<f32>;
uniform extent : vec2<f32>;
uniform wipe : f32;
uniform nearest : f32;
uniform background : vec3<f32>;
#ifdef RECTANGLE_LEFT
var leftImage : texture_2d<f32>;
var leftImageSampler : sampler;
uniform leftSize : vec2<f32>;
#endif
#ifdef RECTANGLE_RIGHT
var rightImage : texture_2d<f32>;
var rightImageSampler : sampler;
uniform rightSize : vec2<f32>;
#endif
varying vLocal : vec2<f32>;
varying vPlane : vec2<f32>;
${SRGB_ENCODE_WGSL}
${RECTANGLE_IMAGE_WGSL}

fn rectangleSurfaceSample(image : texture_2d<f32>, imageSampler : sampler, size : vec2<f32>, uv : vec2<f32>, dx : vec2<f32>, dy : vec2<f32>) -> vec3<f32> {
  let at = mix(uv, rectangleNearestTexelUv(uv, size), uniforms.nearest);
  let keep = 1.0 - uniforms.nearest;
  return textureSampleGrad(image, imageSampler, at, dx * keep, dy * keep).rgb;
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let uv = rectangleImageUv(fragmentInputs.vPlane, uniforms.extent);
  let covered = rectangleImageCoverage(fragmentInputs.vPlane, uniforms.extent);
  let dx = dpdx(uv);
  let dy = dpdy(uv);
#ifdef RECTANGLE_LEFT
  let left = rectangleSurfaceSample(leftImage, leftImageSampler, uniforms.leftSize, uv, dx, dy);
#else
  let left = uniforms.background;
#endif
#ifdef RECTANGLE_RIGHT
  let right = rectangleSurfaceSample(rightImage, rightImageSampler, uniforms.rightSize, uv, dx, dy);
#else
  let right = uniforms.background;
#endif
  let shown = select(right, left, fragmentInputs.vLocal.x < uniforms.wipe);
  fragmentOutputs.color = vec4<f32>(sphereSrgbEncode(mix(uniforms.background, shown, covered)), 1.0);
}
`;

export const RECTANGLE_SURFACE_UNIFORMS = ["planeRect", "extent", "wipe", "nearest", "background", "leftSize", "rightSize"] as const;
export const RECTANGLE_SURFACE_SAMPLERS = ["leftImage", "rightImage"] as const;

/**
 * A sphere image surface. The quad fills the surface's viewport. Each fragment's
 * common-space ray is the same perspective ray the camera casts, from the basis
 * uploaded in float64. Each source rotates that ray by its own content matrix
 * once, then the live sampling functions read it. Both sources are sampled
 * before the wipe, which is surface-local x and does not move the ray.
 * Comparison has no source/next crossfade: a steady tiled pair is the two
 * previews and their atlases and tables, six samplers.
 */
export const SPHERE_SURFACE_VERTEX = /* wgsl */ `
attribute position : vec3<f32>;
varying vLocal : vec2<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  vertexOutputs.vLocal = vec2<f32>(vertexInputs.position.x, 1.0 - vertexInputs.position.y);
  vertexOutputs.position = vec4<f32>(vertexInputs.position.xy * 2.0 - vec2<f32>(1.0), 0.5, 1.0);
}
`;

export const SPHERE_SURFACE_FRAGMENT = /* wgsl */ `
uniform forward : vec3<f32>;
uniform right : vec3<f32>;
uniform up : vec3<f32>;
uniform tanHalf : f32;
uniform aspect : f32;
uniform wipe : f32;
uniform nearest : f32;
uniform background : vec3<f32>;
#if defined(LEFT_EQUIRECT) || defined(LEFT_CUBE)
uniform leftContent0 : vec3<f32>;
uniform leftContent1 : vec3<f32>;
uniform leftContent2 : vec3<f32>;
#endif
#ifdef LEFT_EQUIRECT
var leftEquirect : texture_2d<f32>;
var leftEquirectSampler : sampler;
uniform leftSize : vec2<f32>;
#endif
#ifdef LEFT_CUBE
var leftCube : texture_cube<f32>;
var leftCubeSampler : sampler;
#endif
#ifdef LEFT_TILES
var leftTileAtlas : texture_2d<f32>;
var leftTileAtlasSampler : sampler;
var leftTileTable : texture_2d<f32>;
var leftTileTableSampler : sampler;
uniform leftTileLayout : vec4<f32>;
uniform leftTileAtlasInfo : vec4<f32>;
#endif
#if defined(RIGHT_EQUIRECT) || defined(RIGHT_CUBE)
uniform rightContent0 : vec3<f32>;
uniform rightContent1 : vec3<f32>;
uniform rightContent2 : vec3<f32>;
#endif
#ifdef RIGHT_EQUIRECT
var rightEquirect : texture_2d<f32>;
var rightEquirectSampler : sampler;
uniform rightSize : vec2<f32>;
#endif
#ifdef RIGHT_CUBE
var rightCube : texture_cube<f32>;
var rightCubeSampler : sampler;
#endif
#ifdef RIGHT_TILES
var rightTileAtlas : texture_2d<f32>;
var rightTileAtlasSampler : sampler;
var rightTileTable : texture_2d<f32>;
var rightTileTableSampler : sampler;
uniform rightTileLayout : vec4<f32>;
uniform rightTileAtlasInfo : vec4<f32>;
#endif
varying vLocal : vec2<f32>;
${SRGB_ENCODE_WGSL}
${CUBE_VECTOR_WGSL}
${EQUIRECT_UV_WGSL}
${EQUIRECT_SAMPLE_WGSL}
${TILE_LOOKUP_WGSL}

fn sphereSurfaceDirection(local: vec2<f32>) -> vec3<f32> {
  return normalize(uniforms.forward + uniforms.right * ((local.x * 2.0 - 1.0) * uniforms.tanHalf * uniforms.aspect) + uniforms.up * ((1.0 - local.y * 2.0) * uniforms.tanHalf));
}

fn sphereContentDirection(c0: vec3<f32>, c1: vec3<f32>, c2: vec3<f32>, world: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(c0, world), dot(c1, world), dot(c2, world));
}

fn sphereSurfaceEquirect(tex: texture_2d<f32>, samp: sampler, image: vec3<f32>, size: vec2<f32>) -> vec3<f32> {
  let uv = sphereEquirectUv(image);
  if (uniforms.nearest > 0.5) {
    let snapped = (floor(uv * size) + vec2<f32>(0.5)) / size;
    return textureSampleLevel(tex, samp, snapped, 0.0).rgb;
  }
  return sphereSeamlessSample(tex, samp, uv).rgb;
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let world = sphereSurfaceDirection(fragmentInputs.vLocal);
#ifdef LEFT_EQUIRECT
  let leftImage = sphereContentDirection(uniforms.leftContent0, uniforms.leftContent1, uniforms.leftContent2, world);
  var left = sphereSurfaceEquirect(leftEquirect, leftEquirectSampler, leftImage, uniforms.leftSize);
#else
#ifdef LEFT_CUBE
  let leftImage = sphereContentDirection(uniforms.leftContent0, uniforms.leftContent1, uniforms.leftContent2, world);
  var left = textureSample(leftCube, leftCubeSampler, sphereCubeVector(leftImage)).rgb;
#ifdef LEFT_TILES
  left = sphereTiles(leftTileAtlas, leftTileAtlasSampler, leftTileTable, leftTileTableSampler, left, leftImage, uniforms.leftTileLayout, uniforms.leftTileAtlasInfo);
#endif
#else
  var left = uniforms.background;
#endif
#endif
#ifdef RIGHT_EQUIRECT
  let rightImage = sphereContentDirection(uniforms.rightContent0, uniforms.rightContent1, uniforms.rightContent2, world);
  var right = sphereSurfaceEquirect(rightEquirect, rightEquirectSampler, rightImage, uniforms.rightSize);
#else
#ifdef RIGHT_CUBE
  let rightImage = sphereContentDirection(uniforms.rightContent0, uniforms.rightContent1, uniforms.rightContent2, world);
  var right = textureSample(rightCube, rightCubeSampler, sphereCubeVector(rightImage)).rgb;
#ifdef RIGHT_TILES
  right = sphereTiles(rightTileAtlas, rightTileAtlasSampler, rightTileTable, rightTileTableSampler, right, rightImage, uniforms.rightTileLayout, uniforms.rightTileAtlasInfo);
#endif
#else
  var right = uniforms.background;
#endif
#endif
  let shown = select(right, left, fragmentInputs.vLocal.x < uniforms.wipe);
  fragmentOutputs.color = vec4<f32>(sphereSrgbEncode(shown), 1.0);
}
`;
