// Shared game rules: used by both the browser and the Node server.

export const TICK_RATE = 30;          // server simulation steps per second
export const SNAPSHOT_RATE = 20;      // world updates sent to clients per second
export const MATCH_SECONDS = 180;     // one match = 3 minutes
export const RESULTS_SECONDS = 12;    // podium screen between matches
export const MAX_PLAYERS = 8;
export const MIN_ACTORS = 6;          // rooms are topped up with bots to this many boats
export const RESPAWN_SECONDS = 5;    // wait before the REVIVE button unlocks
export const SPAWN_SHIELD = 4;       // seconds of protection after (re)spawning; ends early if you fire
export const MAX_HP = 100;

export const ARENA_R = 165;

export const BOATS = [
  { id: 'boat-speed-a', name: 'Bluefin' },
  { id: 'boat-speed-b', name: 'Sunburst' },
  { id: 'boat-speed-c', name: 'Firecracker' },
  { id: 'boat-speed-d', name: 'Lemon Drop' },
  { id: 'boat-speed-e', name: 'Lava Raft' },
  { id: 'boat-speed-f', name: 'Turtle' },
  { id: 'boat-speed-g', name: 'Riptide' },
  { id: 'boat-speed-h', name: 'Hot Rod' },
  { id: 'boat-speed-i', name: 'Copper Jet' },
  { id: 'boat-speed-j', name: 'Mint Racer' },
];

export const CHARACTERS = [
  'character-male-a', 'character-female-a', 'character-male-b', 'character-female-b',
  'character-male-c', 'character-female-c', 'character-male-d', 'character-female-d',
  'character-male-e', 'character-female-e', 'character-male-f', 'character-female-f',
  'character-robot', 'character-alien', 'character-knight', 'character-soldier',
  'character-zombie', 'character-raider', 'character-worker',
];

// tier 1 = Common, 2 = Rare, 3 = Epic, 4 = Legendary. Every weapon is one tap: weapons with more than one
// shot fire them all by themselves, one after another (see BURST_INTERVAL).
export const WEAPONS = {
  gun:     { name: 'Machine Gun',    ammo: 30, weight: 30, tier: 1, aim: 'front', how: 'One tap fires all 30 bullets · keep pointing at the boat · 8 hits sink it' },
  rockets: { name: 'Rockets',        ammo: 3,  weight: 25, tier: 1, aim: 'front', how: 'One tap fires 3 rockets in a row · 1 hit sinks a boat' },
  mines:   { name: 'Sea Mines',      ammo: 3,  weight: 15, tier: 2, aim: 'back',  how: 'One tap drops 3 mines BEHIND you · each lasts 10 s' },
  torpedo: { name: 'Homing Torpedo', ammo: 1,  weight: 12, tier: 2, aim: 'front', how: 'One tap fires it · chases the boat in front of you' },
  shield:  { name: 'Shield',         ammo: 1,  weight: 8,  tier: 2, aim: 'none',  how: 'One tap: 6 seconds where nothing can sink you' },
  nitro:   { name: 'Turbo Ram',      ammo: 1,  weight: 6,  tier: 3, aim: 'none',  how: 'One tap: speed burst · crash into boats to sink them' },
  wave:    { name: 'Shockwave',      ammo: 1,  weight: 4,  tier: 4, aim: 'area',  how: 'One tap sinks every boat inside the circle' },
};
export const WEAPON_KEYS = Object.keys(WEAPONS);
// seconds between automatic shots after the one tap
export const BURST_INTERVAL = { gun: 0.11, rockets: 0.4, mines: 0.45 };

export const TIERS = {
  1: { name: 'Common',    color: '#d6e4ee' },
  2: { name: 'Rare',      color: '#3da5ff' },
  3: { name: 'Epic',      color: '#c06bff' },
  4: { name: 'Legendary', color: '#ffb703' },
};

// Aim assist: shots fired within this cone of a boat are steered onto it.
export const AIM = { cone: 0.24, range: 85 };

export const WEAPON_STATS = {
  rocketSpeed: 62, rocketLife: 2.2, rocketSplash: 4.5,
  torpedoSpeed: 33, torpedoLife: 6.5, torpedoTurn: 1.9,
  bulletSpeed: 105, bulletLife: 0.78, bulletDamage: 13,
  mineArm: 0.7, mineRadius: 3.4, mineLife: 10, maxMines: 14,
  shieldDuration: 6, nitroDuration: 3.2, waveDelay: 1.0, waveRadius: 30,
};

export const PHYS = {
  accel: 19, brake: 34, reverseAccel: 11, maxSpeed: 21, boostSpeed: 36, reverseMax: 7,
  coastDrag: 0.9, turnRate: 2.1, grip: 2.8, driftGrip: 1.2, radius: 2.0, gravity: 34,
};

// --- map layout -----------------------------------------------------------

const deg = (d) => (d * Math.PI) / 180;
const polar = (r, a) => ({ x: Math.sin(deg(a)) * r, z: Math.cos(deg(a)) * r });

