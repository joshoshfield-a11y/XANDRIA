/**
 * Game Generator
 * Handles the generation of game code using operator pipelines
 */

import { operatorRegistry, OperatorResult } from '../XANDRIAv3.0/src/engine/operators/OperatorRegistry';
import { GameGenerationSpec, GameProject, OperatorResult as OpResult, OperatorEnvironment } from './types';

export class GameGenerator {
  /**
   * Generate a complete game from specification
   */
  async generateGame(specification: string): Promise<string> {
    console.log(`🎮 Generating game code for: ${specification}`);

    // Generate base game template
    let gameCode = this.generateBaseGameTemplate(specification);

    // Apply operator pipeline
    const operatorResults = await this.runOperatorPipeline(specification);

    // Integrate operator results
    for (const result of operatorResults) {
      if (result.success && result.result?.code) {
        gameCode = this.integrateOperatorResult(gameCode, result);
      }
    }

    return gameCode;
  }

  /**
   * Run the operator pipeline for game generation
   */
  private async runOperatorPipeline(specification: string): Promise<OpResult[]> {
    const spec: GameGenerationSpec = {
      type: 'game_generation',
      specification,
      targetPlatform: 'web',
      features: ['3d', 'physics', 'ai', 'multiplayer']
    };

    const config = {
      generationMode: 'comprehensive',
      maxIterations: 50,
      qualityThreshold: 0.8
    };

    const previousResults: OpResult[] = [];
    const environment: OperatorEnvironment = {
      timestamp: Date.now(),
      sessionId: 'game_gen_' + Date.now(),
      contextScope: ['game', 'web', '3d']
    };

    return await operatorRegistry.synthesizeIntent(spec, {
      input: specification,
      config,
      state: {},
      previousResults,
      environment
    });
  }

