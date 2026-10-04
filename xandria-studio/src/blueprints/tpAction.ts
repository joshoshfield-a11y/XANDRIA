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
  showIntroCard,
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  bossPhaseBanner,
} from './campaign';
import { Scatter } from '../engine/world/Scatter';
import { Structures } from '../engine/world/Structures';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';

export function buildThirdPersonAction(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud } = engine;
  const rng = engine.rng.fork(101);

  // campaign layer: intro card + XP progression (non-blocking at boot)
  showIntroCard(engine, spec);
  const prog = new Progression(engine);
  let notifyLevelUp: () => void = () => {};

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
      engine.score += 100;
      hud.setScore(engine.score);
      objectives.addProgress(1);
      grantKillXp(prog, notifyLevelUp);
      combatPulse();
      const d = e.position.distanceTo(avatar.ctrl.position);
      if (d < 14) camRig.shake(0.6 * (1 - d / 14));
      if (rng.chance(0.3)) pickups.spawn(rng.chance(0.6) ? 'health' : 'coin', e.position.clone().add(new THREE.Vector3(0, 0.6, 0)));
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  });

  // --- player
  const spawnY = terrain.heightAt(0, 0);
  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, spawnY + 2, 0), enemies, projectiles);
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);

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
  enemies.spawnAll(spec.enemies, spawnFor);

  // --- pickups
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'coin') { engine.score += 50; engine.audio.play('coin'); if (spec.objective.type === 'collect') objectives.addProgress(1); }
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    if (p.kind === 'ammo') { avatar.addAmmo(24); engine.audio.play('pickup'); }
    if (p.kind === 'powerup') { avatar.ctrl.speedBoostT = 6; engine.audio.play('powerup'); hud.toast('SPEED SURGE'); }
    grantPickupXp(prog, notifyLevelUp);
    hud.setScore(engine.score);
  };
  const half = terrain.size / 2 - 12;
  pickups.scatterTerrain(
    { coin: spec.pickups.coins, health: spec.pickups.health, ammo: spec.pickups.ammo, powerup: spec.pickups.powerups },
    (x, z) => terrain.heightAt(x, z), half, spec.meta.seed,
    [{ x: 0, z: 0, r: 6 }],
  );

  // --- reach objective marker
  let goal: THREE.Group | null = null;
  let goalPos: THREE.Vector3 | null = null;
  if (spec.objective.type === 'reach') {
    const gx = rng.range(-half * 0.7, half * 0.7), gz = rng.range(-half * 0.7, half * 0.7);
    goalPos = new THREE.Vector3(gx, terrain.heightAt(gx, gz), gz);
    goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
    goal.position.copy(goalPos);
    scene.add(goal);
  }

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);
  hud.setHint('WASD move · mouse look · LMB attack · Space jump · Shift dash/sprint · Esc pause');
  if (spec.player.weapon !== 'none') hud.setCrosshair(false);

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
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult());
    objectives.update(dt);

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

    // FIX 5: combat intensity decays to baseline; boss bar tracks the toughest living enemy
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    if (spec.objective.type === 'boss') {
      const boss = enemies.enemies.filter((e) => e.alive).sort((a, b) => b.maxHealth - a.maxHealth)[0];
      if (boss) hud.setBoss(`BOSS — ${boss.spec.kind.toUpperCase()}`, boss.health / boss.maxHealth);
      else hud.setBoss(null, 0);
    }

    // camera
    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, pickups, objectives };
}
