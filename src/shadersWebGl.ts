import { SRGB_ENCODE_GLSL, SRGB_DECODE_GLSL } from "@foss-earth/images/shaders";
import { CUBE_VECTOR_GLSL } from "@foss-earth/sphere-cubemap/shaders";
import { EQUIRECT_UV_GLSL, EQUIRECT_SAMPLE_GLSL, EQUIRECT_UV_UNIT_GLSL } from "@foss-earth/sphere-equirectangular/shaders";
import { TILE_LOOKUP_GLSL } from "@foss-earth/sphere-tiled-cubemap/shaders";
import { RECTANGLE_IMAGE_GLSL } from "@foss-earth/rectangle-image/shaders";
/**
 * GLSL counterpart of sphereShaders.ts, owned by FOSS Earth's renderer.
 * The same analytic quad and immersion triangle work on WebGL 1 and 2;
 * Babylon translates attributes, varyings and fragment depth for WebGL 2.
 * WebGL textures hold encoded sRGB. Decode before blending and encode once
 * at output, matching WebGPU's native sRGB texture sampling contract.
 *
 * SOURCE_TILES and NEXT_TILES draw a tiled cube (src/scenes/tiles/) over the
 * preview cube the same draw samples: sphereTiles looks the direction's cell
 * up in the display table and takes one bilinear tap from the atlas.
 *
 * SPHERE_LEAN (the renderer.experiments.panoramaShaders parameter) draws
 * the same image with less per-pixel work: the orb's cap angle and window
 * come from the CPU (its depth keeps this shader's arithmetic), immersion
 * turns the view into the image's frame in the vertex shader, and a ray is
 * normalized once where it must be, or not at all for a cube lookup, which
 * only needs its direction.
 */

const EXTENSIONS = /* glsl */ `
#extension GL_OES_standard_derivatives : require
#ifdef SPHERE_TEXTURE_GRADIENTS
#extension GL_EXT_shader_texture_lod : enable
#endif
precision highp float;
`;

const CONTENT_UNIFORMS = /* glsl */ `
uniform vec3 content0;
uniform vec3 content1;
uniform vec3 content2;
`;

const COMMON = /* glsl */ `
${SRGB_DECODE_GLSL}

${SRGB_ENCODE_GLSL}

vec3 sphereImageDirection(vec3 worldDirection) {
  return vec3(dot(content0, worldDirection), dot(content1, worldDirection), dot(content2, worldDirection));
}

${CUBE_VECTOR_GLSL}

${EQUIRECT_UV_UNIT_GLSL}

${EQUIRECT_UV_GLSL}

${TILE_LOOKUP_GLSL}

${EQUIRECT_SAMPLE_GLSL}
`;

export const ORB_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewRotProj;
uniform vec3 quadCenter;
uniform vec3 quadU;
uniform vec3 quadV;
varying vec3 vRel;
void main(void) {
  vec3 rel = quadCenter + position.x * quadU + position.y * quadV;
  vRel = rel;
  gl_Position = viewRotProj * vec4(rel, 1.0);
}
`;

export const ORB_FRAGMENT_GLSL = /* glsl */ `
#extension GL_EXT_frag_depth : require
${EXTENSIONS}
uniform mat4 viewRotProj;
uniform vec3 markerRel;
uniform float radius;
uniform float tanPreviewHalfAngle;
uniform float opacity;
uniform vec4 outlineColor;
uniform float outlineWidth;
#ifdef SPHERE_LEAN
// The same for every pixel of a draw, so worked out once on the CPU (ORB_LEAN_UNIFORMS).
uniform float sinAlpha;
uniform float windowGain;
uniform float identityWindow;
#endif
${CONTENT_UNIFORMS}
#ifdef SOURCE_EQUIRECT
uniform sampler2D sphereEquirect;
#else
uniform samplerCube sphereCube;
#endif
#ifdef SOURCE_TILES
uniform sampler2D tileAtlas;
uniform sampler2D tileTable;
uniform vec4 tileLayout;
uniform vec4 tileAtlasInfo;
#endif
varying vec3 vRel;
${COMMON}

