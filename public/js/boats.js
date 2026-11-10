// Visual objects: boats with drivers, projectiles, mines and power chests.
import * as THREE from 'three';
import { model, tex, noReflect } from './assets.js';
import { MAX_HP } from './shared/data.js';

export const BOAT_SCALE = 1.3;

// Find a seat for the driver: the lowest deck point in the back half of the hull.
const seatCache = new Map();
function seatFor(boatId) {
  if (seatCache.has(boatId)) return seatCache.get(boatId);
  const hull = model(`boats/${boatId}`);
  hull.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  let best = { y: 1.2, z: -0.5 };
  for (let z = -1.0; z <= -0.15; z += 0.05) {
    rc.set(new THREE.Vector3(0, 5, z), new THREE.Vector3(0, -1, 0));
    const hit = rc.intersectObject(hull, true)[0];
    if (!hit) continue;
    const y = Math.max(0.62, hit.point.y);
    if (y < best.y - 0.01) best = { y, z };
  }
  seatCache.set(boatId, best);
  return best;
}

// --- foam trail ribbon drawn on the water behind each boat
const WAKE_LIFE = 2.6;
const WAKE_MAX = 56;
const WAKE_VERT = `attribute vec2 wa; varying vec2 vA; varying vec2 vW;
void main(){ vA = wa; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const WAKE_FRAG = `uniform sampler2D noise; uniform float time; varying vec2 vA; varying vec2 vW;
void main(){
  float across = abs(vA.x); float age = vA.y; float str = vA.y < 0.0 ? 0.0 : 1.0;
  float edge = smoothstep(0.45, 0.9, across) * (1.0 - smoothstep(0.9, 1.0, across));
  float core = (1.0 - smoothstep(0.0, 0.5, across)) * (1.0 - smoothstep(0.0, 0.45, age));
  float n = texture2D(noise, vW * 0.07 + vec2(time * 0.01, 0.0)).g;
  float n2 = texture2D(noise, vW * 0.21 - vec2(0.0, time * 0.02)).r;
  float foam = smoothstep(0.35, 0.75, n * 0.6 + n2 * 0.6);
  float a = (edge * 1.0 + core * 0.95) * pow(1.0 - clamp(age, 0.0, 1.0), 1.2) * (0.5 + 0.7 * foam);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.97, 1.0, 1.0), a * str);
}`;
let wakeMat = null;
export function wakeMaterial() {
  if (!wakeMat) {
    wakeMat = new THREE.ShaderMaterial({
      uniforms: { noise: { value: tex('textures/waternormals.jpg') }, time: { value: 0 } },
      vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
  }
  return wakeMat;
}

class WakeTrail {
  constructor(scene) {
    this.scene = scene;
    this.pts = [];
    this.pos = new Float32Array(WAKE_MAX * 2 * 3);
    this.wa = new Float32Array(WAKE_MAX * 2 * 2);
    const idx = [];
    for (let i = 0; i < WAKE_MAX - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('wa', new THREE.BufferAttribute(this.wa, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, wakeMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.addT = 0;
  }

  update(dt, t, x, z, h, speed, active) {
    this.addT += dt;
    const st = Math.min(1, speed / 22);
    if (active && speed > 2 && this.addT > 0.05) {
      this.addT = 0;
      this.pts.unshift({ x: x - Math.sin(h) * 1.9, z: z - Math.cos(h) * 1.9, h, t, s: st });
      if (this.pts.length > WAKE_MAX - 1) this.pts.pop();
    }
    while (this.pts.length && t - this.pts[this.pts.length - 1].t > WAKE_LIFE) this.pts.pop();
    const list = active && speed > 2 ? [{ x: x - Math.sin(h) * 1.9, z: z - Math.cos(h) * 1.9, h, t, s: st }, ...this.pts] : this.pts;
    const n = Math.min(WAKE_MAX, list.length);
    for (let i = 0; i < WAKE_MAX; i++) {
      const p = list[Math.min(i, n - 1)];
      const o = i * 6, w = i * 4;
      if (!p || i >= n || n < 2) { this.wa[w + 1] = this.wa[w + 3] = -1; continue; }
      const age = (t - p.t) / WAKE_LIFE;
      const width = (0.9 + age * 6.5) * (0.4 + 0.6 * p.s);
      const sx = Math.cos(p.h) * width, sz = -Math.sin(p.h) * width;
      this.pos[o] = p.x + sx; this.pos[o + 1] = 0.09; this.pos[o + 2] = p.z + sz;
      this.pos[o + 3] = p.x - sx; this.pos[o + 4] = 0.09; this.pos[o + 5] = p.z - sz;
      const a = Math.min(0.999, age + (1 - p.s) * 0.5);
      this.wa[w] = -1; this.wa[w + 1] = a; this.wa[w + 2] = 1; this.wa[w + 3] = a;
    }
    this.geo.setDrawRange(0, Math.max(0, (n - 1) * 6));
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.wa.needsUpdate = true;
  }

  clear() { this.pts = []; }
  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); }
}

const SHIELD_VERT = `varying vec3 vN; varying vec3 vV;
void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const SHIELD_FRAG = `uniform float time; uniform vec3 color; varying vec3 vN; varying vec3 vV;
void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.2); float band = 0.5 + 0.5 * sin(time * 6.0 + vN.y * 12.0);
  gl_FragColor = vec4(color, clamp(f * 0.9 + band * 0.08, 0.0, 1.0)); }`;

