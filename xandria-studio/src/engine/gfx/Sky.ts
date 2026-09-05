/** Sky dome (gradient shader), sun/moon, hemisphere + directional light with shadows, fog, stars. */
import * as THREE from 'three';
import type { GameSpec } from '@spec';

export interface SkyRig {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  update(dt: number, target: THREE.Vector3): void;
  dispose(): void;
}

export function createSky(spec: GameSpec, scene: THREE.Scene): SkyRig {
  const { palette, timeOfDay, weather, environment } = spec.theme;
  const group = new THREE.Group();
  const top = new THREE.Color(palette.sky);
  const bottom = new THREE.Color(palette.horizon);
  const night = timeOfDay === 'night';
  const dusk = timeOfDay === 'dusk' || timeOfDay === 'dawn';
  if (night) { top.multiplyScalar(0.25); bottom.multiplyScalar(0.35); }
  if (dusk) { bottom.lerp(new THREE.Color('#ff9a5c'), 0.45); top.multiplyScalar(0.7); }

  const skyMat = new THREE.ShaderMaterial({
    uniforms: { top: { value: top }, bottom: { value: bottom }, sunDir: { value: new THREE.Vector3(0.3, 0.5, 0.2).normalize() }, sunColor: { value: new THREE.Color(night ? '#c8d8ff' : '#fff2c0') }, time: { value: 0 }, stars: { value: night ? 1 : 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float time; uniform float stars;
      varying vec3 vDir;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 col = mix(bottom, top, pow(max(h,0.0), 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += sunColor * (pow(s, 256.0) * 1.5 + pow(s, 8.0) * 0.25);
        if (stars > 0.5 && h > 0.0) { float st = step(0.997, hash(floor(vDir*180.0))); col += vec3(st) * (0.6 + 0.4*sin(time*3.0 + hash(floor(vDir*180.0))*20.0)); }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), skyMat);
  dome.frustumCulled = false;
  group.add(dome);

  // Clouds: a few flat translucent discs drifting
  const cloudGroup = new THREE.Group();
  if (weather !== 'clear' || environment !== 'space-station') {
    const cm = new THREE.MeshBasicMaterial({ color: night ? '#3a4460' : '#ffffff', transparent: true, opacity: weather === 'storm' ? 0.85 : 0.55, depthWrite: false, fog: false });
    const count = weather === 'clear' ? 10 : 26;
    for (let i = 0; i < count; i++) {
      const w = 60 + Math.random() * 120;
      const c = new THREE.Mesh(new THREE.CircleGeometry(w, 12), cm);
      c.rotation.x = -Math.PI / 2;
      c.position.set((Math.random() - 0.5) * 1400, 180 + Math.random() * 80, (Math.random() - 0.5) * 1400);
      c.scale.set(1, 0.5 + Math.random(), 1);
      cloudGroup.add(c);
    }
  }
  group.add(cloudGroup);

  // Lighting
  const sunColor = night ? new THREE.Color('#7f8fc0') : dusk ? new THREE.Color('#ffb070') : new THREE.Color('#fff4e0');
  const sun = new THREE.DirectionalLight(sunColor, night ? 0.5 : dusk ? 1.6 : 2.2);
  const sunDir = new THREE.Vector3(0.45, dusk ? 0.35 : 0.75, 0.35).normalize();
  sun.position.copy(sunDir).multiplyScalar(140);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 400;
  const sh = 90;
  sun.shadow.camera.left = -sh; sun.shadow.camera.right = sh; sun.shadow.camera.top = sh; sun.shadow.camera.bottom = -sh;
  sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.02;
  skyMat.uniforms.sunDir.value.copy(sunDir);
  group.add(sun); group.add(sun.target);

  const hemi = new THREE.HemisphereLight(top.clone().lerp(new THREE.Color('#ffffff'), 0.3), new THREE.Color(palette.ground).multiplyScalar(0.6), night ? 0.35 : 0.9);
  const ambient = new THREE.AmbientLight('#ffffff', night ? 0.12 : 0.25);
  group.add(hemi, ambient);

  // Fog
  const fogColor = new THREE.Color(palette.fog);
  if (night) fogColor.multiplyScalar(0.35);
  const density = weather === 'fog' ? 0.012 : weather === 'storm' || weather === 'ash' ? 0.007 : environment === 'space-station' ? 0.002 : 0.0035;
  scene.fog = new THREE.FogExp2(fogColor.getHex(), density);
  scene.background = fogColor;

  scene.add(group);
  let t = 0;
  return {
    group, sun, hemi, ambient,
    update(dt, target) {
      t += dt;
      skyMat.uniforms.time.value = t;
      dome.position.copy(target);
      cloudGroup.position.x = target.x + ((t * 4) % 200) - 100;
      cloudGroup.position.z = target.z;
      // keep shadow frustum on the player
      sun.position.copy(target).addScaledVector(sunDir, 140);
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
    },
    dispose() { scene.remove(group); dome.geometry.dispose(); skyMat.dispose(); },
  };
}