void main(void) {
  vec3 v = normalize(vRel);
#ifdef SPHERE_LEAN
  // The distance, axis and depth keep the full shader's arithmetic: orbs that
  // nearly coincide on screen must settle their depth ties the same way.
  float d = length(markerRel);
  vec3 a = markerRel / d;
  float c = dot(a, v);
  vec3 k = v - c * a;
  float sinDelta = length(k);
  bool inside = d <= radius;
#else
  float d = length(markerRel);
  vec3 a = markerRel / d;
  float c = dot(a, v);
  vec3 k = v - c * a;
  float sinDelta = length(k);
  bool inside = d <= radius;
  float sinAlpha = min(radius / d, 1.0);
  float cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  float tanAlpha = sinAlpha / max(cosAlpha, 1e-7);
#endif
  float edge = sinAlpha - sinDelta;
  float edgeWidth = max(fwidth(sinDelta), 1e-7);
  float front = c > 0.0 ? 1.0 : 0.0;
  float exterior = clamp(edge / edgeWidth + 0.5, 0.0, 1.0) * front;
  float coverage = inside ? 1.0 : exterior;
  float pixelStep = max(length(vec2(dFdx(sinDelta), dFdy(sinDelta))), 1e-9);
  float ringOuter = clamp(edge / pixelStep + outlineWidth + 0.5, 0.0, 1.0) * front;
  float ring = (inside ? 0.0 : max(ringOuter - exterior, 0.0)) * outlineColor.a;

#ifdef SPHERE_LEAN
  // Only its direction is sampled: the equirectangular lookup normalizes it once, a cube needs no length.
  vec3 worldDirection = identityWindow > 0.5 ? v : a + k * (windowGain / max(c, 1e-4));
#else
  float gain = tanPreviewHalfAngle / max(tanAlpha, 1e-7);
  vec3 windowed = normalize(a + k * (gain / max(c, 1e-4)));
  vec3 worldDirection = (inside || tanAlpha >= tanPreviewHalfAngle) ? v : windowed;
#endif
  vec3 imageDirection = sphereImageDirection(worldDirection);
#ifdef SOURCE_EQUIRECT
  vec4 sampled = sphereSeamlessSample(sphereEquirect, sphereEquirectUv(imageDirection));
#else
  vec4 sampled = textureCube(sphereCube, sphereCubeVector(imageDirection));
#endif
#ifdef SOURCE_TILES
  sampled.rgb = sphereTiles(tileAtlas, tileTable, sampled.rgb, imageDirection, tileLayout, tileAtlasInfo);
#endif

  float b = c * d;
  float root = sqrt(max(radius * radius - d * d + b * b, 0.0));
  float t = inside ? b + root : b - root;
  vec4 clip = viewRotProj * vec4(v * max(t, 0.0), 1.0);
#ifdef OUTPUT_DIRECTION
  if (coverage <= 0.0) discard;
#ifdef SPHERE_LEAN
  gl_FragColor = vec4(normalize(imageDirection), coverage);
#else
  gl_FragColor = vec4(imageDirection, coverage);
#endif
#else
#ifdef OUTPUT_RAY
  if (coverage <= 0.0) discard;
  gl_FragColor = vec4(v, coverage);
#else
  float shown = coverage + ring;
  if (shown <= 0.0) discard;
  vec3 rgb = (sampled.rgb * coverage + outlineColor.rgb * ring) / shown;
  gl_FragColor = vec4(rgb, shown * opacity);
#endif
#endif
  // WebGL's projection maps depth to [-1, 1], unlike WebGPU's [0, 1].
  gl_FragDepthEXT = clamp(0.5 * (clip.z / clip.w) + 0.5, 0.0, 1.0);
}
`;

export const IMMERSION_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 inverseViewRotProj;
#ifdef SPHERE_LEAN
// The view ray in each image's frame, divided by its w on the CPU: w is the
// same at every corner, so the rotation is linear across the triangle.
uniform mat4 imageFromClip;
uniform mat4 nextImageFromClip;
varying vec3 vImage;
varying vec3 vNextImage;
#ifdef OUTPUT_RAY
varying vec4 vRay;
#endif
#else
varying vec4 vRay;
#endif
void main(void) {
  vec4 clip = vec4(position.xy, 0.5, 1.0);
#ifdef SPHERE_LEAN
  vImage = (imageFromClip * clip).xyz;
  vNextImage = (nextImageFromClip * clip).xyz;
#ifdef OUTPUT_RAY
  vRay = inverseViewRotProj * clip;
#endif
#else
  vRay = inverseViewRotProj * clip;
#endif
  gl_Position = clip;
}
`;

