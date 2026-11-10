// Records Boomboats trailer shots. Usage: node shots.mjs [shotName ...]
import fs from 'node:fs';
import { launch, join, record, sleep, checkTake } from './lib.mjs';
process.env.REC_MIME = 'video/mp4;codecs=avc1.640033,mp4a.40.2';

const DIR = new URL('./clips/', import.meta.url).pathname;
fs.mkdirSync(DIR, { recursive: true });
const directorSrc = fs.readFileSync(new URL('./director.js', import.meta.url), 'utf8');

const want = process.argv.slice(2);
const browser = await launch();
let page = await join(browser, { name: 'Captain Boom', boat: 2, char: 0 });
await page.evaluate(directorSrc);
await page.waitForFunction(() => window.__dir?.ready);
const ev = (fn, ...a) => page.evaluate(fn, ...a);
await ev(() => { __dir.hud(false); __dir.music(0); });
await sleep(4000); // let bots spread out

async function alive() { await page.waitForFunction(() => __boomboats.game.me.alive, { timeout: 15000 }); }
// Put me `dist` metres behind a bot that has open water around it, facing the same way.
async function behindBot(dist = 30, speed = 22) {
  return ev((dist, speed) => {
    const D = __dir; const isl = D.data.ISLANDS;
    const ok = (x, z) => Math.hypot(x, z) < 120 && isl.every((i) => Math.hypot(x - i.x, z - i.z) > i.r + 8);
    const bots = D.bots().sort(() => Math.random() - 0.5);
    for (const b of bots) {
      const x = b.x - Math.sin(b.h) * dist, z = b.z - Math.cos(b.h) * dist;
      let clear = ok(x, z);
      for (let k = 0.25; k <= 1 && clear; k += 0.25) clear = ok(b.x - Math.sin(b.h) * dist * k, b.z - Math.cos(b.h) * dist * k);
      if (clear) { D.tp(x, z, b.h, speed); return b.id; }
    }
    const b = bots[0]; D.tp(b.x - Math.sin(b.h) * dist, b.z - Math.cos(b.h) * dist, b.h, speed); return b.id;
  }, dist, speed);
}

