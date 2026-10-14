// Campaign map: main UI.
import { detectEnv, firebaseConfigFor, DEFAULT_MAP, STARTING_PIN_TYPES, STARTING_TRAVEL_MODES, NPC_STATUSES, TRAVEL_PACES, TIME_SCHEMES, SITE_CALENDAR, SITE_TITLE, SITE_CONFIG_MISSING } from './config.js';
import { CALENDAR_PRESETS, isValidDate, dayNumber, addDays, formatDate as formatGameDate, weekdayName, periodDays, periodsToText, textToPeriods } from './calendar.js';
import { h, toast, explainError, formDialog, confirmDialog, panelDialog, formatDate } from './ui.js';
import { pinSvg, typeSwatch, partySvg, PARTY_SIZE } from './markers.js';
import { routeSegments, smoothPath, pathLength, legPixels, legPoints, modeIdOf, arcPoints } from './route.js';
import { parseBackup, summarize } from './restore.js';

const L = window.L;
const env = detectEnv();
const $ = (id) => document.getElementById(id);

const state = {
  backend: null,
  user: null,
  member: null,
  role: null,
  settings: null,
  pinTypes: new Map(),
  pins: new Map(),
  waypoints: [],
  members: [],
  notes: [],
  dmText: '',
  noteDraft: '',
  noteKind: 'note', // what the pin panel's add form adds: note or lead
  selectedPinId: null,
  selectedNpcId: null, // the detail panel shows a pin or an NPC, never both
  npcs: new Map(),
  npcSecrets: new Map(), // DM only: DM notes and hidden links, by NPC id
  npcNotes: [],
  npcNoteDraft: '',
  affiliations: new Map(),
  travelModes: new Map(),
  travelModesLoaded: false,
  revealing: new Set(), // reveal writes in flight, so each is sent once
  sideTab: readPref('sideTab', 'map'),
  npcFilter: '', // affiliation id, or '' for all
  // PC view: a DM window that loads and shows only what players see, for
  // projecting at the table. Kept in this window's address (?view=pc), so a
  // second window, or a refresh, keeps its own setting.
  pcView: new URLSearchParams(location.search).get('view') === 'pc',
  // Presenter sync: `presenting` is the DM window sending its view;
  // `followDM` is a window applying it (on by default in PC view).
  presenter: null,
  presenting: false,
  followDM: new URLSearchParams(location.search).get('view') === 'pc',
  appliedSeq: 0,
  plans: new Map(),
  dmPlans: new Map(),
  showPlans: readPref('showPlans', true),
  sessions: new Map(),
  sessionsLoaded: false,
  selectedSessionId: null,
  sessionNotes: [],
  sessionSecret: '',
  sessionNoteDraft: '',
  handouts: new Map(),
  viewerHandoutId: null,
  mode: 'select',
  hiddenFilters: new Set(readPref('hiddenFilters', [])),
  showRoute: readPref('showRoute', true),
  showHidden: readPref('showHidden', true),
  dataSubs: [],
  memberSub: null,
  detailSubs: [],
  map: null,
  layers: null,
  overlay: null,
  mapKey: null,
  fitZoom: 0,
  refreshers: new Set(), // open dialogs that redraw on data changes
  measure: null, // { points: [{x, y}] } while the Measure tool is on
  search: {
    query: '',
    scope: { pins: true, npcs: true, stops: true, sessions: true, ...readPref('searchScope', {}) },
    texts: null,     // Map pinId -> { notes, dmText }, loaded when search is used
    sessionTexts: null, // Map sessionId -> { notes }
    npcTexts: null,  // Map npcId -> { notes }
    loadedAt: 0,
    loading: null,   // promise while loading
    generation: 0,   // bumps on reset so a late load from a previous account is dropped
  },
};

// Short name for downloaded files, from the site title.
const fileSlug = () => SITE_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign-map';

// The account's own role. The DM has full admin powers (members, map
// settings, backup and restore); the rules grant the same. The role names
// only show who is who.
const hasDMRole = () => state.role === 'dm' || state.role === 'admin';
// What this window acts as. In PC view a DM's window behaves exactly like a
// player's: it loads only what players can read and offers no editing.
const isDM = () => hasDMRole() && !state.pcView;
const isAdmin = isDM;
const inPcView = () => hasDMRole() && state.pcView;

function readPref(key, fallback) {
  try { const v = localStorage.getItem(`campaign-map.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`campaign-map.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const reportError = (err) => { console.error(err); toast(explainError(err), 'error'); };
async function attempt(fn, okMessage) {
  try { const r = await fn(); if (okMessage) toast(okMessage, 'ok'); return r; } catch (err) { reportError(err); return undefined; }
}

// ---------- coordinates: stored as image pixels, Leaflet uses [-y, x] ----------
const ll = (x, y) => L.latLng(-y, x);
const xy = (latlng) => ({ x: Math.round(latlng.lng), y: Math.round(-latlng.lat) });

// ---------- startup and gate screens ----------
function gate(message, actions = []) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-message').textContent = message;
  $('gate-actions').replaceChildren(...actions);
}

async function start() {
  document.title = SITE_TITLE;
  document.querySelectorAll('.site-title').forEach((el) => { el.textContent = SITE_TITLE; });
  try {
    if (env === 'demo') {
      const { createDemoBackend } = await import('./backend-demo.js');
      state.backend = createDemoBackend(new URLSearchParams(location.search).get('demo'));
    } else {
      const config = firebaseConfigFor(env);
      if (!config) {
        gate(`This copy of the map has no Firebase settings for the "${env}" environment. ${SITE_CONFIG_MISSING ? 'Copy public/js/site-config.example.js to site-config.js and fill it in' : 'Fill in that environment in public/js/site-config.js'}, or open the demo to try the interface.`,
          [h('a', { class: 'btn', href: '?demo=dm' }, 'Open the demo')]);
        return;
      }
      const { createFirebaseBackend } = await import('./backend-firebase.js');
      state.backend = createFirebaseBackend(config, { emulators: env === 'local', onError: reportError });
    }
  } catch (err) {
    gate(`The map could not start: ${explainError(err)}`);
    return;
  }
  state.backend.onAuth(onUser);
}

function onUser(user) {
  stopData();
  state.memberSub?.();
  state.memberSub = null;
  state.user = user;
  if (!user) {
    gate('Sign in with the Google account your DM added to the map.', [
      h('button', { class: 'btn primary', type: 'button', onclick: () => attempt(() => state.backend.signIn()) }, 'Sign in with Google'),
    ]);
    return;
  }
  gate('Checking your access…');
  state.memberSub = state.backend.watchMember(user.email, (member) => {
    if (!member) {
      stopData();
      state.role = null;
      gate(`${user.email} is not on this map's member list. Ask the map admin to add it, or sign in with a different Google account.`, [
        h('button', { class: 'btn', type: 'button', onclick: () => state.backend.signOut() }, 'Sign out'),
      ]);
      return;
    }
    const roleChanged = member.role !== state.role;
    state.member = member;
    state.role = member.role;
    enterApp(roleChanged);
  });
}

function stopData() {
  state.dataSubs.forEach((u) => u());
  state.dataSubs = [];
  // Nothing loaded for one view may linger into another (PC view especially).
  state.pins = new Map(); state.npcs = new Map(); state.npcSecrets = new Map();
  state.affiliations = new Map(); state.travelModes = new Map(); state.travelModesLoaded = false;
  state.plans = new Map(); state.dmPlans = new Map(); state.handouts = new Map();
  state.sessions = new Map(); state.sessionsLoaded = false;
  closeViewer();
  renderPins(); renderNpcList(); renderPlans(); renderSessionList();
  closeDetail();
  resetSearch(); // a different account or role must not reuse loaded notes
}

function enterApp(roleChanged) {
  $('gate').hidden = true;
  $('app').hidden = false;
  renderChrome();
  if (!roleChanged && state.dataSubs.length) return;
  stopData();
  const b = state.backend;
  state.dataSubs.push(
    b.watchSettings((s) => {
      state.settings = { ...DEFAULT_MAP, ...(s || {}) };
      setupMap(); renderRouteList(); renderMeasure(); renderModeHint(); renderDetail();
    }),
    b.watchPinTypes((list) => {
      state.pinTypes = new Map(list.map((t) => [t.id, t]));
      renderFilters(); renderPins(); renderDetail(); refreshDialogs();
    }),
    b.watchPins(isDM(), (list) => {
      state.pins = new Map(list.map((p) => [p.id, p]));
      if (state.selectedPinId && !state.pins.has(state.selectedPinId)) closeDetail();
      state.search.loadedAt = 0; // pins changed: reload notes on the next search
      syncHandoutVisibility();
      renderFilters(); renderPins(); renderDetail(); renderParty(); renderSearchResults(); renderPlanList();
    }),
    b.watchWaypoints((list) => {
      state.waypoints = list.sort((a, b2) => a.seq - b2.seq);
      syncReveals(); syncSessions();
      renderRoute(); renderRouteList(); renderParty(); renderDetail(); renderDraft(); renderSearchResults(); renderSessionList();
    }),
    b.watchMembers((list) => { state.members = list; refreshDialogs(); }),
    b.watchTravelModes(isDM(), (list) => {
      state.travelModes = new Map(list.map((m) => [m.id, m]));
      if (!state.travelModesLoaded) { state.travelModesLoaded = true; addStartingTravelModes(); }
      syncReveals();
      renderRoute(); renderRouteList(); renderFilters(); renderSearchResults(); refreshDialogs();
    }),
    b.watchAffiliations(isDM(), (list) => {
      state.affiliations = new Map(list.map((a) => [a.id, a]));
      syncReveals();
      renderNpcList(); renderDetail(); refreshDialogs();
    }),
    b.watchNpcs(isDM(), (list) => {
      state.npcs = new Map(list.map((n) => [n.id, n]));
      if (state.selectedNpcId && !state.npcs.has(state.selectedNpcId)) closeDetail();
      state.search.loadedAt = 0;
      syncReveals(); syncHandoutVisibility();
      renderNpcList(); renderDetail(); renderSearchResults(); refreshDialogs();
    }),
  );
  state.dataSubs.push(
    b.watchPresenter((p) => { state.presenter = p; followPresenter(); renderPresenterChips(); }),
    b.watchPlans((list) => { state.plans = new Map(list.map((x) => [x.id, x])); renderPlans(); renderPlanList(); }),
    b.watchSessions((list) => {
      state.sessions = new Map(list.map((x) => [x.id, x]));
      state.sessionsLoaded = true;
      syncSessions();
      if (state.selectedSessionId && !state.sessions.has(state.selectedSessionId)) closeDetail();
      renderSessionList(); renderDetail(); renderSearchResults();
    }),
    b.watchHandouts(isDM(), (list) => {
      state.handouts = new Map(list.map((x) => [x.id, x]));
      syncHandoutVisibility();
      if (state.viewerHandoutId && !state.handouts.has(state.viewerHandoutId)) closeViewer();
      renderDetail(); renderViewer(); renderSearchResults();
    }),
  );
  if (isDM()) {
    state.dataSubs.push(b.watchNpcSecrets((list) => {
      state.npcSecrets = new Map(list.map((x) => [x.id, x]));
      renderNpcList(); renderDetail(); renderSearchResults();
    }));
    state.dataSubs.push(b.watchDmPlans((list) => { state.dmPlans = new Map(list.map((x) => [x.id, x])); renderPlans(); renderPlanList(); }));
  }
}

// ---------- chrome: top bar, menu, DM tools ----------
function displayName(member, email) {
  const person = member?.displayName || email;
  return member?.characterName ? `${member.characterName} (${person})` : person;
}

function renderChrome() {
  const badge = $('env-badge');
  const labels = { demo: ['Demo', 'Demo mode: changes are not saved'], local: ['Local', 'Local emulators'], dev: ['Test data', 'Dev Firebase project: test data only'] };
  badge.hidden = !labels[env];
  badge.textContent = labels[env]?.[0] || '';
  badge.title = labels[env]?.[1] || '';
  badge.dataset.env = env;

  $('user-name').textContent = state.member?.characterName || state.member?.displayName || state.user.displayName || state.user.email;
  $('user-role').textContent = { admin: 'Admin', dm: 'DM', player: 'Player' }[state.role] || '';
  document.body.classList.toggle('pc-view', inPcView());
  $('pc-view-badge').hidden = !inPcView();

  const items = [];
  if (inPcView()) items.push(['Leave PC view…', leavePcView]);
  if (!isDM()) items.push([state.followDM ? 'Stop following the DM\'s screen' : 'Follow the DM\'s screen', () => setFollow(!state.followDM)]);
  if (isDM()) items.push(['Pin types', openPinTypes], ['Travel modes', openTravelModes], ['NPC affiliations', openAffiliations], ['Convert "People met" to NPCs…', convertPeopleMet]);
  if (isAdmin()) items.push(['Members', openMembers], ['Map settings', openMapSettings], ['In-game time…', openTimeSettings], ['Download backup (JSON)', exportBackup], ['Restore from backup…', restoreBackup]);
  if (env === 'demo') {
    items.push(['sep']);
    for (const r of ['player', 'dm', 'admin']) if (r !== state.role) items.push([`View demo as ${r === 'dm' ? 'DM' : r}`, () => { location.search = `?demo=${r}`; }]);
  }
  items.push(['sep'], [env === 'demo' ? 'Leave demo' : 'Sign out', () => state.backend.signOut()]);
  $('user-menu').replaceChildren(...items.map(([label, fn]) => (label === 'sep'
    ? h('div', { class: 'sep', role: 'separator' })
    : h('button', { type: 'button', role: 'menuitem', onclick: () => { toggleMenu(false); fn(); } }, label))));

  $('dm-tools').hidden = !isDM();
  // Players may draw planned routes; nothing else leaves Select mode for them.
  if (!isDM() && !(state.mode === 'plan' && !inPcView())) setMode('select');
  if (!isDM() && state.presenting) setPresenting(false);
  renderSideTabs();
  renderPresenterChips();
}

// ---------- PC view ----------
function setPcView(on) {
  if (on && state.presenting) setPresenting(false); // tell followers before this window stops being the DM's
  state.pcView = on;
  const params = new URLSearchParams(location.search);
  if (on) params.set('view', 'pc'); else params.delete('view');
  const qs = params.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  closeDetail();
  setMode('select');
  // Reload everything as the new view: PC view must never hold DM-only data.
  enterApp(true);
  toast(on ? 'PC view: this window now shows only what players see.' : 'DM view.', 'ok');
}

async function leavePcView() {
  const ok = await confirmDialog(
    'Leave PC view? This window will show hidden pins, hidden NPCs and DM notes. If this screen is projected or shared, players will see them.',
    'Show DM view', { cancelLabel: 'Stay in PC view' });
  if (ok) setPcView(false);
}

function toggleMenu(open) {
  const menu = $('user-menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('user-button').setAttribute('aria-expanded', String(show));
}

const MODE_HINTS = {
  addPin: 'Click the map where the new pin goes. Press Esc to stop.',
  addStop: 'Click along the road; clicking a pin routes through it. End with Stop here or Enter. If your last click is on a pin, the stop links to it. For a teleport or other direct leg, click only the destination and pick that travel mode when asked.',
  redraw: 'Click along the road, in travel order, then choose Save road.',
  move: 'Drag pins to new positions. Each move saves when you let go.',
  measure: 'Click points on the map to measure. Backspace removes the last point; Esc ends.',
  plan: 'Click along the way you plan to go; clicking a pin routes through it. The plan starts at the party\'s position. Backspace removes a point; Enter or Save plan saves it.',
};
function setMode(mode, draft = null) {
  state.mode = mode;
  state.draft = mode === 'addStop' ? { points: [], redrawId: null } : (mode === 'redraw' || mode === 'plan') ? draft : null;
  state.measure = mode === 'measure' ? { points: [] } : null;
  document.querySelectorAll('#dm-tools button[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelector('.measure-btn')?.setAttribute('aria-pressed', String(mode === 'measure'));
  $('map').classList.toggle('mode-add', ['addPin', 'addStop', 'redraw', 'measure', 'plan'].includes(mode));
  state.map?.doubleClickZoom[state.draft || state.measure ? 'disable' : 'enable']();
  renderModeHint();
  renderDraft();
  renderMeasure();
  renderPins();
  if (mode !== 'select') state.map?.closePopup();
  renderRoute(); // route click targets exist only in Select mode
  renderPlans();
}

// The hint above the DM toolbar, with Undo / Stop here / Save road while drawing.
function renderModeHint() {
  const box = $('mode-hint');
  const text = MODE_HINTS[state.mode];
  box.hidden = !text;
  // Measuring often targets the scale bar at the bottom of the map, so keep the hint out of the way.
  box.classList.toggle('at-top', state.mode === 'measure');
  if (!text) return;
  const d = state.draft;
  const actions = [];
  if (state.measure) {
    const n = state.measure.points.length;
    const px = pathLength(state.measure.points);
    const miles = px * milesPerPixel();
    const summary = n < 2 ? (n ? '1 point' : 'No points yet')
      : `${fmtMiles(miles)}: ${TRAVEL_PACES.map((p) => `${p.label.toLowerCase()} ${fmtDays(miles, p.milesPerDay)}`).join(', ')}`;
    actions.push(h('span', { class: 'hint-count' }, summary));
    actions.push(h('button', { class: 'btn small', type: 'button', disabled: !n, onclick: undoMeasurePoint }, 'Undo point'));
    if (isAdmin() && n >= 2) actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => setScaleFromMeasure(px) }, 'Use as map scale'));
    actions.push(h('button', { class: 'btn small primary', type: 'button', onclick: () => setMode('select') }, 'Done'));
  }
  if (d) {
    const n = d.points.length;
    actions.push(h('span', { class: 'hint-count' }, n === 1 ? '1 point' : `${n} points`));
    actions.push(h('button', { class: 'btn small', type: 'button', disabled: !n, onclick: undoDraftPoint }, 'Undo point'));
    if (state.mode === 'addStop') {
      const endPin = n ? pinAtPoint(d.points[n - 1]) : null;
      actions.push(h('button', { class: 'btn small primary', type: 'button', disabled: !n, onclick: () => finishStop() },
        endPin ? `Stop at ${endPin.name}` : 'Stop here'));
    }
    if (state.mode === 'redraw') {
      actions.push(h('button', { class: 'btn small primary', type: 'button', onclick: saveRedraw }, n ? 'Save road' : 'Save as straight line'));
      actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => setMode('select') }, 'Cancel'));
    }
    if (state.mode === 'plan') {
      const total = planDraftPoints().length;
      actions.push(h('button', { class: 'btn small primary', type: 'button', disabled: total < 2, onclick: savePlanDraft }, 'Save plan'));
      actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => setMode('select') }, 'Cancel'));
    }
  }
  box.replaceChildren(h('span', {}, text), actions.length ? h('span', { class: 'hint-actions' }, actions) : '');
}

function wireChrome() {
  $('user-button').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!$('user-menu').hidden && !e.target.closest('.menu')) toggleMenu(false); });
  $('dm-tools').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('pc-view-btn').addEventListener('click', () => setPcView(true));
  $('present-btn').addEventListener('click', () => setPresenting(!state.presenting));
  $('plan-btn').addEventListener('click', startPlan);
  $('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(true); });
  $('present-chip').addEventListener('click', () => setPresenting(false));
  $('follow-chip').addEventListener('click', () => setFollow(false));
  $('pc-view-badge').addEventListener('click', leavePcView);
  document.querySelectorAll('#side-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.sideTab = b.dataset.tab; writePref('sideTab', state.sideTab); renderSideTabs();
  }));
  $('party-jump').addEventListener('click', jumpToParty);
  $('toggle-side').addEventListener('click', () => setSide($('app').classList.contains('side-closed')));
  wireSearch();
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (state.draft && !typing) {
      if (e.key === 'Backspace') { e.preventDefault(); undoDraftPoint(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (state.mode === 'redraw') saveRedraw();
        else if (state.mode === 'plan') { if (planDraftPoints().length >= 2) savePlanDraft(); } else if (state.draft.points.length) finishStop();
        return;
      }
    }
    if (state.measure && !typing && e.key === 'Backspace') { e.preventDefault(); undoMeasurePoint(); return; }
    if (e.key !== 'Escape') return;
    if (!$('user-menu').hidden) toggleMenu(false);
    else if (state.viewerHandoutId) closeViewer(true);
    else if (state.mode !== 'select') setMode('select');
    else if (state.selectedPinId || state.selectedNpcId || state.selectedSessionId) closeDetail();
  });
  if (window.matchMedia('(max-width: 760px)').matches) setSide(false);
}

function setSide(open) {
  $('app').classList.toggle('side-closed', !open);
  $('toggle-side').setAttribute('aria-expanded', String(open));
  setTimeout(() => state.map?.invalidateSize(), 60);
}

