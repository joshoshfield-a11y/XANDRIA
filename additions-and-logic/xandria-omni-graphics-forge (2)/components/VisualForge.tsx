
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createNoise2D } from 'simplex-noise';

interface VisualForgeProps {
  onInteract?: (type: string) => void;
}

const VisualForge: React.FC<VisualForgeProps> = ({ onInteract }) => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    let isMounted = true;
    let animationFrameId: number;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x00050a, 0.0008);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
    camera.position.set(0, 100, 300);
    
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        logarithmicDepthBuffer: true,
        powerPreference: "high-performance"
      });
    } catch (e) {
      console.error("XANDRIA: Failed to create WebGL context", e);
      return;
    }

    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    const noise2D = createNoise2D();
    const loader = new GLTFLoader();
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const ASSET_URLS = {
      TREE: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/SpruceTree/glTF-Binary/SpruceTree.glb',
      ROCK: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Rock/glTF-Binary/Rock.glb'
    };

    const generatePBRTextures = (size: number = 1024) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const albedoData = ctx.createImageData(size, size);
      for (let i = 0; i < albedoData.data.length; i += 4) {
        const x = (i / 4) % size;
        const y = Math.floor((i / 4) / size);
        const n = (noise2D(x / 64, y / 64) + 1) / 2;
        albedoData.data[i] = 15 + 20 * n;
        albedoData.data[i + 1] = 25 + 35 * n;
        albedoData.data[i + 2] = 10 + 15 * n;
        albedoData.data[i + 3] = 255;
      }
      ctx.putImageData(albedoData, 0, 0);
      const albedoMap = new THREE.CanvasTexture(canvas);
      albedoMap.wrapS = albedoMap.wrapT = THREE.RepeatWrapping;
      albedoMap.repeat.set(10, 10);
      return { albedoMap };
    };
    const textures = generatePBRTextures();

    const sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    const sun = new THREE.Vector3();
    const sunLight = new THREE.DirectionalLight(0xfff5e1, 3.5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    scene.add(sunLight);

    // --- TERRAIN GENESIS ---
    const terrainGeo = new THREE.PlaneGeometry(2000, 2000, 128, 128);
    const terrainPos = terrainGeo.attributes.position.array;
    for (let i = 0; i < terrainPos.length; i += 3) {
      const x = terrainPos[i];
      const y = terrainPos[i + 1];
      terrainPos[i + 2] = noise2D(x / 200, y / 200) * 50 + noise2D(x / 50, y / 50) * 12;
    }
    terrainGeo.computeVertexNormals();
    
    // Custom Terrain Material with Height-Based Shading
    const terrainMat = new THREE.MeshStandardMaterial({ 
      map: textures.albedoMap, 
      roughness: 1.0, 
      metalness: 0.05 
    });
    
    terrainMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
         varying float vHeight;`
      ).replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vHeight = position.z;`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
         varying float vHeight;`
      ).replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float h = clamp(vHeight / 60.0, 0.0, 1.0);
         vec3 mountainColor = vec3(0.5, 0.45, 0.4);
         vec3 valleyColor = vec3(0.1, 0.15, 0.05);
         diffuseColor.rgb = mix(diffuseColor.rgb, mix(valleyColor, mountainColor, h), 0.4);
        `
      );
    };

    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.receiveShadow = true;
    scene.add(terrain);

    // --- OP-08 BLOOM: MICRO-DETAIL ASSETS ---
    const FOREST_COUNT = 400;
    const ROCK_COUNT = 300;
    const GRASS_COUNT = 25000;
    const PEBBLE_COUNT = 1500;
    const SHRUB_COUNT = 800;
    
    const dummy = new THREE.Object3D();
    const originalMatrices: { [key: string]: THREE.Matrix4[] } = { tree: [], rock: [], pebble: [], shrub: [] };
    
    let treeInst: THREE.InstancedMesh;
    let rockInst: THREE.InstancedMesh;
    let grassInst: THREE.InstancedMesh;
    let pebbleInst: THREE.InstancedMesh;
    let shrubInst: THREE.InstancedMesh;

    const animations = new Map<string, { mesh: THREE.InstancedMesh, index: number, startTime: number, originalMatrix: THREE.Matrix4 }>();

    // Grass & Detail Materials
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x446622, side: THREE.DoubleSide, roughness: 1.0 });
    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.vertexShader = `uniform float time; ${shader.vertexShader}`.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vec4 worldPos = instanceMatrix * vec4(position, 1.0);
        float sway = sin(time * 2.0 + worldPos.x * 0.2 + worldPos.z * 0.2) * (position.y * 0.5);
        transformed.x += sway;
        transformed.z += sway * 0.5;
      `);
      grassMat.userData.shader = shader;
    };

    const initializeAssets = async () => {
      try {
        const [treeGltf, rockGltf] = await Promise.all([
          loader.loadAsync(ASSET_URLS.TREE),
          loader.loadAsync(ASSET_URLS.ROCK)
        ]);

        if (!isMounted) return;

        const treeMesh = (treeGltf.scene.children[0] as THREE.Mesh);
        treeInst = new THREE.InstancedMesh(treeMesh.geometry, treeMesh.material, FOREST_COUNT);
        treeInst.name = "tree";
        
        const rockMesh = (rockGltf.scene.children[0] as THREE.Mesh);
        rockInst = new THREE.InstancedMesh(rockMesh.geometry, rockMesh.material, ROCK_COUNT);
        rockInst.name = "rock";
      } catch (e) {
        if (!isMounted) return;
        treeInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 1, 15, 8), new THREE.MeshStandardMaterial({ color: 0x2a1a0f }), FOREST_COUNT);
        treeInst.name = "tree";
        rockInst = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(2, 0), new THREE.MeshStandardMaterial({ color: 0x444444 }), ROCK_COUNT);
        rockInst.name = "rock";
      }

      // Micro Detail Genesis
      const pebbleGeo = new THREE.DodecahedronGeometry(0.5, 0);
      const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.9 });
      pebbleInst = new THREE.InstancedMesh(pebbleGeo, pebbleMat, PEBBLE_COUNT);
      pebbleInst.name = "pebble";

      const shrubGeo = new THREE.ConeGeometry(1, 2, 5);
      const shrubMat = new THREE.MeshStandardMaterial({ color: 0x224411, roughness: 1.0 });
      shrubInst = new THREE.InstancedMesh(shrubGeo, shrubMat, SHRUB_COUNT);
      shrubInst.name = "shrub";

      const grassGeo = new THREE.PlaneGeometry(0.5, 4, 1, 4);
      grassGeo.translate(0, 2, 0);
      grassInst = new THREE.InstancedMesh(grassGeo, grassMat, GRASS_COUNT);
      grassInst.name = "grass";

      [treeInst, rockInst, grassInst, pebbleInst, shrubInst].forEach(m => {
        m.castShadow = true; m.receiveShadow = true; scene.add(m);
      });

      let tIdx = 0, rIdx = 0, gIdx = 0, pIdx = 0, sIdx = 0;
      for (let i = 0; i < 60000; i++) {
        const x = (Math.random() - 0.5) * 1950;
        const z = (Math.random() - 0.5) * 1950;
        const h = noise2D(x / 200, -z / 200) * 50 + noise2D(x / 50, -z / 50) * 12;

        if (h > 1.5) {
          const dice = Math.random();
          dummy.position.set(x, h - 0.2, z);
          
          if (dice < 0.015 && tIdx < FOREST_COUNT) {
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.scale.setScalar(0.4 + Math.random() * 1.2);
            dummy.updateMatrix();
            treeInst.setMatrixAt(tIdx++, dummy.matrix);
            originalMatrices.tree.push(dummy.matrix.clone());
          } else if (dice < 0.03 && rIdx < ROCK_COUNT) {
            dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            dummy.scale.setScalar(1 + Math.random() * 4);
            dummy.updateMatrix();
            rockInst.setMatrixAt(rIdx++, dummy.matrix);
            originalMatrices.rock.push(dummy.matrix.clone());
          } else if (dice < 0.08 && sIdx < SHRUB_COUNT) {
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.scale.setScalar(0.5 + Math.random() * 1.0);
            dummy.updateMatrix();
            shrubInst.setMatrixAt(sIdx++, dummy.matrix);
            originalMatrices.shrub.push(dummy.matrix.clone());
          } else if (dice < 0.15 && pIdx < PEBBLE_COUNT) {
            dummy.rotation.set(Math.random(), Math.random(), Math.random());
            dummy.scale.setScalar(0.5 + Math.random() * 1.5);
            dummy.updateMatrix();
            pebbleInst.setMatrixAt(pIdx++, dummy.matrix);
            originalMatrices.pebble.push(dummy.matrix.clone());
          } else if (gIdx < GRASS_COUNT) {
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.scale.set(1, 0.4 + Math.random() * 1.6, 1);
            dummy.updateMatrix();
            grassInst.setMatrixAt(gIdx++, dummy.matrix);
          }
        }
      }
      [treeInst, rockInst, grassInst, pebbleInst, shrubInst].forEach(m => {
        m.instanceMatrix.needsUpdate = true;
      });
    };

    initializeAssets();

    const water = new Water(new THREE.PlaneGeometry(5000, 5000), {
      textureWidth: 512, textureHeight: 512,
      waterNormals: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/waternormals.jpg', t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; }),
      sunDirection: sun, sunColor: 0xffffff, waterColor: 0x001e0f, distortionScale: 5.0,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = -10;
    scene.add(water);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.6, 0.3, 0.9));

    const handleClick = (event: MouseEvent) => {
      mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const targets = [];
      if (treeInst) targets.push(treeInst);
      if (rockInst) targets.push(rockInst);
      if (shrubInst) targets.push(shrubInst);
      if (pebbleInst) targets.push(pebbleInst);
      
      const intersects = raycaster.intersectObjects(targets);
      if (intersects.length > 0) {
        const intersection = intersects[0];
        const index = intersection.instanceId;
        const mesh = intersection.object as THREE.InstancedMesh;
        if (index !== undefined) {
          const type = mesh.name;
          const key = `${type}-${index}`;
          if (!animations.has(key)) {
            animations.set(key, { 
              mesh, index, startTime: performance.now(), originalMatrix: originalMatrices[type][index].clone() 
            });
            if (onInteract) onInteract(`SIGNAL_DETECTED: ${type.toUpperCase()}_${index}`);
          }
        }
      }
    };
    window.addEventListener('click', handleClick);

    const clock = new THREE.Clock();
    const animate = () => {
      if (!isMounted) return;
      animationFrameId = requestAnimationFrame(animate);
      const delta = clock.getElapsedTime();
      const now = performance.now();
      
      water.material.uniforms['time'].value += 1.0 / 60.0;
      if (grassMat.userData.shader) {
        grassMat.userData.shader.uniforms.time.value = delta;
      }
      
      const cycleSpeed = 0.05;
      const phi = Math.acos(Math.cos(delta * cycleSpeed)); 
      const theta = delta * cycleSpeed * 0.5;
      sun.setFromSphericalCoords(1, phi, theta);
      sky.material.uniforms['sunPosition'].value.copy(sun);
      sunLight.position.copy(sun).multiplyScalar(500);
      
      const sunHeight = Math.cos(phi);
      sunLight.intensity = Math.max(0, sunHeight * 3.5);
      const dawnColor = new THREE.Color(0xffaa44);
      const noonColor = new THREE.Color(0xfff5e1);
      sunLight.color.lerpColors(dawnColor, noonColor, Math.max(0, sunHeight));
      (scene.fog as THREE.FogExp2).density = 0.0008 + (1 - Math.max(0, sunHeight)) * 0.0015;

      animations.forEach((anim, key) => {
        const elapsed = (now - anim.startTime) / 1000;
        if (elapsed > 1) {
          anim.mesh.setMatrixAt(anim.index, anim.originalMatrix);
          anim.mesh.instanceMatrix.needsUpdate = true;
          animations.delete(key);
        } else {
          const scale = 1 + Math.sin(elapsed * Math.PI * 4) * 0.2 * (1 - elapsed);
          const mat = anim.originalMatrix.clone();
          const p = new THREE.Vector3(); const r = new THREE.Quaternion(); const s = new THREE.Vector3();
          mat.decompose(p, r, s); s.multiplyScalar(scale); mat.compose(p, r, s);
          anim.mesh.setMatrixAt(anim.index, mat); anim.mesh.instanceMatrix.needsUpdate = true;
        }
      });

      const camR = 500 + Math.sin(delta * 0.05) * 150;
      camera.position.x = Math.sin(delta * 0.02) * camR;
      camera.position.z = Math.cos(delta * 0.02) * camR;
      camera.position.y = 120 + Math.sin(delta * 0.07) * 40;
      camera.lookAt(0, -20, 0);

      composer.render();
    };
    animate();

    const handleResize = () => {
      const w = mountRef.current?.clientWidth || 0;
      const h = mountRef.current?.clientHeight || 0;
      renderer.setSize(w, h);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      isMounted = false;
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('click', handleClick);
      cancelAnimationFrame(animationFrameId);
      scene.traverse((object: any) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) object.material.forEach((m: any) => m.dispose());
          else object.material.dispose();
        }
      });
      textures.albedoMap.dispose();
      renderer.dispose();
      composer.dispose();
      if (mountRef.current && renderer.domElement) mountRef.current.removeChild(renderer.domElement);
    };
  }, [onInteract]);

  return <div ref={mountRef} className="w-full h-full bg-black cursor-crosshair" />;
};

export default VisualForge;