// Solid islands and rocks: x, z, radius, kind. They block boats and shots.
export const ISLANDS = [
  { ...polar(0, 0), r: 18, kind: 'fort' },
  ...[45, 135, 225, 315].map((a, i) => ({ ...polar(80, a), r: 11, kind: i % 2 ? 'palms' : 'camp' })),
  ...[0, 90, 180, 270].map((a) => ({ ...polar(124, a), r: 6, kind: 'rocks' })),
  { ...polar(138, 128), r: 7, kind: 'wreck' },
  { ...polar(136, 310), r: 5.5, kind: 'rocks' },
  // tall sea stacks: cover you can hide behind
  ...[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((a) => ({ ...polar(102, a), r: 4.5, kind: 'stack' })),
  ...[0, 90, 180, 270].map((a) => ({ ...polar(40, a), r: 3.6, kind: 'stack' })),
];

// Stone walls: straight cover from (x1, z1) to (x2, z2).
const wall = (r, a, len) => {
  const c = polar(r, a), t = { x: Math.cos(deg(a)), z: -Math.sin(deg(a)) }; // tangent direction
  return { x1: c.x - t.x * len / 2, z1: c.z - t.z * len / 2, x2: c.x + t.x * len / 2, z2: c.z + t.z * len / 2 };
};
export const WALLS = [
  ...[0, 90, 180, 270].map((a) => wall(74, a, 20)),
  ...[30, 120, 210, 300].map((a) => wall(120, a, 18)), // between spawn lanes, so nobody spawns facing a wall
];
const WALL_THICK = 1.5;

// Everything solid as circles (walls become a chain of overlapping circles). Used for crashes, shots and line of sight.
export const SOLIDS = [
  ...ISLANDS.map((i) => ({ x: i.x, z: i.z, r: i.r, h: i.kind === 'stack' ? 40 : 6 })),
  ...WALLS.flatMap((w) => {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1), n = Math.ceil(len / 2);
    return Array.from({ length: n + 1 }, (_, i) => ({ x: w.x1 + (w.x2 - w.x1) * i / n, z: w.z1 + (w.z2 - w.z1) * i / n, r: WALL_THICK, h: 7 }));
  }),
];

/** True when nothing solid sits between the two points. */
export function losClear(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  for (const o of SOLIDS) {
    const t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / L2));
    const px = ax + dx * t - o.x, pz = az + dz * t - o.z;
    if (px * px + pz * pz < o.r * o.r) return false;
  }
  return true;
}

/** Distance along heading h from (x, z) to the first solid thing, up to max. */
export function rayDistance(x, z, h, max) {
  const fx = Math.sin(h), fz = Math.cos(h);
  let best = max;
  for (const o of SOLIDS) {
    const ox = o.x - x, oz = o.z - z;
    const along = ox * fx + oz * fz;
    if (along < 0 || along - o.r > best) continue;
    const side2 = ox * ox + oz * oz - along * along;
    if (side2 >= o.r * o.r) continue;
    best = Math.min(best, Math.max(0, along - Math.sqrt(o.r * o.r - side2)));
  }
  return best;
}

// Jump ramps: boats driving along `a` (heading) launch off the far end.
export const RAMPS = [20, 110, 200, 290].map((a) => {
  const p = polar(50, a);
  return { x: p.x, z: p.z, h: deg(a), w: 8, l: 9, height: 3.2 };
});

// Weapon pickup spots.
export const CRATE_SPOTS = [
  ...[45, 135, 225, 315].map((a) => polar(36, a)),
  ...[0, 90, 180, 270].map((a) => polar(62, a)),      // just inside the walls
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((a) => polar(100, a)),
  ...[0, 90, 180, 270].map((a) => polar(148, a)),     // between spawn points, not on them
];
export const CRATE_RESPAWN = 6;

export const SPAWNS = Array.from({ length: 12 }, (_, i) => {
  const a = i * 30 + 15;
  const p = polar(146, a);
  return { x: p.x, z: p.z, h: deg(a) + Math.PI }; // face the middle
});

// --- physics --------------------------------------------------------------

