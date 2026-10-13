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

// Route line colors. A stop's `travel` says how the party reached it.
// Teleport legs are drawn as an arc straight between the two stops.
// teleport.inline is the wording used inside sentences ("By teleport").
const teleport = site.TELEPORT || { label: 'Teleport', inline: 'teleport' };
export const ROUTE_STYLES = {
  road: { label: 'Party route', color: '#c9a227' },
  teleport: { label: teleport.label, inline: teleport.inline || teleport.label, color: '#b07cff' },
};

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