  /**
   * Generate base React/Three.js game template
   */
  private generateBaseGameTemplate(specification: string): string {
    return `
import React, { useRef, useState, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { PointerLockControls, Sky, Fog } from '@react-three/drei';
import * as THREE from 'three';

// Game constants
const GAME_CONFIG = {
  playerSpeed: 5,
  gravity: -9.81,
  jumpForce: 10,
  enemyCount: 5,
  collectibleCount: 10
};

// Player controller component
function Player() {
  const { camera } = useThree();
  const velocity = useRef(new THREE.Vector3());
  const direction = useRef(new THREE.Vector3());
  const [canJump, setCanJump] = useState(true);

  useFrame((state, delta) => {
    // Movement logic
    velocity.current.x -= velocity.current.x * 10.0 * delta;
    velocity.current.z -= velocity.current.z * 10.0 * delta;

    // Apply gravity
    velocity.current.y += GAME_CONFIG.gravity * delta;

    // Ground collision (simple)
    if (camera.position.y <= 1 && velocity.current.y < 0) {
      velocity.current.y = 0;
      setCanJump(true);
    }

    // Input handling
    if (keys.w) velocity.current.z -= GAME_CONFIG.playerSpeed * delta;
    if (keys.s) velocity.current.z += GAME_CONFIG.playerSpeed * delta;
    if (keys.a) velocity.current.x -= GAME_CONFIG.playerSpeed * delta;
    if (keys.d) velocity.current.x += GAME_CONFIG.playerSpeed * delta;
    if (keys.space && canJump) {
      velocity.current.y = GAME_CONFIG.jumpForce;
      setCanJump(false);
    }

    // Apply movement
    camera.position.add(velocity.current.clone().multiplyScalar(delta));
  });

  return null;
}

// Enemy system
function EnemySystem() {
  const [enemies, setEnemies] = useState(() => {
    return Array.from({ length: GAME_CONFIG.enemyCount }, (_, i) => ({
      id: i,
      position: [
        (Math.random() - 0.5) * 100,
        1,
        (Math.random() - 0.5) * 100
      ],
      health: 100,
      behavior: Math.random() > 0.5 ? 'patrol' : 'chase'
    }));
  });

  useFrame((state, delta) => {
    // Update enemy AI
    setEnemies(prev => prev.map(enemy => {
      if (enemy.behavior === 'patrol') {
        // Simple patrol behavior
        enemy.position[0] += Math.sin(state.clock.elapsedTime + enemy.id) * delta;
        enemy.position[2] += Math.cos(state.clock.elapsedTime + enemy.id) * delta;
      }
      return enemy;
    }));
  });

  return (
    <>
      {enemies.map(enemy => (
        <mesh key={enemy.id} position={enemy.position}>
          <boxGeometry args={[1, 2, 1]} />
          <meshStandardMaterial color="red" />
        </mesh>
      ))}
    </>
  );
}

// Collectible system
function CollectibleSystem({ onCollect }: { onCollect: (id: number) => void }) {
  const [collectibles, setCollectibles] = useState(() => {
    return Array.from({ length: GAME_CONFIG.collectibleCount }, (_, i) => ({
      id: i,
      position: [
        (Math.random() - 0.5) * 80,
        2,
        (Math.random() - 0.5) * 80
      ],
      collected: false
    }));
  });

  const collect = (id: number) => {
    setCollectibles(prev => prev.map(c =>
      c.id === id ? { ...c, collected: true } : c
    ));
    onCollect(id);
  };

  return (
    <>
      {collectibles
        .filter(c => !c.collected)
        .map(collectible => (
          <mesh
            key={collectible.id}
            position={collectible.position}
            onClick={() => collect(collectible.id)}
          >
            <sphereGeometry args={[0.5]} />
            <meshStandardMaterial color="gold" emissive="yellow" emissiveIntensity={0.2} />
          </mesh>
        ))}
    </>
  );
}

// Main game scene component
export function GameScene() {
  const [score, setScore] = useState(0);
  const [health, setHealth] = useState(100);
  const [gameState, setGameState] = useState<'playing' | 'paused' | 'gameOver'>('playing');

  const handleCollectible = (id: number) => {
    setScore(prev => prev + 10);
  };

  const handleDamage = (damage: number) => {
    setHealth(prev => {
      const newHealth = Math.max(0, prev - damage);
      if (newHealth === 0) {
        setGameState('gameOver');
      }
      return newHealth;
    });
  };

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[10, 10, 5]}
        intensity={1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />

      {/* Environment */}
      <Sky
        distance={450000}
        sunPosition={[0, 1, 0]}
        inclination={0}
        azimuth={0.25}
      />
      <Fog attach="fog" args={['#87CEEB', 10, 100]} />

      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial
          color="#4a5d23"
          roughness={0.8}
          metalness={0.1}
        />
      </mesh>

      {/* Game Objects */}
      <Player />
      <EnemySystem />
      <CollectibleSystem onCollect={handleCollectible} />

      {/* UI Overlay */}
      <div style={{
        position: 'absolute',
        top: 10,
        left: 10,
        color: 'white',
        fontFamily: 'monospace',
        fontSize: '16px',
        textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
        zIndex: 100
      }}>
        <div>Score: {score}</div>
        <div>Health: {health}</div>
        <div>Status: {gameState}</div>
      </div>

      {/* Game Over Screen */}
      {gameState === 'gameOver' && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: 'white',
          fontSize: '32px',
          textAlign: 'center',
          textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
          zIndex: 200
        }}>
          <div>Game Over!</div>
          <div>Final Score: {score}</div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '20px',
              padding: '10px 20px',
              fontSize: '18px',
              backgroundColor: '#4CAF50',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer'
            }}
          >
            Play Again
          </button>
        </div>
      )}
    </>
  );
}

// Input handling
const keys: Record<string, boolean> = {};

window.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
});

window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

export default GameScene;
`;
  }

  /**
   * Integrate operator-generated code into the base template
   */
  private integrateOperatorResult(baseCode: string, result: OpResult): string {
    if (!result.result?.features) return baseCode;

    let enhancedCode = baseCode;

    const features = result.result.features;

    if (features.includes('enemies')) {
      enhancedCode = this.addEnemySystem(enhancedCode);
    }

    if (features.includes('weapons')) {
      enhancedCode = this.addWeaponSystem(enhancedCode);
    }

    if (features.includes('physics')) {
      enhancedCode = this.addPhysicsSystem(enhancedCode);
    }

    if (features.includes('ai')) {
      enhancedCode = this.addAISystem(enhancedCode);
    }

    if (features.includes('multiplayer')) {
      enhancedCode = this.addMultiplayerSystem(enhancedCode);
    }

    if (features.includes('procedural')) {
      enhancedCode = this.addProceduralGeneration(enhancedCode);
    }

    return enhancedCode;
  }

