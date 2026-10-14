// Turns on the project's git hooks (.githooks/pre-push runs the public-repo
// check before every push). Runs automatically after `npm install` through
// the "prepare" script; safe to run by hand too: `node scripts/install-hooks.mjs`.
// Does nothing outside a git repository (a downloaded zip, say), so it can
// never make `npm install` fail.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (!existsSync('.git')) process.exit(0);
try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('Git hooks on: every git push runs the public-repo check first.');
} catch {
  console.log('Could not turn on the git hooks (is git installed?). Run `npm run check:public` before each push instead.');
}
