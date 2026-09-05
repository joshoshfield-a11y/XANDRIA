
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { createNoise2D } from 'simplex-noise';

const VisualForge: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 4000);
    camera.position.set(0, 50, 200);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    const noise2D = createNoise2D();

    // --- PROCEDURAL TEXTURES ---
    const generatePBRTextures = (size: number = 1024) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const albedoData = ctx.createImageData(size, size);
      for (let i = 0; i < albedoData.data.length; i += 4) {
        const x = (i / 4) % size;
        const y = Math.floor((i / 4) / size);
        const n = (noise2D(x / 64, y / 64) + 1) / 2;
        albedoData.data[i] = 20 + 20 * n;
        albedoData.data[i + 1] = 30 + 30 * n;
        albedoData.data[i + 2] = 10 + 10 * n;
        albedoData.data[i + 3] = 255;
      }
      ctx.putImageData(albedoData, 0, 0);
      const albedoMap = new THREE.CanvasTexture(canvas);
      albedoMap.wrapS = albedoMap.wrapT = THREE.RepeatWrapping;
      albedoMap.repeat.set(4, 4);
      return { albedoMap };
    };
    const textures = generatePBRTextures();

    // --- SKY & SUN ---
    const sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    const sun = new THREE.Vector3();
    const sunLight = new THREE.DirectionalLight(0xfff5e1, 4.0);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    scene.add(sunLight);
    const phi = THREE.MathUtils.degToRad(85); 
    const theta = THREE.MathUtils.degToRad(180);
    sun.setFromSphericalCoords(1, phi, theta);
    sky.material.uniforms['sunPosition'].value.copy(sun);
    sunLight.position.copy(sun).multiplyScalar(300);

    // --- TERRAIN ---
    const terrainGeo = new THREE.PlaneGeometry(1200, 1200, 256, 256);
    const terrainPos = terrainGeo.attributes.position.array;
    for (let i = 0; i < terrainPos.length; i += 3) {
      const x = terrainPos[i];
      const y = terrainPos[i + 1];
      terrainPos[i + 2] = noise2D(x / 120, y / 120) * 25 + noise2D(x / 30, y / 30) * 6;
    }
    terrainGeo.computeVertexNormals();
    const terrainMat = new THREE.MeshStandardMaterial({ map: textures.albedoMap, roughness: 0.9 });
    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.receiveShadow = true;
    scene.add(terrain);

    // --- LOD GEOMETRY POOLS (OP-08 BLOOM) ---
    const LOD_DISTANCES = { HIGH: 180, MED: 350 };
    const TOTAL_TREES = 600;

    // Materials
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0f });
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x0a2a0a, roughness: 0.9 });
    const oakMat = new THREE.MeshStandardMaterial({ color: 0x2a3a0a, emissive: 0x0a1100, emissiveIntensity: 0.2 });
    const willowMat = new THREE.MeshStandardMaterial({ color: 0x220033, emissive: 0xaa00aa, emissiveIntensity: 0.4 });

    // Geometries per TIER
    const pineHigh = { trunk: new THREE.CylinderGeometry(0.1, 0.6, 12, 8), leaf: new THREE.ConeGeometry(3, 6, 8) };
    const pineMed = { trunk: new THREE.CylinderGeometry(0.1, 0.6, 12, 5), leaf: new THREE.ConeGeometry(3, 6, 5) };
    const pineLow = { trunk: new THREE.ConeGeometry(1, 15, 4), leaf: new THREE.BufferGeometry() }; // Merged low poly look

    const oakHigh = { trunk: new THREE.CylinderGeometry(0.5, 0.8, 8, 8), leaf: new THREE.IcosahedronGeometry(3.5, 1) };
    const oakMed = { trunk: new THREE.CylinderGeometry(0.5, 0.8, 8, 5), leaf: new THREE.IcosahedronGeometry(3.5, 0) };
    const oakLow = { trunk: new THREE.CylinderGeometry(0.6, 0.8, 12, 3), leaf: new THREE.SphereGeometry(3, 4, 3) };

    const willowHigh = { trunk: new THREE.CylinderGeometry(0.3, 0.4, 10, 8), leaf: new THREE.TorusKnotGeometry(2.2, 0.6, 48, 8) };
    const willowMed = { trunk: new THREE.CylinderGeometry(0.3, 0.4, 10, 4), leaf: new THREE.TorusKnotGeometry(2.2, 0.6, 16, 4) };
    const willowLow = { trunk: new THREE.BoxGeometry(0.5, 10, 0.5), leaf: new THREE.IcosahedronGeometry(3, 0) };

    // Create 3 InstancedMeshes per Species Group (High, Med, Low)
    const speciesGroups = [
      { id: 'pine', mats: [trunkMat, pineMat], geos: [pineHigh, pineMed, pineLow], count: 0, instances: [] as any[] },
      { id: 'oak', mats: [trunkMat, oakMat], geos: [oakHigh, oakMed, oakLow], count: 0, instances: [] as any[] },
      { id: 'willow', mats: [trunkMat, willowMat], geos: [willowHigh, willowMed, willowLow], count: 0, instances: [] as any[] }
    ];

    const allLODMeshes: { [key: string]: THREE.InstancedMesh[] } = {};

    speciesGroups.forEach(group => {
      allLODMeshes[`${group.id}_trunks`] = group.geos.map(g => new THREE.InstancedMesh(g.trunk, group.mats[0], TOTAL_TREES));
      allLODMeshes[`${group.id}_leaves`] = group.geos.map(g => new THREE.InstancedMesh(g.leaf, group.mats[1], TOTAL_TREES * 4));
      
      allLODMeshes[`${group.id}_trunks`].forEach(m => { m.castShadow = true; m.receiveShadow = true; scene.add(m); });
      allLODMeshes[`${group.id}_leaves`].forEach(m => { m.castShadow = true; m.receiveShadow = true; scene.add(m); });
    });

    // Generate Tree data
    const treeData: any[] = [];
    const dummy = new THREE.Object3D();
    for (let i = 0; i < TOTAL_TREES; i++) {
      const x = (Math.random() - 0.5) * 800;
      const z = (Math.random() - 0.5) * 800;
      const h = noise2D(x / 120, -z / 120) * 25 + noise2D(x / 30, -z / 30) * 6;
      if (h > 2) {
        treeData.push({
          pos: new THREE.Vector3(x, h, z),
          rotY: Math.random() * Math.PI,
          scale: 0.8 + Math.random() * 0.5,
          type: i % 3 // 0: Pine, 1: Oak, 2: Willow
        });
      }
    }

    const updateLOD = () => {
      const camPos = camera.position;

      // Reset counts
      const counts: any = {};
      Object.keys(allLODMeshes).forEach(key => {
        counts[key] = [0, 0, 0];
      });

      treeData.forEach(tree => {
        const dist = tree.pos.distanceTo(camPos);
        let lodIdx = 2; // Default Low
        if (dist < LOD_DISTANCES.HIGH) lodIdx = 0;
        else if (dist < LOD_DISTANCES.MED) lodIdx = 1;

        const species = speciesGroups[tree.type].id;
        const trunkKey = `${species}_trunks`;
        const leafKey = `${species}_leaves`;

        // Update Trunk Matrix
        dummy.position.copy(tree.pos).add(new THREE.Vector3(0, tree.type === 0 ? 6 : (tree.type === 1 ? 4 : 5), 0));
        dummy.rotation.set(0, tree.rotY, 0);
        dummy.scale.setScalar(tree.scale);
        dummy.updateMatrix();
        allLODMeshes[trunkKey][lodIdx].setMatrixAt(counts[trunkKey][lodIdx]++, dummy.matrix);

        // Update Leaf Matrix
        if (tree.type === 0) { // Pine
          for (let l = 0; l < 3; l++) {
            dummy.position.copy(tree.pos).add(new THREE.Vector3(0, 8 + l * 3, 0));
            dummy.scale.setScalar(tree.scale * (1.2 - l * 0.3));
            dummy.updateMatrix();
            allLODMeshes[leafKey][lodIdx].setMatrixAt(counts[leafKey][lodIdx]++, dummy.matrix);
          }
        } else if (tree.type === 1) { // Oak
          const offsets = [[0, 6, 0], [2, 7, 1], [-2, 7, -1], [0, 9, 0]];
          offsets.forEach(off => {
            dummy.position.copy(tree.pos).add(new THREE.Vector3(off[0], off[1], off[2]));
            dummy.scale.setScalar(tree.scale * (0.8 + Math.random() * 0.2));
            dummy.updateMatrix();
            allLODMeshes[leafKey][lodIdx].setMatrixAt(counts[leafKey][lodIdx]++, dummy.matrix);
          });
        } else { // Willow
          dummy.position.copy(tree.pos).add(new THREE.Vector3(0, 10, 0));
          dummy.scale.setScalar(tree.scale * 1.5);
          dummy.updateMatrix();
          allLODMeshes[leafKey][lodIdx].setMatrixAt(counts[leafKey][lodIdx]++, dummy.matrix);
        }
      });

      // Update Needs
      Object.keys(allLODMeshes).forEach(key => {
        allLODMeshes[key].forEach((mesh, idx) => {
          mesh.count = counts[key][idx];
          mesh.instanceMatrix.needsUpdate = true;
        });
      });
    };

    // --- WATER ---
    const water = new Water(new THREE.PlaneGeometry(3000, 3000), {
      textureWidth: 512, textureHeight: 512,
      waterNormals: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/waternormals.jpg', t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; }),
      sunDirection: sun, sunColor: 0xffffff, waterColor: 0x001e0f, distortionScale: 3.7,
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = -8;
    scene.add(water);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.7, 0.4, 0.85));

    const clock = new THREE.Clock();
    const animate = () => {
      const delta = clock.getElapsedTime();
      water.material.uniforms['time'].value += 1.0 / 60.0;
      
      const r = 250 + Math.sin(delta * 0.1) * 60;
      camera.position.x = Math.sin(delta * 0.05) * r;
      camera.position.z = Math.cos(delta * 0.05) * r;
      camera.position.y = 60 + Math.sin(delta * 0.15) * 20;
      camera.lookAt(0, -10, 0);

      updateLOD();
      composer.render();
      requestAnimationFrame(animate);
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
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeChild(renderer.domElement);
      renderer.dispose();
      composer.dispose();
    };
  }, []);

  return <div ref={mountRef} className="w-full h-full" />;
};

export default VisualForge;
