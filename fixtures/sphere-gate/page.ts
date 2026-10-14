/**
 * Stage D panorama gate page. It draws sphere pairs on a real WebGL 1, WebGL 2
 * or WebGPU device and reports measurements. It does not claim Safari.
 */
import { Color3, Color4, Constants, FreeCamera, MeshBuilder, RawCubeTexture, RawTexture, Scene, StandardMaterial, Vector3, WebGPUEngine, Engine, type AbstractEngine } from "@babylonjs/core";
import { GPU_LAYER_SOURCE_FACES, type CubeFaceName } from "@foss-earth/sphere-cubemap";
import { createLookModel, createSphereCameraTarget, createSphereSlot, type LookSettings } from "@foss-earth/image-viewer";
import { anchorSphereCamera, projectSphereRay, sphereRay, sphereViewBasis, type SphereCamera, type SpherePoint } from "@foss-earth/image-viewer";
import { createSphereSurfaceRenderer, sphereSurfaceVariant, type SphereSampling, type SphereSurfaceDraw, type SphereSurfaceKind, type SphereSurfaceSource } from "@foss-earth/image-viewer/babylon";

const FACE_COLOR: Record<CubeFaceName, [number, number, number]> = {
  px: [255, 0, 0], nx: [0, 255, 0], py: [0, 0, 255], ny: [255, 255, 0], pz: [0, 255, 255], nz: [255, 0, 255],
};
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
/** Common +Y becomes image +X. One application, so the centre shows px. */
const YAW_TO_PX = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] as const;
const KINDS: SphereSurfaceKind[] = ["equirectangular", "cube", "tiles"];
const LOOK: LookSettings = {
  dragSensitivity: 0.15, swipeSensitivity: 0.1, lookRate: 90, zoomPerNotch: 0.25, zoomRate: 0.5, pinchGain: 1, inertiaHalfLifeMs: 0,
  fovRangeDeg: { min: 10, max: 140 }, pitchRangeDeg: { min: -85, max: 85 }, reducedMotion: true,
};

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
let engine: AbstractEngine | null = null;
let scene: Scene | null = null;
let webGpu = false;
let bgra = false;
const shaderErrors: string[] = [];
const sources = new Map<string, SphereSurfaceSource>();
let draw: SphereSurfaceDraw | null = null;
let camera: SphereCamera = { headingDeg: 0, pitchDeg: 0, verticalFovDeg: 60 };
let wheelTarget: ReturnType<typeof createSphereCameraTarget> | null = null;
let wheelOn = false;
let wheelRay: readonly [number, number, number] | null = null;
let wheelPoint: SpherePoint | null = null;

function close(actual: readonly number[], expected: readonly number[], tolerance = 12): boolean {
  return actual.length >= 3 && expected.every((channel, index) => Math.abs((actual[index] ?? 255) - channel) <= tolerance);
}

function directionFromUv(u: number, v: number): [number, number, number] {
  const lon = (u - 0.5) * Math.PI * 2, lat = (0.5 - v) * Math.PI;
  return [Math.sin(lon) * Math.cos(lat), Math.cos(lon) * Math.cos(lat), Math.sin(lat)];
}

function dominantFace(direction: readonly [number, number, number]): CubeFaceName {
  const [x, y, z] = direction.map(Math.abs) as [number, number, number];
  if (x >= y && x >= z) return direction[0] >= 0 ? "px" : "nx";
  if (y >= z) return direction[1] >= 0 ? "py" : "ny";
  return direction[2] >= 0 ? "pz" : "nz";
}

function fill(size: number, color: readonly [number, number, number]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([color[0], color[1], color[2], 255], i * 4);
  return data;
}

function equirect(width: number, height: number, paint: (x: number, y: number, u: number, v: number) => [number, number, number]): RawTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width, v = (y + 0.5) / height;
    data.set([...paint(x, y, u, v), 255], (y * width + x) * 4);
  }
  const texture = RawTexture.CreateRGBATexture(data, width, height, scene, false, false, Constants.TEXTURE_LINEAR_LINEAR, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  texture.gammaSpace = true;
  texture.name = "sphere-gate-equirect";
  return texture;
}