export const IMMERSION_FRAGMENT_GLSL = /* glsl */ `
${EXTENSIONS}
uniform float opacity;
uniform float mixWeight;
${CONTENT_UNIFORMS}
uniform vec3 nextContent0;
uniform vec3 nextContent1;
uniform vec3 nextContent2;
#ifdef SOURCE_EQUIRECT
uniform sampler2D sphereEquirect;
#else
uniform samplerCube sphereCube;
#endif
#ifdef NEXT_EQUIRECT
uniform sampler2D nextEquirect;
#endif
#ifdef NEXT_CUBE
uniform samplerCube nextCube;
#endif
#ifdef SOURCE_TILES
uniform sampler2D tileAtlas;
uniform sampler2D tileTable;
uniform vec4 tileLayout;
uniform vec4 tileAtlasInfo;
#endif
#ifdef NEXT_TILES
uniform sampler2D nextTileAtlas;
uniform sampler2D nextTileTable;
uniform vec4 nextTileLayout;
uniform vec4 nextTileAtlasInfo;
#endif
#ifdef SPHERE_LEAN
varying vec3 vImage;
#ifdef NEXT_EQUIRECT
varying vec3 vNextImage;
#endif
#ifdef NEXT_CUBE
varying vec3 vNextImage;
#endif
#ifdef OUTPUT_RAY
varying vec4 vRay;
#endif
#else
varying vec4 vRay;
#endif
${COMMON}

void main(void) {
#ifdef SPHERE_LEAN
#ifdef SOURCE_EQUIRECT
  vec3 imageDirection = normalize(vImage);
  vec3 color = sphereSeamlessSample(sphereEquirect, sphereEquirectUvUnit(imageDirection)).rgb;
#else
  vec3 imageDirection = vImage;
  vec3 color = textureCube(sphereCube, sphereCubeVector(imageDirection)).rgb;
#endif
#ifdef NEXT_EQUIRECT
  vec3 nextImage = normalize(vNextImage);
#endif
#ifdef NEXT_CUBE
  vec3 nextImage = vNextImage;
#endif
#else
  vec3 v = normalize(vRay.xyz / vRay.w);
  vec3 imageDirection = sphereImageDirection(v);
#ifdef SOURCE_EQUIRECT
  vec3 color = sphereSeamlessSample(sphereEquirect, sphereEquirectUv(imageDirection)).rgb;
#else
  vec3 color = textureCube(sphereCube, sphereCubeVector(imageDirection)).rgb;
#endif
  vec3 nextImage = vec3(dot(nextContent0, v), dot(nextContent1, v), dot(nextContent2, v));
#endif
#ifdef SOURCE_TILES
  color = sphereTiles(tileAtlas, tileTable, color, imageDirection, tileLayout, tileAtlasInfo);
#endif
#ifdef NEXT_EQUIRECT
#ifdef SPHERE_LEAN
  color = sphereSrgbEncode(mix(sphereSrgbDecode(color), sphereSrgbDecode(sphereSeamlessSample(nextEquirect, sphereEquirectUvUnit(nextImage)).rgb), mixWeight));
#else
  color = sphereSrgbEncode(mix(sphereSrgbDecode(color), sphereSrgbDecode(sphereSeamlessSample(nextEquirect, sphereEquirectUv(nextImage)).rgb), mixWeight));
#endif
#endif
#ifdef NEXT_CUBE
  vec3 nextColor = textureCube(nextCube, sphereCubeVector(nextImage)).rgb;
#ifdef NEXT_TILES
  nextColor = sphereTiles(nextTileAtlas, nextTileTable, nextColor, nextImage, nextTileLayout, nextTileAtlasInfo);
#endif
  color = sphereSrgbEncode(mix(sphereSrgbDecode(color), sphereSrgbDecode(nextColor), mixWeight));
#endif
#ifdef OUTPUT_DIRECTION
#ifdef SPHERE_LEAN
  gl_FragColor = vec4(normalize(imageDirection), 1.0);
#else
  gl_FragColor = vec4(imageDirection, 1.0);
#endif
#else
#ifdef OUTPUT_RAY
#ifdef SPHERE_LEAN
  gl_FragColor = vec4(normalize(vRay.xyz / vRay.w), 1.0);
#else
  gl_FragColor = vec4(v, 1.0);
#endif
#else
  // The steady view has no crossfade: avoid decoding and encoding every
  // pixel when the encoded sample is already the desired display color.
  gl_FragColor = vec4(color, opacity);
#endif
#endif
}
`;

/** The orb's per-draw constants under SPHERE_LEAN, set by the renderer from its float64 geometry. */
export const ORB_LEAN_UNIFORMS = ["sinAlpha", "windowGain", "identityWindow"] as const;
/** Immersion's view-to-image matrices under SPHERE_LEAN. */
export const IMMERSION_LEAN_UNIFORMS = ["imageFromClip", "nextImageFromClip"] as const;

