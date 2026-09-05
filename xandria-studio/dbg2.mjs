import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });

for (const [name, intent] of [['racing', 'desert racing grand prix'], ['topdown', 'top-down horde shooter']]) {
  await p.goto(`http://localhost:4180/player.html?test=1&intent=${encodeURIComponent(intent)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__XANDRIA__?.engine?.state === 'playing', null, { timeout: 30000 });
  // hold throttle for a few sim seconds
  await p.evaluate(() => window.__XANDRIA__.engine.input.inject(['forward'], { lx: 0, ly: -1 }));
  await p.waitForTimeout(4000);
  const info = await p.evaluate(() => {
    const X = window.__XANDRIA__;
    const cam = X.engine.camera.position;
    const spec = X.spec;
    const bp = X.blueprint;
    const playerPos = bp?.car ? bp.car.position : bp?.avatar?.ctrl?.position;
    return {
      genre: spec.meta.genre, env: spec.theme.environment, tod: spec.theme.timeOfDay,
      cam: { x: +cam.x.toFixed(1), y: +cam.y.toFixed(1), z: +cam.z.toFixed(1) },
      player: playerPos ? { x: +playerPos.x.toFixed(1), y: +playerPos.y.toFixed(1), z: +playerPos.z.toFixed(1) } : null,
      terrainY: X.engine.terrain ? +X.engine.terrain.heightAt(playerPos.x, playerPos.z).toFixed(1) : null,
      speed: bp?.car ? +bp.car.speed.toFixed(1) : undefined,
    };
  });
  console.log(name, JSON.stringify(info));
  await p.screenshot({ path: `tests/e2e/shots/dbg-${name}.png` });
  await p.evaluate(() => window.__XANDRIA__.engine.input.inject([], null));
}
await b.close();