export function newBoatState(spawn) {
  return { x: spawn.x, z: spawn.z, h: spawn.h, vx: 0, vz: 0, y: 0, vy: 0, onRamp: false, air: false, boost: 0 };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Advance one boat. input: { throttle: -1..1, steer: -1..1 (positive = left) }.
 * Returns an events object ({ landed, bumped, launched }) for effects.
 */
export function stepBoat(b, input, dt) {
  const ev = {};
  const fx = Math.sin(b.h), fz = Math.cos(b.h);
  let fwd = b.vx * fx + b.vz * fz;
  let latX = b.vx - fwd * fx, latZ = b.vz - fwd * fz;
  const boosting = b.boost > 0;
  if (boosting) b.boost = Math.max(0, b.boost - dt);
  const max = boosting ? PHYS.boostSpeed : PHYS.maxSpeed;

  if (!b.air) {
    const t = input.throttle;
    if (boosting) fwd += PHYS.accel * 2.2 * dt;
    else if (t > 0) fwd += (fwd < 0 ? PHYS.brake : PHYS.accel) * t * dt;
    else if (t < 0) fwd += (fwd > 0 ? -PHYS.brake : -PHYS.reverseAccel) * -t * dt;
    else fwd *= Math.exp(-PHYS.coastDrag * dt);
    if (fwd > max) fwd = Math.max(max, fwd - 30 * dt);
    if (fwd < -PHYS.reverseMax) fwd = -PHYS.reverseMax;

    // turning: needs some speed, reversed when going backwards
    const steerAmt = clamp(Math.abs(fwd) / 7, 0, 1) * Math.sign(fwd || 1);
    const sharp = Math.abs(input.steer) > 0.5 && Math.abs(fwd) > 13;
    b.h += input.steer * PHYS.turnRate * steerAmt * dt * (boosting ? 0.8 : 1);
    const grip = sharp ? PHYS.driftGrip : PHYS.grip;
    const k = Math.exp(-grip * dt);
    latX *= k; latZ *= k;
  } else {
    b.h += input.steer * PHYS.turnRate * 0.35 * dt; // a little air control
  }

  const nfx = Math.sin(b.h), nfz = Math.cos(b.h);
  b.vx = nfx * fwd + latX;
  b.vz = nfz * fwd + latZ;
  b.x += b.vx * dt;
  b.z += b.vz * dt;

  // ramps
  let onRampNow = false;
  for (const r of RAMPS) {
    const dx = b.x - r.x, dz = b.z - r.z;
    const rx = Math.cos(r.h), rz = -Math.sin(r.h);      // ramp right axis
    const ax = Math.sin(r.h), az = Math.cos(r.h);        // ramp forward axis
    const lx = dx * rx + dz * rz;
    const lz = dx * ax + dz * az + r.l / 2;              // 0 at low end, l at lip
    if (Math.abs(lx) < r.w / 2 && lz > 0 && lz < r.l) {
      const surf = (r.height * lz) / r.l;
      const along = b.vx * ax + b.vz * az;
      if (b.y <= surf + 0.6 && along > 2) {
        b.y = surf; b.vy = 0; b.air = false; onRampNow = true;
        b._rampLaunch = (along * r.height) / r.l;
      }
    }
  }
  if (b.onRamp && !onRampNow) {
    b.air = true;
    b.vy = (b._rampLaunch || 0) * 1.25 + 5;
    ev.launched = true;
  }
  b.onRamp = onRampNow;

  if (b.air || (!onRampNow && b.y > 0)) {
    b.air = true;
    b.vy -= PHYS.gravity * dt;
    b.y += b.vy * dt;
    if (b.y <= 0) {
      ev.landed = Math.min(1, Math.abs(b.vy) / 25);
      b.y = 0; b.vy = 0; b.air = false;
    }
  }

  // islands, rocks and walls
  for (const isl of SOLIDS) {
    const dx = b.x - isl.x, dz = b.z - isl.z;
    const min = isl.r + PHYS.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && b.y < isl.h) {
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, nz = dz / d;
      b.x = isl.x + nx * min; b.z = isl.z + nz * min;
      const vn = b.vx * nx + b.vz * nz;
      if (vn < 0) { b.vx -= vn * nx * 1.4; b.vz -= vn * nz * 1.4; ev.bumped = Math.min(1, -vn / 20); }
      b.vx *= 0.85; b.vz *= 0.85;
    }
  }
  // arena edge
  const dist = Math.hypot(b.x, b.z);
  if (dist > ARENA_R) {
    const nx = b.x / dist, nz = b.z / dist;
    b.x = nx * ARENA_R; b.z = nz * ARENA_R;
    const vn = b.vx * nx + b.vz * nz;
    if (vn > 0) { b.vx -= vn * nx * 1.5; b.vz -= vn * nz * 1.5; ev.bumped = Math.min(1, vn / 20); }
  }
  return ev;
}

export function pickWeapon(rand = Math.random) {
  const entries = Object.entries(WEAPONS);
  const total = entries.reduce((s, [, w]) => s + w.weight, 0);
  let r = rand() * total;
  for (const [k, w] of entries) { if ((r -= w.weight) < 0) return k; }
  return 'gun';
}

export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Aim assist shared by server (real shots) and client (lock-on marker).
 * from: { x, z, h }; targets: [{ x, z, vx, vz, ref }]. Returns { ref, heading } or null.
 */
export function findAimTarget(from, targets, shotSpeed, cone = AIM.cone, range = AIM.range) {
  let best = null, bestScore = Infinity;
  for (const t of targets) {
    const dx = t.x - from.x, dz = t.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 1) continue;
    const a = Math.abs(angleDiff(from.h, Math.atan2(dx, dz)));
    // allow a wider cone up close so near boats are easy to hit
    if (a > cone + 2.5 / d) continue;
    if (!losClear(from.x, from.z, t.x, t.z)) continue; // hiding behind cover
    const score = a * 40 + d;
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (!best) return null;
  // lead the target: aim where it will be when the shot arrives
  const d = Math.hypot(best.x - from.x, best.z - from.z);
  const tt = d / shotSpeed;
  const px = best.x + (best.vx || 0) * tt, pz = best.z + (best.vz || 0) * tt;
  return { ref: best.ref, heading: Math.atan2(px - from.x, pz - from.z) };
}
