/** Camera rigs: third-person orbit, first-person, top-down, side-scroll, vehicle chase. */
import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { CameraKind } from '@spec';

export interface CameraRig {
  update(dt: number, targetPos: THREE.Vector3, targetVel: THREE.Vector3, targetYaw: number): void;
  /** current view yaw (radians) — used to make movement camera-relative */
  yaw: number;
  pitch: number;
  shake(amount: number): void;
  camera: THREE.PerspectiveCamera;
}

export function makeCameraRig(kind: CameraKind, camera: THREE.PerspectiveCamera, input: Input, groundY?: (x: number, z: number) => number): CameraRig {
  let yaw = 0, pitch = kind === 'top-down' ? -1.25 : -0.32;
  let shakeT = 0, shakeAmp = 0;
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const smooth = new THREE.Vector3();
  let fovBase = camera.fov;
  let initialized = false;

  const dist = kind === 'third-person' ? 7.5 : kind === 'chase' ? 9 : kind === 'top-down' ? 26 : kind === 'side' ? 13 : 0;

  return {
    camera,
    get yaw() { return yaw; },
    set yaw(v: number) { yaw = v; },
    get pitch() { return pitch; },
    set pitch(v: number) { pitch = v; },
    shake(amount: number) { shakeAmp = Math.max(shakeAmp, amount); shakeT = 0.4; },

    update(dt, targetPos, targetVel, targetYaw) {
      // look input
      yaw -= input.look.x * 0.0026;
      pitch -= input.look.y * 0.0024;
      const pitchMin = kind === 'top-down' ? -1.35 : kind === 'side' ? -0.2 : -1.2;
      const pitchMax = kind === 'top-down' ? -1.0 : kind === 'side' ? 0.2 : 0.55;
      pitch = Math.max(pitchMin, Math.min(pitchMax, pitch));

      if (kind === 'first-person') {
        pos.copy(targetPos).add(new THREE.Vector3(0, 1.62, 0));
        camera.position.copy(pos);
        camera.rotation.set(0, 0, 0, 'YXZ');
        camera.rotation.order = 'YXZ';
        camera.rotation.y = yaw;
        camera.rotation.x = pitch;
      } else if (kind === 'side') {
        // side scroll: look along +z, follow x/y
        const want = new THREE.Vector3(targetPos.x, targetPos.y + 2.2, targetPos.z + dist);
        if (!initialized) { smooth.copy(want); initialized = true; }
        smooth.lerp(want, 1 - Math.pow(0.001, dt));
        camera.position.copy(smooth);
        look.set(targetPos.x + targetVel.x * 0.35, targetPos.y + 1.4, targetPos.z);
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
        if (kind === 'top-down') pos.copy(targetPos).add(new THREE.Vector3(0, dist, 0.01));
        // never sink under terrain
        if (groundY) {
          const gy = groundY(pos.x, pos.z) + 0.9;
          if (pos.y < gy) pos.y = gy;
        }
        if (!initialized) { smooth.copy(pos); initialized = true; }
        smooth.lerp(pos, 1 - Math.pow(0.0005, dt));
        camera.position.copy(smooth);
        look.copy(targetPos).add(new THREE.Vector3(0, kind === 'chase' ? 1.6 : 1.2, 0));
        if (kind === 'chase') look.addScaledVector(targetVel, 0.14);
        camera.lookAt(look);
      }

      // FOV kick with speed
      const speedK = Math.min(1, targetVel.length() / 30);
      camera.fov = fovBase + speedK * 9;
      camera.updateProjectionMatrix();

      // shake
      if (shakeT > 0) {
        shakeT -= dt;
        const s = shakeAmp * (shakeT / 0.4);
        camera.position.x += (Math.random() - 0.5) * s;
        camera.position.y += (Math.random() - 0.5) * s;
        camera.position.z += (Math.random() - 0.5) * s;
        if (shakeT <= 0) shakeAmp = 0;
      }
    },
  };
}
