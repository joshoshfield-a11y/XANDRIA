/**
 * PLATFORMER — side-scroll 3D: floating platform course over a hazard floor, coins on arcs,
 * patrolling walkers, double-jump/dash moveset, goal flag at the summit.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import { VariantDirector } from './enemies';
import {
  EffectState,
  EffectHud,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
  wrapShieldDamage,
} from './fx';
import { ChapterDresser, ParallaxLayers } from './dressing';
import { Structures } from '../engine/world/Structures';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';
import { Rng } from '../engine/core/Rng';

export function buildPlatformer(engine: Engine, spec: GameSpec) {
  const { scene, hud, terrain } = engine;
  const rng = new Rng(spec.meta.seed ^ 0x4a7f);

  // M2: snapshot the pristine run config before any run-time mutation.
  snapshotLoadoutBase(spec);
  // M7: drop stale asset-bridge roots left by the previous run (no-op at boot).
  engine.assetBridge.dispose();

  // campaign layer: XP progression (the intro card is shown by Engine.beginPlay)
  const prog = new Progression(engine);
  let notifyLevelUp: () => void = () => {};
  // content depth: enemy variants, timed pickup effects, chapter dressing
  const fx = new EffectState();
  const fxHud = new EffectHud();
  const dresser = new ChapterDresser(engine);

  // asset registry (reskin layer): world assets first, the rest after spawns
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  // world = mostly visual; course floats above a hazard
  const startY = Math.max(3, terrain.heightAt(-terrain.size / 2 + 14, 0) + 3);
  const start = new THREE.Vector3(-terrain.size / 2 + 14, startY, 0);
  const dir = new THREE.Vector3(1, 0, 0.08);

  // background parallax layers (distant ridges drifting with the camera)
  const parallax = new ParallaxLayers(engine, rng.fork(4242), spec, startY);

  const structures = new Structures(engine.physics, engine.mats);
  const difficulty = spec.rules.difficulty;
  const gapBoost = difficulty === 'hard' ? 1.2 : difficulty === 'easy' ? 0.8 : 1;
  const platforms = structures.platforms(spec.meta.seed, 26, start, dir, {
    gapMin: 3.2 * gapBoost,
    gapMax: 5.2 * gapBoost,
    sizeMin: difficulty === 'hard' ? 2.2 : 2.8,
    sizeMax: 4.6,
    riseMax: difficulty === 'easy' ? 1.1 : 1.7,
  });
  scene.add(structures.group);

  // hazard floor: lava/void plane far below
  const hazardY = startY - 22;
  const hazard = new THREE.Mesh(
    new THREE.PlaneGeometry(terrain.size * 2, terrain.size * 2),
    engine.mats.standard('lava', spec.theme.environment === 'volcanic' ? '#ff4a1f' : '#1a0f2e', {
      emissive: spec.theme.environment === 'volcanic' ? '#ff3300' : '#6a3fd8',
      emissiveIntensity: 0.9,
    }),
  );
  hazard.rotation.x = -Math.PI / 2;
  hazard.position.y = hazardY;
  scene.add(hazard);
  const hazardLight = new THREE.PointLight(spec.theme.environment === 'volcanic' ? '#ff5a2f' : '#7a4fe8', 1.4, 90);
  hazardLight.position.set(start.x + 40, hazardY + 8, 0);
  scene.add(hazardLight);

  // goal at final platform
  const last = platforms[platforms.length - 1];
  const goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
  goal.position.copy(last.pos);
  scene.add(goal);

  // player
  const projectiles = null;
  let avatar: PlayerAvatar;
  const enemies = new EnemyManager(engine, null, {
    onPlayerHit: (dmg, from) => avatar.damage(dmg, from),
    // platformer has no player weapons; walkers are stompable hazards —
    // if one dies (stomp/hazard/fall), it still feeds the XP economy, and
    // kills now count toward kill stages too (B1: onDeath never reported)
    onDeath: (e) => {
      variants.onEnemyDeath(e);
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp);
      objectives.addProgress(1, 'kill');
    },
  });
  // enemy variants: spikeballs (never stomp) + skyrays (sine patrol)
  const variants = new VariantDirector(engine, enemies, null, 31337);
  avatar = new PlayerAvatar(engine, spec, start.clone().add(new THREE.Vector3(0, 2, 0)), enemies, projectiles);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // walkers patrol the bigger platforms — some are spikeballs (stomping hurts!)
  const patrolPlatforms = platforms.filter((p, i) => i > 2 && i < platforms.length - 2 && p.size.x > 3.4);
  const walkers = spec.enemies.filter((e) => e.kind === 'walker');
  const nEnemies = Math.min(patrolPlatforms.length, walkers.reduce((n, e) => n + e.count, 0) || 4);
  for (let i = 0; i < nEnemies; i++) {
    const p = patrolPlatforms[Math.floor((i / nEnemies) * patrolPlatforms.length)];
    const variant = rng.chance(0.35) ? 'spikeball' : null;
    const before = enemies.enemies.length;
    enemies.spawnAll([{ kind: 'walker', count: 1, health: 25, speed: 2.5, damage: 10, weapon: 'melee' }], () => p.pos.clone().add(new THREE.Vector3(0, 1, 0)));
    const e = enemies.enemies[before];
    if (e) { variants.register(e, variant); variants.decorate(e, variant); }
  }

  // skyrays: sine-patrolling flyers over the later platforms
  const rayPlatforms = platforms.filter((p, i) => i > Math.floor(platforms.length * 0.4) && i < platforms.length - 1);
  const nRays = Math.min(3, Math.max(1, Math.floor(rayPlatforms.length / 4)));
  for (let i = 0; i < nRays; i++) {
    const p = rayPlatforms[Math.floor(((i + 0.5) / nRays) * rayPlatforms.length)];
    const before = enemies.enemies.length;
    enemies.spawnAll([{ kind: 'flyer', count: 1, health: 30, speed: 4, damage: 8, weapon: 'blaster' }], () => p.pos.clone().add(new THREE.Vector3(0, 0.1, 0)));
    const e = enemies.enemies[before];
    if (e) { variants.register(e, 'skyray'); variants.decorate(e, 'skyray'); }
  }

  // coins along jump arcs between platforms
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'coin') {
        engine.score += Math.round(50 * fx.scoreMult());
        engine.audio.play('coin');
        hud.setScore(engine.score);
        // B1: route by current stage type, not the legacy objective type
        objectives.addProgress(1, 'collect');
      }
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    }
    grantPickupXp(prog, notifyLevelUp);
  };
  for (let i = 0; i < platforms.length - 1; i++) {
    const a = platforms[i].pos, b = platforms[i + 1].pos;
    const n = Math.max(2, Math.floor(a.distanceTo(b) / 1.6));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const p = a.clone().lerp(b, t);
      p.y += Math.sin(t * Math.PI) * 1.6 + 0.8; // arc
      pickups.spawn('coin', p);
    }
  }
  // health mid-course
  const mid = platforms[Math.floor(platforms.length / 2)];
  pickups.spawn('health', mid.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));
  // timed effect pickups on later platforms: magnet + shield
  const q1 = platforms[Math.floor(platforms.length * 0.3)];
  const q3 = platforms[Math.floor(platforms.length * 0.7)];
  spawnEffectPickup(pickups, engine, 'magnet', q1.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));
  spawnEffectPickup(pickups, engine, 'shield', q3.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));

  // asset registration: enemies (dynamic roots), pickups, platforms, hazard
  registerEnemyAssets(assets, enemies, ['walker', 'flyer'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('world.platform', { kind: 'world', roots: [structures.group, hazard] });
  assets.applyOverrides(spec);

  // clamp collect targets (legacy or staged) to coins actually placed on the course
  const clampCollect = (count: number) => Math.min(count || 20, pickups.remaining('coin'));
  const objSpec = spec.objective.stages
    ? { ...spec.objective, stages: spec.objective.stages.map((s) => s.type === 'collect' ? { ...s, count: clampCollect(s.count) } : s) }
    : spec.objective.type === 'collect'
      ? { ...spec.objective, count: clampCollect(spec.objective.count) }
      : spec.objective;
  const objectives = makeCampaignObjectives(engine, { ...spec, objective: objSpec }, undefined, () => prog.level);
  // N1: touch-aware hint bar
  hud.setHint(isTouchDevice()
    ? 'D-pad move · JUMP jump (x2) · reach the flag · stomp foes (not the spiky ones!)'
    : 'A/D move · Space jump (x2) · Shift dash · reach the flag · stomp foes (not the spiky ones!)');

  // chapter-0 floating dressing (crystals drift near the course)
  const courseCx = start.x + 60;
  dresser.dress(spec, 0, rng.fork(5000), {
    cx: courseCx, cz: 0, half: 70,
    yAt: () => startY,
  }, { floating: true });
  let lastStage = 0;

  const camRig = makeCameraRig('side', engine.camera, engine.input);

  engine.onUpdate((dt) => {
    const t = engine.time;
    // side camera sits at +z looking -z, so screen-right is world +x:
    // camYaw = 0 maps D to +x (the old -PI/2 sent D into the screen)
    avatar.ctrl.camYaw = 0;
    avatar.update(dt, t);
    enemies.update(dt, avatar.ctrl.position, t);
    variants.update(dt, avatar.ctrl.position, t);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    fx.tick(dt, spec);
    fxHud.update(fx, t);
    parallax.update(engine.camera.position.x);

    // chapter transitions: fresh dressing + difficulty ramp
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), {
        cx: courseCx, cz: 0, half: 70,
        yAt: () => startY,
      }, { floating: true });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the quest-graph array index.
      variants.applyStageScaling(objectives.stagesCleared);
    }

    const pp = avatar.ctrl.position;

    // stomp: falling onto a foe kills it — unless it's a spikeball, which hurts
    if (avatar.ctrl.velocity.y < -3 && engine.state === 'playing') {
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const ep = e.position;
        if (Math.hypot(pp.x - ep.x, pp.z - ep.z) < 1.3 && pp.y > ep.y + 0.9 && pp.y < ep.y + 2.8) {
          if (variants.getVariant(e) === 'spikeball') {
            avatar.damage(18, ep);
            engine.audio.play('hurt');
          } else {
            e.damage(9999, pp);
            engine.audio.play('hit');
          }
          avatar.ctrl.body.velocity.y = 9; // bounce
          break;
        }
      }
    }
    if (pp.y < hazardY + 2) {
      avatar.damage(34);
      // bounce back to last platform
      let best = platforms[0].pos, bd = Infinity;
      for (const p of platforms) {
        if (p.pos.y > pp.y) continue;
        const d = Math.abs(p.pos.x - pp.x);
        if (d < bd) { bd = d; best = p.pos; }
      }
      avatar.ctrl.teleport(best.clone().add(new THREE.Vector3(0, 2, 0)));
      engine.audio.play('hurt');
    }
    if (pp.distanceTo(goal.position) < 3) objectives.reachedGoal();

    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives, assets };
}
