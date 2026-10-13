// Campaign map: main UI.
import { detectEnv, firebaseConfigFor, DEFAULT_MAP, STARTING_PIN_TYPES, ROUTE_STYLES, TRAVEL_PACES, SITE_TITLE, SITE_CONFIG_MISSING } from './config.js';
import { h, toast, explainError, formDialog, confirmDialog, panelDialog, formatDate } from './ui.js';
import { pinSvg, typeSwatch, partySvg, PARTY_SIZE } from './markers.js';
import { routeSegments, arcPoints, smoothPath, pathLength, legPixels } from './route.js';
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
  noteKind: 'note', // what the pin panel's add form adds: note, lead or npc
  npcName: '',
  selectedPinId: null,
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
    scope: { pins: true, stops: true, ...readPref('searchScope', {}) },
    texts: null,     // Map pinId -> { notes, dmText }, loaded when search is used
    loadedAt: 0,
    loading: null,   // promise while loading
    generation: 0,   // bumps on reset so a late load from a previous account is dropped
  },
};

// Teleport wording comes from site-config.js (e.g. "Harper teleport").
const TP = ROUTE_STYLES.teleport;
// Short name for downloaded files, from the site title.
const fileSlug = () => SITE_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign-map';

const isDM = () => state.role === 'dm' || state.role === 'admin';
// The DM has full admin powers (members, map settings, backup and restore);
// the rules grant the same. The role names only show who is who.
const isAdmin = () => state.role === 'admin' || state.role === 'dm';

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
      setupMap(); renderRouteList(); renderMeasure(); renderModeHint();
    }),
    b.watchPinTypes((list) => {
      state.pinTypes = new Map(list.map((t) => [t.id, t]));
      renderFilters(); renderPins(); renderDetail(); refreshDialogs();
    }),
    b.watchPins(isDM(), (list) => {
      state.pins = new Map(list.map((p) => [p.id, p]));
      if (state.selectedPinId && !state.pins.has(state.selectedPinId)) closeDetail();
      state.search.loadedAt = 0; // pins changed: reload notes on the next search
      renderFilters(); renderPins(); renderDetail(); renderParty(); renderSearchResults();
    }),
    b.watchWaypoints((list) => {
      state.waypoints = list.sort((a, b2) => a.seq - b2.seq);
      renderRoute(); renderRouteList(); renderParty(); renderDetail(); renderDraft(); renderSearchResults();
    }),
    b.watchMembers((list) => { state.members = list; refreshDialogs(); }),
  );
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

  const items = [];
  if (isDM()) items.push(['Pin types', openPinTypes]);
  if (isAdmin()) items.push(['Members', openMembers], ['Map settings', openMapSettings], ['Download backup (JSON)', exportBackup], ['Restore from backup…', restoreBackup]);
  if (env === 'demo') {
    items.push(['sep']);
    for (const r of ['player', 'dm', 'admin']) if (r !== state.role) items.push([`View demo as ${r === 'dm' ? 'DM' : r}`, () => { location.search = `?demo=${r}`; }]);
  }
  items.push(['sep'], [env === 'demo' ? 'Leave demo' : 'Sign out', () => state.backend.signOut()]);
  $('user-menu').replaceChildren(...items.map(([label, fn]) => (label === 'sep'
    ? h('div', { class: 'sep', role: 'separator' })
    : h('button', { type: 'button', role: 'menuitem', onclick: () => { toggleMenu(false); fn(); } }, label))));

  $('dm-tools').hidden = !isDM();
  if (!isDM()) setMode('select');
}

function toggleMenu(open) {
  const menu = $('user-menu');
  const show = open ?? menu.hidden;
  menu.hidden = !show;
  $('user-button').setAttribute('aria-expanded', String(show));
}

