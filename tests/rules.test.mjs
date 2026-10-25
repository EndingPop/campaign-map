// Security rules tests. Run with `npm run test:rules`, which starts the
// Firestore emulator, runs this file, and shuts the emulator down.
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where,
} from 'firebase/firestore';

const ADMIN = 'admin@example.com';
const DM = 'dm@example.com';
const PLAYER = 'player@example.com';
const PLAYER2 = 'player2@example.com';
const STRANGER = 'stranger@example.com';

let env;

function as(email, verified = true) {
  return env.authenticatedContext(email.split('@')[0], { email, email_verified: verified }).firestore();
}

const pin = (over = {}) => ({
  name: 'Test City', x: 100, y: 200, baseType: 'city', rings: [],
  visibility: 'public', description: '', ...over,
});
const note = (author, over = {}) => ({ text: 'A note', authorEmail: author, authorName: 'Someone', ...over });
const npc = (over = {}) => ({
  name: 'Test NPC', status: 'alive', visibility: 'public', description: '', pinIds: [], affiliationIds: [], ...over,
});
const mode = (over = {}) => ({
  label: 'Ship', color: '#336699', line: 'arc', dash: 'solid', revealed: false, paces: { normal: 96 }, ...over,
});
const plan = (by, over = {}) => ({ name: 'Coast road', points: [{ x: 1, y: 1 }, { x: 5, y: 5 }], travel: 'road', createdBy: by, ...over });
const handout = (over = {}) => ({ title: 'Letter', parentKind: 'pin', parentId: 'open', revealed: false, visibility: 'hidden', transcription: '', ...over });
const aff = (over = {}) => ({ name: 'Harpers', color: '#1e5bc6', description: '', revealed: false, ...over });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-map',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(async () => { await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'members', ADMIN), { role: 'admin' });
    await setDoc(doc(db, 'members', DM), { role: 'dm' });
    await setDoc(doc(db, 'members', PLAYER), { role: 'player' });
    await setDoc(doc(db, 'members', PLAYER2), { role: 'player' });
    await setDoc(doc(db, 'pins', 'open'), pin());
    await setDoc(doc(db, 'pins', 'secret'), pin({ visibility: 'hidden' }));
    await setDoc(doc(db, 'pins', 'open', 'dm', 'private'), { text: 'DM only' });
    await setDoc(doc(db, 'pins', 'open', 'notes', 'n1'), note(PLAYER));
    await setDoc(doc(db, 'pins', 'secret', 'notes', 'n2'), note(PLAYER));
    await setDoc(doc(db, 'waypoints', 'w1'), { seq: 1, x: 1, y: 1 });
    await setDoc(doc(db, 'pinTypes', 'city'), { label: 'Town/City', kind: 'base', color: '#c0392b' });
    await setDoc(doc(db, 'settings', 'map'), { imagePath: 'map/map.jpg', imageWidth: 4000, imageHeight: 3000 });
    await setDoc(doc(db, 'npcs', 'known'), npc());
    await setDoc(doc(db, 'npcs', 'unmet'), npc({ visibility: 'hidden', name: 'Secret villain' }));
    await setDoc(doc(db, 'npcs', 'known', 'notes', 'k1'), note(PLAYER));
    await setDoc(doc(db, 'npcs', 'unmet', 'notes', 'u1'), note(DM));
    await setDoc(doc(db, 'npcSecrets', 'known'), { text: 'Works for the cult', hiddenPinIds: ['open'], hiddenAffiliationIds: ['cult'] });
    await setDoc(doc(db, 'travelModes', 'road'), mode({ label: 'Road', line: 'path', revealed: true, paces: { slow: 18, normal: 24, fast: 30 } }));
    await setDoc(doc(db, 'travelModes', 'airship'), mode({ label: 'Airship', revealed: false }));
    await setDoc(doc(db, 'affiliations', 'harpers'), aff({ revealed: true }));
    await setDoc(doc(db, 'affiliations', 'cult'), aff({ name: 'Cult of the Dragon', revealed: false }));
    await setDoc(doc(db, 'presenter', 'state'), { seq: 1, live: false });
    await setDoc(doc(db, 'plans', 'p1'), plan(PLAYER));
    await setDoc(doc(db, 'dmPlans', 'd1'), plan(DM, { name: 'If they take the river' }));
    await setDoc(doc(db, 'sessions', '2026-10-11'), { title: 'Session one' });
    await setDoc(doc(db, 'sessions', '2026-10-11', 'notes', 's1'), note(PLAYER));
    await setDoc(doc(db, 'sessionSecrets', '2026-10-11'), { text: 'Prep' });
    await setDoc(doc(db, 'handouts', 'shown'), handout({ visibility: 'public', revealed: true }));
    await setDoc(doc(db, 'handouts', 'secret'), handout({ title: 'Secret letter' }));
    await setDoc(doc(db, 'images', 'img1'), { data: 'data:image/webp;base64,AAAA' });
  });
});

