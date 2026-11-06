// Genera la carpeta `www/` que Capacitor copia dentro del APK.
// Solo incluye lo que la app necesita en producción.
import { cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'www');

const INCLUDE = ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'icons', 'ffmpeg'];

if (existsSync(out)) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const item of INCLUDE) {
  const src = join(root, item);
  if (!existsSync(src)) {
    console.log('  (omitido, no existe): ' + item);
    continue;
  }
  await cp(src, join(out, item), { recursive: true });
  console.log('  + ' + item);
}

async function sizeOf(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await sizeOf(p) : (await stat(p)).size;
  }
  return total;
}

const mb = ((await sizeOf(out)) / 1048576).toFixed(1);
console.log(`www listo: ${mb} MB`);
