
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

    // --- INITIALIZATION ---
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
    camera.position.set(0, 10, 30);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    const noise2D = createNoise2D();

    // --- OP-22 MATRIX: SKY & SUN ---
    const sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);

    const sun = new THREE.Vector3();
    const effectController = {
      turbidity: 10,
      rayleigh: 3,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.7,
      elevation: 5,
      azimuth: 180,
    };

    const updateSky = () => {
      const uniforms = sky.material.uniforms;
      uniforms['turbidity'].value = effectController.turbidity;
      uniforms['rayleigh'].value = effectController.rayleigh;
      uniforms['mieCoefficient'].value = effectController.mieCoefficient;
      uniforms['mieDirectionalG'].value = effectController.mieDirectionalG;

      const phi = THREE.MathUtils.degToRad(90 - effectController.elevation);
      const theta = THREE.MathUtils.degToRad(effectController.azimuth);

      sun.setFromSphericalCoords(1, phi, theta);
      uniforms['sunPosition'].value.copy(sun);
    };
    updateSky();

    const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    sunLight.position.copy(sun).multiplyScalar(100);
    sunLight.castShadow = true;
    sunLight.shadow.camera.left = -50;
    sunLight.shadow.camera.right = 50;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.camera.far = 500;
    sunLight.shadow.mapSize.width = 4096;
    sunLight.shadow.mapSize.height = 4096;
    scene.add(sunLight);

    const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
    scene.add(ambientLight);

    // --- TERRAIN GENERATION ---
    const terrainSize = 256;
    const terrainGeo = new THREE.PlaneGeometry(300, 300, terrainSize, terrainSize);
    const terrainPositions = terrainGeo.attributes.position.array;
    for (let i = 0; i < terrainPositions.length; i += 3) {
      const x = terrainPositions[i];
      const y = terrainPositions[i + 1];
      const noise = noise2D(x / 50, y / 50) * 8 + noise2D(x / 10, y / 10) * 2;
      terrainPositions[i + 2] = noise;
    }
    terrainGeo.computeVertexNormals();
    
    const terrainMat = new THREE.MeshStandardMaterial({ 
      color: 0x223311, 
      roughness: 0.8, 
      metalness: 0.1 
    });
    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.receiveShadow = true;
    scene.add(terrain);

    // --- WATER (OP-08 BLOOM Context) ---
    const waterGeometry = new THREE.PlaneGeometry(1000, 1000);
    const water = new Water(waterGeometry, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/waternormals.jpg', function(texture) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      }),
      sunDirection: sun,
      sunColor: 0xffffff,
      waterColor: 0x001e0f,
      distortionScale: 3.7,
      fog: scene.fog !== undefined
    });
    water.rotation.x = -Math.PI / 2;
    water.position.y = -2; // Slightly below ground level noise average
    scene.add(water);

    // --- INSTANCED GRASS WITH WIND SHADER ---
    const grassCount = 60000;
    const grassGeo = new THREE.PlaneGeometry(0.15, 0.5, 1, 4);
    grassGeo.translate(0, 0.25, 0); // Origin at bottom
    
    const grassMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x335522) }
      },
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 pos = position;
          float wind = sin(uTime * 2.0 + instanceMatrix[3][0] * 0.5 + instanceMatrix[3][2] * 0.5) * position.y * 0.2;
          pos.x += wind;
          pos.z += wind * 0.5;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(uColor * (0.5 + vUv.y), 1.0);
        }
      `,
      side: THREE.DoubleSide
    });

    const grassMesh = new THREE.InstancedMesh(grassGeo, grassMaterial, grassCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < grassCount; i++) {
      const x = (Math.random() - 0.5) * 200;
      const z = (Math.random() - 0.5) * 200;
      const noise = noise2D(x / 50, -z / 50) * 8 + noise2D(x / 10, -z / 10) * 2;
      
      if (noise > -1.5) { // Only place grass above water line approximately
        dummy.position.set(x, noise, z);
        dummy.rotation.y = Math.random() * Math.PI;
        dummy.scale.setScalar(0.5 + Math.random() * 1.5);
        dummy.updateMatrix();
        grassMesh.setMatrixAt(i, dummy.matrix);
      }
    }
    scene.add(grassMesh);

    // --- PROCEDURAL TREES (Simplified Clusters) ---
    const treeCount = 150;
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 4, 8);
    const leafGeo = new THREE.SphereGeometry(2, 8, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x442211 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x113311 });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);

    for (let i = 0; i < treeCount; i++) {
      const x = (Math.random() - 0.5) * 250;
      const z = (Math.random() - 0.5) * 250;
      const noise = noise2D(x / 50, -z / 50) * 8 + noise2D(x / 10, -z / 10) * 2;

      if (noise > 1 && Math.random() > 0.5) {
        dummy.position.set(x, noise + 2, z);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        trunks.setMatrixAt(i, dummy.matrix);

        dummy.position.set(x, noise + 5, z);
        dummy.scale.setScalar(1 + Math.random());
        dummy.updateMatrix();
        leaves.setMatrixAt(i, dummy.matrix);
      }
    }
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    leaves.castShadow = true;
    leaves.receiveShadow = true;
    scene.add(trunks, leaves);

    // --- POST-PROCESSING ---
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.4, 0.4, 0.9);
    composer.addPass(bloomPass);

    // --- ANIMATION ---
    const clock = new THREE.Clock();
    const animate = () => {
      const delta = clock.getElapsedTime();
      
      water.material.uniforms['time'].value += 1.0 / 60.0;
      grassMaterial.uniforms['uTime'].value = delta;
      
      // Camera Path
      camera.position.x = Math.sin(delta * 0.1) * 80;
      camera.position.z = Math.cos(delta * 0.1) * 80;
      camera.position.y = 15 + Math.sin(delta * 0.2) * 5;
      camera.lookAt(0, 0, 0);

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
