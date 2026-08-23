/**
 * XANDRIA App Router
 * Unified launcher that can bootstrap any sub-app or the core engine
 */

import React, { useState, useEffect } from 'react';

interface AppManifest {
  id: string;
  name: string;
  description: string;
  path: string;
  stack: string[];
  size: string;
  status: 'stable' | 'beta' | 'alpha' | 'experimental';
}

const APPS: AppManifest[] = [
  {
    id: 'v7-prime',
    name: 'Xandria v7.0 Prime',
    description: 'Intent → 3D scene with physics. The deployed demo.',
    path: 'additions-and-logic/xandria-engine-v7.0-prime',
    stack: ['React 19', 'Vite', 'Three.js', 'Cannon-es'],
    size: '20KB',
    status: 'stable'
  },
  {
    id: 'aethegard',
    name: 'Aethegard Glass Bottle Universe',
    description: 'Universe simulation with AIChat, Browser, Forge, Terminal.',
    path: 'additions-and-logic/aethegard-glass-bottle-universe',
    stack: ['React', 'Vite', 'Gemini API'],
    size: '114KB',
    status: 'beta'
  },
  {
    id: 'logos',
    name: 'Logos Logic Orchestration Kernel',
    description: 'ECS-based logic orchestration with operator lattice.',
    path: 'additions-and-logic/logos_-logic-orchestration-kernel',
    stack: ['React', 'Vite', 'ECS'],
    size: '41KB',
    status: 'beta'
  },
  {
    id: 'mythos',
    name: 'Mythos Asset Synthesis Pipeline',
    description: '3D stage + acoustic console + SCG viewer.',
    path: 'additions-and-logic/mythos_-asset-synthesis-pipeline',
    stack: ['React', 'Vite', 'Three.js'],
    size: '29KB',
    status: 'beta'
  },
  {
    id: 'simulation',
    name: 'Simulation & QA Matrix v7.0',
    description: 'Simulation grid + agent detail + telemetry dashboard.',
    path: 'additions-and-logic/simulation-&-qa-matrix-v7.0',
    stack: ['React', 'Vite'],
    size: '36KB',
    status: 'beta'
  },
  {
    id: 'architect',
    name: 'Architect Meta-Procedural Engine',
    description: 'Meta-procedural generation engine.',
    path: 'additions-and-logic/architect_-meta-procedural-engine',
    stack: ['React', 'Vite'],
    size: '31KB',
    status: 'beta'
  },
  {
    id: 'meta-protocol',
    name: 'Xandria Meta-Engine Protocol',
    description: 'Node visualizer + singularity core.',
    path: 'additions-and-logic/xandria-meta-engine-protocol',
    stack: ['React', 'Vite', 'Three.js'],
    size: '45KB',
    status: 'beta'
  },
  {
    id: 'asset-forge',
    name: 'Aethelgard Sovereign Asset Forge',
    description: 'Asset generation with live preview.',
    path: 'additions-and-logic/aethelgard_-sovereign-asset-forge',
    stack: ['React', 'Vite'],
    size: '43KB',
    status: 'beta'
  }
];

const STATUS_COLORS: Record<string, string> = {
  stable: '#00ff88',
  beta: '#ffaa00',
  alpha: '#ff0055',
  experimental: '#cc44ff'
};

export default function AppRouter() {
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ totalApps: APPS.length, totalSize: '359KB' });

  const filteredApps = APPS.filter(app =>
    app.name.toLowerCase().includes(search.toLowerCase()) ||
    app.description.toLowerCase().includes(search.toLowerCase())
  );

  const launchApp = (app: AppManifest) => {
    console.log(`[AppRouter] Launching ${app.id} from ${app.path}`);
    // In a real implementation, this would dynamically import the app
    // For now, we redirect to the app's dev server
    window.open(`/${app.path}/index.html`, '_blank');
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#050510',
      color: '#e0e0ff',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem'
    }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{
          fontSize: '2.5rem',
          fontWeight: 800,
          background: 'linear-gradient(135deg, #00ffff, #ff00ff)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          margin: 0
        }}>
          🜂 XANDRIA App Router
        </h1>
        <p style={{ color: '#8888aa', marginTop: '0.5rem' }}>
          Unified launcher — {stats.totalApps} subsystems — {stats.totalSize} total
        </p>
      </header>

      <div style={{ marginBottom: '2rem' }}>
        <input
          type="text"
          placeholder="Search apps..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%',
            maxWidth: '400px',
            padding: '0.75rem 1rem',
            background: '#0a0a1a',
            border: '1px solid #1a1a3a',
            borderRadius: '8px',
            color: '#e0e0ff',
            fontSize: '1rem',
            outline: 'none'
          }}
        />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: '1rem'
      }}>
        {filteredApps.map(app => (
          <div
            key={app.id}
            onClick={() => launchApp(app)}
            style={{
              background: '#0a0a1a',
              border: '1px solid #1a1a3a',
              borderRadius: '12px',
              padding: '1.5rem',
              cursor: 'pointer',
              transition: 'all 0.2s',
              position: 'relative',
              overflow: 'hidden'
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = '#00ffff';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = '#1a1a3a';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <div style={{
              position: 'absolute',
              top: '1rem',
              right: '1rem',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: STATUS_COLORS[app.status]
            }} />
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', color: '#fff' }}>
              {app.name}
            </h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#8888aa', lineHeight: 1.5 }}>
              {app.description}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {app.stack.map(tech => (
                <span key={tech} style={{
                  fontSize: '0.7rem',
                  padding: '0.2rem 0.5rem',
                  background: '#1a1a3a',
                  borderRadius: '4px',
                  color: '#00ffff'
                }}>
                  {tech}
                </span>
              ))}
            </div>
            <div style={{
              marginTop: '1rem',
              fontSize: '0.75rem',
              color: '#555577',
              display: 'flex',
              justifyContent: 'space-between'
            }}>
              <span>{app.size}</span>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {app.status}
              </span>
            </div>
          </div>
        ))}
      </div>

      <footer style={{
        marginTop: '3rem',
        paddingTop: '2rem',
        borderTop: '1px solid #1a1a3a',
        color: '#555577',
        fontSize: '0.8rem'
      }}>
        <p>XANDRIA Unified v4.0 — 72-operator lattice — 13-layer stack — MIT License</p>
      </footer>
    </div>
  );
}
