/**
 * REFERENCE BLUEPRINT — third-person action adventure.
 * Humanoid + melee/ranged, enemies roaming a themed world, pickups, eliminate/collect/reach/boss objectives.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  bossPhaseBanner,
  needsReachGoal,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import {
  VariantDirector,
  planSpawns,
  isBossStageActive,
  ACTION_VARIANTS,
} from './enemies';
import {
  EffectState,
  EffectHud,
  scatterEffects,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
  wrapShieldDamage,
} from './fx';
import { ChapterDresser } from './dressing';
import { Scatter } from '../engine/world/Scatter';
import { Structures } from '../engine/world/Structures';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';

export function buildThirdPersonAction(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud } = engine;
  const rng = engine.rng.fork(101);

  // M2: snapshot the pristine run config before any run-time mutation, so
  // restarts restore the true base (not a mutated one).
  snapshotLoadoutBase(spec);
  // M7: in-place restarts tear down the scene but never cleared the asset
  // bridge's roots — drop the stale refs (no-op at boot).
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

  // --- world dressing
  const structures = new Structures(engine.physics, engine.mats);
  if (spec.world.scatter.buildings > 0) structures.city(spec, terrain, spec.world.scatter.buildings, spec.meta.seed);
  scene.add(structures.group);
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: 12 }],
    engine,
  });

  // --- combat systems
  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let avatar: PlayerAvatar;

  // FIX 5: combat music intensity — pulsed up by combat events, decays to baseline
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  const enemies = new EnemyManager(engine, projectiles, {
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    onDeath: (e) => {
      variants.onEnemyDeath(e); // splitter minis + visual cleanup first
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp);
      objectives.addProgress(1, 'kill'); // M5: kills only count toward kill stages
      combatPulse();
      const d = e.position.distanceTo(avatar.ctrl.position);
      if (d < 14) camRig.shake(0.6 * (1 - d / 14));
      if (rng.chance(0.3)) pickups.spawn(rng.chance(0.6) ? 'health' : 'coin', e.position.clone().add(new THREE.Vector3(0, 0.6, 0)));
      else if (rng.chance(0.12)) {
        const kinds = ['shield', 'rapid', 'mult', 'magnet'] as const;
        spawnEffectPickup(pickups, engine, kinds[rng.int(0, 3)], e.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
      }
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  });
  // enemy variants: shielded bruisers + ranged casters over the base kinds
  const variants = new VariantDirector(engine, enemies, projectiles);

  // --- player
  const spawnY = terrain.heightAt(0, 0);
  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, spawnY + 2, 0), enemies, projectiles);
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { target.damage(p.damage * prog.damageMult(), point); combatPulse(); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  // --- enemies spawn ringed around spawn
  const spawnFor = (kind: string, i: number, n: number): THREE.Vector3 => {
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const r = kind === 'turret' ? rng.range(18, 40) : rng.range(12, terrain.size / 2 - 20);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!terrain.inBounds(x, z)) continue;
      return new THREE.Vector3(x, terrain.heightAt(x, z) + 1, z);
    }
    return new THREE.Vector3(rng.range(-20, 20), spawnY + 2, rng.range(-20, 20));
  };
  // --- enemies spawn ringed around spawn, with chapter-0 variants
  const planned = planSpawns(spec.enemies, rng, 0, ACTION_VARIANTS);
  {
    const before = enemies.enemies.length;
    enemies.spawnAll(spec.enemies, spawnFor);
    enemies.enemies.slice(before).forEach((e, idx) => {
      const p = planned[idx];
      variants.register(e, p ? p.variant : null);
      if (p) variants.decorate(e, p.variant);
    });
  }

  // --- pickups
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'coin') { engine.score += Math.round(50 * fx.scoreMult()); engine.audio.play('coin'); objectives.addProgress(1, 'collect'); }
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
      if (p.kind === 'ammo') { avatar.addAmmo(24); engine.audio.play('pickup'); }
      if (p.kind === 'powerup') { avatar.ctrl.speedBoostT = 6; engine.audio.play('powerup'); hud.toast('SPEED SURGE'); }
    }
    grantPickupXp(prog, notifyLevelUp);
    hud.setScore(engine.score);
  };
  const half = terrain.size / 2 - 12;
  pickups.scatterTerrain(
    { coin: spec.pickups.coins, health: spec.pickups.health, ammo: spec.pickups.ammo, powerup: spec.pickups.powerups },
    (x, z) => terrain.heightAt(x, z), half, spec.meta.seed,
    [{ x: 0, z: 0, r: 6 }],
  );
  // timed effect pickups: shield / rapid-fire / score×2 / magnet
  scatterEffects(pickups, engine, rng.fork(913), (x, z) => terrain.heightAt(x, z), half,
    ['shield', 'rapid', 'mult', 'magnet'], [{ x: 0, z: 0, r: 8 }]);

  // --- reach objective marker (B2): legacy 'reach' OR any 'reach' stage in a
  // quest chain — staged beacon stages had goalPos === null and could never complete
  let goal: THREE.Group | null = null;
  let goalPos: THREE.Vector3 | null = null;
  if (needsReachGoal(spec)) {
    const gx = rng.range(-half * 0.7, half * 0.7), gz = rng.range(-half * 0.7, half * 0.7);
    goalPos = new THREE.Vector3(gx, terrain.heightAt(gx, gz), gz);
    goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
    goal.position.copy(goalPos);
    scene.add(goal);
  }

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);

  // asset registration: enemies (dynamic roots), pickups, projectiles, city
  registerEnemyAssets(assets, enemies, ['walker', 'drone', 'brute', 'turret'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  // M6: wire the (cloned, never the shared cache entry) tracer material into
  // the projectile pool so the override actually reaches pixels
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);
  // N1: touch-aware hint bar (title screen already detects touch)
  hud.setHint(isTouchDevice()
    ? 'Left stick move · ATK attack · JUMP jump · DASH dash'
    : 'WASD move · mouse look · LMB attack · Space jump · Shift dash/sprint · Esc pause');
  // N7: crosshair belongs to guns, not melee
  hud.setCrosshair(spec.player.weapon !== 'none');

  // chapter-0 world dressing
  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half, yAt: (x, z) => terrain.heightAt(x, z) });
  let lastStage = 0;

  // difficulty ramp: each new chapter drops scaled reinforcements (not during boss stages)
  const spawnReinforcements = (stage: number) => {
    if (isBossStageActive(spec, objectives)) return;
    const n = 2 + stage;
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 4, damage: 10, weapon: 'melee' as const }];
    for (let k = 0; k < n; k++) {
      const plannedR = planSpawns([{ ...kinds[rng.int(0, kinds.length - 1)], count: 1 }], rng, stage, ACTION_VARIANTS)[0];
      const before = enemies.enemies.length;
      enemies.spawnAll([plannedR.spec], () => spawnFor(plannedR.spec.kind, k, n));
      const e = enemies.enemies[before];
      if (e) { variants.register(e, plannedR.variant); variants.decorate(e, plannedR.variant); }
    }
    hud.toast('HOSTILE REINFORCEMENTS');
    engine.audio.play('alarm');
    assets.applyOverrides(spec); // reskin the reinforcements
  };

  // --- camera
  const camRig = makeCameraRig(spec.player.camera, engine.camera, engine.input, (x, z) => engine.terrain.heightAt(x, z));

  // --- boss aura
  const bossAura = spec.objective.type === 'boss'
    ? new THREE.PointLight(new THREE.Color(spec.theme.palette.accent), 2, 30)
    : null;
  if (bossAura) scene.add(bossAura);

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw;
    avatar.update(dt, t);

    // attack input (melee damage scales with the damage upgrade multiplier)
    if (engine.input.justPressed('attack') && engine.state === 'playing') {
      if (spec.player.weapon === 'sword' || spec.player.weapon === 'none') {
        avatar.melee(avatar.ctrl.yaw, 2.6, 1.3, 25 * prog.damageMult());
      } else {
        // shoot toward camera forward
        const dir = new THREE.Vector3();
        engine.camera.getWorldDirection(dir);
        avatar.shoot(dir);
      }
    }
    if (engine.input.pressed('attack') && spec.player.weapon === 'rifle') {
      const dir = new THREE.Vector3();
      engine.camera.getWorldDirection(dir);
      avatar.shoot(dir);
    }

    enemies.update(dt, avatar.ctrl.position, t);
    variants.update(dt, avatar.ctrl.position, t);
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    fx.tick(dt, spec);
    fxHud.update(fx, t);

    // chapter transitions: fresh dressing, difficulty ramp, boss intro
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half, yAt: (x, z) => terrain.heightAt(x, z) });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the
      // quest-graph array index — branch B stages must not be systematically
      // harder than branch A stages on the same chapter.
      const chapter = objectives.stagesCleared;
      variants.applyStageScaling(chapter);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
      spawnReinforcements(chapter);
    }

    // scatter soft collision for player
    const pp = avatar.ctrl.position;
    scatter.resolve(pp, 0.5);
    avatar.ctrl.body.position.x = pp.x; avatar.ctrl.body.position.z = pp.z;

    // fell out of world
    if (pp.y < -40) { avatar.damage(1000); camRig.shake(0.8); }

    // reach goal check
    if (goalPos && pp.distanceTo(goalPos) < 3.5) objectives.reachedGoal();

    // boss aura follows last living enemy
    if (bossAura) {
      const b = enemies.enemies.find((e) => e.alive);
      if (b) bossAura.position.copy(b.position).add(new THREE.Vector3(0, 3, 0));
    }

    // FIX 5: combat intensity decays to baseline; boss bar during boss fights
    // (legacy boss objective or boss stage)
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    variants.updateBossBar(spec.objective.type === 'boss' || isBossStageActive(spec, objectives));

    // camera
    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives, assets };
}