// ---------- map ----------
function setupMap() {
  const { imagePath, imageWidth: w, imageHeight: ht } = state.settings;
  const key = `${imagePath}|${w}|${ht}`;
  if (state.mapKey === key) return;
  state.mapKey = key;
  const bounds = L.latLngBounds([[-ht, 0], [0, w]]);
  if (!state.map) {
    state.map = L.map('map', {
      crs: L.CRS.Simple, attributionControl: false, zoomSnap: 0.25, zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120, maxBoundsViscosity: 0.8,
    });
    state.layers = {
      route: L.layerGroup().addTo(state.map),
      pins: L.layerGroup().addTo(state.map),
      party: L.layerGroup().addTo(state.map),
    };
    state.map.on('click', onMapClick);
    state.map.on('moveend', () => { if (state.presenting) writePresenter({ view: currentView() }); });
    // Measure tool button, under the zoom buttons, for everyone.
    const MeasureControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar');
        const btn = L.DomUtil.create('a', 'measure-btn', wrap);
        btn.href = '#';
        btn.title = 'Measure distance and travel time';
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'Measure distance and travel time');
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1.5" y="6" width="15" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 6v3M8 6v2M11 6v3M14 6v2" stroke="currentColor" stroke-width="1.4"/></svg>';
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(btn, 'click', (e) => { L.DomEvent.preventDefault(e); setMode(state.mode === 'measure' ? 'select' : 'measure'); });
        return wrap;
      },
    });
    new MeasureControl().addTo(state.map);
  }
  state.overlay?.remove();
  state.overlay = L.imageOverlay(imagePath, bounds, { alt: 'Campaign map' }).addTo(state.map);
  state.overlay.on('error', () => toast(`The map image "${imagePath}" did not load. Check Map settings.`, 'error'));
  // Allow zooming to 2x the image's real resolution; past that it only blurs.
  // A sharper copy of the same map (same grid numbers) raises the limit automatically.
  state.overlay.on('load', () => {
    const native = Math.log2(state.overlay.getElement().naturalWidth / w);
    if (Number.isFinite(native)) state.map.setMaxZoom(Math.max(state.fitZoom + 1, native + 1));
  });
  state.overlay.bringToBack();
  state.map.invalidateSize();
  // Leaflet clamps getBoundsZoom to the current min zoom (0 by default with
  // no tile layers), so open the range before measuring.
  state.map.setMinZoom(-8);
  state.fitZoom = state.map.getBoundsZoom(bounds);
  state.map.setMinZoom(state.fitZoom - 0.75);
  state.map.setMaxZoom(Math.max(2, state.fitZoom + 3));
  state.map.setMaxBounds(bounds.pad(0.3));
  state.map.fitBounds(bounds);
  renderPins(); renderRoute(); renderParty(); renderPlans();
}

function typesOf(pin) {
  const base = state.pinTypes.get(pin.baseType);
  const rings = (pin.rings || []).map((id) => state.pinTypes.get(id)).filter(Boolean)
    .sort((a, b) => (a.ringOrder ?? 0) - (b.ringOrder ?? 0));
  return { base, rings };
}

function pinPassesFilter(pin) {
  const ids = [pin.baseType, ...(pin.rings || [])].filter((id) => state.pinTypes.has(id));
  if (!ids.length) return true;
  return ids.some((id) => !state.hiddenFilters.has(id));
}

function renderPins() {
  if (!state.map) return;
  state.layers.pins.clearLayers();
  for (const pin of state.pins.values()) {
    const hidden = pin.visibility === 'hidden';
    if (hidden && !state.showHidden) continue;
    if (!pinPassesFilter(pin)) continue;
    const { base, rings } = typesOf(pin);
    const { size, html } = pinSvg(base, rings, { hidden, selected: pin.id === state.selectedPinId });
    const icon = L.divIcon({ className: 'pin-icon', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const marker = L.marker(ll(pin.x, pin.y), {
      icon, title: pin.name, alt: pin.name, riseOnHover: true,
      draggable: isDM() && state.mode === 'move',
      zIndexOffset: pin.id === state.selectedPinId ? 500 : 0,
    });
    marker.bindTooltip(pin.name, { direction: 'top', offset: [0, -size / 2], className: 'pin-label' });
    marker.on('click', (e) => { L.DomEvent.stopPropagation(e); onPinClick(pin.id); });
    marker.on('dragend', () => movePin(pin.id, marker.getLatLng()));
    marker.addTo(state.layers.pins);
  }
}

function renderRoute() {
  if (!state.map) return;
  state.layers.route.clearLayers();
  if (!state.showRoute || !state.waypoints.length) return;
  for (const seg of routeSegments(state.waypoints, (id) => modeOf(id).line)) {
    const m = modeOf(seg.mode);
    const pts = (seg.kind === 'arc' ? legPoints([seg.from, seg.to], 1, 'arc') : smoothPath(seg.points)).map((p) => ll(p.x, p.y));
    L.polyline(pts, { color: '#1f2a36', weight: 7, opacity: 0.55, interactive: false }).addTo(state.layers.route);
    L.polyline(pts, { color: m.color, weight: 3.5, dashArray: DASHES[m.dash] ?? DASHES.dash, lineCap: 'round', interactive: false })
      .addTo(state.layers.route);
  }
  // Click targets: a wide invisible line over each leg, and the stop dots.
  // Only in Select mode; while drawing or measuring, clicks must reach the map.
  const selecting = state.mode === 'select';
  if (selecting) {
    state.waypoints.forEach((w, i) => {
      if (i === 0) return;
      L.polyline(legPoints(state.waypoints, i, legMode(i).line).map((p) => ll(p.x, p.y)), { color: '#000', weight: 18, opacity: 0, className: 'route-hit' })
        .on('click', (e) => { L.DomEvent.stopPropagation(e); showLegPopup(i, e.latlng); })
        .addTo(state.layers.route);
    });
  }
  state.waypoints.slice(0, -1).forEach((w, i) => {
    const dot = L.circleMarker(ll(w.x, w.y), { radius: 4.5, color: '#1f2a36', weight: 2, fillColor: '#c9a227', fillOpacity: 1 })
      .bindTooltip(`${i + 1}. ${stopLabel(w)}${w.sessionDate ? ` (${formatSessionDate(w.sessionDate)})` : ''}`, { className: 'pin-label', direction: 'top' });
    if (selecting) dot.on('click', (e) => { L.DomEvent.stopPropagation(e); showLegPopup(i, ll(w.x, w.y)); });
    dot.addTo(state.layers.route);
  });
  if (state.legPopup && !state.waypoints[state.legPopup.index]) state.map.closePopup();
}

// Popup for stop i and the leg leading into it: from/to, session date,
// distance and travel time. Highlights the leg while open.
function showLegPopup(i, latlng) {
  const w = state.waypoints[i];
  if (!w) return;
  const prev = state.waypoints[i - 1];
  const mode = i > 0 ? legMode(i) : null;
  const miles = i > 0 ? legMiles(i) : 0;
  const rows = [
    ['Session date', w.sessionDate ? formatSessionDate(w.sessionDate) : 'not recorded'],
  ];
  if (gameTimeLabel(w)) rows.push(['In-game', gameTimeLabel(w)]);
  if (gameDaysInto(i) != null) rows.push(['Days since previous stop', String(gameDaysInto(i))]);
  if (i === 0) rows.push(['Route', 'Start of the route']);
  else if (isInstant(mode)) rows.push(['Travel', `${mode.label} (no travel time)`]);
  else {
    rows.push(['Travel', mode.label]);
    rows.push(['Distance', `${fmtMiles(miles)} ${mode.line === 'arc' ? 'straight across' : 'along the way'}`]);
    rows.push(['Travel time', modePaces(mode).map((p) => h('div', {}, `${fmtDays(miles, p.milesPerDay)}${modePaces(mode).length > 1 ? ` at ${p.label.toLowerCase()} pace` : ''}`))]);
  }
  const body = h('div', { class: 'leg-popup' },
    h('div', { class: 'leg-title' }, `Stop ${i + 1}: ${stopLabel(w)}`),
    prev ? h('div', { class: 'leg-from' }, `From stop ${i}: ${stopLabel(prev)}`) : null,
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    i === state.waypoints.length - 1 ? h('div', { class: 'leg-from' }, 'The party is here.') : null,
    isDM() ? h('div', { class: 'popup-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { state.map.closePopup(); editStop(w); } }, 'Edit stop'),
      h('button', { class: 'btn small', type: 'button', onclick: () => showPlayers({ kind: 'stop', id: w.id }) }, 'Show players')) : null);

  state.layers.legHighlight ||= L.layerGroup().addTo(state.map);
  state.layers.legHighlight.clearLayers();
  if (prev) {
    const pts = legPoints(state.waypoints, i, mode.line);
    L.polyline(pts.map((p) => ll(p.x, p.y)), { color: '#ffffff', weight: 7, opacity: 0.5, interactive: false }).addTo(state.layers.legHighlight);
  }
  state.legPopup = { index: i };
  L.popup({ className: 'leg-popup-wrap', maxWidth: 300, autoPanPadding: [20, 20] })
    .setLatLng(latlng)
    .setContent(body)
    .on('remove', () => { state.layers.legHighlight?.clearLayers(); state.legPopup = null; })
    .openOn(state.map);
  presentItem({ kind: 'stop', id: w.id });
}

function currentStop() { return state.waypoints[state.waypoints.length - 1] || null; }
function stopLabel(w) {
  if (!w) return '';
  return w.label || state.pins.get(w.pinId)?.name || `Stop ${state.waypoints.indexOf(w) + 1}`;
}

function renderParty() {
  const w = currentStop();
  $('party-label').textContent = w ? `Party: ${stopLabel(w)}` : 'Party position not set';
  if (!state.map) return;
  state.layers.party.clearLayers();
  if (!w) return;
  // At a pin, the party marker sits up and to the right so the pin's rings stay visible.
  const atPin = w.pinId && state.pins.has(w.pinId);
  const icon = L.divIcon({ className: 'party-icon', html: partySvg, iconSize: [PARTY_SIZE, PARTY_SIZE], iconAnchor: atPin ? [8, 40] : [24, 24] });
  L.marker(ll(w.x, w.y), { icon, zIndexOffset: 1000, keyboard: false, interactive: true, title: 'Party' })
    .bindTooltip(`Party is here: ${stopLabel(w)}`, { className: 'pin-label', direction: 'top', offset: [0, -16] })
    .on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.measure) addMeasurePoint({ x: w.x, y: w.y });
      else if (state.draft) addDraftPoint(xy(e.latlng)); // drawing: the marker must not block clicks
      else if (w.pinId && state.pins.has(w.pinId)) onPinClick(w.pinId);
      else showLegPopup(state.waypoints.length - 1, ll(w.x, w.y));
    })
    .addTo(state.layers.party);
  // Phones show the whole map very small, so start them zoomed in on the party.
  if (!state.centeredOnParty && isPhone()) {
    state.centeredOnParty = true;
    state.map.setView(ll(w.x, w.y), state.fitZoom + 1.5, { animate: false });
  }
}

function jumpToParty() {
  const w = currentStop();
  if (!w) { toast(isDM() ? 'No route yet. Use Add stop to mark where the party is.' : 'The DM has not marked the party\'s position yet.'); return; }
  state.map?.flyTo(ll(w.x, w.y), Math.max(state.map.getZoom(), state.fitZoom + 1.5), { duration: 0.8 });
}

function onMapClick(e) {
  if (state.measure) { addMeasurePoint(xy(e.latlng)); return; }
  if (state.mode === 'plan' && state.draft) { addDraftPoint(xy(e.latlng)); return; }
  if (!isDM()) { if (state.selectedPinId) closeDetail(); return; }
  if (state.mode === 'addPin') editPin(null, xy(e.latlng));
  else if (state.draft) addDraftPoint(xy(e.latlng));
  else if (state.selectedPinId) closeDetail();
}

function onPinClick(id) {
  const pin = state.pins.get(id);
  if (!pin) return;
  if (state.measure) { addMeasurePoint({ x: pin.x, y: pin.y }); return; }
  // While drawing a leg, a pin click is a bend point through that pin.
  if (state.draft && (isDM() || state.mode === 'plan')) { addDraftPoint({ x: pin.x, y: pin.y, pinId: pin.id }); return; }
  if (isDM() && state.mode === 'addPin') return;
  openPin(id);
}

const PIN_FIELDS = ['name', 'x', 'y', 'baseType', 'rings', 'visibility', 'description'];
const pinData = (pin) => Object.fromEntries(PIN_FIELDS.map((k) => [k, pin[k] ?? (k === 'rings' ? [] : k === 'description' ? '' : pin[k])]));

function movePin(id, latlng) {
  const pin = state.pins.get(id);
  if (!pin) return;
  attempt(() => state.backend.savePin(id, { ...pinData(pin), ...xy(latlng) }, state.user.email));
}

// ---------- side panel: filters and route list ----------
function renderFilters() {
  const box = $('filters');
  const types = [...state.pinTypes.values()].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99) || a.label.localeCompare(b.label));
  const counts = new Map();
  for (const p of state.pins.values()) for (const id of [p.baseType, ...(p.rings || [])]) counts.set(id, (counts.get(id) || 0) + 1);

  const typeRow = (t) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !state.hiddenFilters.has(t.id), onchange: (e) => {
      if (e.target.checked) state.hiddenFilters.delete(t.id); else state.hiddenFilters.add(t.id);
      writePref('hiddenFilters', [...state.hiddenFilters]);
      renderPins();
    } }),
    h('span', { class: 'swatch', html: typeSwatch(t) }),
    h('span', {}, t.label),
    h('span', { class: 'muted', style: 'margin-left:auto;color:var(--mist);font-size:13px' }, String(counts.get(t.id) || 0)));

  const children = [];
  if (!types.length) {
    children.push(h('p', { class: 'empty' }, 'No pin types yet.'));
    if (isDM()) children.push(h('button', { class: 'btn primary small', type: 'button', onclick: addStartingTypes }, 'Add the starting pin types'));
  } else {
    const base = types.filter((t) => t.kind !== 'ring');
    const rings = types.filter((t) => t.kind === 'ring');
    if (base.length) children.push(h('div', { class: 'filter-group' }, h('p', { class: 'filter-group-name' }, 'Places'), base.map(typeRow)));
    if (rings.length) children.push(h('div', { class: 'filter-group' }, h('p', { class: 'filter-group-name' }, 'Affiliations (rings)'), rings.map(typeRow)));
  }
  // Travel: the route on/off switch, then a legend line per travel mode.
  // Players only have revealed modes (ones the route has used).
  const modes = sortedModes();
  const [first, ...others] = modes.length ? modes : [modeOf('road')];
  const modeLabel = (m) => h('span', {}, m.label, isDM() && !m.revealed ? h('span', { class: 'muted-note' }, ' (unused; hidden from players)') : null);
  children.push(h('div', { class: 'filter-group' },
    h('p', { class: 'filter-group-name' }, 'Travel'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.showRoute, onchange: (e) => { state.showRoute = e.target.checked; writePref('showRoute', state.showRoute); renderRoute(); } }),
      h('span', { class: 'swatch', html: modeSwatch(first) }),
      modeLabel(first)),
    others.map((m) => h('div', { class: 'check legend-only' }, h('span', { class: 'swatch', html: modeSwatch(m) }), modeLabel(m))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.showPlans, onchange: (e) => { state.showPlans = e.target.checked; writePref('showPlans', state.showPlans); renderPlans(); } }),
      h('span', { class: 'swatch', html: '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 16 L9 8 L13 13 L20 5" fill="none" stroke="#dce3ea" stroke-width="3" stroke-dasharray="1 5" stroke-linecap="round"/></svg>' }),
      'Planned routes')));
  if (isDM()) {
    const hiddenCount = [...state.pins.values()].filter((p) => p.visibility === 'hidden').length;
    children.push(h('div', { class: 'filter-group' },
      h('p', { class: 'filter-group-name' }, 'DM view'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.showHidden, onchange: (e) => { state.showHidden = e.target.checked; writePref('showHidden', state.showHidden); renderPins(); } }),
        h('span', {}, 'Hidden pins'),
        h('span', { style: 'margin-left:auto;color:var(--mist);font-size:13px' }, String(hiddenCount)))));
  }
  box.replaceChildren(...children);
}

function formatSessionDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? formatDate(new Date(+m[1], +m[2] - 1, +m[3])) : (s || '');
}

// "By Harper teleport" or "86 mi, about 3½ days" for the leg into stop i.
function legLine(w, i) {
  if (i === 0) return '';
  const mode = legMode(i);
  if (isInstant(mode)) return `By ${mode.inline || mode.label}`;
  const miles = legMiles(i);
  const by = modeIdOf(w) === 'road' ? '' : ` by ${mode.inline || mode.label}`;
  return `${fmtMiles(miles)}${by}, about ${fmtDays(miles, mainPace(mode))}`;
}

// Totals over the whole route: miles and days for modes with travel time
// (each at its normal pace, or its only pace), and a count of the others.
function renderRouteSummary() {
  const box = $('route-summary');
  if (!box) return;
  const legs = state.waypoints.length - 1;
  if (legs < 1) { box.hidden = true; return; }
  let miles = 0;
  let days = 0;
  const instant = new Map(); // mode id -> count
  state.waypoints.forEach((w, i) => {
    if (i === 0) return;
    const mode = legMode(i);
    if (isInstant(mode)) { instant.set(modeIdOf(w), (instant.get(modeIdOf(w)) || 0) + 1); return; }
    const m = legMiles(i);
    miles += m;
    days += m / mainPace(mode);
  });
  const extras = [...instant].map(([id, n]) => { const m = modeOf(id); return `${n} ${m.inline || m.label}${n === 1 ? '' : 's'}`; });
  const firstDay = gameDayNumber(state.waypoints.find((w) => gameDayNumber(w) != null));
  const lastDay = gameDayNumber([...state.waypoints].reverse().find((w) => gameDayNumber(w) != null));
  const inGame = firstDay != null && lastDay != null && lastDay > firstDay ? ` ${lastDay - firstDay} in-game days from the first dated stop to the last.` : '';
  box.textContent = `${fmtMiles(miles)} traveled, about ${fmtDaysValue(days)}`
    + (extras.length ? `, plus ${extras.join(' and ')}` : '') + `.${inGame}`;
  box.title = 'Each leg at its travel mode\'s normal pace (or its only pace).';
  box.hidden = false;
}

function renderRouteList() {
  renderRouteSummary();
  const list = $('route-list');
  if (!state.waypoints.length) {
    list.replaceChildren(h('li', { class: 'empty', style: 'display:block' },
      isDM() ? 'No stops yet. Choose Add stop, then click the map or a pin.' : 'No stops yet.'));
    return;
  }
  const items = state.waypoints.map((w, i) => {
    const last = i === state.waypoints.length - 1;
    return h('li', { class: last ? 'current' : '' },
      h('span', { class: 'route-seq' }, String(i + 1)),
      h('button', { class: 'route-stop', type: 'button', onclick: () => showStopFromList(w, i) },
        h('span', { class: 'route-name' }, stopLabel(w) + (last ? ' (party is here)' : '')),
        legLine(w, i) ? h('span', { class: 'route-date' }, legLine(w, i)) : null,
        gameTimeLabel(w) ? h('span', { class: 'route-date route-game' }, gameTimeLabel(w)) : null,
        w.sessionDate ? h('span', { class: 'route-date' }, formatSessionDate(w.sessionDate)) : null),
      isDM() ? h('span', {},
        h('button', { class: 'btn link small', type: 'button', title: 'Edit this stop', onclick: () => editStop(w) }, 'Edit')) : null);
  }).reverse();
  list.replaceChildren(...items);
}

// ---------- distance and travel time ----------
function milesPerPixel() {
  const v = Number(state.settings?.milesPerPixel);
  return v > 0 ? v : DEFAULT_MAP.milesPerPixel;
}
function fmtMiles(m) {
  return `${m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString()} mi`;
}
// Days at a pace, rounded to the half day (travel is planned in days, not hours).
function fmtDays(miles, perDay) { return fmtDaysValue(miles / perDay); }
function fmtDaysValue(days) {
  const d = Math.round(days * 2) / 2;
  return d < 0.5 ? 'under ½ day' : `${String(d).replace('.5', '½')} day${d > 1 ? 's' : ''}`;
}

// ---------- travel modes ----------
const DASHES = { dash: '9 7', dot: '2 7', solid: null };
const SWATCH_DASH = { dash: '4 3', dot: '1 4', solid: null };
const startingMode = (id) => STARTING_TRAVEL_MODES.find((m) => m.id === id);
// A stop's mode, falling back to the built-in definitions (and to a plain
// road line for a mode this person cannot read or that was deleted).
function modeOf(id) {
  const m = state.travelModes.get(id);
  if (m) return { id, ...m };
  const fallback = startingMode(id) || { ...startingMode('road'), label: 'Travel', inline: 'travel' };
  return { ...fallback, id };
}
function legMode(i) { return modeOf(modeIdOf(state.waypoints[i] || {})); }
function sortedModes() {
  return [...state.travelModes.values()].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99) || a.label.localeCompare(b.label));
}
// The paces a mode has, slow to fast: [{ id, label, milesPerDay }].
function modePaces(mode) {
  return TRAVEL_PACES.filter((p) => Number(mode?.paces?.[p.id]) > 0)
    .map((p) => ({ ...p, milesPerDay: Number(mode.paces[p.id]) }));
}
const isInstant = (mode) => !modePaces(mode).length;
function mainPace(mode) {
  const ps = modePaces(mode);
  return (ps.find((p) => p.id === 'normal') || ps[0])?.milesPerDay || 24;
}
function modeSwatch(m) {
  const d = m.line === 'arc' ? 'M2 17 Q11 -1 20 17' : 'M2 16 L9 8 L13 13 L20 5';
  const dash = SWATCH_DASH[m.dash];
  return `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="${d}" fill="none" stroke="${m.color}" stroke-width="3"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/></svg>`;
}

// The DM's app creates the starting modes once, when the database has none.
async function addStartingTravelModes() {
  if (!isDM() || state.travelModes.size) return;
  await attempt(async () => {
    for (const { id, ...m } of STARTING_TRAVEL_MODES) await state.backend.saveTravelMode(id, m);
  });
}

// Shows players a travel mode once a stop uses it, and an affiliation once it
// is a visible link on a revealed NPC. Runs in the DM's app whenever the data
// changes, so it also catches stops and NPCs saved before this existed.
function syncReveals() {
  if (!isDM()) return;
  const want = [];
  for (const w of state.waypoints) want.push(['travelModes', modeIdOf(w), state.travelModes.get(modeIdOf(w))]);
  for (const n of state.npcs.values()) {
    if (n.visibility !== 'public') continue;
    for (const id of n.affiliationIds || []) want.push(['affiliations', id, state.affiliations.get(id)]);
  }
  for (const [col, id, doc] of want) {
    const key = `${col}/${id}`;
    if (!doc || doc.revealed || state.revealing.has(key)) continue;
    state.revealing.add(key);
    state.backend.reveal(col, id).catch(reportError).finally(() => state.revealing.delete(key));
  }
}

