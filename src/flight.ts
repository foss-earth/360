/** Retained orb entry/exit paths; world math supplied by the host. */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "@foss-earth/images";
import type { ViewBasis } from "./math.js";
import type { ViewerWorldMath, ViewerNavigationSnapshot } from "./ports.js";
const RAD_TO_DEG = 180 / Math.PI;
export interface FlightPose {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
  verticalFovRad: number;
}

export interface Flight {
  /** The sphere the flight passes through, drawn at this radius throughout, metres. */
  radiusMeters: number;
  /** The pose at eased progress `s`, from 0 to 1. */
  pose(s: number): FlightPose;
}

/** How far inside the sphere a flight ends or starts, as a share of its radius: well inside, where every ray is covered. */
export const INSIDE_SHARE = 0.5;

/** The signed angle about the unit `axis` that turns `from` to `to`, both across it, radians. */
function angleAbout(from: Vec3, to: Vec3, axis: Vec3): number {
  return Math.atan2(dot(cross(from, to), axis), dot(from, to));
}

/** `v`, across the unit `axis`, turned about it by `angle` radians. */
function turnAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  return add(scale(v, Math.cos(angle)), scale(cross(axis, v), Math.sin(angle)));
}

/** Part way along the great circle from `a` to `b`; opposite directions turn about `pivot`. */
function slerp(a: Vec3, b: Vec3, s: number, pivot: Vec3): Vec3 {
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (angle < 1e-9) return normalize(add(scale(a, 1 - s), scale(b, s)));
  let axis = cross(a, b);
  if (length(axis) < 1e-9) axis = sub(pivot, scale(a, dot(pivot, a)));
  return normalize(turnAbout(a, normalize(axis), angle * s));
}

/** Distance part way from `from` to `to` by the same factor each moment: steady growth on screen. */
const geometric = (from: number, to: number, s: number): number => from * Math.pow(to / from, s);

/** A pose's view for the coverage tests, with the viewport's aspect. */
export function poseView(pose: FlightPose, aspect: number): ViewBasis {
  return { forward: pose.forward, up: pose.up, right: normalize(cross(pose.forward, pose.up)), verticalFovRad: pose.verticalFovRad, aspect };
}

/**
 * Into an orb from where the camera is: straight at its marker while turning
 * to face it, to `INSIDE_SHARE` of the radius inside a sphere of
 * `radiusMeters`. The roll the view starts with, relative to level, unwinds
 * on the way. Null when the eye is already inside the sphere.
 */
export function flightIn(world: ViewerWorldMath, start: FlightPose, marker: Vec3, radiusMeters: number): Flight | null {
  const rel = sub(marker, start.position);
  const distance = length(rel);
  if (!(radiusMeters > 0) || !(distance > radiusMeters)) return null;
  const axis = scale(rel, 1 / distance);
  const vertical = normalize(marker);
  const roll = angleAbout(world.levelUp(start.forward, vertical, start.up), start.up, start.forward);
  const inside = radiusMeters * INSIDE_SHARE;
  return {
    radiusMeters,
    pose(s) {
      const forward = slerp(start.forward, axis, s, start.up);
      return {
        position: sub(marker, scale(axis, geometric(distance, inside, s))),
        forward,
        up: turnAbout(world.levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: start.verticalFovRad,
      };
    },
  };
}

/**
 * Out of an orb, backing away from the way the view faces: from
 * `INSIDE_SHARE` of the radius inside a sphere of `radiusMeters` to the view
 * that keeps the heading and looks at the marker with the saved overview's
 * pitch, distance and field of view. `end` is that view as the globe
 * camera's snapshot, centred on the marker. The view's roll unwinds on the
 * way. Null when that view would be inside the sphere.
 */
export function flightOut(world: ViewerWorldMath, start: Omit<FlightPose, "position">, marker: Vec3, radiusMeters: number, overview: ViewerNavigationSnapshot["camera"]): (Flight & { end: ViewerNavigationSnapshot }) | null {
  const far = overview.radius;
  if (!(radiusMeters > 0) || !(far > radiusMeters)) return null;
  const vertical = normalize(marker);
  const { yaw, pitch } = world.orbitAngles(marker, start.forward, overview.yaw);
  const roll = angleAbout(world.levelUp(start.forward, vertical, start.up), start.up, start.forward);
  const inside = radiusMeters * INSIDE_SHARE;
  const place = world.pointGeodetic(marker);
  return {
    radiusMeters,
    pose(s) {
      const forward = world.orbitLook(marker, yaw, pitch + (overview.pitch - pitch) * s);
      return {
        position: sub(marker, scale(forward, geometric(inside, far, s))),
        forward,
        up: turnAbout(world.levelUp(forward, vertical, start.up), forward, roll * (1 - s)),
        verticalFovRad: start.verticalFovRad + (overview.fov - start.verticalFovRad) * s,
      };
    },
    end: {
      version: 1,
      view: {
        latDeg: place.latitudeDeg,
        lonDeg: place.longitudeDeg,
        headingDeg: (((yaw * RAD_TO_DEG) % 360) + 360) % 360,
        pitchDeg: 90 * (1 - (2 * overview.pitch) / Math.PI),
        zoomMeters: far,
      },
      camera: { center: { x: marker[0], y: marker[1], z: marker[2] }, yaw, pitch: overview.pitch, radius: far, fov: overview.fov },
    },
  };
}

/** How far either side of a pose, in eased progress, a flight's motion is measured. */
const MOTION_PROBE = 1e-4;

/**
 * How fast a flight moves at eased progress `s`, going at `rate` progress
 * per second: its eye's velocity, m/s, and how fast its look turns (the
 * look's derivative), 1/s.
 */
export function flightMotion(flight: Flight, s: number, rate: number): { velocity: Vec3; turn: Vec3 } {
  const from = Math.max(0, s - MOTION_PROBE);
  const to = Math.min(1, s + MOTION_PROBE);
  const a = flight.pose(from);
  const b = flight.pose(to);
  const per = rate / (to - from);
  return { velocity: scale(sub(b.position, a.position), per), turn: scale(sub(b.forward, a.forward), per) };
}

