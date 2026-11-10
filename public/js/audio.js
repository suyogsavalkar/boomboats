// Sound playback with Web Audio: real recordings first, Kenney packs as a fallback.

const SOUNDS = {
  engine:    ['/audio/engine_loop.ogg', '/audio/engine_loop.mp3', '/audio/kenney/engineCircular_000.ogg'],
  explosion1:['/audio/explosion_1.ogg', '/audio/explosion_1.mp3', '/audio/kenney/explosionCrunch_000.ogg'],
  explosion2:['/audio/explosion_2.ogg', '/audio/explosion_2.mp3', '/audio/kenney/lowFrequency_explosion_000.ogg'],
  splash:    ['/audio/splash.ogg', '/audio/splash.mp3', '/audio/kenney/drop_002.ogg'],
  waves:     ['/audio/waves_loop.ogg', '/audio/waves_loop.mp3'],
  rocket:    ['/audio/rocket_launch.ogg', '/audio/rocket_launch.mp3', '/audio/kenney/thrusterFire_000.ogg'],
  gun:       ['/audio/gun_burst.ogg', '/audio/gun_burst.mp3', '/audio/kenney/laserSmall_000.ogg'],
  music:     ['/audio/music_loop.ogg', '/audio/music_loop.mp3'],
  horn:      ['/audio/horn.ogg', '/audio/horn.mp3', '/audio/kenney/jingles_STEEL00.ogg'],
  pickup:    ['/audio/kenney/confirmation_001.ogg'],
  click:     ['/audio/kenney/select_001.ogg'],
  shield:    ['/audio/kenney/forceField_000.ogg'],
  nitro:     ['/audio/kenney/thrusterFire_002.ogg'],
  bump:      ['/audio/kenney/impactPlate_heavy_000.ogg'],
  ping:      ['/audio/kenney/impactMetal_000.ogg'],
  empty:     ['/audio/kenney/error_004.ogg'],
  mine:      ['/audio/kenney/impactWood_heavy_000.ogg'],
  waterBoom: ['/audio/water_explosion.ogg', '/audio/water_explosion.mp3', '/audio/kenney/explosionCrunch_002.ogg'],
  win:       ['/audio/kenney/jingles_HIT00.ogg'],
  lose:      ['/audio/kenney/jingles_SAX05.ogg'],
  start:     ['/audio/kenney/jingles_HIT03.ogg'],
};

class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.muted = localStorageGet('bb-muted') === '1';
    this.listener = { x: 0, z: 0 };
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain(); this.sfx.connect(this.master);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.22; this.musicGain.connect(this.master);
    await Promise.all(Object.entries(SOUNDS).map(([k, urls]) => this.loadFirst(k, urls)));
  }

  async loadFirst(key, urls) {
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        this.buffers[key] = await this.ctx.decodeAudioData(await r.arrayBuffer());
        return;
      } catch { /* try next */ }
    }
  }

  resume() { this.ctx?.state === 'suspended' && this.ctx.resume(); }

  setMuted(m) {
    this.muted = m;
    localStorageSet('bb-muted', m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  /** One-shot sound. pos = {x, z} for distance falloff and stereo pan. */
  play(key, { pos, volume = 1, rate = 1, jitter = 0.06 } = {}) {
    const buf = this.buffers[key];
    if (!buf || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = this.ctx.createGain();
    let v = volume;
    let out = g;
    if (pos) {
      const dx = pos.x - this.listener.x, dz = pos.z - this.listener.z;
      const d = Math.hypot(dx, dz);
      v *= 1 / (1 + Math.max(0, d - 8) / 22);
      if (v < 0.02) return;
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, this.panFor(dx, dz)));
      g.connect(pan); pan.connect(this.sfx); out = null;
    }
    g.gain.value = v;
    if (out) g.connect(this.sfx);
    src.connect(g);
    src.start();
    return src;
  }

  panFor(dx, dz) {
    // listener faces `heading`; positive pan = right
    const h = this.listener.h || 0;
    const rx = -Math.cos(h), rz = Math.sin(h);
    const d = Math.hypot(dx, dz) || 1;
    return ((dx * rx + dz * rz) / d) * 0.8;
  }

  /** A looping sound with live volume/pitch control. */
  loop(key, volume = 1) {
    const buf = this.buffers[key];
    if (!buf || !this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = volume;
    const pan = this.ctx.createStereoPanner();
    src.connect(g); g.connect(pan); pan.connect(key === 'music' ? this.musicGain : this.sfx);
    src.start(0, Math.random() * buf.duration);
    return {
      src, gain: g, pan,
      set: (vol, rate, p = 0) => {
        const t = this.ctx.currentTime;
        g.gain.setTargetAtTime(vol, t, 0.08);
        if (rate) src.playbackRate.setTargetAtTime(rate, t, 0.08);
        pan.pan.setTargetAtTime(p, t, 0.08);
      },
      stop: () => { try { src.stop(); } catch { /* already stopped */ } },
    };
  }
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export const audio = new Audio();
