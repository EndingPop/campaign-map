// Settings for one campaign's copy of the map.
//
// Copy this file to site-config.js (same folder) and fill it in. site-config.js
// is listed in .gitignore, so your domain, Firebase projects and campaign names
// never reach a public repository. Until it exists, the app falls back to this
// example: demo mode works, and signing in reports that Firebase is not set up.
//
// The Firebase web settings below are not secrets: Firebase documents them as
// safe to ship in client code (https://firebase.google.com/docs/projects/api-keys).
// The Firestore rules protect the data; Cloudflare Access protects the site.

// Shown in the page title and header.
export const SITE_TITLE = 'Campaign Map';

// The production hostname. Every other hostname (the dev Worker's address, for
// example) uses the dev Firebase project.
export const PROD_HOST = 'map.example.com';

// From Firebase console > Project settings > General > Your apps > Web app.
export const FIREBASE_CONFIGS = {
  prod: {
    apiKey: 'REPLACE_ME',
    authDomain: 'REPLACE_ME.firebaseapp.com',
    projectId: 'REPLACE_ME',
    appId: 'REPLACE_ME',
  },
  dev: {
    apiKey: 'REPLACE_ME',
    authDomain: 'REPLACE_ME.firebaseapp.com',
    projectId: 'REPLACE_ME',
    appId: 'REPLACE_ME',
  },
};

// The map image, in public/ (map files other than the example are git-ignored,
// since published maps are usually copyrighted). Width and height are the
// coordinate grid pins are stored on. milesPerPixel sets distances; measure
// the map's scale bar with the Measure tool and choose "Use as map scale".
// An admin can also change all of these in the app (Map settings).
export const MAP = {
  imagePath: 'map/example-map.png',
  imageWidth: 2576,
  imageHeight: 1667,
  milesPerPixel: 1.0,
};

// Created by the "Add the starting pin types" button when the database has
// none. Base types are a pin's shape and color; rings are outlines drawn
// around it (a pin can have several). Change them later in the app.
export const STARTING_PIN_TYPES = [
  { id: 'city', label: 'Town/City', kind: 'base', color: '#c0392b', shape: 'circle', sortOrder: 1 },
  { id: 'notable', label: 'Notable location', kind: 'base', color: '#2e8b57', shape: 'diamond', sortOrder: 2 },
  { id: 'faction', label: 'Allied faction', kind: 'ring', color: '#000000', ringOrder: 1, sortOrder: 3 },
  { id: 'portal', label: 'Teleport circle', kind: 'ring', color: '#1e5bc6', ringOrder: 2, sortOrder: 4 },
];

// Wording for route legs where the party teleported instead of traveling.
// label: legend and headings. inline: inside sentences ("By teleport").
export const TELEPORT = { label: 'Teleport', inline: 'teleport' };

// Optional: this campaign's own in-game calendar, offered first in Map
// settings when the DM chooses "In-game calendar". Built-in presets cover the
// Forgotten Realms, Greyhawk, Golarion and Eberron (public/js/calendar.js has
// them as examples of the shape). Leave it out if a preset fits.
// export const CALENDAR = {
//   name: 'Our calendar', yearSuffix: 'AE',
//   periods: [{ name: 'Firstmonth', days: 30 }, { name: 'Feast', days: 1, festival: true }, ...],
//   leap: null,
//   week: { length: 7, names: [] },
// };