function cube(): RawCubeTexture {
  const size = 32;
  const data = GPU_LAYER_SOURCE_FACES.map(face => fill(size, FACE_COLOR[face]));
  const texture = new RawCubeTexture(scene!, data, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  texture.gammaSpace = true;
  texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
  texture.name = "sphere-gate-cube";
  return texture;
}

function viewSize() {
  const cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssW * dpr)), height = Math.max(1, Math.round(cssH * dpr));
  if (engine!.getRenderWidth(true) !== width || engine!.getRenderHeight(true) !== height) engine!.setSize(width, height);
  return { cssW, cssH, width: engine!.getRenderWidth(true), height: engine!.getRenderHeight(true), dpr };
}

function viewportOf(size: { cssW: number; cssH: number }) {
  return { width: size.cssW, height: size.cssH };
}

function makeDraw(size: ReturnType<typeof viewSize>, left: SphereSurfaceKind | null, right: SphereSurfaceKind | null, sampling: SphereSampling, wipe: number, pose = camera): SphereSurfaceDraw {
  return {
    framebufferRect: { x: 0, y: 0, width: size.width, height: size.height },
    basis: sphereViewBasis(pose, viewportOf(size)),
    left: left ? { source: sources.get(left) ?? null } : null,
    right: right ? { source: sources.get(right + "-yaw") ?? null } : null,
    wipe, sampling, background: [0, 0, 0],
  };
}

/** Reads while the frame's color attachment is still bound. WebGPU has none after the pass ends. */
function readDuringFrame(points: readonly SpherePoint[]): Promise<[number, number, number][]> {
  return new Promise((resolve, reject) => {
    const observer = scene!.onAfterRenderObservable.add(() => {
      scene!.onAfterRenderObservable.remove(observer);
      void (async () => {
        try {
          const width = engine!.getRenderWidth(true), height = engine!.getRenderHeight(true);
          const cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
          const colors: [number, number, number][] = [];
          for (const point of points) {
            const x = Math.min(width - 1, Math.max(0, Math.floor(point.x * width / cssW)));
            const yTop = Math.min(height - 1, Math.max(0, Math.floor(point.y * height / cssH)));
            const y = webGpu ? yTop : height - 1 - yTop;
            const data = await engine!.readPixels(x, y, 1, 1, true, webGpu);
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const r0 = bytes[0] ?? 0, g = bytes[1] ?? 0, b0 = bytes[2] ?? 0;
            colors.push(bgra ? [b0, g, r0] : [r0, g, b0]);
          }
          resolve(colors);
        } catch (error) { reject(error); }
      })();
    });
    if (webGpu) engine!.beginFrame();
    scene!.render();
    if (webGpu) engine!.endFrame();
  });
}

async function sample(cssX: number, cssY: number): Promise<[number, number, number]> {
  const [color] = await readDuringFrame([{ x: cssX, y: cssY }]);
  return color ?? [0, 0, 0];
}

function untouched(color: readonly number[]): boolean {
  return (color[0] === 51 && color[1] === 51 && color[2] === 77) || (color[0] === 77 && color[1] === 51 && color[2] === 51) || (color[0] === 0 && color[1] === 0 && color[2] === 0 && color.length === 3);
}

async function renderAt(next: SphereSurfaceDraw | null): Promise<void> {
  draw = next;
  const center = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  for (let i = 0; i < 20; i++) {
    const [color] = await readDuringFrame([center]);
    if (i >= 2 && color && !untouched(color)) return;
  }
}

function check(name: string, ok: boolean, details: Record<string, unknown> = {}) {
  return { name, ok, details };
}

