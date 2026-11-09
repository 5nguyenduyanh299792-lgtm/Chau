import {
  db,
  auth,
  doc,
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  handleFirestoreError,
  OperationType,
  signInWithPopup,
  signOut,
  googleProvider,
  onAuthStateChanged
} from './firebase.js';

let unsubscribeRecords = null;
let syncStatusCallback = null;

export const SyncState = {
  currentUser: null,
  isSyncing: false,
  lastSyncedAt: null,
  status: 'offline', // 'offline' | 'syncing' | 'synced' | 'error'
  errorMessage: null
};

export function setSyncStatusListener(cb) {
  syncStatusCallback = cb;
  if (cb) cb(SyncState);
}

function updateState(partial) {
  Object.assign(SyncState, partial);
  if (syncStatusCallback) {
    syncStatusCallback(SyncState);
  }
}

/**
 * Sanitize and validate record for Firestore according to blueprint
 */
function sanitizeRecordForCloud(rec, userId) {
  const data = {
    month: String(rec.month),
    rent: Math.max(0, Math.round(Number(rec.rent) || 0)),
    electric: Math.max(0, Math.round(Number(rec.electric) || 0)),
    water: Math.max(0, Math.round(Number(rec.water) || 0)),
    others: Array.isArray(rec.others)
      ? rec.others
          .map(o => ({
            name: String(o.name || '').trim().slice(0, 60),
            amount: Math.max(0, Math.round(Number(o.amount) || 0)),
          }))
          .filter(o => o.name)
          .slice(0, 30)
      : [],
    people: Math.min(20, Math.max(1, Math.round(Number(rec.people)) || 1)),
    paid: Boolean(rec.paid),
    paidDate: rec.paid ? String(rec.paidDate || '').slice(0, 10) : '',
    note: String(rec.note || '').slice(0, 500),
    userId: String(userId),
    updatedAt: rec.updatedAt || new Date().toISOString(),
    createdAt: rec.createdAt || new Date().toISOString()
  };

  if (rec.elecMeter && typeof rec.elecMeter === 'object') {
    data.elecMeter = {
      on: Boolean(rec.elecMeter.on),
      old: rec.elecMeter.old != null ? Number(rec.elecMeter.old) : null,
      new: rec.elecMeter.new != null ? Number(rec.elecMeter.new) : null,
      price: rec.elecMeter.price != null ? Math.round(Number(rec.elecMeter.price)) : null
    };
  }

  if (rec.waterMeter && typeof rec.waterMeter === 'object') {
    data.waterMeter = {
      on: Boolean(rec.waterMeter.on),
      old: rec.waterMeter.old != null ? Number(rec.waterMeter.old) : null,
      new: rec.waterMeter.new != null ? Number(rec.waterMeter.new) : null,
      price: rec.waterMeter.price != null ? Math.round(Number(rec.waterMeter.price)) : null
    };
  }

  return data;
}

/**
 * Save a single record to Firestore
 */
export async function syncRecordToCloud(rec) {
  const user = auth.currentUser;
  if (!user || !rec || !rec.month) return false;

  const path = `users/${user.uid}/records/${rec.month}`;
  updateState({ isSyncing: true, status: 'syncing' });

  try {
    const payload = sanitizeRecordForCloud(rec, user.uid);
    await setDoc(doc(db, 'users', user.uid, 'records', rec.month), payload);
    updateState({ isSyncing: false, status: 'synced', lastSyncedAt: new Date(), errorMessage: null });
    return true;
  } catch (error) {
    updateState({ isSyncing: false, status: 'error', errorMessage: error.message });
    handleFirestoreError(error, OperationType.WRITE, path);
    return false;
  }
}

/**
 * Delete a single record from Firestore
 */