/**
 * GLSL counterpart of RECTANGLE_SURFACE_VERTEX and RECTANGLE_SURFACE_FRAGMENT. WebGL
 * textures hold encoded sRGB: samples are decoded, the background is linear,
 * and output is encoded once. With RECTANGLE_GRADIENTS (WebGL 2, or WebGL 1 with
 * derivatives and texture LOD) both sources take explicit gradients of the
 * continuous coordinate, and none for a nearest view; without it, implicit
 * gradients, biased far down for a nearest view so it reads level 0.
 */
export const RECTANGLE_SURFACE_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform vec4 planeRect;
varying vec2 vLocal;
varying vec2 vPlane;
void main(void) {
  vLocal = vec2(position.x, 1.0 - position.y);
  vPlane = planeRect.xy + vLocal * planeRect.zw;
  gl_Position = vec4(position.xy * 2.0 - 1.0, 0.5, 1.0);
}
`;

export const RECTANGLE_SURFACE_FRAGMENT_GLSL = /* glsl */ `
#if defined(RECTANGLE_GRADIENTS) && !defined(SPHERE_WEBGL2)
#extension GL_OES_standard_derivatives : require
#extension GL_EXT_shader_texture_lod : require
#endif
precision highp float;
uniform vec2 extent;
uniform float wipe;
uniform float nearest;
uniform vec3 background;
#ifdef RECTANGLE_LEFT
uniform sampler2D leftImage;
uniform vec2 leftSize;
#endif
#ifdef RECTANGLE_RIGHT
uniform sampler2D rightImage;
uniform vec2 rightSize;
#endif
varying vec2 vLocal;
varying vec2 vPlane;
${SRGB_DECODE_GLSL}
${SRGB_ENCODE_GLSL}
${RECTANGLE_IMAGE_GLSL}

vec3 rectangleSurfaceSample(sampler2D image, vec2 size, vec2 uv, vec2 dx, vec2 dy) {
  vec2 at = mix(uv, rectangleNearestTexelUv(uv, size), nearest);
#ifdef RECTANGLE_GRADIENTS
  float keep = 1.0 - nearest;
#ifdef SPHERE_WEBGL2
  vec4 texel = textureGrad(image, at, dx * keep, dy * keep);
#else
  vec4 texel = texture2DGradEXT(image, at, dx * keep, dy * keep);
#endif
#else
  vec4 texel = texture2D(image, at, -16.0 * nearest);
#endif
  return sphereSrgbDecode(texel.rgb);
}

void main(void) {
  vec2 uv = rectangleImageUv(vPlane, extent);
  float covered = rectangleImageCoverage(vPlane, extent);
#ifdef RECTANGLE_GRADIENTS
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
#else
  vec2 dx = vec2(0.0);
  vec2 dy = vec2(0.0);
#endif
#ifdef RECTANGLE_LEFT
  vec3 left = rectangleSurfaceSample(leftImage, leftSize, uv, dx, dy);
#else
  vec3 left = background;
#endif
#ifdef RECTANGLE_RIGHT
  vec3 right = rectangleSurfaceSample(rightImage, rightSize, uv, dx, dy);
#else
  vec3 right = background;
#endif
  vec3 shown = vLocal.x < wipe ? left : right;
  gl_FragColor = vec4(sphereSrgbEncode(mix(background, shown, covered)), 1.0);
}
`;

export const SPHERE_SURFACE_VERTEX_GLSL = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vLocal;
void main(void) {
  vLocal = vec2(position.x, 1.0 - position.y);
  gl_Position = vec4(position.xy * 2.0 - 1.0, 0.5, 1.0);
}
`;

/**
 * WebGL twin of the sphere surface. Samples are encoded sRGB; both sides are
 * decoded, mixed with the linear background, and encoded once. Tiles return
 * an encoded colour, so that result is decoded after the lookup.
 */
