// HUD helpers: scoreboard, kill feed, weapon slot, minimap, results.
import { WEAPONS, TIERS, ISLANDS, WALLS, ARENA_R, RAMPS } from './shared/data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ICONS = {
  rockets: `<svg viewBox="0 0 48 48"><g fill="none" stroke-linejoin="round" stroke-width="2.5" stroke="#3a1505"><path d="M8 34 L30 12 l8-2-2 8-22 22z" fill="#ff6a3d"/><path d="M14 40l-6-6-4 8z" fill="#ffd23d"/><path d="M30 12l6 6" /></g><circle cx="31" cy="17" r="3" fill="#fff"/></svg>`,
  gun: `<svg viewBox="0 0 48 48"><g stroke="#3a2a05" stroke-width="2.5" stroke-linejoin="round"><rect x="6" y="18" width="26" height="12" rx="3" fill="#ffd23d"/><rect x="30" y="20" width="14" height="4" fill="#9aa"/><rect x="30" y="26" width="14" height="4" fill="#9aa"/><path d="M12 30l-2 10h8l2-10z" fill="#c98a00"/></g></svg>`,
  mines: `<svg viewBox="0 0 48 48"><g stroke="#2b0905" stroke-width="2.5"><ellipse cx="24" cy="27" rx="14" ry="15" fill="#c0392b"/><path d="M11 21h26M11 33h26" fill="none"/><path d="M24 12V6" /><circle cx="27" cy="5" r="3" fill="#ffd23d"/></g></svg>`,
  torpedo: `<svg viewBox="0 0 48 48"><g stroke="#05263a" stroke-width="2.5" stroke-linejoin="round"><path d="M6 24c0-5 6-7 12-7h16c6 0 10 3 10 7s-4 7-10 7H18c-6 0-12-2-12-7z" fill="#3dd5ff"/><path d="M8 17l-4-5v24l4-5" fill="#1b8ab0"/></g><circle cx="36" cy="24" r="3" fill="#fff"/></svg>`,
  shield: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="rgba(124,247,255,.35)" stroke="#7cf7ff" stroke-width="3"/><path d="M16 18a10 10 0 0 1 10-6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  nitro: `<svg viewBox="0 0 48 48"><g stroke="#2a0a45" stroke-width="2.5" stroke-linejoin="round"><path d="M26 4L10 28h12l-4 16 20-26H26z" fill="#b25bff"/></g></svg>`,
  wave: `<svg viewBox="0 0 48 48"><g fill="none" stroke-width="3.5" stroke-linecap="round"><path d="M4 30c5-6 9-6 13 0s9 6 13 0 9-6 14 0" stroke="#9ff0ff"/><path d="M4 38c5-6 9-6 13 0s9 6 13 0 9-6 14 0" stroke="#fff"/><path d="M14 20c3-8 9-12 18-12" stroke="#9ff0ff"/></g></svg>`,
  none: `<svg viewBox="0 0 48 48"><rect x="8" y="16" width="32" height="22" rx="4" fill="#8a5a2b" stroke="#3a2010" stroke-width="2.5"/><path d="M8 22h32" stroke="#3a2010" stroke-width="2.5"/><rect x="21" y="19" width="6" height="7" rx="1" fill="#ffd23d"/><text x="24" y="14" font-size="14" text-anchor="middle" fill="#ffd23d" font-family="Lilita One">?</text></svg>`,
};

export class HUD {
  constructor() {
    this.board = $('board');
    this.feed = $('feed');
    this.timer = $('timer');
    this.mm = $('minimap').getContext('2d');
    this.hintTimer = 0;
  }

  setWeapon(w, n, fresh, touch) {
    const el = $('weapon');
    el.classList.toggle('empty', !w);
    const def = w && WEAPONS[w];
    const tier = def && TIERS[def.tier];
    el.style.setProperty('--tier', tier ? tier.color : 'rgba(255,255,255,.25)');
    $('weapon-icon').innerHTML = ICONS[w || 'none'];
    $('weapon-tier').textContent = tier ? `${tier.name.toUpperCase()} ${'★'.repeat(def.tier)}` : '';
    $('weapon-name').textContent = def ? def.name : 'No weapon';
    $('weapon-how').textContent = def ? def.how : 'Follow the yellow arrow to a floating weapon';
    const ammo = $('weapon-ammo');
    if (!def || def.ammo <= 1) ammo.innerHTML = '';
    else if (def.ammo > 5) ammo.innerHTML = `<b class="bar"><b style="width:${(100 * n / def.ammo).toFixed(0)}%"></b></b><span>${n} / ${def.ammo}</span>`;
    else ammo.innerHTML = `${'<i></i>'.repeat(n)}<span>${n} left</span>`;
    $('weapon-key').textContent = touch ? 'TAP FIRE' : 'SPACE';
    if (fresh) {
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      this.pickupCard(w);
    }
  }

