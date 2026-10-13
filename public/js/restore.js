// Restore from a backup made by "Download backup (JSON)".
// This module is pure: it checks a backup and turns it into a list of
// writes; each backend carries the writes out. Keeping it pure lets the
// planning be tested in Node and shared by the Firebase and demo backends.
//
// A restore makes the database match the backup:
//   - every document in the backup is written back under its original id
//     (so route stops keep pointing at the same pins);
//   - documents that exist now but are not in the backup are deleted.
// Members are only touched when asked, and the admin doing the restore is
// never removed or changed, so they cannot lock themselves out.

const TIMESTAMP_TYPE = 'firestore/timestamp/1.0';

// Turns the JSON form of Firestore timestamps back into values the backend
// can store. `makeTimestamp(seconds, nanoseconds)` is supplied by the backend.
export function reviveTimestamps(value, makeTimestamp) {
  if (Array.isArray(value)) return value.map((v) => reviveTimestamps(v, makeTimestamp));
  if (value && typeof value === 'object') {
    if (value.type === TIMESTAMP_TYPE && Number.isFinite(value.seconds)) {
      return makeTimestamp(value.seconds, value.nanoseconds || 0);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveTimestamps(v, makeTimestamp)]));
  }
  return value;
}

// Parses and checks a backup file's text. Throws an Error with a message
// meant for the person restoring.
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const lists = ['pins', 'waypoints', 'pinTypes', 'members'];
  if (!data || typeof data !== 'object' || !data.exportedAt || lists.some((k) => !Array.isArray(data[k]))) {
    throw new Error('That file is not a map backup (it needs exportedAt, pins, waypoints, pinTypes and members).');
  }
  for (const k of lists) {
    if (data[k].some((d) => !d || typeof d.id !== 'string' || !d.id || d.id.includes('/'))) {
      throw new Error(`The backup's ${k} list has an entry without a usable id.`);
    }
  }
  for (const p of data.pins) {
    if (p.notes != null && !Array.isArray(p.notes)) throw new Error(`Pin "${p.name || p.id}" has malformed notes.`);
    if ((p.notes || []).some((n) => !n || typeof n.id !== 'string' || !n.id)) throw new Error(`Pin "${p.name || p.id}" has a note without an id.`);
  }
  return data;
}

export function summarize(backup) {
  const notes = backup.pins.flatMap((p) => p.notes || []);
  const kind = (n) => n.kind || 'note';
  return {
    exportedAt: backup.exportedAt,
    projectId: backup.projectId || 'unknown',
    pins: backup.pins.length,
    hiddenPins: backup.pins.filter((p) => p.visibility === 'hidden').length,
    notes: notes.filter((n) => kind(n) === 'note').length,
    leads: notes.filter((n) => kind(n) === 'lead').length,
    people: notes.filter((n) => kind(n) === 'npc').length,
    dmTexts: backup.pins.filter((p) => p.dmText).length,
    stops: backup.waypoints.length,
    pinTypes: backup.pinTypes.length,
    members: backup.members.length,
    hasSettings: !!backup.settings,
  };
}

const withoutId = ({ id, ...rest }) => rest;

// Returns [{ op: 'set' | 'delete', path: [...segments], data? }].
// `current` is an export of the database as it is now (same shape as a backup).
// options.members: also restore the member list.
// options.keepEmail: the signed-in admin; their member entry is never touched.
export function planRestore(backup, current, { members = false, keepEmail = '' } = {}) {
  const ops = [];
  const set = (path, data) => ops.push({ op: 'set', path, data });
  const del = (path) => ops.push({ op: 'delete', path });
  const ids = (list) => new Set(list.map((d) => d.id));

  // Deletions first: whatever exists now and is not in the backup.
  const backupPins = new Map(backup.pins.map((p) => [p.id, p]));
  for (const pin of current.pins) {
    const keep = backupPins.get(pin.id);
    const keepNotes = ids(keep?.notes || []);
    for (const n of pin.notes || []) if (!keepNotes.has(n.id)) del(['pins', pin.id, 'notes', n.id]);
    if (pin.dmText && !keep?.dmText) del(['pins', pin.id, 'dm', 'private']);
    if (!keep) del(['pins', pin.id]);
  }
  for (const [col, list] of [['waypoints', backup.waypoints], ['pinTypes', backup.pinTypes]]) {
    const keep = ids(list);
    for (const d of current[col]) if (!keep.has(d.id)) del([col, d.id]);
  }
  const keepLower = keepEmail.toLowerCase();
  if (members) {
    const keep = ids(backup.members);
    for (const m of current.members) if (!keep.has(m.id) && m.id !== keepLower) del(['members', m.id]);
  }

  // Then writes, parents before children.
  if (backup.settings) set(['settings', 'map'], backup.settings);
  for (const t of backup.pinTypes) set(['pinTypes', t.id], withoutId(t));
  for (const p of backup.pins) {
    const { id, notes = [], dmText = '', ...pin } = p;
    set(['pins', id], pin);
    if (dmText) set(['pins', id, 'dm', 'private'], { text: dmText });
    for (const n of notes) set(['pins', id, 'notes', n.id], withoutId(n));
  }
  for (const w of backup.waypoints) set(['waypoints', w.id], withoutId(w));
  if (members) for (const m of backup.members) if (m.id !== keepLower) set(['members', m.id], withoutId(m));
  return ops;
}
