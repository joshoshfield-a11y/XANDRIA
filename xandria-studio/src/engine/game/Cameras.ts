/** Camera rigs: third-person orbit, first-person, top-down, side-scroll, vehicle chase. */
import * as THREE from 'three';
import type { Body } from 'cannon-es';
import type { Input } from '../core/Input';
import { GROUP } from '../core/Physics';
import type { Physics } from '../core/Physics';
import type { CameraKind } from '@spec';

export interface CameraRig {
  update(dt: number, targetPos: THREE.Vector3, targetVel: THREE.Vector3, targetYaw: number): void;
  /** current view yaw (radians) — used to make movement camera-relative */
  yaw: number;
  pitch: number;
  shake(amount: number): void;
  camera: THREE.PerspectiveCamera;
}

/**
 * Camera collision options. When supplied, every non-first-person rig probes
 * the physics world each frame with a ray from the look target toward the
 * desired camera position (`Physics.raycast(from, to, mask, skipBody)`) and
 * clamps the boom to (hit − margin) so walls and terrain never swallow the
 * camera. Pass the player/avatar body as `skipBody` — the probe starts at the
 * look target, which is usually inside the avatar's own body, and the
 * wave-beta raycast fix made skipBody a true exclusion (not a post-filter),
 * so the probe sees past the avatar to the real occluder.
 *
 * Blueprints wire this as:
 *   makeCameraRig(kind, engine.camera, input, groundY, { physics: engine.physics, skipBody: avatarBody })
 */
export interface CameraCollisionOpts {
  physics: Physics;
  skipBody?: Body;
  /** collision mask for the probe (default GROUP.WORLD) */
  mask?: number;
}

/**
 * ACCESSIBILITY PASS: module-level reduced-motion flag (set by Engine.
 * applyAccessibility). Rigs are blueprint-owned, so there is no Engine
 * handle to thread this through — the flag is the seam. When set, rig
 * shake() is a no-op and the speed FOV kick is skipped (the only zoom
 * modulation in the game — the "zoom punch" of the brief). Camera
 * collision and framing are untouched.
 */
let cameraReducedMotion = false;

export function setCameraReducedMotion(v: boolean): void {
  cameraReducedMotion = v;
}

export function getCameraReducedMotion(): boolean {
  return cameraReducedMotion;
}

/** camera-to-wall safety margin (meters) */
const COLL_MARGIN = 0.45;
/** regrow speed of the boom after an occlusion clears (m/s of boom fraction) */
const REGROW_RATE = 3.0;

