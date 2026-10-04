/**
 * FPS ARENA — pointer-lock first-person shooter in a walled arena. Waves of drones/walkers,
 * cover crates, ammo/health economy, survive N waves.
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
import { Structures } from '../engine/world/Structures';
import { PlayerAvatar } from './common';

export function buildFpsArena(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(202);
  const arenaR = Math.min(46, terrain.size / 2 - 12);

  // campaign layer: intro card + XP progression (non-blocking at boot)
  showIntroCard(engine, spec);
  const prog = new Progression(engine);
  let notifyLevelUp: () => void = () => {};

  // arena: perimeter + cover
  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), arenaR, 5);
  structures.arenaCover(spec, terrain, spec.rules.difficulty === 'hard' ? 26 : 20, arenaR - 6, spec.meta.seed);
  scene.add(structures.group);

  // visual wall ring glow (neon arenas)
  if (spec.theme.environment === 'neon-city' || spec.theme.environment === 'space-station') {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(arenaR, 0.18, 6, 64),
      engine.mats.glow(spec.theme.palette.accent, 2),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = terrain.heightAt(0, 0) + 5.2;
    scene.add(ring);
  }

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
      if (rng.chance(0.25)) pickups.spawn(rng.chance(0.5) ? 'ammo' : 'health', e.position.clone().add(new THREE.Vector3(0, 0.5, 0)));
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  });

  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 0) + 2, 0), enemies, projectiles);
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Player projectiles damage the enemy owning the hit body; enemy projectiles damage the player.
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { target.damage(p.damage * prog.damageMult(), point); combatPulse(); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    if (p.kind === 'ammo') { avatar.addAmmo(30); engine.audio.play('pickup'); }
    if (p.kind === 'coin') { engine.score += 50; engine.audio.play('coin'); }
    if (p.kind === 'powerup') { avatar.ctrl.speedBoostT = 5; engine.audio.play('powerup'); }
    grantPickupXp(prog, notifyLevelUp);
    hud.setScore(engine.score);
  };
  pickups.scatterTerrain(
    { coin: 0, health: spec.pickups.health, ammo: Math.max(4, spec.pickups.ammo), powerup: spec.pickups.powerups },
    (x, z) => terrain.heightAt(x, z), arenaR - 4, spec.meta.seed,
  );

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);
  hud.setCrosshair(true);
  hud.setHint('WASD move · mouse aim · LMB fire · Space jump · Esc pause');

  // pointer lock on click
  engine.renderer.domElement.addEventListener('click', () => input.requestPointerLock());

  const camRig = makeCameraRig('first-person', engine.camera, input, (x, z) => terrain.heightAt(x, z));

  // waves: when all dead and objective wants more, respawn a wave (survive/eliminate > initial count)
  const totalNeeded = spec.objective.type === 'eliminate' ? spec.objective.count : spec.enemies.reduce((n, e) => n + e.count, 0);
  const initialCount = spec.enemies.reduce((n, e) => n + e.count, 0);
  let spawned = initialCount;

  const spawnWave = () => {
    const remaining = totalNeeded - spawned;
    if (remaining <= 0) return;
    hud.toast('NEW WAVE INBOUND');
    engine.audio.play('alarm');
    let left = Math.min(remaining, 6);
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 4, damage: 10, weapon: 'melee' as const }];
    let i = 0;
    while (left > 0) {
      const es = { ...kinds[i % kinds.length], count: 1 };
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(arenaR * 0.5, arenaR - 4);
      const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      pos.y = terrain.heightAt(pos.x, pos.z) + 1.5;
      enemies.spawnAll([es], () => pos);
      spawned++;
      left--;
      i++;
    }
  };

  // initial spawn (capped at 8 alive at once)
  const spawnInitial = () => {
    const capped = spec.enemies.map((e) => ({ ...e, count: Math.min(e.count, Math.ceil(8 / spec.enemies.length)) }));
    spawned = capped.reduce((n, e) => n + e.count, 0);
    enemies.spawnAll(capped, (kind, i, n) => {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = kind === 'turret' ? arenaR * 0.7 : rng.range(arenaR * 0.4, arenaR * 0.8);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      return new THREE.Vector3(x, terrain.heightAt(x, z) + 1.5, z);
    });
  };
  spawnInitial();

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw;
    avatar.update(dt, t);

    if ((input.pressed('attack') || input.justPressed('attack')) && engine.state === 'playing') {
      const dir = new THREE.Vector3();
      engine.camera.getWorldDirection(dir);
      avatar.shoot(dir);
    }

    enemies.update(dt, avatar.ctrl.position, t);
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult());
    objectives.update(dt);

    if (enemies.aliveCount() === 0 && spawned < totalNeeded) spawnWave();

    if (avatar.ctrl.position.y < -40) { avatar.damage(1000); camRig.shake(0.8); }

    // FIX 5: combat intensity decays to baseline; boss bar tracks the toughest living enemy
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    if (spec.objective.type === 'boss') {
      const boss = enemies.enemies.filter((e) => e.alive).sort((a, b) => b.maxHealth - a.maxHealth)[0];
      if (boss) hud.setBoss(`BOSS — ${boss.spec.kind.toUpperCase()}`, boss.health / boss.maxHealth);
      else hud.setBoss(null, 0);
    }

    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
    // keep HUD objective fresh for wave counter
    if (spec.objective.type === 'survive') hud.setProgress(`${objectives.done ? 0 : ''}${enemies.aliveCount()} hostiles`);
  });

  return { avatar, enemies, pickups, objectives };
}