  /**
   * Add enemy system enhancements
   */
  private addEnemySystem(code: string): string {
    const enemyEnhancement = `
// Enhanced Enemy System - Pathfinding and Combat
function EnhancedEnemySystem() {
  const [enemies, setEnemies] = useState(() => {
    return Array.from({ length: GAME_CONFIG.enemyCount }, (_, i) => ({
      id: i,
      position: [
        (Math.random() - 0.5) * 100,
        1,
        (Math.random() - 0.5) * 100
      ],
      health: 100,
      behavior: Math.random() > 0.5 ? 'patrol' : 'chase',
      target: [0, 1, 0], // Player position
      lastAttack: 0
    }));
  });

  useFrame((state, delta) => {
    setEnemies(prev => prev.map(enemy => {
      const distanceToPlayer = Math.sqrt(
        Math.pow(enemy.position[0] - state.camera.position.x, 2) +
        Math.pow(enemy.position[2] - state.camera.position.z, 2)
      );

      if (enemy.behavior === 'chase' && distanceToPlayer < 20) {
        // Move towards player
        const direction = [
          state.camera.position.x - enemy.position[0],
          0,
          state.camera.position.z - enemy.position[2]
        ];
        const length = Math.sqrt(direction[0] ** 2 + direction[2] ** 2);

        if (length > 0) {
          direction[0] /= length;
          direction[2] /= length;

          enemy.position[0] += direction[0] * 2 * delta;
          enemy.position[2] += direction[2] * 2 * delta;
        }

        // Attack if close enough
        if (distanceToPlayer < 3 && state.clock.elapsedTime - enemy.lastAttack > 1) {
          enemy.lastAttack = state.clock.elapsedTime;
          // Trigger damage to player
          window.dispatchEvent(new CustomEvent('playerDamage', { detail: { damage: 10 } }));
        }
      } else if (enemy.behavior === 'patrol') {
        // Patrol behavior
        enemy.position[0] += Math.sin(state.clock.elapsedTime + enemy.id) * delta * 2;
        enemy.position[2] += Math.cos(state.clock.elapsedTime + enemy.id) * delta * 2;
      }

      return enemy;
    }));
  });

  return (
    <>
      {enemies.map(enemy => (
        <group key={enemy.id} position={enemy.position}>
          <mesh castShadow>
            <boxGeometry args={[1, 2, 1]} />
            <meshStandardMaterial
              color={enemy.behavior === 'chase' ? 'darkred' : 'red'}
              emissive={enemy.behavior === 'chase' ? 'darkred' : 'transparent'}
              emissiveIntensity={0.1}
            />
          </mesh>
          {/* Health bar */}
          <mesh position={[0, 2.5, 0]}>
            <planeGeometry args={[1, 0.1]} />
            <meshBasicMaterial
              color={enemy.health > 50 ? 'green' : enemy.health > 25 ? 'yellow' : 'red'}
              transparent
              opacity={0.8}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}`;

    return code.replace(
      '      <EnemySystem />',
      '      <EnhancedEnemySystem />'
    ).replace(
      '// Enemy system',
      enemyEnhancement
    );
  }

  /**
   * Add weapon system
   */
  private addWeaponSystem(code: string): string {
    const weaponSystem = `
// Weapon System
function WeaponSystem({ onFire }: { onFire: (position: number[], direction: number[]) => void }) {
  const weaponRef = useRef<THREE.Group>(null);
  const [ammo, setAmmo] = useState(30);

  useFrame((state) => {
    if (weaponRef.current) {
      // Position weapon relative to camera
      weaponRef.current.position.copy(state.camera.position);
      weaponRef.current.rotation.copy(state.camera.rotation);
      weaponRef.current.translateZ(-1);
      weaponRef.current.translateY(-0.5);
    }
  });

  const handleFire = () => {
    if (ammo > 0) {
      setAmmo(prev => prev - 1);
      if (weaponRef.current) {
        const position = weaponRef.current.position.toArray();
        const direction = weaponRef.current.getWorldDirection(new THREE.Vector3()).toArray();
        onFire(position, direction);
      }
    }
  };

  useEffect(() => {
    const handleClick = () => handleFire();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [ammo]);

  return (
    <group ref={weaponRef}>
      <mesh>
        <boxGeometry args={[0.1, 0.1, 1]} />
        <meshStandardMaterial color="gray" />
      </mesh>
      <div style={{
        position: 'absolute',
        bottom: 20,
        right: 20,
        color: 'white',
        fontFamily: 'monospace',
        fontSize: '14px'
      }}>
        Ammo: {ammo}
      </div>
    </group>
  );
}`;

    return code.replace(
      '      <CollectibleSystem onCollect={handleCollectible} />',
      `      <CollectibleSystem onCollect={handleCollectible} />
      <WeaponSystem onFire={handleWeaponFire} />`
    ).replace(
      '  const handleCollectible = (id: number) => {',
      `  const handleWeaponFire = (position: number[], direction: number[]) => {
    // Create projectile
    console.log('Fired weapon from', position, 'in direction', direction);
  };

  const handleCollectible = (id: number) => {`
    ).replace(
      '/* Generated game content */',
      weaponSystem + '\n\n/* Generated game content */'
    );
  }