function makeTag(name, isBot) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, transparent: true }));
  sp.material.map.colorSpace = THREE.SRGBColorSpace;
  sp.scale.set(5.6, 1.575, 1);
  sp.renderOrder = 10;
  const draw = (hp) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 72);
    g.font = '900 30px Nunito, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.fillStyle = '#fff';
    g.strokeText(name, 128, 32); g.fillText(name, 128, 32);
    if (hp < MAX_HP) {
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(48, 46, 160, 14);
      g.fillStyle = hp > 50 ? '#49e07a' : hp > 25 ? '#ffcf33' : '#ff5a2c';
      g.fillRect(50, 48, 156 * Math.max(0, hp) / MAX_HP, 10);
    }
    sp.material.map.needsUpdate = true;
  };
  draw(MAX_HP);
  void isBot;
  return { sp, draw };
}

export class BoatView {
  constructor(scene, fx, info, isMe) {
    this.scene = scene; this.fx = fx; this.info = info; this.isMe = isMe;
    this.root = new THREE.Group();
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);
    this.hull = model(`boats/${info.boat}`);
    this.hull.scale.setScalar(BOAT_SCALE);
    this.tilt.add(this.hull);

    this.driver = model(`chars/${info.char}`);
    this.driver.scale.setScalar(1.75);
    const seat = seatFor(info.boat);
    this.driver.position.set(0, (seat.y - 0.12) * BOAT_SCALE, seat.z * BOAT_SCALE);
    this.wakeTrail = new WakeTrail(scene);
    this.tilt.add(this.driver);
    this.mixer = new THREE.AnimationMixer(this.driver);
    const clips = this.driver.userData.animations || [];
    this.actions = {};
    for (const name of ['drive', 'die', 'emote-yes', 'idle']) {
      const clip = THREE.AnimationClip.findByName(clips, name);
      if (clip) this.actions[name] = this.mixer.clipAction(clip);
    }
    this.play('drive');