export async function deleteRecordFromCloud(monthKey) {
  const user = auth.currentUser;
  if (!user || !monthKey) return false;

  const path = `users/${user.uid}/records/${monthKey}`;
  updateState({ isSyncing: true, status: 'syncing' });

  try {
    await deleteDoc(doc(db, 'users', user.uid, 'records', monthKey));
    updateState({ isSyncing: false, status: 'synced', lastSyncedAt: new Date(), errorMessage: null });
    return true;
  } catch (error) {
    updateState({ isSyncing: false, status: 'error', errorMessage: error.message });
    handleFirestoreError(error, OperationType.DELETE, path);
    return false;
  }
}

/**
 * Save app settings to Firestore
 */
export async function syncSettingsToCloud(settings) {
  const user = auth.currentUser;
  if (!user || !settings) return false;

  const path = `users/${user.uid}/settings/app`;
  try {
    const data = {
      dueDay: Math.min(31, Math.max(1, Math.round(Number(settings.dueDay)) || 5)),
      people: Math.min(20, Math.max(1, Math.round(Number(settings.people)) || 1)),
      theme: ['auto', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'auto',
      userId: user.uid,
      updatedAt: new Date().toISOString()
    };
    await setDoc(doc(db, 'users', user.uid, 'settings', 'app'), data);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return false;
  }
}

/**
 * Initialize real-time synchronization with local state store S
 */
export function initSyncEngine({ getLocalState, onCloudUpdated }) {
  onAuthStateChanged(auth, async (user) => {
    if (unsubscribeRecords) {
      unsubscribeRecords();
      unsubscribeRecords = null;
    }

    if (!user) {
      updateState({
        currentUser: null,
        isSyncing: false,
        status: 'offline',
        errorMessage: null
      });
      return;
    }

    updateState({
      currentUser: user,
      isSyncing: true,
      status: 'syncing'
    });

    const localState = getLocalState();
    const recordsPath = `users/${user.uid}/records`;

    try {
      // 1. Initial fetch from Firestore
      const snap = await getDocs(collection(db, 'users', user.uid, 'records'));
      const cloudRecords = {};
      snap.forEach(docSnap => {
        cloudRecords[docSnap.id] = docSnap.data();
      });

      // 2. Upload any local records that don't exist in cloud yet
      const localKeys = Object.keys(localState.records || {});
      for (const k of localKeys) {
        if (!cloudRecords[k]) {
          const payload = sanitizeRecordForCloud(localState.records[k], user.uid);
          await setDoc(doc(db, 'users', user.uid, 'records', k), payload);
          cloudRecords[k] = payload;
        }
      }

      // 3. Inform app of merged records
      onCloudUpdated(cloudRecords);
      updateState({
        isSyncing: false,
        status: 'synced',
        lastSyncedAt: new Date(),
        errorMessage: null
      });

      // 4. Attach real-time snapshot listener
      unsubscribeRecords = onSnapshot(
        collection(db, 'users', user.uid, 'records'),
        (snapshot) => {
          const updatedCloud = {};
          snapshot.forEach(docSnap => {
            updatedCloud[docSnap.id] = docSnap.data();
          });
          onCloudUpdated(updatedCloud);
          updateState({
            isSyncing: false,
            status: 'synced',
            lastSyncedAt: new Date()
          });
        },
        (error) => {
          updateState({ isSyncing: false, status: 'error', errorMessage: error.message });
          handleFirestoreError(error, OperationType.LIST, recordsPath);
        }
      );
    } catch (error) {
      updateState({ isSyncing: false, status: 'error', errorMessage: error.message });
      handleFirestoreError(error, OperationType.GET, recordsPath);
    }
  });
}

/**
 * Sign in using Google Popup
 */
export async function loginWithGoogle() {
  try {
    updateState({ isSyncing: true, status: 'syncing' });
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    updateState({ isSyncing: false, status: 'error', errorMessage: error.message });
    throw error;
  }
}

/**
 * Sign out
 */
export async function logoutUser() {
  if (unsubscribeRecords) {
    unsubscribeRecords();
    unsubscribeRecords = null;
  }
  await signOut(auth);
  updateState({
    currentUser: null,
    isSyncing: false,
    status: 'offline',
    errorMessage: null
  });
}
