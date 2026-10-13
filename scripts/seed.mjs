// Fills the LOCAL Firestore emulator with test members, pin types, pins and
// a short route. It always targets the emulator (127.0.0.1:8080, project
// demo-map) and cannot touch the dev or prod Firebase projects.
// Usage: start `npm run emulators` in one terminal, then `npm run seed`.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
const { STARTING_PIN_TYPES, STARTING_TRAVEL_MODES } = await import('../public/js/config.js');
const [RING_A, RING_B] = STARTING_PIN_TYPES.filter((t) => t.kind === 'ring').map((t) => t.id);

initializeApp({ projectId: 'demo-map' });
const db = getFirestore();

const members = {
  'admin@example.com': { role: 'admin', displayName: 'Test Admin', characterName: '' },
  'dm@example.com': { role: 'dm', displayName: 'Test DM', characterName: '' },
  'player@example.com': { role: 'player', displayName: 'Test Player', characterName: 'Test Hero' },
};

const pins = {
  p1: { name: 'First Town', x: 1450, y: 1050, baseType: 'city', rings: [], visibility: 'public', description: 'Test pin: plain town.' },
  p2: { name: 'Ridgeford', x: 1650, y: 900, baseType: 'city', rings: [RING_A].filter(Boolean), visibility: 'public', description: '' },
  p3: { name: 'Waystation', x: 1900, y: 700, baseType: 'city', rings: [RING_B].filter(Boolean), visibility: 'public', description: '' },
  p4: { name: 'Port Calder', x: 2150, y: 1050, baseType: 'city', rings: [RING_A, RING_B].filter(Boolean), visibility: 'public', description: 'Test pin: both rings.' },
  p5: { name: 'Old Ruins', x: 1750, y: 1250, baseType: 'notable', rings: [], visibility: 'public', description: '' },
  p6: { name: 'Hidden Place', x: 2300, y: 1350, baseType: 'notable', rings: [], visibility: 'hidden', description: 'Players should not see this pin.' },
};

const waypoints = {
  w1: { seq: 1, x: 1450, y: 1050, label: 'First Town', pinId: 'p1', sessionDate: '2026-09-20' },
  w2: { seq: 2, x: 1560, y: 1000, path: [{ x: 1490, y: 1075 }, { x: 1530, y: 1060 }], label: 'Road camp', pinId: null, sessionDate: '2026-09-27' },
  w3: { seq: 3, x: 1650, y: 900, path: [{ x: 1600, y: 925 }], label: 'Ridgeford', pinId: 'p2', sessionDate: '2026-10-04' },
  w4: { seq: 4, x: 1900, y: 700, path: [{ x: 1720, y: 830 }, { x: 1820, y: 760 }], travel: 'road', label: 'Waystation', pinId: 'p3', sessionDate: '2026-10-11' },
  w5: { seq: 5, x: 2150, y: 1050, path: [], travel: 'teleport', label: 'Port Calder', pinId: 'p4', sessionDate: '2026-10-11' },
};

const batch = db.batch();
for (const [email, m] of Object.entries(members)) batch.set(db.doc(`members/${email}`), { ...m, addedAt: FieldValue.serverTimestamp() });
for (const { id, ...t } of STARTING_PIN_TYPES) batch.set(db.doc(`pinTypes/${id}`), t);
for (const [id, p] of Object.entries(pins)) batch.set(db.doc(`pins/${id}`), { ...p, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'seed' });
batch.set(db.doc('pins/p1/dm/private'), { text: 'Test DM-only text.' });
const seedNote = (o) => ({ ...o, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
batch.set(db.doc('pins/p1/notes/lead1'), seedNote({ kind: 'lead', status: 'open', text: 'Test lead: the mill road is watched at night.', authorEmail: 'player@example.com', authorName: 'Test Hero (Test Player)' }));
batch.set(db.doc('pins/p1/notes/npc1'), seedNote({ kind: 'npc', name: 'Test innkeeper', text: 'Test person met here.', authorEmail: 'player@example.com', authorName: 'Test Hero (Test Player)' }));
batch.set(db.doc('pins/p6/notes/seed1'), { text: 'Note on a hidden pin: players must not see this.', authorEmail: 'dm@example.com', authorName: 'Test DM', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
for (const [id, w] of Object.entries(waypoints)) batch.set(db.doc(`waypoints/${id}`), w);
// Travel modes as the DM's app creates them; the teleport is revealed because w5 uses it.
for (const { id, ...m } of STARTING_TRAVEL_MODES) batch.set(db.doc(`travelModes/${id}`), { ...m, revealed: true });
batch.set(db.doc('travelModes/ship'), { label: 'Ship', inline: 'ship', color: '#2a7fb8', line: 'arc', dash: 'solid', paces: { normal: 96 }, revealed: false, sortOrder: 3 });
batch.set(db.doc('affiliations/a1'), { name: 'Test guild', color: '#d4a017', description: 'Known to players.', revealed: true });
batch.set(db.doc('affiliations/a2'), { name: 'Test cult', color: '#7a2e2e', description: 'Players must not see this.', revealed: false });
const npcs = {
  n1: [{ name: 'Test peddler', status: 'alive', visibility: 'public', description: 'Visible NPC.', pinIds: ['p2', 'p3'], affiliationIds: ['a1'] },
    { text: 'Test DM note on a visible NPC.', hiddenPinIds: ['p6'], hiddenAffiliationIds: ['a2'], sourceNotes: [] }],
  n2: [{ name: 'Test villain', status: 'unknown', visibility: 'hidden', description: 'Players must not see this NPC.', pinIds: [], affiliationIds: [] },
    { text: '', hiddenPinIds: [], hiddenAffiliationIds: ['a2'], sourceNotes: [] }],
};
for (const [id, [n, secret]] of Object.entries(npcs)) {
  batch.set(db.doc(`npcs/${id}`), { ...n, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'seed' });
  batch.set(db.doc(`npcSecrets/${id}`), secret);
}
batch.set(db.doc('npcs/n1/notes/s1'), seedNote({ text: 'Test note on an NPC.', authorEmail: 'player@example.com', authorName: 'Test Hero (Test Player)' }));
batch.set(db.doc('settings/map'), { imagePath: 'map/map.jpg', imageWidth: 2576, imageHeight: 1667 });
await batch.commit();

console.log(`Seeded the local emulator: ${Object.keys(members).length} members, ${STARTING_PIN_TYPES.length} pin types, ${Object.keys(pins).length} pins, ${Object.keys(npcs).length} NPCs, ${Object.keys(waypoints).length} route stops.`);
process.exit(0);
