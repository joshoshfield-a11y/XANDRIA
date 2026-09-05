
import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { Joint, LODTier } from '../types';

interface Stage3DProps {
  joints: Joint[];
  name: string;
  currentLOD: number;
}

const Stage3D: React.FC<Stage3DProps> = ({ joints, name, currentLOD }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020205);
    
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(5, 5, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    containerRef.current.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    scene.add(ambientLight);
    const pointLight = new THREE.PointLight(0x00f3ff, 2, 50);
    pointLight.position.set(10, 10, 10);
    scene.add(pointLight);

    // Grid
    const gridHelper = new THREE.GridHelper(20, 20, 0x334155, 0x1e293b);
    scene.add(gridHelper);

    // Dynamic Geometry based on LOD
    const getGeometryForLOD = (lod: number) => {
      // Scale resolution by LOD
      const resolution = lod === 0 ? 128 : lod === 1 ? 48 : 16;
      return new THREE.TorusKnotGeometry(1.5, 0.4, resolution, resolution / 4);
    };

    const material = new THREE.MeshPhongMaterial({ 
      color: 0x0ea5e9, 
      wireframe: true,
      transparent: true,
      opacity: 0.6
    });

    const mesh = new THREE.Mesh(getGeometryForLOD(currentLOD), material);
    meshRef.current = mesh;
    scene.add(mesh);

    // Skeleton Visualization
    const skeletonGroup = new THREE.Group();
    const jointMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const jointGeo = new THREE.SphereGeometry(0.1, 16, 16);

    joints.forEach(j => {
      const jointMesh = new THREE.Mesh(jointGeo, jointMaterial);
      jointMesh.position.set(j.position[0], j.position[1], j.position[2]);
      skeletonGroup.add(jointMesh);

      if (j.parent) {
        const parent = joints.find(p => p.name === j.parent);
        if (parent) {
          const points = [
            new THREE.Vector3(...j.position),
            new THREE.Vector3(...parent.position)
          ];
          const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
          const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
          const line = new THREE.Line(lineGeo, lineMat);
          skeletonGroup.add(line);
        }
      }
    });
    scene.add(skeletonGroup);

    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      if (meshRef.current) meshRef.current.rotation.y += 0.005;
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.dispose();
      containerRef.current?.removeChild(renderer.domElement);
    };
  }, [joints, currentLOD]);

  return <div ref={containerRef} className="w-full h-full relative" />;
};

export default Stage3D;
