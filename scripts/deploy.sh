#!/usr/bin/env bash
# Step-by-step deploy: dev first, then prod.
#
#   npm run deploy            (or: bash scripts/deploy.sh)
#   npm run deploy -- --dry-run   shows the steps without running anything
#
# Before each step it shows the command and waits:
#   Enter = run it    s = skip it    q = quit
# If a command fails, the script stops there and nothing after it runs.

set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# Always work from the project folder (the one holding package.json).
cd "$(dirname "$0")/.." || exit 1

# Your addresses, from the optional .deploy.env (see .deploy.env.example).
DEV_URL="your dev site (the workers.dev address printed by the dev deploy)"
PROD_URL="your production site"
# shellcheck disable=SC1091
[[ -f .deploy.env ]] && source .deploy.env

bold=$'\e[1m'; red=$'\e[31m'; green=$'\e[32m'; yellow=$'\e[33m'; reset=$'\e[0m'
step_no=0

# ask "question" -> returns 0 to go on, 1 to skip; quits on q.
ask() {
  local answer
  while true; do
    read -r -p "$1 [Enter = yes, s = skip, q = quit] " answer || { echo; echo "No input; stopping."; exit 1; }
    case "${answer,,}" in
      "" | y | yes) return 0 ;;
      s | skip) return 1 ;;
      q | quit) echo "Stopped. Nothing after this point was run."; exit 0 ;;
      *) echo "Please press Enter, s or q." ;;
    esac
  done
}

# run "description" command...
run() {
  local what="$1"; shift
  step_no=$((step_no + 1))
  echo
  echo "${bold}Step ${step_no}: ${what}${reset}"
  echo "  \$ $*"
  if ! ask "Run this step?"; then
    echo "${yellow}Skipped.${reset}"
    return
  fi
  if (( DRY_RUN )); then
    echo "(dry run: not running it)"
    return
  fi
  if "$@"; then
    echo "${green}Step ${step_no} finished.${reset}"
  else
    local code=$?
    echo
    echo "${red}${bold}Step ${step_no} failed (exit code ${code}). Stopping here; later steps were not run.${reset}"
    echo "Fix the problem, then run the script again. Steps that already finished can be skipped with s."
    exit "$code"
  fi
}

# pause "message" -> a checkpoint with no command.
pause() {
  step_no=$((step_no + 1))
  echo
  echo "${bold}Step ${step_no}: $1${reset}"
  shift
  for line in "$@"; do echo "  $line"; done
  ask "Done, and ready to continue?" || echo "${yellow}Continuing without confirming.${reset}"
}

echo "${bold}Campaign map deploy${reset} ($(node -p "require('./package.json').version" 2>/dev/null || echo 'version unknown'))"
(( DRY_RUN )) && echo "${yellow}Dry run: commands are shown but not run.${reset}"

command -v node >/dev/null || { echo "${red}Node.js is not installed or not on the PATH.${reset}"; exit 1; }
command -v npm >/dev/null || { echo "${red}npm is not installed or not on the PATH.${reset}"; exit 1; }

# This copy's own settings must exist; they are not in the repository.
missing=0
for f in public/js/site-config.js wrangler.jsonc .firebaserc; do
  if [[ ! -f "$f" ]]; then
    echo "${red}Missing ${f}.${reset} Copy the matching .example file and fill it in (README: \"Set up your copy\")."
    missing=1
  fi
done
(( missing )) && exit 1
map_path=$(node -e "import('./public/js/config.js').then((c) => console.log(c.DEFAULT_MAP.imagePath))" 2>/dev/null)
if [[ -n "$map_path" && ! -f "public/$map_path" ]]; then
  echo "${yellow}Warning: the map image public/${map_path} named in site-config.js is not in this folder.${reset}"
  echo "It is not in the repository (maps are usually copyrighted); copy it in before deploying, or the deployed site will have no map."
  ask "Deploy anyway?" || exit 1
fi

run "Install or update the project's tools (only needed if package.json changed; skip otherwise)" \
  npm install
run "Run the security rules tests against the local emulator" \
  npm run test:rules
run "Deploy the security rules to dev" \
  npm run deploy:rules:dev
run "Deploy the site to dev" \
  npm run deploy:site:dev
pause "Check the dev site" \
  "Open ${DEV_URL} in a private window, sign in, and try what changed." \
  "If something is wrong, press q now; prod has not been touched."
pause "Back up prod" \
  "Open ${PROD_URL}, sign in as admin or DM, and choose Download backup (JSON) in the account menu." \
  "Keep the file somewhere safe before continuing."
run "Deploy the security rules to prod" \
  npm run deploy:rules:prod
run "Deploy the site to prod" \
  npm run deploy:site:prod

echo
echo "${green}${bold}All steps done.${reset} Check ${PROD_URL}."
echo "If the prod site misbehaves: npx wrangler rollback --env=\"\"  (rules: restore an earlier version in the Firebase console's Rules tab)."