const SHOTS = {
  async aerial() {
    await ev(() => { __dir.pilot = { mode: 'hunt' }; __dir.cams.move({ from: { x: 60, y: 95, z: 250 }, to: { x: 18, y: 22, z: 92 }, lookFrom: { x: 0, y: 0, z: 0 }, lookTo: { x: 0, y: 6, z: 0 }, dur: 9, fov: 48, fovTo: 52 }); });
    return 9000;
  },
  async orbit() {
    await ev(() => { __dir.pilot = { mode: 'hunt' }; __dir.cams.orbit({ r: 125, y: 70, speed: 0.07, a0: 2.2, lookY: -15, fov: 50 }); });
    return 9000;
  },
  async hero() {
    await alive(); await behindBot(60, 26);
    await ev(() => { __dir.pilot = { mode: 'hunt' }; __dir.cams.rig({ side: 2.8, fwd: 8.5, up: 1.7, lookFwd: -1, lookUp: 1.4, fov: 48, smooth: 7 }); });
    await sleep(800);
    return 7000;
  },
  async side() {
    await alive(); await behindBot(60, 26);
    await ev(() => { __dir.pilot = { mode: 'hunt' }; __dir.cams.rig({ side: 7.5, fwd: 1.5, up: 1.1, lookFwd: 0.5, lookUp: 1.2, fov: 42, smooth: 9 }); });
    await sleep(800);
    return 6000;
  },
  async ramp() {
    await alive();
    await ev(() => {
      const D = __dir; const r = D.data.RAMPS[1];
      const fx = Math.sin(r.h), fz = Math.cos(r.h), rx = -fz, rz = fx;
      D.pilot = { mode: 'straight', avoid: false };
      D.tp(r.x - fx * 20, r.z - fz * 20, r.h, 27);
      D.cams.watch({ x: r.x + rx * 15 + fx * 9, y: 2.2, z: r.z + rz * 15 + fz * 9, fov: 50, smooth: 10, lookUp: 1.5 });
    });
    return 3500;
  },
  async ramp2() {
    await alive();
    await ev(() => {
      const D = __dir; const r = D.data.RAMPS[3];
      const fx = Math.sin(r.h), fz = Math.cos(r.h);
      D.pilot = { mode: 'straight', avoid: false };
      D.tp(r.x - fx * 22, r.z - fz * 22, r.h, 27);
      D.cams.rig({ side: -4, fwd: -9, up: 1.2, lookFwd: 10, lookUp: 2.5, fov: 60, smooth: 4 });
    });
    return 3500;
  },
  async pickup() {
    await alive();
    // empty hands first: you can't grab a chest while holding a weapon
    await ev(() => { __dir.give('gun'); });
    await sleep(400);
    await ev(() => __dir.fire());
    await page.waitForFunction(() => !__boomboats.game.me.weapon, { timeout: 8000 });
    await ev(() => {
      const D = __dir; const g = __boomboats.game; const bots = D.bots();
      const isl = D.data.ISLANDS;
      const cs = g.crates.filter((c) => c.on && Math.hypot(c.x, c.z) > 60 && Math.hypot(c.x, c.z) < 100
        && bots.every((b) => Math.hypot(b.x - c.x, b.z - c.z) > 35));
      const c = cs[Math.floor(Math.random() * cs.length)] || g.crates.find((c) => c.on);
      // approach along the ring so the run-up is open water
      let best = null;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const x = c.x - Math.sin(a) * 30, z = c.z - Math.cos(a) * 30;
        const clear = isl.every((i) => { for (let k = 0; k <= 1; k += 0.2) if (Math.hypot(c.x - Math.sin(a) * 30 * k - i.x, c.z - Math.cos(a) * 30 * k - i.z) < i.r + 6) return false; return true; });
        if (clear && Math.hypot(x, z) < 125) { best = { x, z, a }; break; }
      }
      D.tp(best.x, best.z, best.a, 20);
      D.pilot = { mode: 'point', x: c.x, z: c.z, avoid: false };
      D.cams.rig({ side: 2.5, fwd: -8, up: 2.8, lookFwd: 12, lookUp: 1.2, fov: 50, smooth: 6 });
    });
    return 3200;
  },
  async battle() {
    await ev(() => { __dir.pilot = { mode: 'hunt', fire: true }; __dir.give('rockets'); __dir.cams.orbit({ r: 58, y: 13, speed: -0.11, a0: 1.0, lookY: 2, fov: 55 }); });
    await sleep(1500);
    return 8000;
  },
  async rockets() { return weapon('rockets', { side: 1.5, fwd: -10, up: 3.0, lookFwd: 26, lookUp: 1, fov: 56, smooth: 6 }, 7000, 38); },
  async gun() { return weapon('gun', { side: 3.5, fwd: -7, up: 2.3, lookFwd: 18, lookUp: 1, fov: 56, smooth: 6 }, 5500, 26); },
  async torpedo() { return weapon('torpedo', { side: -2, fwd: -11, up: 4.2, lookFwd: 32, lookUp: 0, fov: 58, smooth: 5 }, 6500, 45); },
  async nitro() { return weapon('nitro', { side: 2, fwd: -7.5, up: 2.0, lookFwd: 14, lookUp: 1.2, fov: 68, smooth: 7 }, 5500, 32, { nitroRange: 40 }); },
  async shield() {
    await alive(); await behindBot(25, 22);
    await ev(() => { __dir.give('shield'); __dir.pilot = { mode: 'hunt', fire: true, nitroRange: 99 }; __dir.cams.rig({ side: -3, fwd: 8, up: 2.0, lookFwd: 0, lookUp: 1.6, fov: 50, smooth: 7 }); });
    await sleep(500);
    return 5000;
  },
  async mines() {
    await alive();
    const id = await ev(() => {
      const D = __dir; const b = D.bots().sort((a, c) => Math.hypot(a.x, a.z) - Math.hypot(c.x, c.z))[2] || D.bots()[0];
      D.tp(b.x + Math.sin(b.h) * 12, b.z + Math.cos(b.h) * 12, b.h, 14);
      D.give('mines');
      D.pilot = { mode: 'straight', fire: true, fireGap: 0.45 };
      D.cams.rig({ side: 5, fwd: 16, up: 7.5, lookFwd: -12, lookUp: 0, fov: 55, smooth: 5 });
      return b.id;
    });
    void id;
    return 5000;
  },
  async wave() {
    await alive();
    await ev(() => {
      const D = __dir; const bots = D.bots();
      let best = null, bestN = -1;
      for (const b of bots) { const n = bots.filter((o) => Math.hypot(o.x - b.x, o.z - b.z) < 28).length; if (n > bestN) { bestN = n; best = b; } }
      D.tp(best.x - Math.sin(best.h) * 8, best.z - Math.cos(best.h) * 8, best.h, 15);
      D.give('wave');
      D.pilot = { mode: 'hunt', fire: true, waveMin: 1 };
      D.cams.rig({ side: 0, fwd: -26, up: 17, lookFwd: 4, lookUp: 0, fov: 60, smooth: 3 });
      window.__waveBots = bestN;
    });
    console.log('  bots near wave:', await ev(() => window.__waveBots));
    return 5000;
  },
  async sink() {
    await alive();
    const id = await behindBot(26, 20);
    await ev((id) => {
      const D = __dir; D.give('rockets');
      D.pilot = { mode: 'hunt', fire: true, id, fireGap: 0.45 };
      D.cams.rig({ target: 'bot', id, side: 9, fwd: 2, up: 2.4, lookFwd: 0, lookUp: 1, fov: 44, smooth: 5 });
    }, id);
    return 6000;
  },
  async pack() {
    await alive();
    await ev(() => {
      const D = __dir; const b = D.bots()[Math.floor(Math.random() * D.bots().length)];
      D.pilot = { mode: 'follow', id: b.id, dist: 9 };
      D.tp(b.x - Math.sin(b.h) * 10, b.z - Math.cos(b.h) * 10, b.h, 24);
      D.cams.rig({ target: 'bot', id: b.id, side: -2.5, fwd: 14, up: 1.0, lookFwd: -6, lookUp: 1.6, fov: 34, smooth: 4 });
    });
    return 6000;
  },
};

