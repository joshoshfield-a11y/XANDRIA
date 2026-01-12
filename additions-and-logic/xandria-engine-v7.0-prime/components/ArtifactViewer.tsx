
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as CANNON from 'cannon-es';

interface ArtifactViewerProps {
  sceneConfig: any;
}

const ArtifactViewer: React.FC<ArtifactViewerProps> = ({ sceneConfig }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [isSimulating, setIsSimulating] = useState(true);

  useEffect(() => {
    if (!mountRef.current || !sceneConfig) return;

    const scene = new THREE.Scene();
    const config = sceneConfig.scene || {};
    scene.background = new THREE.Color(config.background || 0x05050a);

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    camera.position.set(20, 20, 20);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Helpers
    const gridHelper = new THREE.GridHelper(100, 100, 0x00f3ff, 0x111111);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    // Physics World Setup
    const world = new CANNON.World();
    const grav = config.physics?.gravity || [0, -9.82, 0];
    world.gravity.set(grav[0], grav[1], grav[2]);
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 10;

    // Advanced Materials
    const defaultMaterial = new CANNON.Material('default');
    const defaultContactMaterial = new CANNON.ContactMaterial(
      defaultMaterial,
      defaultMaterial,
      {
        friction: config.physics?.friction ?? 0.3,
        restitution: config.physics?.restitution ?? 0.4,
      }
    );
    world.addContactMaterial(defaultContactMaterial);

    const meshes: { mesh: THREE.Mesh; body: CANNON.Body }[] = [];

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const spotLight = new THREE.SpotLight(0xffffff, 1.5);
    spotLight.position.set(20, 40, 20);
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.width = 1024;
    spotLight.shadow.mapSize.height = 1024;
    scene.add(spotLight);

    // Entities
    (config.entities || []).forEach((entity: any) => {
      let geo;
      let shape;
      const mass = entity.mass !== undefined ? entity.mass : 1;

      switch (entity.type) {
        case 'sphere': 
          geo = new THREE.SphereGeometry(1, 64, 64); 
          shape = new CANNON.Sphere(1);
          break;
        case 'plane': 
          geo = new THREE.PlaneGeometry(100, 100); 
          shape = new CANNON.Plane();
          break;
        case 'cylinder':
          geo = new THREE.CylinderGeometry(1, 1, 2, 32);
          shape = new CANNON.Cylinder(1, 1, 2, 32);
          break;
        case 'torus':
          geo = new THREE.TorusGeometry(1, 0.4, 32, 100);
          shape = new CANNON.Sphere(1.2); 
          break;
        default: 
          geo = new THREE.BoxGeometry(2, 2, 2);
          shape = new CANNON.Box(new CANNON.Vec3(1, 1, 1));
      }

      const mat = new THREE.MeshStandardMaterial({ 
        color: entity.color || 0x00f3ff, 
        wireframe: entity.wireframe,
        roughness: 0.1,
        metalness: 0.8
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const body = new CANNON.Body({ 
        mass: mass,
        material: defaultMaterial
      });
      body.addShape(shape);
      
      const pos = entity.position || [0, 0, 0];
      body.position.set(pos[0], pos[1], pos[2]);
      
      if (entity.rotation) {
        body.quaternion.setFromEuler(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
      }

      if (entity.type === 'plane') {
        body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      }

      world.addBody(body);
      meshes.push({ mesh, body });
    });

    let lastTime = performance.now();
    const animate = () => {
      const currentTime = performance.now();
      const dt = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      requestAnimationFrame(animate);
      if (isSimulating) {
        world.step(1/60, dt, 3);
        meshes.forEach(({ mesh, body }) => {
          mesh.position.copy(body.position as any);
          mesh.quaternion.copy(body.quaternion as any);
        });
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeChild(renderer.domElement);
    };
  }, [sceneConfig, isSimulating]);

  return (
    <div className="relative w-full h-full group">
      <div ref={mountRef} className="w-full h-full rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,0,0,0.5)] border border-white/5" />
      
      <div className="absolute top-6 right-6 flex flex-col gap-3 opacity-0 group-hover:opacity-100 transition-all duration-500 translate-x-4 group-hover:translate-x-0">
        <button 
          onClick={() => setIsSimulating(!isSimulating)}
          className="glass px-6 py-3 rounded-full text-[10px] font-bold tracking-[0.2em] text-cyan-400 hover:bg-cyan-400/20 active:scale-90 transition-all flex items-center gap-3"
        >
          <span className={`w-2 h-2 rounded-full ${isSimulating ? 'bg-cyan-400 animate-pulse' : 'bg-red-500'}`} />
          {isSimulating ? 'FREEZE_TIME' : 'RESUME_FLOW'}
        </button>
      </div>

      <div className="absolute bottom-6 left-6 flex flex-col gap-1 pointer-events-none">
        <div className="glass px-4 py-2 rounded-xl text-[9px] fira text-white/50 uppercase tracking-widest flex items-center gap-3">
          <span className="text-cyan-400">STATUS:</span> OPERATIONAL
          <div className="w-px h-3 bg-white/10" />
          <span className="text-cyan-400">ENGINE:</span> CANNON_PRIME_v0.2
        </div>
      </div>
    </div>
  );
};

export default ArtifactViewer;
