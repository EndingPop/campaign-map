# Campaign map (1.0)

A private, shared map for a tabletop campaign. The DM marks where the party has been and
where it is now; everyone in the group can open the map, see the places the party knows
about, and add what they learned.

- **Typed pins**, each with a base type (shape and color) and any number of ring types
  (outlines), for example Town/City with a faction ring. Types are set per campaign.
- **Hidden pins and DM-only text**, invisible to players until revealed.
- **The party's route**, drawn as a smooth curve along the roads the DM clicks, with
  teleport legs drawn separately; the newest stop is the party's current position.
- **Distances and travel time** for every leg and the whole route, at 5e travel pace, plus
  a Measure tool for everyone.
- **Notes, leads and people met** on each pin, written by any player and signed.
- **Search** across pins, notes and route stops, limited to what each person may see.
- **Roles:** players, and a DM and an admin with the same full powers.
- **Backup and restore** from the app.

It was built for a Storm King's Thunder group on the Sword Coast, but nothing in the code
is tied to that campaign: the title, map, pin types and teleport wording are settings.

**How it works.** The site is static files in `public/`, served by a Cloudflare Worker.
Cloudflare Access decides who can load the site at all. Firebase Authentication signs
people in with Google, and Cloud Firestore stores the data, with the rules in
`firestore.rules` deciding what each role may read and write. There is no server to run.
Everything fits in the free tiers of Cloudflare and Firebase (Spark plan) for a group of
this size.

Every command below is typed in a terminal opened in this folder (the one containing this
README).

## 1. One-time setup on your computer