export const SPHERE_SURFACE_FRAGMENT_GLSL = /* glsl */ `
#if !defined(SPHERE_WEBGL2)
#extension GL_OES_standard_derivatives : enable
#endif
#ifdef SPHERE_TEXTURE_GRADIENTS
#extension GL_EXT_shader_texture_lod : enable
#endif
precision highp float;
varying vec2 vLocal;
uniform vec3 forward;
uniform vec3 right;
uniform vec3 up;
uniform float tanHalf;
uniform float aspect;
uniform float wipe;
uniform float nearest;
uniform vec3 background;
#if defined(LEFT_EQUIRECT) || defined(LEFT_CUBE)
uniform vec3 leftContent0;
uniform vec3 leftContent1;
uniform vec3 leftContent2;
#endif
#ifdef LEFT_EQUIRECT
uniform sampler2D leftEquirect;
uniform vec2 leftSize;
#endif
#ifdef LEFT_CUBE
uniform samplerCube leftCube;
#endif
#ifdef LEFT_TILES
uniform sampler2D leftTileAtlas;
uniform sampler2D leftTileTable;
uniform vec4 leftTileLayout;
uniform vec4 leftTileAtlasInfo;
#endif
#if defined(RIGHT_EQUIRECT) || defined(RIGHT_CUBE)
uniform vec3 rightContent0;
uniform vec3 rightContent1;
uniform vec3 rightContent2;
#endif
#ifdef RIGHT_EQUIRECT
uniform sampler2D rightEquirect;
uniform vec2 rightSize;
#endif
#ifdef RIGHT_CUBE
uniform samplerCube rightCube;
#endif
#ifdef RIGHT_TILES
uniform sampler2D rightTileAtlas;
uniform sampler2D rightTileTable;
uniform vec4 rightTileLayout;
uniform vec4 rightTileAtlasInfo;
#endif
${SRGB_DECODE_GLSL}
${SRGB_ENCODE_GLSL}
${CUBE_VECTOR_GLSL}
${EQUIRECT_UV_UNIT_GLSL}
${EQUIRECT_UV_GLSL}
${EQUIRECT_SAMPLE_GLSL}
${TILE_LOOKUP_GLSL}

vec3 sphereSurfaceDirection(vec2 local) {
  return normalize(forward + right * ((local.x * 2.0 - 1.0) * tanHalf * aspect) + up * ((1.0 - local.y * 2.0) * tanHalf));
}

vec3 sphereContentDirection(vec3 c0, vec3 c1, vec3 c2, vec3 world) {
  return vec3(dot(c0, world), dot(c1, world), dot(c2, world));
}

vec3 sphereSurfaceEquirect(sampler2D tex, vec3 image, vec2 size) {
  vec2 uv = sphereEquirectUv(image);
  if (nearest > 0.5) {
    vec2 snapped = (floor(uv * size) + vec2(0.5)) / size;
    return texture2D(tex, snapped).rgb;
  }
  return sphereSeamlessSample(tex, uv).rgb;
}

void main(void) {
  vec3 world = sphereSurfaceDirection(vLocal);
#ifdef LEFT_EQUIRECT
  vec3 leftImage = sphereContentDirection(leftContent0, leftContent1, leftContent2, world);
  vec3 left = sphereSrgbDecode(sphereSurfaceEquirect(leftEquirect, leftImage, leftSize));
#else
#ifdef LEFT_CUBE
  vec3 leftImage = sphereContentDirection(leftContent0, leftContent1, leftContent2, world);
  vec3 leftEncoded = textureCube(leftCube, sphereCubeVector(leftImage)).rgb;
#ifdef LEFT_TILES
  leftEncoded = sphereTiles(leftTileAtlas, leftTileTable, leftEncoded, leftImage, leftTileLayout, leftTileAtlasInfo);
#endif
  vec3 left = sphereSrgbDecode(leftEncoded);
#else
  vec3 left = background;
#endif
#endif
#ifdef RIGHT_EQUIRECT
  vec3 rightImage = sphereContentDirection(rightContent0, rightContent1, rightContent2, world);
  vec3 right = sphereSrgbDecode(sphereSurfaceEquirect(rightEquirect, rightImage, rightSize));
#else
#ifdef RIGHT_CUBE
  vec3 rightImage = sphereContentDirection(rightContent0, rightContent1, rightContent2, world);
  vec3 rightEncoded = textureCube(rightCube, sphereCubeVector(rightImage)).rgb;
#ifdef RIGHT_TILES
  rightEncoded = sphereTiles(rightTileAtlas, rightTileTable, rightEncoded, rightImage, rightTileLayout, rightTileAtlasInfo);
#endif
  vec3 right = sphereSrgbDecode(rightEncoded);
#else
  vec3 right = background;
#endif
#endif
  vec3 shown = vLocal.x < wipe ? left : right;
  gl_FragColor = vec4(sphereSrgbEncode(shown), 1.0);
}
`;