// Miles of the leg into stop i (0 for the first stop and for travel modes
// with no travel time, like teleports).
function legMiles(i) {
  const mode = legMode(i);
  return i > 0 && !isInstant(mode) ? legPixels(state.waypoints, i, mode.line) * milesPerPixel() : 0;
}

function addMeasurePoint(p) {
  state.measure.points.push(p);
  renderMeasure(); renderModeHint();
}
function undoMeasurePoint() {
  if (!state.measure?.points.length) return;
  state.measure.points.pop();
  renderMeasure(); renderModeHint();
}
function renderMeasure() {
  if (!state.map) return;
  state.layers.measure ||= L.layerGroup().addTo(state.map);
  state.layers.measure.clearLayers();
  const pts = state.measure?.points || [];
  if (pts.length > 1) {
    const line = pts.map((p) => ll(p.x, p.y));
    L.polyline(line, { color: '#1f2a36', weight: 6, opacity: 0.6, interactive: false }).addTo(state.layers.measure);
    L.polyline(line, { color: '#ffffff', weight: 2.5, dashArray: '6 6', interactive: false }).addTo(state.layers.measure);
  }
  pts.forEach((p, i) => {
    const m = L.circleMarker(ll(p.x, p.y), { radius: 4, color: '#1f2a36', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false });
    if (i === pts.length - 1 && i > 0) {
      m.bindTooltip(fmtMiles(pathLength(pts) * milesPerPixel()), { permanent: true, direction: 'right', className: 'pin-label measure-label' });
    }
    m.addTo(state.layers.measure);
  });
}

// Admin: the measured line is a known distance (e.g. the scale bar), so set the scale from it.
async function setScaleFromMeasure(px) {
  const vals = await formDialog({
    title: 'Set the map scale',
    submitLabel: 'Save scale',
    fields: [{ name: 'miles', label: 'How many miles is the line you measured?', type: 'number', step: 'any', required: true,
      hint: `The line is ${Math.round(px)} map pixels. Tip: measure the map's scale bar end to end and enter its length.` }],
  });
  if (!vals || !(vals.miles > 0)) return;
  const mpp = Number((vals.miles / px).toFixed(4));
  // The settings listener redraws distances once the save lands.
  await attempt(() => state.backend.saveSettings({ ...DEFAULT_MAP, ...state.settings, milesPerPixel: mpp }), `Map scale saved: ${mpp} miles per pixel.`);
}

// ---------- search ----------
// Searches only what this person can already see: state.pins holds public
// pins for players and every pin for the DM, and notes / DM text are read
// per visible pin, so the security rules decide what can ever match.
const SEARCH_MAX_AGE_MS = 60_000;
const SEARCH_LIMIT = 50;

function wireSearch() {
  const input = $('search-input');
  const clearBtn = $('search-clear');
  const clear = () => { input.value = ''; state.search.query = ''; clearBtn.hidden = true; renderSearchResults(); };
  input.addEventListener('focus', () => ensureSearchTexts());
  input.addEventListener('input', () => {
    state.search.query = input.value;
    clearBtn.hidden = !input.value;
    ensureSearchTexts();
    renderSearchResults();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) { e.stopPropagation(); clear(); }
  });
  clearBtn.addEventListener('click', () => { clear(); input.focus(); });
  const scopeBox = (key, label) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: state.search.scope[key], onchange: (e) => {
      state.search.scope[key] = e.target.checked;
      writePref('searchScope', state.search.scope);
      renderSearchResults();
    } }), label);
  $('search-scope').replaceChildren(scopeBox('pins', 'Pins and notes'), scopeBox('npcs', 'NPCs'), scopeBox('stops', 'Route stops'), scopeBox('sessions', 'Sessions'));
}

function resetSearch() {
  const s = state.search;
  s.texts = null; s.npcTexts = null; s.sessionTexts = null; s.loadedAt = 0; s.loading = null; s.generation += 1;
  renderSearchResults();
}

// Loads notes (and DM text for the DM) for every visible pin and NPC, at most once a minute.
function ensureSearchTexts() {
  const s = state.search;
  if (!state.backend || !state.role || s.loading) return;
  if (s.texts && Date.now() - s.loadedAt < SEARCH_MAX_AGE_MS) return;
  const gen = s.generation;
  s.loading = Promise.all([state.backend.readPinTexts([...state.pins.keys()], isDM()), state.backend.readNpcTexts([...state.npcs.keys()]),
    state.backend.readSessionTexts([...state.sessions.keys()])])
    .then(([texts, npcTexts, sessionTexts]) => { if (gen === s.generation) { s.texts = texts; s.npcTexts = npcTexts; s.sessionTexts = sessionTexts; s.loadedAt = Date.now(); } })
    .catch(reportError)
    .finally(() => { if (gen === s.generation) { s.loading = null; renderSearchResults(); if (state.selectedSessionId) renderDetail(); } });
  renderSearchResults();
}

