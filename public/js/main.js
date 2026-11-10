// Boomboats client: rendering, input, networking and game flow.
import * as THREE from 'three';
import { loadAll } from './assets.js';
import { buildWorld } from './world.js';
import { FX } from './fx.js';
import { audio } from './audio.js';
import { HUD, ICONS } from './hud.js';
import { AimHelper } from './aim.js';
import { BoatView, ProjectileView, MineView, PickupView, wakeMaterial } from './boats.js';
import {
  BOATS, CHARACTERS, CRATE_SPOTS, WEAPON_STATS, MAX_HP, PHYS, RESPAWN_SECONDS, SPAWN_SHIELD, WEAPONS, WEAPON_KEYS, TIERS,
  newBoatState, stepBoat,
} from './shared/data.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const isTouch = matchMedia('(pointer: coarse)').matches;

// anonymous visitor id (random, kept on this device) so the owner's stats can count returning players
const visitorId = (() => {
  let v = store.get('bb-vid', '');
  if (!/^[a-zA-Z0-9-]{8,40}$/.test(v)) { v = crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('bb-vid', v); }
  return v;
})();
try {
  const ref = document.referrer ? new URL(document.referrer).hostname : '';
  navigator.sendBeacon?.('/api/e', JSON.stringify({ t: 'visit', vid: visitorId, dev: isTouch ? 'mobile' : 'desktop', inv: new URLSearchParams(location.search).has('room'), ref: ref === location.hostname ? '' : ref }));
} catch { /* stats are optional */ }

// ---------------------------------------------------------------- renderer
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 6000);
let fx, world, hud, aim;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fx?.setScale(h * renderer.getPixelRatio() * 0.9);
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- state
const game = {
  mode: 'loading',          // loading | menu | playing
  ws: null,
  meId: null,
  room: null,
  me: null,                 // { s, view, alive, weapon, ammo, deadUntil, killer }
  players: new Map(),       // id -> { info, view, buf, flags, hp, alive, score, deaths }
  projectiles: new Map(),   // id -> { view, type, x, y, z, vx, vz, ts }
  mines: new Map(),
  crates: [],
  matchState: 'playing',
  matchEnds: 0,             // performance.now()/1000 when the current phase ends
  serverOffset: null,       // serverTime - localTime
  lastSend: 0,
  showFull: false,
};
const sel = { boat: Number(store.get('bb-boat', 0)) % BOATS.length, char: Number(store.get('bb-char', 0)) % CHARACTERS.length };
let preview = null; // menu showcase boat

const localNow = () => performance.now() / 1000;
const serverNow = () => localNow() + (game.serverOffset ?? 0);

// ---------------------------------------------------------------- input
const keys = new Set();
const touch = { steer: 0, throttle: 0, active: false };
let fireQueued = false;    // a press waiting for the next frame
// every weapon is one tap; multi-shot weapons then fire by themselves until empty
function pressFire() { fireQueued = true; }
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.code);
  if (game.mode === 'playing') {
    if (e.code === 'Space') { if (!e.repeat) pressFire(); e.preventDefault(); }
    if ((e.code === 'Enter' || e.code === 'KeyR') && game.me && !game.me.alive) tryRevive();
    if (e.code === 'Tab') { game.showFull = true; e.preventDefault(); }
    if (e.code === 'KeyM') toggleMute();
    if (e.code === 'Escape' && $('help').classList.contains('hidden')) $('exit-confirm').classList.toggle('hidden');
    if (e.code.startsWith('Arrow')) e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') game.showFull = false;
});
addEventListener('blur', () => keys.clear());
canvas.addEventListener('mousedown', (e) => { if (game.mode === 'playing' && e.button === 0) pressFire(); });

function readInput() {
  let throttle = 0, steer = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) throttle += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) throttle -= 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) steer += 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) steer -= 1;
  if (touch.active) { throttle = touch.throttle; steer = touch.steer; }
  return { throttle, steer };
}

function setupTouch() {
  if (!isTouch) return;
  $('touch').classList.remove('hidden');
  const stick = $('stick'), knob = $('knob');
  let id = null;
  const move = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== id) continue;
      const r = stick.getBoundingClientRect();
      let dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      touch.steer = -dx;
      touch.throttle = dy > 0.55 ? -1 : len > 0.2 ? 1 : 0;
      touch.active = true;
    }
    e.preventDefault();
  };
  stick.addEventListener('touchstart', (e) => { id = e.changedTouches[0].identifier; move(e); }, { passive: false });
  stick.addEventListener('touchmove', move, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) if (t.identifier === id) { id = null; touch.active = false; knob.style.transform = ''; }
  };
  stick.addEventListener('touchend', end);
  stick.addEventListener('touchcancel', end);
  const fireBtn = $('touch-fire');
  fireBtn.addEventListener('touchstart', (e) => { pressFire(); fireBtn.classList.add('down'); e.preventDefault(); }, { passive: false });
  const up = (e) => { fireBtn.classList.remove('down'); e.preventDefault(); };
  fireBtn.addEventListener('touchend', up, { passive: false });
  fireBtn.addEventListener('touchcancel', up, { passive: false });
}