const MODE_HINTS = {
  addPin: 'Click the map where the new pin goes. Press Esc to stop.',
  addStop: `Click along the road; clicking a pin routes through it. End with Stop here or Enter. If your last click is on a pin, the stop links to it. For a ${TP.inline}, click only the destination and choose ${TP.label} when asked.`,
  redraw: 'Click along the road, in travel order, then choose Save road.',
  move: 'Drag pins to new positions. Each move saves when you let go.',
  measure: 'Click points on the map to measure. Backspace removes the last point; Esc ends.',
};
function setMode(mode, draft = null) {
  state.mode = mode;
  state.draft = mode === 'addStop' ? { points: [], redrawId: null } : mode === 'redraw' ? draft : null;
  state.measure = mode === 'measure' ? { points: [] } : null;
  document.querySelectorAll('#dm-tools button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelector('.measure-btn')?.setAttribute('aria-pressed', String(mode === 'measure'));
  $('map').classList.toggle('mode-add', ['addPin', 'addStop', 'redraw', 'measure'].includes(mode));
  state.map?.doubleClickZoom[state.draft || state.measure ? 'disable' : 'enable']();
  renderModeHint();
  renderDraft();
  renderMeasure();
  renderPins();
  if (mode !== 'select') state.map?.closePopup();
  renderRoute(); // route click targets exist only in Select mode
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
  }
  box.replaceChildren(h('span', {}, text), actions.length ? h('span', { class: 'hint-actions' }, actions) : '');
}