describe('non-members', () => {
  test('unauthenticated users read nothing', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'pins', 'open')));
    await assertFails(getDoc(doc(db, 'settings', 'map')));
  });
  test('signed-in strangers read nothing', async () => {
    const db = as(STRANGER);
    await assertFails(getDoc(doc(db, 'pins', 'open')));
    await assertFails(getDocs(collection(db, 'waypoints')));
    await assertFails(getDoc(doc(db, 'members', PLAYER)));
    await assertFails(getDocs(collection(db, 'members')));
  });
  test('signed-in strangers may check their own (missing) member entry', async () => {
    await assertSucceeds(getDoc(doc(as(STRANGER), 'members', STRANGER)));
  });
  test('unverified email is refused even if listed', async () => {
    await assertFails(getDoc(doc(as(PLAYER, false), 'pins', 'open')));
  });
});

describe('players', () => {
  test('read revealed pins, route, types, settings, members', async () => {
    const db = as(PLAYER);
    await assertSucceeds(getDoc(doc(db, 'pins', 'open')));
    await assertSucceeds(getDocs(query(collection(db, 'pins'), where('visibility', '==', 'public'))));
    await assertSucceeds(getDocs(collection(db, 'waypoints')));
    await assertSucceeds(getDocs(collection(db, 'pinTypes')));
    await assertSucceeds(getDoc(doc(db, 'settings', 'map')));
    await assertSucceeds(getDocs(collection(db, 'members')));
  });
  test('cannot read hidden pins, or list pins without the visibility filter', async () => {
    const db = as(PLAYER);
    await assertFails(getDoc(doc(db, 'pins', 'secret')));
    await assertFails(getDocs(collection(db, 'pins')));
  });
  test('cannot read DM-only text', async () => {
    await assertFails(getDoc(doc(as(PLAYER), 'pins', 'open', 'dm', 'private')));
  });
  test('cannot read notes on hidden pins', async () => {
    await assertFails(getDocs(collection(as(PLAYER), 'pins', 'secret', 'notes')));
  });
  test('read all notes on revealed pins', async () => {
    await assertSucceeds(getDocs(collection(as(PLAYER2), 'pins', 'open', 'notes')));
  });
  test('cannot write pins, waypoints, types, members, settings', async () => {
    const db = as(PLAYER);
    await assertFails(setDoc(doc(db, 'pins', 'new'), pin()));
    await assertFails(updateDoc(doc(db, 'pins', 'open'), { name: 'Renamed' }));
    await assertFails(setDoc(doc(db, 'waypoints', 'w2'), { seq: 2, x: 1, y: 1 }));
    await assertFails(setDoc(doc(db, 'pinTypes', 'x'), { label: 'X', kind: 'base', color: 'red' }));
    await assertFails(setDoc(doc(db, 'members', PLAYER), { role: 'admin' }));
    await assertFails(setDoc(doc(db, 'settings', 'map'), { imagePath: 'x' }));
  });
  test('add own note on a revealed pin', async () => {
    await assertSucceeds(setDoc(doc(as(PLAYER2), 'pins', 'open', 'notes', 'n3'), note(PLAYER2)));
  });
  test('cannot add a note as someone else, or on a hidden pin', async () => {
    const db = as(PLAYER2);
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'n3'), note(PLAYER)));
    await assertFails(setDoc(doc(db, 'pins', 'secret', 'notes', 'n3'), note(PLAYER2)));
  });
  test('cannot add extra fields or oversized text', async () => {
    const db = as(PLAYER2);
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'n3'), note(PLAYER2, { pinned: true })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'n3'), note(PLAYER2, { text: 'x'.repeat(4001) })));
  });
  test('edit and delete own note only', async () => {
    await assertSucceeds(updateDoc(doc(as(PLAYER), 'pins', 'open', 'notes', 'n1'), { text: 'Edited' }));
    await assertFails(updateDoc(doc(as(PLAYER2), 'pins', 'open', 'notes', 'n1'), { text: 'Hijack' }));
    await assertFails(deleteDoc(doc(as(PLAYER2), 'pins', 'open', 'notes', 'n1')));
    await assertSucceeds(deleteDoc(doc(as(PLAYER), 'pins', 'open', 'notes', 'n1')));
  });
  test('cannot reassign own note to another author', async () => {
    await assertFails(updateDoc(doc(as(PLAYER), 'pins', 'open', 'notes', 'n1'), { authorEmail: PLAYER2 }));
  });
  test('add leads and people met on revealed pins only', async () => {
    const db = as(PLAYER2);
    await assertSucceeds(setDoc(doc(db, 'pins', 'open', 'notes', 'l1'), note(PLAYER2, { kind: 'lead', status: 'open' })));
    await assertSucceeds(setDoc(doc(db, 'pins', 'open', 'notes', 'p1'), note(PLAYER2, { kind: 'npc', name: 'Innkeeper' })));
    await assertFails(setDoc(doc(db, 'pins', 'secret', 'notes', 'l2'), note(PLAYER2, { kind: 'lead', status: 'open' })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'x1'), note(PLAYER2, { kind: 'quest' })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'x2'), note(PLAYER2, { kind: 'lead', status: 'maybe' })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'x3'), note(PLAYER2, { kind: 'npc', name: 'n'.repeat(101) })));
  });
  test('anyone may mark someone else\'s lead done, but change nothing else', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'pins', 'open', 'notes', 'l1'), note(PLAYER, { kind: 'lead', status: 'open' }));
    });
    const db = as(PLAYER2);
    await assertSucceeds(updateDoc(doc(db, 'pins', 'open', 'notes', 'l1'), { status: 'done' }));
    await assertFails(updateDoc(doc(db, 'pins', 'open', 'notes', 'l1'), { status: 'lost' }));
    await assertFails(updateDoc(doc(db, 'pins', 'open', 'notes', 'l1'), { status: 'open', text: 'Hijack' }));
    await assertFails(updateDoc(doc(db, 'pins', 'open', 'notes', 'n1'), { status: 'done' })); // a plain note has no status
  });
});