// ---------------------------------------------------------------- menu
function charLabel(c) {
  return c.replace('character-', '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
function updatePreview() {
  $('boat-name').textContent = BOATS[sel.boat].name;
  $('char-name').textContent = charLabel(CHARACTERS[sel.char]);
  store.set('bb-boat', sel.boat); store.set('bb-char', sel.char);
  if (game.mode !== 'menu') return;
  preview?.dispose();
  preview = new BoatView(scene, fx, { name: '', boat: BOATS[sel.boat].id, char: CHARACTERS[sel.char] }, true);
  preview.play('idle');
  preview.respawn(PREVIEW_POS.x, PREVIEW_POS.z, 0.6);
}
const PREVIEW_POS = { x: -24, z: 96 };

let invite = null; // room code from an invite link (?room=CODE)

function setupMenu() {
  const nameEl = $('name');
  nameEl.value = store.get('bb-name', '') || '';
  const params = new URLSearchParams(location.search);
  invite = params.get('room');
  if (invite) { $('code').value = invite.toUpperCase().slice(0, 5); $('btn-play').textContent = `JOIN ${invite.toUpperCase().slice(0, 5)}`; }
  const click = () => { audio.init().then(() => audio.play('click', { volume: 0.5 })); };
  $('boat-prev').onclick = () => { click(); sel.boat = (sel.boat + BOATS.length - 1) % BOATS.length; updatePreview(); };
  $('boat-next').onclick = () => { click(); sel.boat = (sel.boat + 1) % BOATS.length; updatePreview(); };
  $('char-prev').onclick = () => { click(); sel.char = (sel.char + CHARACTERS.length - 1) % CHARACTERS.length; updatePreview(); };
  $('char-next').onclick = () => { click(); sel.char = (sel.char + 1) % CHARACTERS.length; updatePreview(); };
  $('btn-play').onclick = () => connect(invite ? { mode: 'code', code: invite, via: 'link' } : { mode: 'quick' });
  $('btn-create').onclick = () => connect({ mode: 'create' });
  $('btn-join').onclick = () => {
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 5) { $('menu-error').textContent = 'Room codes have 5 letters.'; return; }
    connect({ mode: 'code', code });
  };
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-play').click(); });
  $('btn-mute').onclick = toggleMute;
  $('btn-help').onclick = () => { click(); $('help').classList.remove('hidden'); };
  const closeHelp = () => $('help').classList.add('hidden');
  $('btn-help-close').onclick = closeHelp;
  $('btn-help-x').onclick = closeHelp;
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) closeHelp(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });
  // HUD buttons never keep keyboard focus, so Space always fires instead of re-pressing them
  for (const b of document.querySelectorAll('#hud button')) b.addEventListener('mousedown', (e) => e.preventDefault());
  $('btn-revive').onclick = () => tryRevive();
  $('btn-exit').onclick = () => $('exit-confirm').classList.remove('hidden');
  $('btn-exit-stay').onclick = () => $('exit-confirm').classList.add('hidden');
  $('btn-exit-leave').onclick = exitRoom;
  $('btn-copy').onclick = () => {
    const url = `${location.origin}/?room=${game.room}`;
    navigator.clipboard?.writeText(url).then(() => hud.hint('Invite link copied! Send it to your friends.'), () => hud.hint(url, 6));
  };
}

function toggleMute() {
  audio.setMuted(!audio.muted);
  $('btn-mute').textContent = audio.muted ? '🔇' : '🔊';
}

// Phones play sideways: go full screen and lock to landscape where the browser allows it.
function enterLandscape() {
  if (!isTouch) return;
  const el = document.documentElement;
  const lock = () => screen.orientation?.lock?.('landscape').catch(() => {});
  try {
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => {});
    else lock();
  } catch { /* iPhone Safari: no fullscreen API; the rotate screen covers it */ }
}

// ---------------------------------------------------------------- networking
function connect(opts) {
  enterLandscape();
  const name = $('name').value.trim() || `Sailor${Math.floor(Math.random() * 900 + 100)}`;
  store.set('bb-name', name);
  $('menu-error').textContent = '';
  for (const b of ['btn-play', 'btn-create', 'btn-join']) $(b).disabled = true;
  audio.init().then(() => audio.resume());
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  game.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', name, boat: BOATS[sel.boat].id, char: CHARACTERS[sel.char], vid: visitorId, dev: isTouch ? 'mobile' : 'desktop', ...opts }));
    ping();
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onerror = () => { $('menu-error').textContent = 'Could not reach the game server.'; };
  ws.onclose = () => {
    for (const b of ['btn-play', 'btn-create', 'btn-join']) $(b).disabled = false;
    if (game.mode === 'playing') leaveGame('Disconnected from the server.');
  };
}

function send(msg) { if (game.ws?.readyState === 1) game.ws.send(JSON.stringify(msg)); }
function ping() { send({ t: 'ping', c: performance.now() }); }
setInterval(() => { if (game.mode === 'playing') ping(); }, 2000);