async function boot(backend: "webgl" | "webgl2" | "webgpu") {
  shaderErrors.length = 0;
  if (backend === "webgpu") {
    const gpu = new WebGPUEngine(canvas, { antialias: false, stencil: false, preserveDrawingBuffer: true });
    await gpu.initAsync();
    engine = gpu;
    webGpu = true;
    bgra = String((gpu as { _options?: { swapChainFormat?: string } })._options?.swapChainFormat ?? "").startsWith("bgra");
  } else {
    engine = new Engine(canvas, false, { disableWebGL2Support: backend === "webgl", stencil: false, adaptToDeviceRatio: false, preserveDrawingBuffer: true });
    webGpu = false;
    bgra = false;
  }
  scene = new Scene(engine);
  scene.clearColor = new Color4(0.2, 0.2, 0.3, 1);
  const view = new FreeCamera("gate", new Vector3(0, 0, -10), scene);
  view.setTarget(Vector3.Zero());
  scene.activeCamera = view;
  // WebGPU opens a render pass only when the camera draws something. The surface
  // then draws into that pass; a scene with no visible mesh never binds a color target.
  const dummy = MeshBuilder.CreateBox("sphere-gate-pass", { size: 0.2 }, scene);
  const dummyMaterial = new StandardMaterial("sphere-gate-pass", scene);
  dummyMaterial.diffuseColor = new Color3(0.2, 0.2, 0.3);
  dummy.material = dummyMaterial;
  const renderer = createSphereSurfaceRenderer(scene, {
    requestRender() { /* The gate renders explicitly. */ },
    onError(message) { shaderErrors.push(message.slice(0, 700)); },
  });
  renderer.addSurface(() => draw);
  const size = viewSize();
  const faceEquirect = equirect(256, 128, (_x, _y, u, v) => FACE_COLOR[dominantFace(directionFromUv(u, v))]);
  const faces = cube();
  const atlas = RawTexture.CreateRGBATexture(fill(8, [255, 255, 255]), 8, 8, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  atlas.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE; atlas.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE; atlas.gammaSpace = true;
  const tableData = new Uint8Array(6 * 2 * 4);
  const table = RawTexture.CreateRGBATexture(tableData, 6, 2, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
  table.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE; table.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE; table.gammaSpace = false;
  const tiles = { atlas, table, layout: [1, 8, 0, 8] as const, atlasSize: [8, 8] as const, warp: "gnomonic" as const, outlines: false };
  const put = (key: string, texture: SphereSurfaceSource["texture"], kind: SphereSurfaceKind, content: typeof IDENTITY, extra?: Partial<SphereSurfaceSource>) => {
    sources.set(key, { texture, kind, width: kind === "equirectangular" ? 256 : 32, height: kind === "equirectangular" ? 128 : 32, contentFromCommon: content, ...extra });
  };
  put("equirectangular", faceEquirect, "equirectangular", IDENTITY);
  put("equirectangular-yaw", faceEquirect, "equirectangular", YAW_TO_PX);
  put("cube", faces, "cube", IDENTITY);
  put("cube-yaw", faces, "cube", YAW_TO_PX);
  put("tiles", faces, "tiles", IDENTITY, { tiles });
  put("tiles-yaw", faces, "tiles", YAW_TO_PX, { tiles });
  const caps = engine.getCaps();
  const gl = (engine as { _gl?: WebGLRenderingContext })._gl;
  return {
    available: renderer.available,
    unavailableReason: renderer.unavailableReason,
    backend: webGpu ? "webgpu" : engine.webGLVersion === 1 ? "webgl" : engine.webGLVersion >= 2 ? "webgl2" : "unknown",
    webGLVersion: webGpu ? null : engine.webGLVersion,
    renderer: gl?.getParameter(gl.RENDERER) ?? (webGpu ? "webgpu" : null),
    maxTextureSize: caps.maxTextureSize,
    maxTextureImageUnits: gl ? gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) : null,
    dpr: size.dpr, css: { width: size.cssW, height: size.cssH }, framebuffer: { width: size.width, height: size.height },
    bgra, shaderErrors: [...shaderErrors],
  };
}

const centre = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });

