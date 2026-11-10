import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { BOATS, CHARACTERS } from './shared/data.js';

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const models = new Map();
const textures = new Map();

export const MODEL_LIST = [
  ...BOATS.map((b) => `boats/${b.id}`),
  ...CHARACTERS.map((c) => `chars/${c}`),
  'boats/ramp', 'boats/buoy', 'boats/buoy-flag', 'boats/cargo-pile-a', 'boats/boat-house-a',
  'pirate/palm-bend', 'pirate/palm-straight', 'pirate/palm-detailed-bend', 'pirate/palm-detailed-straight',
  'pirate/rocks-a', 'pirate/rocks-b', 'pirate/rocks-c', 'pirate/rocks-sand-a', 'pirate/rocks-sand-b', 'pirate/rocks-sand-c',
  'pirate/patch-grass', 'pirate/grass-plant', 'pirate/chest', 'pirate/crate', 'pirate/barrel', 'pirate/cannon',
  'pirate/ship-wreck', 'pirate/tower-complete-large', 'pirate/structure-platform-dock', 'pirate/structure-platform-dock-small',
  'pirate/flag-pirate-high', 'pirate/ship-pirate-large', 'pirate/ship-pirate-medium', 'pirate/castle-wall',
  'pirate/crate-bottles', 'pirate/bottle-large',
  'space/rocket_topA', 'space/rocket_fuelA', 'space/rocket_finsA',
  'blaster/blaster-p', 'blaster/grenade-a', 'blaster/grenade-b', 'chars/shield-round',
  'nature/rock_tallA', 'nature/rock_tallB', 'pirate/castle-wall', 'pirate/tower-complete-small',
];

export const TEXTURE_LIST = [
  'textures/waternormals.jpg',
  'fx/smoke_01.png', 'fx/smoke_04.png', 'fx/smoke_07.png', 'fx/fire_01.png', 'fx/fire_02.png', 'fx/flame_03.png',
  'fx/flare_01.png', 'fx/spark_04.png', 'fx/spark_05.png', 'fx/circle_05.png', 'fx/light_01.png', 'fx/muzzle_02.png',
  'fx/star_04.png', 'fx/scorch_02.png', 'fx/twirl_02.png', 'fx/whitePuff00.png', 'fx/whitePuff04.png', 'fx/explosion00.png',
  'fx/explosion03.png', 'fx/explosion06.png',
];

export async function loadAll(onProgress) {
  const total = MODEL_LIST.length + TEXTURE_LIST.length;
  let done = 0;
  const tick = () => onProgress?.(++done / total);
  await Promise.all([
    ...MODEL_LIST.map((name) => loader.loadAsync(`/models/${name}.glb`).then((g) => {
      g.scene.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          if (o.material?.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
        }
      });
      models.set(name, g);
      tick();
    }).catch((e) => { console.warn('model failed', name, e); tick(); })),
    ...TEXTURE_LIST.map((name) => texLoader.loadAsync(`/${name}`).then((t) => {
      if (!name.includes('normals')) t.colorSpace = THREE.SRGBColorSpace;
      textures.set(name, t);
      tick();
    }).catch(() => tick())),
  ]);
}

/** A fresh copy of a model. Characters keep their skeleton and animations. */
export function model(name) {
  const g = models.get(name);
  if (!g) return new THREE.Group();
  const obj = name.startsWith('chars/') ? SkeletonUtils.clone(g.scene) : g.scene.clone(true);
  obj.userData.animations = g.animations;
  return obj;
}

export function tex(name) { return textures.get(name); }

/** Flat decals lying on the water (rings, aim line). The water skips them when drawing its reflection,
 *  because a reflected decal shows up as a stray arc across the sea. */
export const noReflect = new Set();
