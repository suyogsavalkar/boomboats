// Shared helpers for recording Boomboats trailer shots in headless Chrome.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const URL_BASE = 'http://localhost:3101/';
export const W = 1920, H = 1080;

export async function launch() {
  return puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      `--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  });
}

// Open the game, pick a boat/driver, join a fresh private room, and install the trailer hooks.
export async function join(browser, { name = 'Captain', boat = 2, char = 0, room = 'create' } = {}) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.evaluateOnNewDocument((boat, char) => {
    localStorage.setItem('bb-boat', String(boat));
    localStorage.setItem('bb-char', String(char));
    localStorage.setItem('bb-muted', '0');
  }, boat, char);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__boomboats && !document.getElementById('menu').classList.contains('hidden'), { timeout: 90000 });
  await page.evaluate(installHooks);
  if (room === 'menu') return page;
  await page.type('#name', name);
  if (room === 'create') await page.click('#btn-create');
  else { await page.type('#code', room); await page.click('#btn-join'); }
  await page.waitForFunction(() => window.__boomboats.game.me, { timeout: 15000 });
  await page.evaluate(() => document.activeElement?.blur());
  return page;
}

// Runs inside the page.
async function installHooks() {
  const bb = window.__boomboats;
  const { audio } = await import('/js/audio.js');
  bb.audio = audio;
  await audio.init();
  audio.resume();
  // Trailer camera: if window.__cam is set it overrides the game camera right before each render.
  const orig = bb.renderer.render.bind(bb.renderer);
  bb.renderer.render = (scene, cam) => {
    if (window.__cam) { try { window.__cam(cam, performance.now() / 1000); } catch (e) { console.error(e); window.__cam = null; } }
    orig(scene, cam);
    window.__frames = (window.__frames || 0) + 1;
    // feed the recorder at most 60 frames per second, right after a finished render
    const tr = window.__vtrack;
    if (tr && tr.readyState === 'live') {
      const now = performance.now();
      if (!window.__lastReq || now - window.__lastReq >= 16.0) { window.__lastReq = now; tr.requestFrame(); }
    }
  };
  // Key helpers for the autopilot.
  const held = new Set();
  window.__key = (code, down) => {
    if (down === held.has(code)) return;
    down ? held.add(code) : held.delete(code);
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));
  };
  window.__releaseAll = () => { for (const c of [...held]) window.__key(c, false); };
  // Record the WebGL canvas + game audio into one file, streamed out in chunks.
  window.__startRec = (mime) => {
    const canvas = document.getElementById('game');
    const vs = canvas.captureStream(0);
    window.__vtrack = vs.getVideoTracks()[0];
    const dest = audio.ctx.createMediaStreamDestination();
    audio.master.connect(dest);
    const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 20_000_000, audioBitsPerSecond: 256_000 });
    window.__rec = rec;
    // keep chunks in memory while recording; copying them out mid-take stalls rendering
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    window.__recDone = new Promise((r) => { rec.onstop = () => { vs.getTracks().forEach((t) => t.stop()); window.__vtrack = null; setTimeout(r, 200); }; });
    window.__recParts = parts;
    rec.start(1000);
  };
  window.__stopRec = async () => {
    window.__rec.stop(); await window.__recDone;
    audio.master.disconnect(); audio.master.connect(audio.ctx.destination);
    const buf = new Uint8Array(await new Blob(window.__recParts).arrayBuffer());
    for (let off = 0; off < buf.length; off += 4 << 20) {
      const sub = buf.subarray(off, off + (4 << 20));
      let s = '';
      for (let i = 0; i < sub.length; i += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(i, i + 0x8000));
      await window.__chunk(btoa(s));
    }
    window.__recParts = null;
  };
}

export async function record(page, file, ms, during) {
  fs.writeFileSync(file, Buffer.alloc(0));
  const pending = [];
  if (!page.__chunkBound) {
    await page.exposeFunction('__chunk', (b64) => { fs.appendFileSync(page.__file, Buffer.from(b64, 'base64')); });
    page.__chunkBound = true;
  }
  page.__file = file;
  const mime = process.env.REC_MIME || await page.evaluate(() => ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'].find((m) => MediaRecorder.isTypeSupported(m)));
  const f0 = await page.evaluate(() => window.__frames);
  await page.evaluate((m) => window.__startRec(m), mime);
  const t0 = Date.now();
  if (during) pending.push(during());
  await sleep(ms);
  await page.evaluate(() => window.__stopRec());
  await Promise.all(pending);
  const f1 = await page.evaluate(() => window.__frames);
  const fps = ((f1 - f0) / ((Date.now() - t0) / 1000)).toFixed(1);
  console.log(`recorded ${file} (${mime}) ~${fps} fps`);
  return mime;
}

// Frame-timing check for a recorded take: enough frames, no long freezes.
import { execSync } from 'node:child_process';
export function checkTake(file, ms) {
  const out = execSync(`ffprobe -v error -select_streams v -show_entries frame=pts_time -of csv=p=0 "${file}"`).toString();
  const t = out.split('\n').map((l) => parseFloat(l)).filter((x) => Number.isFinite(x));
  if (t.length < 2) return { ok: false, frames: t.length };
  let maxGap = 0; for (let i = 1; i < t.length; i++) maxGap = Math.max(maxGap, t[i] - t[i - 1]);
  const want = (ms / 1000) * 60;
  const ok = t.length >= want * 0.85 && maxGap < 0.075;
  return { ok, frames: t.length, want: Math.round(want), maxGap: +maxGap.toFixed(3) };
}