    const shieldMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0x7cf7ff) } },
      vertexShader: SHIELD_VERT, fragmentShader: SHIELD_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(3.4, 32, 20), shieldMat);
    this.shield.position.y = 1;
    this.shield.visible = false;
    this.root.add(this.shield);

    // charge ring for the Boom Wave
    this.charge = new THREE.Mesh(new THREE.RingGeometry(3.6, 4.2, 48),
      new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.charge.rotation.x = -Math.PI / 2; this.charge.position.y = 0.3; this.charge.visible = false;
    this.root.add(this.charge);
    noReflect.add(this.charge);
    noReflect.add(this.wakeTrail.mesh);

    if (!isMe) {
      this.tag = makeTag(info.name, info.bot);
      this.tag.sp.position.y = 4.4;
      this.root.add(this.tag.sp);
    }
    this.hp = MAX_HP;
    this.phase = Math.random() * 10;
    this.wakeT = 0;
    this.lastH = 0;
    this.roll = 0; this.pitch = 0;
    this.alive = true;
    this.sinkT = 0;
    this.flags = 0;
    scene.add(this.root);
  }

  play(name, once = false) {
    const a = this.actions[name];
    if (!a || this.current === a) return;
    a.reset();
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    a.fadeIn(0.15).play();
    this.current?.fadeOut(0.15);
    this.current = a;
  }

  setHp(hp) {
    if (hp === this.hp) return;
    this.hp = hp;
    this.tag?.draw(hp);
  }

  setPlaying(on) { this.wakeTrail.mesh.visible = on; }

  /** Show the weapon this boat is carrying, mounted on the bow. */
  setWeapon(w) {
    w = w || null;
    if (w === this.weapon) return;
    this.weapon = w;
    if (this.mount) { this.tilt.remove(this.mount); this.mount = null; }
    if (!w) return;
    const g = new THREE.Group();
    if (w === 'gun') {
      // twin guns, big enough to read from behind
      for (const x of [-0.5, 0.5]) { const m = weaponModel('gun'); m.scale.setScalar(0.8); m.position.x = x; g.add(m); }
    } else {
      const m = weaponModel(w);
      m.scale.setScalar(w === 'shield' || w === 'wave' || w === 'nitro' ? 0.5 : 0.65);
      g.add(m);
    }
    g.position.set(0, 1.95, 1.5);
    this.tilt.add(g);
    this.mount = g;
  }

  kill() {
    if (!this.alive) return;
    this.alive = false;
    this.sinkT = 0;
    this.shield.visible = false;
    this.charge.visible = false;
    this.setWeapon(null);
    this.play('die', true);
    if (this.tag) this.tag.sp.visible = false;
  }

  respawn(x, z, h) {
    this.alive = true;
    this.wakeTrail.clear();
    this.root.visible = true;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = h;
    this.tilt.rotation.set(0, 0, 0);
    this.tilt.position.set(0, 0, 0);
    this.hp = -1; this.setHp(MAX_HP);
    if (this.tag) this.tag.sp.visible = true;
    this.play('drive');
    this.fx.sparkle(x, 2, z, [0.6, 1, 1], 24);
  }

  /** s: {x, y, z, h, speed}; flags: bitmask from the server. */
  update(dt, t, s, flags, camPos) {
    this.mixer.update(dt);
    if (s) this.wakeTrail.update(dt, t, s.x, s.z, s.h, s.speed, this.alive && s.y < 0.3);
    if (!this.alive) {
      this.sinkT += dt;
      this.tilt.rotation.z = Math.min(1.1, this.sinkT * 0.9);
      this.tilt.rotation.x = Math.min(0.6, this.sinkT * 0.4);
      this.tilt.position.y = -this.sinkT * 1.4;
      if (this.sinkT < 1.5 && Math.random() < 0.5) {
        const p = this.root.position;
        this.fx.smoke.emit({ x: p.x, y: p.y + 1.5, z: p.z, vy: 3, size: 3, endSize: 7, life: 2, alpha: 0.7, color: [0.12, 0.12, 0.12], endColor: [0.4, 0.4, 0.4] });
        this.fx.fire.emit({ x: p.x + (Math.random() - 0.5) * 2, y: p.y + 1, z: p.z, vy: 3, size: 2.2, endSize: 0.5, life: 0.4, color: [1, 0.7, 0.3], endColor: [1, 0.2, 0] });
      }
      if (this.sinkT > 2.4) this.root.visible = false;
      return;
    }
    this.flags = flags;
    const p = this.root.position;
    const bob = s.y > 0.05 ? 0 : Math.sin(t * 2.3 + this.phase) * 0.08 + Math.sin(t * 3.7 + this.phase) * 0.04;
    p.set(s.x, s.y + bob, s.z);
    this.root.rotation.y = s.h;

    let dh = s.h - this.lastH;
    if (dh > Math.PI) dh -= Math.PI * 2; if (dh < -Math.PI) dh += Math.PI * 2;
    this.lastH = s.h;
    const turn = dt > 0 ? dh / dt : 0;
    const k = 1 - Math.exp(-6 * dt);
    const airborne = s.y > 0.3;
    const targetPitch = airborne ? -0.15 : -Math.min(0.12, s.speed * 0.004) + Math.sin(t * 2.1 + this.phase) * 0.025;
    this.pitch += (targetPitch - this.pitch) * k;
    this.roll += (Math.max(-0.35, Math.min(0.35, -turn * s.speed * 0.006)) + Math.sin(t * 1.7 + this.phase) * 0.03 - this.roll) * k;
    this.tilt.rotation.set(this.pitch, 0, this.roll);

    const shielded = !!(flags & 2);
    this.shield.visible = shielded;
    if (shielded) {
      this.shield.material.uniforms.time.value = t;
      // gold = spawn protection, cyan = Shield weapon
      this.shield.material.uniforms.color.value.set(flags & 32 ? 0xffd75e : 0x7cf7ff);
    }
    if (this.mount) this.mount.position.y = 1.95 + Math.sin(t * 3 + this.phase) * 0.06;
    this.charge.visible = !!(flags & 16);
    if (this.charge.visible) { const sc = 1 + ((t * 3) % 1) * 2; this.charge.scale.setScalar(sc); this.charge.material.opacity = 1 - (sc - 1) / 2; }

    // wake
    if (!airborne && s.speed > 1.5) {
      this.wakeT += dt;
      const rate = 1 / (14 + s.speed);
      while (this.wakeT > rate) { this.wakeT -= rate; this.fx.wake(s.x, s.z, s.h, s.speed, !!(flags & 4)); }
    } else if (flags & 4) this.fx.wake(s.x, s.z, s.h, 0, true);

    if (this.tag && camPos) {
      const d = camPos.distanceTo(p);
      this.tag.sp.material.opacity = d > 110 ? 0 : d > 80 ? (110 - d) / 30 : 1;
      const sc = Math.min(2.2, Math.max(0.75, d / 30));
      this.tag.sp.scale.set(4.2 * sc, 1.18 * sc, 1);
    }
  }

  dispose() {
    this.scene.remove(this.root);
    noReflect.delete(this.charge);
    noReflect.delete(this.wakeTrail.mesh);
    this.wakeTrail.dispose();
    this.mixer.stopAllAction();
  }
}