function searchTerms(q) {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// fields: [{ label, text, also? }]; `also` is searched but not shown (a note's author).
// Every term must appear somewhere in the item.
function matchItem(fields, terms) {
  const usable = fields.filter((f) => f.text);
  const hay = (f) => `${f.text}\n${f.also || ''}`.toLowerCase();
  const all = usable.map(hay).join('\n');
  if (!terms.every((t) => all.includes(t))) return null;
  const hits = usable.filter((f) => terms.some((t) => hay(f).includes(t)));
  // The title already shows the name, so the excerpt comes from another field when one matched.
  const nameHit = hits[0]?.label === 'Name';
  // Show the field that matches the most terms (stable order otherwise).
  const termCount = (f) => terms.filter((t) => hay(f).includes(t)).length;
  const rest = (nameHit ? hits.slice(1) : hits).map((f, i) => ({ f, i, n: termCount(f) }))
    .sort((a, b) => b.n - a.n || a.i - b.i).map((x) => x.f);
  return { nameHit, field: rest[0] || null, count: rest.length };
}

// A short excerpt around the first match, with every term marked.
function snippet(text, terms) {
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const first = found.length ? Math.min(...found) : 0; // matched only on the author: show the start
  const start = Math.max(0, first - 40);
  const end = Math.min(text.length, first + 80);
  const piece = (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return piece.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

function pinSearchFields(pin) {
  const { base, rings } = typesOf(pin);
  // The open pin's notes and DM text are live, so edits made there show at once.
  const extra = pin.id === state.selectedPinId ? { notes: state.notes, dmText: state.dmText } : state.search.texts?.get(pin.id);
  return [
    { label: 'Name', text: pin.name },
    { label: 'Description', text: pin.description || '' },
    ...(extra?.notes || []).map((n) => {
      const by = n.authorName || n.authorEmail;
      const kind = noteKind(n);
      if (kind === 'npc') return { label: `Person met: ${n.name || 'unnamed'}`, text: n.text, also: `${n.name || ''} ${by}` };
      if (kind === 'lead') return { label: `Lead (${n.status === 'done' ? 'followed up' : 'open'}) by ${by}`, text: n.text, also: `${by} lead rumor` };
      return { label: `Note by ${by}`, text: n.text, also: by };
    }),
    ...(isDM() && extra?.dmText ? [{ label: 'DM-only text', text: extra.dmText }] : []),
    { label: 'Type', text: [base?.label, ...rings.map((r) => r.label)].filter(Boolean).join(', ') },
  ];
}

function npcSearchFields(npc) {
  const notes = npc.id === state.selectedNpcId ? state.npcNotes : state.search.npcTexts?.get(npc.id)?.notes || [];
  const affs = npcLinks(npc, 'affiliations');
  return [
    { label: 'Name', text: npc.name },
    { label: 'Description', text: npc.description || '' },
    { label: 'Status', text: statusLabel(npc.status) },
    { label: 'Affiliations', text: affs.filter((a) => !a.hidden).map((a) => a.item.name).join(', ') },
    { label: 'Places', text: npcLinks(npc, 'pins').map((x) => x.item.name).join(', ') },
    ...notes.map((n) => ({ label: `Note by ${n.authorName || n.authorEmail}`, text: n.text, also: n.authorName || n.authorEmail })),
    ...(isDM() ? [
      { label: 'Hidden affiliations', text: affs.filter((a) => a.hidden).map((a) => a.item.name).join(', ') },
      { label: 'DM-only notes', text: npcSecret(npc.id).text || '' },
    ] : []),
  ];
}

function handoutSearchFields(x) {
  const parent = x.parentKind === 'npc' ? state.npcs.get(x.parentId) : state.pins.get(x.parentId);
  return [
    { label: 'Name', text: x.title },
    { label: 'Text', text: x.transcription || '' },
    { label: x.parentKind === 'npc' ? 'NPC' : 'Place', text: parent?.name || '' },
  ];
}

function sessionSearchFields(x) {
  const notes = x.id === state.selectedSessionId ? state.sessionNotes : state.search.sessionTexts?.get(x.id)?.notes || [];
  return [
    { label: 'Name', text: x.title || '' },
    { label: 'Date', text: `${formatSessionDate(x.id)} ${x.id}` },
    ...notes.map((n) => ({ label: `Recap by ${n.authorName || n.authorEmail}`, text: n.text, also: n.authorName || n.authorEmail })),
  ];
}

function stopSearchFields(w, i) {
  return [
    { label: 'Stop', text: stopLabel(w) },
    { label: 'Date', text: w.sessionDate ? `${formatSessionDate(w.sessionDate)} ${w.sessionDate}` : '' },
    { label: 'Travel', text: i > 0 ? `${legMode(i).label} ${legMode(i).inline || ''}` : '' },
    { label: 'In-game', text: gameTimeLabel(w) },
  ];
}

function renderSearchResults() {
  const s = state.search;
  const status = $('search-status');
  const list = $('search-results');
  if (!status || !list) return;
  const terms = searchTerms(s.query);
  if (!terms.length || terms.join('').length < 2) {
    status.hidden = true; list.hidden = true; list.replaceChildren();
    return;
  }
  const results = [];
  if (s.scope.pins) {
    for (const pin of state.pins.values()) {
      const m = matchItem(pinSearchFields(pin), terms);
      if (m) results.push({ kind: 'pin', pin, m, rank: m.nameHit ? 0 : 1 });
    }
  }
  if (s.scope.npcs) {
    for (const npc of state.npcs.values()) {
      const m = matchItem(npcSearchFields(npc), terms);
      if (m) results.push({ kind: 'npc', npc, m, rank: m.nameHit ? 0 : 1 });
    }
  }
  for (const x of state.handouts.values()) {
    if (!(x.parentKind === 'npc' ? s.scope.npcs : s.scope.pins)) continue;
    const m = matchItem(handoutSearchFields(x), terms);
    if (m) results.push({ kind: 'handout', handout: x, m, rank: m.nameHit ? 0 : 1 });
  }
  if (s.scope.sessions) {
    for (const x of state.sessions.values()) {
      const m = matchItem(sessionSearchFields(x), terms);
      if (m) results.push({ kind: 'session', session: x, m, rank: 2 });
    }
  }
  if (s.scope.stops) {
    state.waypoints.forEach((w, i) => {
      const m = matchItem(stopSearchFields(w, i), terms);
      if (m) results.push({ kind: 'stop', w, i, m, rank: 2 });
    });
  }
  results.sort((a, b) => a.rank - b.rank
    || (a.kind === 'stop' && b.kind === 'stop' ? b.i - a.i : 0)
    || (a.kind !== b.kind ? (a.kind === 'pin' ? -1 : 1) : 0)
    || ((a.pin || a.npc) && (b.pin || b.npc) ? (a.pin || a.npc).name.localeCompare((b.pin || b.npc).name) : 0)
    || (a.session && b.session ? b.session.id.localeCompare(a.session.id) : 0));

  const parts = [];
  if (!s.scope.pins && !s.scope.npcs && !s.scope.stops && !s.scope.sessions) parts.push('Tick at least one of Pins and notes, NPCs, Route stops or Sessions to search.');
  else {
    parts.push(results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matches');
    if ((s.scope.pins || s.scope.npcs || s.scope.sessions) && s.loading) parts.push('loading notes…');
  }
  status.textContent = parts.join(', ');
  status.hidden = false;

  list.replaceChildren(...results.slice(0, SEARCH_LIMIT).map((r) => {
    const more = r.m.count > 1 ? ` (+${r.m.count - 1} more)` : '';
    if (r.kind === 'pin') {
      return h('li', {}, h('button', { type: 'button', class: 'search-hit', onclick: () => showPinFromSearch(r.pin.id) },
        h('span', { class: 'search-title' },
          h('span', { class: 'search-kind' }, 'Pin'), r.pin.name,
          r.pin.visibility === 'hidden' ? h('span', { class: 'search-hidden' }, 'hidden') : null),
        r.m.field ? h('span', { class: 'search-snippet' }, h('span', { class: 'search-field' }, `${r.m.field.label}${more}: `), snippet(r.m.field.text, terms)) : null));
    }
    if (r.kind === 'handout' || r.kind === 'session') {
      const title = r.kind === 'handout' ? r.handout.title : (r.session.title ? `${formatSessionDate(r.session.id)}: ${r.session.title}` : formatSessionDate(r.session.id));
      const hidden = r.kind === 'handout' && r.handout.visibility !== 'public';
      return h('li', {}, h('button', { type: 'button', class: 'search-hit', onclick: () => (r.kind === 'handout' ? openViewer(r.handout.id) : openSession(r.session.id)) },
        h('span', { class: 'search-title' }, h('span', { class: 'search-kind' }, r.kind === 'handout' ? 'Handout' : 'Session'), title,
          hidden ? h('span', { class: 'search-hidden' }, 'hidden') : null),
        r.m.field ? h('span', { class: 'search-snippet' }, h('span', { class: 'search-field' }, `${r.m.field.label}${more}: `), snippet(r.m.field.text, terms)) : null));
    }
    if (r.kind === 'npc') {
      return h('li', {}, h('button', { type: 'button', class: 'search-hit', onclick: () => openNpc(r.npc.id) },
        h('span', { class: 'search-title' },
          h('span', { class: 'search-kind' }, 'NPC'), r.npc.name,
          r.npc.visibility === 'hidden' ? h('span', { class: 'search-hidden' }, 'hidden') : null),
        r.m.field ? h('span', { class: 'search-snippet' }, h('span', { class: 'search-field' }, `${r.m.field.label}${more}: `), snippet(r.m.field.text, terms)) : null));
    }
    return h('li', {}, h('button', { type: 'button', class: 'search-hit', onclick: () => showStopFromSearch(r.w) },
      h('span', { class: 'search-title' }, h('span', { class: 'search-kind' }, `Stop ${r.i + 1}`), stopLabel(r.w)),
      h('span', { class: 'search-snippet' },
        [r.w.sessionDate ? formatSessionDate(r.w.sessionDate) : '', r.i > 0 && modeIdOf(r.w) !== 'road' ? legMode(r.i).label : ''].filter(Boolean).join(' · '))));
  }));
  if (results.length > SEARCH_LIMIT) list.append(h('li', { class: 'empty' }, `Showing the first ${SEARCH_LIMIT}. Add a word to narrow it down.`));
  list.hidden = false;
}

function showPinFromSearch(id) {
  const pin = state.pins.get(id);
  if (!pin) return;
  if (isPhone()) setSide(false);
  openPin(id);
  if (!isPhone()) state.map?.flyTo(ll(pin.x, pin.y), Math.max(state.map.getZoom(), state.fitZoom + 1.5), { duration: 0.6 });
}

function showStopFromSearch(w) {
  showStopFromList(w, state.waypoints.indexOf(w));
}

// Centers the map on stop i and opens its leg popup once the move ends.
function showStopFromList(w, i) {
  if (!state.map) return;
  if (isPhone()) setSide(false);
  if (state.mode !== 'select') setMode('select');
  state.map.once('moveend', () => showLegPopup(i, ll(w.x, w.y)));
  state.map.flyTo(ll(w.x, w.y), Math.max(state.map.getZoom(), state.fitZoom + 1.5), { duration: 0.6 });
}

// ---------- route editing ----------
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Bend points clicked while drawing a leg (Add stop) or redrawing one.
function addDraftPoint(p) {
  state.draft.points.push(p);
  renderDraft(); renderModeHint();
}
function undoDraftPoint() {
  if (!state.draft?.points.length) return;
  state.draft.points.pop();
  renderDraft(); renderModeHint();
}

// Preview of the leg being drawn: from the stop before it, through the
// clicked points (and, when redrawing, on to the stop being redrawn).
function renderDraft() {
  if (!state.map) return;
  state.layers.draft ||= L.layerGroup().addTo(state.map);
  state.layers.draft.clearLayers();
  const d = state.draft;
  if (!d) return;
  let start = d.plan ? d.start : currentStop();
  let end = null;
  if (d.redrawId) {
    const i = state.waypoints.findIndex((w) => w.id === d.redrawId);
    start = state.waypoints[i - 1];
    end = state.waypoints[i];
  }
  const pts = [start, ...d.points, end].filter(Boolean).map((p) => ({ x: p.x, y: p.y }));
  if (pts.length > 1) {
    L.polyline(smoothPath(pts).map((p) => ll(p.x, p.y)), { color: '#ffffff', weight: 3, dashArray: '4 6', opacity: 0.95, interactive: false })
      .addTo(state.layers.draft);
  }
  d.points.forEach((p) => L.circleMarker(ll(p.x, p.y), { radius: 4, color: '#1f2a36', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false })
    .addTo(state.layers.draft));
}

// The pin a drawn point belongs to: the pin that was clicked, or any pin
// (including ones hidden by the legend filters) within 14 screen px.
function pinAtPoint(p) {
  if (p.pinId && state.pins.has(p.pinId)) return state.pins.get(p.pinId);
  if (!state.map) return null;
  const at = state.map.latLngToContainerPoint(ll(p.x, p.y));
  let best = null;
  let bestDist = 14;
  for (const pin of state.pins.values()) {
    const d = at.distanceTo(state.map.latLngToContainerPoint(ll(pin.x, pin.y)));
    if (d <= bestDist) { best = pin; bestDist = d; }
  }
  return best;
}

// Ends the leg being drawn at the last clicked point, linked to a pin if it is on one.
function finishStop() {
  const points = state.draft.points.map(({ x, y }) => ({ x, y }));
  const last = state.draft.points[state.draft.points.length - 1];
  if (!last) return;
  points.pop();
  const pin = pinAtPoint(last);
  const pos = pin ? { x: pin.x, y: pin.y } : { x: last.x, y: last.y };
  addStop(pos, pin, state.waypoints.length ? points : []);
}

async function saveRedraw() {
  const { redrawId } = state.draft;
  const points = state.draft.points.map(({ x, y }) => ({ x, y }));
  try {
    await state.backend.updateWaypoint(redrawId, { path: points });
    toast(points.length ? 'Road saved.' : 'Leg set to a straight line.', 'ok');
    setMode('select');
  } catch (err) {
    reportError(err); // stay in redraw mode with the points intact
  }
}

const TRAVEL_FIELD_HINT = 'Modes drawn as a direct arc go straight from the previous stop; any road points you clicked are dropped. A mode the party has not used before becomes visible to players with this stop.';
const travelOptions = () => (state.travelModes.size ? sortedModes() : [modeOf('road')])
  .map((m) => ({ value: m.id, label: `${m.label}${m.revealed ? '' : ' (first use: reveals it to players)'}` }));

// Saving a stop with a mode players have not seen yet reveals the mode.
function revealModeFor(travel) {
  const m = state.travelModes.get(travel);
  if (m && !m.revealed) attempt(() => state.backend.reveal('travelModes', travel));
}

// Travel days for a new leg from the current stop, for the in-game date suggestion.
function newLegDays(pos, path, travel) {
  const prev = currentStop();
  const mode = modeOf(travel);
  if (!prev || isInstant(mode)) return 0;
  const px = mode.line === 'arc' ? Math.hypot(pos.x - prev.x, pos.y - prev.y) : pathLength(smoothPath([{ x: prev.x, y: prev.y }, ...path, pos]));
  return Math.ceil((px * milesPerPixel()) / mainPace(mode));
}

// Resolves true when the stop was added. opts.travel preselects the travel mode.
async function addStop(pos, pin, path = [], opts = {}) {
  const startTravel = opts.travel || 'road';
  const vals = await formDialog({
    title: 'Add a stop to the route',
    submitLabel: 'Add stop',
    fields: [
      { name: 'label', label: 'Place name', value: pin?.name || '', hint: pin ? 'Linked to this pin.' : 'Leave blank for an unnamed stop.' },
      { name: 'sessionDate', label: 'Session date', type: 'date', value: todayIso() },
      state.waypoints.length ? { name: 'travel', label: 'How the party got here', type: 'select', value: startTravel, hint: TRAVEL_FIELD_HINT,
        options: travelOptions() } : null,
      ...gameTimeFields(null, currentStop(), newLegDays(pos, path, startTravel), todayIso()),
    ].filter(Boolean),
  });
  if (!vals) return false; // keeps the drawn points so the DM can carry on
  const game = readGameTime(vals);
  if (game.error) { toast(game.error, 'error'); return false; }
  const seq = (state.waypoints.length ? Math.max(...state.waypoints.map((w) => w.seq)) : 0) + 1;
  const travel = vals.travel || 'road';
  try {
    await state.backend.addWaypoint({ seq, x: pos.x, y: pos.y, path: modeOf(travel).line === 'arc' ? [] : path, travel,
      label: vals.label, sessionDate: vals.sessionDate, pinId: pin?.id || null, ...game.patch });
    revealModeFor(travel);
    toast('Stop added.', 'ok');
    if (state.draft && !state.draft.plan) { state.draft.points = []; renderDraft(); renderModeHint(); }
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

async function editStop(w) {
  const index = state.waypoints.findIndex((x) => x.id === w.id);
  const bends = Array.isArray(w.path) ? w.path.length : 0;
  const current = modeIdOf(w);
  const pathNow = modeOf(current).line === 'arc' ? 'direct arc' : bends ? `${bends} bend point${bends === 1 ? '' : 's'}` : 'straight line';
  const vals = await formDialog({
    title: 'Edit stop',
    submitLabel: 'Save stop',
    danger: 'Delete stop',
    fields: [
      { name: 'label', label: 'Place name', value: w.label || '' },
      { name: 'sessionDate', label: 'Session date', type: 'date', value: w.sessionDate || '' },
      index > 0 ? { name: 'travel', label: 'How the party got here', type: 'select', value: current, options: travelOptions(), hint: TRAVEL_FIELD_HINT } : null,
      index > 0 ? { name: 'road', label: `Line from the previous stop (now: ${pathNow})`, type: 'select', value: 'keep',
        options: [{ value: 'keep', label: 'Keep as is' }, { value: 'redraw', label: 'Redraw it on the map' }, { value: 'straight', label: 'Make it a straight line' }],
        hint: 'Applies to modes that follow a drawn path.' } : null,
      ...gameTimeFields(w, state.waypoints[index - 1], 0, w.sessionDate),
    ].filter(Boolean),
  });
  if (!vals) return;
  if (vals.__danger) {
    if (await confirmDialog(`Delete the stop "${stopLabel(w)}" from the route?`, 'Delete stop')) {
      await attempt(() => state.backend.deleteWaypoint(w.id), 'Stop deleted.');
    }
    return;
  }
  const game = readGameTime(vals);
  if (game.error) { toast(game.error, 'error'); return; }
  const update = { label: vals.label, sessionDate: vals.sessionDate, ...game.patch };
  const travel = vals.travel || current;
  const arc = modeOf(travel).line === 'arc';
  if (index > 0) update.travel = travel;
  if (arc || vals.road === 'straight') update.path = [];
  const redraw = vals.road === 'redraw' && !arc;
  if (vals.road === 'redraw' && arc) toast('That travel mode is drawn as a direct arc, so there is no road to redraw.');
  const saved = await attempt(() => state.backend.updateWaypoint(w.id, update).then(() => true), 'Stop saved.');
  if (saved && index > 0) revealModeFor(travel);
  if (redraw) {
    setMode('redraw', { points: [], redrawId: w.id });
    const prev = state.waypoints[index - 1];
    state.map?.flyToBounds(L.latLngBounds([ll(prev.x, prev.y), ll(w.x, w.y)]).pad(0.4), { duration: 0.6, maxZoom: state.fitZoom + 2 });
  }
}

// ---------- pin detail drawer ----------
function openPin(id) {
  if (state.selectedPinId !== id) {
    state.detailSubs.forEach((u) => u());
    state.detailSubs = [];
    state.notes = [];
    state.dmText = '';
    state.noteDraft = '';
    state.selectedNpcId = null;
    clearSessionSelection();
    state.selectedPinId = id;
    state.detailSubs.push(state.backend.watchNotes(id, (notes) => {
      state.notes = notes.sort((a, b) => noteTime(b) - noteTime(a));
      renderDetail(); renderSearchResults();
    }));
    if (isDM()) state.detailSubs.push(state.backend.watchDmText(id, (t) => { state.dmText = t; renderDetail(); }));
  }
  renderDetail();
  renderPins();
  keepPinVisible(state.pins.get(id));
  presentItem({ kind: 'pin', id });
}

// On phones the detail sheet covers the lower 62% of the screen; slide the
// map so the selected pin sits in the visible strip above it.
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
function keepPinVisible(pin) {
  if (!pin || !state.map || !isPhone()) return;
  const map = state.map;
  const zoom = Math.max(map.getZoom(), state.fitZoom + 1.5);
  const size = map.getSize();
  const visibleMidY = (size.y * 0.38) / 2;
  const p = map.project(ll(pin.x, pin.y), zoom).add([0, size.y / 2 - visibleMidY]);
  map.flyTo(map.unproject(p, zoom), zoom, { duration: 0.5 });
}

function noteTime(n) {
  const v = n.createdAt;
  if (!v) return Date.now(); // pending server timestamp: newest
  return v instanceof Date ? v.getTime() : v.toMillis?.() ?? 0;
}

function closeDetail() {
  state.detailSubs.forEach((u) => u());
  state.detailSubs = [];
  const had = state.selectedPinId;
  state.selectedPinId = null;
  const hadNpc = state.selectedNpcId;
  state.selectedNpcId = null;
  clearSessionSelection();
  $('detail').hidden = true;
  if (had) renderPins();
  if (hadNpc) renderNpcList();
  if (had || hadNpc) presentItem(null);
}

function renderDetail() {
  const panel = $('detail');
  if (state.selectedNpcId) { renderNpcDetail(panel); return; }
  if (state.selectedSessionId) { renderSessionDetail(panel); return; }
  const pin = state.pins.get(state.selectedPinId);
  if (!pin) { panel.hidden = true; return; }
  const { base, rings } = typesOf(pin);
  const visits = state.waypoints.filter((w) => w.pinId === pin.id);
  const myEmail = state.user.email;

  const badge = (t) => h('span', { class: 'badge' }, h('span', { class: 'swatch', html: typeSwatch(t) }), t.label);
  const meta = (n) => {
    const mine = n.authorEmail === myEmail;
    const edited = n.updatedAt && n.createdAt && noteTime({ createdAt: n.updatedAt }) - noteTime(n) > 60000;
    return h('div', { class: 'note-meta' },
      h('span', { class: 'note-author' }, n.authorName || n.authorEmail),
      h('span', {}, formatDate(n.createdAt) + (edited ? ' (edited)' : '')),
      h('span', { class: 'note-tools' },
        mine && !inPcView() ? h('button', { class: 'btn link', type: 'button', onclick: () => editNote(pin.id, n) }, 'Edit') : null,
        (mine && !inPcView()) || isDM() ? h('button', { class: 'btn link', type: 'button', onclick: () => deleteNote(pin.id, n) }, 'Delete') : null));
  };
  const byKind = (k) => state.notes.filter((n) => noteKind(n) === k);
  const leads = byKind('lead').sort((a, b) => (a.status === 'done') - (b.status === 'done'));
  const openLeads = leads.filter((n) => n.status !== 'done').length;
  const leadItems = leads.map((n) => {
    const done = n.status === 'done';
    return h('li', { class: `note lead${done ? ' done' : ''}` },
      h('label', { class: 'lead-check', title: done ? 'Mark as still open' : 'Mark as followed up' },
        h('input', { type: 'checkbox', checked: done, disabled: inPcView(), 'aria-label': done ? 'Followed up' : 'Open lead',
          onchange: (e) => attempt(() => state.backend.setLeadStatus(pin.id, n.id, e.target.checked ? 'done' : 'open')) }),
        h('span', { class: 'note-text' }, n.text)),
      meta(n));
  });
  // Entries from before NPCs were their own records. Shown until the DM
  // converts them (menu > Convert "People met" to NPCs) and removes them.
  const personItems = byKind('npc').sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((n) => h('li', { class: 'note' },
    h('div', { class: 'npc-name' }, n.name || 'Unnamed'),
    h('div', { class: 'note-text' }, n.text),
    meta(n)));
  const pinNpcs = npcsAtPin(pin.id);
  const noteItems = byKind('note').map((n) => h('li', { class: 'note' }, meta(n), h('div', { class: 'note-text' }, n.text)));

  const kind = ADDABLE_KINDS.includes(state.noteKind) ? state.noteKind : 'note';
  const textarea = h('textarea', { rows: '3', maxlength: '4000', placeholder: NOTE_KINDS[kind].placeholder, 'aria-label': NOTE_KINDS[kind].label,
    oninput: (e) => { state.noteDraft = e.target.value; } });
  textarea.value = state.noteDraft;
  const focusedTag = panel.contains(document.activeElement) ? document.activeElement.tagName : null;

  panel.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('h2', {}, pin.name),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: closeDetail,
        html: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' })),
    h('div', { class: 'badges' },
      base ? badge(base) : null,
      rings.map(badge),
      pin.visibility === 'hidden' ? h('span', { class: 'badge hidden-badge' }, 'Hidden from players') : null),
    visits.length ? h('p', { class: 'muted' },
      `Party visited ${visits.length === 1 ? 'once' : `${visits.length} times`}${visits.at(-1).sessionDate ? `, last on ${formatSessionDate(visits.at(-1).sessionDate)}` : ''}.`) : null,
    pin.description ? h('p', { class: 'desc' }, pin.description) : (isDM() ? h('p', { class: 'muted' }, 'No description yet.') : null),
    isDM() ? h('div', { class: 'dm-box' },
      h('div', { class: 'dm-label' }, 'DM only'),
      h('div', { class: 'dm-text' }, state.dmText || 'Nothing written yet.')) : null,
    isDM() ? h('div', { class: 'detail-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => editPin(pin.id) }, 'Edit pin'),
      h('button', { class: 'btn', type: 'button', onclick: () => addStop({ x: pin.x, y: pin.y }, pin) }, 'Party arrived here'),
      showPlayersButton({ kind: 'pin', id: pin.id }),
      h('button', { class: 'btn danger', type: 'button', onclick: () => deletePin(pin) }, 'Delete pin')) : null,
    h('h3', {}, 'Leads and rumors', leads.length ? h('span', { class: 'h-count' }, `${openLeads} open`) : null),
    leadItems.length ? h('ul', { class: 'notes' }, leadItems) : h('p', { class: 'muted' }, 'No leads yet.'),
    h('h3', {}, 'NPCs', pinNpcs.length ? h('span', { class: 'h-count' }, String(pinNpcs.length)) : null),
    pinNpcs.length ? h('ul', { class: 'npc-links' }, pinNpcs.map(({ npc, hiddenLink }) => npcRow(npc, { hiddenLink }))) : h('p', { class: 'muted' }, 'No NPCs linked here.'),
    isDM() ? h('div', { class: 'detail-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => editNpc(null, { pinId: pin.id }) }, 'New NPC here')) : null,
    ...handoutSection('pin', pin.id),
    personItems.length ? h('h3', {}, 'People met (older entries)') : null,
    personItems.length ? h('ul', { class: 'notes' }, personItems) : null,
    h('h3', {}, 'Party notes'),
    noteItems.length ? h('ul', { class: 'notes' }, noteItems) : h('p', { class: 'muted' }, 'No notes yet.'),
    inPcView() ? null : h('form', { class: 'note-form', onsubmit: (e) => { e.preventDefault(); addNote(pin.id); } },
      h('select', { 'aria-label': 'What to add', onchange: (e) => { state.noteKind = e.target.value; renderDetail(); } },
        ADDABLE_KINDS.map((k) => h('option', { value: k, selected: k === kind }, NOTE_KINDS[k].label))),
      textarea,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, NOTE_KINDS[kind].add))),
  ].filter(Boolean)); // replaceChildren would print null as text
  panel.hidden = false;
  if (focusedTag === 'TEXTAREA') textarea.focus();
}

// What can be added to a pin. Stored in the pin's notes with a `kind` field;
// older notes have no kind and count as 'note'.
const NOTE_KINDS = {
  note: { label: 'Note', add: 'Add note', placeholder: 'What did the party learn here?', noun: 'note' },
  lead: { label: 'Lead or rumor', add: 'Add lead', placeholder: 'A lead or rumor heard here', noun: 'lead' },
  npc: { label: 'Person met', add: 'Add person', placeholder: 'Who they are, what they wanted, how it went', noun: 'person' },
};
const noteKind = (n) => (NOTE_KINDS[n.kind] ? n.kind : 'note');
// "Person met" entries can still be edited and deleted, but new people are NPCs.
const ADDABLE_KINDS = ['note', 'lead'];

async function addNote(pinId) {
  const kind = ADDABLE_KINDS.includes(state.noteKind) ? state.noteKind : 'note';
  const text = state.noteDraft.trim();
  if (!text) { toast(`Write something before adding the ${NOTE_KINDS[kind].noun}.`); return; }
  const entry = { text, authorEmail: state.user.email, authorName: displayName(state.member, state.user.email) };
  if (kind !== 'note') entry.kind = kind;
  if (kind === 'lead') entry.status = 'open';
  try {
    await state.backend.addNote(pinId, entry);
    state.noteDraft = '';
    renderDetail();
  } catch (err) {
    reportError(err); // the draft stays in the box so nothing is lost
  }
}

async function editNote(pinId, note) {
  const kind = noteKind(note);
  const vals = await formDialog({
    title: `Edit ${NOTE_KINDS[kind].noun}`,
    submitLabel: 'Save',
    fields: [
      kind === 'npc' ? { name: 'name', label: 'Name', value: note.name || '' } : null,
      { name: 'text', label: kind === 'npc' ? 'About them' : NOTE_KINDS[kind].label, type: 'textarea', value: note.text, rows: 6 },
    ].filter(Boolean),
  });
  if (!vals || !vals.text) return;
  const fields = { text: vals.text };
  if (kind === 'npc') { if (!vals.name) { toast('Give the person a name.'); return; } fields.name = vals.name; }
  await attempt(() => state.backend.updateNote(pinId, note.id, fields), 'Saved.');
}

async function deleteNote(pinId, note) {
  const noun = NOTE_KINDS[noteKind(note)].noun;
  if (!(await confirmDialog(`Delete this ${noun}? This cannot be undone.`, `Delete ${noun}`))) return;
  await attempt(() => state.backend.deleteNote(pinId, note.id), 'Deleted.');
}

// ---------- NPCs ----------
// An NPC's public record holds the location and affiliation links players
// may see; hidden links and the DM's notes are in npcSecrets (DM only).
const npcSecret = (id) => state.npcSecrets.get(id) || {};
const statusLabel = (id) => NPC_STATUSES.find((x) => x.id === id)?.label || 'Unknown';
const byName = (a, b) => a.name.localeCompare(b.name);

// NPCs linked to a pin: [{ npc, hiddenLink }]. Players get only shown links
// on revealed NPCs (that is all they have); the DM also gets hidden links.
function npcsAtPin(pinId) {
  const out = [];
  for (const npc of state.npcs.values()) {
    if ((npc.pinIds || []).includes(pinId)) out.push({ npc, hiddenLink: false });
    else if (isDM() && (npcSecret(npc.id).hiddenPinIds || []).includes(pinId)) out.push({ npc, hiddenLink: true });
  }
  return out.sort((a, b) => byName(a.npc, b.npc));
}
// [{ item, hidden }] for an NPC's pins or affiliations that this person can see.
function npcLinks(npc, kind) {
  const shown = kind === 'pins' ? npc.pinIds : npc.affiliationIds;
  const hidden = isDM() ? (kind === 'pins' ? npcSecret(npc.id).hiddenPinIds : npcSecret(npc.id).hiddenAffiliationIds) : [];
  const source = kind === 'pins' ? state.pins : state.affiliations;
  return [...(shown || []).map((id) => ({ id, hidden: false })), ...(hidden || []).map((id) => ({ id, hidden: true }))]
    .map(({ id, hidden: h2 }) => ({ item: source.get(id), hidden: h2 }))
    .filter((x) => x.item)
    .sort((a, b) => (a.item.name || '').localeCompare(b.item.name || ''));
}
function affChip({ item, hidden }) {
  return h('span', { class: `aff-chip${hidden ? ' hidden-link' : ''}`, title: [item.description, hidden ? 'Hidden from players' : ''].filter(Boolean).join('\n') || null },
    h('span', { class: 'aff-dot', style: `background:${item.color}` }), item.name, hidden ? ' (hidden)' : '');
}
function statusChip(npc) {
  return h('span', { class: `status-chip status-${npc.status || 'unknown'}` }, statusLabel(npc.status));
}

function npcRow(npc, { hiddenLink = false } = {}) {
  return h('li', { class: npc.id === state.selectedNpcId ? 'selected' : '' },
    h('button', { class: `npc-row${npc.portrait ? ' with-portrait' : ''}`, type: 'button', onclick: () => openNpc(npc.id) },
      npc.portrait ? imageEl(npc.portrait, 'portrait-sm') : null,
      h('span', { class: 'npc-row-name' }, npc.name,
        npc.visibility === 'hidden' ? h('span', { class: 'search-hidden' }, 'hidden') : null,
        hiddenLink ? h('span', { class: 'search-hidden' }, 'hidden link') : null),
      h('span', { class: 'npc-row-meta' }, statusChip(npc), npcLinks(npc, 'affiliations').map(affChip))));
}

function renderSideTabs() {
  const tab = ['npcs', 'sessions'].includes(state.sideTab) ? state.sideTab : 'map';
  document.querySelectorAll('#side-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('map-pane').hidden = tab !== 'map';
  $('npc-pane').hidden = tab !== 'npcs';
  $('session-pane').hidden = tab !== 'sessions';
}

function renderNpcList() {
  const box = $('npc-pane');
  if (!box || !state.role) return;
  $('npc-tab-count').textContent = state.npcs.size ? String(state.npcs.size) : '';
  const affs = [...state.affiliations.values()].sort(byName);
  if (state.npcFilter && !state.affiliations.has(state.npcFilter)) state.npcFilter = '';
  const list = [...state.npcs.values()]
    .filter((n) => !state.npcFilter || npcLinks(n, 'affiliations').some((x) => x.item.id === state.npcFilter))
    .sort(byName);
  box.replaceChildren(...[
    affs.length ? h('label', { class: 'npc-filter' }, 'Affiliation ',
      h('select', { onchange: (e) => { state.npcFilter = e.target.value; renderNpcList(); } },
        h('option', { value: '' }, 'All'),
        affs.map((a) => h('option', { value: a.id, selected: a.id === state.npcFilter }, a.name)))) : null,
    list.length ? h('ul', { class: 'npc-list' }, list.map((n) => npcRow(n)))
      : h('p', { class: 'empty' }, state.npcs.size ? 'No NPCs with that affiliation.' : (isDM() ? 'No NPCs yet.' : 'The party has not met anyone yet.')),
    isDM() ? h('div', { class: 'detail-actions' }, h('button', { class: 'btn primary small', type: 'button', onclick: () => editNpc(null) }, 'Add NPC')) : null,
  ].filter(Boolean));
}

function openNpc(id) {
  if (state.selectedNpcId !== id) {
    state.detailSubs.forEach((u) => u());
    state.detailSubs = [];
    const hadPin = state.selectedPinId;
    state.selectedPinId = null;
    if (hadPin) renderPins();
    state.npcNotes = [];
    state.npcNoteDraft = '';
    clearSessionSelection();
    state.selectedNpcId = id;
    state.detailSubs.push(state.backend.watchNpcNotes(id, (notes) => {
      state.npcNotes = notes.sort((a, b) => noteTime(b) - noteTime(a));
      renderDetail(); renderSearchResults();
    }));
  }
  if (isPhone()) setSide(false);
  renderDetail();
  renderNpcList();
  presentItem({ kind: 'npc', id });
}

function noteMeta(n, onEdit, onDelete) {
  const mine = n.authorEmail === state.user.email;
  const edited = n.updatedAt && n.createdAt && noteTime({ createdAt: n.updatedAt }) - noteTime(n) > 60000;
  return h('div', { class: 'note-meta' },
    h('span', { class: 'note-author' }, n.authorName || n.authorEmail),
    h('span', {}, formatDate(n.createdAt) + (edited ? ' (edited)' : '')),
    h('span', { class: 'note-tools' },
      mine && !inPcView() ? h('button', { class: 'btn link', type: 'button', onclick: onEdit }, 'Edit') : null,
      (mine && !inPcView()) || isDM() ? h('button', { class: 'btn link', type: 'button', onclick: onDelete }, 'Delete') : null));
}

function renderNpcDetail(panel) {
  const npc = state.npcs.get(state.selectedNpcId);
  if (!npc) { panel.hidden = true; return; }
  const secret = npcSecret(npc.id);
  const places = npcLinks(npc, 'pins');
  const noteItems = state.npcNotes.map((n) => h('li', { class: 'note' },
    noteMeta(n, () => editNpcNote(npc.id, n), () => deleteNpcNote(npc.id, n)), h('div', { class: 'note-text' }, n.text)));
  const textarea = h('textarea', { rows: '3', maxlength: '4000', placeholder: 'What the party learned about them', 'aria-label': 'Note',
    oninput: (e) => { state.npcNoteDraft = e.target.value; } });
  textarea.value = state.npcNoteDraft;
  const refocus = panel.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
  panel.replaceChildren(...[
    h('div', { class: 'detail-head' },
      npc.portrait ? imageEl(npc.portrait, 'portrait') : null,
      h('h2', {}, npc.name),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: closeDetail,
        html: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' })),
    h('div', { class: 'badges' },
      h('span', { class: 'badge' }, 'NPC'),
      statusChip(npc),
      npcLinks(npc, 'affiliations').map(affChip),
      npc.visibility === 'hidden' ? h('span', { class: 'badge hidden-badge' }, 'Hidden from players') : null),
    npc.description ? h('p', { class: 'desc' }, npc.description) : h('p', { class: 'muted' }, isDM() ? 'No description yet. Players see the description once the NPC is revealed.' : 'No description yet.'),
    isDM() ? h('div', { class: 'dm-box' },
      h('div', { class: 'dm-label' }, 'DM only'),
      h('div', { class: 'dm-text' }, secret.text || 'Nothing written yet.')) : null,
    isDM() ? h('div', { class: 'detail-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => editNpc(npc) }, 'Edit NPC'),
      h('button', { class: 'btn', type: 'button', onclick: () => setPortrait(npc) }, npc.portrait ? 'Change portrait' : 'Set portrait'),
      showPlayersButton({ kind: 'npc', id: npc.id }),
      h('button', { class: 'btn danger', type: 'button', onclick: () => deleteNpc(npc) }, 'Delete NPC')) : null,
    h('h3', {}, 'Places'),
    places.length ? h('ul', { class: 'npc-links' }, places.map(({ item: pin, hidden }) => h('li', {},
      h('button', { class: 'npc-row', type: 'button', onclick: () => showPinFromSearch(pin.id) },
        h('span', { class: 'npc-row-name' }, pin.name,
          pin.visibility === 'hidden' ? h('span', { class: 'search-hidden' }, 'hidden pin') : null,
          hidden ? h('span', { class: 'search-hidden' }, 'hidden link') : null)))))
      : h('p', { class: 'muted' }, 'No places linked.'),
    ...handoutSection('npc', npc.id),
    h('h3', {}, 'Party notes'),
    noteItems.length ? h('ul', { class: 'notes' }, noteItems) : h('p', { class: 'muted' }, 'No notes yet.'),
    inPcView() ? null : h('form', { class: 'note-form', onsubmit: (e) => { e.preventDefault(); addNpcNote(npc.id); } },
      textarea,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Add note'))),
  ].filter(Boolean));
  panel.hidden = false;
  if (refocus) textarea.focus();
}

async function addNpcNote(npcId) {
  const text = state.npcNoteDraft.trim();
  if (!text) { toast('Write something before adding the note.'); return; }
  try {
    await state.backend.addNpcNote(npcId, { text, authorEmail: state.user.email, authorName: displayName(state.member, state.user.email) });
    state.npcNoteDraft = '';
    renderDetail();
  } catch (err) {
    reportError(err); // the draft stays in the box
  }
}
async function editNpcNote(npcId, note) {
  const vals = await formDialog({ title: 'Edit note', fields: [{ name: 'text', label: 'Note', type: 'textarea', value: note.text, rows: 6 }] });
  if (!vals || !vals.text) return;
  await attempt(() => state.backend.updateNpcNote(npcId, note.id, { text: vals.text }), 'Saved.');
}
async function deleteNpcNote(npcId, note) {
  if (!(await confirmDialog('Delete this note? This cannot be undone.', 'Delete note'))) return;
  await attempt(() => state.backend.deleteNpcNote(npcId, note.id), 'Deleted.');
}

// DM: create or edit an NPC. `pinId` pre-links a new NPC to that pin.
async function editNpc(npc, { pinId = null } = {}) {
  const secret = npc ? npcSecret(npc.id) : {};
  const pinOptions = [...state.pins.values()].sort(byName)
    .map((p) => ({ value: p.id, label: p.visibility === 'hidden' ? `${p.name} (hidden pin)` : p.name }));
  const affOptions = [...state.affiliations.values()].sort(byName)
    .map((a) => ({ value: a.id, label: a.name, swatch: `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${a.color}"/></svg>` }));
  const vals = await formDialog({
    title: npc ? `Edit ${npc.name}` : 'New NPC',
    submitLabel: npc ? 'Save NPC' : 'Add NPC',
    fields: [
      { name: 'name', label: 'Name', value: npc?.name || '', required: true },
      { name: 'status', label: 'Status', type: 'select', value: npc?.status || NPC_STATUSES[0].id, options: NPC_STATUSES.map((x) => ({ value: x.id, label: x.label })) },
      { name: 'visibility', label: 'Who can see this NPC', type: 'select', value: npc?.visibility || 'hidden',
        options: [{ value: 'hidden', label: 'Hidden from players' }, { value: 'public', label: 'Visible to players' }],
        hint: npc ? null : 'New NPCs start hidden. Reveal them when the party meets them.' },
      { name: 'description', label: 'Description (what the party knows on meeting them; players see this)', type: 'textarea', value: npc?.description || '', rows: 4 },
      { name: 'dmText', label: 'DM-only notes', type: 'textarea', value: secret.text || '', rows: 3 },
      { name: 'places', label: 'Places', type: 'links', options: pinOptions,
        value: { shown: npc ? npc.pinIds || [] : [pinId].filter(Boolean), hidden: secret.hiddenPinIds || [] },
        hint: 'Tick each place they are tied to. "Hidden" keeps that link from players. Links to hidden pins stay invisible to players until the pin is revealed.' },
      { name: 'affiliations', label: 'Affiliations', type: 'links', options: affOptions,
        value: { shown: npc?.affiliationIds || [], hidden: secret.hiddenAffiliationIds || [] },
        hint: affOptions.length ? 'An affiliation shown on a visible NPC becomes known to players.' : 'No affiliations yet: add them from the menu (NPC affiliations).' },
    ],
  });
  if (!vals) return;
  if (!vals.name) { toast('An NPC needs a name.', 'error'); return; }
  const data = {
    name: vals.name, status: vals.status, visibility: vals.visibility, description: vals.description,
    pinIds: vals.places.shown, affiliationIds: vals.affiliations.shown, portrait: npc?.portrait || null,
  };
  const newSecret = {
    text: vals.dmText, hiddenPinIds: vals.places.hidden, hiddenAffiliationIds: vals.affiliations.hidden,
    sourceNotes: secret.sourceNotes || [],
  };
  const id = await attempt(() => state.backend.saveNpc(npc?.id || null, data, newSecret, state.user.email), npc ? 'NPC saved.' : 'NPC added.');
  if (id) openNpc(id);
}

async function deleteNpc(npc) {
  if (!(await confirmDialog(`Delete "${npc.name}" with all notes and handouts on them? This cannot be undone.`, 'Delete NPC'))) return;
  closeDetail();
  await deleteHandoutsOf('npc', npc.id);
  await attempt(() => state.backend.deleteNpc(npc.id), 'NPC deleted.');
  if (npc.portrait?.imageId) attempt(() => state.backend.deleteImage(npc.portrait.imageId));
}

// ---------- NPC affiliations (DM) ----------
function affiliationUses(id) {
  return [...state.npcs.values()].filter((n) => (n.affiliationIds || []).includes(id) || (npcSecret(n.id).hiddenAffiliationIds || []).includes(id)).length;
}
async function editAffiliation(aff) {
  const vals = await formDialog({
    title: aff ? `Edit ${aff.name}` : 'New affiliation',
    submitLabel: aff ? 'Save' : 'Add affiliation',
    fields: [
      { name: 'name', label: 'Name', value: aff?.name || '', required: true },
      { name: 'color', label: 'Color', type: 'color', value: aff?.color || '#5b6b7a' },
      { name: 'description', label: 'Description (players see it once the affiliation is known)', type: 'textarea', value: aff?.description || '', rows: 3 },
      { name: 'revealed', label: 'Known to players (ticked automatically when it shows on a visible NPC)', type: 'checkbox', value: aff?.revealed || false },
    ],
  });
  if (!vals || !vals.name) return;
  const id = aff?.id || state.backend.newId('affiliations');
  await attempt(() => state.backend.saveAffiliation(id, { name: vals.name, color: vals.color, description: vals.description, revealed: vals.revealed }),
    aff ? 'Affiliation saved.' : 'Affiliation added.');
}
async function deleteAffiliation(aff) {
  const used = affiliationUses(aff.id);
  const msg = used ? `"${aff.name}" is on ${used} NPC${used === 1 ? '' : 's'}; it disappears from them. Delete it?` : `Delete the affiliation "${aff.name}"?`;
  if (!(await confirmDialog(msg, 'Delete'))) return;
  await attempt(() => state.backend.deleteAffiliation(aff.id), 'Affiliation deleted.');
}
function openAffiliations() {
  const body = h('div');
  const render = () => {
    const affs = [...state.affiliations.values()].sort(byName);
    body.replaceChildren(
      affs.length ? h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Players'), h('th', {}, 'NPCs'), h('th', {}, ''))),
        h('tbody', {}, affs.map((a) => h('tr', {},
          h('td', {}, h('span', { class: 'aff-dot', style: `background:${a.color}` })),
          h('td', {}, a.name, a.description ? h('div', { class: 'hint' }, a.description) : null),
          h('td', {}, a.revealed ? 'Known' : 'Not yet'),
          h('td', {}, String(affiliationUses(a.id))),
          h('td', { style: 'text-align:right;white-space:nowrap' },
            h('button', { class: 'btn small', type: 'button', onclick: () => editAffiliation(a) }, 'Edit'), ' ',
            h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteAffiliation(a) }, 'Delete')))))) :
        h('p', { class: 'muted' }, 'No affiliations yet.'),
      h('p', { class: 'hint' }, 'Players see an affiliation once it is a visible (not hidden) link on an NPC they can see, or when you tick "Known to players".'),
      h('div', { class: 'detail-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => editAffiliation(null) }, 'Add affiliation')));
  };
  render();
  const { dlg } = panelDialog('NPC affiliations', body, { wide: true });
  trackDialog(dlg, render);
}

// ---------- travel modes (DM) ----------
const modeUses = (id) => state.waypoints.filter((w, i) => i > 0 && modeIdOf(w) === id).length;
async function editTravelMode(mode) {
  const pace = (id) => mode?.paces?.[id] ?? null;
  const vals = await formDialog({
    title: mode ? `Edit ${mode.label}` : 'New travel mode',
    submitLabel: mode ? 'Save' : 'Add travel mode',
    fields: [
      { name: 'label', label: 'Name (legend and menus)', value: mode?.label || '', required: true },
      { name: 'inline', label: 'In a sentence: "By ___"', value: mode?.inline || '', hint: 'For example "ship" or "Harper teleport". Leave blank to use the name.' },
      { name: 'color', label: 'Line color', type: 'color', value: mode?.color || '#2a7fb8' },
      { name: 'line', label: 'Drawn as', type: 'select', value: mode?.line || 'path',
        options: [{ value: 'path', label: 'A path you click along (road, river)' }, { value: 'arc', label: 'A direct arc between stops (teleport, flight, sea crossing)' }] },
      { name: 'dash', label: 'Line style', type: 'select', value: mode?.dash || 'dash',
        options: [{ value: 'dash', label: 'Dashed' }, { value: 'dot', label: 'Dotted' }, { value: 'solid', label: 'Solid' }] },
      ...TRAVEL_PACES.map((p) => ({ name: `pace_${p.id}`, label: `${p.label} pace (miles a day)`, type: 'number', step: 'any', value: pace(p.id) })),
      { name: 'sortOrder', label: 'Order in the legend', type: 'number', value: mode?.sortOrder ?? (state.travelModes.size + 1) },
      { name: 'revealed', label: 'Visible to players (ticked automatically when a stop first uses it)', type: 'checkbox', value: mode?.revealed || false },
    ],
    intro: h('p', { class: 'hint' }, 'Fill in the paces this mode should show; leave the others blank. With no pace at all the leg has no distance or travel time, like a teleport.'),
  });
  if (!vals || !vals.label) return;
  const paces = {};
  for (const p of TRAVEL_PACES) { const v = vals[`pace_${p.id}`]; if (v > 0) paces[p.id] = v; }
  const id = mode?.id || state.backend.newId('travelModes');
  const data = { label: vals.label, inline: vals.inline || vals.label, color: vals.color, line: vals.line, dash: vals.dash, paces,
    sortOrder: vals.sortOrder ?? 99, revealed: vals.revealed };
  await attempt(() => state.backend.saveTravelMode(id, data), mode ? 'Travel mode saved.' : 'Travel mode added.');
}
async function deleteTravelMode(mode) {
  if (mode.id === 'road') { toast('The road mode is the default for stops and cannot be deleted. Rename or restyle it instead.'); return; }
  const used = modeUses(mode.id);
  if (used) { toast(`"${mode.label}" is used by ${used} route stop${used === 1 ? '' : 's'}. Change those stops first.`, 'error'); return; }
  if (!(await confirmDialog(`Delete the travel mode "${mode.label}"?`, 'Delete'))) return;
  await attempt(() => state.backend.deleteTravelMode(mode.id), 'Travel mode deleted.');
}
function openTravelModes() {
  const body = h('div');
  const render = () => {
    const modes = sortedModes();
    body.replaceChildren(
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Miles a day'), h('th', {}, 'Players'), h('th', {}, ''))),
        h('tbody', {}, modes.map((m) => h('tr', {},
          h('td', {}, h('span', { class: 'swatch', html: modeSwatch(m) })),
          h('td', {}, m.label),
          h('td', {}, isInstant(m) ? 'No travel time' : modePaces(m).map((p) => `${p.label.toLowerCase()} ${p.milesPerDay}`).join(', ')),
          h('td', {}, m.revealed ? `Shown${modeUses(m.id) ? '' : ' (unused)'}` : 'Hidden until used'),
          h('td', { style: 'text-align:right;white-space:nowrap' },
            h('button', { class: 'btn small', type: 'button', onclick: () => editTravelMode(m) }, 'Edit'), ' ',
            m.id === 'road' ? null : h('button', { class: 'btn small danger', type: 'button', onclick: () => deleteTravelMode(m) }, 'Delete')))))),
      h('p', { class: 'hint' }, 'Players see a travel mode in the legend only after a route stop uses it.'),
      h('div', { class: 'detail-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => editTravelMode(null) }, 'Add travel mode')));
  };
  render();
  const { dlg } = panelDialog('Travel modes', body, { wide: true });
  trackDialog(dlg, render);
}

// ---------- converting old "person met" entries (DM, one time) ----------
// Each entry becomes a hidden NPC linked to its pin, with the entry's text as
// a party note under its original author. The NPC's secret record lists the
// entry it came from, so running this again skips it, and the old entries
// are removed only in a second, separate step.
async function convertPeopleMet() {
  toast('Reading notes on every pin…');
  const texts = await attempt(() => state.backend.readPinTexts([...state.pins.keys()], true));
  if (!texts) return;
  const entries = [];
  for (const [pinId, { notes }] of texts) for (const n of notes) if (noteKind(n) === 'npc') entries.push({ pinId, note: n });
  const done = new Set([...state.npcSecrets.values()].flatMap((x) => x.sourceNotes || []));
  const key = (e) => `${e.pinId}/${e.note.id}`;
  const todo = entries.filter((e) => !done.has(key(e)));
  const converted = entries.filter((e) => done.has(key(e)));
  if (!entries.length) { toast('No "People met" entries left on any pin.', 'ok'); return; }

  if (todo.length) {
    const ok = await confirmDialog(
      `${todo.length} "People met" entr${todo.length === 1 ? 'y' : 'ies'} not yet converted (${entries.length} in all). Each becomes a hidden NPC linked to its pin, with the entry's text as a party note by its original author. The old entries stay until you remove them. Convert now?`,
      `Convert ${todo.length}`, { danger: false });
    if (!ok) return;
    const ops = [];
    for (const e of todo) {
      const id = state.backend.newId('npcs');
      const n = e.note;
      ops.push({ op: 'set', path: ['npcs', id], data: { name: (n.name || 'Unnamed').slice(0, 100), status: NPC_STATUSES[0].id, visibility: 'hidden',
        description: '', pinIds: [e.pinId], affiliationIds: [], updatedBy: state.user.email } });
      ops.push({ op: 'set', path: ['npcSecrets', id], data: { text: '', hiddenPinIds: [], hiddenAffiliationIds: [], sourceNotes: [key(e)] } });
      const note = { text: n.text, authorEmail: n.authorEmail, authorName: n.authorName || n.authorEmail };
      if (n.createdAt) note.createdAt = n.createdAt;
      if (n.updatedAt) note.updatedAt = n.updatedAt;
      ops.push({ op: 'set', path: ['npcs', id, 'notes', n.id], data: note });
    }
    if (!(await attempt(() => state.backend.applyOps(ops).then(() => true)))) return;
    toast(`Converted ${todo.length}. Check the new NPCs (hidden, in the NPCs tab), merge any duplicates, then reveal them.`, 'ok');
    state.sideTab = 'npcs'; writePref('sideTab', 'npcs'); renderSideTabs();
    return;
  }
  const remove = await confirmDialog(
    `All ${converted.length} "People met" entr${converted.length === 1 ? 'y has' : 'ies have'} been converted to NPCs. Remove the old entries from their pins? Do this once the NPCs look right. This cannot be undone (a backup can restore them).`,
    `Remove ${converted.length}`);
  if (!remove) return;
  await attempt(() => state.backend.applyOps(converted.map((e) => ({ op: 'delete', path: ['pins', e.pinId, 'notes', e.note.id] }))),
    'Old "People met" entries removed.');
}

// ---------- presenter sync ----------
// The DM's own window (Present on) writes what it shows to presenter/state;
// windows with Follow DM on (PC view by default) apply it. Only things
// players can see are ever sent, and followers open them with their own
// (player) data, so a hidden item can never reach the projector.
const PRESENT_THROTTLE_MS = 1000;
let presentTimer = null;
let presentPending = null;
let presentLast = 0;

function currentView() {
  if (!state.map) return null;
  const b = state.map.getBounds();
  return { x1: Math.round(b.getWest()), y1: Math.round(-b.getNorth()), x2: Math.round(b.getEast()), y2: Math.round(-b.getSouth()) };
}
function currentItem() {
  if (state.viewerHandoutId) return { kind: 'handout', id: state.viewerHandoutId };
  if (state.selectedPinId) return { kind: 'pin', id: state.selectedPinId };
  if (state.selectedNpcId) return { kind: 'npc', id: state.selectedNpcId };
  if (state.selectedSessionId) return { kind: 'session', id: state.selectedSessionId };
  return null;
}
function playerVisible(item) {
  if (!item) return true;
  if (item.kind === 'pin') return state.pins.get(item.id)?.visibility === 'public';
  if (item.kind === 'npc') return state.npcs.get(item.id)?.visibility === 'public';
  if (item.kind === 'handout') return state.handouts.get(item.id)?.visibility === 'public';
  return item.kind === 'stop' || item.kind === 'session';
}
function writePresenter(patch) {
  if (!isDM()) return;
  presentPending = { ...(presentPending || {}), ...patch };
  const flush = () => {
    presentTimer = null;
    presentLast = Date.now();
    const p = presentPending;
    presentPending = null;
    const base = state.presenter || {};
    state.backend.setPresenter({ live: state.presenting, push: false, view: base.view || null, item: base.item ?? null, ...p, seq: Date.now() })
      .catch(reportError);
  };
  if (presentTimer) return;
  const wait = PRESENT_THROTTLE_MS - (Date.now() - presentLast);
  if (wait <= 0) flush(); else presentTimer = setTimeout(flush, wait);
}
// Called whenever the DM's window opens or closes something.
function presentItem(item) {
  if (!state.presenting || !isDM()) return;
  if (!playerVisible(item)) { toast('Not shown to players: that is hidden from them.'); return; }
  writePresenter({ item });
}
// "Show players": one item, now, whether or not Present is on.
function showPlayers(item) {
  if (!playerVisible(item)) { toast('That is hidden from players, so it was not shown.', 'error'); return; }
  let view = currentView();
  const at = item.kind === 'pin' ? state.pins.get(item.id) : item.kind === 'stop' ? state.waypoints.find((w) => w.id === item.id) : null;
  if (at && view) {
    const hw = (view.x2 - view.x1) / 2;
    const hh = (view.y2 - view.y1) / 2;
    view = { x1: at.x - hw, y1: at.y - hh, x2: at.x + hw, y2: at.y + hh };
  }
  writePresenter({ item, view, push: true });
  toast('Shown to players.', 'ok');
}
function setPresenting(on) {
  state.presenting = on && isDM();
  $('present-btn').setAttribute('aria-pressed', String(state.presenting));
  if (state.presenting) writePresenter({ live: true, view: currentView(), item: playerVisible(currentItem()) ? currentItem() : null });
  else if (isDM()) writePresenter({ live: false });
  renderPresenterChips();
}
function setFollow(on) {
  state.followDM = on;
  state.appliedSeq = 0;
  renderChrome();
  if (on) followPresenter();
}
function renderPresenterChips() {
  const chipP = $('present-chip');
  const chipF = $('follow-chip');
  if (!chipP || !chipF) return;
  chipP.hidden = !state.presenting;
  chipF.hidden = !(state.followDM && !isDM());
}
function followPresenter() {
  const p = state.presenter;
  if (!state.followDM || isDM() || !p || !(p.seq > state.appliedSeq)) return;
  const firstLook = !state.appliedSeq;
  state.appliedSeq = p.seq;
  // A window that starts following joins a live presentation, but does not
  // replay a one-off "Show players" from before it opened.
  if (!p.live && (!p.push || firstLook)) return;
  if (p.view && state.map) {
    state.map.flyToBounds(L.latLngBounds(ll(p.view.x1, p.view.y1), ll(p.view.x2, p.view.y2)), { duration: 0.6 });
  }
  const it = p.item;
  if (!it) { closeViewer(); closeDetail(); return; }
  if (it.kind === 'handout') { if (state.handouts.has(it.id)) openViewer(it.id); return; }
  closeViewer();
  if (it.kind === 'pin' && state.pins.has(it.id)) openPin(it.id);
  else if (it.kind === 'npc' && state.npcs.has(it.id)) openNpc(it.id);
  else if (it.kind === 'session' && state.sessions.has(it.id)) openSession(it.id);
  else if (it.kind === 'stop') {
    const i = state.waypoints.findIndex((w) => w.id === it.id);
    if (i >= 0) state.map?.once('moveend', () => showLegPopup(i, ll(state.waypoints[i].x, state.waypoints[i].y)));
  }
}
const showPlayersButton = (item) => (isDM()
  ? h('button', { class: 'btn', type: 'button', title: 'Put this on the players\' screen (PC view windows following you)', onclick: () => showPlayers(item) }, 'Show players')
  : null);

// ---------- planned routes ----------
// Party plans: any member draws them, everyone sees them. DM plans: the DM's
// prep, in a collection players cannot read.
function startPlan() {
  if (inPcView()) return;
  const party = currentStop();
  if (isPhone()) setSide(false);
  setMode('plan', { points: [], plan: true, start: party ? { x: party.x, y: party.y } : null });
}
function planDraftPoints() {
  const d = state.draft;
  if (!d?.plan) return [];
  return [d.start, ...d.points].filter(Boolean).map(({ x, y }) => ({ x, y }));
}
function planModeOptions(current) {
  const modes = state.travelModes.size ? sortedModes() : [modeOf('road')];
  return modes.map((m) => ({ value: m.id, label: m.label, selected: m.id === current }));
}
async function savePlanDraft() {
  const points = planDraftPoints();
  if (points.length < 2) { toast('Click at least one point along the way first.'); return; }
  const vals = await formDialog({
    title: 'Save planned route',
    submitLabel: 'Save plan',
    fields: [
      { name: 'name', label: 'Name', value: '', required: true, hint: 'For example "Coast road to the next town".' },
      { name: 'travel', label: 'Travel mode (for the distance and time estimate)', type: 'select', value: 'road', options: planModeOptions('road') },
      isDM() ? { name: 'who', label: 'Who can see it', type: 'select', value: 'dm',
        options: [{ value: 'dm', label: 'Only me (DM prep)' }, { value: 'party', label: 'Everyone (a party plan)' }] } : null,
    ].filter(Boolean),
  });
  if (!vals) return;
  if (!vals.name) { toast('A plan needs a name.', 'error'); return; }
  const dm = vals.who === 'dm';
  const data = { name: vals.name, points, travel: vals.travel || 'road', createdBy: state.user.email,
    createdByName: displayName(state.member, state.user.email) };
  if (await attempt(() => state.backend.savePlan(null, data, dm), dm ? 'DM plan saved.' : 'Plan saved.')) setMode('select');
}
function allPlans() {
  const party = [...state.plans.values()].map((p) => ({ ...p, dm: false }));
  const dm = isDM() ? [...state.dmPlans.values()].map((p) => ({ ...p, dm: true })) : [];
  return [...party, ...dm].sort((a, b) => a.name.localeCompare(b.name));
}
function planLine(plan) {
  const m = modeOf(plan.travel);
  const pts = plan.points || [];
  if (m.line === 'arc') return pts.slice(1).flatMap((p, i) => arcPoints(pts[i], p));
  return smoothPath(pts);
}
function planMiles(plan) {
  const m = modeOf(plan.travel);
  const pts = plan.points || [];
  const px = m.line === 'arc' ? pts.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0) : pathLength(smoothPath(pts));
  return px * milesPerPixel();
}
function renderPlans() {
  if (!state.map) return;
  state.layers.plans ||= L.layerGroup().addTo(state.map);
  state.layers.plans.clearLayers();
  if (!state.showPlans) return;
  const selecting = state.mode === 'select';
  for (const plan of allPlans()) {
    const m = modeOf(plan.travel);
    const pts = planLine(plan).map((p) => ll(p.x, p.y));
    if (pts.length < 2) continue;
    L.polyline(pts, { color: plan.dm ? '#7a2e2e' : '#1f2a36', weight: 6, opacity: 0.35, interactive: false }).addTo(state.layers.plans);
    const line = L.polyline(pts, { color: m.color, weight: 3, opacity: 0.85, dashArray: '2 9', lineCap: 'round', interactive: selecting })
      .bindTooltip(`${plan.dm ? 'DM plan' : 'Plan'}: ${plan.name}`, { className: 'pin-label', sticky: true });
    if (selecting) {
      L.polyline(pts, { color: '#000', weight: 16, opacity: 0, className: 'route-hit' })
        .on('click', (e) => { L.DomEvent.stopPropagation(e); showPlanPopup(plan, e.latlng); })
        .addTo(state.layers.plans);
    }
    line.addTo(state.layers.plans);
  }
}
function planCanEdit(plan) { return !inPcView() && (plan.dm ? isDM() : true); }
function showPlanPopup(plan, latlng) {
  const m = modeOf(plan.travel);
  const miles = planMiles(plan);
  const rows = [
    ['Who', plan.dm ? 'DM plan (players cannot see it)' : `Party plan by ${plan.createdByName || plan.createdBy}`],
    ['Travel', m.label],
  ];
  if (isInstant(m)) rows.push(['Time', 'No travel time']);
  else {
    rows.push(['Distance', fmtMiles(miles)]);
    rows.push(['Travel time', modePaces(m).map((p) => h('div', {}, `${fmtDays(miles, p.milesPerDay)}${modePaces(m).length > 1 ? ` at ${p.label.toLowerCase()} pace` : ''}`))]);
  }
  const body = h('div', { class: 'leg-popup' },
    h('div', { class: 'leg-title' }, plan.name),
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    planCanEdit(plan) ? h('div', { class: 'popup-actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { state.map.closePopup(); editPlan(plan); } }, 'Edit'),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => { state.map.closePopup(); deletePlan(plan); } }, 'Delete'),
      isDM() ? h('button', { class: 'btn small', type: 'button', onclick: () => { state.map.closePopup(); convertPlan(plan); } }, 'Party traveled this way') : null) : null);
  L.popup({ className: 'leg-popup-wrap', maxWidth: 300 }).setLatLng(latlng).setContent(body).openOn(state.map);
}
async function editPlan(plan) {
  const vals = await formDialog({
    title: `Edit ${plan.name}`,
    fields: [
      { name: 'name', label: 'Name', value: plan.name, required: true },
      { name: 'travel', label: 'Travel mode (for the estimate)', type: 'select', value: plan.travel, options: planModeOptions(plan.travel) },
    ],
  });
  if (!vals || !vals.name) return;
  const { id, dm, updatedAt, ...rest } = plan;
  await attempt(() => state.backend.savePlan(id, { ...rest, name: vals.name, travel: vals.travel || plan.travel }, dm), 'Plan saved.');
}
async function deletePlan(plan) {
  if (!(await confirmDialog(`Delete the plan "${plan.name}"?`, 'Delete plan'))) return;
  await attempt(() => state.backend.deletePlan(plan.id, plan.dm), 'Plan deleted.');
}
// DM: the party went this way. Adds one stop at the plan's end (bend points
// become its road), then removes the plan.
async function convertPlan(plan) {
  const pts = plan.points || [];
  const last = pts[pts.length - 1];
  const party = currentStop();
  const startsAtParty = party && pts[0] && Math.hypot(pts[0].x - party.x, pts[0].y - party.y) < 2;
  const path = pts.slice(startsAtParty ? 1 : 0, -1).map(({ x, y }) => ({ x, y }));
  const pin = pinAtPoint(last);
  const added = await addStop(pin ? { x: pin.x, y: pin.y } : { x: last.x, y: last.y }, pin, state.waypoints.length ? path : [], { travel: plan.travel });
  if (added) await attempt(() => state.backend.deletePlan(plan.id, plan.dm));
}
function renderPlanList() {
  const box = $('plan-list');
  if (!box || !state.role) return;
  const plans = allPlans();
  box.replaceChildren(
    ...plans.map((p) => h('li', {}, h('button', { class: 'route-stop', type: 'button', onclick: () => {
      const pts = planLine(p).map((x) => ll(x.x, x.y));
      if (!state.map || pts.length < 2) return;
      if (isPhone()) setSide(false);
      state.map.once('moveend', () => showPlanPopup(p, pts[pts.length - 1]));
      state.map.flyToBounds(L.latLngBounds(pts).pad(0.3), { duration: 0.6 });
    } },
    h('span', { class: 'route-name' }, p.name, p.dm ? h('span', { class: 'search-hidden' }, 'DM only') : null),
    h('span', { class: 'route-date' }, isInstant(modeOf(p.travel)) ? modeOf(p.travel).label : `${fmtMiles(planMiles(p))}, about ${fmtDays(planMiles(p), mainPace(modeOf(p.travel)))}`)))),
    ...(plans.length ? [] : [h('li', { class: 'empty' }, 'No planned routes.')]),
  );
  $('plan-btn').hidden = inPcView();
}

// ---------- session log ----------
const SESSION_ID = /^\d{4}-\d{2}-\d{2}$/;
const sessionCreating = new Set();
// The DM's app adds a session for every play date the route uses.
function syncSessions() {
  if (!isDM() || !state.sessionsLoaded) return;
  for (const w of state.waypoints) {
    const d = w.sessionDate;
    if (!SESSION_ID.test(d || '') || state.sessions.has(d) || sessionCreating.has(d)) continue;
    sessionCreating.add(d);
    state.backend.saveSession(d, { title: '' }).catch(reportError).finally(() => sessionCreating.delete(d));
  }
}
const sessionStops = (id) => state.waypoints.map((w, i) => ({ w, i })).filter(({ w }) => w.sessionDate === id);
const sortedSessions = () => [...state.sessions.values()].sort((a, b) => b.id.localeCompare(a.id));
const localIsoDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function renderSessionList() {
  const box = $('session-pane');
  if (!box || !state.role) return;
  $('session-tab-count').textContent = state.sessions.size ? String(state.sessions.size) : '';
  const list = sortedSessions();
  box.replaceChildren(...[
    list.length ? h('ul', { class: 'npc-list' }, list.map((x) => {
      const stops = sessionStops(x.id).length;
      return h('li', { class: x.id === state.selectedSessionId ? 'selected' : '' },
        h('button', { class: 'npc-row', type: 'button', onclick: () => openSession(x.id) },
          h('span', { class: 'npc-row-name' }, formatSessionDate(x.id)),
          h('span', { class: 'npc-row-meta muted-note' }, [x.title, stops ? `${stops} stop${stops === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))));
    })) : h('p', { class: 'empty' }, 'No sessions yet. Each play date on the route gets one automatically.'),
    isDM() ? h('div', { class: 'detail-actions' }, h('button', { class: 'btn primary small', type: 'button', onclick: addSession }, 'Add session')) : null,
  ].filter(Boolean));
}
function clearSessionSelection() {
  if (!state.selectedSessionId) return;
  state.selectedSessionId = null;
  state.layers?.sessionHighlight?.clearLayers();
  renderSessionList();
}
function openSession(id) {
  if (state.selectedSessionId !== id) {
    state.detailSubs.forEach((u) => u());
    state.detailSubs = [];
    const hadPin = state.selectedPinId;
    state.selectedPinId = null;
    state.selectedNpcId = null;
    if (hadPin) renderPins();
    state.sessionNotes = [];
    state.sessionSecret = '';
    state.sessionNoteDraft = '';
    state.selectedSessionId = id;
    state.detailSubs.push(state.backend.watchSessionNotes(id, (notes) => {
      state.sessionNotes = notes.sort((a, b) => noteTime(a) - noteTime(b));
      renderDetail(); renderSearchResults();
    }));
    if (isDM()) state.detailSubs.push(state.backend.watchSessionSecret(id, (t) => { state.sessionSecret = t; renderDetail(); }));
    ensureSearchTexts(); // for "written that day"
  }
  if (isPhone()) setSide(false);
  highlightSession(id);
  renderDetail();
  renderSessionList();
  presentItem({ kind: 'session', id });
}
function highlightSession(id) {
  if (!state.map) return;
  state.layers.sessionHighlight ||= L.layerGroup().addTo(state.map);
  state.layers.sessionHighlight.clearLayers();
  const pts = [];
  for (const { w, i } of sessionStops(id)) {
    pts.push(ll(w.x, w.y));
    if (i === 0) continue;
    const line = legPoints(state.waypoints, i, legMode(i).line).map((p) => ll(p.x, p.y));
    pts.push(...line);
    L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.45, interactive: false }).addTo(state.layers.sessionHighlight);
  }
  if (pts.length && !state.followDM) state.map.flyToBounds(L.latLngBounds(pts).pad(0.4), { duration: 0.6, maxZoom: state.fitZoom + 2 });
}
// Notes, leads and NPC notes written on that date (from the search cache).
function writtenThatDay(id) {
  const out = [];
  for (const [pinId, t] of state.search.texts || []) {
    for (const n of t.notes || []) if (n.createdAt && localIsoDate(noteTime(n)) === id) out.push({ n, where: state.pins.get(pinId)?.name, open: () => openPin(pinId) });
  }
  for (const [npcId, t] of state.search.npcTexts || []) {
    for (const n of t.notes || []) if (n.createdAt && localIsoDate(noteTime(n)) === id) out.push({ n, where: state.npcs.get(npcId)?.name, open: () => openNpc(npcId) });
  }
  return out.filter((x) => x.where).sort((a, b) => noteTime(a.n) - noteTime(b.n));
}
function renderSessionDetail(panel) {
  const x = state.sessions.get(state.selectedSessionId);
  if (!x) { panel.hidden = true; return; }
  const stops = sessionStops(x.id);
  const pins = [...new Set(stops.map(({ w }) => w.pinId).filter((id) => state.pins.has(id)))].map((id) => state.pins.get(id));
  const npcs = [...new Map(pins.flatMap((p) => npcsAtPin(p.id)).map(({ npc }) => [npc.id, npc])).values()].sort(byName);
  const written = writtenThatDay(x.id);
  const linkList = (items) => h('ul', { class: 'npc-links' }, items.map(([label, sub, fn]) => h('li', {},
    h('button', { class: 'npc-row', type: 'button', onclick: fn }, h('span', { class: 'npc-row-name' }, label), sub ? h('span', { class: 'npc-row-meta muted-note' }, sub) : null))));
  const textarea = h('textarea', { rows: '3', maxlength: '4000', placeholder: 'What happened this session', 'aria-label': 'Recap', oninput: (e) => { state.sessionNoteDraft = e.target.value; } });
  textarea.value = state.sessionNoteDraft;
  const refocus = panel.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
  panel.replaceChildren(...[
    h('div', { class: 'detail-head' },
      h('h2', {}, x.title || 'Session'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: closeDetail,
        html: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' })),
    h('div', { class: 'badges' }, h('span', { class: 'badge' }, 'Session'), h('span', { class: 'badge' }, formatSessionDate(x.id))),
    isDM() ? h('div', { class: 'dm-box' }, h('div', { class: 'dm-label' }, 'DM only'), h('div', { class: 'dm-text' }, state.sessionSecret || 'Nothing written yet.')) : null,
    isDM() ? h('div', { class: 'detail-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => editSession(x) }, 'Edit session'),
      showPlayersButton({ kind: 'session', id: x.id })) : null,
    h('h3', {}, 'Recap'),
    state.sessionNotes.length ? h('ul', { class: 'notes' }, state.sessionNotes.map((n) => h('li', { class: 'note' },
      noteMeta(n, () => editSessionNote(x.id, n), () => deleteSessionNote(x.id, n)), h('div', { class: 'note-text' }, n.text))))
      : h('p', { class: 'muted' }, 'No recap yet.'),
    inPcView() ? null : h('form', { class: 'note-form', onsubmit: (e) => { e.preventDefault(); addSessionNote(x.id); } },
      textarea, h('div', {}, h('button', { class: 'btn primary', type: 'button', onclick: () => addSessionNote(x.id) }, 'Add to recap'))),
    h('h3', {}, 'Route that day'),
    stops.length ? linkList(stops.map(({ w, i }) => [`${i + 1}. ${stopLabel(w)}`, i > 0 ? legLine(w, i) : 'Start of the route', () => showStopFromList(w, i)]))
      : h('p', { class: 'muted' }, 'No route stops on this date.'),
    pins.length ? h('h3', {}, 'Places') : null,
    pins.length ? linkList(pins.map((p) => [p.name, null, () => showPinFromSearch(p.id)])) : null,
    npcs.length ? h('h3', {}, 'NPCs there') : null,
    npcs.length ? linkList(npcs.map((n) => [n.name, statusLabel(n.status), () => openNpc(n.id)])) : null,
    h('h3', {}, 'Written that day'),
    state.search.loading && !state.search.texts ? h('p', { class: 'muted' }, 'Loading notes…')
      : written.length ? linkList(written.map(({ n, where, open }) => [`${where}: ${n.text.length > 80 ? `${n.text.slice(0, 80)}…` : n.text}`, n.authorName || n.authorEmail, open]))
        : h('p', { class: 'muted' }, 'No notes, leads or NPC notes dated that day.'),
  ].filter(Boolean));
  panel.hidden = false;
  if (refocus) textarea.focus();
}
async function addSession() {
  const vals = await formDialog({
    title: 'Add a session',
    submitLabel: 'Add session',
    fields: [
      { name: 'date', label: 'Play date', type: 'date', value: todayIso(), required: true },
      { name: 'title', label: 'Title (optional)', value: '' },
    ],
  });
  if (!vals || !SESSION_ID.test(vals.date || '')) return;
  if (state.sessions.has(vals.date)) { openSession(vals.date); return; }
  if (await attempt(() => state.backend.saveSession(vals.date, { title: vals.title }).then(() => true), 'Session added.')) openSession(vals.date);
}
async function editSession(x) {
  const vals = await formDialog({
    title: `Session of ${formatSessionDate(x.id)}`,
    submitLabel: 'Save',
    danger: 'Delete session',
    fields: [
      { name: 'title', label: 'Title', value: x.title || '' },
      { name: 'dmText', label: 'DM-only notes', type: 'textarea', value: state.sessionSecret, rows: 5 },
    ],
  });
  if (!vals) return;
  if (vals.__danger) {
    const stops = sessionStops(x.id).length;
    const msg = `Delete this session and its recap?${stops ? ` Its ${stops} route stop${stops === 1 ? '' : 's'} stay; the session comes back (empty) while any stop has this date.` : ''}`;
    if (await confirmDialog(msg, 'Delete session')) { closeDetail(); await attempt(() => state.backend.deleteSession(x.id), 'Session deleted.'); }
    return;
  }
  await attempt(async () => {
    await state.backend.saveSession(x.id, { title: vals.title });
    if (vals.dmText !== state.sessionSecret) await state.backend.setSessionSecret(x.id, vals.dmText);
  }, 'Session saved.');
}
async function addSessionNote(id) {
  const text = state.sessionNoteDraft.trim();
  if (!text) { toast('Write something before adding it to the recap.'); return; }
  try {
    await state.backend.addSessionNote(id, { text, authorEmail: state.user.email, authorName: displayName(state.member, state.user.email) });
    state.sessionNoteDraft = '';
    renderDetail();
  } catch (err) { reportError(err); }
}
async function editSessionNote(id, note) {
  const vals = await formDialog({ title: 'Edit recap', fields: [{ name: 'text', label: 'Recap', type: 'textarea', value: note.text, rows: 6 }] });
  if (!vals || !vals.text) return;
  await attempt(() => state.backend.updateSessionNote(id, note.id, { text: vals.text }), 'Saved.');
}
async function deleteSessionNote(id, note) {
  if (!(await confirmDialog('Delete this part of the recap? This cannot be undone.', 'Delete'))) return;
  await attempt(() => state.backend.deleteSessionNote(id, note.id), 'Deleted.');
}

// ---------- images (NPC portraits, handouts) ----------
// An image reference is { imageId } (uploaded, stored in Firestore) or
// { url, crop } (an outside address; crop is { x, y, w, h } as fractions of
// the image, applied when shown because another site's image cannot be
// re-saved). Uploaded images are cropped and shrunk before upload.
const imageCache = new Map(); // imageId -> Promise of a data URL (or null)
function imageData(id) {
  if (!imageCache.has(id)) imageCache.set(id, state.backend.getImage(id).catch(() => null));
  return imageCache.get(id);
}
function cropCanvas(img, c, maxSide = 2000) {
  const sw = c.w * img.naturalWidth;
  const sh = c.h * img.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * k));
  cv.height = Math.max(1, Math.round(sh * k));
  cv.getContext('2d').drawImage(img, c.x * img.naturalWidth, c.y * img.naturalHeight, sw, sh, 0, 0, cv.width, cv.height);
  return cv;
}
// A box showing the image (CSS sizes it); a "?" if it cannot be loaded.
function imageEl(ref, cls = '') {
  const box = h('span', { class: `img-box ${cls}` });
  if (!ref) return box;
  const fail = () => box.replaceChildren(h('span', { class: 'img-missing', title: 'The image could not be loaded.' }, '?'));
  if (ref.imageId) {
    imageData(ref.imageId).then((src) => (src ? box.replaceChildren(h('img', { src, alt: '' })) : fail()));
  } else if (ref.url) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.onload = () => box.replaceChildren(ref.crop ? cropCanvas(img, ref.crop) : img);
    img.onerror = fail;
    img.src = ref.url;
  }
  return box;
}
// Draws the crop at no more than maxW x maxH and encodes it small enough for
// one Firestore document (1 MiB): WebP where the browser can, else JPEG.
function encodeImage(img, c, maxW, maxH) {
  const sw = c.w * img.naturalWidth;
  const sh = c.h * img.naturalHeight;
  let k = Math.min(1, maxW / sw, maxH / sh);
  for (let tries = 0; tries < 6; tries++) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(sw * k));
    cv.height = Math.max(1, Math.round(sh * k));
    cv.getContext('2d').drawImage(img, c.x * img.naturalWidth, c.y * img.naturalHeight, sw, sh, 0, 0, cv.width, cv.height);
    let type = 'image/webp';
    let data = cv.toDataURL(type, 0.85);
    if (!data.startsWith('data:image/webp')) { type = 'image/jpeg'; data = cv.toDataURL(type, 0.85); }
    for (const q of [0.7, 0.55]) if (data.length > 900000) data = cv.toDataURL(type, q);
    if (data.length <= 900000) return { data, width: cv.width, height: cv.height };
    k *= 0.75;
  }
  throw new Error('That image is too detailed to store even when shrunk. Try a smaller crop.');
}

// Choose an image: upload a file or link an address, then pan and zoom it in
// the frame. aspect 1 = square (portraits); null keeps the image's shape.
// Resolves to { imageId } | { url, crop } | { remove: true } | null.
function pickImage({ title, aspect = null, current = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog wide' });
    let img = null;
    let source = null;
    let nw = 0, nh = 0, fw = 0, fh = 0, s0 = 1, z = 1, ox = 0, oy = 0;
    const imgEl = h('img', { class: 'crop-img', alt: '', draggable: 'false' });
    const frame = h('div', { class: 'crop-frame' }, imgEl);
    const zoom = h('input', { type: 'range', min: '1', max: '5', step: '0.01', value: '1', disabled: true, 'aria-label': 'Zoom' });
    const status = h('p', { class: 'hint' }, 'Choose a file, or paste the address of an image on the web.');
    const fileInput = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Image file' });
    const urlInput = h('input', { type: 'url', placeholder: 'https://example.com/picture.png', 'aria-label': 'Image address' });
    const copyBox = h('input', { type: 'checkbox' });
    const saveBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Save image');
    const scale = () => s0 * z;
    const clamp = () => {
      ox = Math.min(0, Math.max(fw - nw * scale(), ox));
      oy = Math.min(0, Math.max(fh - nh * scale(), oy));
    };
    const paint = () => {
      imgEl.style.width = `${nw * scale()}px`;
      imgEl.style.height = `${nh * scale()}px`;
      imgEl.style.transform = `translate(${ox}px, ${oy}px)`;
    };
    const crop = () => {
      const r = (v) => Math.round(v * 10000) / 10000;
      return { x: r(-ox / (nw * scale())), y: r(-oy / (nh * scale())), w: r(fw / (nw * scale())), h: r(fh / (nh * scale())) };
    };
    const setZoom = (nz) => {
      const cx = (fw / 2 - ox) / scale();
      const cy = (fh / 2 - oy) / scale();
      z = Math.min(5, Math.max(1, nz));
      zoom.value = String(z);
      ox = fw / 2 - cx * scale();
      oy = fh / 2 - cy * scale();
      clamp(); paint();
    };
    const load = (src, kind, startCrop = null) => {
      const i = new Image();
      if (kind === 'url') i.referrerPolicy = 'no-referrer';
      i.onload = () => {
        img = i; source = kind; nw = i.naturalWidth; nh = i.naturalHeight;
        const box = Math.min(420, window.innerWidth - 80);
        if (aspect) { fw = box; fh = box / aspect; } else { const k = Math.min(box / nw, 360 / nh); fw = nw * k; fh = nh * k; }
        frame.style.width = `${fw}px`;
        frame.style.height = `${fh}px`;
        s0 = Math.max(fw / nw, fh / nh);
        imgEl.src = src;
        if (startCrop) {
          z = Math.max(1, fw / (startCrop.w * nw) / s0);
          ox = -startCrop.x * nw * scale();
          oy = -startCrop.y * nh * scale();
        } else { z = 1; ox = (fw - nw * s0) / 2; oy = (fh - nh * s0) / 2; }
        zoom.value = String(z);
        zoom.disabled = false;
        saveBtn.disabled = false;
        clamp(); paint();
        status.classList.remove('warn');
        status.textContent = `${nw} × ${nh} px. Drag the picture to move it; use the slider or the scroll wheel to zoom.`;
      };
      i.onerror = () => { status.textContent = kind === 'url' ? 'That address did not load as an image. Check it opens in a new tab, and that the site allows embedding.' : 'That file is not an image this browser can open.'; };
      i.src = src;
    };
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) load(URL.createObjectURL(f), 'file'); });
    const loadUrl = () => { const u = urlInput.value.trim(); if (/^https?:\/\//i.test(u)) load(u, 'url'); else status.textContent = 'Enter an address starting with https://'; };
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadUrl(); } });
    zoom.addEventListener('input', () => setZoom(Number(zoom.value)));
    frame.addEventListener('wheel', (e) => { if (!img) return; e.preventDefault(); setZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
    let drag = null;
    frame.addEventListener('pointerdown', (e) => { if (!img) return; drag = { x: e.clientX, y: e.clientY, ox, oy }; frame.setPointerCapture(e.pointerId); });
    frame.addEventListener('pointermove', (e) => { if (!drag) return; ox = drag.ox + e.clientX - drag.x; oy = drag.oy + e.clientY - drag.y; clamp(); paint(); });
    frame.addEventListener('pointerup', () => { drag = null; });
    frame.addEventListener('pointercancel', () => { drag = null; });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    // Another site's image can be copied only if that site allows it (CORS):
    // reload it in CORS mode; the browser refuses the load, or the canvas
    // export, when the site does not.
    const corsCopy = (url) => new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.referrerPolicy = 'no-referrer';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('blocked'));
      i.src = url;
    });
    const NO_COPY = 'That site does not allow other web pages to copy its images. Untick "Store a copy" to save it as a link, or download the image and upload the file.';
    saveBtn.addEventListener('click', async () => {
      if (!img) return;
      if (source === 'url' && !copyBox.checked) { close({ url: urlInput.value.trim(), crop: crop() }); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        let src = img;
        if (source === 'url') {
          try { src = await corsCopy(urlInput.value.trim()); } catch { throw new Error(NO_COPY); }
        }
        let out;
        try {
          out = aspect ? encodeImage(src, crop(), 512, 512 / aspect) : encodeImage(src, crop(), 2000, 2000);
        } catch (err) {
          if (err?.name === 'SecurityError') throw new Error(NO_COPY);
          throw err;
        }
        const imageId = await state.backend.saveImage(out);
        close({ imageId });
      } catch (err) {
        // Shown inside the dialog: a toast would sit behind it.
        console.error(err);
        status.textContent = explainError(err);
        status.classList.add('warn');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save image';
      }
    });
    dlg.append(
      h('h2', {}, title),
      h('div', { class: 'field' }, h('label', {}, 'Upload a file (shrunk before upload, stored with the map)'), fileInput),
      h('div', { class: 'field' }, h('label', {}, 'Or use an image on the web'),
        h('div', { class: 'add-row' }, urlInput, h('button', { type: 'button', class: 'btn', onclick: loadUrl }, 'Load')),
        h('label', { class: 'check' }, copyBox, 'Store a copy with the map (keeps working if the original disappears; only works if that site allows copying)'),
        h('p', { class: 'hint' }, 'Unticked, only the address is saved: anyone with it can open the image, and it breaks if the site removes it.')),
      h('div', { class: 'crop-wrap' }, frame),
      h('label', { class: 'crop-zoom' }, 'Zoom ', zoom),
      status,
      h('div', { class: 'dialog-actions' },
        current ? h('button', { type: 'button', class: 'btn danger', onclick: () => close({ remove: true }) }, 'Remove image') : null,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel'),
        saveBtn));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    if (current?.url) { urlInput.value = current.url; load(current.url, 'url', current.crop); }
  });
}

const npcFields = (npc) => ({
  name: npc.name, status: npc.status || NPC_STATUSES[0].id, visibility: npc.visibility, description: npc.description || '',
  pinIds: npc.pinIds || [], affiliationIds: npc.affiliationIds || [], portrait: npc.portrait || null,
});
async function setPortrait(npc) {
  const r = await pickImage({ title: `Portrait of ${npc.name}`, aspect: 1, current: npc.portrait });
  if (!r) return;
  const portrait = r.remove ? null : r;
  const saved = await attempt(() => state.backend.saveNpc(npc.id, { ...npcFields(npc), portrait }, npcSecret(npc.id), state.user.email), r.remove ? 'Portrait removed.' : 'Portrait saved.');
  const old = npc.portrait?.imageId;
  if (saved && old && old !== portrait?.imageId) attempt(() => state.backend.deleteImage(old));
}

// ---------- handouts ----------
const handoutRef = (x) => (x.imageId ? { imageId: x.imageId } : x.url ? { url: x.url, crop: x.crop || null } : null);
function handoutParentVisible(x) {
  const parent = x.parentKind === 'npc' ? state.npcs.get(x.parentId) : state.pins.get(x.parentId);
  return parent?.visibility === 'public';
}
function handoutsFor(kind, id) {
  return [...state.handouts.values()].filter((x) => x.parentKind === kind && x.parentId === id)
    .sort((a, b) => noteTime(a) - noteTime(b) || a.title.localeCompare(b.title));
}
// The DM's app keeps each handout's `visibility` (what players can read) in
// step with its own switch and its pin's or NPC's visibility.
function syncHandoutVisibility() {
  if (!isDM()) return;
  for (const x of state.handouts.values()) {
    const want = x.revealed && handoutParentVisible(x) ? 'public' : 'hidden';
    const key = `handouts/${x.id}`;
    if (x.visibility === want || state.revealing.has(key)) continue;
    state.revealing.add(key);
    state.backend.setHandoutVisibility(x.id, want).catch(reportError).finally(() => state.revealing.delete(key));
  }
}
function handoutSection(kind, id) {
  const list = handoutsFor(kind, id);
  if (!list.length && !isDM()) return [];
  return [
    h('h3', {}, 'Handouts', list.length ? h('span', { class: 'h-count' }, String(list.length)) : null),
    list.length ? h('ul', { class: 'handout-list' }, list.map((x) => h('li', {},
      h('button', { class: 'handout-card', type: 'button', onclick: () => openViewer(x.id) },
        handoutRef(x) ? imageEl(handoutRef(x), 'thumb') : h('span', { class: 'img-box thumb doc-icon', 'aria-hidden': 'true' }, '¶'),
        h('span', { class: 'handout-title' }, x.title,
          isDM() && x.visibility !== 'public' ? h('span', { class: 'search-hidden' }, x.revealed ? 'hidden with its place' : 'hidden') : null))))) : null,
    isDM() ? h('div', { class: 'detail-actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => editHandout(null, kind, id) }, 'Add handout')) : null,
  ];
}
async function editHandout(x, parentKind, parentId) {
  const hasImage = !!(x && handoutRef(x));
  const vals = await formDialog({
    title: x ? `Edit ${x.title}` : 'New handout',
    submitLabel: x ? 'Save handout' : 'Next',
    fields: [
      { name: 'title', label: 'Title', value: x?.title || '', required: true },
      { name: 'transcription', label: 'Text (a transcription, so search finds its words; optional)', type: 'textarea', value: x?.transcription || '', rows: 5 },
      { name: 'revealed', label: 'Players can see it (once its place or NPC is visible to them)', type: 'checkbox', value: x?.revealed || false },
      { name: 'image', label: 'Image', type: 'select', value: hasImage ? 'keep' : (x ? 'none' : 'choose'),
        options: hasImage
          ? [{ value: 'keep', label: 'Keep the current image' }, { value: 'choose', label: 'Choose a new image…' }, { value: 'none', label: 'Remove the image' }]
          : [{ value: 'choose', label: 'Choose an image…' }, { value: 'none', label: 'No image (text only)' }] },
    ],
  });
  if (!vals) return;
  if (!vals.title) { toast('A handout needs a title.', 'error'); return; }
  let image = hasImage ? { imageId: x.imageId || null, url: x.url || null, crop: x.crop || null } : { imageId: null, url: null, crop: null };
  if (vals.image === 'choose') {
    const r = await pickImage({ title: `Image for ${vals.title}`, aspect: null, current: x && x.url ? { url: x.url, crop: x.crop } : null });
    if (r === null) return; // cancelled: nothing saved
    image = r.remove ? { imageId: null, url: null, crop: null } : { imageId: r.imageId || null, url: r.url || null, crop: r.crop || null };
  } else if (vals.image === 'none') image = { imageId: null, url: null, crop: null };
  const pk = x?.parentKind || parentKind;
  const pid = x?.parentId || parentId;
  const draft = { revealed: vals.revealed, parentKind: pk, parentId: pid };
  const data = { title: vals.title, transcription: vals.transcription, parentKind: pk, parentId: pid, revealed: vals.revealed,
    visibility: vals.revealed && handoutParentVisible(draft) ? 'public' : 'hidden', ...image };
  if (x?.createdAt) data.createdAt = x.createdAt;
  const id = await attempt(() => state.backend.saveHandout(x?.id || null, data), x ? 'Handout saved.' : 'Handout added.');
  if (id && x?.imageId && x.imageId !== image.imageId) attempt(() => state.backend.deleteImage(x.imageId));
}
async function deleteHandout(x) {
  if (!(await confirmDialog(`Delete the handout "${x.title}"? This cannot be undone.`, 'Delete handout'))) return;
  closeViewer(true);
  await attempt(() => state.backend.deleteHandout(x.id), 'Handout deleted.');
  if (x.imageId) attempt(() => state.backend.deleteImage(x.imageId));
}
// Deleting a pin or NPC also deletes its handouts (and their images).
async function deleteHandoutsOf(kind, id) {
  for (const x of handoutsFor(kind, id)) {
    await attempt(() => state.backend.deleteHandout(x.id));
    if (x.imageId) await attempt(() => state.backend.deleteImage(x.imageId));
  }
}

function openViewer(id) {
  state.viewerHandoutId = id;
  renderViewer();
  presentItem({ kind: 'handout', id });
}
function closeViewer(byUser = false) {
  if (!state.viewerHandoutId) return;
  state.viewerHandoutId = null;
  const v = $('viewer');
  if (v) { v.hidden = true; v.replaceChildren(); }
  // Followers close the handout too; if the DM's panel shows something
  // hidden, they go back to the plain map rather than keep the handout.
  if (byUser) { const it = currentItem(); presentItem(playerVisible(it) ? it : null); }
}
function renderViewer() {
  const v = $('viewer');
  if (!v) return;
  const x = state.handouts.get(state.viewerHandoutId);
  if (!x) { v.hidden = true; v.replaceChildren(); return; }
  const parent = x.parentKind === 'npc' ? state.npcs.get(x.parentId) : state.pins.get(x.parentId);
  const ref = handoutRef(x);
  const pic = ref ? imageEl(ref, 'viewer-img') : null;
  if (pic) pic.addEventListener('click', () => pic.classList.toggle('zoomed'));
  v.replaceChildren(h('div', { class: 'viewer-card', role: 'dialog', 'aria-label': x.title },
    h('div', { class: 'detail-head' },
      h('h2', {}, x.title),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => closeViewer(true),
        html: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' })),
    h('div', { class: 'badges' },
      parent ? h('span', { class: 'badge' }, `${x.parentKind === 'npc' ? 'NPC' : 'Place'}: ${parent.name}`) : null,
      isDM() && x.visibility !== 'public' ? h('span', { class: 'badge hidden-badge' }, x.revealed ? 'Hidden: its place or NPC is hidden' : 'Hidden from players') : null,
      ref ? h('span', { class: 'muted-note' }, 'Click the image to zoom.') : null),
    pic ? h('div', { class: 'viewer-pic' }, pic) : null,
    x.transcription ? h('div', { class: 'viewer-text' }, x.transcription) : null,
    isDM() ? h('div', { class: 'detail-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => editHandout(x) }, 'Edit handout'),
      showPlayersButton({ kind: 'handout', id: x.id }),
      h('button', { class: 'btn danger', type: 'button', onclick: () => deleteHandout(x) }, 'Delete')) : null));
  v.hidden = false;
}

// ---------- in-game time ----------
// The DM picks one scheme per campaign (In-game time… in the account menu);
// the real session date is kept regardless.
const timeScheme = () => state.settings?.timeScheme || 'session';
const gameCalendar = () => state.settings?.calendar || null;
function gameTimeLabel(w) {
  if (!w) return '';
  switch (timeScheme()) {
    case 'calendar': {
      const cal = gameCalendar();
      if (!cal || !isValidDate(cal, w.gameDate)) return '';
      const wd = weekdayName(cal, w.gameDate);
      return `${wd ? `${wd}, ` : ''}${formatGameDate(cal, w.gameDate)}`;
    }
    case 'day': return Number.isFinite(w.gameDay) ? `Day ${w.gameDay}` : '';
    case 'sessionNumber': return Number.isFinite(w.gameDay) ? `Session ${w.gameDay}` : '';
    case 'text': return w.gameDateText || '';
    default: return '';
  }
}
function gameDayNumber(w) {
  if (!w) return null;
  if (timeScheme() === 'calendar') { const cal = gameCalendar(); return cal && isValidDate(cal, w.gameDate) ? dayNumber(cal, w.gameDate) : null; }
  if (timeScheme() === 'day') return Number.isFinite(w.gameDay) ? w.gameDay : null;
  return null;
}
// In-game days from stop i-1 to stop i, or null.
function gameDaysInto(i) {
  if (i < 1) return null;
  const a = gameDayNumber(state.waypoints[i - 1]);
  const b = gameDayNumber(state.waypoints[i]);
  return a == null || b == null ? null : b - a;
}
// Form fields for a stop's in-game time. `prev` is the stop before it;
// `suggestDays` the travel days to add for a new stop's suggestion.
function gameTimeFields(w, prev, suggestDays, sessionDate) {
  const scheme = timeScheme();
  const hint = w || !prev ? null : `Suggested: the previous stop plus ${suggestDays} day${suggestDays === 1 ? '' : 's'} of travel. Change it if the party rested or detoured.`;
  if (scheme === 'calendar') {
    const cal = gameCalendar();
    if (!cal) return [];
    let d = w?.gameDate;
    if (!w && prev && isValidDate(cal, prev.gameDate)) d = addDays(cal, prev.gameDate, suggestDays);
    return [
      { name: 'gameYear', label: `In-game year${cal.yearSuffix ? ` (${cal.yearSuffix})` : ''}`, type: 'number', value: d?.year ?? '', hint },
      { name: 'gamePeriod', label: 'Month or festival', type: 'select', value: String(d?.period ?? 0),
        options: cal.periods.map((p, i) => ({ value: String(i), label: `${p.name}${p.festival ? ' (festival)' : ''}` })) },
      { name: 'gameDayOf', label: 'Day', type: 'number', value: d?.day ?? '' },
    ];
  }
  if (scheme === 'day') {
    const v = w ? w.gameDay : (prev && Number.isFinite(prev.gameDay) ? prev.gameDay + suggestDays : '');
    return [{ name: 'gameNumber', label: 'Campaign day', type: 'number', value: v ?? '', hint }];
  }
  if (scheme === 'sessionNumber') {
    const v = w ? w.gameDay : (prev && Number.isFinite(prev.gameDay) ? prev.gameDay + (prev.sessionDate !== sessionDate ? 1 : 0) : 1);
    return [{ name: 'gameNumber', label: 'Session number', type: 'number', value: v ?? '' }];
  }
  if (scheme === 'text') return [{ name: 'gameText', label: 'In-game time', value: w?.gameDateText || '', hint: 'Any text, e.g. "The night of the storm".' }];
  return [];
}
// Turns those fields back into stop fields. Returns { patch } or { error }.
function readGameTime(vals) {
  const scheme = timeScheme();
  if (scheme === 'calendar') {
    const cal = gameCalendar();
    if (!cal || vals.gameYear == null || vals.gameDayOf == null) return { patch: { gameDate: null } };
    const d = { year: Math.trunc(vals.gameYear), period: Number(vals.gamePeriod), day: Math.trunc(vals.gameDayOf) };
    if (!isValidDate(cal, d)) {
      const max = periodDays(cal, d.period, d.year);
      return { error: max ? `${cal.periods[d.period].name} ${d.year} has days 1 to ${max}.` : `${cal.periods[d.period].name} does not occur in ${d.year}.` };
    }
    return { patch: { gameDate: d } };
  }
  if (scheme === 'day' || scheme === 'sessionNumber') return { patch: { gameDay: vals.gameNumber == null ? null : Math.trunc(vals.gameNumber) } };
  if (scheme === 'text') return { patch: { gameDateText: (vals.gameText || '').slice(0, 100) } };
  return { patch: {} };
}
function calendarFromPreset(key) {
  if (key === 'site') return structuredClone(SITE_CALENDAR);
  if (key === 'current') return structuredClone(gameCalendar());
  if (key === 'custom') return { name: 'Custom calendar', yearSuffix: '', periods: [{ name: 'Firstmonth', days: 30 }], leap: null, week: { length: 7, names: [] } };
  return structuredClone(CALENDAR_PRESETS[key]);
}
const stopsWithGameTime = () => state.waypoints.filter((w) => w.gameDate || Number.isFinite(w.gameDay) || w.gameDateText).length;
async function openTimeSettings() {
  const cal = gameCalendar();
  const presetOptions = [
    cal ? { value: 'current', label: `Keep the current calendar (${cal.name})` } : null,
    SITE_CALENDAR ? { value: 'site', label: `${SITE_CALENDAR.name} (this site's own)` } : null,
    ...Object.entries(CALENDAR_PRESETS).map(([k, c]) => ({ value: k, label: c.name })),
    { value: 'custom', label: 'Start a custom calendar' },
  ].filter(Boolean);
  const vals = await formDialog({
    title: 'In-game time on route stops',
    submitLabel: 'Next',
    intro: h('p', { class: 'hint' }, 'Pick one way to mark in-game time for the whole campaign. The real session date is always kept as well.'),
    fields: [
      { name: 'scheme', label: 'Stops show', type: 'select', value: timeScheme(), options: TIME_SCHEMES.map((t) => ({ value: t.id, label: t.label })) },
      { name: 'preset', label: 'Calendar (for "In-game calendar")', type: 'select', value: presetOptions[0].value, options: presetOptions },
    ],
  });
  if (!vals) return;
  const scheme = vals.scheme;
  let calendar = cal;
  if (scheme === 'calendar') {
    calendar = await editCalendar(calendarFromPreset(vals.preset));
    if (!calendar) return;
  }
  const used = stopsWithGameTime();
  if (scheme !== timeScheme() && used) {
    const convertible = new Set(['calendar', 'day']);
    if (convertible.has(scheme) && convertible.has(timeScheme()) && (scheme === 'day' ? cal : calendar)) {
      const ok = await convertGameTime(timeScheme(), scheme, scheme === 'day' ? cal : calendar);
      if (ok === null) return;
    } else if (!(await confirmDialog(`${used} route stop${used === 1 ? ' has' : 's have'} in-game times in the current scheme. They stay on the stops but are not shown under the new scheme until you re-enter them. Switch anyway?`, 'Switch', { danger: false }))) return;
  } else if (scheme === 'calendar' && cal && used && JSON.stringify(cal.periods) !== JSON.stringify(calendar.periods)) {
    if (!(await confirmDialog('Changing the months or festivals keeps each stop\'s entered date (year, month number, day) but can change the days between stops. Save the calendar?', 'Save calendar', { danger: false }))) return;
  }
  await attempt(() => state.backend.saveSettings({ ...state.settings, timeScheme: scheme, calendar: calendar || null }), 'In-game time settings saved.');
}
// Edits a calendar (name, suffix, periods as text, leap rule, week). Resolves to the calendar or null.
async function editCalendar(cal) {
  const weekNames = (cal.week?.names || []).join(', ');
  const anchor = cal.week?.anchor;
  const vals = await formDialog({
    title: `Calendar: ${cal.name}`,
    submitLabel: 'Use this calendar',
    fields: [
      { name: 'name', label: 'Name', value: cal.name, required: true },
      { name: 'yearSuffix', label: 'Year label (DR, CY, AR...)', value: cal.yearSuffix || '' },
      { name: 'periods', label: 'Months and festivals, in order: one per line, name then days; add "festival" for festival days and "leap N" for days added in leap years', type: 'textarea', value: periodsToText(cal), rows: 12 },
      { name: 'leapEvery', label: 'Leap year every N years (0 = no leap years)', type: 'number', value: cal.leap?.every || 0 },
      { name: 'leapOffset', label: 'Leap years are those where (year − this number) divides evenly by N', type: 'number', value: cal.leap?.offset || 0 },
      { name: 'weekLength', label: 'Days in a week (or tenday)', type: 'number', value: cal.week?.length || 7 },
      { name: 'weekNames', label: 'Weekday names, comma separated (optional)', value: weekNames },
      { name: 'anchor', label: 'To show weekdays: a known date and its weekday, as "year, month number, day, weekday" (optional)', value: anchor ? `${anchor.year}, ${anchor.period + 1}, ${anchor.day}, ${cal.week.names[anchor.weekday] || ''}` : '',
        hint: 'Month number counts festivals too, from 1. Example: "1491, 1, 1, Sul".' },
    ],
  });
  if (!vals) return null;
  try {
    const out = {
      name: vals.name || 'Calendar', yearSuffix: vals.yearSuffix || '', periods: textToPeriods(vals.periods),
      leap: vals.leapEvery > 0 ? { every: Math.trunc(vals.leapEvery), offset: Math.trunc(vals.leapOffset || 0) } : null,
      week: { length: Math.max(1, Math.trunc(vals.weekLength || 7)), names: vals.weekNames.split(',').map((x) => x.trim()).filter(Boolean) },
    };
    if (vals.anchor) {
      const [y, p, d, wd] = vals.anchor.split(',').map((x) => x.trim());
      const a = { year: Number(y), period: Number(p) - 1, day: Number(d), weekday: out.week.names.findIndex((n) => n.toLowerCase() === (wd || '').toLowerCase()) };
      if (a.weekday < 0 || !isValidDate(out, a)) throw new Error('The weekday example does not match the calendar: check the month number, the day and the weekday name.');
      out.week.anchor = a;
    }
    return out;
  } catch (err) {
    toast(err.message, 'error');
    return editCalendar(cal);
  }
}
// Switching between Campaign day and a calendar: rewrite every stop, given
// the calendar date of day 1. Resolves true when done, null if cancelled.
async function convertGameTime(from, to, cal) {
  const vals = await formDialog({
    title: 'Convert stop times',
    submitLabel: 'Convert',
    intro: h('p', { class: 'hint' }, `To convert the stops from ${from === 'day' ? 'campaign days' : 'calendar dates'} to ${to === 'day' ? 'campaign days' : 'calendar dates'}, give the calendar date of Day 1.`),
    fields: [
      { name: 'year', label: `Year${cal.yearSuffix ? ` (${cal.yearSuffix})` : ''}`, type: 'number', value: '' },
      { name: 'period', label: 'Month or festival', type: 'select', value: '0', options: cal.periods.map((p, i) => ({ value: String(i), label: p.name })) },
      { name: 'day', label: 'Day', type: 'number', value: 1 },
    ],
  });
  if (!vals) return null;
  const day1 = { year: Math.trunc(vals.year), period: Number(vals.period), day: Math.trunc(vals.day) };
  if (!isValidDate(cal, day1)) { toast('That is not a date on this calendar.', 'error'); return null; }
  const base = dayNumber(cal, day1);
  const ops = [];
  for (const w of state.waypoints) {
    if (to === 'calendar' && Number.isFinite(w.gameDay)) ops.push([w.id, { gameDate: addDays(cal, day1, w.gameDay - 1) }]);
    if (to === 'day' && isValidDate(cal, w.gameDate)) ops.push([w.id, { gameDay: dayNumber(cal, w.gameDate) - base + 1 }]);
  }
  const ok = await attempt(async () => { for (const [id, patch] of ops) await state.backend.updateWaypoint(id, patch); return true; }, `Converted ${ops.length} stop${ops.length === 1 ? '' : 's'}.`);
  return ok ? true : null;
}

// ---------- pin create / edit / delete ----------
async function editPin(id, pos) {
  const pin = id ? state.pins.get(id) : null;
  const types = [...state.pinTypes.values()].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
  const baseTypes = types.filter((t) => t.kind !== 'ring');
  const ringTypes = types.filter((t) => t.kind === 'ring');
  if (!baseTypes.length) { toast('Add pin types first (menu > Pin types).', 'error'); return; }
  const vals = await formDialog({
    title: pin ? `Edit ${pin.name}` : 'New pin',
    submitLabel: pin ? 'Save pin' : 'Add pin',
    fields: [
      { name: 'name', label: 'Name', value: pin?.name || '', required: true },
      { name: 'baseType', label: 'Type', type: 'select', value: pin?.baseType || baseTypes[0].id, options: baseTypes.map((t) => ({ value: t.id, label: t.label })) },
      ringTypes.length ? { name: 'rings', label: 'Affiliations', type: 'checklist', value: pin?.rings || [], options: ringTypes.map((t) => ({ value: t.id, label: t.label, swatch: typeSwatch(t) })) } : null,
      { name: 'visibility', label: 'Who can see it', type: 'select', value: pin?.visibility || 'hidden',
        options: [{ value: 'hidden', label: 'Hidden from players' }, { value: 'public', label: 'Visible to players' }],
        hint: pin ? null : 'New pins start hidden so nothing is revealed by accident.' },
      { name: 'description', label: 'Description (players see this)', type: 'textarea', value: pin?.description || '', rows: 4 },
      { name: 'dmText', label: 'DM-only notes', type: 'textarea', value: pin ? state.dmText : '', rows: 3 },
    ].filter(Boolean),
  });
  if (!vals) return;
  if (!vals.name) { toast('A pin needs a name.', 'error'); return; }
  const data = {
    name: vals.name, x: pin ? pin.x : pos.x, y: pin ? pin.y : pos.y, baseType: vals.baseType,
    rings: vals.rings || [], visibility: vals.visibility, description: vals.description,
  };
  const newId = await attempt(() => state.backend.savePin(id, data, state.user.email));
  if (!newId) return;
  if (vals.dmText !== (pin ? state.dmText : '')) await attempt(() => state.backend.setDmText(newId, vals.dmText));
  toast(pin ? 'Pin saved.' : 'Pin added.', 'ok');
  if (!pin) setMode('select');
  openPin(newId);
}

async function deletePin(pin) {
  if (!(await confirmDialog(`Delete "${pin.name}" with all of its notes and handouts? This cannot be undone.`, 'Delete pin'))) return;
  closeDetail();
  await deleteHandoutsOf('pin', pin.id);
  await attempt(() => state.backend.deletePin(pin.id), 'Pin deleted.');
}

// ---------- pin types (DM) ----------
async function addStartingTypes() {
  await attempt(async () => {
    for (const { id, ...t } of STARTING_PIN_TYPES) await state.backend.savePinType(id, t);
  }, 'Starting pin types added.');
}

function slugify(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 40) || 'type';
}

async function editPinType(type) {
  const vals = await formDialog({
    title: type ? `Edit ${type.label}` : 'New pin type',
    submitLabel: type ? 'Save type' : 'Add type',
    fields: [
      { name: 'label', label: 'Name', value: type?.label || '', required: true },
      { name: 'kind', label: 'Drawn as', type: 'select', value: type?.kind || 'base',
        options: [{ value: 'base', label: 'Pin shape (each pin has one)' }, { value: 'ring', label: 'Ring around the pin (any number)' }] },
      { name: 'color', label: 'Color', type: 'color', value: type?.color || '#7a5c3a' },
      { name: 'shape', label: 'Shape (pin shapes only)', type: 'select', value: type?.shape || 'circle',
        options: ['circle', 'diamond', 'square', 'triangle'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
      { name: 'ringOrder', label: 'Ring position (rings only, 1 = innermost)', type: 'number', value: type?.ringOrder ?? 1 },
      { name: 'sortOrder', label: 'Order in the legend', type: 'number', value: type?.sortOrder ?? (state.pinTypes.size + 1) },
    ],
  });
  if (!vals || !vals.label) return;
  let id = type?.id || slugify(vals.label);
  if (!type) { const stem = id; let n = 2; while (state.pinTypes.has(id)) id = `${stem}-${n++}`; }
  const data = { label: vals.label, kind: vals.kind, color: vals.color, sortOrder: vals.sortOrder ?? 99 };
  if (vals.kind === 'base') data.shape = vals.shape; else data.ringOrder = vals.ringOrder ?? 1;
  await attempt(() => state.backend.savePinType(id, data), type ? 'Pin type saved.' : 'Pin type added.');
}

async function deletePinType(type) {
  const used = [...state.pins.values()].filter((p) => p.baseType === type.id || (p.rings || []).includes(type.id)).length;
  const msg = used
    ? `"${type.label}" is used by ${used} pin${used === 1 ? '' : 's'}. Those pins keep the setting but will draw in grey until you pick another type. Delete it?`
    : `Delete the pin type "${type.label}"?`;
  if (!(await confirmDialog(msg, 'Delete type'))) return;
  await attempt(() => state.backend.deletePinType(type.id), 'Pin type deleted.');
}

function openPinTypes() {
  const body = h('div');
  const render = () => {
    const types = [...state.pinTypes.values()].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
    body.replaceChildren(
      types.length ? h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Drawn as'), h('th', {}, ''))),
        h('tbody', {}, types.map((t) => h('tr', {},
          h('td', {}, h('span', { class: 'swatch', html: typeSwatch(t) })),
          h('td', {}, t.label),
          h('td', {}, t.kind === 'ring' ? `Ring ${t.ringOrder ?? ''}` : `${t.shape || 'circle'}`),
          h('td', { style: 'text-align:right;white-space:nowrap' },
            h('button', { class: 'btn small', type: 'button', onclick: () => editPinType(t) }, 'Edit'), ' ',
            h('button', { class: 'btn small danger', type: 'button', onclick: () => deletePinType(t) }, 'Delete')))))) :
        h('p', { class: 'muted' }, 'No pin types yet.'),
      h('div', { class: 'detail-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => editPinType(null) }, 'Add pin type'),
        !types.length ? h('button', { class: 'btn', type: 'button', onclick: addStartingTypes }, 'Add the starting pin types') : null));
  };
  render();
  const { dlg } = panelDialog('Pin types', body, { wide: true });
  trackDialog(dlg, render);
}

// ---------- members (admin) ----------
function openMembers() {
  const body = h('div');
  const roleSelect = (value, onchange) => h('select', { onchange, 'aria-label': 'Role' },
    ['player', 'dm', 'admin'].map((r) => h('option', { value: r, selected: r === value }, r === 'dm' ? 'DM' : r[0].toUpperCase() + r.slice(1))));
  const render = () => {
    const members = [...state.members].sort((a, b) => a.id.localeCompare(b.id));
    const email = h('input', { type: 'email', placeholder: 'name@example.com', 'aria-label': 'Google account email' });
    const name = h('input', { type: 'text', placeholder: 'Player name', 'aria-label': 'Player name' });
    const character = h('input', { type: 'text', placeholder: 'Character name', 'aria-label': 'Character name' });
    const role = roleSelect('player');
    body.replaceChildren(
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Google account'), h('th', {}, 'Player'), h('th', {}, 'Character'), h('th', {}, 'Role'), h('th', {}, ''))),
        h('tbody', {}, members.map((m) => h('tr', {},
          h('td', {}, m.id),
          h('td', {}, m.displayName || ''),
          h('td', {}, m.characterName || ''),
          h('td', {}, m.id === state.user.email ? `${{ admin: 'Admin', dm: 'DM', player: 'Player' }[m.role] || m.role} (you)`
            : roleSelect(m.role, (e) => attempt(() => state.backend.saveMember(m.id, { ...stripId(m), role: e.target.value }), 'Role changed.'))),
          h('td', { style: 'text-align:right;white-space:nowrap' },
            h('button', { class: 'btn small', type: 'button', onclick: () => editMember(m) }, 'Edit'), ' ',
            m.id !== state.user.email ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
              if (await confirmDialog(`Remove ${m.id} from the map? Also remove them from the Cloudflare Access list.`, 'Remove')) {
                attempt(() => state.backend.deleteMember(m.id), 'Member removed.');
              }
            } }, 'Remove') : null))))),
      h('h3', { style: 'margin-top:18px' }, 'Add a member'),
      h('form', { class: 'add-row', onsubmit: (e) => {
        e.preventDefault();
        const addr = email.value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { toast('Enter the Google account email address.', 'error'); return; }
        attempt(() => state.backend.saveMember(addr, { role: role.value, displayName: name.value.trim(), characterName: character.value.trim() }),
          `${addr} added. Also add it to the Cloudflare Access allow list.`);
      } }, email, name, character, role, h('button', { class: 'btn primary', type: 'submit' }, 'Add')),
      h('p', { class: 'hint' }, 'Each person also needs to be on the Cloudflare Access allow list, or they cannot load the site.'));
  };
  render();
  const { dlg } = panelDialog('Members', body, { wide: true });
  trackDialog(dlg, render);
}

const stripId = ({ id, ...rest }) => rest;

async function editMember(m) {
  const vals = await formDialog({
    title: `Edit ${m.id}`,
    fields: [
      { name: 'displayName', label: 'Player name', value: m.displayName || '' },
      { name: 'characterName', label: 'Character name', value: m.characterName || '' },
    ],
  });
  if (!vals) return;
  await attempt(() => state.backend.saveMember(m.id, { ...stripId(m), ...vals }), 'Member saved.');
}

// ---------- map settings and backup (admin) ----------
async function openMapSettings() {
  const s = state.settings || DEFAULT_MAP;
  const detect = h('button', { class: 'btn small', type: 'button', onclick: (e) => {
    const form = e.target.closest('form');
    const img = new Image();
    img.onload = () => {
      form.elements.imageWidth.value = img.naturalWidth;
      form.elements.imageHeight.value = img.naturalHeight;
      toast(`Image is ${img.naturalWidth} × ${img.naturalHeight} px.`, 'ok');
    };
    img.onerror = () => toast('That image path did not load.', 'error');
    img.src = form.elements.imagePath.value;
  } }, 'Read size from image');
  const vals = await formDialog({
    title: 'Map settings',
    fields: [
      { name: 'imagePath', label: 'Map image path', value: s.imagePath, hint: 'Relative to the site, e.g. map/map.jpg' },
      { name: 'imageWidth', label: 'Width (px)', type: 'number', value: s.imageWidth },
      { name: 'imageHeight', label: 'Height (px)', type: 'number', value: s.imageHeight },
      { name: 'milesPerPixel', label: 'Scale (miles per map pixel)', type: 'number', step: 'any', value: s.milesPerPixel ?? DEFAULT_MAP.milesPerPixel,
        hint: 'Used for route distances and the Measure tool. Easier: measure the scale bar with the Measure tool and choose Use as map scale.' },
    ],
    extra: h('div', {}, detect, h('p', { class: 'hint' }, 'Width and height set the coordinate grid pins are stored on, and the image is stretched to fill it. To switch to a sharper copy of the same map, change only the path and keep these numbers; pins stay in place. A map with different framing means moving every pin.')),
  });
  if (!vals) return;
  if (!(vals.imageWidth > 0 && vals.imageHeight > 0)) { toast('Width and height must be positive numbers.', 'error'); return; }
  if (!(vals.milesPerPixel > 0)) { toast('The scale must be a positive number.', 'error'); return; }
  // Keep the other settings (in-game time) that live in the same document.
  await attempt(() => state.backend.saveSettings({ ...state.settings, imagePath: vals.imagePath, imageWidth: vals.imageWidth, imageHeight: vals.imageHeight, milesPerPixel: vals.milesPerPixel }), 'Map settings saved.');
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function exportBackup() {
  const data = await attempt(() => state.backend.exportAll());
  if (!data) return;
  downloadJson(data, `${fileSlug()}-backup-${backupProjectTag()}-${todayIso()}.json`);
  toast('Backup downloaded.', 'ok');
}
const backupProjectTag = () => (state.backend.projectId || env).replace(/[^a-z0-9-]/gi, '');

// ---------- restore (admin) ----------
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

async function restoreBackup() {
  const file = await pickFile('application/json,.json');
  if (!file) return;
  let backup;
  try { backup = parseBackup(await file.text()); } catch (err) { toast(err.message, 'error'); return; }
  const s = summarize(backup);
  const here = state.backend.projectId || env;
  const otherProject = s.projectId !== here;
  const row = (label, value) => h('tr', {}, h('th', {}, label), h('td', {}, String(value)));
  const exported = new Date(s.exportedAt);
  const summary = h('div', {},
    h('p', {}, `File: ${file.name}`),
    h('table', { class: 'table' },
      row('Saved', Number.isNaN(exported.getTime()) ? s.exportedAt : exported.toLocaleString()),
      row('From project', s.projectId),
      row('Pins', `${s.pins} (${s.hiddenPins} hidden), DM-only text on ${s.dmTexts}`),
      row('Notes / leads / people met', `${s.notes} / ${s.leads} / ${s.people}`),
      row('NPCs', s.npcs == null ? 'not in file (current NPCs kept)' : `${s.npcs} (${s.hiddenNpcs} hidden), ${s.npcNotes} notes`),
      row('Affiliations', s.affiliations == null ? 'not in file (current ones kept)' : s.affiliations),
      row('Travel modes', s.travelModes == null ? 'not in file (current ones kept)' : s.travelModes),
      row('Sessions', s.sessions == null ? 'not in file (current ones kept)' : s.sessions),
      row('Planned routes', s.plans == null ? 'not in file (current ones kept)' : s.plans),
      row('Handouts / uploaded images', s.handouts == null ? 'not in file (current ones kept)' : `${s.handouts} / ${s.images ?? 0}`),
      row('Route stops', s.stops),
      row('Pin types', s.pinTypes),
      row('Members in file', s.members),
      row('Map settings', s.hasSettings ? 'included' : 'not in file (current settings kept)')),
    otherProject ? h('p', { class: 'warn' }, `This backup came from "${s.projectId}", and this site uses "${here}".`) : null,
    h('p', { class: 'hint' }, 'Restoring makes this map match the backup: entries added since it was saved are deleted, and changed ones go back to how they were. A copy of the current data downloads first, so this can be undone by restoring that copy.'));
  const vals = await formDialog({
    title: 'Restore from backup',
    submitLabel: 'Restore',
    intro: summary,
    fields: [
      { name: 'members', label: `Also restore the member list (your own entry, ${state.user.email}, is always kept)`, type: 'checkbox', value: false },
      otherProject ? { name: 'otherProject', label: `Yes, restore a "${s.projectId}" backup into "${here}"`, type: 'checkbox', value: false } : null,
      { name: 'confirm', label: 'I understand this replaces the map\'s current data', type: 'checkbox', value: false },
    ].filter(Boolean),
  });
  if (!vals) return;
  if (!vals.confirm || (otherProject && !vals.otherProject)) { toast('Restore cancelled: tick the confirmation boxes to go ahead.'); return; }

  try {
    toast('Saving a copy of the current data…');
    const current = await state.backend.exportAll();
    downloadJson(current, `${fileSlug()}-before-restore-${backupProjectTag()}-${todayIso()}.json`);
    closeDetail();
    const count = await state.backend.restoreAll(backup, current, { members: vals.members, keepEmail: state.user.email },
      (done, total) => toast(`Restoring… ${done} of ${total} changes`));
    resetSearch();
    toast(`Restore finished: ${count} changes. The copy of the data from before the restore was downloaded.`, 'ok');
  } catch (err) {
    reportError(err);
    toast('The restore stopped part-way. Run it again with the same file to finish, or restore the "before-restore" copy to go back.', 'error');
  }
}

// Dialogs that list live data redraw when that data changes.
function trackDialog(dlg, render) {
  state.refreshers.add(render);
  dlg.addEventListener('close', () => state.refreshers.delete(render));
}
function refreshDialogs() { state.refreshers.forEach((r) => r()); }

if (env === 'demo' || env === 'local') window.__skt = state; // for debugging only

wireChrome();
start();
