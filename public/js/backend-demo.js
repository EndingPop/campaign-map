// In-memory stand-in for backend-firebase.js, used with ?demo in the URL.
// ?demo=dm (default), ?demo=player or ?demo=admin picks the role.
// Nothing is saved; reloading the page resets the data.
import { STARTING_PIN_TYPES, STARTING_TRAVEL_MODES, DEFAULT_MAP } from './config.js';
import { planRestore, reviveTimestamps } from './restore.js';

// Demo pins use the first two ring types configured in site-config.js.
const [RING_A, RING_B] = STARTING_PIN_TYPES.filter((t) => t.kind === 'ring').map((t) => t.id);

const ROLE_USERS = {
  admin: { email: 'admin@example.com', displayName: 'Demo Admin' },
  dm: { email: 'dm@example.com', displayName: 'Demo DM' },
  player: { email: 'player@example.com', displayName: 'Demo Player' },
};

// A plain SVG stand-in for uploaded images, so the demo needs no files.
function demoImage(bg, fg, text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="${bg}"/><rect x="30" y="30" width="540" height="740" fill="none" stroke="${fg}" stroke-width="6"/><text x="300" y="430" font-family="Georgia, serif" font-size="${text.length > 2 ? 110 : 320}" text-anchor="middle" fill="${fg}">${text}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

let counter = 0;
const newId = () => `demo${Date.now().toString(36)}${(counter++).toString(36)}`;
const clone = (v) => structuredClone(v);

export function createDemoBackend(roleParam) {
  const role = ROLE_USERS[roleParam] ? roleParam : 'dm';
  const me = ROLE_USERS[role];
  const now = new Date();

  const data = {
    members: {
      'admin@example.com': { role: 'admin', displayName: 'Demo Admin', characterName: '' },
      'dm@example.com': { role: 'dm', displayName: 'Demo DM', characterName: '' },
      'player@example.com': { role: 'player', displayName: 'Demo Player', characterName: 'Brynja' },
      'player2@example.com': { role: 'player', displayName: 'Second Player', characterName: 'Oskar' },
    },
    settings: { ...DEFAULT_MAP },
    pinTypes: Object.fromEntries(STARTING_PIN_TYPES.map(({ id, ...t }) => [id, id === RING_A ? { ...t, affiliationId: 'lantern' } : t])),
    pins: {
      p1: { name: 'First Town', x: 1450, y: 1050, baseType: 'city', rings: [], visibility: 'public', description: 'Where the party met.' },
      p2: { name: 'Ridgeford', x: 1650, y: 900, baseType: 'city', rings: [RING_A].filter(Boolean), visibility: 'public', description: '' },
      p3: { name: 'Waystation', x: 1900, y: 700, baseType: 'city', rings: [RING_B].filter(Boolean), visibility: 'public', description: '' },
      p4: { name: 'Port Calder', x: 2150, y: 1050, baseType: 'city', rings: [RING_A, RING_B].filter(Boolean), visibility: 'public', description: 'Both networks meet here.' },
      p5: { name: 'Old Ruins', x: 1750, y: 1250, baseType: 'notable', rings: [], visibility: 'public', description: '' },
      p6: { name: 'Something the DM knows', x: 2300, y: 1350, baseType: 'notable', rings: [], visibility: 'hidden', description: 'Players cannot see this yet.' },
    },
    dm: { p1: 'DM-only note: the innkeeper is lying.' },
    notes: {
      p1: {
        n1: { text: 'Rested here two nights. Cheap ale.', authorEmail: 'player2@example.com', authorName: 'Oskar (Second Player)', createdAt: now, updatedAt: now },
        l1: { kind: 'lead', status: 'open', text: 'A trader says the old mill road is watched at night.', authorEmail: 'player2@example.com', authorName: 'Oskar (Second Player)', createdAt: now, updatedAt: now },
        l2: { kind: 'lead', status: 'done', text: 'The smith wants iron from the hills.', authorEmail: 'player@example.com', authorName: 'Brynja (Demo Player)', createdAt: now, updatedAt: now },
        // An entry from before NPCs were their own records; the DM menu converts it.
        p1: { kind: 'npc', name: 'Hedda the innkeeper', text: 'Friendly, nosy, keeps a ledger of every guest.', authorEmail: 'player@example.com', authorName: 'Brynja (Demo Player)', createdAt: now, updatedAt: now },
      },
    },
    travelModes: {
      ...Object.fromEntries(STARTING_TRAVEL_MODES.map(({ id, ...m }) => [id, { ...m, revealed: true }])),
      ship: { label: 'Ship', inline: 'ship', color: '#2a7fb8', line: 'arc', dash: 'solid', paces: { normal: 96 }, revealed: false, sortOrder: 3 },
    },
    affiliations: {
      lantern: { name: 'Lantern Society', color: '#d4a017', description: 'Travelling scholars who trade in maps and rumors.', revealed: true, symbol: { imageId: 'img-lantern' } },
      ash: { name: 'Ashen Hand', color: '#7a2e2e', description: 'A smuggling ring. The party has not heard of it yet.', revealed: false },
    },
    npcs: {
      n1: { name: 'Maro the peddler', status: 'alive', visibility: 'public', description: 'A cheerful peddler with a mule named Pepper. Sells a bit of everything.', pinIds: ['p2', 'p3'], affiliationIds: ['lantern'], portrait: { imageId: 'img-maro' } },
      n2: { name: 'Captain Ysolde', status: 'missing', visibility: 'public', description: 'Harbor master of Port Calder. Nobody has seen her for a week.', pinIds: ['p4'], affiliationIds: [] },
      n3: { name: 'The veiled stranger', status: 'unknown', visibility: 'hidden', description: 'Watches the party from a distance.', pinIds: [], affiliationIds: [] },
    },
    npcSecrets: {
      n1: { text: 'Carries messages for the Ashen Hand without knowing it.', hiddenPinIds: ['p6'], hiddenAffiliationIds: ['ash'], sourceNotes: [] },
      n2: { text: 'Held in the smugglers\' cave.', hiddenPinIds: [], hiddenAffiliationIds: [], sourceNotes: [] },
      n3: { text: 'Ysolde\'s sister.', hiddenPinIds: ['p6'], hiddenAffiliationIds: ['ash'], sourceNotes: [] },
    },
    presenter: null,
    plans: {
      pl1: { name: 'Coast road to Port Calder', points: [{ x: 2150, y: 1050 }, { x: 2230, y: 1180 }, { x: 2300, y: 1350 }], travel: 'road', createdBy: 'player@example.com', createdByName: 'Brynja (Demo Player)' },
    },
    dmPlans: {
      dp1: { name: 'If they follow the smugglers', points: [{ x: 2150, y: 1050 }, { x: 1980, y: 1250 }, { x: 1750, y: 1250 }], travel: 'road', createdBy: 'dm@example.com', createdByName: 'Demo DM' },
    },
    sessions: {
      '2026-09-20': { title: 'The road begins' },
      '2026-09-27': { title: '' },
      '2026-10-04': { title: '' },
      '2026-10-11': { title: 'Through the circle' },
    },
    sessionNotes: {
      '2026-10-11': { r1: { text: 'Took the teleport circle from the waystation. Port Calder smells of fish and trouble.', authorEmail: 'player2@example.com', authorName: 'Oskar (Second Player)', createdAt: now, updatedAt: now } },
    },
    sessionSecrets: { '2026-10-11': { text: 'Next time: the harbor master is missing. Seed the rumor at the docks.' } },
    handouts: {
      h1: { title: 'Notice on the inn door', parentKind: 'pin', parentId: 'p1', revealed: true, visibility: 'public',
        transcription: 'Wanted: guards for a caravan east. Ask for Hedda.', imageId: 'img-notice', url: null, crop: null, createdAt: now },
      h2: { title: 'Smuggler\'s ledger page', parentKind: 'pin', parentId: 'p4', revealed: false, visibility: 'hidden',
        transcription: 'Three crates, north dock, new moon.', imageId: null, url: null, crop: null, createdAt: now },
    },
    images: {
      'img-notice': { data: demoImage('#e8dcc0', '#5a4632', 'WANTED'), width: 600, height: 800 },
      'img-maro': { data: demoImage('#c9a227', '#1f2a36', 'M'), width: 512, height: 512 },
      'img-lantern': { data: demoImage('#1f2a36', '#d4a017', 'L'), width: 512, height: 512 },
    },
    npcNotes: {
      n1: { a1: { text: 'Sold us rope at a fair price. Asked a lot of questions about where we were headed.', authorEmail: 'player@example.com', authorName: 'Brynja (Demo Player)', createdAt: now, updatedAt: now } },
    },
    waypoints: {
      w1: { seq: 1, x: 1450, y: 1050, label: 'First Town', pinId: 'p1', sessionDate: '2026-09-20' },
      w2: { seq: 2, x: 1560, y: 1000, path: [{ x: 1490, y: 1075 }, { x: 1530, y: 1060 }], label: 'Road camp', sessionDate: '2026-09-27' },
      w3: { seq: 3, x: 1650, y: 900, path: [{ x: 1600, y: 925 }], label: 'Ridgeford', pinId: 'p2', sessionDate: '2026-10-04' },
      w4: { seq: 4, x: 1900, y: 700, path: [{ x: 1720, y: 830 }, { x: 1820, y: 760 }], travel: 'road', label: 'Waystation', pinId: 'p3', sessionDate: '2026-10-11' },
      w5: { seq: 5, x: 2150, y: 1050, path: [], travel: 'teleport', label: 'Port Calder', pinId: 'p4', sessionDate: '2026-10-11' },
    },
  };

  // Writes a list of { op, path, data } the way Firestore would, mapping
  // subcollections onto the in-memory tables.
  function applyOps(ops) {
    for (const o of ops) {
      const [col, id, sub, subId] = o.path;
      const value = o.op === 'set' ? clone(o.data) : null;
      if (col === 'settings') { if (value) data.settings = value; continue; }
      if (sub) {
        const table = col === 'pins' && sub === 'notes' ? data.notes : col === 'npcs' && sub === 'notes' ? data.npcNotes : null;
        if (table) { if (value) (table[id] ||= {})[subId] = value; else if (table[id]) delete table[id][subId]; continue; }
        if (col === 'sessions' && sub === 'notes') { if (value) (data.sessionNotes[id] ||= {})[subId] = value; else if (data.sessionNotes[id]) delete data.sessionNotes[id][subId]; continue; }
        if (col === 'pins' && sub === 'dm') { if (value) data.dm[id] = value.text; else delete data.dm[id]; continue; }
        continue;
      }
      if (col === 'pins' && !value) { delete data.pins[id]; delete data.notes[id]; delete data.dm[id]; continue; }
      if (col === 'npcs' && !value) { delete data.npcs[id]; delete data.npcNotes[id]; continue; }
      if (col === 'sessions' && !value) { delete data.sessions[id]; delete data.sessionNotes[id]; continue; }
      if (value) (data[col] ||= {})[id] = value; else delete data[col]?.[id];
    }
  }

  const listeners = new Set();
  // Presenter state is the one thing shared between demo tabs, so a PC view
  // tab can follow a DM tab. Everything else stays per tab.
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('campaign-map-demo-presenter') : null;
  if (channel) channel.onmessage = (e) => { data.presenter = e.data; emit(); };
  const emit = () => queueMicrotask(() => listeners.forEach((l) => l()));
  const sub = (fn) => { listeners.add(fn); fn(); return () => listeners.delete(fn); };
  const list = (obj) => Object.entries(obj).map(([id, v]) => ({ id, ...clone(v) }));
  const isDM = () => ['dm', 'admin'].includes(data.members[me.email]?.role);
  const guard = (ok, what) => { if (!ok) throw Object.assign(new Error(`Demo: not allowed to ${what}`), { code: 'permission-denied' }); };

  return {
    kind: 'demo',
    role,

    onAuth(cb) { queueMicrotask(() => cb({ ...me })); return () => {}; },
    async signIn() {},
    async signOut() { location.search = ''; },

    watchMember: (email, cb) => sub(() => cb(data.members[email] ? { id: email, ...clone(data.members[email]) } : null)),
    watchMembers: (cb) => sub(() => cb(list(data.members))),
    watchSettings: (cb) => sub(() => cb(clone(data.settings))),
    watchPinTypes: (cb) => sub(() => cb(list(data.pinTypes))),
    watchPins: (dmView, cb) => sub(() => cb(list(data.pins).filter((p) => dmView || p.visibility === 'public'))),
    watchWaypoints: (cb) => sub(() => cb(list(data.waypoints))),
    watchTravelModes: (dmView, cb) => sub(() => cb(list(data.travelModes).filter((m) => (dmView && isDM()) || m.revealed))),
    watchAffiliations: (dmView, cb) => sub(() => cb(list(data.affiliations).filter((a) => (dmView && isDM()) || a.revealed))),
    watchNpcs: (dmView, cb) => sub(() => cb(list(data.npcs).filter((n) => (dmView && isDM()) || n.visibility === 'public'))),
    watchNpcSecrets: (cb) => sub(() => cb(isDM() ? list(data.npcSecrets) : [])),
    watchNpcNotes: (npcId, cb) => sub(() => cb(list(data.npcNotes[npcId] || {}))),
    watchPresenter: (cb) => sub(() => cb(clone(data.presenter))),
    watchPlans: (cb) => sub(() => cb(list(data.plans))),
    watchDmPlans: (cb) => sub(() => cb(isDM() ? list(data.dmPlans) : [])),
    watchSessions: (cb) => sub(() => cb(list(data.sessions))),
    watchSessionNotes: (id, cb) => sub(() => cb(list(data.sessionNotes[id] || {}))),
    watchSessionSecret: (id, cb) => sub(() => cb(isDM() ? data.sessionSecrets[id]?.text || '' : '')),
    watchHandouts: (dmView, cb) => sub(() => cb(list(data.handouts).filter((x) => (dmView && isDM()) || x.visibility === 'public'))),
    watchNotes: (pinId, cb) => sub(() => cb(list(data.notes[pinId] || {}))),
    watchDmText: (pinId, cb) => sub(() => cb(data.dm[pinId] || '')),

    async savePin(id, pin, by) {
      guard(isDM(), 'edit pins');
      const pid = id || newId();
      data.pins[pid] = { ...clone(pin), updatedAt: new Date(), updatedBy: by };
      emit();
      return pid;
    },
    async savePins(list, by, onProgress = () => {}) {
      guard(isDM(), 'edit pins');
      for (const p of list) data.pins[p.id || newId()] = { ...clone(p.data), updatedAt: new Date(), updatedBy: by };
      emit();
      onProgress(list.length, list.length);
    },
    async deletePin(id) {
      guard(isDM(), 'delete pins');
      delete data.pins[id]; delete data.notes[id]; delete data.dm[id];
      emit();
    },
    // Same contract as the Firebase backend; mimics the rules (players get
    // nothing from hidden pins, only the DM gets DM text).
    async readPinTexts(pinIds, includeDm) {
      const out = new Map();
      for (const id of pinIds) {
        const pin = data.pins[id];
        if (!pin || (!isDM() && pin.visibility !== 'public')) continue;
        out.set(id, { notes: list(data.notes[id] || {}), dmText: includeDm && isDM() ? data.dm[id] || '' : '' });
      }
      return out;
    },
    async setDmText(pinId, text) { guard(isDM(), 'edit DM text'); data.dm[pinId] = text; emit(); },

    async addNote(pinId, note) {
      guard(note.authorEmail === me.email, 'write as someone else');
      (data.notes[pinId] ||= {})[newId()] = { ...note, createdAt: new Date(), updatedAt: new Date() };
      emit();
    },
    async updateNote(pinId, noteId, fields) {
      const n = data.notes[pinId]?.[noteId];
      guard(n && n.authorEmail === me.email, 'edit this note');
      Object.assign(n, clone(fields), { updatedAt: new Date() });
      emit();
    },
    async setLeadStatus(pinId, noteId, status) {
      const n = data.notes[pinId]?.[noteId];
      guard(n && (n.kind === 'lead') && ['open', 'done'].includes(status), 'change this lead');
      n.status = status;
      emit();
    },
    async deleteNote(pinId, noteId) {
      const n = data.notes[pinId]?.[noteId];
      guard(n && (isDM() || n.authorEmail === me.email), 'delete this note');
      delete data.notes[pinId][noteId];
      emit();
    },

    async saveNpc(id, npc, secret, by) {
      guard(isDM(), 'edit NPCs');
      const nid = id || newId();
      data.npcs[nid] = { ...clone(npc), updatedAt: new Date(), updatedBy: by };
      data.npcSecrets[nid] = clone(secret);
      emit();
      return nid;
    },
    async deleteNpc(id) {
      guard(isDM(), 'delete NPCs');
      delete data.npcs[id]; delete data.npcSecrets[id]; delete data.npcNotes[id];
      emit();
    },
    async addNpcNote(npcId, note) {
      guard(note.authorEmail === me.email && (isDM() || data.npcs[npcId]?.visibility === 'public'), 'add this note');
      (data.npcNotes[npcId] ||= {})[newId()] = { ...note, createdAt: new Date(), updatedAt: new Date() };
      emit();
    },
    async updateNpcNote(npcId, noteId, fields) {
      const n = data.npcNotes[npcId]?.[noteId];
      guard(n && n.authorEmail === me.email, 'edit this note');
      Object.assign(n, clone(fields), { updatedAt: new Date() });
      emit();
    },
    async deleteNpcNote(npcId, noteId) {
      const n = data.npcNotes[npcId]?.[noteId];
      guard(n && (isDM() || n.authorEmail === me.email), 'delete this note');
      delete data.npcNotes[npcId][noteId];
      emit();
    },
    async readNpcTexts(npcIds) {
      const out = new Map();
      for (const id of npcIds) {
        const npc = data.npcs[id];
        if (!npc || (!isDM() && npc.visibility !== 'public')) continue;
        out.set(id, { notes: list(data.npcNotes[id] || {}) });
      }
      return out;
    },

    async saveTravelMode(id, m) { guard(isDM(), 'edit travel modes'); data.travelModes[id] = clone(m); emit(); },
    async deleteTravelMode(id) { guard(isDM(), 'edit travel modes'); delete data.travelModes[id]; emit(); },
    async saveAffiliation(id, a) { guard(isDM(), 'edit affiliations'); data.affiliations[id] = clone(a); emit(); },
    async deleteAffiliation(id) { guard(isDM(), 'edit affiliations'); delete data.affiliations[id]; emit(); },
    async reveal(col, id) { guard(isDM(), 'reveal this'); if (data[col]?.[id]) data[col][id].revealed = true; emit(); },

    async setPresenter(state) {
      guard(isDM(), 'present');
      data.presenter = { ...clone(state), updatedAt: new Date() };
      channel?.postMessage(data.presenter); // other demo tabs (a PC view tab) follow
      emit();
    },
    async savePlan(id, plan, dm) {
      guard(!dm || isDM(), 'make DM plans');
      const table = dm ? data.dmPlans : data.plans;
      const pid = id || newId();
      table[pid] = { ...clone(plan), updatedAt: new Date() };
      emit();
      return pid;
    },
    async deletePlan(id, dm) { guard(!dm || isDM(), 'delete DM plans'); delete (dm ? data.dmPlans : data.plans)[id]; emit(); },
    async saveSession(id, x) { guard(isDM(), 'edit sessions'); data.sessions[id] = clone(x); emit(); },
    async deleteSession(id) { guard(isDM(), 'delete sessions'); delete data.sessions[id]; delete data.sessionNotes[id]; delete data.sessionSecrets[id]; emit(); },
    async setSessionSecret(id, text) { guard(isDM(), 'edit DM session notes'); data.sessionSecrets[id] = { text }; emit(); },
    async addSessionNote(id, note) {
      guard(note.authorEmail === me.email, 'write as someone else');
      (data.sessionNotes[id] ||= {})[newId()] = { ...note, createdAt: new Date(), updatedAt: new Date() };
      emit();
    },
    async updateSessionNote(id, noteId, fields) {
      const n = data.sessionNotes[id]?.[noteId];
      guard(n && n.authorEmail === me.email, 'edit this note');
      Object.assign(n, clone(fields), { updatedAt: new Date() });
      emit();
    },
    async deleteSessionNote(id, noteId) {
      const n = data.sessionNotes[id]?.[noteId];
      guard(n && (isDM() || n.authorEmail === me.email), 'delete this note');
      delete data.sessionNotes[id][noteId];
      emit();
    },
    async readSessionTexts(ids) {
      return new Map(ids.filter((id) => data.sessions[id]).map((id) => [id, { notes: list(data.sessionNotes[id] || {}) }]));
    },
    async saveHandout(id, h) {
      guard(isDM(), 'edit handouts');
      const hid = id || newId();
      data.handouts[hid] = { ...clone(h), createdAt: data.handouts[hid]?.createdAt || new Date() };
      emit();
      return hid;
    },
    async deleteHandout(id) { guard(isDM(), 'delete handouts'); delete data.handouts[id]; emit(); },
    async setHandoutVisibility(id, visibility) { guard(isDM(), 'edit handouts'); if (data.handouts[id]) data.handouts[id].visibility = visibility; emit(); },
    async saveImage(img) { guard(isDM(), 'upload images'); const iid = newId(); data.images[iid] = clone(img); return iid; },
    async getImage(id) { return data.images[id]?.data || null; },
    async deleteImage(id) { guard(isDM(), 'delete images'); delete data.images[id]; },

    newId: () => newId(),
    async applyOps(ops) { guard(isDM(), 'make these changes'); applyOps(ops); emit(); },

    async addWaypoint(w) { guard(isDM(), 'edit the route'); data.waypoints[newId()] = clone(w); emit(); },
    async updateWaypoint(id, w) { guard(isDM(), 'edit the route'); Object.assign(data.waypoints[id], clone(w)); emit(); },
    async deleteWaypoint(id) { guard(isDM(), 'edit the route'); delete data.waypoints[id]; emit(); },
    async updateWaypoints(updates) { guard(isDM(), 'edit the route'); for (const u of updates) Object.assign(data.waypoints[u.id], clone(u.data)); emit(); },

    async savePinType(id, t) { guard(isDM(), 'edit pin types'); data.pinTypes[id] = clone(t); emit(); },
    async deletePinType(id) { guard(isDM(), 'edit pin types'); delete data.pinTypes[id]; emit(); },

    async saveMember(email, m) { guard(['admin', 'dm'].includes(data.members[me.email]?.role), 'manage members'); data.members[email] = clone(m); emit(); },
    async deleteMember(email) { guard(['admin', 'dm'].includes(data.members[me.email]?.role), 'manage members'); delete data.members[email]; emit(); },

    async saveSettings(s) { guard(['admin', 'dm'].includes(data.members[me.email]?.role), 'change map settings'); data.settings = clone(s); emit(); },

    projectId: 'demo',

    // Same plan as the Firebase backend, applied to the in-memory data.
    async restoreAll(backup, current, options, onProgress = () => {}) {
      guard(['admin', 'dm'].includes(data.members[me.email]?.role), 'restore a backup');
      const ops = planRestore(backup, current, options);
      const revive = (d) => reviveTimestamps(d, (s, n) => new Date(s * 1000 + Math.floor(n / 1e6)));
      applyOps(ops.map((o) => (o.op === 'set' ? { ...o, data: revive(o.data) } : o)));
      onProgress(ops.length, ops.length);
      emit();
      return ops.length;
    },

    async exportAll() {
      // Dates are written the way Firestore timestamps serialize, like a real backup.
      const asTimestamps = (v) => {
        if (v instanceof Date) return { type: 'firestore/timestamp/1.0', seconds: Math.floor(v.getTime() / 1000), nanoseconds: (v.getTime() % 1000) * 1e6 };
        if (Array.isArray(v)) return v.map(asTimestamps);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asTimestamps(x)]));
        return v;
      };
      return asTimestamps({
        exportedAt: new Date().toISOString(), projectId: 'demo', settings: clone(data.settings),
        members: list(data.members), pinTypes: list(data.pinTypes), waypoints: list(data.waypoints),
        pins: list(data.pins).map((p) => ({ ...p, notes: list(data.notes[p.id] || {}), dmText: data.dm[p.id] || '' })),
        npcs: list(data.npcs).map((n) => ({ ...n, notes: list(data.npcNotes[n.id] || {}) })),
        npcSecrets: list(data.npcSecrets), affiliations: list(data.affiliations), travelModes: list(data.travelModes),
        sessions: list(data.sessions).map((x) => ({ ...x, notes: list(data.sessionNotes[x.id] || {}) })),
        sessionSecrets: list(data.sessionSecrets), plans: list(data.plans), dmPlans: list(data.dmPlans),
        handouts: list(data.handouts), images: list(data.images),
      });
    },
  };
}
