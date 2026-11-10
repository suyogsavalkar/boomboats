import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1920, height: 1080 } });
const pg = await b.newPage();
const base = 'file://' + new URL('./cards.html', import.meta.url).pathname;
const W = { rockets: ['TRIPLE ROCKETS', 'Common', '#d6e4ee'], gun: ['DECK GUN', 'Common', '#d6e4ee'], mines: ['POWDER KEGS', 'Rare', '#3da5ff'], torpedo: ['HOMING TORPEDO', 'Rare', '#3da5ff'], shield: ['BUBBLE SHIELD', 'Rare', '#3da5ff'], nitro: ['RAM NITRO', 'Epic', '#c06bff'], wave: ['BOOM WAVE', 'Legendary', '#ffb703'] };
const jobs = ['logo', 'c_throttle', 'c_loot', 'c_smash', 'c_players', 'c_boats', 'end'].map((id) => [id, `?id=${id}`]);
for (const [k, [n, t, c]] of Object.entries(W)) jobs.push([`w_${k}`, `?id=w&name=${encodeURIComponent(n)}&tier=${t}&color=${encodeURIComponent(c)}`]);
for (const [name, q] of jobs) {
  await pg.goto(base + q, { waitUntil: 'networkidle0' });
  await pg.evaluate(() => document.fonts.ready);
  await pg.screenshot({ path: `cards/${name}.png`, omitBackground: true });
}
await b.close();
console.log('cards:', jobs.length);
