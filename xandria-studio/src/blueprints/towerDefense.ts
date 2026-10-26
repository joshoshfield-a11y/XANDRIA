/**
 * TOWER DEFENSE — defend the Core: waves of hostiles march on the glowing
 * core at the arena's heart. The player fights on foot (twin-stick style:
 * WASD + mouse aim) and spends score on turret pads ([E] to build) ringing
 * the core. Each wave's kill quota comes from the spec's quest stages, so the
 * run is winnable by construction; if the core's HP hits zero the run ends.
 *
 * Composes the proven combat stack (EnemyManager + Projectiles + Objectives).
 * Enemies target the CORE, not the player — the blueprint passes the core
 * position as the EnemyManager target. Turrets are blueprint-local static
 * meshes firing friendly projectiles; no EnemyAI contract changes.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager, type Enemy } from '../engine/game/EnemyAI';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import {
  makeCampaignObjectives,
  bossPhaseBanner,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { VariantDirector, planSpawns, isBossStageActive, ARENA_VARIANTS } from './enemies';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import { ChapterDresser } from './dressing';
import { Structures } from '../engine/world/Structures';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { PlayerAvatar } from './common';
import { buildItemKit, type BlueprintItemKit } from './itemKit';
import { GatheringManager, GatheringInteractionSession } from '../engine/game/gathering';
import {
  resolveCraftingEnabled,
  ensureCraftingItemDefs,
  buildRecipePool,
  resolveGatheringDensity,
} from '../engine/game/crafting';
import { StationManager, CraftingInteractionSession } from '../engine/game/stations';

interface Turret {
  group: THREE.Group;
  head: THREE.Group;
  muzzle: THREE.Object3D;
  pos: THREE.Vector3;
  cd: number;
}

export function buildTowerDefense(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(909);
  const arenaR = Math.min(44, terrain.size / 2 - 10);
  const td = (spec.custom as any)?.towerDefense ?? {};
  const waves = typeof td.waves === 'number' ? td.waves : 4;
  const turretCost = typeof td.turretCost === 'number' ? td.turretCost : 150;
  let coreHp = typeof td.baseHealth === 'number' ? td.baseHealth : 120;
  const coreMax = coreHp;

  snapshotLoadoutBase(spec);
  engine.assetBridge.dispose();

  const dresser = new ChapterDresser(engine);
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  const structures = new Structures(engine.physics, engine.mats);
  const groundY = terrain.heightAt(0, 0);
  structures.arenaWalls(new THREE.Vector3(0, groundY, 0), arenaR, 4);
  structures.arenaCover(spec, terrain, 10, arenaR - 8, spec.meta.seed ^ 77);
  scene.add(structures.group);
  const landmarks = structures.landmarks(spec, terrain, scene, spec.meta.seed, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }], quality: engine.effectiveQuality(),
    maxRealLights: engine.tiers.flags.maxRealLights,
  });
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
    heroExclusion: [{ x: 0, z: 0, r: 12 }],
    engine,
    quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul,
    windMul: engine.tiers.flags.windMul,
    heroSpots: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  structures.structureSets(spec, terrain, scene, spec.meta.seed, {
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }], quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul,
    structureShadows: engine.tiers.flags.structureShadows,
  });
  scatterAmberGlow(scene, rng.fork(0xe9a1), {
    mats: engine.mats,
    groundY: (x, z) => terrain.heightAt(x, z),
    half: terrain.size / 2 - 10,
    exclusion: [{ x: 0, z: 0, r: arenaR + 6 }],
    quality: engine.effectiveQuality(),
  });
  attachLightShafts(engine);

  // the Core: glowing crystal on a plinth at the arena heart
  const corePos = new THREE.Vector3(0, groundY, 0);
  const coreGroup = new THREE.Group();
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(4, 1.2, 4), engine.mats.flat('#3a3f4a'));
  plinth.position.y = 0.6;
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.6),
    engine.mats.glow(spec.theme.palette.accent, 2.5),
  );
  crystal.position.y = 3.2;
  coreGroup.add(plinth, crystal);
  coreGroup.position.copy(corePos);
  scene.add(coreGroup);

  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  // enemies that reach the core detonate on it — no kill credit, no quota
  // progress; the core takes the hit instead
  const detonated = new Set<Enemy>();
  const setObjectiveText = () => {
    const waveNo = Math.min(objectives.currentStageIndex + 1, waves);
    hud.setObjective('DEFEND THE CORE', `Wave ${waveNo}/${waves} · Core ${Math.max(0, Math.ceil(coreHp))}/${coreMax}`);
  };

  const enemies = new EnemyManager(engine, projectiles, {
    // TD: the manager's target is the CORE — melee-range arrivals detonate on
    // it via the loop below, so onPlayerHit only counts when the hit actually
    // lands near the player (otherwise the avatar would take phantom hits
    // from across the map whenever a walker reaches the core).
    onPlayerHit: (dmg, from) => {
      if (from && from.distanceTo(corePos) < 5) return;
      avatar.damage(dmg, from); camRig.shake(0.55); combatPulse();
    },
    onDeath: (e) => {
      variants.onEnemyDeath(e);
      if (detonated.has(e)) { detonated.delete(e); return; } // core detonation: no credit
      engine.score += 100;
      hud.setScore(engine.score);
      objectives.addProgress(1, 'kill');
      combatPulse();
      if (rng.chance(0.15)) pickups.spawn('health', e.position.clone());
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  }, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  const variants = new VariantDirector(engine, enemies, projectiles);

  // player spawns beside the core, fights twin-stick style
  const avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(6, terrain.heightAt(6, 0) + 2, 0), enemies, projectiles);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });

  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { target.damage(p.damage, point); combatPulse(); engine.juice.spawnText(engine.camera, point, 'playerDamage', p.damage); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    if (p.kind === 'coin') { engine.score += 50; hud.setScore(engine.score); engine.audio.play('coin'); }
  };

  // UPGRADE LOOP (blueprint-rollout): crafting/gathering/stations layer
  // parity -- TD is the generator-variety blueprint's natural home for it.
  // Gated on the crafting spec flag (default true); map-local lifecycle via
  // engine.portalEntities like the other blueprints. TD has no SkillSystem
  // or QuestManager, so the session runs with playerLevel 1 and no skill
  // gates (skillId-gated recipes fail closed, honestly blocked).
  const craftingEnabled = resolveCraftingEnabled(spec);
  if (craftingEnabled) ensureCraftingItemDefs(spec);
  const itemKit: BlueprintItemKit | null = buildItemKit(engine, spec, avatar);
  const gathering = new GatheringManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    inventory: itemKit?.inventory ?? null,
    density: resolveGatheringDensity(spec),
  });
  engine.portalEntities.register(gathering);
  if (craftingEnabled) gathering.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  const stations = new StationManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  engine.portalEntities.register(stations);
  if (craftingEnabled) stations.spawnForMap(spec.meta.seed);
  const stationSession = craftingEnabled
    ? new CraftingInteractionSession(engine, stations, {
        recipes: () => buildRecipePool(spec),
        defs: () => spec.custom?.items?.defs ?? {},
        inventory: () => itemKit?.inventory ?? null,
        playerLevel: () => 1,
        toast: (m) => engine.hud.toast(m),
      })
    : null;
  const gatheringSession = new GatheringInteractionSession(engine, gathering, {
    isModalOpen: () => stationSession?.isPanelOpen ?? false,
  });

  // turret pads: deterministic ring around the core
  interface Pad { pos: THREE.Vector3; mesh: THREE.Mesh; ring: THREE.Mesh; turret: Turret | null; }
  const pads: Pad[] = [];
  const padCount = 6;
  const padMat = engine.mats.flat('#2e3340');
  const ringMat = engine.mats.glow(spec.theme.palette.accent, 1.2);
  for (let i = 0; i < padCount; i++) {
    const a = (i / padCount) * Math.PI * 2 + rng.range(-0.1, 0.1);
    const r = 11 + rng.range(-1, 1);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = terrain.heightAt(x, z);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.9, 0.5, 10), padMat);
    mesh.position.set(x, y + 0.25, z);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.12, 8, 24),
      engine.mats.flat('#3a4050'),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.55, z);
    scene.add(mesh, ring);
    pads.push({ pos: new THREE.Vector3(x, y, z), mesh, ring, turret: null });
  }

  const buildTurret = (pad: Pad) => {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.6, 1.4), engine.mats.flat('#4a5060'));
    base.position.y = 1.3;
    const head = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), engine.mats.flat(spec.theme.palette.secondary));
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.8, 8), engine.mats.flat('#22262e'));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 1.1;
    const muzzle = new THREE.Object3D();
    muzzle.position.z = 2.0;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), engine.mats.glow(spec.theme.palette.accent, 2));
    eye.position.set(0, 0.35, 0.55);
    head.add(dome, barrel, muzzle, eye);
    head.position.y = 2.4;
    group.add(base, head);
    group.position.copy(pad.pos).add(new THREE.Vector3(0, 0.5, 0));
    scene.add(group);
    pad.ring.material = ringMat;
    pad.turret = { group, head, muzzle, pos: group.position.clone(), cd: rng.range(0, 0.5) };
    engine.audio.play('powerup');
    engine.particles.magic(pad.pos.clone().add(new THREE.Vector3(0, 1.5, 0)), spec.theme.palette.accent, 14);
  };

  const objectives = makeCampaignObjectives(engine, spec);
  hud.setHint(isTouchDevice()
    ? 'Left stick move · auto-attack · stand on a pad + BUILD to place a turret'
    : 'WASD move · mouse aim · LMB fire · stand on a pad + [E] build turret (150) · Esc pause');
  setObjectiveText();

  const camRig = makeCameraRig('top-down', engine.camera, input, (x, z) => terrain.heightAt(x, z),
    { physics: engine.physics, skipBody: avatar.ctrl.body });

  // wave director: one quest stage per wave; the quota is the stage count
  const walkerSpec = spec.enemies.find((e) => e.kind === 'walker')
    ?? spec.enemies[0]
    ?? { kind: 'walker' as const, count: 8, health: 28, speed: 4.2, damage: 9, weapon: 'melee' as const };
  const bruteSpec = spec.enemies.find((e) => e.kind === 'brute');
  const spawnEdge = () => {
    const a = rng.range(0, Math.PI * 2);
    const pos = new THREE.Vector3(Math.cos(a) * (arenaR - 3), 0, Math.sin(a) * (arenaR - 3));
    pos.y = terrain.heightAt(pos.x, pos.z) + 1.2;
    return pos;
  };
  // wave flow: one quest stage per wave; each stage's wave spawns once after a
  // short grace period, then the next stage starts when its quota is cleared
  let lastStage = -1;
  let pendingWave = -1;
  let intermission = 3.0; // grace before wave 1
  const spawnWave = (waveIdx: number) => {
    const stage = spec.objective.stages?.[waveIdx];
    const quota = stage?.count ?? 8;
    const last = waveIdx === waves - 1;
    const list: typeof walkerSpec[] = [];
    const walkers = last && bruteSpec ? quota - 1 : quota;
    for (let i = 0; i < walkers; i++) list.push({ ...walkerSpec, count: 1 });
    if (last && bruteSpec) list.push({ ...bruteSpec, count: 1 });
    for (const s of list) {
      const planned = planSpawns([s], rng, waveIdx, ARENA_VARIANTS)[0];
      const before = enemies.enemies.length;
      enemies.spawnAll([planned.spec], () => spawnEdge());
      const e = enemies.enemies[before];
      if (e) { variants.register(e, planned.variant); variants.decorate(e, planned.variant); }
    }
    assets.applyOverrides(spec);
    hud.showCard(`WAVE ${waveIdx + 1}`, last ? 'The alpha marches with them — hold the line!' : 'They come for the Core.');
    engine.audio.play('alarm');
  };

  registerEnemyAssets(assets, enemies, ['walker', 'brute'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);

  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
  const aimPoint = new THREE.Vector3(1, 0, 0);
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpDir = new THREE.Vector3();
  const tmpMuzzle = new THREE.Vector3();

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw;
    avatar.update(dt, t);
    itemKit?.update(dt);
    gatheringSession.update(dt); // UPGRADE LOOP (blueprint-rollout): [E] Harvest prompt + registration refresh
    stationSession?.update(dt); // UPGRADE LOOP (blueprint-rollout): [E] Use prompt + crafting panel

    // twin-stick aim + fire (same pattern as the top-down shooter)
    const pp = avatar.ctrl.position;
    groundPlane.constant = -(pp.y + 0.9);
    raycaster.setFromCamera(new THREE.Vector2(input.pointer.x, input.pointer.y), engine.camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, aimPoint);
    const aimDir = new THREE.Vector3(1, 0, 0);
    if (hit) {
      aimDir.copy(aimPoint).sub(pp).setY(0);
      if (aimDir.lengthSq() > 0.01) {
        aimDir.normalize();
        avatar.ctrl.yaw = Math.atan2(aimDir.x, aimDir.z) - Math.PI;
        avatar.ctrl.rig.group.rotation.y = avatar.ctrl.yaw + Math.PI;
      }
    }
    if ((input.pressed('attack') || input.justPressed('attack')) && engine.state === 'playing') {
      avatar.shoot(aimDir.clone(), pp.clone().add(new THREE.Vector3(0, 1.1, 0)));
    }

    // turret construction: nearest free pad in range + [E]
    let nearPad: Pad | null = null;
    for (const pad of pads) {
      if (pad.turret) continue;
      if (pad.pos.distanceTo(pp) < 3.5) { nearPad = pad; break; }
    }
    if (nearPad && engine.state === 'playing') {
      hud.setHint(engine.score >= turretCost
        ? `[E] Build turret (${turretCost} score)`
        : `Need ${turretCost - engine.score} more score for a turret`);
      // UPGRADE LOOP (blueprint-rollout): a live station prompt owns [E]
      // -- the turret build defers so one keypress can't double-fire.
      if (input.justPressed('interact') && engine.score >= turretCost && !stationSession?.promptedStation) {
        engine.score -= turretCost;
        hud.setScore(engine.score);
        buildTurret(nearPad);
        hud.setHint(isTouchDevice() ? 'Left stick move · auto-attack' : 'WASD move · mouse aim · LMB fire · Esc pause');
      }
    }

    // turrets: nearest enemy in 26m, 0.8s cycle
    for (const pad of pads) {
      const tw = pad.turret;
      if (!tw) continue;
      tw.cd -= dt;
      const target = enemies.nearest(tw.pos, 26);
      if (target) {
        tmpDir.copy(target.position).sub(tw.pos).setY(0).normalize();
        tw.head.rotation.y = Math.atan2(tmpDir.x, tmpDir.z);
        if (tw.cd <= 0 && engine.state === 'playing') {
          tw.cd = 0.8;
          tw.muzzle.getWorldPosition(tmpMuzzle);
          projectiles.fire(tmpMuzzle, tmpDir.clone(), { speed: 40, damage: 14, friendly: true, life: 1.4 });
          engine.audio.play('laser', { vol: 0.4 });
        }
      }
    }

    // enemies march on the CORE; arrivals detonate on it
    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    enemies.update(dt, corePos, t);
    gathering.update(dt); // UPGRADE LOOP (blueprint-rollout): static node submits into the shared instancer frame
    stations.update(dt); // UPGRADE LOOP (blueprint-rollout): static station submits into the shared instancer frame
    inst.endFrame();
    for (const e of [...enemies.enemies]) {
      if (!e.alive) continue;
      tmpDir.copy(e.position).setY(corePos.y);
      if (tmpDir.distanceTo(corePos) < 3.2) {
        detonated.add(e);
        coreHp -= e.spec.damage * 2;
        engine.particles.magic(e.position.clone(), '#ff5a2f', 18);
        engine.audio.play('explosion');
        camRig.shake(0.7);
        e.damage(100000, e.position);
        setObjectiveText();
        if (coreHp <= 0) { engine.lose('The Core was destroyed.'); return; }
      }
    }

    variants.update(dt, pp, t);
    projectiles.update(dt);
    pickups.update(dt, pp, 2.6);
    objectives.update(dt);

    // wave flow: spawn the pending stage's wave once its grace period elapses
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      pendingWave = stageIdx;
      intermission = 2.5;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half: arenaR - 8, yAt: (x, z) => terrain.heightAt(x, z) });
      variants.applyStageScaling(objectives.stagesCleared);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
      setObjectiveText();
    }
    if (pendingWave >= 0 && !objectives.done && engine.state === 'playing') {
      intermission -= dt;
      if (intermission <= 0) {
        spawnWave(pendingWave);
        pendingWave = -1;
      }
    }

    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    variants.updateBossBar(isBossStageActive(spec, objectives));
    crystal.rotation.y += dt * 0.8;
    crystal.position.y = 3.2 + Math.sin(t * 2) * 0.25;

    if (pp.y < -40) { avatar.damage(1000); camRig.shake(0.8); }
    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, objectives, assets, pads, get coreHp() { return coreHp; }, gathering, stations, stationSession, gatheringSession, itemKit, itemWorld: itemKit?.itemWorld ?? null };
}