describe('players: NPCs, affiliations, travel modes', () => {
  test('read revealed NPCs and their notes, not hidden ones', async () => {
    const db = as(PLAYER2);
    await assertSucceeds(getDoc(doc(db, 'npcs', 'known')));
    await assertSucceeds(getDocs(query(collection(db, 'npcs'), where('visibility', '==', 'public'))));
    await assertSucceeds(getDocs(collection(db, 'npcs', 'known', 'notes')));
    await assertFails(getDoc(doc(db, 'npcs', 'unmet')));
    await assertFails(getDocs(collection(db, 'npcs')));
    await assertFails(getDocs(collection(db, 'npcs', 'unmet', 'notes')));
  });
  test('never read NPC secrets (DM notes, hidden links and affiliations)', async () => {
    const db = as(PLAYER);
    await assertFails(getDoc(doc(db, 'npcSecrets', 'known')));
    await assertFails(getDocs(collection(db, 'npcSecrets')));
  });
  test('cannot create or edit NPCs or their secrets', async () => {
    const db = as(PLAYER);
    await assertFails(setDoc(doc(db, 'npcs', 'mine'), npc()));
    await assertFails(updateDoc(doc(db, 'npcs', 'known'), { status: 'dead' }));
    await assertFails(deleteDoc(doc(db, 'npcs', 'known')));
    await assertFails(setDoc(doc(db, 'npcSecrets', 'known'), { text: '' }));
  });
  test('add, edit and delete their own notes on revealed NPCs only', async () => {
    const db = as(PLAYER2);
    await assertSucceeds(setDoc(doc(db, 'npcs', 'known', 'notes', 'k2'), note(PLAYER2)));
    await assertSucceeds(updateDoc(doc(db, 'npcs', 'known', 'notes', 'k2'), { text: 'Edited' }));
    await assertFails(setDoc(doc(db, 'npcs', 'unmet', 'notes', 'u2'), note(PLAYER2)));
    await assertFails(setDoc(doc(db, 'npcs', 'known', 'notes', 'k3'), note(PLAYER)));
    await assertFails(setDoc(doc(db, 'npcs', 'known', 'notes', 'k4'), note(PLAYER2, { kind: 'lead' })));
    await assertFails(updateDoc(doc(db, 'npcs', 'known', 'notes', 'k1'), { text: 'Hijack' }));
    await assertFails(deleteDoc(doc(db, 'npcs', 'known', 'notes', 'k1')));
    await assertSucceeds(deleteDoc(doc(db, 'npcs', 'known', 'notes', 'k2')));
  });
  test('read only revealed travel modes and affiliations', async () => {
    const db = as(PLAYER);
    await assertSucceeds(getDoc(doc(db, 'travelModes', 'road')));
    await assertSucceeds(getDocs(query(collection(db, 'travelModes'), where('revealed', '==', true))));
    await assertFails(getDoc(doc(db, 'travelModes', 'airship')));
    await assertFails(getDocs(collection(db, 'travelModes')));
    await assertSucceeds(getDoc(doc(db, 'affiliations', 'harpers')));
    await assertSucceeds(getDocs(query(collection(db, 'affiliations'), where('revealed', '==', true))));
    await assertFails(getDoc(doc(db, 'affiliations', 'cult')));
    await assertFails(getDocs(collection(db, 'affiliations')));
  });
  test('cannot write travel modes or affiliations', async () => {
    const db = as(PLAYER);
    await assertFails(updateDoc(doc(db, 'travelModes', 'airship'), { revealed: true }));
    await assertFails(setDoc(doc(db, 'travelModes', 'walk'), mode()));
    await assertFails(updateDoc(doc(db, 'affiliations', 'cult'), { revealed: true }));
  });
});

