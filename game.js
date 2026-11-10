// Boomboats game logic: rooms, bots, weapons and hits. Runs inside the Node server (server.js)
// and inside the Cloudflare Durable Object (worker/index.js); each passes in its own sockets.
import {
  TICK_RATE, SNAPSHOT_RATE, MATCH_SECONDS, RESULTS_SECONDS, MAX_PLAYERS, MIN_ACTORS,
  RESPAWN_SECONDS, SPAWN_SHIELD, MAX_HP, BOATS, CHARACTERS, WEAPONS, WEAPON_STATS as WS,
  CRATE_SPOTS, CRATE_RESPAWN, SPAWNS, ARENA_R, SOLIDS, WEAPON_KEYS, newBoatState, stepBoat, pickWeapon, angleDiff,
  findAimTarget, losClear, BURST_INTERVAL,
} from "./public/js/shared/data.js";

export { TICK_RATE };

/**
 * opts: { matchSeconds?, debug?, log?, track? }  track(event) receives analytics events (join / leave).
 * A socket is { send(text), open() -> boolean }.
 */
export function createGame(opts = {}) {
  const MATCH_LEN = Number(opts.matchSeconds) || MATCH_SECONDS;
  const log = opts.log || (() => {});
  const track = (e) => { try { opts.track?.({ ts: Date.now(), ...e }); } catch { /* analytics must never break the game */ } };
  const cleanId = (v) => (typeof v === 'string' && /^[a-zA-Z0-9-]{8,40}$/.test(v) ? v : null);
  const rooms = new Map();
  let nextId = 1;
  const now = () => performance.now() / 1000;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const r2 = (v) => Math.round(v * 100) / 100;
  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
  const BOT_NAMES = [
    'Captain Kipper', 'Salty Sue', 'Barnacle Bob', 'Wave Rider', 'Admiral Fizz', 'Sea Biscuit',
    'Rusty Anchor', 'Tidal Tina', 'Gill Bates', 'Cap. Crunch', 'Marlin Monroe', 'Shelly',
    'Skipper Jo', 'Reef Raider', 'Bubbles', 'Hook Hand Hal', 'Splashley', 'Torpedo Ted',
  ];
  const PROJ_CODE = { rocket: 0, torpedo: 1, bullet: 2 };


  // ---------------------------------------------------------------- rooms


  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let c;
    do { c = Array.from({ length: 5 }, () => pick(A)).join(''); } while (rooms.has(c));
    return c;
  }

  class Room {
    constructor(isPublic) {
      this.code = makeCode();
      this.isPublic = isPublic;
      this.players = new Map();
      this.projectiles = [];
      this.mines = new Map();
      this.waves = [];
      this.crates = CRATE_SPOTS.map((s, i) => ({ i, x: s.x, z: s.z, on: true, at: 0, w: pickWeapon() }));
      this.emptySince = now();
      this.startMatch();
      this.lastSnap = 0;
      this.lastBoard = 0;
      rooms.set(this.code, this);
    }

    humans() { return [...this.players.values()].filter((p) => !p.isBot); }

    send(p, msg) { if (p.ws && p.ws.open()) p.ws.send(JSON.stringify(msg)); }
    broadcast(msg) {
      const s = JSON.stringify(msg);
      for (const p of this.players.values()) if (p.ws && p.ws.open()) p.ws.send(s);
    }

    publicInfo(p) {
      return { id: p.id, name: p.name, boat: p.boat, char: p.char, bot: p.isBot, score: p.score, deaths: p.deaths };
    }

    addPlayer(p) {
      this.players.set(p.id, p);
      this.spawn(p, true);
      if (!p.isBot) {
        this.emptySince = null;
        this.send(p, {
          t: 'welcome', id: p.id, room: this.code, isPublic: this.isPublic,
          players: [...this.players.values()].map((q) => this.publicInfo(q)),
          match: { state: this.state, endsAt: this.endsAt - now() },
          crates: this.crateList(),
          mines: [...this.mines.values()].map((m) => [m.id, r2(m.x), r2(m.z), m.owner.id, r2(m.expires - now())]),
          spawn: { x: p.s.x, z: p.s.z, h: p.s.h },
        });
      }
      this.broadcastExcept(p, { t: 'join', p: this.publicInfo(p) });
    }

    crateList() { return this.crates.map((c) => [c.i, c.on ? 1 : 0, c.w]); }

    broadcastExcept(ex, msg) {
      const s = JSON.stringify(msg);
      for (const p of this.players.values()) if (p !== ex && p.ws && p.ws.open()) p.ws.send(s);
    }

    removePlayer(p) {
      this.players.delete(p.id);
      this.broadcast({ t: 'leave', id: p.id });
      if (this.humans().length === 0) this.emptySince = now();
      if (!p.isBot) this.balanceBots();
    }

    balanceBots() {
      const humans = this.humans().length;
      const bots = [...this.players.values()].filter((p) => p.isBot);
      const want = Math.max(0, Math.min(MAX_PLAYERS, MIN_ACTORS) - humans);
      if (humans === 0) return;
      for (let i = bots.length; i < want; i++) this.addBot();
      for (let i = want; i < bots.length; i++) this.removePlayer(bots[i]);
    }

    addBot() {
      const used = new Set([...this.players.values()].map((p) => p.name));
      const name = pick(BOT_NAMES.filter((n) => !used.has(n))) || 'Bot';
      const bot = makePlayer(null, name, pick(BOATS).id, pick(CHARACTERS));
      bot.isBot = true;
      bot.ai = { goal: null, stuckT: 0, reverseT: 0, holdT: 0, fireCd: rnd(0.3, 1), skill: rnd(0.6, 1) };
      this.addPlayer(bot);
    }

    startMatch() {
      this.state = 'playing';
      this.endsAt = now() + MATCH_LEN;
      this.projectiles = [];
      this.mines.clear();
      this.crates.forEach((c) => { c.on = true; c.w = pickWeapon(); });
      for (const p of this.players.values()) {
        p.totalScore += p.score; p.totalDeaths += p.deaths;
        p.score = 0; p.deaths = 0; p.weapon = null; p.ammo = 0;
        this.spawn(p);
      }
      this.broadcast({ t: 'match', state: 'playing', endsAt: MATCH_LEN, crates: this.crateList(), mines: [] });
    }

    endMatch() {
      this.state = 'results';
      this.endsAt = now() + RESULTS_SECONDS;
      const results = [...this.players.values()]
        .sort((a, b) => b.score - a.score || a.deaths - b.deaths)
        .map((p) => ({ id: p.id, name: p.name, score: p.score, deaths: p.deaths, boat: p.boat, char: p.char, bot: p.isBot }));
      this.broadcast({ t: 'match', state: 'results', endsAt: RESULTS_SECONDS, results });
    }

    spawn(p, quiet) {
      const others = [...this.players.values()].filter((q) => q !== p && q.alive);
      let best = SPAWNS[0], bestD = -1;
      for (const s of SPAWNS) {
        const d = others.length ? Math.min(...others.map((q) => dist2(q.s, s))) : Math.random();
        const score = d + Math.random() * 300;
        if (score > bestD) { bestD = score; best = s; }
      }
      p.s = newBoatState(best);
      p.alive = true;
      p.hp = MAX_HP;
      p.shieldUntil = 0;
      p.safeUntil = now() + SPAWN_SHIELD; // spawn protection
      p.respawnAt = 0;
      p.trigger = false;
      p.nitroUntil = 0;
      p.waveAt = 0;
      if (!quiet) this.broadcast({ t: 'spawn', id: p.id, x: r2(best.x), z: r2(best.z), h: r2(best.h) });
    }

    safe(v) { const t = now(); return v.shieldUntil > t || v.safeUntil > t; }

    kill(v, k, weapon) {
      if (!v.alive || this.safe(v)) return false;
      v.alive = false;
      v.respawnAt = now() + RESPAWN_SECONDS;
      v.deaths++;
      v.weapon = null; v.ammo = 0; v.trigger = false; v.nitroUntil = 0; v.waveAt = 0;
      if (k && k !== v && this.state === 'playing') k.score++;
      this.broadcast({ t: 'kill', v: v.id, k: k ? k.id : null, w: weapon, x: r2(v.s.x), z: r2(v.s.z), ks: k ? k.score : 0 });
      return true;
    }

    damage(v, k, dmg, weapon) {
      if (!v.alive || this.safe(v)) return;
      v.hp -= dmg;
      if (v.hp <= 0) this.kill(v, k, weapon);
      else this.broadcast({ t: 'hit', v: v.id, hp: v.hp });
    }

    boom(x, y, z, kind, owner, radius) {
      this.broadcast({ t: 'boom', x: r2(x), y: r2(y), z: r2(z), kind });
      if (radius) {
        for (const p of this.players.values()) {
          if (!p.alive || p === owner) continue;
          if ((p.s.x - x) ** 2 + (p.s.z - z) ** 2 < radius * radius && Math.abs(p.s.y - y) < radius) this.kill(p, owner, kind);
        }
      }
    }

    // One tap. Single-use weapons go off now; multi-shot ones keep firing in tick() until empty.
    fire(p) {
      if (!p.alive || !p.weapon || this.state !== 'playing' || p.trigger) return;
      const t = now();
      if (p.fireLock > t) return;
      p.fireLock = t + 0.2;
      if (p.weapon !== 'shield') p.safeUntil = 0; // attacking ends spawn protection
      if (WEAPONS[p.weapon].ammo > 1) { p.trigger = true; p.nextShot = t; return; }
      this.shoot(p, t);
    }

    // one shot of the current weapon, aimed wherever the boat points right now
    shoot(p, t) {
      const w = p.weapon;
      const s = p.s;
      const fx = Math.sin(s.h), fz = Math.cos(s.h);
      switch (w) {
        case 'gun': {
          const h = this.aimHeading(p, WS.bulletSpeed) + rnd(-0.03, 0.03);
          const bx = Math.sin(h), bz = Math.cos(h);
          const side = (p.shotSide = -(p.shotSide || 1)) * 0.5;
          this.projectiles.push({ id: nextId++, type: 'bullet', owner: p,
            x: s.x + bx * 2.4 + Math.cos(s.h) * side, y: s.y + 1.4, z: s.z + bz * 2.4 - Math.sin(s.h) * side,
            vx: bx * WS.bulletSpeed, vz: bz * WS.bulletSpeed, life: WS.bulletLife, born: t });
          p.lastShot = t;
          break;
        }
        case 'rockets': {
          const sp = WS.rocketSpeed;
          const h = this.aimHeading(p, sp);
          this.projectiles.push({ id: nextId++, type: 'rocket', owner: p, x: s.x + fx * 2.6, y: s.y + 1.3, z: s.z + fz * 2.6,
            vx: Math.sin(h) * sp, vz: Math.cos(h) * sp, life: WS.rocketLife, born: t });
          break;
        }
        case 'torpedo': {
          const pr = { id: nextId++, type: 'torpedo', owner: p, x: s.x + fx * 3, y: 0.2, z: s.z + fz * 3,
            vx: fx * WS.torpedoSpeed, vz: fz * WS.torpedoSpeed, h: s.h, life: WS.torpedoLife, born: t };
          pr.target = this.findTarget(p, pr, 1.4, 160, true);
          this.projectiles.push(pr);
          break;
        }
        case 'mines': {
          if (this.mines.size >= WS.maxMines) this.mines.delete(this.mines.keys().next().value);
          const m = { id: nextId++, owner: p, x: s.x - fx * 3.8, z: s.z - fz * 3.8, armAt: t + WS.mineArm, expires: t + WS.mineLife };
          this.mines.set(m.id, m);
          this.broadcast({ t: 'mine', id: m.id, x: r2(m.x), z: r2(m.z), o: p.id, life: WS.mineLife });
          break;
        }
        case 'shield': p.shieldUntil = t + WS.shieldDuration; break;
        case 'nitro': p.nitroUntil = t + WS.nitroDuration; p.s.boost = WS.nitroDuration; break;
        case 'wave': p.waveAt = t + WS.waveDelay; break;
      }
      if (w !== 'gun') this.broadcast({ t: 'fire', id: p.id, w }); // the gun's sound comes from the snapshot flag
      p.ammo--;
      if (p.ammo <= 0) { p.weapon = null; p.ammo = 0; p.trigger = false; }
      this.send(p, { t: 'ammo', w: p.weapon, n: p.ammo });
    }

    // heading for a shot, bent toward a boat inside the aim-assist cone
    aimHeading(p, shotSpeed) {
      const targets = [];
      for (const q of this.players.values()) {
        if (q !== p && q.alive) targets.push({ x: q.s.x, z: q.s.z, vx: q.s.vx, vz: q.s.vz, ref: q });
      }
      const aim = findAimTarget(p.s, targets, shotSpeed);
      return aim ? aim.heading : p.s.h;
    }

    findTarget(p, from, cone, range, needSight) {
      let best = null, bd = range * range;
      const h = Math.atan2(from.vx, from.vz);
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const d = dist2(from, q.s);
        if (d > bd) continue;
        const a = Math.abs(angleDiff(h, Math.atan2(q.s.x - from.x, q.s.z - from.z)));
        if (a < cone && (!needSight || losClear(from.x, from.z, q.s.x, q.s.z))) { bd = d; best = q; }
      }
      return best;
    }

    // ------------------------------------------------------------- simulation
    tick(dt) {
      const t = now();
      if (this.state === 'playing' && t >= this.endsAt) this.endMatch();
      else if (this.state === 'results' && t >= this.endsAt) this.startMatch();

      for (const p of this.players.values()) {
        if (!p.alive) {
          // bots come back by themselves; people press REVIVE
          if (p.isBot && p.respawnAt && t >= p.respawnAt) this.spawn(p);
          continue;
        }
        if (p.isBot) this.botThink(p, dt, t);
        // after one tap, multi-shot weapons keep firing until they're empty
        if (p.trigger && p.weapon && this.state === 'playing' && t >= (p.nextShot || 0)) {
          p.nextShot = t + (BURST_INTERVAL[p.weapon] || 0.3);
          this.shoot(p, t);
        }
        // boom wave
        if (p.waveAt && t >= p.waveAt) {
          p.waveAt = 0;
          this.boom(p.s.x, 0, p.s.z, 'wave', p, WS.waveRadius);
        }
        // crates
        if (!p.weapon && this.state === 'playing') {
          for (const c of this.crates) {
            if (c.on && dist2(p.s, c) < 3.3 * 3.3 && p.s.y < 4) {
              c.on = false; c.at = t + CRATE_RESPAWN;
              p.weapon = c.w; p.ammo = WEAPONS[p.weapon].ammo;
              this.broadcast({ t: 'crate', i: c.i, on: false, by: p.id });
              this.send(p, { t: 'ammo', w: p.weapon, n: p.ammo, fresh: true });
              p.trigger = false;
            if (p.isBot) p.ai.holdT = 0;
              break;
            }
          }
        }
      }
      for (const c of this.crates) {
        if (!c.on && t >= c.at) { c.on = true; c.w = pickWeapon(); this.broadcast({ t: 'crate', i: c.i, on: true, w: c.w }); }
      }

      // ramming with nitro, and boat-vs-boat bumps for bots
      const alive = [...this.players.values()].filter((p) => p.alive);
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j];
          const d2 = dist2(a.s, b.s);
          if (d2 > 4.2 * 4.2 || Math.abs(a.s.y - b.s.y) > 3) continue;
          if (a.nitroUntil > t && b.nitroUntil <= t) this.kill(b, a, 'nitro');
          else if (b.nitroUntil > t && a.nitroUntil <= t) this.kill(a, b, 'nitro');
          else {
            const d = Math.sqrt(d2) || 0.01, nx = (b.s.x - a.s.x) / d, nz = (b.s.z - a.s.z) / d, push = (4.2 - d) / 2;
            if (a.isBot) { a.s.x -= nx * push; a.s.z -= nz * push; }
            if (b.isBot) { b.s.x += nx * push; b.s.z += nz * push; }
          }
        }
      }

      // projectiles
      for (const pr of this.projectiles) {
        pr.life -= dt;
        if (pr.type === 'torpedo') {
          if (!pr.target || !pr.target.alive) pr.target = this.findTarget(pr.owner, pr, 1.2, 120);
          if (pr.target) {
            const want = Math.atan2(pr.target.s.x - pr.x, pr.target.s.z - pr.z);
            pr.h += Math.max(-WS.torpedoTurn * dt, Math.min(WS.torpedoTurn * dt, angleDiff(pr.h, want)));
          }
          pr.vx = Math.sin(pr.h) * WS.torpedoSpeed; pr.vz = Math.cos(pr.h) * WS.torpedoSpeed;
        }
        pr.x += pr.vx * dt; pr.z += pr.vz * dt;
        let hit = false;
        for (const q of alive) {
          if (q === pr.owner && t - pr.born < 0.5) continue;
          if (q === pr.owner && pr.type === 'bullet') continue;
          const r = pr.type === 'bullet' ? 2.2 : 2.7;
          if (dist2(pr, q.s) < r * r && Math.abs(q.s.y + 0.8 - pr.y) < 3.2) {
            if (pr.type === 'bullet') {
              this.damage(q, pr.owner, WS.bulletDamage, 'gun');
              this.broadcast({ t: 'boom', x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), kind: q.shieldUntil > t ? 'deflect' : 'spark' });
            } else {
              this.kill(q, pr.owner, pr.type === 'rocket' ? 'rockets' : 'torpedo');
              this.boom(pr.x, pr.y, pr.z, pr.type, pr.owner, pr.type === 'rocket' ? WS.rocketSplash : 3);
            }
            hit = true; break;
          }
        }
        if (!hit) {
          for (const o of SOLIDS) {
            if ((pr.x - o.x) ** 2 + (pr.z - o.z) ** 2 < (o.r + 0.4) ** 2 && pr.y < o.h + 1) {
              if (pr.type === 'bullet') this.broadcast({ t: 'boom', x: r2(pr.x), y: r2(pr.y), z: r2(pr.z), kind: 'spark' });
              else this.boom(pr.x, pr.y, pr.z, pr.type, pr.owner, WS.rocketSplash);
              hit = true; break;
            }
          }
          if (!hit && pr.x * pr.x + pr.z * pr.z > (ARENA_R + 12) ** 2) { pr.life = 0; }
        }
        if (hit) pr.life = -1;
        else if (pr.life <= 0 && pr.type !== 'bullet') this.boom(pr.x, Math.max(pr.y, 0), pr.z, pr.type === 'rocket' ? 'splash' : 'torpedo', pr.owner, pr.type === 'rocket' ? 0 : WS.rocketSplash);
      }
      this.projectiles = this.projectiles.filter((pr) => pr.life > 0);

      // mines
      for (const m of this.mines.values()) {
        if (t > m.expires) { this.mines.delete(m.id); this.broadcast({ t: 'unmine', id: m.id, gone: 1 }); continue; }
        if (t < m.armAt) continue;
        for (const q of alive) {
          if (q === m.owner) continue; // your own mines never go off on you
          if (q.alive && dist2(m, q.s) < WS.mineRadius ** 2 && q.s.y < 2.5) {
            this.mines.delete(m.id);
            this.broadcast({ t: 'unmine', id: m.id });
            this.kill(q, m.owner === q ? null : m.owner, 'mines');
            this.boom(m.x, 0.5, m.z, 'mine', m.owner, 4);
            break;
          }
        }
      }

      if (t - this.lastSnap >= 1 / SNAPSHOT_RATE) { this.lastSnap = t; this.snapshot(t); }
      if (t - this.lastBoard >= 1) {
        this.lastBoard = t;
        this.broadcast({ t: 'board', l: [...this.players.values()].map((p) => [p.id, p.score, p.deaths]), left: r2(this.endsAt - t), st: this.state });
      }
    }

    snapshot(t) {
      const p = [];
      for (const q of this.players.values()) {
        const s = q.s;
        const flags = (q.alive ? 1 : 0) | (this.safe(q) ? 2 : 0) | (q.nitroUntil > t || s.boost > 0 ? 4 : 0)
          | (t - (q.lastShot || 0) < 0.2 ? 8 : 0) | (q.waveAt ? 16 : 0) | (q.safeUntil > t ? 32 : 0);
        p.push([q.id, r2(s.x), r2(s.y), r2(s.z), r2(s.h), flags, Math.max(0, q.hp), r2(Math.hypot(s.vx, s.vz)),
          q.weapon ? WEAPON_KEYS.indexOf(q.weapon) + 1 : 0]);
      }
      const pr = this.projectiles.map((x) => [x.id, PROJ_CODE[x.type], r2(x.x), r2(x.y), r2(x.z), r2(x.vx), r2(x.vz)]);
      this.broadcast({ t: 's', ts: r2(t), p, pr });
    }

    // ------------------------------------------------------------- bot brain
    botThink(p, dt, t) {
      const ai = p.ai, s = p.s;
      const enemies = [...this.players.values()].filter((q) => q !== p && q.alive);
      let nearest = null, nd = Infinity;
      for (const q of enemies) { const d = dist2(s, q.s); if (d < nd) { nd = d; nearest = q; } }
      const angTo = (o) => angleDiff(s.h, Math.atan2(o.x - s.x, o.z - s.z));

      // pick a goal
      let goal = null;
      if (!p.weapon) {
        let bc = null, bd = Infinity;
        for (const c of this.crates) {
          if (!c.on) continue;
          const d = dist2(s, c) * (1 + Math.abs(angTo(c)) * 0.6) / WEAPONS[c.w].tier;
          if (d < bd) { bd = d; bc = c; }
        }
        goal = bc;
      } else if (nearest) goal = nearest.s;
      if (!goal) goal = { x: 0, z: 0 };

      let desired = Math.atan2(goal.x - s.x, goal.z - s.z);
      // steer around islands in the way
      const fx = Math.sin(s.h), fz = Math.cos(s.h);
      let nearestAhead = Infinity;
      for (const isl of SOLIDS) {
        const dx = isl.x - s.x, dz = isl.z - s.z;
        const ahead = dx * fx + dz * fz;
        if (ahead < 0 || ahead > 24 || ahead > nearestAhead) continue;
        const lat = dx * Math.cos(s.h) - dz * Math.sin(s.h); // + means obstacle on the left
        if (Math.abs(lat) < isl.r + 4.5) { nearestAhead = ahead; desired = s.h + (lat > 0 ? -1.1 : 1.1); }
      }
      if (Math.hypot(s.x, s.z) > ARENA_R - 13) desired = Math.atan2(-s.x, -s.z);

      const diff = angleDiff(s.h, desired);
      const input = { throttle: 1, steer: Math.max(-1, Math.min(1, diff * 2.5)) };
      if (Math.abs(diff) > 2.3 && nd < 400) input.throttle = 0.5;

      // unstick
      const speed = Math.hypot(s.vx, s.vz);
      ai.stuckT = speed < 3 ? ai.stuckT + dt : 0;
      if (ai.stuckT > 1.2) { ai.reverseT = 1.1; ai.stuckT = 0; }
      if (ai.reverseT > 0) { ai.reverseT -= dt; input.throttle = -1; input.steer = 1; }

      stepBoat(s, input, dt);

      // weapons
      ai.fireCd -= dt;
      if (p.weapon && ai.fireCd <= 0 && this.state === 'playing') {
        ai.holdT += dt;
        const w = p.weapon;
        const ang = nearest ? Math.abs(angTo(nearest.s)) : 9;
        const d = Math.sqrt(nd);
        const sight = nearest && losClear(s.x, s.z, nearest.s.x, nearest.s.z);
        let go = false;
        if (w === 'rockets') go = sight && d < 70 && ang < 0.1 + 2 / Math.max(d, 1);
        else if (w === 'gun') go = sight && d < 55 && ang < 0.3 + 2 / Math.max(d, 1);
        else if (w === 'torpedo') go = sight && d < 110 && ang < 0.9;
        else if (w === 'mines') go = (d < 35 && ang > 2.4) || ai.holdT > 6;
        else if (w === 'shield') go = ai.holdT > rnd(0.5, 3);
        else if (w === 'nitro') go = d < 45 && ang < 0.25;
        else if (w === 'wave') go = d < WS.waveRadius * 0.7;
        if (ai.holdT > 14) go = true;
        if (go && Math.random() < ai.skill) {
          this.fire(p);
          ai.fireCd = rnd(0.25, 0.7) / ai.skill;
        }
      }
    }
  }

  function makePlayer(ws, name, boat, char) {
    return {
      id: nextId++, ws, name, boat, char, isBot: false, s: newBoatState(SPAWNS[0]), alive: false, hp: MAX_HP,
      score: 0, deaths: 0, totalScore: 0, totalDeaths: 0, weapon: null, ammo: 0, shieldUntil: 0, safeUntil: 0, trigger: false, nitroUntil: 0, waveAt: 0, fireLock: 0,
    };
  }

  // one connected client; returns handlers for its messages and its disconnect.
  // meta: { country? } from the host (Cloudflare adds the visitor's country).
  function connect(sock, meta = {}) {
    let room = null, me = null;
    const reply = (msg) => { if (sock.open()) sock.send(JSON.stringify(msg)); };
    return {
      message(raw) {
        if (typeof raw !== "string" || raw.length > 16 * 1024) return;
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m.t !== "string") return;
        if (m.t === "ping") { reply({ t: "pong", c: m.c, s: now() }); return; }
        if (m.t === "join" && !me) {
          const name = String(m.name || "Sailor").replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 16) || "Sailor";
          const boat = BOATS.some((b) => b.id === m.boat) ? m.boat : BOATS[0].id;
          const char = CHARACTERS.includes(m.char) ? m.char : CHARACTERS[0];
          if (m.mode === "create") room = new Room(false);
          else if (m.mode === "code") {
            room = rooms.get(String(m.code || "").toUpperCase().trim());
            if (!room) { reply({ t: "error", msg: "No room with that code. Check the code and try again." }); return; }
            if (room.humans().length >= MAX_PLAYERS) { reply({ t: "error", msg: "That room is full (8 players)." }); room = null; return; }
          } else {
            room = [...rooms.values()]
              .filter((r) => r.isPublic && r.humans().length < MAX_PLAYERS)
              .sort((a, b) => b.humans().length - a.humans().length)[0] || new Room(true);
          }
          me = makePlayer(sock, name, boat, char);
          me.vid = cleanId(m.vid);
          me.sid = Math.random().toString(36).slice(2, 12);
          me.joinedAt = now();
          me.kills = 0;
          track({
            type: 'join', sid: me.sid, vid: me.vid, name, room: room.code, public: room.isPublic,
            mode: m.mode === 'create' ? 'create' : m.mode === 'code' ? (m.via === 'link' ? 'link' : 'code') : 'quick',
            device: m.dev === 'mobile' ? 'mobile' : 'desktop', country: meta.country || null, ip: meta.ip || null,
          });
          room.addPlayer(me);
          room.balanceBots();
          log(`[${room.code}] ${name} joined (${room.humans().length} humans)`);
          return;
        }
        if (!me || !room) return;
        if (m.t === "s" && me.alive) {
          const s = me.s;
          const nums = [m.x, m.y, m.z, m.h, m.vx, m.vz].map(Number);
          if (nums.some((v) => !Number.isFinite(v))) return;
          [s.x, s.y, s.z, s.h, s.vx, s.vz] = nums;
          const d = Math.hypot(s.x, s.z);
          const lim = ARENA_R + 7;
          if (d > lim) { s.x *= lim / d; s.z *= lim / d; }
        } else if (m.t === "fire") room.fire(me);
        else if (m.t === "revive") {
          // the REVIVE button unlocks after RESPAWN_SECONDS (small allowance for clock differences)
          if (!me.alive && room.state === "playing" && now() >= me.respawnAt - 0.3) room.spawn(me);
        }
        else if (m.t === "debug" && opts.debug && WEAPONS[m.w]) {
          me.weapon = m.w; me.ammo = WEAPONS[m.w].ammo;
          room.send(me, { t: "ammo", w: me.weapon, n: me.ammo, fresh: true });
        }
      },
      close() {
        if (room && me) {
          room.removePlayer(me);
          log(`[${room.code}] ${me.name} left`);
          track({ type: 'leave', sid: me.sid, vid: me.vid, name: me.name, room: room.code,
            secs: Math.round(now() - me.joinedAt), score: me.totalScore + me.score, deaths: me.totalDeaths + me.deaths });
        }
        room = null; me = null;
      },
    };
  }

  // advance every room; call TICK_RATE times a second
  let last = now();
  function tick() {
    const t = now();
    const dt = Math.min(0.1, t - last);
    last = t;
    for (const room of rooms.values()) {
      if (room.emptySince && t - room.emptySince > 20) { rooms.delete(room.code); continue; }
      if (room.humans().length) room.tick(dt);
    }
  }

  // what's happening right now, for the admin dashboard
  function live() {
    const t = now();
    return [...rooms.values()].map((r) => ({
      code: r.code, public: r.isPublic, state: r.state, secondsLeft: Math.max(0, Math.round(r.endsAt - t)),
      bots: [...r.players.values()].filter((p) => p.isBot).length,
      people: r.humans().map((p) => ({ name: p.name, score: p.score, minutes: Math.round((t - (p.joinedAt || t)) / 6) / 10 })),
    }));
  }

  return { connect, tick, live, roomCount: () => rooms.size };
}