  pickupCard(w) {
    const def = WEAPONS[w], tier = TIERS[def.tier];
    const card = $('pickup-card');
    card.style.setProperty('--tier', tier.color);
    $('pc-icon').innerHTML = ICONS[w];
    $('pc-name').textContent = def.name.toUpperCase();
    $('pc-tier').textContent = `${tier.name.toUpperCase()}  ${'★'.repeat(def.tier)}${'☆'.repeat(4 - def.tier)}`;
    $('pc-how').textContent = def.how;
    card.classList.add('hidden'); void card.offsetWidth; card.classList.remove('hidden');
    clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => card.classList.add('hidden'), 2200);
  }

  aimStatus(text, kind = '') {
    const el = $('aim-status');
    if (el.textContent !== text) el.textContent = text;
    el.className = text ? `show ${kind}` : '';
  }

  helpWeapons() {
    $('help-weapons').innerHTML = Object.entries(WEAPONS).map(([k, d]) => {
      const t = TIERS[d.tier];
      return `<div class="hw" style="--tier:${t.color}">${ICONS[k]}<div><div class="t">${t.name.toUpperCase()} ${'★'.repeat(d.tier)}</div><div class="n">${d.name}</div><div class="d">${d.how}</div></div></div>`;
    }).join('');
  }

  hint(text, secs = 2.5) {
    const h = $('hint');
    h.textContent = text;
    h.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => h.classList.remove('show'), secs * 1000);
  }

  center(text) {
    const c = $('center-msg');
    c.textContent = text;
    c.classList.remove('show'); void c.offsetWidth; c.classList.add('show');
  }

  setTimer(sec) {
    const s = Math.max(0, Math.ceil(sec));
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.timer.classList.toggle('low', s <= 15);
  }

  renderBoard(players, meId, expanded) {
    const list = [...players].sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    this.board.classList.toggle('expanded', expanded);
    this.board.innerHTML = list.map((p, i) => `<div class="r ${p.id === meId ? 'me' : ''}"><span class="rk">${i + 1}</span><span class="n">${esc(p.name)}${p.bot ? ' <span class="bot">BOT</span>' : ''}</span>${expanded ? `<span class="rk">☠${p.deaths}</span>` : ''}<span class="s">${p.score}</span></div>`).join('');
  }

  killFeed(kName, vName, w, mine) {
    const icon = { rockets: '🚀', torpedo: '🌀', mines: '💣', gun: '🔫', nitro: '⚡', wave: '🌊' }[w] || '💥';
    const el = document.createElement('div');
    el.className = 'k' + (mine ? ' me' : '');
    el.innerHTML = kName ? `${esc(kName)}<span class="w">${icon}</span>${esc(vName)}` : `${esc(vName)}<span class="w">${icon}</span>sank`;
    this.feed.prepend(el);
    while (this.feed.children.length > 5) this.feed.lastChild.remove();
    setTimeout(() => el.remove(), 6000);
  }

  minimap(me, others, crates) {
    const g = this.mm, W = 180, c = W / 2, k = (W / 2 - 6) / ARENA_R;
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath(); g.arc(c, c, W / 2, 0, Math.PI * 2); g.clip();
    // map is drawn with the player's heading up
    g.translate(c, c);
    const h = me ? me.h : 0;
    g.rotate(h + Math.PI);
    const cx = me ? me.x : 0, cz = me ? me.z : 0;
    const tx = (x) => (x - cx) * k, tz = (z) => (z - cz) * k;
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
    g.beginPath(); g.arc(tx(0), tz(0), ARENA_R * k, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#e9cf8f';
    for (const i of ISLANDS) { g.beginPath(); g.arc(tx(i.x), tz(i.z), i.r * k, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = '#b9b3a6'; g.lineWidth = Math.max(2, 3 * k * 2); g.lineCap = 'round';
    for (const w of WALLS) { g.beginPath(); g.moveTo(tx(w.x1), tz(w.z1)); g.lineTo(tx(w.x2), tz(w.z2)); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,.6)';
    for (const r of RAMPS) { g.beginPath(); g.arc(tx(r.x), tz(r.z), 2.5, 0, Math.PI * 2); g.fill(); }
    for (const cr of crates) {
      if (!cr.on) continue;
      g.fillStyle = TIERS[cr.tier || 1].color;
      g.fillRect(tx(cr.x) - 3, tz(cr.z) - 3, 6, 6);
    }
    for (const o of others) {
      if (!o.alive) continue;
      g.fillStyle = '#ff5a2c';
      g.beginPath(); g.arc(tx(o.x), tz(o.z), 4, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    // me, always center pointing up
    g.fillStyle = '#ffcf33'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(c, c - 8); g.lineTo(c + 6, c + 6); g.lineTo(c, c + 3); g.lineTo(c - 6, c + 6); g.closePath(); g.fill(); g.stroke();
  }

  showResults(results, meId) {
    const podium = $('podium');
    const order = [1, 0, 2];
    podium.innerHTML = order.map((i) => {
      const p = results[i];
      if (!p) return '';
      return `<div class="p p${i + 1}"><div class="nm">${esc(p.name)}</div><div class="sc">${p.score} smash${p.score === 1 ? '' : 'es'}</div><div class="blk">${i + 1}</div></div>`;
    }).join('');
    $('results-list').innerHTML = results.slice(3).map((p, i) => `<div class="r ${p.id === meId ? 'me' : ''}"><span>${i + 4}</span><span class="n">${esc(p.name)}</span><span>${p.score}</span></div>`).join('');
    $('results').classList.remove('hidden');
  }
}