  /**
   * Add physics system
   */
  private addPhysicsSystem(code: string): string {
    const physicsSystem = `
// Physics System - Cannon.js Integration
import * as CANNON from 'cannon-es';

function PhysicsSystem() {
  const world = useRef<CANNON.World>();
  const bodies = useRef<Map<string, CANNON.Body>>(new Map());

  useEffect(() => {
    // Initialize physics world
    world.current = new CANNON.World();
    world.current.gravity.set(0, GAME_CONFIG.gravity, 0);

    // Ground body
    const groundBody = new CANNON.Body({
      type: CANNON.Body.KINEMATIC,
      shape: new CANNON.Plane()
    });
    groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    world.current.addBody(groundBody);

    // Player physics body
    const playerBody = new CANNON.Body({
      mass: 1,
      shape: new CANNON.Box(new CANNON.Vec3(0.5, 1, 0.5)),
      position: new CANNON.Vec3(0, 5, 0)
    });
    world.current.addBody(playerBody);
    bodies.current.set('player', playerBody);

    // Clean up
    return () => {
      world.current?.bodies.forEach(body => world.current?.removeBody(body));
    };
  }, []);

  useFrame((state, delta) => {
    if (world.current) {
      // Step physics simulation
      world.current.step(1 / 60, delta, 3);

      // Update Three.js objects to match physics bodies
      bodies.current.forEach((body, key) => {
        if (key === 'player') {
          // Sync camera with physics body
          state.camera.position.copy(body.position as any);
          state.camera.position.y += 1; // Offset for head position
        }
      });
    }
  });

  return null;
}`;

    return code.replace(
      '      <Player />',
      `      <Player />
      <PhysicsSystem />`
    ).replace(
      '/* Generated game content */',
      physicsSystem + '\n\n/* Generated game content */'
    );
  }

  /**
   * Add AI system
   */
  private addAISystem(code: string): string {
    const aiSystem = `
// AI System - Pathfinding and Decision Making
function AISystem() {
  const [aiEntities, setAiEntities] = useState(() => {
    return Array.from({ length: 3 }, (_, i) => ({
      id: i,
      type: Math.random() > 0.5 ? 'guard' : 'scout',
      position: [
        (Math.random() - 0.5) * 50,
        1,
        (Math.random() - 0.5) * 50
      ],
      state: 'idle',
      waypoints: [] as number[][],
      currentWaypoint: 0
    }));
  });

  useFrame((state, delta) => {
    setAiEntities(prev => prev.map(entity => {
      // Decision making
      const distanceToPlayer = Math.sqrt(
        Math.pow(entity.position[0] - state.camera.position.x, 2) +
        Math.pow(entity.position[2] - state.camera.position.z, 2)
      );

      if (distanceToPlayer < 10) {
        entity.state = 'alert';
        // Generate path to player
        entity.waypoints = [
          [state.camera.position.x, 1, state.camera.position.z]
        ];
        entity.currentWaypoint = 0;
      } else if (entity.waypoints.length === 0) {
        entity.state = 'patrol';
        // Generate random patrol waypoints
        entity.waypoints = Array.from({ length: 4 }, () => [
          (Math.random() - 0.5) * 40,
          1,
          (Math.random() - 0.5) * 40
        ]);
      }

      // Movement along waypoints
      if (entity.waypoints.length > 0) {
        const target = entity.waypoints[entity.currentWaypoint];
        const direction = [
          target[0] - entity.position[0],
          0,
          target[2] - entity.position[2]
        ];
        const distance = Math.sqrt(direction[0] ** 2 + direction[2] ** 2);

        if (distance > 1) {
          direction[0] /= distance;
          direction[2] /= distance;

          entity.position[0] += direction[0] * 2 * delta;
          entity.position[2] += direction[2] * 2 * delta;
        } else {
          // Move to next waypoint
          entity.currentWaypoint = (entity.currentWaypoint + 1) % entity.waypoints.length;
        }
      }

      return entity;
    }));
  });

  return (
    <>
      {aiEntities.map(entity => (
        <mesh key={entity.id} position={entity.position}>
          <cylinderGeometry args={[0.5, 0.5, 2]} />
          <meshStandardMaterial
            color={entity.type === 'guard' ? 'blue' : 'green'}
            emissive={entity.state === 'alert' ? 'red' : 'transparent'}
            emissiveIntensity={entity.state === 'alert' ? 0.3 : 0}
          />
        </mesh>
      ))}
    </>
  );
}`;

    return code.replace(
      '      <EnemySystem />',
      `      <EnemySystem />
      <AISystem />`
    ).replace(
      '/* Generated game content */',
      aiSystem + '\n\n/* Generated game content */'
    );
  }