function onMessage(m) {
  switch (m.t) {
    case 'error':
      $('menu-error').textContent = m.msg;
      game.ws.close();
      break;
    case 'pong': {
      const rtt = (performance.now() - m.c) / 1000;
      const off = m.s + rtt / 2 - localNow();
      game.serverOffset = game.serverOffset === null ? off : game.serverOffset * 0.8 + off * 0.2;
      break;
    }
    case 'welcome': startGame(m); break;
    case 'join': addPlayer(m.p); break;
    case 'leave': removePlayer(m.id); break;
    case 's': onSnapshot(m); break;
    case 'board': onBoard(m); break;
    case 'ammo': setWeapon(m.w, m.n, m.fresh); break;
    case 'fire': onFire(m); break;
    case 'boom': onBoom(m); break;
    case 'kill': onKill(m); break;
    case 'hit': onHit(m); break;
    case 'spawn': onSpawn(m); break;
    case 'crate': onCrate(m); break;
    case 'mine': {
      game.mines.set(m.id, new MineView(scene, m.x, m.z, m.o === game.meId, m.life));
      audio.play('splash', { pos: m, volume: 0.5, rate: 1.3 });
      break;
    }
    case 'unmine': {
      const mm = game.mines.get(m.id);
      if (mm && m.gone) { fx.splash(mm.x, mm.z, 0.5); fx.sparkle(mm.x, 1, mm.z, mm.own ? [0.4, 1, 0.5] : [1, 0.5, 0.4], 10); } // timed out
      mm?.dispose(); game.mines.delete(m.id);
      break;
    }
    case 'match': onMatch(m); break;
  }
}

// ---------------------------------------------------------------- game flow
function startGame(m) {
  game.mode = 'playing';
  game.meId = m.id;
  game.room = m.room;
  preview?.dispose(); preview = null;
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('roomcode').textContent = `ROOM ${m.room}`;
  if (innerWidth < 760) $('btn-copy').textContent = 'Invite';
  for (const p of m.players) addPlayer(p);
  const me = game.players.get(m.id);
  game.me = { s: newBoatState(m.spawn), view: me.view, alive: true, weapon: null, ammo: 0, sendT: 0, safeUntil: localNow() + SPAWN_SHIELD };
  me.view.respawn(m.spawn.x, m.spawn.z, m.spawn.h);
  applyCrates(m.crates);
  for (const [id, x, z, o, life] of m.mines) game.mines.set(id, new MineView(scene, x, z, o === m.id, life));
  game.matchState = m.match.state;
  game.matchEnds = localNow() + m.match.endsAt;
  setWeapon(null, 0);
  hud.renderBoard([...game.players.values()].map(boardRow), game.meId, false);
  hud.hint(isTouch ? 'Follow the yellow arrow to grab a weapon!' : 'Drive with WASD — follow the yellow arrow to a weapon!', 5);
  setupTouch();
  startLoops();
  audio.play('horn', { volume: 0.6 });
}

function applyCrates(list) {
  for (const [i, on, w] of list || []) game.crates[i]?.set(!!on, w);
}

// Leave the room on purpose: close the connection and go back to the menu.
function exitRoom() {
  const ws = game.ws;
  game.ws = null;
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); }
  for (const b of ['btn-play', 'btn-create', 'btn-join']) $(b).disabled = false;
  // after leaving on purpose, PLAY goes back to normal matchmaking instead of the invite room
  if (invite) { invite = null; history.replaceState(null, '', location.pathname); $('btn-play').textContent = 'PLAY'; }
  leaveGame('');
}

function leaveGame(reason) {
  game.mode = 'menu';
  for (const p of game.players.values()) p.view.dispose();
  game.players.clear();
  for (const p of game.projectiles.values()) p.view.dispose();
  game.projectiles.clear();
  for (const mm of game.mines.values()) mm.dispose();
  game.mines.clear();
  game.me = null;
  aim.hideAll();
  hud.aimStatus('');
  $('guide').classList.add('hidden');
  $('dead').classList.add('hidden');
  $('protect').classList.add('hidden');
  $('exit-confirm').classList.add('hidden');
  $('pickup-card').classList.add('hidden');

  stopLoops();
  $('hud').classList.add('hidden');
  $('results').classList.add('hidden');
  $('menu').classList.remove('hidden');
  $('menu-error').textContent = reason || '';
  updatePreview();
}

function addPlayer(info) {
  if (game.players.has(info.id)) return;
  const isMe = info.id === game.meId;
  const view = new BoatView(scene, fx, info, isMe);
  game.players.set(info.id, { info, view, buf: [], flags: 1, hp: MAX_HP, alive: true, score: info.score || 0, deaths: info.deaths || 0, gunSoundT: 0 });
}

function removePlayer(id) {
  const p = game.players.get(id);
  if (!p) return;
  p.view.dispose();
  p.engine?.stop();
  game.players.delete(id);
}

function boardRow(p) { return { id: p.info.id, name: p.info.name, bot: p.info.bot, score: p.score, deaths: p.deaths }; }

function onBoard(m) {
  for (const [id, score, deaths] of m.l) {
    const p = game.players.get(id);
    if (p) { p.score = score; p.deaths = deaths; }
  }
  game.matchEnds = localNow() + m.left;
}