async function runPairs() {
  const checks = [];
  const leftPose: SphereCamera = { headingDeg: 0, pitchDeg: 0, verticalFovDeg: 50 };
  for (const left of KINDS) for (const right of KINDS) {
    const size = viewSize();
    camera = leftPose;
    const before = { ...camera };
    await renderAt(makeDraw(size, left, right, "nearest", 0.5, camera));
    const leftColor = await sample(size.cssW * 0.25, size.cssH * 0.5);
    const rightColor = await sample(size.cssW * 0.75, size.cssH * 0.5);
    const name = `${left}/${right}`;
    checks.push(check(`pair ${name} left is the forward face`, close(leftColor, FACE_COLOR.py), { leftColor, expected: FACE_COLOR.py }));
    checks.push(check(`pair ${name} right is one +X orientation`, close(rightColor, FACE_COLOR.px), { rightColor, expected: FACE_COLOR.px }));
    draw = makeDraw(size, left, right, "nearest", 0.15, camera);
    await renderAt(draw, 2);
    checks.push(check(`pair ${name} wipe leaves the camera`, camera.headingDeg === before.headingDeg && camera.pitchDeg === before.pitchDeg && camera.verticalFovDeg === before.verticalFovDeg, { camera, before }));
    const afterLeft = await sample(size.cssW * 0.05, size.cssH * 0.5);
    const afterRight = await sample(size.cssW * 0.9, size.cssH * 0.5);
    checks.push(check(`pair ${name} wipe is a screen split`, close(afterLeft, FACE_COLOR.py) && close(afterRight, FACE_COLOR.px), { afterLeft, afterRight }));
  }
  return checks;
}

async function runFixtures() {
  const checks = [];
  const size = viewSize();
  const view = viewportOf(size);
  const seam: SphereCamera = { headingDeg: 180, pitchDeg: 0, verticalFovDeg: 40 };
  await renderAt(makeDraw(size, "equirectangular", null, "linear", 1, seam));
  const seamColor = await sample(size.cssW / 2, size.cssH / 2);
  checks.push(check("equirect seam at the back face stays the back face", close(seamColor, FACE_COLOR.ny, 30) && !close(seamColor, FACE_COLOR.py, 30), { seamColor }));
  const pole: SphereCamera = { headingDeg: 0, pitchDeg: 80, verticalFovDeg: 30 };
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, pole));
  const poleColor = await sample(size.cssW / 2, size.cssH / 2);
  const basis = sphereViewBasis(pole, view);
  checks.push(check("pole sample is +Z and the basis has no roll", close(poleColor, FACE_COLOR.pz) && Math.abs(basis.right[2]) < 1e-6, { poleColor, rightZ: basis.right[2] }));
  return checks;
}

function paintAnchor(point: SpherePoint, pose: SphereCamera) {
  const size = viewSize();
  const ray = sphereRay(pose, viewportOf(size), point);
  const u = Math.atan2(ray[0], ray[1]) / (Math.PI * 2) + 0.5;
  const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, ray[2]))) / Math.PI;
  const texture = equirect(256, 128, (x, y) => {
    const uu = (x + 0.5) / 256, vv = (y + 0.5) / 128;
    const du = Math.abs(uu - u), dv = Math.abs(vv - v);
    return du < 3 / 256 && dv < 3 / 128 ? [255, 0, 0] : [0, 0, 255];
  });
  sources.set("equirectangular", { texture, kind: "equirectangular", width: 256, height: 128, contentFromCommon: IDENTITY });
  return ray;
}