// ---------------------------------------------------------------- projectiles
let rocketProto = null;
function rocketModel() {
  if (!rocketProto) {
    rocketProto = new THREE.Group();
    let y = 0;
    for (const [name, h] of [['space/rocket_finsA', 0.7], ['space/rocket_fuelA', 0.5], ['space/rocket_topA', 0.8]]) {
      const part = model(name);
      const box = new THREE.Box3().setFromObject(part);
      const c = box.getCenter(new THREE.Vector3());
      part.position.set(-c.x, y - box.min.y, -c.z);
      rocketProto.add(part);
      y += h;
    }
    rocketProto.rotation.x = Math.PI / 2; // nose along +z
    rocketProto.position.z = -1;
  }
  const g = new THREE.Group();
  g.add(rocketProto.clone(true));
  return g;
}

export class ProjectileView {
  constructor(scene, fx, type) {
    this.scene = scene; this.fx = fx; this.type = type;
    if (type === 2) {
      this.obj = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 2.6), new THREE.MeshBasicMaterial({ color: 0xffe28a }));
    } else {
      this.obj = rocketModel();
      this.obj.scale.setScalar(type === 1 ? 1.1 : 0.85);
      if (type === 1) this.obj.children[0].children.forEach((c) => c.traverse((m) => { if (m.isMesh) { m.material = m.material.clone(); m.material.color.multiplyScalar(0.55); } }));
    }
    scene.add(this.obj);
    this.trailT = 0;
  }

  update(dt, x, y, z, vx, vz) {
    this.obj.position.set(x, y, z);
    this.obj.rotation.y = Math.atan2(vx, vz);
    if (this.type === 0) this.obj.children[0].rotation.z += dt * 12;
    if (this.type !== 2) {
      this.trailT += dt;
      while (this.trailT > 0.016) { this.trailT -= 0.016; this.fx.trail(x - Math.sin(this.obj.rotation.y) * 1.2, y, z - Math.cos(this.obj.rotation.y) * 1.2, this.type === 0 ? 'rocket' : 'torpedo'); }
    }
  }

  dispose() { this.scene.remove(this.obj); }
}

// ---------------------------------------------------------------- mines
export class MineView {
  /** own: dropped by this player (shown green, harmless to them). life: seconds until it vanishes. */
  constructor(scene, x, z, own = false, life = 10) {
    this.scene = scene; this.x = x; this.z = z; this.own = own;
    this.obj = new THREE.Group();
    const keg = model('pirate/barrel');
    keg.traverse((m) => { if (m.isMesh) { m.material = m.material.clone(); m.material.color.set(own ? 0x4fe07a : 0xff6650); } });
    keg.scale.setScalar(1.25);
    keg.position.y = -0.5;
    this.obj.add(keg);
    this.light = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex('fx/light_01.png'), color: own ? 0x2bff6a : 0xff2a10, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.light.scale.setScalar(3);
    this.light.position.y = 1.4;
    this.obj.add(this.light);
    this.obj.position.set(x, 0, z);
    this.phase = Math.random() * 6;
    this.endsAt = performance.now() / 1000 + (life || 10);
    scene.add(this.obj);
  }
  update(t) {
    const left = this.endsAt - performance.now() / 1000;
    this.obj.position.y = Math.sin(t * 2 + this.phase) * 0.12;
    this.obj.rotation.z = Math.sin(t * 1.4 + this.phase) * 0.1;
    // blinks faster in its last 2.5 seconds, then shrinks away
    const rate = left < 2.5 ? 8 : 2.5;
    this.light.material.opacity = (t * rate + this.phase) % 1 < 0.5 ? 1 : 0.15;
    this.obj.scale.setScalar(left < 0.4 ? Math.max(0.05, left / 0.4) : 1);
  }
  dispose() { this.scene.remove(this.obj); }
}

