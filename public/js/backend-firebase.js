// Data access through Firebase Auth and Firestore. Every watch* function
// returns an unsubscribe function. backend-demo.js implements the same API
// in memory.
import {
  initializeApp, getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut as fbSignOut, getFirestore, connectFirestoreEmulator,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, serverTimestamp, writeBatch, Timestamp,
} from '../vendor/firebase.js';
import { planRestore, reviveTimestamps } from './restore.js';

// Firestore allows 500 writes per batch; stay under it.
const RESTORE_BATCH = 400;

export function createFirebaseBackend(config, { emulators = false, onError = console.error } = {}) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (emulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  const listDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const watch = (ref, cb, map = listDocs) =>
    onSnapshot(ref, (snap) => cb(map(snap)), (err) => onError(err));

  return {
    kind: 'firebase',

    onAuth(cb) {
      return onAuthStateChanged(auth, (u) => cb(u ? { email: u.email.toLowerCase(), displayName: u.displayName || '' } : null));
    },
    async signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    },
    signOut: () => fbSignOut(auth),

    watchMember: (email, cb) =>
      watch(doc(db, 'members', email), cb, (s) => (s.exists() ? { id: s.id, ...s.data() } : null)),
    watchMembers: (cb) => watch(collection(db, 'members'), cb),
    watchSettings: (cb) => watch(doc(db, 'settings', 'map'), cb, (s) => (s.exists() ? s.data() : null)),
    watchPinTypes: (cb) => watch(collection(db, 'pinTypes'), cb),
    watchPins: (isDM, cb) =>
      watch(isDM ? collection(db, 'pins') : query(collection(db, 'pins'), where('visibility', '==', 'public')), cb),
    // Players get only revealed modes, affiliations and NPCs (the rules refuse
    // anything else); the DM gets all of them.
    watchTravelModes: (isDM, cb) =>
      watch(isDM ? collection(db, 'travelModes') : query(collection(db, 'travelModes'), where('revealed', '==', true)), cb),
    watchAffiliations: (isDM, cb) =>
      watch(isDM ? collection(db, 'affiliations') : query(collection(db, 'affiliations'), where('revealed', '==', true)), cb),
    watchNpcs: (isDM, cb) =>
      watch(isDM ? collection(db, 'npcs') : query(collection(db, 'npcs'), where('visibility', '==', 'public')), cb),
    watchNpcSecrets: (cb) => watch(collection(db, 'npcSecrets'), cb),
    watchNpcNotes: (npcId, cb) => watch(collection(db, 'npcs', npcId, 'notes'), cb),
    watchWaypoints: (cb) => watch(collection(db, 'waypoints'), cb),
    watchNotes: (pinId, cb) => watch(collection(db, 'pins', pinId, 'notes'), cb),
    watchDmText: (pinId, cb) =>
      watch(doc(db, 'pins', pinId, 'dm', 'private'), cb, (s) => (s.exists() ? s.data().text || '' : '')),

    async savePin(id, data, by) {
      const body = { ...data, updatedAt: serverTimestamp(), updatedBy: by };
      if (id) { await setDoc(doc(db, 'pins', id), body); return id; }
      return (await addDoc(collection(db, 'pins'), body)).id;
    },
    async deletePin(id) {
      const batch = writeBatch(db);
      (await getDocs(collection(db, 'pins', id, 'notes'))).forEach((n) => batch.delete(n.ref));
      batch.delete(doc(db, 'pins', id, 'dm', 'private'));
      batch.delete(doc(db, 'pins', id));
      await batch.commit();
    },
    setDmText: (pinId, text) => setDoc(doc(db, 'pins', pinId, 'dm', 'private'), { text }),

    // Search: one read of each listed pin's notes (and DM text for the DM).
    // The caller passes only pins this person can already see; the security
    // rules refuse anything else, and a refused pin is skipped.
    async readPinTexts(pinIds, includeDm) {
      const out = new Map();
      await Promise.all(pinIds.map(async (id) => {
        try {
          const notes = listDocs(await getDocs(collection(db, 'pins', id, 'notes')));
          let dmText = '';
          if (includeDm) {
            const d = await getDoc(doc(db, 'pins', id, 'dm', 'private'));
            dmText = d.exists() ? d.data().text || '' : '';
          }
          out.set(id, { notes, dmText });
        } catch {
          // The pin was hidden or deleted after the list loaded.
        }
      }));
      return out;
    },

    addNote: (pinId, note) =>
      addDoc(collection(db, 'pins', pinId, 'notes'), { ...note, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }),
    // fields: what the author changed (text, name).
    updateNote: (pinId, noteId, fields) =>
      updateDoc(doc(db, 'pins', pinId, 'notes', noteId), { ...fields, updatedAt: serverTimestamp() }),
    // Any member may flip a lead's status; only `status` changes (see the rules).
    setLeadStatus: (pinId, noteId, status) => updateDoc(doc(db, 'pins', pinId, 'notes', noteId), { status }),
    deleteNote: (pinId, noteId) => deleteDoc(doc(db, 'pins', pinId, 'notes', noteId)),

    // NPCs: the public part and the DM-only part are written together.
    async saveNpc(id, data, secret, by) {
      const ref = id ? doc(db, 'npcs', id) : doc(collection(db, 'npcs'));
      const batch = writeBatch(db);
      batch.set(ref, { ...data, updatedAt: serverTimestamp(), updatedBy: by });
      batch.set(doc(db, 'npcSecrets', ref.id), secret);
      await batch.commit();
      return ref.id;
    },
    async deleteNpc(id) {
      const batch = writeBatch(db);
      (await getDocs(collection(db, 'npcs', id, 'notes'))).forEach((n) => batch.delete(n.ref));
      batch.delete(doc(db, 'npcSecrets', id));
      batch.delete(doc(db, 'npcs', id));
      await batch.commit();
    },
    addNpcNote: (npcId, note) =>
      addDoc(collection(db, 'npcs', npcId, 'notes'), { ...note, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }),
    updateNpcNote: (npcId, noteId, fields) =>
      updateDoc(doc(db, 'npcs', npcId, 'notes', noteId), { ...fields, updatedAt: serverTimestamp() }),
    deleteNpcNote: (npcId, noteId) => deleteDoc(doc(db, 'npcs', npcId, 'notes', noteId)),
    // Search: notes of each listed NPC (ones this person can see).
    async readNpcTexts(npcIds) {
      const out = new Map();
      await Promise.all(npcIds.map(async (id) => {
        try { out.set(id, { notes: listDocs(await getDocs(collection(db, 'npcs', id, 'notes'))) }); } catch { /* hidden or deleted since */ }
      }));
      return out;
    },

    saveTravelMode: (id, data) => setDoc(doc(db, 'travelModes', id), data),
    deleteTravelMode: (id) => deleteDoc(doc(db, 'travelModes', id)),
    saveAffiliation: (id, data) => setDoc(doc(db, 'affiliations', id), data),
    deleteAffiliation: (id) => deleteDoc(doc(db, 'affiliations', id)),
    // Shows a travel mode or affiliation to players (the DM's app calls this
    // when a stop or a revealed NPC first uses it).
    reveal: (col, id) => updateDoc(doc(db, col, id), { revealed: true }),

    // Several writes at once, in batches: [{ op: 'set' | 'delete', path, data }].
    // Used to convert old "person met" entries into NPCs.
    newId: (col) => doc(collection(db, col)).id,
    async applyOps(ops) {
      for (let i = 0; i < ops.length; i += RESTORE_BATCH) {
        const batch = writeBatch(db);
        for (const o of ops.slice(i, i + RESTORE_BATCH)) {
          const ref = doc(db, ...o.path);
          if (o.op === 'delete') batch.delete(ref); else batch.set(ref, o.data);
        }
        await batch.commit();
      }
    },

    addWaypoint: (data) => addDoc(collection(db, 'waypoints'), { ...data, createdAt: serverTimestamp() }),
    updateWaypoint: (id, data) => updateDoc(doc(db, 'waypoints', id), data),
    deleteWaypoint: (id) => deleteDoc(doc(db, 'waypoints', id)),

    savePinType: (id, data) => setDoc(doc(db, 'pinTypes', id), data),
    deletePinType: (id) => deleteDoc(doc(db, 'pinTypes', id)),

    saveMember: (email, data) => setDoc(doc(db, 'members', email), { ...data, addedAt: data.addedAt || serverTimestamp() }),
    deleteMember: (email) => deleteDoc(doc(db, 'members', email)),

    saveSettings: (data) => setDoc(doc(db, 'settings', 'map'), data),

    projectId: config.projectId,

    // Admin restore. `current` is a fresh exportAll() (the caller saves it
    // first as a safety copy). Writes go out in batches of 400; batches are
    // not one transaction, so a failure part-way leaves a partial restore
    // that running the restore again finishes. onProgress(done, total).
    async restoreAll(backup, current, options, onProgress = () => {}) {
      const ops = planRestore(backup, current, options);
      const revive = (data) => reviveTimestamps(data, (s, n) => new Timestamp(s, n));
      for (let i = 0; i < ops.length; i += RESTORE_BATCH) {
        const batch = writeBatch(db);
        for (const o of ops.slice(i, i + RESTORE_BATCH)) {
          const ref = doc(db, ...o.path);
          if (o.op === 'delete') batch.delete(ref); else batch.set(ref, revive(o.data));
        }
        await batch.commit();
        onProgress(Math.min(i + RESTORE_BATCH, ops.length), ops.length);
      }
      return ops.length;
    },

    // Admin backup: everything the signed-in admin can read.
    async exportAll() {
      const all = async (path) => listDocs(await getDocs(collection(db, ...path)));
      const pins = await all(['pins']);
      for (const p of pins) {
        p.notes = await all(['pins', p.id, 'notes']);
        const dm = await getDoc(doc(db, 'pins', p.id, 'dm', 'private'));
        p.dmText = dm.exists() ? dm.data().text || '' : '';
      }
      const npcs = await all(['npcs']);
      for (const n of npcs) n.notes = await all(['npcs', n.id, 'notes']);
      const settings = await getDoc(doc(db, 'settings', 'map'));
      return {
        exportedAt: new Date().toISOString(),
        projectId: config.projectId,
        settings: settings.exists() ? settings.data() : null,
        members: await all(['members']),
        pinTypes: await all(['pinTypes']),
        waypoints: await all(['waypoints']),
        pins,
        npcs,
        npcSecrets: await all(['npcSecrets']),
        affiliations: await all(['affiliations']),
        travelModes: await all(['travelModes']),
      };
    },
  };
}
