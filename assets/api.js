// api.js: the server-action layer (the demo's version of the report's api.php).
//
// The UI never touches SQL. It calls `api.call(action, payload)` and gets back the same
// JSON shape a PHP endpoint would send: { ok: true, data } or { ok: false, error, status }.
// Every rule lives here: validation, sessions, CSRF, roles, ownership, rate limits and
// which fields are private. Hiding a button in the UI is never the only protection.
//
// createApi({ db, store, session, onWrite })
//   db       a sql.js Database (foreign keys already switched on)
//   store    uploads store: put(name, blob), get(name), delete(name)
//   session  session store: load() -> { sid, userId, csrf } | null, save(obj)
//   onWrite  optional async callback, run after any action that changed the database
//            (the app uses it to save the database to IndexedDB)

export const CATEGORIES = ['Electronics', 'Bags & wallets', 'Keys', 'Clothing', 'Documents', 'Other'];
export const CSRF_ERROR = 'Your session has expired. Please refresh and try again.';

const LOGIN_ERROR = 'Email or password is incorrect.';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Actions that change data. Each one must carry the session's CSRF token.
const STATE_CHANGING = new Set([
  'register', 'login', 'logout', 'report', 'claim',
  'approve_claim', 'mark_returned', 'admin_hide', 'admin_restore',
]);

// ---------------------------------------------------------------------------
// Password and answer hashing (PBKDF2-SHA256, the browser's stand-in for password_hash)
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100000;
const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

