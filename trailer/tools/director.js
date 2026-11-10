// In-page trailer director: autopilot for my boat + cinematic cameras. Injected after the game boots.
(async () => {
  const bb = window.__boomboats;
  const game = bb.game;
  const THREE = bb.camera.constructor; // PerspectiveCamera, only for type
  void THREE;
  const data = await import('/js/shared/data.js');
  const D = (window.__dir = { pilot: { mode: 'off' }, data });

  const norm = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
  D.me = () => game.me.s;
  D.bots = () => [...game.players.values()]
    .filter((p) => p.info.id !== game.meId && p.alive && p.view.alive)
    .map((p) => ({ id: p.info.id, name: p.info.name, x: p.view.root.position.x, y: p.view.root.position.y, z: p.view.root.position.z, h: p.view.root.rotation.y, p }));
  D.bot = (id) => D.bots().find((b) => b.id === id);
  D.tp = (x, z, h, speed = 0) => {
    const s = game.me.s;
    Object.assign(s, { x, z, h, vx: Math.sin(h) * speed, vz: Math.cos(h) * speed, y: 0, vy: 0, air: false, onRamp: false });
    game.me.view.wakeTrail?.clear?.();
  };
  D.give = (w) => bb.send({ t: 'debug', w });
  D.fire = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  D.hud = (on) => { document.getElementById('hud').style.display = on ? '' : 'none'; };
  D.music = (v) => { if (bb.audio.musicGain) bb.audio.musicGain.gain.value = v; };

  // ---------------------------------------------------------------- autopilot
  // modes: off | straight | point {x,z} | hunt (nearest bot, fires when lined up) | follow {id, dist}
  let lastFire = 0;
  function pilotTick() {
    requestAnimationFrame(pilotTick);
    const P = D.pilot;
    if (!game.me || !game.me.alive || P.mode === 'off') { window.__releaseAll?.(); return; }
    const s = game.me.s;
    let tx = null, tz = null, target = null;
    if (P.mode === 'point') { tx = P.x; tz = P.z; }
    else if (P.mode === 'hunt' || P.mode === 'follow') {
      if (P.id != null) target = D.bot(P.id);
      if (!target && P.mode === 'hunt') {
        let best = 1e9;
        for (const b of D.bots()) {
          const d = Math.hypot(b.x - s.x, b.z - s.z);
          const ang = Math.abs(norm(Math.atan2(b.x - s.x, b.z - s.z) - s.h));
          const score = d + ang * 45;
          if (score < best) { best = score; target = b; }
        }
        if (target && P.lock) P.id = target.id;
      }
      if (target) {
        // lead the target a little
        const lead = P.mode === 'hunt' ? 0.35 : 0;
        tx = target.x + Math.sin(target.h) * 20 * lead; tz = target.z + Math.cos(target.h) * 20 * lead;
        if (P.mode === 'follow') { tx = target.x - Math.sin(target.h) * (P.dist || 12); tz = target.z - Math.cos(target.h) * (P.dist || 12); }
      }
    }
    let steer = 0;
    if (tx != null) {
      const want = Math.atan2(tx - s.x, tz - s.z);
      const diff = norm(want - s.h);
      steer = Math.abs(diff) < 0.04 ? 0 : Math.sign(diff);
      P.aimErr = diff;
      P.dist = Math.hypot(tx - s.x, tz - s.z);
    }
    // island avoidance
    if (P.avoid !== false) {
      for (const isl of data.ISLANDS) {
        const dx = isl.x - s.x, dz = isl.z - s.z, d = Math.hypot(dx, dz) - isl.r;
        const a = norm(Math.atan2(dx, dz) - s.h);
        if (d < 16 && Math.abs(a) < 0.9) steer = a > 0 ? -1 : 1;
      }
      const r = Math.hypot(s.x, s.z);
      if (r > 128) { const a = norm(Math.atan2(-s.x, -s.z) - s.h); steer = Math.sign(a); }
    }
    window.__key('KeyA', steer > 0);
    window.__key('KeyD', steer < 0);
    window.__key('KeyW', P.throttle !== 0);
    // weapons
    const w = game.me.weapon;
    const now = performance.now() / 1000;
    if (P.fire && w && now - lastFire > (P.fireGap || 0.7)) {
      let go = false;
      if (w === 'shield' || w === 'nitro') go = !target || (P.dist ?? 99) < (P.nitroRange || 45);
      else if (w === 'wave') go = D.bots().filter((b) => Math.hypot(b.x - s.x, b.z - s.z) < 26).length >= (P.waveMin || 2);
      else if (w === 'mines') go = true;
      else go = target && Math.abs(P.aimErr) < 0.1 && (P.dist ?? 99) < (w === 'gun' ? 40 : 70);
      if (go) { lastFire = now; D.fire(); }
    }
  }
  requestAnimationFrame(pilotTick);

  // ---------------------------------------------------------------- cameras
  const V = (x, y, z) => ({ x, y, z });
  const cam = { pos: null, look: null, last: performance.now() / 1000 };
  const lerp = (a, b, k) => a + (b - a) * k;
  function apply(c, pos, look, fov, smooth, dt) {
    if (!cam.pos || smooth === 0) { cam.pos = { ...pos }; cam.look = { ...look }; }
    else {
      const k = 1 - Math.exp(-smooth * dt), kl = 1 - Math.exp(-smooth * 1.6 * dt);
      for (const ax of ['x', 'y', 'z']) { cam.pos[ax] = lerp(cam.pos[ax], pos[ax], k); cam.look[ax] = lerp(cam.look[ax], look[ax], kl); }
    }
    c.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    c.lookAt(cam.look.x, cam.look.y, cam.look.z);
    if (fov) { c.fov = fov; c.updateProjectionMatrix(); }
  }
  const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
  D.cams = {
    off() { window.__cam = null; cam.pos = null; },
    // circle around a point
    orbit({ cx = 0, cz = 0, r = 110, y = 50, speed = 0.06, a0 = 0, lookY = 0, fov = 50 }) {
      cam.pos = null; const t0 = performance.now() / 1000;
      window.__cam = (c, t) => { const a = a0 + (t - t0) * speed; apply(c, V(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r), V(cx, lookY, cz), fov, 0, 0); };
    },
    // camera fixed to my boat's frame: side (+ = right), fwd (+ = ahead), up
    rig({ side = 0, fwd = -12, up = 5, lookFwd = 6, lookUp = 1.5, lookSide = 0, fov = 55, smooth = 6, target = 'me', id = null }) {
      cam.pos = null;
      window.__cam = (c, t) => {
        const dt = Math.min(0.05, t - cam.last); cam.last = t;
        let s;
        if (target === 'me') s = game.me.s;
        else { const b = D.bot(id) || D.lastBot; if (!b) return; D.lastBot = b; s = b; }
        const fx = Math.sin(s.h), fz = Math.cos(s.h), rx = -fz, rz = fx;
        const y = (s.y || 0);
        apply(c,
          V(s.x + fx * fwd + rx * side, Math.max(0.8, y * 0.5 + up), s.z + fz * fwd + rz * side),
          V(s.x + fx * lookFwd + rx * lookSide, y * 0.7 + lookUp, s.z + fz * lookFwd + rz * lookSide), fov, smooth, dt);
      };
    },
    // fixed camera position that pans to keep my boat (or a bot) in frame
    watch({ x, y, z, target = 'me', id = null, lookUp = 1.2, fov = 45, smooth = 8 }) {
      cam.pos = null;
      window.__cam = (c, t) => {
        const dt = Math.min(0.05, t - cam.last); cam.last = t;
        const s = target === 'me' ? game.me.s : (D.bot(id) || D.lastBot);
        if (!s) return;
        if (target !== 'me') D.lastBot = s;
        apply(c, V(x, y, z), V(s.x, (s.y || 0) + lookUp, s.z), fov, cam.pos ? smooth : 0, dt);
      };
    },
    // move between two keyframes over `dur` seconds
    move({ from, to, lookFrom, lookTo, dur = 6, fov = 50, fovTo }) {
      cam.pos = null; const t0 = performance.now() / 1000;
      window.__cam = (c, t) => {
        const k = ease((t - t0) / dur);
        const p = V(lerp(from.x, to.x, k), lerp(from.y, to.y, k), lerp(from.z, to.z, k));
        const l = V(lerp(lookFrom.x, lookTo.x, k), lerp(lookFrom.y, lookTo.y, k), lerp(lookFrom.z, lookTo.z, k));
        apply(c, p, l, lerp(fov, fovTo ?? fov, k), 0, 0);
      };
    },
  };
  D.ready = true;
})();
