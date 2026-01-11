
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { GeneratorEngine, ArtifactDiagnostics, GeneratedAsset } from './types';
import { synthesizeGenerator, runGenerator, performDiagnostics, forgeAsset, reForgeArtifact } from './services/geminiService';

// --- VISUAL MANIFOLD ENGINE ---
const initManifold = (containerId: string) => {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);
  
  const geometry = new THREE.IcosahedronGeometry(12, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0x00f3ff, wireframe: true, transparent: true, opacity: 0.15 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  
  const innerGeometry = new THREE.OctahedronGeometry(6, 0);
  const innerMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.1 });
  const innerMesh = new THREE.Mesh(innerGeometry, innerMaterial);
  scene.add(innerMesh);

  camera.position.z = 30;
  let speed = 0.003;
  
  const animate = () => {
    requestAnimationFrame(animate);
    mesh.rotation.y += speed;
    mesh.rotation.x += speed * 0.4;
    innerMesh.rotation.y -= speed * 2;
    renderer.render(scene, camera);
  };
  animate();
  
  return { 
    setSpeed: (s: number) => { speed = s; },
    setColor: (c: number) => { material.color.setHex(c); } 
  };
};

// Utils for Live API
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function createBlob(data: Float32Array) {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) int16[i] = data[i] * 32768;
  return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('synthesis');
  const [engines, setEngines] = useState<GeneratorEngine[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [intentInput, setIntentInput] = useState('');
  const [reforgeInput, setReforgeInput] = useState('');
  const [trace, setTrace] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Runtime State
  const [runtimeParams, setRuntimeParams] = useState<Record<string, any>>({});
  const [seed, setSeed] = useState(Math.random().toString(36).substring(7));
  const [artifact, setArtifact] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ArtifactDiagnostics | null>(null);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isReforging, setIsReforging] = useState(false);
  const [isForging, setIsForging] = useState(false);
  const [artifactMode, setArtifactMode] = useState<'source' | 'preview' | 'assets'>('source');
  
  // Live Voice State
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const sessionRef = useRef<any>(null);
  const manifoldRef = useRef<any>(null);

  useEffect(() => {
    manifoldRef.current = initManifold('manifold');
    const savedVault = localStorage.getItem('architect_vault');
    if (savedVault) setEngines(JSON.parse(savedVault));
  }, []);

  useEffect(() => {
    localStorage.setItem('architect_vault', JSON.stringify(engines));
  }, [engines]);

  const addTrace = useCallback((msg: string) => {
    setTrace(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const purgeVault = useCallback(() => {
    if (window.confirm("Purge entire vault substrate?")) {
      setEngines([]);
      localStorage.removeItem('architect_vault');
      setSelectedEngineId(null);
      addTrace("Vault substrate purged.");
    }
  }, [addTrace]);

  const toggleVoice = async () => {
    if (isVoiceActive) {
      setIsVoiceActive(false);
      sessionRef.current?.close();
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      addTrace("Opening Voice Bridge...");
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: "You are the Architect's Voice interface. Facilitate natural language app design. Be brief."
        },
        callbacks: {
          onopen: () => {
            setIsVoiceActive(true);
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(input) }));
            };
            source.connect(processor);
            processor.connect(audioContext.destination);
            addTrace("Voice Bridge Synchronized.");
          },
          onmessage: (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) {
              const text = msg.serverContent.inputTranscription.text;
              setVoiceTranscript(prev => (prev + " " + text).trim());
              setIntentInput(prev => (prev + " " + text).trim());
            }
          },
          onclose: () => setIsVoiceActive(false),
          onerror: (e) => addTrace("Voice Link Error: " + e)
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError("Microphone access denied or session failed.");
      setIsVoiceActive(false);
    }
  };

  const handleSynthesize = async () => {
    if (!intentInput.trim()) return;
    setIsSynthesizing(true);
    manifoldRef.current?.setSpeed(0.04);
    addTrace(`Synthesizing Engine Manifest...`);
    try {
      const engine = await synthesizeGenerator(intentInput);
      setEngines(prev => [engine, ...prev]);
      setIntentInput('');
      setVoiceTranscript('');
      setSelectedEngineId(engine.id);
      setActiveTab('vault');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSynthesizing(false);
      manifoldRef.current?.setSpeed(0.003);
    }
  };

  const handleRun = async () => {
    const engine = engines.find(e => e.id === selectedEngineId);
    if (!engine) return;
    setIsGenerating(true);
    setArtifact(null);
    setDiagnostics(null);
    addTrace(`Collapsing Forge Waveform...`);
    try {
      const code = await runGenerator(engine, runtimeParams, seed);
      setArtifact(code);
      const diag = await performDiagnostics(code);
      setDiagnostics(diag);
      addTrace(`Forge Stable. Integrity Check: ${diag.healthScore}%`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReForge = async () => {
    if (!artifact || !reforgeInput.trim()) return;
    setIsReforging(true);
    addTrace(`Surgeon Agent: Patching Artifact...`);
    try {
      const newCode = await reForgeArtifact(artifact, reforgeInput);
      setArtifact(newCode);
      setReforgeInput('');
      const diag = await performDiagnostics(newCode);
      setDiagnostics(diag);
      addTrace(`Patch Materialized.`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsReforging(false);
    }
  };

  const handleForgeAsset = async (type: string) => {
    const engine = engines.find(e => e.id === selectedEngineId);
    if (!engine) return;
    setIsForging(true);
    addTrace(`Forging ${type} asset lattice...`);
    try {
      const url = await forgeAsset(engine, type);
      const newAsset: GeneratedAsset = { id: crypto.randomUUID(), url, type: type.toLowerCase() as any, prompt: engine.domain };
      setAssets(prev => [newAsset, ...prev]);
      addTrace(`${type} synthesized and cached.`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsForging(false);
    }
  };

  const selectedEngine = useMemo(() => engines.find(e => e.id === selectedEngineId) || null, [engines, selectedEngineId]);

  return (
    <div className="min-h-screen p-4 md:p-12 flex flex-col max-w-7xl mx-auto z-10 relative">
      <nav className="flex items-center justify-between mb-8 px-4 py-2 glass rounded-2xl border-white/5 z-10">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full bg-cyan-400 animate-pulse"></div>
          <h1 className="text-xl font-bold tracking-tighter uppercase italic">ARCHITECT <span className="text-cyan-400">V7.3 PRIME</span></h1>
        </div>
        <div className="flex gap-1 bg-white/5 p-1 rounded-xl">
          {['synthesis', 'vault', 'runtime'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-1.5 rounded-lg text-xs font-bold tracking-widest uppercase transition-all ${activeTab === tab ? 'bg-cyan-500 text-black shadow-[0_0_15px_rgba(0,243,255,0.4)]' : 'opacity-40 hover:opacity-100'}`}>{tab}</button>
          ))}
        </div>
      </nav>

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] uppercase font-bold flex justify-between items-center">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-6 overflow-hidden">
        <div className="lg:col-span-1 flex flex-col gap-6">
          <div className="glass p-6 rounded-3xl flex-1 flex flex-col overflow-hidden">
            <h3 className="text-[10px] font-bold opacity-30 uppercase tracking-widest mb-4">Core Trace</h3>
            <div className="flex-1 overflow-y-auto fira text-[10px] space-y-1 opacity-70">
              {trace.map((t, i) => <div key={i}>{t}</div>)}
              {trace.length === 0 && <div className="opacity-20 italic">Awaiting events...</div>}
            </div>
          </div>
          <button onClick={toggleVoice} className={`p-6 rounded-3xl border transition-all flex flex-col items-center gap-3 ${isVoiceActive ? 'bg-red-500/10 border-red-500/50 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.2)]' : 'glass border-white/5 opacity-60 hover:opacity-100'}`}>
            <div className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${isVoiceActive ? 'border-red-400 animate-pulse' : 'border-white/20'}`}>
               {isVoiceActive && <div className="w-3 h-3 bg-red-400 rounded-full animate-ping"></div>}
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest">{isVoiceActive ? 'Listening...' : 'Ambient Voice'}</span>
          </button>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-6">
          {activeTab === 'synthesis' && (
            <div className="glass p-12 rounded-[3rem] flex-1 flex flex-col items-center justify-center text-center space-y-8 active-glow">
              <h2 className="text-6xl font-light tracking-tighter">Manifest <span className="text-cyan-400 italic">Intent</span></h2>
              <div className="w-full max-w-2xl relative">
                <input type="text" value={intentInput} onChange={(e) => setIntentInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleSynthesize()} placeholder="Describe a new generator substrate..." className="w-full bg-white/5 border border-white/10 rounded-full px-8 py-6 text-xl focus:outline-none focus:border-cyan-400 transition-all placeholder:opacity-20" />
                <button onClick={handleSynthesize} disabled={isSynthesizing || !intentInput} className="absolute right-3 top-3 bottom-3 px-8 rounded-full bg-cyan-500 text-black font-bold uppercase tracking-widest hover:scale-105 transition-all disabled:opacity-30">{isSynthesizing ? 'SYNTHESIZING...' : 'COLLAPSE'}</button>
              </div>
              {voiceTranscript && <div className="p-4 rounded-2xl bg-white/5 border border-white/10 max-w-lg"><p className="text-[11px] fira opacity-60 text-left">"{voiceTranscript}"</p></div>}
            </div>
          )}

          {activeTab === 'vault' && (
            <div className="flex-1 flex flex-col gap-4 overflow-hidden">
               <div className="flex justify-between items-center px-4">
                  <h3 className="text-xs font-bold uppercase opacity-40">Stored Engines</h3>
                  <button onClick={purgeVault} className="text-[9px] font-bold text-red-400/50 hover:text-red-400 uppercase tracking-widest">Purge Substrate</button>
               </div>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto pr-2 content-start">
                {engines.map(engine => (
                  <div key={engine.id} onClick={() => { setSelectedEngineId(engine.id); setActiveTab('runtime'); }} className={`glass p-6 rounded-3xl cursor-pointer transition-all border ${selectedEngineId === engine.id ? 'border-cyan-400' : 'border-white/5 hover:bg-white/5'}`}>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[10px] font-bold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded">v{engine.version}</span>
                    </div>
                    <h4 className="text-2xl font-bold mb-2">{engine.name}</h4>
                    <p className="text-sm opacity-40 line-clamp-2">{engine.description}</p>
                  </div>
                ))}
                {engines.length === 0 && <div className="col-span-2 py-20 text-center opacity-20 italic">No engines synthesized.</div>}
              </div>
            </div>
          )}

          {activeTab === 'runtime' && selectedEngine && (
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 overflow-hidden">
              <div className="glass p-6 rounded-3xl col-span-1 flex flex-col gap-6 h-full overflow-y-auto">
                <div className="flex justify-between items-center">
                   <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-400">Forge Config</h3>
                   <span className="text-[10px] opacity-40">#{selectedEngine.name}</span>
                </div>
                <div className="space-y-4">
                  {selectedEngine.config.parameters.map(param => (
                    <div key={param.key} className="space-y-1">
                      <label className="text-[10px] opacity-40 uppercase font-bold">{param.label}</label>
                      <input type="text" className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-xs focus:border-cyan-500 outline-none" onChange={(e) => setRuntimeParams(p => ({...p, [param.key]: e.target.value}))} placeholder={param.default} />
                    </div>
                  ))}
                </div>
                
                <div className="pt-4 border-t border-white/5 space-y-4">
                  <h3 className="text-[10px] opacity-40 uppercase font-bold">Multimodal Assets</h3>
                  <div className="flex gap-2">
                    {['Logo', 'Icon', 'Hero'].map(type => (
                      <button key={type} onClick={() => handleForgeAsset(type)} disabled={isForging} className="flex-1 py-2 bg-white/5 border border-white/10 rounded-lg text-[9px] font-bold uppercase hover:bg-white/10">{isForging ? '...' : type}</button>
                    ))}
                  </div>
                </div>

                {artifact && (
                  <div className="pt-4 border-t border-white/5 space-y-4">
                    <h3 className="text-[10px] opacity-40 uppercase font-bold">Logic Surgeon</h3>
                    <textarea value={reforgeInput} onChange={(e) => setReforgeInput(e.target.value)} placeholder="Instruction to refine artifact..." className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-[10px] h-20 outline-none focus:border-purple-500" />
                    <button onClick={handleReForge} disabled={isReforging} className="w-full py-2 bg-purple-500/20 text-purple-400 rounded-lg text-[9px] font-bold uppercase border border-purple-500/30">{isReforging ? 'Refining...' : 'Patch Artifact'}</button>
                  </div>
                )}

                <button onClick={handleRun} disabled={isGenerating} className="w-full py-4 bg-cyan-500 text-black font-bold uppercase rounded-2xl hover:shadow-[0_0_30px_rgba(0,243,255,0.4)] transition-all mt-auto">{isGenerating ? 'GENERATING...' : 'EXECUTE FORGE'}</button>
              </div>

              <div className="glass p-6 rounded-3xl col-span-2 flex flex-col overflow-hidden h-full">
                <div className="flex justify-between items-center mb-4">
                  <div className="flex gap-4">
                    {['source', 'preview', 'assets'].map(mode => (
                      <button key={mode} onClick={() => setArtifactMode(mode as any)} className={`text-xs font-bold uppercase tracking-widest ${artifactMode === mode ? 'text-cyan-400' : 'opacity-40'}`}>{mode}</button>
                    ))}
                  </div>
                  {diagnostics && <div className="flex items-center gap-2">
                     <div className="h-1.5 w-20 bg-white/5 rounded-full overflow-hidden">
                        <div className="h-full bg-cyan-500" style={{ width: `${diagnostics.healthScore}%` }}></div>
                     </div>
                     <span className="text-[10px] font-bold text-cyan-400">{diagnostics.healthScore}%</span>
                  </div>}
                </div>

                <div className="flex-1 bg-black/40 rounded-2xl overflow-hidden border border-white/5 relative">
                  {artifactMode === 'source' && <pre className="p-6 fira text-[10px] overflow-auto h-full whitespace-pre-wrap leading-relaxed opacity-80">{artifact || 'Forge idle. Awaiting collapse sequence.'}</pre>}
                  {artifactMode === 'preview' && <iframe srcDoc={artifact || `<div style="color:#333; font-family:sans-serif; padding:40px;">No preview active.</div>`} className="w-full h-full bg-white/5" />}
                  {artifactMode === 'assets' && (
                    <div className="p-6 grid grid-cols-2 gap-4 overflow-y-auto h-full">
                      {assets.map(asset => (
                        <div key={asset.id} className="relative group glass p-2 rounded-xl border-white/5 hover:border-cyan-500/50 transition-all">
                          <img src={asset.url} className="w-full h-auto rounded-lg" alt={asset.type} />
                          <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 rounded text-[8px] font-bold uppercase text-cyan-400">{asset.type}</div>
                        </div>
                      ))}
                      {assets.length === 0 && <div className="col-span-2 text-center py-20 opacity-20 italic">No assets materialized.</div>}
                    </div>
                  )}
                  {isGenerating && <div className="absolute inset-0 bg-black/80 flex items-center justify-center font-bold text-cyan-400 animate-pulse uppercase tracking-[0.5em] z-20">Materializing Artifact...</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