// ---------------------------------------------------------------- weapon pickups
// Each pickup shows the real weapon you will get, with a beam and label in its power-tier colour.

const BEAM_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const BEAM_FRAG = `uniform vec3 color; uniform float time; varying vec2 vUv;
void main(){ float a = pow(1.0 - vUv.y, 1.6) * (0.55 + 0.25 * sin(time * 3.0 + vUv.y * 8.0));
  gl_FragColor = vec4(color, a * 0.3); }`;

// clear bubble around a pickup: see-through in the middle, tier-coloured at the edge
const BUBBLE_FRAG = `uniform vec3 color; uniform float time; varying vec3 vN; varying vec3 vV;
void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0);
  float shimmer = 0.85 + 0.15 * sin(time * 2.0 + vN.y * 6.0);
  gl_FragColor = vec4(mix(vec3(1.0), color, 0.75), f * 0.65 * shimmer); }`;

function fitModel(obj, size) {
  const box = new THREE.Box3().setFromObject(obj);
  const dim = box.getSize(new THREE.Vector3());
  const k = size / Math.max(dim.x, dim.y, dim.z);
  obj.scale.multiplyScalar(k);
  const c = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
  obj.position.sub(c);
  const g = new THREE.Group();
  g.add(obj);
  return g;
}

function tinted(obj, color, amount = 1) {
  obj.traverse((m) => {
    if (m.isMesh) {
      m.material = m.material.clone();
      m.material.color.lerp(new THREE.Color(color), amount);
    }
  });
  return obj;
}

/** The 3D model shown for each weapon, roughly 2.6 units across. */
export function weaponModel(w) {
  switch (w) {
    case 'rockets': {
      const g = new THREE.Group();
      for (let i = -1; i <= 1; i++) {
        const r = rocketModel();
        r.scale.setScalar(0.75);
        r.position.set(i * 0.75, 0, -Math.abs(i) * 0.4);
        r.rotation.y = i * 0.12;
        g.add(r);
      }
      return fitModel(g, 2.8);
    }
    case 'gun': return fitModel(model('blaster/blaster-p'), 3.0);
    case 'mines': return fitModel(tinted(model('pirate/barrel'), 0xff6650), 2.0);
    case 'torpedo': {
      const r = rocketModel();
      r.children[0].traverse((m) => { if (m.isMesh) { m.material = m.material.clone(); m.material.color.multiplyScalar(0.55); } });
      return fitModel(r, 3.0);
    }
    case 'shield': {
      const g = new THREE.Group();
      g.add(fitModel(model('chars/shield-round'), 1.7));
      const bubble = new THREE.Mesh(new THREE.SphereGeometry(1.35, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0x7cf7ff, transparent: true, opacity: 0.22, depthWrite: false }));
      g.add(bubble);
      return g;
    }
    case 'nitro': return fitModel(tinted(model('blaster/grenade-a'), 0xb25bff, 0.6), 2.2);
    case 'wave': return fitModel(model('blaster/grenade-b'), 2.4);
  }
  return new THREE.Group();
}

// icon images for labels (SVG -> image, loaded once)
const iconImages = {};
export function iconImage(w, svg) {
  if (!iconImages[w]) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" '));
    iconImages[w] = img;
  }
  return iconImages[w];
}

function pickupLabel() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true }));
  sp.scale.set(7, 1.75, 1);
  sp.renderOrder = 9;
  const draw = (w, weapon, tier, svg) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(8,28,48,0.78)';
    g.beginPath(); g.roundRect(8, 10, 496, 108, 26); g.fill();
    g.strokeStyle = tier.color; g.lineWidth = 6;
    g.beginPath(); g.roundRect(8, 10, 496, 108, 26); g.stroke();
    const img = iconImage(w, svg);
    const paint = () => { g.drawImage(img, 22, 20, 88, 88); texture.needsUpdate = true; };
    if (img.complete && img.naturalWidth) paint(); else img.addEventListener('load', paint, { once: true });
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    g.font = '400 46px "Lilita One", sans-serif';
    g.fillText(weapon.name, 124, 66);
    g.fillStyle = tier.color;
    g.font = '900 26px Nunito, sans-serif';
    g.fillText(`${tier.name.toUpperCase()}  ${'★'.repeat(weapon.tier)}${'☆'.repeat(4 - weapon.tier)}`, 126, 100);
    texture.needsUpdate = true;
  };
  return { sp, draw };
}

