// Re-exports the parts of the Firebase SDK the app uses, bundled into
// public/vendor/firebase.js by `npm run vendor`.
export { initializeApp } from 'firebase/app';
export {
  getAuth, connectAuthEmulator, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
} from 'firebase/auth';
export {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs,
  setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy,
  serverTimestamp, writeBatch, deleteField, Timestamp,
} from 'firebase/firestore';