function setWeapon(w, n, fresh) {
  if (!game.me) return;
  game.me.weapon = w; game.me.ammo = n;
  hud.setWeapon(w, n, fresh, isTouch);
  game.players.get(game.meId)?.view.setWeapon(w);
  if (!w || fresh) game.me.firing = false;
  if (fresh) audio.play('pickup', { volume: 0.7 });
}

function onSnapshot(m) {
  for (const [id, x, y, z, h, flags, hp, speed, wi] of m.p) {
    const p = game.players.get(id);
    if (!p) continue;
    p.flags = flags;
    if (hp !== p.hp) { p.hp = hp; p.view.setHp(hp); }
    if (id === game.meId) continue;
    if (p.view.alive) p.view.setWeapon(wi ? WEAPON_KEYS[wi - 1] : null);
    p.buf.push({ t: m.ts, x, y, z, h, speed });
    if (p.buf.length > 30) p.buf.shift();
  }
  const seen = new Set();
  for (const [id, type, x, y, z, vx, vz] of m.pr) {
    seen.add(id);
    let pr = game.projectiles.get(id);
    if (!pr) {
      pr = { view: new ProjectileView(scene, fx, type), type };
      game.projectiles.set(id, pr);
      if (type === 2) fx.muzzle(x, y, z, [1, 0.85, 0.4], 3);
    }
    Object.assign(pr, { x, y, z, vx, vz, ts: m.ts });
  }
  for (const [id, pr] of game.projectiles) if (!seen.has(id)) { pr.view.dispose(); game.projectiles.delete(id); }
}

function shooterPos(id) {
  if (id === game.meId && game.me) return game.me.s;
  return game.players.get(id)?.view.root.position;
}

function onFire(m) {
  const pos = shooterPos(m.id);
  const mine = m.id === game.meId;
  const v = mine ? 1 : 0.8;
  switch (m.w) {
    case 'rockets': audio.play('rocket', { pos, volume: 1.4 * v }); if (pos) fx.muzzle(pos.x, 1.5, pos.z, [1, 0.6, 0.2], 5); break;
    case 'torpedo': audio.play('rocket', { pos, volume: 1.1 * v, rate: 0.7 }); audio.play('splash', { pos, volume: 0.6 * v }); break;
    case 'shield': audio.play('shield', { pos, volume: v }); break;
    case 'nitro':
      audio.play('nitro', { pos, volume: v });
      if (mine && game.me) { game.me.s.boost = WEAPON_STATS.nitroDuration; hud.hint('RAM THEM!'); }
      break;
    case 'wave': audio.play('horn', { pos, volume: v, rate: 0.8 }); break;
    case 'gun': break;
  }
}

function onBoom(m) {
  const d = game.me ? Math.hypot(m.x - game.me.s.x, m.z - game.me.s.z) : 100;
  switch (m.kind) {
    case 'rocket': case 'torpedo': case 'mine':
      fx.explosion(m.x, m.y, m.z, m.kind === 'mine' ? 1.1 : 0.9, m.y < 3);
      audio.play(m.kind === 'mine' ? 'waterBoom' : Math.random() < 0.5 ? 'explosion1' : 'explosion2', { pos: m, volume: 1.2 });
      fx.shake = Math.max(fx.shake, Math.max(0, 1 - d / 60) * 0.9);
      break;
    case 'splash':
      fx.splash(m.x, m.z, 1);
      audio.play('splash', { pos: m, volume: 0.6 });
      break;
    case 'wave':
      fx.wave(m.x, m.z, WEAPON_STATS.waveRadius);
      audio.play('waterBoom', { pos: m, volume: 1.6, rate: 0.75 });
      audio.play('explosion2', { pos: m, volume: 1.2, rate: 0.6 });
      fx.shake = Math.max(fx.shake, Math.max(0, 1 - d / 80) * 1.2);
      break;
    case 'spark':
      fx.muzzle(m.x, m.y, m.z, [1, 0.7, 0.3], 2.5);
      for (let i = 0; i < 4; i++) fx.spark.emit({ x: m.x, y: m.y, z: m.z, vx: (Math.random() - 0.5) * 12, vy: Math.random() * 8, vz: (Math.random() - 0.5) * 12, size: 0.6, endSize: 0.1, life: 0.4, color: [1, 0.8, 0.4], gravity: 20 });
      audio.play('ping', { pos: m, volume: 0.35, rate: 1.5 });
      break;
    case 'deflect':
      fx.sparkle(m.x, m.y, m.z, [0.5, 1, 1], 5);
      break;
  }
}

function nameOf(id) { return game.players.get(id)?.info.name || '???'; }