export class PickupView {
  constructor(scene, x, z, deps) {
    this.scene = scene;
    this.deps = deps; // { WEAPONS, TIERS, ICONS }
    this.x = x; this.z = z;
    this.obj = new THREE.Group();
    this.obj.position.set(x, 0, z);
    this.spin = new THREE.Group();
    this.spin.position.y = 2;
    this.obj.add(this.spin);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, time: { value: 0 } },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // thin, faint beam that starts above the bubble: spots the pickup from far away without covering the weapon
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, 12, 12, 1, true), this.beamMat);
    beam.position.y = 4.6 + 6;
    this.obj.add(beam);
    // bubble around the weapon
    this.bubbleMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, time: { value: 0 } },
      vertexShader: SHIELD_VERT, fragmentShader: BUBBLE_FRAG, transparent: true, depthWrite: false,
    });
    this.bubble = new THREE.Mesh(new THREE.SphereGeometry(2.1, 32, 20), this.bubbleMat);
    this.bubble.renderOrder = 3;
    this.obj.add(this.bubble);
    // steady circle on the water, plus a soft ripple
    this.circle = new THREE.Mesh(new THREE.RingGeometry(2.55, 2.95, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    this.circle.rotation.x = -Math.PI / 2;
    this.circle.position.y = 0.16;
    this.obj.add(this.circle);
    noReflect.add(this.circle);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.85, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.15;
    this.obj.add(this.ring);
    noReflect.add(this.ring);
    this.label = pickupLabel();
    this.label.sp.position.y = 5.2;
    this.obj.add(this.label.sp);
    this.phase = Math.random() * 6;
    this.on = true;
    this.pop = 1;
    this.w = null;
    scene.add(this.obj);
  }

  set(on, w) {
    if (w && w !== this.w) {
      this.w = w;
      const { WEAPONS, TIERS, ICONS } = this.deps;
      const weapon = WEAPONS[w], tier = TIERS[weapon.tier];
      this.spin.clear();
      this.spin.add(weaponModel(w));
      const col = new THREE.Color(tier.color);
      this.beamMat.uniforms.color.value.copy(col);
      this.ring.material.color.copy(col);
      this.circle.material.color.copy(col);
      this.bubbleMat.uniforms.color.value.copy(col);
      this.label.draw(w, weapon, tier, ICONS[w]);
      this.tier = weapon.tier;
    }
    if (on && !this.on) this.pop = 0;
    this.on = on;
    this.obj.visible = on;
  }

  update(dt, t, camPos) {
    if (!this.on) return;
    this.pop = Math.min(1, this.pop + dt * 2.5);
    const s = 1 - Math.pow(1 - this.pop, 3) + Math.sin(this.pop * Math.PI) * 0.25;
    this.obj.scale.setScalar(s);
    this.spin.position.y = 2.1 + Math.sin(t * 2 + this.phase) * 0.35;
    this.spin.rotation.y = t * 1.4 + this.phase;
    this.spin.rotation.z = Math.sin(t * 1.1 + this.phase) * 0.15;
    this.beamMat.uniforms.time.value = t;
    this.bubbleMat.uniforms.time.value = t;
    this.bubble.position.y = this.spin.position.y;
    const pulse = (t * 0.6 + this.phase) % 1;
    this.ring.scale.setScalar(1 + pulse * 0.45);
    this.ring.material.opacity = 0.45 * (1 - pulse);
    if (camPos) {
      const d = camPos.distanceTo(this.obj.position);
      const k = Math.min(2.2, Math.max(0.5, d / 42));
      this.label.sp.scale.set(7 * k, 1.75 * k, 1);
      this.label.sp.position.y = 4.4 + k * 0.8;
      // fade out when far away, and when you are right on top of it
      this.label.sp.material.opacity = d > 140 ? 0 : d > 100 ? (140 - d) / 40 : d < 14 ? Math.max(0, (d - 8) / 6) : 1;
    }
  }
}
