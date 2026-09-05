
import React, { useEffect, useRef } from 'react';

interface Props {
  r: number;
  isRunning: boolean;
}

const LatticeCanvas: React.FC<Props> = ({ r, isRunning }) => {
  const initialized = useRef(false);
  // Fixed: Initializing with null to satisfy TypeScript requirement for 1 argument in useRef
  const meshRef = useRef<any>(null);

  useEffect(() => {
    if (initialized.current) return;
    const canvas = document.getElementById('v-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    const renderer = new (window as any).THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new (window as any).THREE.Scene();
    const camera = new (window as any).THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 12;

    const geometry = new (window as any).THREE.TorusKnotGeometry(4, 0.5, 200, 32);
    const material = new (window as any).THREE.MeshPhongMaterial({
      color: 0x00f3ff,
      wireframe: true,
      emissive: 0x00f3ff,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.4
    });

    const lattice = new (window as any).THREE.Mesh(geometry, material);
    scene.add(lattice);
    meshRef.current = lattice;

    const light = new (window as any).THREE.PointLight(0xffffff, 1, 100);
    light.position.set(10, 10, 10);
    scene.add(light);

    const ambient = new (window as any).THREE.AmbientLight(0x404040);
    scene.add(ambient);

    const animate = () => {
      requestAnimationFrame(animate);
      if (lattice) {
        lattice.rotation.y += isRunning ? 0.005 : 0.001;
        lattice.rotation.x += isRunning ? 0.002 : 0.0005;
        
        // React to Engine R value
        const scale = 0.8 + (r * 0.4);
        lattice.scale.set(scale, scale, scale);
        material.emissiveIntensity = 0.2 + (r * 0.8);
      }
      renderer.render(scene, camera);
    };

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener('resize', handleResize);
    animate();
    initialized.current = true;
  }, []);

  return null; // Renders to the #v-canvas element in index.html
};

export default LatticeCanvas;
