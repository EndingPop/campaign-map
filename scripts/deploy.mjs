// Step-by-step deploy, in two parts. Works on Windows, macOS and Linux
// (it needs only Node.js, which the project already requires).
//
//   npm run deploy:dev    install, rules tests, rules and site to dev
//   npm run deploy:prod   back up prod, then rules and site to prod
//
// Add `-- --dry-run` (for example `npm run deploy:dev -- --dry-run`) to see
// the steps without running anything.
//
// Before each step it shows the command and waits:
//   Enter = run it    s = skip it    q = quit
// If a command fails, it stops there and nothing after it runs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!['dev', 'prod'].includes(target)) {
  console.log('Usage: npm run deploy:dev   or   npm run deploy:prod   (add -- --dry-run to only show the steps)');
  process.exit(1);
}

// Always work from the project folder (the one holding package.json).
process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1), red = paint(31), green = paint(32), yellow = paint(33);

// Your addresses, from the optional .deploy.env (see .deploy.env.example).
// Lines look like NAME="value"; anything else is ignored.
const env = { DEV_URL: 'your dev site (the workers.dev address printed by the dev deploy)', PROD_URL: 'your production site' };
if (existsSync('.deploy.env')) {
  for (const line of readFileSync('.deploy.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
}

// Answers are read line by line into a queue, so typed-ahead or piped answers
// are not lost between questions.
const rl = createInterface({ input: process.stdin });
const lines = [];
let waiting = null;
let inputClosed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { inputClosed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
const nextLine = () => (lines.length ? Promise.resolve(lines.shift()) : inputClosed ? Promise.resolve(null) : new Promise((r) => { waiting = r; }));
let stepNo = 0;

function stop(code, message) {
  if (message) console.log(message);
  rl.close();
  process.exit(code);
}

// Resolves true to go on, false to skip; quits on q.
async function ask(question) {
  for (;;) {
    process.stdout.write(`${question} [Enter = yes, s = skip, q = quit] `);
    const line = await nextLine();
    if (line === null) stop(1, '\nNo input; stopping.');
    if (!process.stdin.isTTY) console.log(line); // echo piped answers so the log reads naturally
    const answer = line.trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') return true;
    if (answer === 's' || answer === 'skip') return false;
    if (answer === 'q' || answer === 'quit') stop(0, 'Stopped. Nothing after this point was run.');
    console.log('Please press Enter, s or q.');
  }
}

// Runs `npm run <script>` (or `npm install`) as one step.
async function run(what, args) {
  stepNo += 1;
  console.log(`\n${bold(`Step ${stepNo}: ${what}`)}\n  $ npm ${args.join(' ')}`);
  if (!(await ask('Run this step?'))) { console.log(yellow('Skipped.')); return; }
  if (dryRun) { console.log('(dry run: not running it)'); return; }
  // npm is npm.cmd on Windows, which Node only starts through a shell.
  const r = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status === 0) { console.log(green(`Step ${stepNo} finished.`)); return; }
  stop(r.status || 1, `\n${red(bold(`Step ${stepNo} failed (exit code ${r.status ?? r.error?.code}). Stopping here; later steps were not run.`))}\n`
    + 'Fix the problem, then run it again. Steps that already finished can be skipped with s.');
}

// A checkpoint with no command.
async function pause(what, lines) {
  stepNo += 1;
  console.log(`\n${bold(`Step ${stepNo}: ${what}`)}`);
  for (const l of lines) console.log(`  ${l}`);
  if (!(await ask('Done, and ready to continue?'))) console.log(yellow('Continuing without confirming.'));
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`${bold(`Campaign map deploy to ${target}`)} (${version})`);
if (dryRun) console.log(yellow('Dry run: commands are shown but not run.'));

// This copy's own settings must exist; they are not in the repository.
const missing = ['public/js/site-config.js', 'wrangler.jsonc', '.firebaserc'].filter((f) => !existsSync(f));
for (const f of missing) console.log(`${red(`Missing ${f}.`)} Copy the matching .example file and fill it in (README: "Set up your copy").`);
if (missing.length) stop(1);

const { DEFAULT_MAP } = await import('../public/js/config.js');
if (DEFAULT_MAP?.imagePath && !existsSync(`public/${DEFAULT_MAP.imagePath}`)) {
  console.log(yellow(`Warning: the map image public/${DEFAULT_MAP.imagePath} named in site-config.js is not in this folder.`));
  console.log('It is not in the repository (maps are usually copyrighted); copy it in before deploying, or the deployed site will have no map.');
  if (!(await ask('Deploy anyway?'))) stop(1);
}

if (target === 'dev') {
  await run('Install or update the project\'s tools (only needed if package.json changed; skip otherwise)', ['install']);
  await run('Run the security rules tests against the local emulator', ['run', 'test:rules']);
  await run('Deploy the security rules to dev', ['run', 'deploy:rules:dev']);
  await run('Deploy the site to dev', ['run', 'deploy:site:dev']);
  console.log(`\n${green(bold('Dev steps done.'))} Open ${env.DEV_URL} in a private window, sign in, and try what changed.`);
  console.log('When it looks right, run  npm run deploy:prod');
} else {
  await pause('Back up prod', [
    `Open ${env.PROD_URL}, sign in as admin or DM, and choose Download backup (JSON) in the account menu.`,
    'Keep the file somewhere safe before continuing.',
  ]);
  await run('Deploy the security rules to prod', ['run', 'deploy:rules:prod']);
  await run('Deploy the site to prod', ['run', 'deploy:site:prod']);
  console.log(`\n${green(bold('All steps done.'))} Check ${env.PROD_URL}.`);
  console.log('If the prod site misbehaves: npx wrangler rollback --env=""  (rules: restore an earlier version in the Firebase console\'s Rules tab).');
}
stop(0);
