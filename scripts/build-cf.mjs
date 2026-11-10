// Collects the files Cloudflare serves into dist/: the public/ folder plus the parts of three.js the game imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const THREE = path.join(ROOT, 'node_modules', 'three');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });

// copy three.js entry files and every addon the client imports, following their relative imports
const queue = ['build/three.module.js'];
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'js'), { recursive: true })) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', f), 'utf8');
  for (const m of src.matchAll(/from\s+'three\/addons\/([^']+)'/g)) queue.push(`examples/jsm/${m[1]}`);
}
const seen = new Set();
while (queue.length) {
  const rel = path.normalize(queue.pop());
  if (seen.has(rel)) continue;
  seen.add(rel);
  const src = fs.readFileSync(path.join(THREE, rel), 'utf8');
  const dest = path.join(OUT, 'vendor', 'three', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, src);
  for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) queue.push(path.join(path.dirname(rel), m[1]));
}
console.log(`dist/ ready: public files + ${seen.size} three.js files`);