function onKill(m) {
  const victim = game.players.get(m.v);
  const killer = m.k != null ? game.players.get(m.k) : null;
  if (victim) {
    victim.alive = false;
    const pos = m.v === game.meId && game.me ? game.me.s : victim.view.root.position;
    fx.explosion(pos.x, (pos.y || 0) + 0.5, pos.z, 1.4, true);
    audio.play('explosion1', { pos, volume: 1.5, rate: 0.85 });
    victim.view.kill();
    victim.engine?.set(0, 0.5);
    const d = game.me ? Math.hypot(pos.x - game.me.s.x, pos.z - game.me.s.z) : 100;
    fx.shake = Math.max(fx.shake, Math.max(0, 1 - d / 70));
  }
  if (killer) killer.score = m.ks;
  // the boat I'm watching got sunk: follow whoever did it
  if (game.me && !game.me.alive && m.v === game.me.killerId && killer && m.k !== m.v && m.k !== game.meId) {
    game.me.killerId = m.k;
    $('dead-watch').textContent = `👀 Watching ${killer.info.name}`;
  }
  const involvesMe = m.v === game.meId || m.k === game.meId;
  hud.killFeed(killer && m.k !== m.v ? killer.info.name : null, nameOf(m.v), m.w, involvesMe);
  if (m.k === game.meId && m.v !== game.meId) {
    hud.center(`SMASHED ${nameOf(m.v).toUpperCase()}!`);
    audio.play('pickup', { volume: 0.8, rate: 1.3 });
  }
  if (m.v === game.meId && game.me) {
    game.me.alive = false;
    game.me.deadAtMs = Date.now();
    game.me.deadUntil = localNow() + RESPAWN_SECONDS;
    game.me.killer = killer && m.k !== m.v ? killer.info.name : null;
    game.me.killerId = killer && m.k !== m.v ? m.k : null;
    game.me.reviveAt = 0;
    setWeapon(null, 0);
    $('dead').classList.remove('hidden');
    $('pickup-card').classList.add('hidden');
    $('protect').classList.add('hidden');
    $('dead-by').textContent = game.me.killer ? `Sunk by ${game.me.killer}` : 'You sank yourself!';
    $('dead-watch').textContent = game.me.killer ? `👀 Watching ${game.me.killer}` : '';
    fx.shake = 1.4;
  }
}

function onHit(m) {
  const p = game.players.get(m.v);
  if (p) { p.hp = m.hp; p.view.setHp(m.hp); }
  if (m.v === game.meId) fx.shake = Math.max(fx.shake, 0.3);
}

function onSpawn(m) {
  const p = game.players.get(m.id);
  if (!p) return;
  p.alive = true;
  p.buf = [];
  p.hp = MAX_HP;
  p.view.respawn(m.x, m.z, m.h);
  if (m.id === game.meId && game.me) {
    game.me.s = newBoatState(m);
    game.me.alive = true;
    game.me.safeUntil = localNow() + SPAWN_SHIELD;
    $('dead').classList.add('hidden');
    if (game.matchState === 'playing') hud.center('GO!');
  }
}

function onCrate(m) {
  const c = game.crates[m.i];
  if (!c) return;
  if (!m.on) {
    fx.sparkle(c.x, 2, c.z, [1, 0.85, 0.3], 22);
    if (m.by !== game.meId) audio.play('pickup', { pos: c, volume: 0.35 });
  }
  c.set(m.on, m.w);
}

function onMatch(m) {
  game.matchState = m.state;
  game.matchEnds = localNow() + m.endsAt;
  if (m.state === 'results') {
    hud.showResults(m.results, game.meId);
    const won = m.results[0]?.id === game.meId;
    audio.play(won ? 'win' : 'lose', { volume: 0.8 });
    game.me && (game.me.weapon = null);
    $('dead').classList.add('hidden');
  } else {
    $('results').classList.add('hidden');
    $('dead').classList.add('hidden');
    for (const pr of game.projectiles.values()) pr.view.dispose();
    game.projectiles.clear();
    for (const mm of game.mines.values()) mm.dispose();
    game.mines.clear();
    applyCrates(m.crates);
    for (const p of game.players.values()) { p.score = 0; p.deaths = 0; }
    setWeapon(null, 0);
    hud.center('FIGHT!');
    audio.play('start', { volume: 0.8 });
    // the server respawned everyone; positions arrive in the next snapshot
    if (game.me) { game.me.alive = true; game.me.safeUntil = localNow() + SPAWN_SHIELD; }
    for (const p of game.players.values()) { p.alive = true; p.view.alive = true; p.view.root.visible = true; p.view.play('drive'); }
  }
}

// REVIVE unlocks RESPAWN_SECONDS after sinking; the server does the respawn.
function tryRevive() {
  const me = game.me;
  if (!me || me.alive || game.matchState !== 'playing') return;
  const t = localNow();
  if (t < me.deadUntil || t - (me.reviveAt || 0) < 1) return;
  me.reviveAt = t;
  send({ t: 'revive' });
  audio.play('click', { volume: 0.6 });
}

// ---------------------------------------------------------------- audio loops
const loops = {};
function startLoops() {
  if (!audio.ctx) return;
  loops.engine ||= audio.loop('engine', 0);
  loops.waves ||= audio.loop('waves', 0.25);
  loops.music ||= audio.loop('music', 1);
}
function stopLoops() {
  for (const k of Object.keys(loops)) { loops[k]?.stop(); delete loops[k]; }
  for (const p of game.players.values()) { p.engine?.stop(); p.engine = null; }
}