  /**
   * Add multiplayer system
   */
  private addMultiplayerSystem(code: string): string {
    const multiplayerSystem = `
// Multiplayer System - WebSocket-based networking
function MultiplayerSystem() {
  const [connectedPlayers, setConnectedPlayers] = useState([] as any[]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Connect to multiplayer server
    try {
      const ws = new WebSocket('ws://localhost:8080');
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('connected');
        console.log('Connected to multiplayer server');
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'playerUpdate') {
          setConnectedPlayers(data.players);
        }
      };

      ws.onclose = () => {
        setConnectionStatus('disconnected');
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('disconnected');
      };

      // Send position updates
      const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'positionUpdate',
            position: [0, 0, 0], // Would be actual player position
            timestamp: Date.now()
          }));
        }
      }, 100); // 10 FPS

      return () => {
        clearInterval(interval);
        ws.close();
      };
    } catch (error) {
      console.error('Failed to connect to multiplayer server:', error);
      setConnectionStatus('disconnected');
    }
  }, []);

  return (
    <>
      {/* Other players */}
      {connectedPlayers.map(player => (
        <mesh key={player.id} position={player.position}>
          <capsuleGeometry args={[0.5, 1]} />
          <meshStandardMaterial color="cyan" />
        </mesh>
      ))}

      {/* Connection status indicator */}
      <div style={{
        position: 'absolute',
        top: 10,
        right: 10,
        color: connectionStatus === 'connected' ? 'green' :
               connectionStatus === 'connecting' ? 'yellow' : 'red',
        fontFamily: 'monospace',
        fontSize: '12px'
      }}>
        MP: {connectionStatus.toUpperCase()}
      </div>
    </>
  );
}`;

    return code.replace(
      '      <CollectibleSystem onCollect={handleCollectible} />',
      `      <CollectibleSystem onCollect={handleCollectible} />
      <MultiplayerSystem />`
    ).replace(
      '/* Generated game content */',
      multiplayerSystem + '\n\n/* Generated game content */'
    );
  }

  /**
   * Add procedural generation system
   */
  private addProceduralGeneration(code: string): string {
    const proceduralSystem = `
// Procedural Generation System
function ProceduralWorldSystem() {
  const [worldChunks, setWorldChunks] = useState(() => {
    const chunks = [];
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        chunks.push({
          x: x * 50,
          z: z * 50,
          trees: Array.from({ length: Math.floor(Math.random() * 10) + 5 }, () => ({
            position: [
              x * 50 + (Math.random() - 0.5) * 40,
              0,
              z * 50 + (Math.random() - 0.5) * 40
            ],
            height: Math.random() * 5 + 3,
            type: Math.random() > 0.5 ? 'pine' : 'oak'
          })),
          rocks: Array.from({ length: Math.floor(Math.random() * 5) + 2 }, () => ({
            position: [
              x * 50 + (Math.random() - 0.5) * 40,
              0.5,
              z * 50 + (Math.random() - 0.5) * 40
            ],
            size: Math.random() * 2 + 0.5
          }))
        });
      }
    }
    return chunks;
  });

  return (
    <>
      {worldChunks.map((chunk, chunkIndex) => (
        <group key={chunkIndex}>
          {/* Trees */}
          {chunk.trees.map((tree, treeIndex) => (
            <group key={treeIndex} position={tree.position}>
              <mesh position={[0, tree.height / 2, 0]}>
                <cylinderGeometry args={[0.2, 0.3, tree.height]} />
                <meshStandardMaterial color="#8B4513" />
              </mesh>
              <mesh position={[0, tree.height + 1, 0]}>
                <coneGeometry args={[1.5, 3]} />
                <meshStandardMaterial color="#228B22" />
              </mesh>
            </group>
          ))}

          {/* Rocks */}
          {chunk.rocks.map((rock, rockIndex) => (
            <mesh key={rockIndex} position={rock.position}>
              <dodecahedronGeometry args={[rock.size]} />
              <meshStandardMaterial color="#696969" />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}`;

    return code.replace(
      '      {/* Game Objects */}',
      `      {/* Procedural World */}
      <ProceduralWorldSystem />

      {/* Game Objects */}`
    ).replace(
      '/* Generated game content */',
      proceduralSystem + '\n\n/* Generated game content */'
    );
  }
}