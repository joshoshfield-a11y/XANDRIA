/**
 * XANDRIA v7.0 Prime — Unified Edition
 * Now uses the 72-operator lattice via UnifiedOperatorBridge
 * instead of mock 8-node sequencing.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { UnifiedOperatorBridge, ManifestResult } from './src/bridge';
import { LatticeVisualizer } from './components/LatticeVisualizer';
import { ArtifactViewer } from './components/ArtifactViewer';
import { AssetStore } from './components/AssetStore';
import { VCSHistory } from './components/VCSHistory';
import { SYSTEM_DNA } from './constants';
import './App.css';

const bridge = new UnifiedOperatorBridge();

export default function App() {
  const [intent, setIntent] = useState('');
  const [isManifesting, setIsManifesting] = useState(false);
  const [result, setResult] = useState<ManifestResult | null>(null);
  const [activeTab, setActiveTab] = useState<'preview' | 'code' | 'assets' | 'vcs'>('preview');
  const [trace, setTrace] = useState<string[]>([]);
  const [operatorSequence, setOperatorSequence] = useState<string[]>([]);
  const [coherence, setCoherence] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [qualityScore, setQualityScore] = useState(0);
  const traceEndRef = useRef<HTMLDivElement>(null);

  const addTrace = useCallback((msg: string) => {
    setTrace(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const handleManifest = async () => {
    if (!intent.trim() || isManifesting) return;

    setIsManifesting(true);
    setTrace([]);
    setResult(null);
    setOperatorSequence([]);
    setCoherence(0);
    setConfidence(0);
    setQualityScore(0);

    addTrace('🜂 INITIATING MANIFESTATION SEQUENCE');
    addTrace(`Intent received: "${intent}"`);
    addTrace('Loading 72-operator lattice...');

    try {
      addTrace('Generating operator pipeline from intent...');

      const manifestResult = await bridge.manifest({
        intent,
        assetsContext: [],
        domain: 'gaming',
        scope: 'project'
      });

      setResult(manifestResult);
      setOperatorSequence(manifestResult.operators.executed);
      setCoherence(manifestResult.operators.coherence);
      setConfidence(manifestResult.operators.confidence);
      setQualityScore(manifestResult.quality.score);

      addTrace(`✅ Synthesis complete`);
      addTrace(`Operators executed: ${manifestResult.operators.executed.length}`);
      addTrace(`Pipeline: ${manifestResult.operators.executed.join(' → ')}`);
      addTrace(`Coherence: ${(manifestResult.operators.coherence * 100).toFixed(1)}%`);
      addTrace(`Confidence: ${(manifestResult.operators.confidence * 100).toFixed(1)}%`);
      addTrace(`Quality: ${manifestResult.quality.grade} (${manifestResult.quality.score}/100)`);
      addTrace(`Execution time: ${manifestResult.metadata.executionTime}ms`);
      addTrace(`Scene entities: ${manifestResult.scene.entities.length}`);
      addTrace(`Generated files: ${manifestResult.code.files.length}`);

      if (manifestResult.quality.violations.length > 0) {
        addTrace(`⚠️ Violations: ${manifestResult.quality.violations.join(', ')}`);
      }

      setActiveTab('preview');
    } catch (error: any) {
      addTrace(`❌ SUBSTRATE ERROR: ${error.message}`);
      console.error('Manifestation error:', error);
    } finally {
      setIsManifesting(false);
    }
  };

  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [trace]);

  return (
    <div className="xandria-app">
      <header className="app-header">
        <h1>🜂 XANDRIA v7.0 Prime <span className="badge-unified">UNIFIED</span></h1>
        <div className="status-indicator">
          <span className={`pulse ${isManifesting ? 'active' : ''}`} />
          <span>{isManifesting ? 'MANIFESTING...' : 'READY'}</span>
        </div>
      </header>

      <div className="main-layout">
        <aside className="sidebar">
          <div className="intent-panel">
            <label>INTENT</label>
            <textarea
              value={intent}
              onChange={e => setIntent(e.target.value)}
              placeholder="Describe what you want to create..."
              rows={4}
            />
            <button
              onClick={handleManifest}
              disabled={isManifesting || !intent.trim()}
              className="manifest-btn"
            >
              {isManifesting ? 'MANIFESTING...' : 'MANIFEST'}
            </button>
          </div>

          <div className="metrics-panel">
            <div className="metric">
              <span className="metric-label">Coherence</span>
              <span className="metric-value">{(coherence * 100).toFixed(0)}%</span>
            </div>
            <div className="metric">
              <span className="metric-label">Confidence</span>
              <span className="metric-value">{(confidence * 100).toFixed(0)}%</span>
            </div>
            <div className="metric">
              <span className="metric-label">Quality</span>
              <span className="metric-value">{qualityScore}/100</span>
            </div>
          </div>

          <div className="trace-panel">
            <label>TRACE LOG</label>
            <div className="trace-scroll">
              {trace.map((t, i) => (
                <div key={i} className="trace-line">{t}</div>
              ))}
              <div ref={traceEndRef} />
            </div>
          </div>
        </aside>

        <main className="content">
          <div className="tabs">
            {(['preview', 'code', 'assets', 'vcs'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={activeTab === tab ? 'active' : ''}
              >
                {tab.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="tab-content">
            {activeTab === 'preview' && (
              <ArtifactViewer
                scene={result?.scene}
                isLoading={isManifesting}
              />
            )}
            {activeTab === 'code' && (
              <div className="code-panel">
                {result?.code.files.map(file => (
                  <div key={file.name} className="code-file">
                    <h4>{file.name}</h4>
                    <pre>{file.content}</pre>
                  </div>
                )) || <p>No code generated yet.</p>}
              </div>
            )}
            {activeTab === 'assets' && <AssetStore />}
            {activeTab === 'vcs' && <VCSHistory />}
          </div>
        </main>
      </div>

      <LatticeVisualizer
        operatorSequence={operatorSequence}
        isActive={isManifesting}
      />
    </div>
  );
}