describe('DM: NPCs, affiliations, travel modes', () => {
  test('reads everything, including hidden NPCs and secrets', async () => {
    const db = as(DM);
    await assertSucceeds(getDocs(collection(db, 'npcs')));
    await assertSucceeds(getDocs(collection(db, 'npcSecrets')));
    await assertSucceeds(getDocs(collection(db, 'npcs', 'unmet', 'notes')));
    await assertSucceeds(getDocs(collection(db, 'travelModes')));
    await assertSucceeds(getDocs(collection(db, 'affiliations')));
  });
  test('creates, edits and deletes NPCs and secrets', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'npcs', 'new'), npc({ pinIds: ['open'], affiliationIds: ['harpers'], status: 'missing' })));
    await assertSucceeds(setDoc(doc(db, 'npcSecrets', 'new'), { text: 'x', hiddenPinIds: [], hiddenAffiliationIds: [] }));
    await assertSucceeds(updateDoc(doc(db, 'npcs', 'new'), { visibility: 'hidden' }));
    await assertSucceeds(deleteDoc(doc(db, 'npcs', 'new')));
  });
  test('rejects malformed NPCs', async () => {
    const db = as(DM);
    await assertFails(setDoc(doc(db, 'npcs', 'bad'), npc({ status: 'undead' })));
    await assertFails(setDoc(doc(db, 'npcs', 'bad'), npc({ name: '' })));
    await assertFails(setDoc(doc(db, 'npcs', 'bad'), npc({ visibility: 'secret' })));
    await assertFails(setDoc(doc(db, 'npcs', 'bad'), npc({ pinIds: 'open' })));
  });
  test('writes NPC notes under original authors (conversion and restore)', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'npcs', 'unmet', 'notes', 'c1'), note(PLAYER)));
    await assertFails(setDoc(doc(db, 'npcs', 'unmet', 'notes', 'c2'), note(PLAYER, { name: 'x' })));
  });
  test('manages travel modes and affiliations, with shape checks', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'travelModes', 'ship'), mode({ paces: { slow: null, normal: 96, fast: null } })));
    await assertSucceeds(updateDoc(doc(db, 'travelModes', 'airship'), { revealed: true }));
    await assertFails(setDoc(doc(db, 'travelModes', 'bad'), mode({ line: 'zigzag' })));
    await assertFails(setDoc(doc(db, 'travelModes', 'bad'), mode({ paces: { cruising: 50 } })));
    await assertFails(setDoc(doc(db, 'travelModes', 'bad'), mode({ revealed: 'yes' })));
    await assertSucceeds(deleteDoc(doc(db, 'travelModes', 'ship')));
    await assertSucceeds(setDoc(doc(db, 'affiliations', 'zhent'), aff({ name: 'Zhentarim', description: 'Black Network' })));
    await assertFails(setDoc(doc(db, 'affiliations', 'bad'), aff({ name: '' })));
    await assertFails(setDoc(doc(db, 'affiliations', 'bad'), aff({ description: 'x'.repeat(2001) })));
    await assertSucceeds(deleteDoc(doc(db, 'affiliations', 'zhent')));
  });
});