async function weapon(w, rig, ms, dist, extra = {}) {
  await alive();
  const id = await behindBot(dist, 22);
  await ev((w, rig, id, extra) => {
    const D = __dir; D.give(w);
    D.pilot = { mode: 'hunt', fire: true, id, ...extra };
    D.cams.rig(rig);
  }, w, rig, id, extra);
  await sleep(300);
  return ms;
}

// Boats & drivers showcase uses the main menu's preview boat.
async function showcase() {
  const p = await join(browser, { room: 'menu', boat: 0, char: 0 });
  await p.evaluate(() => {
    document.getElementById('menu').style.display = 'none';
    const c = { x: -24, z: 96 }; const t0 = performance.now() / 1000;
    window.__cam = (cam, t) => { const a = 0.9 + (t - t0) * 0.45; cam.position.set(c.x + Math.sin(a) * 8.5, 3.0, c.z + Math.cos(a) * 8.5); cam.lookAt(c.x, 1.5, c.z); cam.fov = 42; cam.updateProjectionMatrix(); };
  });
  await sleep(1500);
  for (let attempt = 1; attempt <= 4; attempt++) {
  await p.evaluate(() => { document.getElementById('boat-prev').click(); });
  await record(p, DIR + 'showcase.mp4', 8400, async () => {
    for (let i = 0; i < 11; i++) {
      await sleep(700);
      await p.evaluate((i) => { document.getElementById('boat-next').click(); for (let k = 0; k < 2 + (i % 2); k++) document.getElementById('char-next').click(); }, i);
    }
  });
  const c = checkTake(DIR + 'showcase.mp4', 8400);
  console.log(`  showcase take ${attempt}:`, JSON.stringify(c));
  if (c.ok) break;
  }
  await p.close();
}

const order = want.length ? want : [...Object.keys(SHOTS), 'showcase'];
for (const name of order) {
  if (name === 'showcase') { await showcase(); continue; }
  const take = name.match(/^(\w+?)(\d*)$/);
  const fn = SHOTS[name] || SHOTS[take[1]];
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const ms = await fn();
      const file = `${DIR}${name}.mp4`;
      await record(page, file, ms);
      const c = checkTake(file, ms);
      console.log(`  ${name} take ${attempt}:`, JSON.stringify(c));
      await ev(() => { __dir.pilot = { mode: 'off' }; });
      if (c.ok) break;
      await sleep(1500);
    } catch (e) { console.log(`shot ${name} failed:`, e.message); await ev(() => { __dir.pilot = { mode: 'off' }; }).catch(() => {}); }
  }
}
await browser.close();