async function runAnchor() {
  const checks = [];
  const size = viewSize();
  const view = viewportOf(size);
  const point = { x: size.cssW * 0.72, y: size.cssH * 0.36 };
  camera = { headingDeg: 12, pitchDeg: -6, verticalFovDeg: 55 };
  const ray = paintAnchor(point, camera);
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, camera), 6);
  const before = await sample(point.x, point.y);
  checks.push(check("anchor marker is under the pointer before zoom", close(before, [255, 0, 0]), { before, point }));
  const next = anchorSphereCamera(camera, view, ray, point, 28, { fovDeg: LOOK.fovRangeDeg, pitchDeg: LOOK.pitchRangeDeg }, point);
  camera = next;
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, camera), 3);
  const after = await sample(point.x, point.y);
  const projected = projectSphereRay(camera, view, ray);
  const error = projected ? Math.hypot(projected.x - point.x, projected.y - point.y) : Infinity;
  checks.push(check("anchored zoom keeps the marker within one framebuffer pixel", close(after, [255, 0, 0]) && error * size.dpr <= 1, { after, errorCss: error, errorPx: error * size.dpr, camera }));
  const wrapped = anchorSphereCamera({ headingDeg: 350, pitchDeg: 4, verticalFovDeg: 70 }, view, sphereRay({ headingDeg: 350, pitchDeg: 4, verticalFovDeg: 70 }, view, { x: size.cssW * 0.8, y: size.cssH * 0.5 }), { x: size.cssW * 0.8, y: size.cssH * 0.5 }, 30, { fovDeg: LOOK.fovRangeDeg, pitchDeg: LOOK.pitchRangeDeg });
  const turn = ((wrapped.headingDeg - 350 + 540) % 360) - 180;
  checks.push(check("heading wraps through the near branch", turn > 0 && turn < 40 && wrapped.headingDeg < 40, { heading: wrapped.headingDeg, turn }));
  const poleStart: SphereCamera = { headingDeg: 15, pitchDeg: 78, verticalFovDeg: 40 };
  const polePoint = { x: size.cssW * 0.78, y: size.cssH * 0.72 };
  const poleRay = sphereRay(poleStart, view, polePoint);
  const limited = anchorSphereCamera(poleStart, view, poleRay, polePoint, 130, { fovDeg: { min: 10, max: 140 }, pitchDeg: { min: -85, max: 85 } }, polePoint);
  const poleError = projectSphereRay(limited, view, poleRay);
  const poleDistance = poleError ? Math.hypot(poleError.x - polePoint.x, poleError.y - polePoint.y) : Infinity;
  const poleTurn = Math.abs(((limited.headingDeg - 15 + 540) % 360) - 180);
  checks.push(check("near a pole the zoom stops on a feasible pose without roll or the far branch",
    limited.verticalFovDeg < 130 && limited.verticalFovDeg > 40 && limited.pitchDeg <= 85 && limited.pitchDeg > 70 && poleDistance < 0.25 && poleTurn < 80 && Math.abs(sphereViewBasis(limited, view).right[2]) < 1e-5,
    { camera: limited, poleDistance, poleTurn }));
  return checks;
}

async function runTilesAndPublish() {
  const checks = [];
  const size = viewSize();
  const point = centre();
  const pose: SphereCamera = { headingDeg: 0, pitchDeg: 0, verticalFovDeg: 40 };
  await renderAt(makeDraw(size, "tiles", null, "nearest", 1, pose), 6);
  const preview = await sample(point.x, point.y);
  checks.push(check("a tiled source with no resident tile shows the preview", close(preview, FACE_COLOR.py), { preview }));
  const table = sources.get("tiles")?.tiles?.table as RawTexture | undefined;
  const ready = new Uint8Array(6 * 2 * 4);
  ready.set([0, 0, 1, 255], 2 * 4);
  table?.update(ready);
  await renderAt(draw, 4);
  const resident = await sample(point.x, point.y);
  checks.push(check("a ready tile replaces that cell without a second source", close(resident, [255, 255, 255]), { resident }));
  const variant = sphereSurfaceVariant("tiles", "tiles");
  const gl = (engine as { _gl?: WebGLRenderingContext })._gl;
  const units = gl ? gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number : 16;
  checks.push(check("a tiled pair binds six samplers and stays inside the device", variant.samplers.length === 6 && variant.samplers.length <= units, { samplers: variant.samplers, units }));
  await renderAt(makeDraw(size, "tiles", "tiles", "nearest", 0.5, pose), 4);
  const pairLeft = await sample(size.cssW * 0.25, size.cssH * 0.5);
  const pairRight = await sample(size.cssW * 0.75, size.cssH * 0.5);
  checks.push(check("tiled/tiled draws the resident cell and the other orientation", close(pairLeft, [255, 255, 255]) && close(pairRight, FACE_COLOR.px), { pairLeft, pairRight }));
  const slot = createSphereSlot<SphereSurfaceSource>();
  slot.publish(0, sources.get("cube")!);
  const show = async () => {
    draw = { ...makeDraw(size, null, null, "nearest", 1, pose), left: { source: slot.published }, right: null };
    await renderAt(draw, 3);
    return sample(point.x, point.y);
  };
  const original = await show();
  const token = slot.revise();
  const staleAccepted = slot.publish(0, sources.get("equirectangular-yaw")!);
  const stale = await show();
  checks.push(check("a stale publish leaves the picture", staleAccepted === false && close(stale, original) && close(original, FACE_COLOR.py), { original, stale }));
  const replacedAccepted = slot.publish(token, sources.get("equirectangular-yaw")!);
  const replaced = await show();
  checks.push(check("a current publish replaces the whole source", replacedAccepted && close(replaced, FACE_COLOR.px), { replaced }));
  const cancelled = slot.revise();
  slot.clear();
  const cleared = await show();
  const lateAccepted = slot.publish(cancelled, sources.get("cube")!);
  const late = await show();
  checks.push(check("clearing drops the picture and a cancelled token cannot put it back", close(cleared, [0, 0, 0]) && lateAccepted === false && close(late, [0, 0, 0]), { cleared, late }));
  return checks;
}

