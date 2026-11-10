// Builds the lagoon: sky, water, islands and props.
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { model, tex, noReflect } from './assets.js';
import { ISLANDS, WALLS, RAMPS, ARENA_R } from './shared/data.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SAND = new THREE.Color('#f3dca4');
const WET = new THREE.Color('#c7a56c');
const GRASS = new THREE.Color('#71b84a');
const GRASS2 = new THREE.Color('#5aa23c');
const ROCK = new THREE.Color('#9a9188');

function smooth(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

/** A low-poly sand island whose waterline sits at radius r. */
function mound(r, height, grassy, seed, rocky = false) {
  const rand = rng(seed);
  const rings = 9, segs = Math.max(20, Math.round(r * 3));
  const R = r + 5;
  const shore = r + 0.3;
  const ph = [rand() * 6, rand() * 6, rand() * 6];
  const verts = [], colors = [], idx = [];
  const radiusAt = (rho, a) => rho * (1 + 0.07 * Math.sin(3 * a + ph[0]) + 0.04 * Math.sin(7 * a + ph[1]));
  for (let i = 0; i <= rings; i++) {
    const rho = (i / rings) ** 0.85 * R;
    for (let j = 0; j < (i === 0 ? 1 : segs); j++) {
      const a = (j / segs) * Math.PI * 2;
      const rr = i === 0 ? 0 : radiusAt(rho, a);
      let y;
      if (rho <= r * 0.45) y = height;
      else if (rho <= shore) y = height * (1 - smooth((rho - r * 0.45) / (shore - r * 0.45))) + 0.05;
      else y = -2.2 * smooth((rho - shore) / (R - shore));
      if (i > 0 && i < rings) y += (rand() - 0.5) * 0.35 * (y > 0.4 ? 1 : 0.3);
      verts.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
      let c = y < 0.45 ? WET : SAND;
      if (grassy && y > height * 0.6) c = rand() > 0.5 ? GRASS : GRASS2;
      if (rocky && y > height * 0.4) c = ROCK;
      colors.push(c.r, c.g, c.b);
    }
  }
  // center fan
  for (let j = 0; j < segs; j++) idx.push(0, 1 + j, 1 + ((j + 1) % segs));
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segs, b0 = 1 + i * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(idx);
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}

const FOAM_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const FOAM_FRAG = `
uniform float time; uniform float inner; uniform float outer; varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float d = length(p) * outer;
  float t = (d - inner) / (outer - inner);
  float a = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.15, 1.0, t));
  float w = 0.55 + 0.45 * sin(time * 1.8 - d * 2.2 + atan(p.y, p.x) * 3.0);
  gl_FragColor = vec4(1.0, 1.0, 1.0, a * (0.35 + 0.5 * w));
}`;

export function buildWorld(scene, renderer) {
  const world = { buoys: [], foams: [], update: null };

  // --- sky & lighting ------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.turbidity.value = 2.2;
  u.rayleigh.value = 2.2;
  u.mieCoefficient.value = 0.003;
  u.mieDirectionalG.value = 0.85;
  const sun = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(90 - 38);
  const theta = THREE.MathUtils.degToRad(215);
  sun.setFromSphericalCoords(1, phi, theta);
  u.sunPosition.value.copy(sun);
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  const sky2 = sky.clone(); skyScene.add(sky2);
  scene.environment = pmrem.fromScene(skyScene).texture;
  scene.environmentIntensity = 0.7;

  scene.fog = new THREE.Fog(0xcfe6f2, 380, 1600);

  const hemi = new THREE.HemisphereLight(0xcfe9ff, 0x3b6f7f, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff1d6, 2.6);
  dir.position.copy(sun).multiplyScalar(120);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  const sc = dir.shadow.camera;
  sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 400;
  dir.shadow.bias = -0.0005;
  dir.shadow.normalBias = 0.04;
  scene.add(dir);
  scene.add(dir.target);
  world.sun = dir;
  world.sunDir = sun.clone();

  // --- water --------------------------------------------------------------
  const normals = tex('textures/waternormals.jpg');
  normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
  const water = new Water(new THREE.PlaneGeometry(4000, 4000), {
    textureWidth: 1024, textureHeight: 1024, waterNormals: normals,
    sunDirection: sun.clone(), sunColor: 0xfff4e0, waterColor: 0x0f8f9e, distortionScale: 2.2, fog: true,
  });
  // tropical look: less mirror-like, more turquoise body colour
  water.material.fragmentShader = water.material.fragmentShader
    .replace('float rf0 = 0.3;', 'float rf0 = 0.08;')
    .replace('vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * waterColor;',
      'vec3 scatter = ( 0.55 + 0.45 * max( 0.0, dot( surfaceNormal, eyeDirection ) ) ) * waterColor;')
    .replace('( vec3( 0.1 ) + reflectionSample * 0.9 + reflectionSample * specularLight )',
      '( waterColor * 0.35 + reflectionSample * 0.75 + reflectionSample * specularLight )');
  water.material.needsUpdate = true;
  water.rotation.x = -Math.PI / 2;
  water.material.uniforms.size.value = 6;
  scene.add(water);
  // hide water-level decals while the water renders its mirror image
  const mirrorPass = water.onBeforeRender;
  water.onBeforeRender = function (...args) {
    const hidden = [];
    for (const o of noReflect) if (o.visible) { o.visible = false; hidden.push(o); }
    mirrorPass.apply(this, args);
    for (const o of hidden) o.visible = true;
  };
  world.water = water;

  // --- islands ------------------------------------------------------------
  const put = (name, x, y, z, s = 1, ry = 0) => {
    const o = model(name);
    o.position.set(x, y, z);
    o.scale.setScalar(s);
    o.rotation.y = ry;
    scene.add(o);
    return o;
  };
  const addFoam = (x, z, r) => {
    const outer = r + 3.2;
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, inner: { value: r - 0.2 }, outer: { value: outer } },
      vertexShader: FOAM_VERT, fragmentShader: FOAM_FRAG, transparent: true, depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(outer * 2, outer * 2), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.08, z);
    m.renderOrder = 1;
    scene.add(m);
    noReflect.add(m);
    world.foams.push(mat);
  };
  const palms = ['pirate/palm-detailed-bend', 'pirate/palm-detailed-straight', 'pirate/palm-bend', 'pirate/palm-straight'];

  ISLANDS.forEach((isl, n) => {
    const rand = rng(1000 + n * 77);
    const { x, z, r } = isl;
    if (isl.kind === 'stack') {
      // tall sea stack: cover that blocks shots
      const m = mound(r * 1.1, 0.5, false, 70 + n, true);
      m.position.set(x, 0, z); scene.add(m);
      const tall = model(rand() < 0.5 ? 'nature/rock_tallA' : 'nature/rock_tallB');
      tall.scale.set(r * 2.2, r * 2.6 + rand() * 4, r * 2.4);
      tall.position.set(x, -0.4, z);
      tall.rotation.y = rand() * 6;
      scene.add(tall);
      put('pirate/rocks-c', x + r * 0.7, -0.3, z + r * 0.5, r / 3.5, rand() * 6);
      addFoam(x, z, r);
      return;
    }
    if (isl.kind === 'rocks') {
      const m = mound(r * 0.8, 0.6, false, 50 + n, true);
      m.position.set(x, 0, z); scene.add(m);
      put('pirate/rocks-a', x, -0.3, z, r / 2.3, rand() * 6);
      put('pirate/rocks-c', x + r * 0.5, -0.2, z - r * 0.3, r / 4, rand() * 6);
      put('pirate/rocks-b', x - r * 0.5, -0.2, z + r * 0.4, r / 4.5, rand() * 6);
      addFoam(x, z, r);
      return;
    }
    if (isl.kind === 'wreck') {
      const m = mound(r * 0.7, 0.4, false, 90 + n, true);
      m.position.set(x, 0, z); scene.add(m);
      put('pirate/ship-wreck', x, -0.6, z, 1.25, rand() * 6);
      addFoam(x, z, r);
      return;
    }
    const height = isl.kind === 'fort' ? 2.6 : 1.8;
    const m = mound(r, height, true, 10 + n);
    m.position.set(x, 0, z);
    scene.add(m);
    addFoam(x, z, r);
    const top = height - 0.15;
    if (isl.kind === 'fort') {
      put('pirate/tower-complete-large', x, top - 0.1, z, 1.35, 0.4);
      put('pirate/flag-pirate-high', x + 3.6, top, z - 2.6, 1.6, 1);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        put('pirate/cannon', x + Math.sin(a) * 7.5, top - 0.1, z + Math.cos(a) * 7.5, 1.7, a);
      }
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.75;
        put(palms[i % 4], x + Math.sin(a) * 11.5, 0.9, z + Math.cos(a) * 11.5, 1.6 + rand() * 0.5, rand() * 6);
      }
      put('pirate/barrel', x - 4, top, z + 3.5, 1.2);
      put('pirate/crate', x - 4.8, top, z + 2, 1.4, 0.3);
      put('pirate/crate-bottles', x + 4.5, top, z + 4, 1.3, 1.2);
    } else {
      const count = isl.kind === 'palms' ? 6 : 3;
      for (let i = 0; i < count; i++) {
        const a = rand() * Math.PI * 2, d = rand() * r * 0.55;
        put(palms[i % 4], x + Math.sin(a) * d, top, z + Math.cos(a) * d, 1.5 + rand() * 0.6, rand() * 6);
      }
      put('pirate/rocks-sand-a', x + r * 0.55, 0, z - r * 0.4, 1.4, rand() * 6);
      put('pirate/grass-plant', x - r * 0.3, top, z + r * 0.2, 2);
      if (isl.kind === 'camp') {
        put('pirate/chest', x + 1, top, z - 1.5, 1.6, rand() * 6);
        put('pirate/barrel', x - 2, top, z + 2.5, 1.2);
        put('pirate/crate', x - 3, top, z + 1, 1.3, 0.5);
        // a small dock pointing toward the arena middle
        const a = Math.atan2(-x, -z);
        for (let k = 0; k < 3; k++) {
          const d = r - 1 + k * 2.4;
          put('pirate/structure-platform-dock-small', x + Math.sin(a) * d, -0.2, z + Math.cos(a) * d, 1.2, a);
        }
      } else {
        put('pirate/rocks-sand-b', x - r * 0.6, 0, z - r * 0.3, 1.3, rand() * 6);
      }
    }
  });

  // --- stone walls: cover in the open water ----------------------------------
  WALLS.forEach((w) => {
    const dx = w.x2 - w.x1, dz = w.z2 - w.z1, len = Math.hypot(dx, dz);
    const ry = Math.atan2(-dz, dx); // the wall model runs along its local x axis
    const n = Math.round(len / 2.8);
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      const piece = put('pirate/castle-wall', w.x1 + dx * k, -0.6, w.z1 + dz * k, 1, ry);
      piece.scale.set(len / n / 2, 1.5, 1.05);
    }
    for (const [x, z] of [[w.x1, w.z1], [w.x2, w.z2]]) {
      put('pirate/tower-complete-small', x, -0.6, z, 1.15, ry);
      addFoam(x, z, 2.4);
    }
    const mx = (w.x1 + w.x2) / 2, mz = (w.z1 + w.z2) / 2;
    const base = mound(len / 2 + 1, 0.35, false, 500 + Math.round(mx + mz), true);
    base.scale.z = 3 / (len + 2);
    base.position.set(mx, -0.05, mz);
    base.rotation.y = ry;
    scene.add(base);
  });

  // --- outer ring of islands enclosing the lagoon --------------------------
  const ringRand = rng(4242);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + ringRand() * 0.1;
    const d = 212 + ringRand() * 26;
    const r = 13 + ringRand() * 12;
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    const m = mound(r, 2 + ringRand() * 4, true, 300 + i);
    m.position.set(x, 0, z); scene.add(m);
    addFoam(x, z, r);
    const n = 3 + Math.floor(ringRand() * 5);
    for (let k = 0; k < n; k++) {
      const pa = ringRand() * Math.PI * 2, pd = ringRand() * r * 0.6;
      put(palms[k % 4], x + Math.sin(pa) * pd, 1.5, z + Math.cos(pa) * pd, 1.8 + ringRand() * 0.9, ringRand() * 6);
    }
    if (ringRand() > 0.5) put('pirate/rocks-a', x + r * 0.7, -0.3, z, 1.5 + ringRand(), ringRand() * 6);
  }
  // far horizon islands
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.2;
    const d = 520 + ringRand() * 260;
    const r = 40 + ringRand() * 50;
    const m = mound(r, 10 + ringRand() * 22, true, 900 + i);
    m.position.set(Math.sin(a) * d, 0, Math.cos(a) * d); m.castShadow = false;
    scene.add(m);
  }
  // anchored pirate ships just outside the arena
  put('pirate/ship-pirate-large', Math.sin(1.2) * 194, -0.4, Math.cos(1.2) * 194, 2.2, 2.6);
  put('pirate/ship-pirate-medium', Math.sin(4.0) * 191, -0.4, Math.cos(4.0) * 191, 2.2, 0.9);
  put('boats/boat-house-a', Math.sin(2.6) * 189, 0, Math.cos(2.6) * 189, 3, 1.5);

  // --- buoys marking the arena edge ---------------------------------------
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const b = put(i % 2 ? 'boats/buoy' : 'boats/buoy-flag', Math.sin(a) * (ARENA_R + 4), 0, Math.cos(a) * (ARENA_R + 4), 2.2, a);
    world.buoys.push({ o: b, ph: i * 1.7 });
  }

  // --- jump ramps -----------------------------------------------------------
  for (const r of RAMPS) {
    const o = model('boats/ramp');
    o.scale.set(r.w / 2.72, r.height / 1.14, r.l / 2.8);
    o.position.set(r.x, -0.05, r.z);
    o.rotation.y = r.h;
    scene.add(o);
    addFoam(r.x, r.z, 4.5);
  }

  world.update = (t) => {
    water.material.uniforms.time.value = t * 0.6;
    for (const f of world.foams) f.uniforms.time.value = t;
    for (const b of world.buoys) {
      b.o.position.y = Math.sin(t * 1.6 + b.ph) * 0.18 - 0.1;
      b.o.rotation.z = Math.sin(t * 1.3 + b.ph) * 0.08;
    }
  };
  return world;
}
