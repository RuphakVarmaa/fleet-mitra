// db.js: the data layer.
// - loads sql.js (SQLite compiled to WebAssembly) from vendor/
// - creates the tables from schema.sql and inserts the demo data on first run
// - saves the whole database to IndexedDB after every change (the stand-in for MariaDB's disk)
// - keeps uploaded photos in an IndexedDB "uploads" store (the stand-in for the uploads/ folder)
// - keeps the session in localStorage (the stand-in for the PHP session cookie)

import { hashSecret, normalizeAnswer } from './api.js';
import { DEMO_PASSWORD, SEED_ITEMS, SEED_USERS } from './seed.js';

export const APP_KEY = 'fleet-mitra';
export const SESSION_KEY = `${APP_KEY}.session`;
const IDB_NAME = `${APP_KEY}-demo`;
const ROOT = new URL('../', import.meta.url); // the app's root folder

// ---------------------------------------------------------------------------
// sql.js loader
// ---------------------------------------------------------------------------
let sqlJsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('The database engine could not be loaded.'));
    document.head.append(script);
  });
}

export function loadSqlJs() {
  if (!sqlJsPromise) {
    const ready = globalThis.initSqlJs ? Promise.resolve() : loadScript(new URL('vendor/sql-wasm.js', ROOT).href);
    sqlJsPromise = ready
      .then(() => globalThis.initSqlJs({ locateFile: (file) => new URL(`vendor/${file}`, ROOT).href }))
      .catch((err) => {
        sqlJsPromise = null; // allow a retry
        throw err;
      });
  }
  return sqlJsPromise;
}

export async function fetchSchema() {
  const response = await fetch(new URL('schema.sql', ROOT));
  if (!response.ok) throw new Error('schema.sql could not be loaded.');
  return response.text();
}

/** Opens a connection (empty or from saved bytes) with foreign keys switched on. */
export function openConnection(SQL, bytes = null) {
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** sql.js re-opens the database during export, which resets PRAGMAs, so switch FKs back on. */
export function exportDatabase(db) {
  const bytes = db.export();
  db.exec('PRAGMA foreign_keys = ON');
  return bytes;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
export async function seedDatabase(db) {
  // Hash everything first (async), then insert everything in one synchronous transaction.
  const [userHashes, answerHashes] = await Promise.all([
    Promise.all(SEED_USERS.map(() => hashSecret(DEMO_PASSWORD))),
    Promise.all(SEED_ITEMS.map((item) => hashSecret(normalizeAnswer(item.answer)))),
  ]);

  db.exec('BEGIN');
  try {
    const userIds = {};
    const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)');
    SEED_USERS.forEach((user, i) => {
      insertUser.run([user.name, user.email, userHashes[i], user.role, user.created_at]);
      userIds[user.key] = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    });
    insertUser.free();

    const insertItem = db.prepare(`INSERT INTO items (user_id, title, description, type, category, location,
        event_date, status, image, verification_question, verification_hash, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`);
    SEED_ITEMS.forEach((item, i) => {
      insertItem.run([userIds[item.owner], item.title, item.description, item.type, item.category, item.location,
        item.event_date, item.status, item.question, answerHashes[i], item.is_demo, item.created_at]);
    });
    insertItem.free();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** A brand-new database: schema.sql + demo data. Used by the app and by the self-test. */
export async function createFreshDatabase(SQL, schemaSql) {
  const db = openConnection(SQL);
  db.exec(schemaSql);
  await seedDatabase(db);
  return db;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------
function openIndexedDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains('kv')) idb.createObjectStore('kv');
      if (!idb.objectStoreNames.contains('uploads')) idb.createObjectStore('uploads');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
  });
}

function idbTask(idb, storeName, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Upload stores (same interface for IndexedDB and for the in-memory test store)
// ---------------------------------------------------------------------------
function createIdbUploadStore(idb) {
  return {
    async put(name, blob) {
      // Stored as bytes + type, which every browser's IndexedDB supports.
      const record = { type: blob.type, bytes: await blob.arrayBuffer() };
      await idbTask(idb, 'uploads', 'readwrite', (s) => s.put(record, name));
    },
    async get(name) {
      const record = await idbTask(idb, 'uploads', 'readonly', (s) => s.get(name));
      return record ? new Blob([record.bytes], { type: record.type }) : null;
    },
    async delete(name) {
      await idbTask(idb, 'uploads', 'readwrite', (s) => s.delete(name));
    },
  };
}

export function createMemoryUploadStore() {
  const files = new Map();
  return {
    async put(name, blob) { files.set(name, blob); },
    async get(name) { return files.get(name) ?? null; },
    async delete(name) { files.delete(name); },
    names: () => [...files.keys()],
  };
}

// ---------------------------------------------------------------------------
// Session stores
// ---------------------------------------------------------------------------
function createLocalSession(key) {
  let fallback = null; // used if localStorage is blocked
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return fallback;
      }
    },
    save(value) {
      fallback = { ...value };
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* fallback keeps it for this tab */ }
    },
    clear() {
      fallback = null;
      try { localStorage.removeItem(key); } catch { /* nothing to clear */ }
    },
  };
}

export function createMemorySession() {
  let value = null;
  return {
    load: () => (value ? { ...value } : null),
    save: (next) => { value = { ...next }; },
    clear: () => { value = null; },
  };
}

// ---------------------------------------------------------------------------
// The demo database used by the app (restored from IndexedDB, or created + seeded)
// ---------------------------------------------------------------------------
export async function openDemo() {
  const [SQL, schemaSql] = await Promise.all([loadSqlJs(), fetchSchema()]);

  let idb = null;
  try { idb = await openIndexedDb(); } catch { idb = null; } // private mode etc.: run in memory

  async function readSavedBytes() {
    if (!idb) return null;
    const saved = await idbTask(idb, 'kv', 'readonly', (s) => s.get('db'));
    return saved ? new Uint8Array(saved) : null;
  }

  function restore(bytes) {
    try {
      const db = openConnection(SQL, bytes);
      db.exec(schemaSql); // IF NOT EXISTS: also a quick integrity check
      db.exec('SELECT COUNT(*) FROM users');
      return db;
    } catch {
      return null;
    }
  }

  let db = null;
  try {
    const bytes = await readSavedBytes();
    if (bytes) db = restore(bytes);
  } catch {
    db = null;
  }
  const isNew = !db;
  if (isNew) db = await createFreshDatabase(SQL, schemaSql);

  const demo = {
    db,
    persistent: Boolean(idb),
    uploads: idb ? createIdbUploadStore(idb) : createMemoryUploadStore(),
    session: createLocalSession(SESSION_KEY),

    /** Export the database and save it (called after every successful change). */
    async save() {
      if (!idb) return;
      const bytes = exportDatabase(demo.db);
      await idbTask(idb, 'kv', 'readwrite', (s) => s.put(bytes, 'db'));
    },

    /** Re-read the database another tab saved. */
    async reload() {
      const bytes = await readSavedBytes();
      const next = bytes ? restore(bytes) : null;
      if (!next) return false;
      demo.db.close();
      demo.db = next;
      return true;
    },

    /** Wipe saved data, photos and the session, then reseed. */
    async reset() {
      if (idb) {
        await idbTask(idb, 'kv', 'readwrite', (s) => s.clear());
        await idbTask(idb, 'uploads', 'readwrite', (s) => s.clear());
      }
      demo.session.clear();
      demo.db.close();
      demo.db = await createFreshDatabase(SQL, schemaSql);
      await demo.save();
    },
  };

  if (isNew) {
    try { await demo.save(); } catch { /* keep working in memory */ }
  }
  return demo;
}