async function runLive() {
  const checks = [];
  const size = viewSize();
  const view = viewportOf(size);
  const point = { x: size.cssW * 0.68, y: size.cssH * 0.42 };
  let state: SphereCamera = { headingDeg: 20, pitchDeg: 5, verticalFovDeg: 60 };
  paintAnchor(point, state);
  const model = createLookModel(state, () => LOOK, next => { state = next; }, () => view);
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, state), 4);
  const before = await sample(point.x, point.y);
  const ray = sphereRay(state, view, point);
  model.wheel(-100, point);
  camera = state;
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, state), 3);
  const after = await sample(point.x, point.y);
  const projected = projectSphereRay(state, view, ray);
  const error = projected ? Math.hypot(projected.x - point.x, projected.y - point.y) : Infinity;
  checks.push(check("live look keeps an off-centre wheel on the same ray", close(before, [255, 0, 0]) && close(after, [255, 0, 0]) && error < 0.25 && state.verticalFovDeg < 60, { before, after, error, fov: state.verticalFovDeg }));
  return checks;
}

function prepareWheel() {
  const size = viewSize();
  const point = { x: size.cssW * 0.7, y: size.cssH * 0.4 };
  camera = { headingDeg: 8, pitchDeg: -4, verticalFovDeg: 60 };
  wheelPoint = point;
  wheelRay = paintAnchor(point, camera);
  wheelTarget = createSphereCameraTarget({
    get: () => camera,
    set: next => { camera = next; },
    viewport: () => viewportOf(viewSize()),
    settings: () => LOOK,
  });
  wheelOn = true;
  void renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, camera), 4);
  return { x: point.x, y: point.y, fov: camera.verticalFovDeg };
}

async function finishWheel() {
  wheelOn = false;
  const size = viewSize();
  const point = { x: size.cssW * 0.7, y: size.cssH * 0.4 };
  await renderAt(makeDraw(size, "equirectangular", null, "nearest", 1, camera), 3);
  const color = await sample(point.x, point.y);
  const projected = wheelRay && wheelPoint ? projectSphereRay(camera, viewportOf(size), wheelRay) : null;
  const error = projected && wheelPoint ? Math.hypot(projected.x - wheelPoint.x, projected.y - wheelPoint.y) : Infinity;
  return { color, error, camera: { ...camera }, shaderErrors: [...shaderErrors] };
}

canvas.addEventListener("wheel", event => {
  if (!wheelOn || !wheelTarget) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  wheelTarget.wheel(event.deltaY, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });

const api = {
  ready: true,
  boot,
  async run(backend: "webgl" | "webgl2" | "webgpu") {
    const info = await boot(backend);
    const checks = [
      check("the requested backend is the one drawing", info.backend === backend, { info }),
      check("sphere surfaces are available", info.available, { reason: info.unavailableReason }),
      ...(await runPairs()),
      ...(await runFixtures()),
      ...(await runAnchor()),
      ...(await runTilesAndPublish()),
      ...(await runLive()),
      check("no shader or draw error was reported", shaderErrors.length === 0, { shaderErrors }),
    ];
    return { info, checks, failed: checks.filter(item => !item.ok).length };
  },
  prepareWheel,
  finishWheel,
};
(window as unknown as { __sphereGate: typeof api }).__sphereGate = api;
