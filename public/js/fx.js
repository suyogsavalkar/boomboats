// Particle effects (wakes, spray, explosions, smoke) using Kenney particle sprites.
import * as THREE from 'three';
import { tex } from './assets.js';

const VERT = `
attribute float size; attribute float alpha; attribute vec3 color; attribute float rot;
varying float vA; varying vec3 vC; varying float vR;
uniform float scale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = size * scale / max(0.1, -mv.z);
  vA = alpha; vC = color; vR = rot;
}`;
const FRAG = `
uniform sampler2D map; uniform float alphaOnly; varying float vA; varying vec3 vC; varying float vR;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vR), s = sin(vR);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
  vec4 t = texture2D(map, uv);
  float a = t.a * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vC * mix(t.rgb, vec3(1.0), alphaOnly), a);
}`;

class ParticleSystem {
  constructor(scene, texture, max, additive, alphaOnly = false) {
    this.max = max;
    this.count = 0;
    this.p = []; // particle objects
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.rot = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, scale: { value: 600 }, alphaOnly: { value: alphaOnly ? 1 : 0 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }

  emit(o) {
    if (this.p.length >= this.max) this.p.shift();
    this.p.push({
      x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      life: o.life || 1, age: 0, s0: o.size || 1, s1: o.endSize ?? o.size ?? 1,
      a0: o.alpha ?? 1, c: o.color || [1, 1, 1], c1: o.endColor, g: o.gravity || 0, drag: o.drag || 0,
      r: o.rot ?? Math.random() * 6.28, vr: o.spin || 0, floor: o.floor,
    });
  }

  update(dt) {
    const arr = this.p;
    let n = 0;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      q.age += dt;
      if (q.age >= q.life) continue;
      q.vy -= q.g * dt;
      if (q.drag) { const k = Math.exp(-q.drag * dt); q.vx *= k; q.vy *= k; q.vz *= k; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      if (q.floor !== undefined && q.y < q.floor) { q.y = q.floor; q.vy = 0; }
      q.r += q.vr * dt;
      const t = q.age / q.life;
      arr[n++] = q;
      const j = n - 1;
      this.pos[j * 3] = q.x; this.pos[j * 3 + 1] = q.y; this.pos[j * 3 + 2] = q.z;
      this.size[j] = q.s0 + (q.s1 - q.s0) * t;
      this.alpha[j] = q.a0 * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      const c = q.c1 ? [q.c[0] + (q.c1[0] - q.c[0]) * t, q.c[1] + (q.c1[1] - q.c[1]) * t, q.c[2] + (q.c1[2] - q.c[2]) * t] : q.c;
      this.color[j * 3] = c[0]; this.color[j * 3 + 1] = c[1]; this.color[j * 3 + 2] = c[2];
      this.rot[j] = q.r;
    }
    arr.length = n;
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'size', 'alpha', 'color', 'rot']) this.geo.attributes[k].needsUpdate = true;
  }
}

