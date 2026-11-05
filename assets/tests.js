// tests.js: the live self-test (the report's 31 backend checks, section 3.2.9).
// Every check calls createApi(...).call(action, payload) exactly like the UI does, but
// against a fresh in-memory database, session and uploads store. It never opens the
// visitor's saved IndexedDB data.

import { createApi } from './api.js';
import {
  loadSqlJs, fetchSchema, createFreshDatabase, createMemorySession, createMemoryUploadStore, openConnection, exportDatabase,
} from './db.js';
import { DEMO_PASSWORD, SEED_ITEMS } from './seed.js';
import { $, h } from './ui.js';

const GROUPS = [
  'Initialization and privacy',
  'Authentication and sessions',
  'CSRF and authorization',
  'Reporting and discovery',
  'Claims and privacy',
  'Return workflow',
  'Admin workflow',
  'Upload rejection',
];

class CheckFailed extends Error {}

function expect(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

function expectError(res, status, message = null) {
  expect(!res.ok, `expected an error ${status}, got ok`);
  expect(res.status === status, `expected status ${status}, got ${res.status} (${res.error})`);
  if (message) expect(res.error === message, `expected "${message}", got "${res.error}"`);
}

function expectOk(res, what) {
  expect(res.ok, `${what} failed: ${res.error} (${res.status})`);
  return res.data;
}

/** A tiny valid PNG made with a canvas. */
function tinyPng() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1d5c66';
  ctx.fillRect(0, 0, 4, 4);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const PRIVATE_MARKERS = ['password_hash', 'verification_hash', 'pbkdf2_sha256', '@'];

function leaksPrivateData(value) {
  const json = JSON.stringify(value);
  return PRIVATE_MARKERS.find((marker) => json.includes(marker)) ?? null;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
async function buildSuite() {
  const SQL = await loadSqlJs();
  const schemaSql = await fetchSchema();
  const db = await createFreshDatabase(SQL, schemaSql);
  const store = createMemoryUploadStore();

  /** A "browser": its own session (cookie jar) talking to the shared database. */
  function client() {
    const session = createMemorySession();
    const api = createApi({ db, store, session });
    let csrf = null;
    return {
      session,
      raw: api,
      async boot() {
        const res = await api.call('bootstrap', {});
        if (res.ok) csrf = res.data.csrf;
        return res;
      },
      async send(action, payload = {}) {
        const res = await api.call(action, { ...payload, csrf });
        if (res.ok && typeof res.data?.csrf === 'string') csrf = res.data.csrf;
        return res;
      },
    };
  }

  const guest = client();
  const userA = client();
  const userB = client();
  const other = client();
  const finder = client();
  const admin = client();
  await Promise.all([guest, userA, userB, other, finder, admin].map((c) => c.boot()));

  const EMAIL_A = 'member.a@fleetmitra.test';
  const EMAIL_B = 'member.b@fleetmitra.test';
  const PASSWORD_A = 'harbour-light-42';
  const PASSWORD_B = 'compass-rose-77';
  const ctx = {}; // ids shared between checks

  const validReport = (overrides = {}) => ({
    type: 'lost', category: 'Electronics', title: 'Black wireless earbuds case',
    description: 'Matte black earbuds case with a small scratch on the lid.',
    location: 'Seminar hall', event_date: '2026-11-03',
    verification_question: 'What colour is the inner lining?', secret_answer: 'Blue',
    ...overrides,
  });

  const findClaim = (itemId, userEmail) => {
    const stmt = db.prepare(`SELECT c.id, c.status FROM claims c JOIN users u ON u.id = c.user_id
      WHERE c.item_id = ? AND u.email = ?`);
    stmt.bind([itemId, userEmail]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  };

  return [
    // ---------------- Initialization and privacy (2) ----------------
    [GROUPS[0], 'Bootstrap returns a CSRF token, the categories and the seeded demo listings', async () => {
      const boot = expectOk(await guest.boot(), 'bootstrap');
      expect(typeof boot.csrf === 'string' && boot.csrf.length >= 32, 'missing CSRF token');
      expect(boot.user === null, 'a fresh session should be signed out');
      expect(boot.categories.length === 6, 'expected 6 categories');
      expect(boot.counts.lost === 4 && boot.counts.found === 3 && boot.counts.returned === 1,
        `unexpected counts ${JSON.stringify(boot.counts)}`);
      const open = expectOk(await guest.send('items', { type: 'all' }), 'items').items;
      const returned = expectOk(await guest.send('items', { type: 'returned' }), 'items').items;
      const demoTitles = [...open, ...returned].filter((i) => i.is_demo === 1).map((i) => i.title);
      const expected = SEED_ITEMS.filter((i) => i.is_demo).map((i) => i.title);
      expect(expected.every((t) => demoTitles.includes(t)), 'not every demo listing is present');
      expect(demoTitles.length === 6, `expected 6 demo listings, got ${demoTitles.length}`);
    }],
    [GROUPS[0], 'Public list and detail expose no password hashes, answer hashes or emails', async () => {
      const lists = await Promise.all(['all', 'lost', 'found', 'returned'].map((type) => guest.send('items', { type })));
      for (const res of lists) {
        const leak = leaksPrivateData(expectOk(res, 'items'));
        expect(!leak, `public list contains "${leak}"`);
      }
      const bottle = lists[0].data.items.find((i) => i.title === 'Silver steel water bottle');
      ctx.bottleId = bottle.id;
      ctx.demoId = lists[0].data.items.find((i) => i.is_demo === 1).id;
      const detail = expectOk(await guest.send('item', { id: bottle.id }), 'item');
      expect(!leaksPrivateData(detail), 'public detail leaks private data');
      expect(detail.item.verification_question === 'What sticker is on the bottle?', 'question missing');
      expect(!('claims' in detail.item), 'a guest must not receive claims');
    }],

    // ---------------- Authentication and sessions (5) ----------------
    [GROUPS[1], 'Register user A (starts a new session)', async () => {
      const before = userA.session.load().sid;
      const data = expectOk(await userA.send('register', { name: 'Member A', email: EMAIL_A, password: PASSWORD_A }), 'register');
      expect(data.user.email === EMAIL_A && data.user.role === 'user', 'wrong user returned');
      const after = userA.session.load();
      expect(after.sid !== before, 'session id was not regenerated');
      expect(after.userId === data.user.id, 'session is not linked to the new user');
      const row = db.exec('SELECT password_hash FROM users WHERE email = ?', [EMAIL_A])[0].values[0][0];
      expect(row.startsWith('pbkdf2_sha256$100000$') && !row.includes(PASSWORD_A), 'password is not stored as a PBKDF2 hash');
    }],
    [GROUPS[1], 'Register user B', async () => {
      const data = expectOk(await userB.send('register', { name: 'Member B', email: EMAIL_B, password: PASSWORD_B }), 'register');
      expect(data.user.name === 'Member B', 'wrong name');
      ctx.userBId = data.user.id;
    }],
    [GROUPS[1], 'A duplicate email is rejected', async () => {
      const res = await other.send('register', { name: 'Someone Else', email: 'MEMBER.A@fleetmitra.test', password: 'another-pass-1' });
      expectError(res, 422, 'An account with this email already exists.');
      const short = await other.send('register', { name: 'Someone Else', email: 'short@fleetmitra.test', password: 'seven77' });
      expectError(short, 422);
    }],
    [GROUPS[1], 'Login works; a wrong password or unknown email gets the same generic message', async () => {
      expectError(await other.send('login', { email: EMAIL_A, password: 'wrong-password' }), 401, 'Email or password is incorrect.');
      expectError(await other.send('login', { email: 'nobody@fleetmitra.test', password: 'wrong-password' }), 401, 'Email or password is incorrect.');
      const before = other.session.load().sid;
      const data = expectOk(await other.send('login', { email: EMAIL_A, password: PASSWORD_A }), 'login');
      expect(data.user.email === EMAIL_A, 'logged in as the wrong user');
      expect(other.session.load().sid !== before, 'session id was not regenerated on login');
      // Rate limit: 8 failed attempts per email per 15 minutes.
      for (let i = 0; i < 8; i += 1) await other.raw.call('login', { email: 'locked@fleetmitra.test', password: 'nope-nope', csrf: other.session.load().csrf });
      expectError(await other.send('login', { email: 'locked@fleetmitra.test', password: 'nope-nope' }), 429);
    }],
    [GROUPS[1], 'After logout a protected action returns 401', async () => {
      const csrfBefore = other.session.load().csrf;
      expectOk(await other.send('logout'), 'logout');
      const s = other.session.load();
      expect(s.userId === null, 'logout did not clear the user');
      expect(s.csrf !== csrfBefore, 'logout did not issue a new CSRF token');
      expectError(await other.send('my_reports'), 401);
      expectError(await other.send('report', validReport()), 401);
    }],

    // ---------------- CSRF and authorization (4) ----------------
    [GROUPS[2], 'A state-changing request without the CSRF token is refused (403)', async () => {
      expectError(await userA.raw.call('report', validReport()), 403);
      expectError(await userA.raw.call('report', { ...validReport(), csrf: 'forged-token' }), 403);
    }],
    [GROUPS[2], "A non-owner can't mark someone else's item as returned (403)", async () => {
      expectError(await userB.send('mark_returned', { item_id: ctx.bottleId }), 403);
      const item = expectOk(await guest.send('item', { id: ctx.bottleId }), 'item').item;
      expect(item.status === 'open', 'item status changed');
    }],
    [GROUPS[2], 'A non-admin gets 403 from admin_overview', async () => {
      expectError(await userB.send('admin_overview'), 403);
      expectError(await guest.send('admin_overview'), 401);
    }],
    [GROUPS[2], 'A non-admin gets 403 from admin_hide', async () => {
      expectError(await userB.send('admin_hide', { item_id: ctx.bottleId }), 403);
    }],

    // ---------------- Reporting and discovery (4) ----------------
    [GROUPS[3], 'A report with a valid image upload is stored under a random file name', async () => {
      const png = await tinyPng();
      const photo = new File([png], 'my-photo.png', { type: 'image/png' });
      const data = expectOk(await userA.send('report', { ...validReport(), photo }), 'report');
      ctx.itemA = data.id;
      const item = expectOk(await userA.send('item', { id: data.id }), 'item').item;
      expect(/^[0-9a-f-]{36}\.png$/.test(item.image), `unexpected stored name ${item.image}`);
      expect(!item.image.includes('my-photo'), 'the original file name was used');
      expect(await store.get(item.image), 'the upload was not stored');
    }],
    [GROUPS[3], 'A second, opposite-type listing is accepted', async () => {
      const data = expectOk(await userB.send('report', validReport({
        type: 'found', title: 'Earbuds case found near the stage',
        description: 'Found a black earbuds case on a seat after the seminar.',
        verification_question: 'What brand logo is on the case?', secret_answer: 'Orbit',
      })), 'report');
      ctx.itemB = data.id;
      expectError(await userB.send('report', validReport({ event_date: '2999-01-01' })), 422, "The date can't be in the future.");
    }],
    [GROUPS[3], 'Keyword search finds the new report', async () => {
      const items = expectOk(await guest.send('items', { q: 'earbuds lid' }), 'items').items;
      expect(items.some((i) => i.id === ctx.itemA), 'keyword search missed the report');
      const filtered = expectOk(await guest.send('items', { q: 'earbuds', category: 'Keys' }), 'items').items;
      expect(filtered.length === 0, 'category filter was ignored');
    }],
    [GROUPS[3], 'Possible matches returns the opposite-type candidate first', async () => {
      const matches = expectOk(await guest.send('matches', { id: ctx.itemA }), 'matches').matches;
      expect(matches.length >= 1 && matches[0].id === ctx.itemB, 'candidate missing from matches');
      expect(matches.every((m) => m.type === 'found' && m.category === 'Electronics' && m.is_demo === 0), 'wrong candidates');
      expect(matches[0].same_location === 1 && matches[0].days_apart === 0, 'ranking details wrong');
    }],

    // ---------------- Claims and privacy (6) ----------------
    [GROUPS[4], 'A wrong answer is rejected and nothing is stored', async () => {
      const res = await userB.send('claim', { item_id: ctx.itemA, answer: 'green', message: 'I picked this up near the stage.' });
      expectError(res, 422, "That answer doesn't match. Check the details and try again.");
      expect(!findClaim(ctx.itemA, EMAIL_B), 'a claim was stored');
    }],
    [GROUPS[4], 'A correct answer (any case and spacing) stores a pending claim', async () => {
      const data = expectOk(await userB.send('claim', {
        item_id: ctx.itemA, answer: '  BLUE ', message: 'I have your earbuds case. Meet at the seminar hall desk?',
      }), 'claim');
      expect(data.status === 'pending', 'claim is not pending');
      ctx.claimB = data.id;
      expectError(await userB.send('claim', { item_id: ctx.demoId, answer: 'x', message: 'hello there' }), 422,
        "Demo listings can't receive claims.");
      expectError(await userA.send('claim', { item_id: ctx.itemA, answer: 'blue', message: 'my own item' }), 422,
        "You can't claim your own report.");
    }],
    [GROUPS[4], 'A second claim from the same user is rejected (409)', async () => {
      const res = await userB.send('claim', { item_id: ctx.itemA, answer: 'blue', message: 'Sending this again.' });
      expectError(res, 409, "You've already sent a claim for this item.");
    }],
    [GROUPS[4], "Other users can't see the claim or the claimant's email", async () => {
      expectOk(await finder.send('login', { email: 'finder@fleetmitra.test', password: DEMO_PASSWORD }), 'login');
      for (const viewer of [guest, finder]) {
        const item = expectOk(await viewer.send('item', { id: ctx.itemA }), 'item').item;
        expect(!('claims' in item), 'claims were exposed');
        expect(!JSON.stringify(item).includes(EMAIL_B), 'claimant email was exposed');
      }
    }],
    [GROUPS[4], "The owner sees the claim with the claimant's email", async () => {
      const item = expectOk(await userA.send('item', { id: ctx.itemA }), 'item').item;
      expect(item.is_owner === true, 'owner flag missing');
      expect(item.claims.length === 1, 'expected one claim');
      const claim = item.claims[0];
      expect(claim.claimant_email === EMAIL_B && claim.claimant_name === 'Member B', 'claimant details missing');
      expect(claim.status === 'pending' && claim.answer_verified === 1, 'claim state wrong');
    }],
    [GROUPS[4], 'The claimant can track the claim in My reports', async () => {
      const data = expectOk(await userB.send('my_reports'), 'my_reports');
      const claim = data.claims.find((c) => c.item_id === ctx.itemA);
      expect(claim && claim.status === 'pending' && claim.item_title === 'Black wireless earbuds case', 'claim not listed');
      expect(data.items.some((i) => i.id === ctx.itemB), 'own item not listed');
    }],

    // ---------------- Return workflow (3) ----------------
    [GROUPS[5], 'Approving a claim marks it approved, closes other claims and returns the item', async () => {
      expectOk(await finder.send('claim', { item_id: ctx.itemA, answer: 'blue', message: 'I think I saw this at the hall.' }), 'second claim');
      const data = expectOk(await userA.send('approve_claim', { claim_id: ctx.claimB }), 'approve_claim');
      expect(data.status === 'returned' && data.closed_claims === 1, 'unexpected approve result');
      const item = expectOk(await userA.send('item', { id: ctx.itemA }), 'item').item;
      expect(item.status === 'returned', 'item not returned');
      const statuses = Object.fromEntries(item.claims.map((c) => [c.claimant_name, c.status]));
      expect(statuses['Member B'] === 'approved' && statuses['Sample Finder'] === 'closed', JSON.stringify(statuses));
    }],
    [GROUPS[5], 'The claim state is persisted (re-read from an exported copy)', async () => {
      const copy = openConnection(SQL, exportDatabase(db));
      const status = copy.exec('SELECT status FROM claims WHERE id = ?', [ctx.claimB])[0].values[0][0];
      const itemStatus = copy.exec('SELECT status FROM items WHERE id = ?', [ctx.itemA])[0].values[0][0];
      copy.close();
      expect(status === 'approved' && itemStatus === 'returned', 'state was not persisted');
      const mine = expectOk(await userB.send('my_reports'), 'my_reports');
      expect(mine.claims.find((c) => c.id === ctx.claimB).status === 'approved', 'claimant view not updated');
      // The item details tell the claimant what happened, even though the item is no longer open.
      const seen = expectOk(await userB.send('item', { id: ctx.itemA }), 'item').item;
      expect(seen.status === 'returned' && seen.my_claim?.status === 'approved', 'claimant cannot see the approved claim on the item');
    }],
    [GROUPS[5], 'A direct Mark as returned closes the pending claims on that item', async () => {
      expectOk(await userA.send('claim', { item_id: ctx.itemB, answer: 'orbit', message: 'That case is mine, thank you!' }), 'claim');
      const data = expectOk(await userB.send('mark_returned', { item_id: ctx.itemB }), 'mark_returned');
      expect(data.closed_claims === 1, 'pending claim was not closed');
      expect(findClaim(ctx.itemB, EMAIL_A).status === 'closed', 'claim still pending');
      const seen = expectOk(await userA.send('item', { id: ctx.itemB }), 'item').item;
      expect(seen.my_claim?.status === 'closed', 'claimant cannot see the closed claim on the item');
      expectError(await userB.send('mark_returned', { item_id: ctx.itemB }), 422);
    }],

    // ---------------- Admin workflow (6) ----------------
    [GROUPS[6], 'Admin login', async () => {
      const data = expectOk(await admin.send('login', { email: 'admin@fleetmitra.test', password: DEMO_PASSWORD }), 'login');
      expect(data.user.role === 'admin', 'not an admin');
    }],
    [GROUPS[6], 'The dashboard shows account, report and claim counts', async () => {
      const data = expectOk(await admin.send('admin_overview'), 'admin_overview');
      expect(data.counts.accounts === 6 && data.counts.reports === 10 && data.counts.claims === 3,
        `unexpected counts ${JSON.stringify(data.counts)}`);
      expect(data.reports.length === 10 && data.claims.length === 3, 'lists are incomplete');
      expect(!leaksPrivateData(data.reports), 'report list leaks private data');
    }],
    [GROUPS[6], 'Hide stores the previous status', async () => {
      const data = expectOk(await admin.send('admin_hide', { item_id: ctx.itemA }), 'admin_hide');
      expect(data.status === 'hidden' && data.previous_status === 'returned', 'hide result wrong');
    }],
    [GROUPS[6], 'A hidden item leaves public search and is unreadable for others', async () => {
      const returned = expectOk(await guest.send('items', { type: 'returned' }), 'items').items;
      expect(!returned.some((i) => i.id === ctx.itemA), 'hidden item still listed');
      expectError(await guest.send('item', { id: ctx.itemA }), 404);
      expectError(await userB.send('item', { id: ctx.itemA }), 404);
      const own = expectOk(await userA.send('item', { id: ctx.itemA }), 'owner item').item;
      expect(own.status === 'hidden', 'owner cannot see the hidden item');
    }],
    [GROUPS[6], 'Restore puts the item back on the board', async () => {
      expectOk(await admin.send('admin_restore', { item_id: ctx.itemA }), 'admin_restore');
      const returned = expectOk(await guest.send('items', { type: 'returned' }), 'items').items;
      expect(returned.some((i) => i.id === ctx.itemA), 'restored item not listed');
    }],
    [GROUPS[6], 'Restore keeps the earlier Returned status (not Open)', async () => {
      const item = expectOk(await admin.send('item', { id: ctx.itemA }), 'item').item;
      expect(item.status === 'returned' && item.previous_status === null, `status ${item.status}/${item.previous_status}`);
      const open = expectOk(await guest.send('items', { type: 'all' }), 'items').items;
      expect(!open.some((i) => i.id === ctx.itemA), 'returned item reappeared as open');
    }],

    // ---------------- Upload rejection (1) ----------------
    [GROUPS[7], 'A file whose bytes are not a valid image is rejected', async () => {
      const before = store.names().length;
      const fake = new File([new TextEncoder().encode('<?php echo "not an image"; ?>')], 'photo.png', { type: 'image/png' });
      expectError(await userA.send('report', { ...validReport({ title: 'Fake photo test' }), photo: fake }), 422);
      const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
      const broken = new File([header], 'broken.png', { type: 'image/png' });
      expectError(await userA.send('report', { ...validReport({ title: 'Broken photo test' }), photo: broken }), 422);
      expect(store.names().length === before, 'a rejected file was stored');
      const items = expectOk(await guest.send('items', { q: 'photo test' }), 'items').items;
      expect(items.length === 0, 'a report was created for a rejected file');
    }],
  ];
}

// ---------------------------------------------------------------------------
// Runner + rendering
// ---------------------------------------------------------------------------
async function run() {
  const button = $('#run-again');
  const results = $('#results');
  const total = $('#total');
  const summary = $('#summary');
  button.disabled = true;
  summary.classList.remove('is-pass', 'is-fail');
  total.textContent = 'Running checks…';
  results.replaceChildren();

  let suite;
  try {
    suite = await buildSuite();
  } catch (err) {
    total.textContent = `Total: the test database could not start (${err.message}).`;
    summary.classList.add('is-fail');
    button.disabled = false;
    return;
  }

  const lists = new Map();
  const groupCounts = new Map();
  for (const name of GROUPS) {
    const list = h('ul', { class: 'test-list' });
    const counter = h('span', { class: 'count' }, '0');
    lists.set(name, list);
    groupCounts.set(name, { counter, passed: 0, total: 0 });
    results.append(h('section', { class: 'test-group' },
      h('div', { class: 'test-group__head' }, h('h2', { class: 'test-group__title' }, name), counter),
      list));
  }

  let passed = 0;
  const failures = [];
  for (const [group, name, check] of suite) {
    const started = performance.now();
    let error = null;
    try {
      await check();
    } catch (err) {
      error = err instanceof CheckFailed ? err.message : `${err.name}: ${err.message}`;
    }
    const ms = Math.round(performance.now() - started);
    const counts = groupCounts.get(group);
    counts.total += 1;
    if (!error) { passed += 1; counts.passed += 1; } else { failures.push(name); }
    counts.counter.textContent = `${counts.passed}/${counts.total}`;
    lists.get(group).append(h('li', { class: `test ${error ? 'is-fail' : 'is-pass'}` },
      h('span', { class: 'test__mark', 'aria-hidden': 'true' }, error ? '✗' : '✓'),
      h('span', { class: 'test__name' }, name, error ? h('span', { class: 'test__detail' }, error) : null),
      h('span', { class: 'test__time' }, `${ms} ms`)));
  }

  const count = suite.length;
  if (passed === count) {
    total.textContent = `Total: ${count} checks passed.`;
    summary.classList.add('is-pass');
  } else {
    total.textContent = `Total: ${passed} of ${count} checks passed, ${count - passed} failed.`;
    summary.classList.add('is-fail');
  }
  document.body.dataset.result = passed === count ? 'pass' : 'fail';
  button.disabled = false;
}

$('#run-again').addEventListener('click', run);
run();