function wireChrome() {
  $('user-button').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!$('user-menu').hidden && !e.target.closest('.menu')) toggleMenu(false); });
  $('dm-tools').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('party-jump').addEventListener('click', jumpToParty);
  $('toggle-side').addEventListener('click', () => setSide($('app').classList.contains('side-closed')));
  wireSearch();
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (state.draft && !typing) {
      if (e.key === 'Backspace') { e.preventDefault(); undoDraftPoint(); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (state.mode === 'redraw') saveRedraw(); else if (state.draft.points.length) finishStop(); return; }
    }
    if (state.measure && !typing && e.key === 'Backspace') { e.preventDefault(); undoMeasurePoint(); return; }
    if (e.key !== 'Escape') return;
    if (!$('user-menu').hidden) toggleMenu(false);
    else if (state.mode !== 'select') setMode('select');
    else if (state.selectedPinId) closeDetail();
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
  renderPins(); renderRoute(); renderParty();
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
  for (const seg of routeSegments(state.waypoints)) {
    const teleport = seg.kind === 'teleport';
    const pts = (teleport ? arcPoints(seg.from, seg.to) : smoothPath(seg.points)).map((p) => ll(p.x, p.y));
    L.polyline(pts, { color: '#1f2a36', weight: 7, opacity: 0.55, interactive: false }).addTo(state.layers.route);
    L.polyline(pts, { color: ROUTE_STYLES[seg.kind].color, weight: 3.5, dashArray: teleport ? '2 7' : '9 7', lineCap: 'round', interactive: false })
      .addTo(state.layers.route);
  }
  // Click targets: a wide invisible line over each leg, and the stop dots.
  // Only in Select mode; while drawing or measuring, clicks must reach the map.
  const selecting = state.mode === 'select';
  if (selecting) {
    state.waypoints.forEach((w, i) => {
      if (i === 0) return;
      const prev = state.waypoints[i - 1];
      const pts = isTeleport(w, i) ? arcPoints(prev, w)
        : smoothPath([{ x: prev.x, y: prev.y }, ...(Array.isArray(w.path) ? w.path : []), { x: w.x, y: w.y }]);
      L.polyline(pts.map((p) => ll(p.x, p.y)), { color: '#000', weight: 18, opacity: 0, className: 'route-hit' })
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
  const teleport = isTeleport(w, i);
  const miles = i > 0 && !teleport ? legMiles(i) : 0;
  const rows = [
    ['Session date', w.sessionDate ? formatSessionDate(w.sessionDate) : 'not recorded'],
  ];
  if (i === 0) rows.push(['Route', 'Start of the route']);
  else if (teleport) rows.push(['Travel', `${TP.label} (no overland distance)`]);
  else {
    rows.push(['Distance', `${fmtMiles(miles)} along the road`]);
    const pace = (id) => TRAVEL_PACES.find((p) => p.id === id);
    rows.push(['Travel time', ['normal', 'slow', 'fast'].map((id) => h('div', {}, `${fmtDays(miles, pace(id).milesPerDay)} at ${pace(id).label.toLowerCase()} pace`))]);
  }
  const body = h('div', { class: 'leg-popup' },
    h('div', { class: 'leg-title' }, `Stop ${i + 1}: ${stopLabel(w)}`),
    prev ? h('div', { class: 'leg-from' }, `From stop ${i}: ${stopLabel(prev)}`) : null,
    h('table', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
    i === state.waypoints.length - 1 ? h('div', { class: 'leg-from' }, 'The party is here.') : null,
    isDM() ? h('button', { class: 'btn small', type: 'button', onclick: () => { state.map.closePopup(); editStop(w); } }, 'Edit stop') : null);

  state.layers.legHighlight ||= L.layerGroup().addTo(state.map);
  state.layers.legHighlight.clearLayers();
  if (prev) {
    const pts = teleport ? arcPoints(prev, w)
      : smoothPath([{ x: prev.x, y: prev.y }, ...(Array.isArray(w.path) ? w.path : []), { x: w.x, y: w.y }]);
    L.polyline(pts.map((p) => ll(p.x, p.y)), { color: '#ffffff', weight: 7, opacity: 0.5, interactive: false }).addTo(state.layers.legHighlight);
  }
  state.legPopup = { index: i };
  L.popup({ className: 'leg-popup-wrap', maxWidth: 300, autoPanPadding: [20, 20] })
    .setLatLng(latlng)
    .setContent(body)
    .on('remove', () => { state.layers.legHighlight?.clearLayers(); state.legPopup = null; })
    .openOn(state.map);
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
  if (isDM() && state.draft) { addDraftPoint({ x: pin.x, y: pin.y, pinId: pin.id }); return; }
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
  children.push(h('div', { class: 'filter-group' },
    h('p', { class: 'filter-group-name' }, 'Travel'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.showRoute, onchange: (e) => { state.showRoute = e.target.checked; writePref('showRoute', state.showRoute); renderRoute(); } }),
      h('span', { class: 'swatch', html: `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 16 L9 8 L13 13 L20 5" fill="none" stroke="${ROUTE_STYLES.road.color}" stroke-width="3" stroke-dasharray="4 3" stroke-linecap="round"/></svg>` }),
      ROUTE_STYLES.road.label),
    h('div', { class: 'check legend-only' },
      h('span', { class: 'swatch', html: `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 17 Q11 -1 20 17" fill="none" stroke="${ROUTE_STYLES.teleport.color}" stroke-width="3" stroke-dasharray="1 4" stroke-linecap="round"/></svg>` }),
      ROUTE_STYLES.teleport.label)));
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

// "By teleport" or "86 mi, about 3½ days" for the leg into stop i.
function legLine(w, i) {
  if (i === 0) return '';
  if (isTeleport(w, i)) return `By ${TP.inline}`;
  const miles = legMiles(i);
  return `${fmtMiles(miles)}, about ${fmtDays(miles, NORMAL_PACE)}`;
}

function renderRouteSummary() {
  const box = $('route-summary');
  if (!box) return;
  const legs = state.waypoints.length - 1;
  if (legs < 1) { box.hidden = true; return; }
  let miles = 0;
  let teleports = 0;
  state.waypoints.forEach((w, i) => { if (isTeleport(w, i)) teleports += 1; else miles += legMiles(i); });
  box.textContent = `${fmtMiles(miles)} overland, about ${fmtDays(miles, NORMAL_PACE)} at normal pace`
    + (teleports ? `, plus ${teleports} ${TP.inline}${teleports === 1 ? '' : 's'}` : '') + '.';
  box.title = `Travel time at normal pace (${NORMAL_PACE} miles a day). Slow: ${fmtDays(miles, 18)}. Fast: ${fmtDays(miles, 30)}.`;
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
function fmtDays(miles, perDay) {
  const d = Math.round((miles / perDay) * 2) / 2;
  return d < 0.5 ? 'under ½ day' : `${String(d).replace('.5', '½')} day${d > 1 ? 's' : ''}`;
}
const NORMAL_PACE = TRAVEL_PACES.find((p) => p.id === 'normal').milesPerDay;

// Overland miles of the leg into stop i (0 for the first stop and teleports).
function legMiles(i) { return legPixels(state.waypoints, i) * milesPerPixel(); }

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
  $('search-scope').replaceChildren(scopeBox('pins', 'Pins and notes'), scopeBox('stops', 'Route stops'));
}

function resetSearch() {
  const s = state.search;
  s.texts = null; s.loadedAt = 0; s.loading = null; s.generation += 1;
  renderSearchResults();
}

// Loads notes (and DM text for the DM) for every visible pin, at most once a minute.
function ensureSearchTexts() {
  const s = state.search;
  if (!state.backend || !state.role || s.loading) return;
  if (s.texts && Date.now() - s.loadedAt < SEARCH_MAX_AGE_MS) return;
  const gen = s.generation;
  s.loading = state.backend.readPinTexts([...state.pins.keys()], isDM())
    .then((texts) => { if (gen === s.generation) { s.texts = texts; s.loadedAt = Date.now(); } })
    .catch(reportError)
    .finally(() => { if (gen === s.generation) { s.loading = null; renderSearchResults(); } });
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

function stopSearchFields(w, i) {
  return [
    { label: 'Stop', text: stopLabel(w) },
    { label: 'Date', text: w.sessionDate ? `${formatSessionDate(w.sessionDate)} ${w.sessionDate}` : '' },
    { label: 'Travel', text: isTeleport(w, i) ? `${TP.label} ${TP.inline} teleport` : '' },
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
  if (s.scope.stops) {
    state.waypoints.forEach((w, i) => {
      const m = matchItem(stopSearchFields(w, i), terms);
      if (m) results.push({ kind: 'stop', w, i, m, rank: 2 });
    });
  }
  results.sort((a, b) => a.rank - b.rank
    || (a.kind === 'stop' && b.kind === 'stop' ? b.i - a.i : 0)
    || (a.pin && b.pin ? a.pin.name.localeCompare(b.pin.name) : 0));

  const parts = [];
  if (!s.scope.pins && !s.scope.stops) parts.push('Tick Pins and notes or Route stops to search.');
  else {
    parts.push(results.length ? `${results.length} result${results.length === 1 ? '' : 's'}` : 'No matches');
    if (s.scope.pins && s.loading) parts.push('loading notes…');
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
    return h('li', {}, h('button', { type: 'button', class: 'search-hit', onclick: () => showStopFromSearch(r.w) },
      h('span', { class: 'search-title' }, h('span', { class: 'search-kind' }, `Stop ${r.i + 1}`), stopLabel(r.w)),
      h('span', { class: 'search-snippet' },
        [r.w.sessionDate ? formatSessionDate(r.w.sessionDate) : '', isTeleport(r.w, r.i) ? TP.label : ''].filter(Boolean).join(' · '))));
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
  let start = currentStop();
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

// The first stop has no leg leading into it, so it is never a teleport.
function isTeleport(w, index) { return index > 0 && w.travel === 'teleport'; }

const TRAVEL_FIELD_HINT = 'A teleport is drawn as a dotted arc straight from the previous stop; any road points you clicked are dropped.';

async function addStop(pos, pin, path = []) {
  const vals = await formDialog({
    title: 'Add a stop to the route',
    submitLabel: 'Add stop',
    fields: [
      { name: 'label', label: 'Place name', value: pin?.name || '', hint: pin ? 'Linked to this pin.' : 'Leave blank for an unnamed stop.' },
      { name: 'sessionDate', label: 'Session date', type: 'date', value: todayIso() },
      state.waypoints.length ? { name: 'travel', label: 'How the party got here', type: 'select', value: 'road', hint: TRAVEL_FIELD_HINT,
        options: [{ value: 'road', label: 'Traveled (road, river, trail...)' }, { value: 'teleport', label: TP.label }] } : null,
    ].filter(Boolean),
  });
  if (!vals) return; // keeps the drawn points so the DM can carry on
  const seq = (state.waypoints.length ? Math.max(...state.waypoints.map((w) => w.seq)) : 0) + 1;
  const travel = vals.travel === 'teleport' ? 'teleport' : 'road';
  try {
    await state.backend.addWaypoint({ seq, x: pos.x, y: pos.y, path: travel === 'teleport' ? [] : path, travel,
      label: vals.label, sessionDate: vals.sessionDate, pinId: pin?.id || null });
    toast('Stop added.', 'ok');
    if (state.draft) { state.draft.points = []; renderDraft(); renderModeHint(); }
  } catch (err) {
    reportError(err);
  }
}

async function editStop(w) {
  const index = state.waypoints.findIndex((x) => x.id === w.id);
  const bends = Array.isArray(w.path) ? w.path.length : 0;
  const teleport = isTeleport(w, index);
  const legNow = teleport ? TP.inline : bends ? `road with ${bends} bend point${bends === 1 ? '' : 's'}` : 'straight line';
  const legOptions = [{ value: 'keep', label: 'Keep as is' }, { value: 'redraw', label: 'Redraw the road on the map' }, { value: 'straight', label: 'Make it a straight road' }];
  if (!teleport) legOptions.push({ value: 'teleport', label: `Change to a ${TP.inline}` });
  const vals = await formDialog({
    title: 'Edit stop',
    submitLabel: 'Save stop',
    danger: 'Delete stop',
    fields: [
      { name: 'label', label: 'Place name', value: w.label || '' },
      { name: 'sessionDate', label: 'Session date', type: 'date', value: w.sessionDate || '' },
      index > 0 ? { name: 'road', label: `Leg from the previous stop (now: ${legNow})`, type: 'select', value: 'keep', options: legOptions } : null,
    ].filter(Boolean),
  });
  if (!vals) return;
  if (vals.__danger) {
    if (await confirmDialog(`Delete the stop "${stopLabel(w)}" from the route?`, 'Delete stop')) {
      await attempt(() => state.backend.deleteWaypoint(w.id), 'Stop deleted.');
    }
    return;
  }
  const update = { label: vals.label, sessionDate: vals.sessionDate };
  if (vals.road === 'straight') Object.assign(update, { path: [], travel: 'road' });
  if (vals.road === 'redraw') update.travel = 'road';
  if (vals.road === 'teleport') Object.assign(update, { path: [], travel: 'teleport' });
  await attempt(() => state.backend.updateWaypoint(w.id, update), 'Stop saved.');
  if (vals.road === 'redraw') {
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
    state.npcName = '';
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
  $('detail').hidden = true;
  if (had) renderPins();
}

function renderDetail() {
  const panel = $('detail');
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
        mine ? h('button', { class: 'btn link', type: 'button', onclick: () => editNote(pin.id, n) }, 'Edit') : null,
        mine || isDM() ? h('button', { class: 'btn link', type: 'button', onclick: () => deleteNote(pin.id, n) }, 'Delete') : null));
  };
  const byKind = (k) => state.notes.filter((n) => noteKind(n) === k);
  const leads = byKind('lead').sort((a, b) => (a.status === 'done') - (b.status === 'done'));
  const openLeads = leads.filter((n) => n.status !== 'done').length;
  const leadItems = leads.map((n) => {
    const done = n.status === 'done';
    return h('li', { class: `note lead${done ? ' done' : ''}` },
      h('label', { class: 'lead-check', title: done ? 'Mark as still open' : 'Mark as followed up' },
        h('input', { type: 'checkbox', checked: done, 'aria-label': done ? 'Followed up' : 'Open lead',
          onchange: (e) => attempt(() => state.backend.setLeadStatus(pin.id, n.id, e.target.checked ? 'done' : 'open')) }),
        h('span', { class: 'note-text' }, n.text)),
      meta(n));
  });
  const personItems = byKind('npc').sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((n) => h('li', { class: 'note' },
    h('div', { class: 'npc-name' }, n.name || 'Unnamed'),
    h('div', { class: 'note-text' }, n.text),
    meta(n)));
  const noteItems = byKind('note').map((n) => h('li', { class: 'note' }, meta(n), h('div', { class: 'note-text' }, n.text)));

  const kind = state.noteKind;
  const textarea = h('textarea', { rows: '3', maxlength: '4000', placeholder: NOTE_KINDS[kind].placeholder, 'aria-label': NOTE_KINDS[kind].label,
    oninput: (e) => { state.noteDraft = e.target.value; } });
  textarea.value = state.noteDraft;
  const nameInput = kind === 'npc' ? h('input', { type: 'text', maxlength: '100', placeholder: 'Name', 'aria-label': 'Name',
    oninput: (e) => { state.npcName = e.target.value; } }) : null;
  if (nameInput) nameInput.value = state.npcName;
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
      h('button', { class: 'btn danger', type: 'button', onclick: () => deletePin(pin) }, 'Delete pin')) : null,
    h('h3', {}, 'Leads and rumors', leads.length ? h('span', { class: 'h-count' }, `${openLeads} open`) : null),
    leadItems.length ? h('ul', { class: 'notes' }, leadItems) : h('p', { class: 'muted' }, 'No leads yet.'),
    h('h3', {}, 'People met'),
    personItems.length ? h('ul', { class: 'notes' }, personItems) : h('p', { class: 'muted' }, 'Nobody recorded yet.'),
    h('h3', {}, 'Party notes'),
    noteItems.length ? h('ul', { class: 'notes' }, noteItems) : h('p', { class: 'muted' }, 'No notes yet.'),
    h('form', { class: 'note-form', onsubmit: (e) => { e.preventDefault(); addNote(pin.id); } },
      h('select', { 'aria-label': 'What to add', onchange: (e) => { state.noteKind = e.target.value; renderDetail(); } },
        Object.entries(NOTE_KINDS).map(([k, v]) => h('option', { value: k, selected: k === kind }, v.label))),
      nameInput,
      textarea,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, NOTE_KINDS[kind].add))),
  ].filter(Boolean)); // replaceChildren would print null as text
  panel.hidden = false;
  if (focusedTag === 'TEXTAREA') textarea.focus();
  else if (focusedTag === 'INPUT' && nameInput) nameInput.focus();
}