describe('players: presenter, plans, sessions, handouts, images', () => {
  test('read the presenter state but cannot write it', async () => {
    const db = as(PLAYER);
    await assertSucceeds(getDoc(doc(db, 'presenter', 'state')));
    await assertFails(setDoc(doc(db, 'presenter', 'state'), { seq: 2 }));
  });
  test('draw, edit and delete party plans, including other players\' plans', async () => {
    const db = as(PLAYER2);
    await assertSucceeds(getDocs(collection(db, 'plans')));
    await assertSucceeds(setDoc(doc(db, 'plans', 'p2'), plan(PLAYER2)));
    await assertSucceeds(updateDoc(doc(db, 'plans', 'p1'), { name: 'Coast road, then north' }));
    await assertFails(setDoc(doc(db, 'plans', 'p3'), plan(PLAYER2, { points: [{ x: 1, y: 1 }] })));
    await assertFails(setDoc(doc(db, 'plans', 'p3'), plan(PLAYER2, { name: '' })));
    await assertSucceeds(deleteDoc(doc(db, 'plans', 'p1')));
  });
  test('never read or write DM plans', async () => {
    const db = as(PLAYER);
    await assertFails(getDoc(doc(db, 'dmPlans', 'd1')));
    await assertFails(getDocs(collection(db, 'dmPlans')));
    await assertFails(setDoc(doc(db, 'dmPlans', 'd2'), plan(PLAYER)));
  });
  test('read sessions and add their own recap notes, but not DM session notes', async () => {
    const db = as(PLAYER2);
    await assertSucceeds(getDocs(collection(db, 'sessions')));
    await assertSucceeds(getDocs(collection(db, 'sessions', '2026-10-11', 'notes')));
    await assertSucceeds(setDoc(doc(db, 'sessions', '2026-10-11', 'notes', 's2'), note(PLAYER2)));
    await assertFails(setDoc(doc(db, 'sessions', '2026-10-11', 'notes', 's3'), note(PLAYER)));
    await assertFails(updateDoc(doc(db, 'sessions', '2026-10-11', 'notes', 's1'), { text: 'Hijack' }));
    await assertFails(setDoc(doc(db, 'sessions', '2026-10-12'), { title: 'Mine' }));
    await assertFails(getDoc(doc(db, 'sessionSecrets', '2026-10-11')));
  });
  test('read only public handouts, and cannot write handouts', async () => {
    const db = as(PLAYER);
    await assertSucceeds(getDoc(doc(db, 'handouts', 'shown')));
    await assertSucceeds(getDocs(query(collection(db, 'handouts'), where('visibility', '==', 'public'))));
    await assertFails(getDoc(doc(db, 'handouts', 'secret')));
    await assertFails(getDocs(collection(db, 'handouts')));
    await assertFails(updateDoc(doc(db, 'handouts', 'secret'), { visibility: 'public' }));
  });
  test('fetch an image by id, but cannot list or write images', async () => {
    const db = as(PLAYER);
    await assertSucceeds(getDoc(doc(db, 'images', 'img1')));
    await assertFails(getDocs(collection(db, 'images')));
    await assertFails(setDoc(doc(db, 'images', 'img2'), { data: 'data:image/webp;base64,AAAA' }));
  });
});

