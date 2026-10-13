// Run before every push to a public repository: `npm run check:public`.
//
// Lists the files git would publish (tracked files plus new files that are not
// ignored) and fails if any of them
//   - is one of this copy's private files (site config, wrangler.jsonc, ...),
//   - is a map image other than the example, or a backup file,
//   - contains a value taken from the private files (domain, Firebase project
//     ids and keys, Worker name, deploy URLs), or a real-looking email address.
// The values to look for are read from your private files at run time, so this
// script itself contains none of them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
process.chdir(root);

let files;
try {
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
} catch {
  console.log('This folder is not a git repository yet (run `git init` first).');
  process.exit(2);
}

const problems = [];
// Files already staged or committed are published even if .gitignore lists them.
const staged = new Set(execFileSync('git', ['ls-files', '--cached'], { encoding: 'utf8' }).split('\n').filter(Boolean));
const fix = (f) => (staged.has(f) ? `; it is already staged, so .gitignore does not apply: run  git rm --cached "${f}"` : ' (check .gitignore)');

// 1. Files that must never be published.
// Matched by ending, so a stray nested copy of the project is caught too.
const PRIVATE_FILES = ['public/js/site-config.js', 'wrangler.jsonc', '.firebaserc', '.deploy.env'];
const isPrivate = (f) => PRIVATE_FILES.some((p) => f === p || f.endsWith(`/${p}`));
for (const f of files) {
  if (isPrivate(f)) problems.push(`${f}: private settings file would be published${fix(f)}`);
  if (/(^|\/)public\/map\//.test(f) && f !== 'public/map/example-map.png') problems.push(`${f}: map image would be published${fix(f)}`);
  if (/backup|before-restore/i.test(f) && f.endsWith('.json')) problems.push(`${f}: looks like a data backup${fix(f)}`);
  if (/\.(zip|tar|tgz|gz|7z|rar)$/i.test(f)) problems.push(`${f}: archive would be published (it may contain private files); move it out of the project folder`);
  if (f.split('/').length > 1 && f.split('/')[0] !== '.github' && f.endsWith('/package.json')) problems.push(`${f}: looks like a second copy of the project inside this folder; move it out`);
}

// 2. Values that identify this copy, read from the private files.
const secrets = new Map(); // value -> where it came from
const add = (value, from) => { if (typeof value === 'string' && value.length >= 6 && !/REPLACE_ME|example\.com/.test(value)) secrets.set(value, from); };

if (existsSync('public/js/site-config.js')) {
  const site = await import(new URL('../public/js/site-config.js', import.meta.url));
  add(site.PROD_HOST, 'site-config.js PROD_HOST');
  for (const [envName, cfg] of Object.entries(site.FIREBASE_CONFIGS || {})) {
    for (const [k, v] of Object.entries(cfg)) add(v, `site-config.js FIREBASE_CONFIGS.${envName}.${k}`);
  }
}
if (existsSync('wrangler.jsonc')) {
  const text = readFileSync('wrangler.jsonc', 'utf8');
  for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) add(m[1], 'wrangler.jsonc name');
  for (const m of text.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)) add(m[1], 'wrangler.jsonc route');
}
if (existsSync('.firebaserc')) {
  const rc = JSON.parse(readFileSync('.firebaserc', 'utf8'));
  for (const [alias, id] of Object.entries(rc.projects || {})) if (!id.startsWith('demo-')) add(id, `.firebaserc ${alias}`);
}
if (existsSync('.deploy.env')) {
  for (const m of readFileSync('.deploy.env', 'utf8').matchAll(/https?:\/\/([^\s"/]+)/g)) add(m[1], '.deploy.env URL');
}
// A Worker name like "campaign-map" also appears in ordinary text; only flag it as part of an address.
const workerNames = [...secrets].filter(([, from]) => from === 'wrangler.jsonc name').map(([v]) => v);
for (const n of workerNames) { secrets.delete(n); add(`${n}-dev.`, 'wrangler.jsonc name (dev address)'); }

// 3. Scan the text files that would be published.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip)$/i;
for (const f of files) {
  if (BINARY.test(f) || f.startsWith('public/vendor/') || f === 'package-lock.json' || !existsSync(f) || !statSync(f).isFile()) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [value, from] of secrets) {
      if (line.includes(value)) problems.push(`${f}:${i + 1}: contains a value from ${from}`);
    }
    for (const m of line.matchAll(EMAIL)) {
      if (!EMAIL_OK.test(m[0])) problems.push(`${f}:${i + 1}: email address ${m[0]}`);
    }
  });
}

if (problems.length) {
  // Printed to standard output so `npm run check:public > file.txt` captures it.
  console.log(`Not safe to publish. ${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`OK: ${files.length} files checked; none contains this copy's private settings or a real email address.`);
