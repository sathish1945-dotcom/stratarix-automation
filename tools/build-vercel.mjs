/**
 * Build step for Vercel.
 *
 * The project keeps its static files at the repository root so that the GitHub
 * Pages preview and the local Node server continue to work from the same source.
 * Vercel serves from a single output directory, so this script copies the static
 * assets (and nothing else) into `dist/`.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

const FILES = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'favicon.svg', 'offline.html', 'robots.txt'];
const DIRECTORIES = ['js', 'icons'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of FILES) {
  const source = join(root, file);
  if (!existsSync(source)) continue;
  cpSync(source, join(out, file));
}

for (const directory of DIRECTORIES) {
  const source = join(root, directory);
  if (!existsSync(source)) continue;
  cpSync(source, join(out, directory), { recursive: true });
}

// The service worker must never be cached by the CDN, otherwise clients keep an
// old copy forever. Vercel reads headers from vercel.json; this marker file keeps
// the intention documented next to the build step.
console.log(`Built static output in ${out}`);