// ---------------------------------------------------------------- simulation
const STEP = 1 / 60;
let acc = 0;

function interpolate(p, renderT) {
  const b = p.buf;
  if (!b.length) return null;
  if (renderT <= b[0].t) return b[0];
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i].t <= renderT) {
      const a = b[i], c = b[i + 1];
      if (!c) {
        // extrapolate briefly from the last two samples
        const prev = b[i - 1];
        const dt = Math.min(0.2, renderT - a.t);
        if (!prev || a.t === prev.t) return a;
        const k = dt / (a.t - prev.t);
        return { x: a.x + (a.x - prev.x) * k, y: a.y, z: a.z + (a.z - prev.z) * k, h: a.h + angleLerp(prev.h, a.h, 1) * k, speed: a.speed };
      }
      const k = (renderT - a.t) / (c.t - a.t);
      return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k, h: a.h + angleLerp(a.h, c.h, k), speed: a.speed + (c.speed - a.speed) * k };
    }
  }
  return b[0];
}
function angleLerp(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d * k;
}

function stepLocal(dt) {
  const me = game.me;
  if (!me || !me.alive) return;
  const input = game.matchState === 'playing' ? readInput() : { throttle: 0, steer: 0 };
  const ev = stepBoat(me.s, input, dt);
  // bump into other boats
  for (const p of game.players.values()) {
    if (p.info.id === game.meId || !p.alive || !p.view.alive) continue;
    const o = p.view.root.position;
    const dx = me.s.x - o.x, dz = me.s.z - o.z, d = Math.hypot(dx, dz);
    if (d < 4.2 && d > 0.01 && Math.abs(me.s.y - o.y) < 3) {
      const nx = dx / d, nz = dz / d;
      me.s.x += nx * (4.2 - d); me.s.z += nz * (4.2 - d);
      const vn = me.s.vx * nx + me.s.vz * nz;
      if (vn < 0) { me.s.vx -= vn * nx * 1.6; me.s.vz -= vn * nz * 1.6; ev.bumped = Math.max(ev.bumped || 0, Math.min(1, -vn / 15)); }
    }
  }
  if (ev.landed) { fx.splash(me.s.x, me.s.z, 0.6 + ev.landed); audio.play('splash', { volume: 0.4 + ev.landed * 0.6 }); fx.shake = Math.max(fx.shake, ev.landed * 0.5); }
  if (ev.bumped > 0.15) { audio.play('bump', { volume: ev.bumped * 0.8 }); fx.shake = Math.max(fx.shake, ev.bumped * 0.4); }
  if (ev.launched) audio.play('nitro', { volume: 0.4, rate: 1.3 });
}

// ---------------------------------------------------------------- camera
const camPos = new THREE.Vector3(0, 30, 160);
const camLook = new THREE.Vector3();
let menuAngle = 0;