const rand = (a, b) => a + Math.random() * (b - a);

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.foam = new ParticleSystem(scene, tex('fx/smoke_04.png'), 2500, false, true);
    this.smoke = new ParticleSystem(scene, tex('fx/smoke_04.png'), 1200, false, true);
    this.fire = new ParticleSystem(scene, tex('fx/explosion03.png'), 800, true);
    this.flash = new ParticleSystem(scene, tex('fx/light_01.png'), 200, true);
    this.spark = new ParticleSystem(scene, tex('fx/spark_05.png'), 800, true);
    this.star = new ParticleSystem(scene, tex('fx/star_04.png'), 300, true);
    this.systems = [this.foam, this.smoke, this.fire, this.flash, this.spark, this.star];
    this.rings = [];
    // fixed pool so the light count never changes (avoids shader recompiles)
    this.lights = Array.from({ length: 4 }, () => {
      const l = new THREE.PointLight(0xffffff, 0, 45, 1.6);
      scene.add(l);
      return { l, life: 1, age: 1, i0: 0 };
    });
    this.nextLight = 0;
    this.ringTex = tex('fx/circle_05.png');
    this.shake = 0;
  }

  setScale(px) { for (const s of this.systems) s.mat.uniforms.scale.value = px; }

  wake(x, z, h, speed, boost) {
    const bx = x - Math.sin(h) * 2.2, bz = z - Math.cos(h) * 2.2;
    const sideX = Math.cos(h), sideZ = -Math.sin(h);
    const k = Math.min(1, speed / 30);
    if (speed > 8 && Math.random() < 0.5) {
      // churned water right behind the motor
      this.foam.emit({ x: bx + rand(-0.4, 0.4), y: 0.35, z: bz + rand(-0.4, 0.4), vx: -Math.sin(h) * 3, vy: rand(1, 2.5) * k, vz: -Math.cos(h) * 3,
        size: 0.9, endSize: 1.8, life: 0.5, alpha: 0.55, gravity: 8, floor: 0.15 });
    }
    if (speed > 14) {
      const sgn = Math.random() < 0.5 ? -1 : 1;
      this.foam.emit({ x: x + sideX * sgn * 1.1 + Math.sin(h) * 0.8, y: 0.3, z: z + sideZ * sgn * 1.1 + Math.cos(h) * 0.8,
        vx: sideX * sgn * rand(2.5, 5), vy: rand(2, 4) * k, vz: sideZ * sgn * rand(2.5, 5),
        size: 0.45, endSize: 1.1, life: 0.55, alpha: 0.6, gravity: 12, floor: 0.1 });
    }
    if (boost) {
      this.fire.emit({ x: bx, y: 0.9, z: bz, vx: -Math.sin(h) * 6, vy: 1, vz: -Math.cos(h) * 6, size: 1.6, endSize: 0.4,
        life: 0.35, color: [0.75, 0.4, 1], endColor: [0.3, 0.2, 1] });
    }
  }

  splash(x, z, power = 1) {
    for (let i = 0; i < 14 * power; i++) {
      const a = Math.random() * 6.28, s = rand(2, 6) * power;
      this.foam.emit({ x, y: 0.2, z, vx: Math.cos(a) * s, vy: rand(4, 9) * power, vz: Math.sin(a) * s,
        size: rand(0.8, 1.5) * power, endSize: 2.5 * power, life: rand(0.6, 1.1), alpha: 0.85, gravity: 16, floor: 0.1 });
    }
    this.ring(x, z, 1, 6 * power, 0.8, 0.5);
  }

  ring(x, z, r0, r1, life, alpha = 0.6, color = 0xffffff) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: this.ringTex, transparent: true, depthWrite: false, color, opacity: alpha }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.12, z);
    m.renderOrder = 1;
    this.scene.add(m);
    this.rings.push({ m, r0, r1, life, age: 0, alpha });
  }

  light(x, y, z, color, intensity, life) {
    const s = this.lights[this.nextLight++ % this.lights.length];
    s.l.color.set(color);
    s.l.position.set(x, y, z);
    s.life = life; s.age = 0; s.i0 = intensity;
  }

  explosion(x, y, z, big = 1, onWater = true) {
    this.flash.emit({ x, y: y + 1, z, size: 22 * big, endSize: 30 * big, life: 0.25, color: [1, 0.85, 0.6] });
    for (let i = 0; i < 18 * big; i++) {
      const a = Math.random() * 6.28, e = rand(0.2, 1.2), s = rand(3, 11) * big;
      this.fire.emit({ x, y: y + 1, z, vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s + 2, vz: Math.sin(a) * Math.cos(e) * s,
        size: rand(3, 6) * big, endSize: rand(1, 2), life: rand(0.4, 0.8), color: [1, 0.85, 0.5], endColor: [1, 0.3, 0.05], drag: 2.5, spin: rand(-2, 2) });
    }
    for (let i = 0; i < 14 * big; i++) {
      const a = Math.random() * 6.28, s = rand(1, 4) * big;
      this.smoke.emit({ x: x + rand(-1, 1), y: y + 1.5, z: z + rand(-1, 1), vx: Math.cos(a) * s, vy: rand(3, 7), vz: Math.sin(a) * s,
        size: rand(4, 6) * big, endSize: rand(9, 14) * big, life: rand(1.6, 2.8), alpha: 0.75, color: [0.22, 0.2, 0.2], endColor: [0.5, 0.5, 0.52], drag: 1.2, spin: rand(-0.6, 0.6) });
    }
    for (let i = 0; i < 26 * big; i++) {
      const a = Math.random() * 6.28, s = rand(8, 22);
      this.spark.emit({ x, y: y + 1, z, vx: Math.cos(a) * s, vy: rand(4, 16), vz: Math.sin(a) * s,
        size: rand(0.5, 1.1), endSize: 0.1, life: rand(0.5, 1.1), color: [1, 0.75, 0.3], gravity: 22 });
    }
    if (onWater) {
      for (let i = 0; i < 22 * big; i++) {
        const a = Math.random() * 6.28, s = rand(1, 5) * big;
        this.foam.emit({ x, y: 0.4, z, vx: Math.cos(a) * s, vy: rand(8, 18) * big, vz: Math.sin(a) * s,
          size: rand(1.4, 2.6) * big, endSize: 4 * big, life: rand(0.9, 1.5), alpha: 0.9, gravity: 20, floor: 0.1 });
      }
      this.ring(x, z, 2, 14 * big, 1.2, 0.7);
    }
    this.light(x, y + 3, z, 0xff8a3a, 60 * big, 0.5);
  }

  wave(x, z, radius) {
    this.ring(x, z, 2, radius, 1.1, 0.9, 0x9ff0ff);
    this.ring(x, z, 1, radius * 0.7, 1.3, 0.7);
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * 6.28, s = radius * 1.1;
      this.foam.emit({ x: x + Math.cos(a) * 3, y: 0.5, z: z + Math.sin(a) * 3, vx: Math.cos(a) * s, vy: rand(6, 12), vz: Math.sin(a) * s,
        size: 2.5, endSize: 6, life: 1.1, alpha: 0.9, gravity: 14, floor: 0.2, drag: 0.6 });
    }
    this.light(x, 4, z, 0x8ff7ff, 80, 0.7);
  }

  sparkle(x, y, z, color = [1, 0.85, 0.3], n = 18) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, s = rand(2, 7);
      this.star.emit({ x, y, z, vx: Math.cos(a) * s, vy: rand(3, 9), vz: Math.sin(a) * s, size: rand(1, 2), endSize: 0.2,
        life: rand(0.5, 0.9), color, gravity: 10, spin: rand(-4, 4) });
    }
  }

  muzzle(x, y, z, color = [1, 0.8, 0.4], size = 2.5) {
    this.flash.emit({ x, y, z, size, endSize: size * 0.3, life: 0.08, color });
  }

  trail(x, y, z, kind) {
    if (kind === 'rocket') {
      this.fire.emit({ x, y, z, size: 1.4, endSize: 0.3, life: 0.18, color: [1, 0.8, 0.4], endColor: [1, 0.3, 0.1] });
      this.smoke.emit({ x, y, z, vy: 0.6, size: 1, endSize: 3.2, life: 0.9, alpha: 0.5, color: [0.85, 0.85, 0.85], spin: 1 });
    } else if (kind === 'torpedo') {
      this.foam.emit({ x: x + rand(-0.2, 0.2), y: 0.15, z: z + rand(-0.2, 0.2), size: 0.9, endSize: 2.4, life: 1.2, alpha: 0.8 });
    }
  }

  update(dt) {
    for (const s of this.systems) s.update(dt);
    this.rings = this.rings.filter((r) => {
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) { this.scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); return false; }
      const e = 1 - (1 - t) * (1 - t);
      const s = r.r0 + (r.r1 - r.r0) * e;
      r.m.scale.set(s, s, 1);
      r.m.material.opacity = r.alpha * (1 - t);
      return true;
    });
    for (const s of this.lights) {
      s.age += dt;
      s.l.intensity = s.age >= s.life ? 0 : s.i0 * (1 - s.age / s.life);
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }
}
