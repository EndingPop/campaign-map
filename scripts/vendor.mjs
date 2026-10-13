// Rebuilds public/vendor/ from node_modules. Run after changing the
// firebase or leaflet versions in package.json: `npm install && npm run vendor`.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('public/vendor/leaflet/images', { recursive: true });
await build({
  entryPoints: ['vendor-src/firebase-entry.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  outfile: 'public/vendor/firebase.js',
  legalComments: 'linked',
});
cpSync('node_modules/leaflet/dist/leaflet.js', 'public/vendor/leaflet/leaflet.js');
cpSync('node_modules/leaflet/dist/leaflet.css', 'public/vendor/leaflet/leaflet.css');
cpSync('node_modules/leaflet/dist/images', 'public/vendor/leaflet/images', { recursive: true });
cpSync('node_modules/leaflet/LICENSE', 'public/vendor/leaflet/LICENSE');
console.log('Vendored firebase and leaflet into public/vendor/');