export function makeCameraRig(kind: CameraKind, camera: THREE.PerspectiveCamera, input: Input, groundY?: (x: number, z: number) => number, collision?: CameraCollisionOpts): CameraRig {
  let yaw = 0, pitch = kind === 'top-down' ? -1.25 : -0.32;
  let shakeT = 0, shakeAmp = 0;
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const smooth = new THREE.Vector3();
  let fovBase = camera.fov;
  let initialized = false;

  // rig-local scratch — the whole update path stays allocation-free
  const _v = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  // collision-probe state
  let allowT = 1;      // smoothed fraction of the desired boom length
  let probeTarget = 1; // last raycast result (refreshed every other frame)
  let tick = 0;

  const dist = kind === 'third-person' ? 7.5 : kind === 'chase' ? 9 : kind === 'top-down' ? 26 : kind === 'side' ? 13 : 0;

  /** Clamp `want` along the look→want segment to the last probe result.
   *  Shrinks instantly (a wall crossing the boom never traps the camera
   *  inside geometry), regrows slowly (no popping when the wall passes).
   *  Raycasts every other frame — the smoothing hides the 30 Hz probe. */
  const applyCollision = (dt: number, from: THREE.Vector3, want: THREE.Vector3) => {
    if (!collision) return;
    if ((tick++ & 1) === 0) {
      const segLen = from.distanceTo(want);
      probeTarget = 1;
      if (segLen > 1e-3) {
        const hit = collision.physics.raycast(from, want, collision.mask ?? GROUP.WORLD, collision.skipBody);
        if (hit && hit.distance < segLen - 0.01) {
          probeTarget = Math.max(0.12, (hit.distance - COLL_MARGIN) / segLen);
        }
      }
    }
    if (probeTarget < allowT) allowT = probeTarget;
    else if (probeTarget > allowT) allowT = Math.min(probeTarget, allowT + dt * REGROW_RATE);
    if (allowT < 1) {
      const segLen = from.distanceTo(want);
      if (segLen > 1e-3) {
        _dir.copy(want).sub(from).divideScalar(segLen);
        want.copy(from).addScaledVector(_dir, segLen * allowT);
      }
    }
  };

  return {
    camera,
    get yaw() { return yaw; },
    set yaw(v: number) { yaw = v; },
    get pitch() { return pitch; },
    set pitch(v: number) { pitch = v; },
    shake(amount: number) {
      if (cameraReducedMotion) return;
      shakeAmp = Math.max(shakeAmp, amount); shakeT = 0.4;
    },

    update(dt, targetPos, targetVel, targetYaw) {
      // look input
      yaw -= input.look.x * 0.0026;
      pitch -= input.look.y * 0.0024;
      const pitchMin = kind === 'top-down' ? -1.35 : kind === 'side' ? -0.2 : -1.2;
      const pitchMax = kind === 'top-down' ? -1.0 : kind === 'side' ? 0.2 : 0.55;
      pitch = Math.max(pitchMin, Math.min(pitchMax, pitch));

      if (kind === 'first-person') {
        // exempt from collision: the eye sits at the head, walls are the level's problem
        pos.copy(targetPos);
        pos.y += 1.62;
        camera.position.copy(pos);
        camera.rotation.set(0, 0, 0, 'YXZ');
        camera.rotation.order = 'YXZ';
        camera.rotation.y = yaw;
        camera.rotation.x = pitch;
      } else if (kind === 'side') {
        // side scroll: look along +z, follow x/y
        const lift = kind === 'side' ? 2.2 : 0;
        pos.set(targetPos.x, targetPos.y + lift, targetPos.z + dist);
        look.set(targetPos.x + targetVel.x * 0.35, targetPos.y + 1.4, targetPos.z);
        applyCollision(dt, look, pos);
        if (!initialized) { smooth.copy(pos); initialized = true; }
        smooth.lerp(pos, 1 - Math.pow(0.001, dt));
        camera.position.copy(smooth);
        camera.lookAt(look);
      } else {
        const effDist = kind === 'chase' ? dist + Math.min(6, targetVel.length() * 0.12) : dist;
        // chase cam: yaw eases toward velocity heading unless user is actively orbiting
        if (kind === 'chase' && Math.abs(input.look.x) < 0.01 && targetVel.lengthSq() > 4) {
          const head = Math.atan2(targetVel.x, targetVel.z);
          let d = head - yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          yaw += d * Math.min(1, dt * 3.2);
        }
        // camera sits BEHIND (-forwardXZ) and ABOVE (+height) the target
        const fwdX = Math.sin(yaw) * Math.cos(pitch);
        const fwdZ = Math.cos(yaw) * Math.cos(pitch);
        const height = -Math.sin(pitch) * effDist + (kind === 'third-person' ? 2.0 : 2.6);
        pos.set(
          targetPos.x - fwdX * effDist,
          targetPos.y + height,
          targetPos.z - fwdZ * effDist,
        );
        if (kind === 'top-down') { pos.copy(targetPos); pos.y += dist; pos.z += 0.01; }
        // look target first: the collision probe starts here
        look.copy(targetPos);
        look.y += kind === 'chase' ? 1.6 : 1.2;
        if (kind === 'chase') look.addScaledVector(targetVel, 0.14);
        // camera collision: pull the boom in when a wall/terrain blocks the view
        applyCollision(dt, look, pos);
        // never sink under terrain
        if (groundY) {
          const gy = groundY(pos.x, pos.z) + 0.9;
          if (pos.y < gy) pos.y = gy;
        }
        if (!initialized) { smooth.copy(pos); initialized = true; }
        smooth.lerp(pos, 1 - Math.pow(0.0005, dt));
        camera.position.copy(smooth);
        camera.lookAt(look);
      }

      // FOV kick with speed — skipped under reduced motion (zoom punch).
      const speedK = Math.min(1, targetVel.length() / 30);
      camera.fov = cameraReducedMotion ? fovBase : fovBase + speedK * 9;
      camera.updateProjectionMatrix();

      // shake — a mid-shake reduced-motion toggle cancels it outright
      // (no stale shakeT resuming when the toggle flips back off).
      if (shakeT > 0) {
        shakeT -= dt;
        if (cameraReducedMotion) { shakeAmp = 0; shakeT = 0; }
        else {
        const s = shakeAmp * (shakeT / 0.4);
        camera.position.x += (Math.random() - 0.5) * s;
        camera.position.y += (Math.random() - 0.5) * s;
        camera.position.z += (Math.random() - 0.5) * s;
        if (shakeT <= 0) shakeAmp = 0;
        }
      }
    },
  };
}