describe('DM: presenter, plans, sessions, handouts, images, game dates', () => {
  test('writes the presenter state and DM plans', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'presenter', 'state'), { seq: 2, live: true }));
    await assertSucceeds(getDocs(collection(db, 'dmPlans')));
    await assertSucceeds(setDoc(doc(db, 'dmPlans', 'd2'), plan(DM)));
  });
  test('manages sessions and their DM notes', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'sessions', '2026-10-18'), { title: 'Two' }));
    await assertFails(setDoc(doc(db, 'sessions', 'next-week'), { title: 'Bad id' }));
    await assertSucceeds(setDoc(doc(db, 'sessionSecrets', '2026-10-18'), { text: 'Prep' }));
    await assertSucceeds(setDoc(doc(db, 'sessions', '2026-10-11', 'notes', 'r1'), note(PLAYER))); // restore under the original author
  });
  test('manages handouts and images, with shape checks', async () => {
    const db = as(DM);
    await assertSucceeds(getDocs(collection(db, 'handouts')));
    await assertSucceeds(setDoc(doc(db, 'handouts', 'h3'), handout({ parentKind: 'npc', parentId: 'known', url: 'https://example.com/a.png' })));
    await assertFails(setDoc(doc(db, 'handouts', 'bad'), handout({ parentKind: 'stop' })));
    await assertFails(setDoc(doc(db, 'handouts', 'bad'), handout({ visibility: 'secret' })));
    await assertSucceeds(getDocs(collection(db, 'images')));
    await assertSucceeds(setDoc(doc(db, 'images', 'img3'), { data: 'data:image/webp;base64,AAAA', width: 512, height: 512 }));
    await assertFails(setDoc(doc(db, 'images', 'big'), { data: 'x'.repeat(1000001) }));
  });
  test('saves in-game dates on stops', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'waypoints', 'g1'), { seq: 9, x: 1, y: 1, gameDate: { year: 1491, period: 6, day: 15 } }));
    await assertSucceeds(setDoc(doc(db, 'waypoints', 'g2'), { seq: 10, x: 1, y: 1, gameDay: 37, gameDateText: 'The night of the storm' }));
    await assertFails(setDoc(doc(db, 'waypoints', 'g3'), { seq: 11, x: 1, y: 1, gameDate: { year: '1491', period: 6, day: 15 } }));
    await assertFails(setDoc(doc(db, 'waypoints', 'g4'), { seq: 12, x: 1, y: 1, gameDate: { year: 1491, period: 6, day: 15, hour: 3 } }));
  });
});