function updateCamera(dt, t) {
  if (game.mode !== 'playing' || !game.me) {
    menuAngle += dt * 0.12;
    const c = PREVIEW_POS;
    camera.position.set(c.x + Math.sin(menuAngle) * 13, 5.2, c.z + Math.cos(menuAngle) * 13);
    const lookOff = isTouch || innerWidth < 760 ? 0 : -1;
    camera.lookAt(c.x + Math.cos(menuAngle) * 4 * lookOff, 1.8, c.z - Math.sin(menuAngle) * 4 * lookOff);
    camera.fov = 50;
    camera.updateProjectionMatrix();
    return;
  }
  let s = game.me.s;
  let speed = Math.hypot(s.vx, s.vz);
  // while sunk, the camera follows whoever sank you (after a moment on your own wreck)
  const killer = !game.me.alive && game.me.killerId != null ? game.players.get(game.me.killerId) : null;
  const watching = !!(killer?.lastSt && Date.now() - (game.me.deadAtMs || 0) > 1200);
  if (watching) { s = killer.lastSt; speed = s.speed || 0; }
  const fwdX = Math.sin(s.h), fwdZ = Math.cos(s.h);
  const chase = game.me.alive || watching;
  const dist = chase ? 12 + speed * 0.08 : 18;
  const height = chase ? 5.8 + speed * 0.03 : 10;
  const want = new THREE.Vector3(s.x - fwdX * dist, (s.y || 0) * 0.6 + height, s.z - fwdZ * dist);
  const k = 1 - Math.exp(-(game.me.alive ? 5 : watching ? 3 : 1.5) * dt);
  camPos.lerp(want, k);
  const look = new THREE.Vector3(s.x + fwdX * 6, (s.y || 0) * 0.8 + 1.6, s.z + fwdZ * 6);
  camLook.lerp(look, 1 - Math.exp(-10 * dt));
  camera.position.copy(camPos);
  if (fx.shake > 0) {
    const a = fx.shake * fx.shake * 0.8;
    camera.position.x += (Math.random() - 0.5) * a; camera.position.y += (Math.random() - 0.5) * a; camera.position.z += (Math.random() - 0.5) * a;
  }
  camera.lookAt(camLook);
  const wantFov = 62 + Math.min(14, speed * 0.25) + (s.boost > 0 ? 6 : 0) + (isTouch ? 6 : 0);
  camera.fov += (wantFov - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
  void t;
}

// ---------------------------------------------------------------- frame loop
let last = performance.now();
let mmT = 0, boardT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  if (game.mode === 'loading') return;

  if (game.mode === 'playing' && game.me) {
    acc += dt;
    while (acc >= STEP) { stepLocal(STEP); acc -= STEP; }
    const me = game.me;
    if (fireQueued) {
      fireQueued = false;
      if (!me.alive) tryRevive();
      else if (me.weapon && !me.firing) { send({ t: 'fire' }); me.firing = WEAPONS[me.weapon].ammo > 1; }
      else { audio.play('empty', { volume: 0.3 }); hud.hint('No weapon yet — follow the yellow arrow to one!'); }
    }
    // send my state ~20 times/sec
    if (me.alive && t - game.lastSend > 0.05) {
      game.lastSend = t;
      const s = me.s;
      send({ t: 's', x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2), h: +s.h.toFixed(3), vx: +s.vx.toFixed(2), vz: +s.vz.toFixed(2) });
    }

    const renderT = serverNow() - 0.1;
    for (const p of game.players.values()) {
      const isMe = p.info.id === game.meId;
      let st;
      if (isMe) st = { x: me.s.x, y: me.s.y, z: me.s.z, h: me.s.h, speed: Math.hypot(me.s.vx, me.s.vz) };
      else st = interpolate(p, renderT);
      if (!st) continue;
      p.lastSt = st;
      const flags = isMe ? (p.flags & ~4) | (me.s.boost > 0 ? 4 : 0) : p.flags;
      p.view.update(dt, t, st, flags, camera.position);
      // deck gun sound
      if (flags & 8 && p.view.alive) {
        p.gunSoundT -= dt;
        if (p.gunSoundT <= 0) { p.gunSoundT = 0.55; audio.play('gun', { pos: st, volume: isMe ? 0.9 : 0.7, jitter: 0.1 }); }
      } else p.gunSoundT = 0;
      // engines
      if (!isMe && audio.ctx && p.view.alive) {
        p.engine ||= audio.loop('engine', 0);
        const d = Math.hypot(st.x - me.s.x, st.z - me.s.z);
        const vol = Math.max(0, 1 - d / 70) * 0.25;
        p.engine?.set(vol, 0.9 + (st.speed / PHYS.maxSpeed) * 0.8, audio.panFor(st.x - me.s.x, st.z - me.s.z));
      } else if (!isMe && p.engine && !p.view.alive) p.engine.set(0);
    }
    const speed = Math.hypot(me.s.vx, me.s.vz);
    loops.engine?.set(me.alive ? 0.32 + Math.min(0.35, speed * 0.012) : 0, 1.0 + (speed / PHYS.maxSpeed) * 0.75 + (me.s.boost > 0 ? 0.25 : 0));
    const ear = (!me.alive && game.players.get(me.killerId)?.lastSt) || me.s;
    audio.listener = { x: ear.x, z: ear.z, h: ear.h };

    // projectiles: extrapolate from the last server position
    const sn = serverNow();
    for (const pr of game.projectiles.values()) {
      const k = Math.min(0.15, Math.max(0, sn - pr.ts));
      pr.view.update(dt, pr.x + pr.vx * k, pr.y, pr.z + pr.vz * k, pr.vx, pr.vz);
    }
    for (const mm of game.mines.values()) mm.update(t);

    // aiming help
    const enemies = [];
    for (const p of game.players.values()) {
      if (p.info.id === game.meId || !p.view.alive) continue;
      const b = p.buf, n = b.length;
      const vel = n >= 2 && b[n - 1].t > b[n - 2].t
        ? { vx: (b[n - 1].x - b[n - 2].x) / (b[n - 1].t - b[n - 2].t), vz: (b[n - 1].z - b[n - 2].z) / (b[n - 1].t - b[n - 2].t) }
        : { vx: 0, vz: 0 };
      const pos = p.view.root.position;
      enemies.push({ x: pos.x, z: pos.z, ...vel, ref: { pos, name: p.info.name } });
    }
    const aimInfo = aim.update(dt, t, me, enemies, game.crates);
    const guideEl = $('guide');
    // hide the arrow once the weapon is right in front of you, so it doesn't cover it
    const guideAhead = aimInfo.guide && Math.abs(aimInfo.guide.bearing) < 0.3 && aimInfo.guide.dist < 45;
    if (aimInfo.guide && !guideAhead && game.matchState === 'playing') {
      const g = aimInfo.guide, def = WEAPONS[g.w];
      guideEl.classList.remove('hidden');
      guideEl.style.setProperty('--tier', TIERS[def.tier].color);
      const bob = Math.sin(t * 5) * 4;
      $('guide-arrow').style.transform = `translateY(${bob}px) rotate(${(-g.bearing * 180 / Math.PI).toFixed(1)}deg)`;
      const txt = `${def.name} · ${Math.round(g.dist)} m`;
      if ($('guide-text').textContent !== txt) $('guide-text').textContent = txt;
    } else guideEl.classList.add('hidden');
    if (!me.alive || !me.weapon || game.matchState !== 'playing') hud.aimStatus('');
    else if (me.firing) hud.aimStatus(''); // no message while a weapon empties itself
    else if (aimInfo.lock) hud.aimStatus(`🎯 LOCKED ON ${aimInfo.lock.name.toUpperCase()} — FIRE!`);
    else if (me.weapon === 'wave') hud.aimStatus(aimInfo.inRange ? `💥 ${aimInfo.inRange} boat${aimInfo.inRange > 1 ? 's' : ''} in the circle — FIRE!` : 'Get boats inside the circle', aimInfo.inRange ? '' : 'info');
    else if (me.weapon === 'mines') hud.aimStatus('Drop mines in front of boats chasing you', 'info');
    else if (WEAPONS[me.weapon].aim === 'front') hud.aimStatus('Turn toward a boat to lock on', 'info');
    else hud.aimStatus('');
    // driving over a weapon while holding one
    if (me.alive && me.weapon) {
      for (const c of game.crates) {
        if (c.on && Math.hypot(c.x - me.s.x, c.z - me.s.z) < 4 && t - (game.armedHintT || 0) > 3) {
          game.armedHintT = t;
          hud.hint(`Use your ${WEAPONS[me.weapon].name} first to grab another weapon`);
        }
      }
    }

    // HUD
    hud.setTimer(game.matchEnds - localNow());
    if (!me.alive) {
      const left = Math.ceil(me.deadUntil - localNow());
      const btn = $('btn-revive');
      const ready = left <= 0;
      if (btn.disabled === ready) btn.disabled = !ready;
      const label = ready ? (isTouch ? 'REVIVE' : 'REVIVE · SPACE') : `REVIVE IN ${left}`;
      if (btn.textContent !== label) btn.textContent = label;
      btn.classList.toggle('ready', ready);
    }
    // spawn protection badge (the server ends it early when you fire)
    const myFlags = game.players.get(game.meId)?.flags ?? 0;
    const safeLeft = (me.safeUntil || 0) - localNow();
    const prot = $('protect');
    const showProt = me.alive && safeLeft > 0 && game.matchState === 'playing' && (myFlags & 32 || safeLeft > SPAWN_SHIELD - 0.4);
    prot.classList.toggle('hidden', !showProt);
    if (showProt) { const txt = `🛡 PROTECTED · ${Math.ceil(safeLeft)}`; if (prot.textContent !== txt) prot.textContent = txt; }
    if (game.matchState === 'results') $('results-next').textContent = `Next match in ${Math.max(0, Math.ceil(game.matchEnds - localNow()))}…`;
    mmT -= dt; boardT -= dt;
    if (mmT <= 0) {
      mmT = 1 / 15;
      const others = [...game.players.values()].filter((p) => p.info.id !== game.meId).map((p) => ({ x: p.view.root.position.x, z: p.view.root.position.z, alive: p.view.alive }));
      hud.minimap(me.s, others, game.crates);
    }
    if (boardT <= 0) { boardT = 0.25; hud.renderBoard([...game.players.values()].map(boardRow), game.meId, game.showFull); }

    // shadows follow the player
    world.sun.position.set(me.s.x + world.sunDir.x * 120, world.sunDir.y * 120, me.s.z + world.sunDir.z * 120);
    world.sun.target.position.set(me.s.x, 0, me.s.z);
  } else if (preview) {
    preview.update(dt, t, { x: PREVIEW_POS.x, y: 0, z: PREVIEW_POS.z, h: 0.6, speed: 0 }, 1, camera.position);
    world.sun.position.set(PREVIEW_POS.x + world.sunDir.x * 120, world.sunDir.y * 120, PREVIEW_POS.z + world.sunDir.z * 120);
    world.sun.target.position.set(PREVIEW_POS.x, 0, PREVIEW_POS.z);
  }

  for (const c of game.crates) c.update(dt, t, camera.position);
  wakeMaterial().uniforms.time.value = t;
  world.update(t);
  fx.update(dt);
  updateCamera(dt, t);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
async function boot() {
  resize();
  await loadAll((p) => {
    $('loadbar').style.width = `${Math.round(p * 100)}%`;
  });
  $('loadtext').textContent = 'Filling the lagoon…';
  await new Promise((r) => setTimeout(r, 30));
  world = buildWorld(scene, renderer);
  fx = new FX(scene);
  hud = new HUD();
  resize();
  game.crates = CRATE_SPOTS.map((s, i) => {
    const p = new PickupView(scene, s.x, s.z, { WEAPONS, TIERS, ICONS });
    p.set(true, Object.keys(WEAPONS)[i % 7]); // menu backdrop; the server sends the real ones
    return p;
  });
  aim = new AimHelper(scene);
  hud.helpWeapons();
  setupMenu();
  game.mode = 'menu';
  updatePreview();
  $('btn-mute').textContent = audio.muted ? '🔇' : '🔊';
  renderer.compile(scene, camera);
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');
  window.__boomboats = { game, scene, camera, renderer, send, aim };
}

requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  $('loadtext').textContent = `Something went wrong while loading: ${e.message}`;
});