async function pbkdf2(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Hash a password or a normalised answer: pbkdf2_sha256$100000$<salt>$<hash> */
export async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(secret, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Check a secret against a stored hash with a constant-time comparison. */
export async function verifySecret(secret, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const expected = fromBase64(parts[3]);
  const actual = await pbkdf2(secret, fromBase64(parts[2]), iterations);
  return bytesEqual(actual, expected);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function stringsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return bytesEqual(encoder.encode(a), encoder.encode(b));
}

/** Answers are compared after trimming, collapsing inner spaces and lower-casing. */
export function normalizeAnswer(answer) {
  return String(answer ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// A fixed hash used when an email doesn't exist, so a failed login takes the same time
// whether or not the account is real.
let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ??= hashSecret('no-such-account-placeholder');
  return dummyHashPromise;
}

// ---------------------------------------------------------------------------
// Errors and small validation helpers
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message, field = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireLength(value, min, max, field, message) {
  if (value.length < min || value.length > max) throw new ApiError(422, message, field);
}

function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Today's date in the visitor's time zone as YYYY-MM-DD. */
export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function checkEventDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(422, 'Enter a valid date.', 'event_date');
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!real || y < 2000) throw new ApiError(422, 'Enter a valid date.', 'event_date');
  if (value > todayIso()) throw new ApiError(422, "The date can't be in the future.", 'event_date');
}

function startsWith(bytes, signature, offset = 0) {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** Checks a photo the way the PHP upload handler did: size, MIME type, magic bytes, decode. */
async function checkPhoto(file) {
  if (!(file instanceof Blob)) throw new ApiError(422, 'The photo could not be read.', 'photo');
  if (file.size === 0) throw new ApiError(422, 'That photo file is empty.', 'photo');
  if (file.size > MAX_PHOTO_BYTES) throw new ApiError(422, 'Photos must be 5 MB or smaller.', 'photo');
  const extension = PHOTO_TYPES[file.type];
  if (!extension) throw new ApiError(422, 'Photos must be JPG, PNG or WebP files.', 'photo');

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const magicOk =
    (file.type === 'image/jpeg' && startsWith(head, [0xff, 0xd8, 0xff])) ||
    (file.type === 'image/png' && startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (file.type === 'image/webp' && startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8));
  if (!magicOk) throw new ApiError(422, "That file isn't a valid JPG, PNG or WebP image.", 'photo');

  try {
    const bitmap = await createImageBitmap(file);
    bitmap.close();
  } catch {
    throw new ApiError(422, "That file isn't a valid JPG, PNG or WebP image.", 'photo');
  }
  return extension;
}

// ---------------------------------------------------------------------------
// The API factory
// ---------------------------------------------------------------------------
export function createApi({ db, store, session, onWrite = null }) {
  // --- prepared-statement helpers (values are always bound, never concatenated) ---
  let changed = false;

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    return all(sql, params)[0] ?? null;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.run(params);
    } finally {
      stmt.free();
    }
    changed = true;
    const changes = db.getRowsModified();
    return { changes, id: get('SELECT last_insert_rowid() AS id').id };
  }

  function transaction(work) {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- session helpers (the stand-in for $_SESSION) ---
  function currentSession() {
    let s = session.load();
    if (!s || typeof s.sid !== 'string' || typeof s.csrf !== 'string') {
      s = { sid: randomToken(), userId: null, csrf: randomToken() };
      session.save(s);
    }
    return s;
  }

  function currentUser() {
    const s = currentSession();
    if (!s.userId) return null;
    const user = get('SELECT id, name, email, role FROM users WHERE id = ?', [s.userId]);
    if (!user) session.save({ ...s, userId: null }); // account no longer exists
    return user;
  }

  function startSession(userId) {
    const s = currentSession();
    const next = { sid: randomToken(), userId, csrf: s.csrf }; // new sid = session regeneration
    session.save(next);
    return next;
  }

  function requireUser() {
    const user = currentUser();
    if (!user) throw new ApiError(401, 'Please sign in to continue.');
    return user;
  }

  function requireAdmin() {
    const user = requireUser();
    if (user.role !== 'admin') throw new ApiError(403, 'Only administrators can do that.');
    return user;
  }

  // --- rate limits (rate_limits table) ---
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function activeBucket(bucket) {
    const row = get('SELECT attempts, reset_at FROM rate_limits WHERE bucket = ?', [bucket]);
    return row && row.reset_at > nowSeconds() ? row : null;
  }

  function assertNotLimited(bucket, limit, message) {
    const row = activeBucket(bucket);
    if (row && row.attempts >= limit) {
      const minutes = Math.max(1, Math.ceil((row.reset_at - nowSeconds()) / 60));
      throw new ApiError(429, `${message} Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
  }

  function addAttempt(bucket, windowSeconds) {
    if (activeBucket(bucket)) {
      run('UPDATE rate_limits SET attempts = attempts + 1 WHERE bucket = ?', [bucket]);
    } else {
      run(
        `INSERT INTO rate_limits (bucket, attempts, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET attempts = 1, reset_at = excluded.reset_at`,
        [bucket, nowSeconds() + windowSeconds],
      );
    }
  }

  function limit(bucket, max, windowSeconds, message) {
    assertNotLimited(bucket, max, message);
    addAttempt(bucket, windowSeconds);
  }

  // --- shared queries ---
  const ITEM_COLUMNS = `i.id, i.title, i.description, i.type, i.category, i.location, i.event_date,
    i.status, i.image, i.is_demo, i.created_at, u.name AS posted_by`;

  function boardCounts() {
    return get(`SELECT
        COALESCE(SUM(status = 'open' AND type = 'lost'), 0)  AS lost,
        COALESCE(SUM(status = 'open' AND type = 'found'), 0) AS found,
        COALESCE(SUM(status = 'returned'), 0)                AS returned
      FROM items`);
  }

  /** Loads an item and applies the visibility rule for hidden items. */
  function visibleItem(id, user) {
    const item = get(`SELECT ${ITEM_COLUMNS}, i.user_id, i.previous_status, i.verification_question
      FROM items i JOIN users u ON u.id = i.user_id WHERE i.id = ?`, [id]);
    if (!item) throw new ApiError(404, "This report isn't available.");
    const isOwner = Boolean(user && user.id === item.user_id);
    const isAdmin = user?.role === 'admin';
    if (item.status === 'hidden' && !isOwner && !isAdmin) throw new ApiError(404, "This report isn't available.");
    return { item, isOwner, isAdmin };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const actions = {
    bootstrap() {
      const s = currentSession();
      const user = currentUser();
      return { csrf: s.csrf, user, categories: CATEGORIES, counts: boardCounts() };
    },

    async register(p) {
      const name = text(p.name);
      const email = text(p.email).toLowerCase();
      const password = typeof p.password === 'string' ? p.password : '';
      requireLength(name, 2, 60, 'name', 'Name must be 2 to 60 characters.');
      if (email.length > 120 || !EMAIL_PATTERN.test(email)) throw new ApiError(422, 'Enter a valid email address.', 'email');
      if (password.length < 8) throw new ApiError(422, 'Password must be at least 8 characters.', 'password');
      if (password.length > 128) throw new ApiError(422, 'Password must be 128 characters or fewer.', 'password');

      // The whole demo database lives in one browser, so this bucket works like a per-IP limit.
      limit('register:browser', 10, 3600, 'Too many accounts were created from this browser.');

      const exists = get('SELECT id FROM users WHERE email = ?', [email]);
      if (exists) throw new ApiError(422, 'An account with this email already exists.', 'email');

      const passwordHash = await hashSecret(password);
      let userId;
      try {
        userId = run('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
          [name, email, passwordHash, 'user', new Date().toISOString()]).id;
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new ApiError(422, 'An account with this email already exists.', 'email');
        throw err;
      }
      const s = startSession(userId);
      return { user: { id: userId, name, email, role: 'user' }, csrf: s.csrf };
    },

    async login(p) {
      const email = text(p.email).toLowerCase();
      const password = typeof p.password === 'string' ? p.password : '';
      if (!email || !password) throw new ApiError(422, 'Enter your email and password.');
      if (email.length > 120 || password.length > 128) throw new ApiError(401, LOGIN_ERROR);

      const bucket = `login:${email}`;
      assertNotLimited(bucket, 8, 'Too many failed sign-in attempts for this email.');

      const user = get('SELECT id, name, email, role, password_hash FROM users WHERE email = ?', [email]);
      const valid = await verifySecret(password, user ? user.password_hash : await dummyHash());
      if (!user || !valid) {
        addAttempt(bucket, 15 * 60);
        throw new ApiError(401, LOGIN_ERROR); // same message for a wrong email or a wrong password
      }
      run('DELETE FROM rate_limits WHERE bucket = ?', [bucket]);
      const s = startSession(user.id);
      return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrf: s.csrf };
    },

    logout() {
      const s = currentSession();
      const next = { sid: s.sid, userId: null, csrf: randomToken() };
      session.save(next);
      return { csrf: next.csrf };
    },

    items(p) {
      const tab = ['all', 'lost', 'found', 'returned'].includes(p.type) ? p.type : 'all';
      const where = [];
      const params = [];
      if (tab === 'returned') {
        where.push("i.status = 'returned'");
      } else {
        where.push("i.status = 'open'");
        if (tab !== 'all') { where.push('i.type = ?'); params.push(tab); }
      }
      const category = text(p.category);
      if (category) {
        if (!CATEGORIES.includes(category)) throw new ApiError(422, 'Choose a category from the list.', 'category');
        where.push('i.category = ?');
        params.push(category);
      }
      // Every keyword must appear in the title, description or location.
      const words = text(p.q).slice(0, 80).split(/\s+/).filter(Boolean).slice(0, 6);
      for (const word of words) {
        const like = `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.location LIKE ? ESCAPE '\\')");
        params.push(like, like, like);
      }
      const items = all(`SELECT ${ITEM_COLUMNS} FROM items i JOIN users u ON u.id = i.user_id
        WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC, i.id DESC LIMIT 200`, params);
      return { items, counts: boardCounts() };
    },

    item(p) {
      const user = currentUser();
      const { item, isOwner, isAdmin } = visibleItem(toId(p.id), user);
      const result = {
        id: item.id, title: item.title, description: item.description, type: item.type,
        category: item.category, location: item.location, event_date: item.event_date,
        status: item.status, image: item.image, is_demo: item.is_demo, created_at: item.created_at,
        posted_by: item.posted_by, verification_question: item.verification_question,
        is_owner: isOwner, can_manage: isOwner || isAdmin,
      };
      if (isOwner || isAdmin) {
        result.previous_status = item.previous_status;
        result.claims = all(`SELECT c.id, c.message, c.status, c.answer_verified, c.created_at,
            u.name AS claimant_name, u.email AS claimant_email
          FROM claims c JOIN users u ON u.id = c.user_id
          WHERE c.item_id = ? ORDER BY c.created_at DESC, c.id DESC`, [item.id]);
      }
      if (user && !isOwner) {
        result.my_claim = get('SELECT id, status, created_at FROM claims WHERE item_id = ? AND user_id = ?', [item.id, user.id]);
      }
      return { item: result };
    },

    matches(p) {
      const { item } = visibleItem(toId(p.id), currentUser());
      const matches = all(`SELECT ${ITEM_COLUMNS},
          (lower(trim(i.location)) = lower(trim(?))) AS same_location,
          CAST(abs(julianday(i.event_date) - julianday(?)) AS INTEGER) AS days_apart
        FROM items i JOIN users u ON u.id = i.user_id
        WHERE i.status = 'open' AND i.type <> ? AND i.category = ? AND i.id <> ? AND i.is_demo = ?
        ORDER BY same_location DESC, days_apart ASC, i.created_at DESC
        LIMIT 4`, [item.location, item.event_date, item.type, item.category, item.id, item.is_demo]);
      return { matches };
    },

    async report(p) {
      const user = requireUser();
      const type = text(p.type);
      if (type !== 'lost' && type !== 'found') throw new ApiError(422, 'Choose whether you lost or found the item.', 'type');
      const category = text(p.category);
      if (!CATEGORIES.includes(category)) throw new ApiError(422, 'Choose a category from the list.', 'category');
      const title = text(p.title);
      requireLength(title, 3, 80, 'title', 'Item name must be 3 to 80 characters.');
      const description = text(p.description);
      requireLength(description, 10, 1000, 'description', 'Description must be 10 to 1000 characters.');
      const location = text(p.location);
      requireLength(location, 2, 80, 'location', 'Location must be 2 to 80 characters.');
      const eventDate = text(p.event_date);
      checkEventDate(eventDate);
      const question = text(p.verification_question);
      requireLength(question, 5, 160, 'verification_question', 'Verification question must be 5 to 160 characters.');
      const answer = normalizeAnswer(p.secret_answer);
      requireLength(answer, 1, 80, 'secret_answer', 'Enter a secret answer of up to 80 characters.');

      const photo = p.photo instanceof Blob ? p.photo : null;
      const extension = photo ? await checkPhoto(photo) : null;

      limit(`report:${user.id}`, 20, 3600, "You've posted a lot of reports in a short time.");

      const answerHash = await hashSecret(answer);
      // A random name is stored, never the visitor's own filename.
      const imageName = photo ? `${crypto.randomUUID()}${extension}` : null;
      if (photo) await store.put(imageName, photo);
      try {
        const { id } = run(`INSERT INTO items (user_id, title, description, type, category, location, event_date,
            status, image, verification_question, verification_hash, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?)`,
        [user.id, title, description, type, category, location, eventDate, imageName, question, answerHash,
          new Date().toISOString()]);
        return { id };
      } catch (err) {
        if (imageName) await store.delete(imageName);
        throw err;
      }
    },

    async claim(p) {
      const user = requireUser();
      const item = get('SELECT id, user_id, status, is_demo, verification_hash FROM items WHERE id = ?', [toId(p.item_id)]);
      if (!item || item.status === 'hidden') throw new ApiError(404, "This report isn't available.");
      if (item.is_demo) throw new ApiError(422, "Demo listings can't receive claims.");
      if (item.user_id === user.id) throw new ApiError(422, "You can't claim your own report.");
      if (item.status !== 'open') throw new ApiError(422, 'This item has already been returned.');
      const message = text(p.message);
      requireLength(message, 5, 500, 'message', 'Message must be 5 to 500 characters.');
      const answer = normalizeAnswer(p.answer);
      if (!answer) throw new ApiError(422, 'Enter the answer to the verification question.', 'answer');

      // Wrong answers count too, so nobody can guess answers endlessly.
      limit(`claim:${user.id}`, 10, 15 * 60, 'Too many claim attempts.');

      const verified = await verifySecret(answer.slice(0, 80), item.verification_hash);
      if (!verified) throw new ApiError(422, "That answer doesn't match. Check the details and try again.", 'answer');
      try {
        const { id } = run(`INSERT INTO claims (item_id, user_id, message, answer_verified, status, created_at)
          VALUES (?, ?, ?, 1, 'pending', ?)`, [item.id, user.id, message, new Date().toISOString()]);
        return { id, status: 'pending' };
      } catch (err) {
        // The UNIQUE(item_id, user_id) key is what stops a second claim.
        if (String(err.message).includes('UNIQUE')) throw new ApiError(409, "You've already sent a claim for this item.");
        throw err;
      }
    },

    my_reports() {
      const user = requireUser();
      const items = all(`SELECT ${ITEM_COLUMNS} FROM items i JOIN users u ON u.id = i.user_id
        WHERE i.user_id = ? ORDER BY i.created_at DESC, i.id DESC`, [user.id]);
      const claims = all(`SELECT c.id, c.status, c.created_at, c.item_id, i.title AS item_title,
          i.status AS item_status, i.type AS item_type, i.category AS item_category
        FROM claims c JOIN items i ON i.id = c.item_id
        WHERE c.user_id = ? ORDER BY c.created_at DESC, c.id DESC`, [user.id]);
      return { items, claims };
    },

    approve_claim(p) {
      const user = requireUser();
      const claim = get(`SELECT c.id, c.status, c.item_id, i.user_id AS owner_id, i.status AS item_status
        FROM claims c JOIN items i ON i.id = c.item_id WHERE c.id = ?`, [toId(p.claim_id)]);
      if (!claim) throw new ApiError(404, 'That claim could not be found.');
      if (claim.owner_id !== user.id && user.role !== 'admin') {
        throw new ApiError(403, 'Only the person who posted this item can approve its claims.');
      }
      if (claim.status !== 'pending') throw new ApiError(422, 'This claim is no longer pending.');
      if (claim.item_status !== 'open') throw new ApiError(422, 'This item is no longer open.');

      const closed = transaction(() => {
        run("UPDATE claims SET status = 'approved' WHERE id = ?", [claim.id]);
        const others = run("UPDATE claims SET status = 'closed' WHERE item_id = ? AND status = 'pending' AND id <> ?",
          [claim.item_id, claim.id]).changes;
        run("UPDATE items SET status = 'returned' WHERE id = ?", [claim.item_id]);
        return others;
      });
      return { item_id: claim.item_id, claim_id: claim.id, status: 'returned', closed_claims: closed };
    },

    mark_returned(p) {
      const user = requireUser();
      const { item, isOwner, isAdmin } = visibleItem(toId(p.item_id), user);
      if (!isOwner && !isAdmin) throw new ApiError(403, 'Only the person who posted this item can mark it as returned.');
      if (item.status !== 'open') throw new ApiError(422, 'Only open items can be marked as returned.');
      const closed = transaction(() => {
        run("UPDATE items SET status = 'returned' WHERE id = ?", [item.id]);
        return run("UPDATE claims SET status = 'closed' WHERE item_id = ? AND status = 'pending'", [item.id]).changes;
      });
      return { item_id: item.id, status: 'returned', closed_claims: closed };
    },

    admin_overview() {
      requireAdmin();
      const counts = get(`SELECT
          (SELECT COUNT(*) FROM users)  AS accounts,
          (SELECT COUNT(*) FROM items)  AS reports,
          (SELECT COUNT(*) FROM claims) AS claims,
          (SELECT COUNT(*) FROM items WHERE status = 'hidden') AS hidden`);
      const reports = all(`SELECT ${ITEM_COLUMNS}, i.previous_status FROM items i JOIN users u ON u.id = i.user_id
        ORDER BY i.created_at DESC, i.id DESC LIMIT 200`);
      const claims = all(`SELECT c.id, c.status, c.created_at, c.item_id, i.title AS item_title, u.name AS claimant_name
        FROM claims c JOIN items i ON i.id = c.item_id JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC, c.id DESC LIMIT 20`);
      return { counts, reports, claims };
    },

    admin_hide(p) {
      requireAdmin();
      const item = get('SELECT id, status FROM items WHERE id = ?', [toId(p.item_id)]);
      if (!item) throw new ApiError(404, "This report isn't available.");
      if (item.status === 'hidden') throw new ApiError(422, 'This report is already hidden.');
      run("UPDATE items SET previous_status = status, status = 'hidden' WHERE id = ?", [item.id]);
      return { item_id: item.id, status: 'hidden', previous_status: item.status };
    },

    admin_restore(p) {
      requireAdmin();
      const item = get('SELECT id, status, previous_status FROM items WHERE id = ?', [toId(p.item_id)]);
      if (!item) throw new ApiError(404, "This report isn't available.");
      if (item.status !== 'hidden') throw new ApiError(422, 'Only hidden reports can be restored.');
      const restored = item.previous_status === 'returned' ? 'returned' : 'open';
      run('UPDATE items SET status = ?, previous_status = NULL WHERE id = ?', [restored, item.id]);
      return { item_id: item.id, status: restored };
    },
  };

  // --- request dispatcher (like the switch at the top of api.php) ---
  async function handle(action, payload) {
    changed = false;
    let response;
    try {
      if (!Object.hasOwn(actions, action)) throw new ApiError(404, 'Unknown action.');
      if (STATE_CHANGING.has(action) && !stringsEqual(payload.csrf, currentSession().csrf)) {
        throw new ApiError(403, CSRF_ERROR);
      }
      response = { ok: true, data: await actions[action](payload) };
    } catch (err) {
      if (err instanceof ApiError) {
        response = { ok: false, error: err.message, status: err.status };
        if (err.field) response.field = err.field;
      } else {
        console.warn('Unexpected API failure:', err);
        response = { ok: false, error: 'Something went wrong. Please try again.', status: 500 };
      }
    }
    if (changed && onWrite) {
      try {
        await onWrite();
      } catch (err) {
        console.warn('Could not save the demo database:', err);
      }
    }
    return response;
  }

  // Calls run one at a time, like requests handled in order by one PHP worker.
  let queue = Promise.resolve();
  function call(action, payload = {}) {
    const result = queue.then(() => handle(String(action), payload ?? {}));
    queue = result.catch(() => {});
    return result;
  }

  return { call };
}
