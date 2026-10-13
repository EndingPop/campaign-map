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
      const settings = await getDoc(doc(db, 'settings', 'map'));
      return {
        exportedAt: new Date().toISOString(),
        projectId: config.projectId,
        settings: settings.exists() ? settings.data() : null,
        members: await all(['members']),
        pinTypes: await all(['pinTypes']),
        waypoints: await all(['waypoints']),
        pins,
      };
    },
  };
}