1. **Node.js 24 or newer.** The rules test library requires Node 24.12+. Install it with
   [nvm](https://github.com/nvm-sh/nvm), which works without root:
   ```
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   ```
   Close and reopen the terminal, then:
   ```
   nvm install 24
   node --version
   ```
   The second command should print `v24.` followed by more numbers. (Check the nvm page
   for the current version number in the install command.)
2. **Java 21 or newer**, which the local Firestore emulator runs on. On Debian or Ubuntu:
   `sudo apt install openjdk-21-jre-headless`. On Fedora: `sudo dnf install java-21-openjdk-headless`.
   Check with `java -version`.
3. **This project's tools.** In this folder:
   ```
   npm install
   ```
   This downloads the Firebase command-line tool, Cloudflare's Wrangler, and the test
   libraries into `node_modules/`. Nothing is installed system-wide, so the commands
   below run them with `npx` or through `npm run`.

## 2. Try the interface right now (no accounts needed)

```
npm run serve
```
This starts a small web server. Open <http://localhost:5173/?demo=dm> in a browser.
Demo mode uses made-up data held in memory, on an example map: you can add pins, stops and
notes, and reloading the page resets everything. Use the account menu (top right) to view
the demo as a player or an admin. Press Ctrl+C in the terminal to stop the server.

## 3. Set up your copy

Settings that belong to one campaign's copy are kept out of the repository. Each has a
committed `.example` file to copy and fill in; the real files are listed in `.gitignore`.

| Copy this | To this | What goes in it |
| --- | --- | --- |
| `public/js/site-config.example.js` | `public/js/site-config.js` | Site title, production hostname, the two Firebase web configs, map image and scale, starting pin types, teleport wording |
| `wrangler.example.jsonc` | `wrangler.jsonc` | Worker name and production custom domain |
| `.firebaserc.example` | `.firebaserc` | Your dev and prod Firebase project ids (or create it with `npx firebase use --add`) |
| `.deploy.env.example` | `.deploy.env` | Optional: your dev and prod addresses, shown by `npm run deploy` |

Until `site-config.js` exists the app falls back to the example, so demo mode works but
signing in reports that Firebase is not set up.

The Firebase web settings are not secrets. Firebase documents them as safe to include in
client code ([Firebase API keys](https://firebase.google.com/docs/projects/api-keys)): they
identify the project, and the security rules protect the data. They are kept out of the
repository because they belong to one copy, not because they must be hidden.

### The map image

Published campaign maps are usually copyrighted, so map files are not committed: anything
in `public/map/` except `example-map.png` is ignored by git. Put your map in `public/map/`,
set `MAP.imagePath`, `imageWidth` and `imageHeight` in `site-config.js`, and keep a copy
somewhere safe, since git will not. `npm run deploy` uploads it from your folder and warns
if it is missing.

- Width and height are the coordinate grid every pin and route point is stored on.
- **Sharper copy of the same map later:** replace the file and keep the width and height
  (in Map settings) unchanged. The image stretches to fill the same grid, so pins stay in
  place, and the zoom limit rises to match the extra detail.
- **A differently framed map** (cropped, or a different region) needs every pin moved, so
  settle on the map before entering much campaign data.
- **Scale:** open the app, use the Measure tool along the map's scale bar, and choose
  **Use as map scale** (admin or DM), or set `milesPerPixel` in `site-config.js`.

## 4. Test against real Firebase software, locally

The Firebase emulators run Authentication and Firestore on your computer, with the real
security rules, so you can test roles without touching any online project.
Use three terminals, all in this folder:

| Terminal | Command | What it does |
| --- | --- | --- |
| 1 | `npm run emulators` | Starts the local Auth and Firestore emulators. The first run downloads them. Leave it running. |
| 2 | `npm run seed` | Loads test members, the starting pin types, six pins, a lead and a person met, and a five-stop route (one leg a teleport) into the local emulator. Run it again any time to reset that data. |
| 3 | `npm run serve` | Serves the site at <http://localhost:5173>. |

Open <http://localhost:5173> and choose **Sign in with Google**. The emulator shows a fake
Google window: choose **Add new account** and type one of these emails to test each role:

| Email | Role |
| --- | --- |
| `admin@example.com` | admin |
| `dm@example.com` | DM |
| `player@example.com` | player |
| anything else | not a member (should be refused) |

Use a private window for a second role at the same time. The emulator dashboard at
<http://localhost:4000> shows the stored data.

### Run the security rules tests

With the emulators **stopped** (Ctrl+C in terminal 1):
```
npm run test:rules
```
This starts the Firestore emulator, runs 27 tests covering 85 allowed or refused actions
across the roles (for example "a player cannot read a hidden pin" and "a player cannot
edit someone else's note"), and stops the emulator. Every test should report `ok`. Run
this after any change to `firestore.rules`.

## 5. Firebase projects

Create two projects, one for testing (dev) and one for the campaign (prod), so testing never
touches real data. In the [Firebase console](https://console.firebase.google.com), signed in
with the Google account that will own them, for each project:

1. **Create project.** Analytics is not needed.
2. **Security > Authentication > Sign-in method > Google > Enable.**
3. **Databases & Storage > Firestore > Create database:** Standard edition, production
   mode, a location near the group. The location cannot be changed later.
4. **Project settings > General > Your apps > Web:** register an app and copy its config
   values into the `dev` or `prod` block of `site-config.js`.
5. **Firestore > Data:** create the collection `members` with one document whose id is
   your Google email in lowercase and a string field `role` set to `admin`. Everyone else is
   added from the app's **Members** screen.

Menu names are as of October 2026. Whoever owns a Firebase project can read all of its data
in the console, so the owner account is effectively a DM: use a separate account if the
owner also plays.

Then, in this folder:
```
npx firebase login
npx firebase use --add      # run twice: the dev project as "dev", the prod project as "prod"
npm run deploy:rules:dev
npm run deploy:rules:prod
```

## 6. Cloudflare

You need a Cloudflare account, and for production a domain on Cloudflare.

1. **Access policy first.** In the Zero Trust dashboard, **Access > Policies > Add a
   policy**: action Allow, Include > Emails, and every member's Google address.
2. **Protect the Workers.** **Workers & Pages** > the **Cloudflare Access** card (protect all
   Workers): turn it on, choose **All traffic**, and pick your policy. This covers every
   address of every Worker in the account, including ones created later
   ([Cloudflare docs](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)).
   If the card only appears once a Worker exists, deploy dev first and come straight back;
   the Firestore rules protect the data meanwhile. Note that this setting applies to every
   Worker in the account, including other projects' Workers.
3. **Deploy dev:** `npx wrangler login`, then `npm run deploy:site:dev`. The first time,
   Wrangler may ask for a `workers.dev` subdomain. It prints the dev address.
4. Add the dev address (without `https://`) to the dev Firebase project under
   **Authentication > Settings > Authorized domains**, and to `.deploy.env`.
5. **Deploy prod:** `npm run deploy:site:prod`. This creates the production Worker and
   attaches the custom domain from `wrangler.jsonc`; Cloudflare creates its DNS record. An
   existing DNS record with the same name blocks this, so delete it first.
6. Add the production domain to the prod project's authorized domains.
7. **Check:** in a private window, without signing in, open both sites and
   `/map/<your map file>` on the production domain. Each must stop at Cloudflare's sign-in.

The app picks its database from the address it is opened on: the production hostname in
`site-config.js` uses prod, `localhost` uses the emulators, and every other address
(including the dev Worker's `workers.dev` address) uses dev.

## Everyday use

- **Roles:** admin and DM have the same powers: everything players can do, plus pins,
  the route, pin types, DM-only text, members, map settings, backup and restore. The two
  names only show who is who. Either can change or remove the other in **Members**.
- **Adding a person** takes two places: the Cloudflare Access policy, and **Members** in
  the app (admin or DM).
- **New pins start hidden** from players. Switch "Who can see it" to visible when the
  party learns about the place.
- **Route:** choose **Add stop**, then click along the road. Clicking a pin routes the road
  through that town; it does not end the leg. End the leg with **Stop here** or Enter. If your
  last click is on a pin, the button reads **Stop at <pin name>** and the stop links to that pin,
  even if its type is switched off in the legend. Backspace removes the last point. The route
  is drawn as a smooth curve through every stop and bend point, so three or four clicks per leg
  follow most roads. The newest stop is the party's current position. **Party arrived here** on
  a pin adds a straight leg in one step.
- **Teleports:** when adding a stop, set **How the party got here** to the teleport option
  (its name comes from `TELEPORT` in `site-config.js`). Click only the destination (or use
  **Party arrived here** on its pin). The leg is drawn as a dotted violet arc straight from
  the previous stop. Colors are in `ROUTE_STYLES` in `public/js/config.js`.
- **Distances and travel time:** each stop in the route list shows the miles of the leg into
  it (measured along the drawn road) and the days it takes at normal pace (24 miles a day);
  the line under **Route** totals the overland miles and counts the teleports (hover it for
  slow and fast pace). Teleport legs count no miles. The **ruler button** under the zoom
  buttons is the Measure tool, for everyone: click points, read the miles and the days at
  slow, normal and fast pace; Backspace removes a point, Esc ends.
- **Leg details:** click any leg of the route line, a stop dot, or a stop in the route list
  for a popup with where the leg runs from and to, the stop's session date, the miles along
  the road (or the teleport) and the days at normal, slow and fast pace. The DM gets an
  **Edit stop** button there. The route only responds to clicks in Select mode, so drawing a
  new leg or measuring across it still works.
- **Leads and people met:** a pin's panel has three lists: **Leads and rumors**,
  **People met** and **Party notes**. The form at the bottom adds any of the three (pick
  which in its menu; a person needs a name). Anyone who can see a lead can tick it as
  followed up or untick it; only its author can edit the words. The DM can delete any entry.
- **Search** (top of the side panel; the x clears it) finds words in pin names,
  descriptions, pin types, notes, leads, people met and their authors, and in route stop
  names, dates and teleports. The **Pins and notes** and **Route stops** boxes choose what
  it looks through. It only ever sees what the signed-in person can open: players get
  public pins and their notes; the DM also gets hidden pins (marked "hidden") and DM-only
  text. Notes are loaded when search is first used and refreshed at most once a minute.
- **Fixing a leg:** **Edit** next to a stop in the route list lets you rename it, delete it,
  redraw the road leading into it, make that road a straight line, or change the leg to or
  from a teleport.
- **Backups:** after each session, sign in as admin or DM and choose **Download backup
  (JSON)** from the account menu. The file name includes the site title and project.
  Firestore's managed backups are not in the free tier, so these files are the only copies:
  keep a few, and never commit them (they hold DM-only text and members' emails;
  `.gitignore` excludes them).
- **Restoring:** account menu > **Restore from backup…** (admin or DM). Pick a backup file;
  the dialog shows when it was saved, which project it came from and what it holds. Restoring
  makes the map match the file: anything added since is deleted, and changed entries go back.
  Before it changes anything it downloads a `…-before-restore-….json` copy, so restoring
  that file undoes the restore. The member list is restored only if you tick that box, and
  your own member entry is never removed. A backup from a different project (dev into prod,
  say) needs an extra confirmation. If the restore stops part-way (lost connection), run it
  again with the same file.
- **Updating the site:** run `npm run deploy`. It checks that your settings files exist,
  then walks through every step in order (install, rules tests, dev rules, dev site, a pause
  to check dev, a pause to back up prod, prod rules, prod site), shows each command and
  waits: Enter runs it, `s` skips it, `q` quits. If a command fails it stops there and runs
  nothing after it. `npm run deploy -- --dry-run` shows the steps without running anything.
  Cloudflare keeps earlier versions; if something breaks, run `npx wrangler rollback --env=""`
  (production) or use the Worker's Deployments tab in the dashboard.

## Publishing changes to a public repository

Before every push, run:
```
npm run check:public
```
It lists exactly the files git would publish and fails if any of them is one of your
private settings files, a map image other than the example, or a backup, or contains a
value read from your private files (domain, Firebase project ids and keys, Worker name,
deploy addresses) or a real-looking email address. It reads those values from your
private files when it runs, so the check itself publishes nothing.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "This copy of the map has no Firebase settings" | Create `public/js/site-config.js` from the example, or fill in that environment's `REPLACE_ME` values. |
| The map is blank and a message says the image did not load | The file named in `MAP.imagePath` (or Map settings) is not in `public/`. Maps are not in the repository; copy yours in. |
| "That change was refused" or a permission error right after signing in locally | The emulator account may not be marked verified. Open <http://localhost:4000/auth>, edit the account, and turn on email verified. |
| "This address is not on the Firebase project's authorized domains list" | Firebase console > Authentication > Settings > Authorized domains: add the address shown in the browser. |
| The sign-in window never appears on a phone | Allow pop-ups for the site. |
| `npm run test:rules` fails to start | Check `java -version` (21+) and `node --version` (24.12+), and that `npm run emulators` is not already running. |
| `npm run deploy` says a settings file is missing | Copy the matching `.example` file (section 3). |

## Files

| Path | Purpose |
| --- | --- |
| `public/index.html`, `public/styles.css` | Page structure and styling |
| `public/js/app.js` | Interface: map, pins, route, notes, DM and admin tools |
| `public/js/backend-firebase.js` | All reads and writes to Firebase |
| `public/js/backend-demo.js` | In-memory data for `?demo` |
| `public/js/config.js` | App-wide settings; loads `site-config.js` (or the example) |
| `public/js/site-config.example.js` | Template for this copy's settings (`site-config.js`, not committed) |
| `public/js/markers.js` | Pin and party marker drawing |
| `public/js/route.js` | Route geometry: bend points, curve smoothing, leg lengths |
| `public/js/restore.js` | Checks a backup file and plans the writes that restore it |
| `public/js/ui.js` | Dialogs, messages and small helpers |
| `public/vendor/` | Leaflet 1.9.4 and Firebase JS SDK 13.0.0, bundled; rebuild with `npm run vendor` |
| `public/map/example-map.png` | Placeholder map for demo mode; your own map goes beside it (not committed) |
| `firestore.rules` | Security rules |
| `tests/rules.test.mjs` | Security rules tests |
| `scripts/seed.mjs` | Test data for the local emulator only |
| `scripts/serve.mjs` | Local web server |
| `scripts/deploy.sh` | Step-by-step deploy (`npm run deploy`) |
| `scripts/check-public.mjs` | Pre-push check for private data (`npm run check:public`) |
| `LICENSE` | MIT license |
| `firebase.json` | Firebase tool settings |
| `wrangler.example.jsonc`, `.firebaserc.example`, `.deploy.env.example` | Templates for this copy's Cloudflare, Firebase and deploy settings |