describe('DM', () => {
  test('reads everything including hidden pins and DM text', async () => {
    const db = as(DM);
    await assertSucceeds(getDocs(collection(db, 'pins')));
    await assertSucceeds(getDoc(doc(db, 'pins', 'secret')));
    await assertSucceeds(getDoc(doc(db, 'pins', 'open', 'dm', 'private')));
    await assertSucceeds(getDocs(collection(db, 'pins', 'secret', 'notes')));
  });
  test('creates, edits, hides and deletes pins', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'pins', 'new'), pin({ rings: ['ring-a', 'ring-b'] })));
    await assertSucceeds(updateDoc(doc(db, 'pins', 'new'), { visibility: 'hidden' }));
    await assertSucceeds(deleteDoc(doc(db, 'pins', 'new')));
  });
  test('rejects malformed pins', async () => {
    const db = as(DM);
    await assertFails(setDoc(doc(db, 'pins', 'bad'), pin({ visibility: 'secret' })));
    await assertFails(setDoc(doc(db, 'pins', 'bad'), pin({ x: '100' })));
    await assertFails(setDoc(doc(db, 'pins', 'bad'), pin({ name: '' })));
  });
  test('manages waypoints, pin types and DM text', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'waypoints', 'w2'), { seq: 2, x: 5, y: 5 }));
    await assertSucceeds(updateDoc(doc(db, 'waypoints', 'w2'), { path: [{ x: 2, y: 3 }, { x: 4, y: 4 }] }));
    await assertFails(updateDoc(doc(db, 'waypoints', 'w2'), { path: 'not a list' }));
    await assertFails(updateDoc(doc(db, 'waypoints', 'w2'), { path: Array.from({ length: 301 }, () => ({ x: 1, y: 1 })) }));
    await assertSucceeds(updateDoc(doc(db, 'waypoints', 'w2'), { travel: 'teleport', path: [] }));
    await assertSucceeds(updateDoc(doc(db, 'waypoints', 'w2'), { travel: 'road' }));
    await assertSucceeds(updateDoc(doc(db, 'waypoints', 'w2'), { travel: 'airship' })); // any travel mode id
    await assertFails(updateDoc(doc(db, 'waypoints', 'w2'), { travel: '' }));
    await assertFails(updateDoc(doc(db, 'waypoints', 'w2'), { travel: 7 }));
    await assertSucceeds(deleteDoc(doc(db, 'waypoints', 'w2')));
    await assertSucceeds(setDoc(doc(db, 'pinTypes', 'giant'), { label: 'Giant sighting', kind: 'base', color: '#555' }));
    await assertFails(setDoc(doc(db, 'pinTypes', 'bad'), { label: 'Bad', kind: 'square', color: '#555' }));
    await assertSucceeds(setDoc(doc(db, 'pinTypes', 'ring-a'), { label: 'Ring A', kind: 'ring', color: '#555', ringOrder: 1, affiliationId: 'a1' }));
    await assertFails(setDoc(doc(db, 'pinTypes', 'ring-b'), { label: 'Ring B', kind: 'ring', color: '#555', affiliationId: 7 }));
    await assertSucceeds(setDoc(doc(db, 'pins', 'open', 'dm', 'private'), { text: 'Changed' }));
  });
  test('deletes any note, and can restore notes under their original authors', async () => {
    const db = as(DM);
    await assertSucceeds(deleteDoc(doc(db, 'pins', 'open', 'notes', 'n1')));
    await assertSucceeds(setDoc(doc(db, 'pins', 'open', 'notes', 'n9'), note(PLAYER)));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'n10'), note(PLAYER, { kind: 'quest' })));
  });
  test('has admin powers: members and settings', async () => {
    const db = as(DM);
    await assertSucceeds(setDoc(doc(db, 'members', STRANGER), { role: 'player' }));
    await assertFails(setDoc(doc(db, 'members', 'y@example.com'), { role: 'owner' }));
    await assertSucceeds(deleteDoc(doc(db, 'members', STRANGER)));
    await assertSucceeds(setDoc(doc(db, 'settings', 'map'), { imagePath: 'map/map.jpg', imageWidth: 1, imageHeight: 1 }));
  });
});

describe('admin', () => {
  test('manages members and settings', async () => {
    const db = as(ADMIN);
    await assertSucceeds(setDoc(doc(db, 'members', STRANGER), { role: 'player' }));
    await assertFails(setDoc(doc(db, 'members', 'Mixed@Example.com'), { role: 'player' }));
    await assertFails(setDoc(doc(db, 'members', 'x@example.com'), { role: 'owner' }));
    await assertSucceeds(deleteDoc(doc(db, 'members', STRANGER)));
    await assertSucceeds(setDoc(doc(db, 'settings', 'map'), { imagePath: 'map/map.jpg', imageWidth: 1, imageHeight: 1 }));
  });
  test('has DM powers', async () => {
    await assertSucceeds(getDoc(doc(as(ADMIN), 'pins', 'secret')));
  });
  test('restores notes under their original authors, still checking their shape', async () => {
    const db = as(ADMIN);
    await assertSucceeds(setDoc(doc(db, 'pins', 'open', 'notes', 'r1'), note(PLAYER, { kind: 'lead', status: 'done' })));
    await assertSucceeds(setDoc(doc(db, 'pins', 'secret', 'notes', 'n2'), note(PLAYER2, { text: 'Restored text' })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'r2'), note(PLAYER, { kind: 'quest' })));
    await assertFails(setDoc(doc(db, 'pins', 'open', 'notes', 'r3'), note(PLAYER, { extra: true })));
  });
  test('players may never write notes under someone else\'s name', async () => {
    await assertFails(setDoc(doc(as(PLAYER2), 'pins', 'open', 'notes', 'r5'), note(PLAYER)));
    await assertFails(updateDoc(doc(as(PLAYER2), 'pins', 'open', 'notes', 'n1'), { text: 'Rewritten' }));
  });
});
