// Aiming help for the local player: aim line, lock-on marker, blast radius, and the bearing to the nearest weapon.
import * as THREE from 'three';
import { noReflect } from './assets.js';
import { WEAPONS, WEAPON_STATS, TIERS, findAimTarget, rayDistance } from './shared/data.js';

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 16; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(8, 92); g.lineTo(32, 52); g.lineTo(56, 92); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(26, 0, 12, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  return t;
}

function reticleSprite() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 24; g.lineCap = 'round';
  const L0 = 60, m0 = 30, M0 = 226;
  for (const [x, y, dx, dy] of [[m0, m0, 1, 1], [M0, m0, -1, 1], [m0, M0, 1, -1], [M0, M0, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + dy * L0); g.lineTo(x, y); g.lineTo(x + dx * L0, y); g.stroke();
  }
  g.strokeStyle = '#ff3b2f'; g.lineWidth = 14;
  const L = 60, m = 30, M = 226;
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [M, m, -1, 1], [m, M, 1, -1], [M, M, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + dy * L); g.lineTo(x, y); g.lineTo(x + dx * L, y); g.stroke();
  }
  g.fillStyle = '#ff3b2f';
  g.beginPath(); g.arc(128, 128, 10, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false, fog: false }));
  sp.renderOrder = 20;
  return sp;
}

export class AimHelper {
  constructor(scene) {
    this.scene = scene;
    // aim line on the water
    this.lineTex = chevronTexture();
    this.lineMat = new THREE.MeshBasicMaterial({ map: this.lineTex, transparent: true, opacity: 0.9, depthWrite: false, color: 0xffffff, fog: false });
    this.line = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.lineMat);
    this.line.rotation.x = -Math.PI / 2;
    this.line.renderOrder = 2;
    this.lineGroup = new THREE.Group();
    this.lineGroup.add(this.line);
    scene.add(this.lineGroup);
    // lock-on marker
    this.reticle = reticleSprite();
    scene.add(this.reticle);
    // blast radius for the Boom Wave
    const R = WEAPON_STATS.waveRadius;
    this.area = new THREE.Mesh(new THREE.RingGeometry(R - 1.8, R, 96),
      new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }));
    this.area.rotation.x = -Math.PI / 2;
    this.areaFill = new THREE.Mesh(new THREE.CircleGeometry(R, 96),
      new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.12, depthWrite: false, fog: false }));
    this.areaFill.rotation.x = -Math.PI / 2;
    scene.add(this.area, this.areaFill);
    noReflect.add(this.lineGroup); noReflect.add(this.area); noReflect.add(this.areaFill);
    this.lockRef = null;
    this.hideAll();
  }

  hideAll() {
    this.lineGroup.visible = false;
    this.reticle.visible = false;
    this.area.visible = this.areaFill.visible = false;
  }

  /**
   * me: { s, alive, weapon }; enemies: [{ x, z, vx, vz, ref }]; pickups: PickupView[].
   * Returns info for the HUD: { lock, inRange }.
   */
  update(dt, t, me, enemies, pickups) {
    this.hideAll();
    this.lockRef = null;
    if (!me || !me.alive) return {};
    const s = me.s;
    const w = me.weapon;
    const out = {};

    if (!w) {
      // guide arrow to the nearest pickup (prefers ones ahead of you)
      let best = null, bd = Infinity;
      for (const p of pickups) {
        if (!p.on) continue;
        const d = Math.hypot(p.x - s.x, p.z - s.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best && bd > 9) {
        let bearing = Math.atan2(best.x - s.x, best.z - s.z) - s.h;
        while (bearing > Math.PI) bearing -= Math.PI * 2;
        while (bearing < -Math.PI) bearing += Math.PI * 2;
        out.guide = { bearing, dist: bd, w: best.w };
      }
      return out;
    }

    const def = WEAPONS[w];
    const color = new THREE.Color(TIERS[def.tier].color);
    if (def.aim === 'front' || def.aim === 'back') {
      const len = def.aim === 'back' ? 9 : w === 'gun' ? 70 : 75;
      const dir = def.aim === 'back' ? -1 : 1;
      const speed = w === 'gun' ? WEAPON_STATS.bulletSpeed : w === 'torpedo' ? WEAPON_STATS.torpedoSpeed : WEAPON_STATS.rocketSpeed;
      let heading = s.h;
      let lineLen = len;
      if (def.aim === 'front') {
        const aim = w === 'torpedo'
          ? findAimTarget(s, enemies, speed, 0.9, 120)
          : findAimTarget(s, enemies, speed);
        if (aim) {
          this.lockRef = aim.ref;
          out.lock = aim.ref;
          if (w !== 'torpedo') heading = aim.heading;
          this.reticle.visible = true;
          const tp = aim.ref.pos;
          const pulse = 1 + Math.sin(t * 10) * 0.08;
          this.reticle.position.set(tp.x, (tp.y || 0) + 1.2, tp.z);
          this.reticle.scale.setScalar(0.2 * pulse);
          this.reticle.material.rotation = Math.sin(t * 3) * 0.15;
          if (w !== 'torpedo') lineLen = Math.min(len, Math.hypot(tp.x - s.x, tp.z - s.z) - 2.5);
        }
      }
      // the line stops where a rock or wall would block the shot
      if (dir > 0) lineLen = Math.min(lineLen, rayDistance(s.x, s.z, heading, lineLen + 2.5) - 2.5);
      this.lineGroup.visible = true;
      this.lineGroup.position.set(s.x, 0.14, s.z);
      this.lineGroup.rotation.y = dir > 0 ? heading : s.h + Math.PI;
      lineLen = Math.max(4, lineLen);
      this.line.scale.set(2.4, lineLen, 1);
      this.line.position.set(0, 0, 2.5 + lineLen / 2);
      this.lineTex.repeat.set(1, lineLen / 3.5);
      this.lineTex.offset.y = -t * 1.5;
      this.lineMat.color.copy(out.lock ? new THREE.Color(0xff4a3a) : color);
      this.lineMat.opacity = out.lock ? 0.95 : 0.7;
    } else if (def.aim === 'area') {
      this.area.visible = this.areaFill.visible = true;
      this.area.position.set(s.x, 0.15, s.z);
      this.areaFill.position.set(s.x, 0.13, s.z);
      const R = WEAPON_STATS.waveRadius;
      out.inRange = enemies.filter((e) => Math.hypot(e.x - s.x, e.z - s.z) < R).length;
      this.area.material.opacity = 0.7 + Math.sin(t * 6) * 0.25;
      this.area.material.color.set(out.inRange ? 0xff5a2c : 0x9ff0ff);
      this.areaFill.material.color.set(out.inRange ? 0xff5a2c : 0x9ff0ff);
    }
    return out;
  }
}
