// Boomboats on Cloudflare: static files come from Workers Static Assets (dist/),
// every multiplayer room runs inside one Durable Object called "lobby",
// and analytics live in a second Durable Object ("stats") with its own SQLite database.
import { DurableObject } from 'cloudflare:workers';
import { createGame, TICK_RATE } from '../game.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const lobbyOf = (env) => env.LOBBY.get(env.LOBBY.idFromName('lobby'));
const statsOf = (env) => env.STATS.get(env.STATS.idFromName('stats'));

// One-way fingerprint of the visitor's IP address: counts unique users without storing the address.
// Mixed with a secret salt (`wrangler secret put IP_SALT`) so it can't be reversed by trying every IP.
async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || !env.IP_SALT) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.IP_SALT}|${ip}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// constant-time check of the admin key (set with `wrangler secret put ADMIN_KEY`)
async function isAdmin(request, env) {
  const key = env.ADMIN_KEY;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || !given) return false;
  const a = new TextEncoder().encode(key), b = new TextEncoder().encode(given);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const headers = new Headers(request.headers);
      headers.set('x-bb-country', request.cf?.country || '');
      headers.set('x-bb-ip', (await ipHash(request, env)) || '');
      return lobbyOf(env).fetch(new Request(request, { headers }));
    }

    // page-visit beacon from the game page
    if (url.pathname === '/api/e' && request.method === 'POST') {
      const text = await request.text();
      if (text.length < 600) {
        try {
          const e = JSON.parse(text);
          if (e && e.t === 'visit') {
            ctx.waitUntil(statsOf(env).record({
              ts: Date.now(), type: 'visit', vid: e.vid, device: e.dev, country: request.cf?.country || null, ip: await ipHash(request, env),
              mode: e.inv ? 'invite' : null, ref: e.ref,
            }).catch(() => {}));
          }
        } catch { /* ignore junk */ }
      }
      return new Response(null, { status: 204 });
    }

    // admin data: only with the admin key
    if (url.pathname === '/admin/api/summary') {
      if (!(await isAdmin(request, env))) return json({ error: 'Wrong or missing admin key' }, 401);
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
      const [summary, live] = await Promise.all([statsOf(env).summary(days), lobbyOf(env).live().catch(() => [])]);
      return json({ ...summary, live });
    }

    // admin: delete everything recorded for one name (e.g. your own test games)
    if (url.pathname === '/admin/api/forget' && request.method === 'POST') {
      if (!(await isAdmin(request, env))) return json({ error: 'Wrong or missing admin key' }, 401);
      const name = (url.searchParams.get('name') || '').slice(0, 20);
      if (!name) return json({ error: 'Missing name' }, 400);
      return json({ removed: await statsOf(env).forget(name) });
    }

    return env.ASSETS.fetch(request);
  },
};

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const stats = statsOf(env);
    this.game = createGame({ log: console.log, track: (e) => { stats.record(e).catch(() => {}); } });
    this.sockets = 0;
    this.timer = null;
  }

  async fetch(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const country = request.headers.get('x-bb-country') || null;
    const ip = request.headers.get('x-bb-ip') || null;
    const conn = this.game.connect({ send: (s) => server.send(s), open: () => server.readyState === 1 }, { country, ip });
    this.sockets++;
    this.startLoop();
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      this.sockets--;
      conn.close();
    };
    server.addEventListener('message', (e) => conn.message(e.data));
    server.addEventListener('close', done);
    server.addEventListener('error', done);
    return new Response(null, { status: 101, webSocket: client });
  }

  // rooms and players right now (for the admin dashboard)
  live() { return this.game.live(); }

  // run the game loop while anyone is connected or a room is still winding down
  startLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.game.tick();
      if (this.sockets === 0 && this.game.roomCount() === 0) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 1000 / TICK_RATE);
  }
}