// What can be added to a pin. Stored in the pin's notes with a `kind` field;
// older notes have no kind and count as 'note'.
const NOTE_KINDS = {
  note: { label: 'Note', add: 'Add note', placeholder: 'What did the party learn here?', noun: 'note' },
  lead: { label: 'Lead or rumor', add: 'Add lead', placeholder: 'A lead or rumor heard here', noun: 'lead' },
  npc: { label: 'Person met', add: 'Add person', placeholder: 'Who they are, what they wanted, how it went', noun: 'person' },
};
const noteKind = (n) => (NOTE_KINDS[n.kind] ? n.kind : 'note');

async function addNote(pinId) {
  const kind = state.noteKind;
  const text = state.noteDraft.trim();
  const name = state.npcName.trim();
  if (kind === 'npc' && !name) { toast('Give the person a name.'); return; }
  if (!text) { toast(`Write something before adding the ${NOTE_KINDS[kind].noun}.`); return; }
  const entry = { text, authorEmail: state.user.email, authorName: displayName(state.member, state.user.email) };
  if (kind !== 'note') entry.kind = kind;
  if (kind === 'lead') entry.status = 'open';
  if (kind === 'npc') entry.name = name;
  try {
    await state.backend.addNote(pinId, entry);
    state.noteDraft = '';
    state.npcName = '';
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
  if (!(await confirmDialog(`Delete "${pin.name}" and all of its notes? This cannot be undone.`, 'Delete pin'))) return;
  closeDetail();
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
  await attempt(() => state.backend.saveSettings({ imagePath: vals.imagePath, imageWidth: vals.imageWidth, imageHeight: vals.imageHeight, milesPerPixel: vals.milesPerPixel }), 'Map settings saved.');
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
