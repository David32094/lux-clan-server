import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.site');

const files = [
  'index.html',
  'LUX_CLAN_EDITOR_BY.DAVID.XIT.html',
  'LUX_CLAN_EDITOR.html',
  'manifest.webmanifest',
  'sw.js',
  'mobile-touch-fix.js',
  'supabase-client-config.js',
  'prototipo-lider.js',
  'prototipo-clan-hub.js',
  'prototipo-accesos.js',
  'prototipo-placas.js',
  'prototipo-placas-ocr.js',
  'prototipo-supabase.js',
  'lux-simple-ui.css',
  'fluxo-theme.css',
  'lux-match-ocr.js',
  'lux-platform-v3.js',
  'lux-platform-v3.css',
  'vendor/qrcode.js',
  'INTEGRANTES/base.png',
  'ENFRETAMIENTOS/base.png',
  'ENFRETAMIENTOS/OVERLAY POR ENCIMA DE LA FOTO DEL RESULTADO.png',
  'ICONOS/ChatGPT Image 7 ago 2026, 05_48_09 a.m..png',
  'ICONOS/FLUXO_LOGO.png'
];

await rm(output, { recursive:true, force:true });
for (const relative of files) {
  const source = join(root, relative);
  const destination = join(output, relative);
  await mkdir(dirname(destination), { recursive:true });
  await cp(source, destination);
}

async function totalBytes(directory) {
  let total = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await stat(path);
    total += info.isDirectory() ? await totalBytes(path) : info.size;
  }
  return total;
}

const bytes = await totalBytes(output);
console.log(`Sitio preparado: ${(bytes / 1024 / 1024).toFixed(2)} MB en ${output}`);
