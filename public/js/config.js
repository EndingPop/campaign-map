// App-wide settings. Everything specific to one campaign's copy of the map
// (title, domain, Firebase projects, map image, pin types, teleport wording)
// lives in site-config.js, which is not committed. When it is missing, the
// committed site-config.example.js is used instead, so a fresh clone still
// runs in demo mode.

let site;
let siteConfigMissing = false;
try {
  site = await import('./site-config.js');
} catch {
  site = await import('./site-config.example.js');
  siteConfigMissing = true;
}
export const SITE_CONFIG_MISSING = siteConfigMissing;

export const SITE_TITLE = site.SITE_TITLE || 'Campaign Map';
export const PROD_HOST = site.PROD_HOST;
export const STARTING_PIN_TYPES = site.STARTING_PIN_TYPES;

const FIREBASE_CONFIGS = {
  ...site.FIREBASE_CONFIGS,
  // Local emulators started with `npm run emulators`. Same for every copy.
  local: {
    apiKey: 'demo-key',
    authDomain: 'demo-map.firebaseapp.com',
    projectId: 'demo-map',
  },
};

// Map image used until an admin saves map settings in the app.
export const DEFAULT_MAP = { ...site.MAP };

// Overland travel pace, miles per day (D&D 5e Basic Rules, Travel Pace table).
export const TRAVEL_PACES = [
  { id: 'slow', label: 'Slow', milesPerDay: 18 },
  { id: 'normal', label: 'Normal', milesPerDay: 24 },
  { id: 'fast', label: 'Fast', milesPerDay: 30 },
];

// Travel modes the DM's app creates on first sign-in when the database has
// none. A stop's `travel` holds a mode id; stops without one count as
// 'road'. More modes are added in the app (menu > Travel modes).
//   line   'path': follows the bend points the DM clicks, smoothed
//          'arc' : a curve straight from the previous stop
//   dash   'dash' | 'dot' | 'solid'
//   paces  miles a day at slow / normal / fast; leave any out. With none
//          set, the leg has no distance or travel time (a teleport).
//   revealed  players see the mode only once true; the DM's app sets it the
//          first time a stop uses the mode.
// The teleport wording comes from site-config.js (e.g. "Harper teleport").
const teleport = site.TELEPORT || { label: 'Teleport', inline: 'teleport' };
export const STARTING_TRAVEL_MODES = [
  { id: 'road', label: 'Overland travel', inline: 'overland travel', color: '#c9a227', line: 'path', dash: 'dash',
    paces: Object.fromEntries(TRAVEL_PACES.map((p) => [p.id, p.milesPerDay])), revealed: true, sortOrder: 1 },
  { id: 'teleport', label: teleport.label, inline: teleport.inline || teleport.label, color: '#b07cff', line: 'arc', dash: 'dot',
    paces: {}, revealed: false, sortOrder: 2 },
];

// How route stops mark in-game time (Map settings > Stop time). The DM picks
// one per campaign; the real session date is always kept as well.
export const TIME_SCHEMES = [
  { id: 'session', label: 'Session date only' },
  { id: 'calendar', label: 'In-game calendar' },
  { id: 'day', label: 'Campaign day (Day 1, Day 2...)' },
  { id: 'sessionNumber', label: 'Session number' },
  { id: 'text', label: 'Free text' },
];
// A campaign's own calendar from site-config.js (same shape as the presets
// in calendar.js), offered first when the DM picks a calendar.
export const SITE_CALENDAR = site.CALENDAR || null;

// What an NPC's status can be. The first is the default for a new NPC.
export const NPC_STATUSES = [
  { id: 'alive', label: 'Alive' },
  { id: 'dead', label: 'Dead' },
  { id: 'missing', label: 'Missing' },
  { id: 'unknown', label: 'Unknown' },
];

// 'demo'  : ?demo in the URL. In-memory data, no sign-in, nothing saved.
// 'local' : localhost, talks to the Firebase emulators.
// 'prod'  : PROD_HOST.
// 'dev'   : anything else.
export function detectEnv() {
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) return 'demo';
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'local';
  if (host === PROD_HOST) return 'prod';
  return 'dev';
}

export function firebaseConfigFor(env) {
  const cfg = FIREBASE_CONFIGS[env];
  if (!cfg || Object.values(cfg).some((v) => String(v).includes('REPLACE_ME'))) return null;
  return cfg;
}