// ---------------------------------------------------------------- analytics store
const DAY = 86400000;
const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const num = (v) => (Number.isFinite(v) ? v : null);

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, vid TEXT, sid TEXT, name TEXT, mode TEXT,
      room TEXT, public INTEGER, device TEXT, country TEXT, ref TEXT, secs INTEGER, score INTEGER, deaths INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS ev_type_ts ON events(type, ts)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS ev_sid ON events(sid)');
    // added later: hashed IP address (never the address itself)
    const cols = this.sql.exec('PRAGMA table_info(events)').toArray().map((c) => c.name);
    if (!cols.includes('ip')) this.sql.exec('ALTER TABLE events ADD COLUMN ip TEXT');
  }

  /** Store one event: visit, join or leave. */
  record(e) {
    if (!e || !['visit', 'join', 'leave'].includes(e.type)) return;
    const vid = typeof e.vid === 'string' && /^[a-zA-Z0-9-]{8,40}$/.test(e.vid) ? e.vid : null;
    this.sql.exec(
      'INSERT INTO events (ts, type, vid, sid, name, mode, room, public, device, country, ref, secs, score, deaths, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      num(e.ts) ?? Date.now(), e.type, vid, str(e.sid, 16), str(e.name, 20), str(e.mode, 10), str(e.room, 8),
      e.public == null ? null : e.public ? 1 : 0, e.device === 'mobile' ? 'mobile' : e.device ? 'desktop' : null,
      str(e.country, 4), str(e.ref, 80), num(e.secs), num(e.score), num(e.deaths),
      typeof e.ip === 'string' && /^[0-9a-f]{16}$/.test(e.ip) ? e.ip : null,
    );
  }

  /** Delete a name's games, plus the visits from the devices that used it. Returns rows removed. */
  forget(name) {
    const vids = this.sql.exec("SELECT DISTINCT vid FROM events WHERE name=? AND vid IS NOT NULL", name).toArray().map((r) => r.vid);
    let removed = this.sql.exec('DELETE FROM events WHERE name=?', name).rowsWritten;
    for (const v of vids) {
      // keep the device's history if it also played under other names
      const other = this.sql.exec('SELECT COUNT(*) n FROM events WHERE vid=? AND name IS NOT NULL', v).one().n;
      if (!other) removed += this.sql.exec('DELETE FROM events WHERE vid=?', v).rowsWritten;
    }
    return removed;
  }

  /** Everything the dashboard shows, for the last `days` days. */
  summary(days) {
    const now = Date.now(), since = now - days * DAY;
    const q = (sql, ...args) => this.sql.exec(sql, ...args).toArray();
    const one = (sql, ...args) => q(sql, ...args)[0] || {};
    const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

    const totals = {
      visitors: one("SELECT COUNT(DISTINCT vid) n FROM events WHERE type='visit' AND ts>=?", since).n || 0,
      visits: one("SELECT COUNT(*) n FROM events WHERE type='visit' AND ts>=?", since).n || 0,
      players: one("SELECT COUNT(DISTINCT vid) n FROM events WHERE type='join' AND ts>=?", since).n || 0,
      sessions: one("SELECT COUNT(*) n FROM events WHERE type='join' AND ts>=?", since).n || 0,
      roomsCreated: one("SELECT COUNT(*) n FROM events WHERE type='join' AND mode='create' AND ts>=?", since).n || 0,
      friendJoins: one("SELECT COUNT(*) n FROM events WHERE type='join' AND mode IN ('link','code') AND ts>=?", since).n || 0,
      playSeconds: one("SELECT COALESCE(SUM(secs),0) n FROM events WHERE type='leave' AND ts>=?", since).n || 0,
      avgSessionSeconds: Math.round(one("SELECT AVG(secs) n FROM events WHERE type='leave' AND ts>=?", since).n || 0),
      allTimePlayers: one("SELECT COUNT(DISTINCT vid) n FROM events WHERE type='join'").n || 0,
      // unique users by IP address (hashed): anyone who opened or played the game
      uniqueUsers: one("SELECT COUNT(DISTINCT ip) n FROM events WHERE type IN ('visit','join') AND ts>=?", since).n || 0,
      uniquePlayers: one("SELECT COUNT(DISTINCT ip) n FROM events WHERE type='join' AND ts>=?", since).n || 0,
      allTimeUniqueUsers: one("SELECT COUNT(DISTINCT ip) n FROM events WHERE type IN ('visit','join')").n || 0,
    };

    // per-day counts
    const daily = {};
    for (let t = since; t <= now + 1; t += DAY) daily[dayOf(t)] = { day: dayOf(t), users: 0, visitors: 0, players: 0, rooms: 0, minutes: 0 };
    const add = (rows, key) => rows.forEach((r) => { if (daily[r.d]) daily[r.d][key] = r.n; });
    const D = "strftime('%Y-%m-%d', ts/1000, 'unixepoch')";
    add(q(`SELECT ${D} d, COUNT(DISTINCT vid) n FROM events WHERE type='visit' AND ts>=? GROUP BY d`, since), 'visitors');
    add(q(`SELECT ${D} d, COUNT(DISTINCT ip) n FROM events WHERE type IN ('visit','join') AND ts>=? GROUP BY d`, since), 'users');
    add(q(`SELECT ${D} d, COUNT(DISTINCT vid) n FROM events WHERE type='join' AND ts>=? GROUP BY d`, since), 'players');
    add(q(`SELECT ${D} d, COUNT(*) n FROM events WHERE type='join' AND mode='create' AND ts>=? GROUP BY d`, since), 'rooms');
    add(q(`SELECT ${D} d, ROUND(SUM(secs)/60.0, 1) n FROM events WHERE type='leave' AND ts>=? GROUP BY d`, since), 'minutes');

    // funnel: visited -> played -> created a room -> a friend joined that room
    const funnel = [
      { step: 'Opened the game', n: totals.visitors },
      { step: 'Played a match', n: totals.players },
      { step: 'Created a private room', n: one("SELECT COUNT(DISTINCT vid) n FROM events WHERE type='join' AND mode='create' AND ts>=?", since).n || 0 },
      { step: 'A friend joined their room', n: one(`SELECT COUNT(DISTINCT c.vid) n FROM events c JOIN events j
          ON j.room=c.room AND j.type='join' AND j.mode IN ('link','code') AND j.ts>=c.ts AND COALESCE(j.vid,'')<>COALESCE(c.vid,'')
          WHERE c.type='join' AND c.mode='create' AND c.ts>=?`, since).n || 0 },
    ];

    // retention: players grouped by the day they first played; did they come back?
    const activity = q(`SELECT vid, ${D} d FROM events WHERE type='join' AND vid IS NOT NULL GROUP BY vid, d`);
    const byVid = new Map();
    for (const r of activity) { if (!byVid.has(r.vid)) byVid.set(r.vid, new Set()); byVid.get(r.vid).add(r.d); }
    const cohorts = new Map();
    const dayNum = (d) => Math.round(Date.parse(d) / DAY);
    for (const set of byVid.values()) {
      const daysPlayed = [...set].sort();
      const first = daysPlayed[0];
      if (Date.parse(first) < now - Math.max(days, 14) * DAY) continue;
      const f = dayNum(first);
      const offsets = daysPlayed.map((d) => dayNum(d) - f);
      const c = cohorts.get(first) || { day: first, size: 0, d1: 0, d7: 0, any: 0 };
      c.size++;
      if (offsets.includes(1)) c.d1++;
      if (offsets.some((o) => o >= 1 && o <= 7)) c.d7++;
      if (offsets.length > 1) c.any++;
      cohorts.set(first, c);
    }
    const today = dayNum(dayOf(now));
    const retention = [...cohorts.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map((c) => ({
      ...c, age: today - dayNum(c.day), // days since first play (D1 / D7 aren't known yet for very new cohorts)
    }));
    const returning = [...byVid.values()].filter((s) => s.size > 1).length;

    const recent = q(`SELECT j.ts, j.name, j.mode, j.room, j.device, j.country, j.vid, j.ip, l.secs, l.score, l.deaths
      FROM events j LEFT JOIN events l ON l.sid=j.sid AND l.type='leave'
      WHERE j.type='join' AND j.ts>=? ORDER BY j.ts DESC LIMIT 150`, since);
    const names = q(`SELECT j.name, COUNT(*) sessions, COUNT(DISTINCT j.vid) people, COUNT(DISTINCT j.ip) networks, COALESCE(SUM(l.secs),0) secs,
        COALESCE(SUM(l.score),0) sinks, MAX(j.ts) last
      FROM events j LEFT JOIN events l ON l.sid=j.sid AND l.type='leave'
      WHERE j.type='join' AND j.ts>=? GROUP BY j.name ORDER BY sessions DESC, secs DESC LIMIT 50`, since);
    const devices = q("SELECT COALESCE(device,'unknown') k, COUNT(DISTINCT vid) n FROM events WHERE type='visit' AND ts>=? GROUP BY k ORDER BY n DESC", since);
    const countries = q("SELECT COALESCE(country,'??') k, COUNT(DISTINCT vid) n FROM events WHERE type='visit' AND ts>=? GROUP BY k ORDER BY n DESC LIMIT 8", since);
    const joinModes = q("SELECT mode k, COUNT(*) n FROM events WHERE type='join' AND ts>=? GROUP BY k ORDER BY n DESC", since);

    return {
      generatedAt: now, days, totals: { ...totals, returningPlayers: returning },
      daily: Object.values(daily), funnel, retention, recent, names, devices, countries, joinModes,
    };
  }
}
