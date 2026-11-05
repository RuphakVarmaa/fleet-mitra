# Fleet Mitra: campus lost & found (live demo)

Fleet Mitra is a campus lost and found board. Members post what they lost or found, the board
suggests possible matches, and a claimant must answer the poster's private verification question
before their message (and email) reaches the poster. The poster approves the handover, the item
becomes **Returned**, and an administrator can hide or restore listings.

This folder is a static, no-build version of the project described in the mini project report
(the report's body calls the app "Reunite"). Every feature in the report works here.

## Demo accounts

All demo passwords are `demo1234`. The sign-in dialog lists these accounts with a
"Use this account" button that fills the form (the normal login check still runs).

| Account | Email | Role |
|---|---|---|
| Sample Owner | `owner@fleetmitra.test` | member: lost the "Silver steel water bottle" |
| Sample Finder | `finder@fleetmitra.test` | member: found the "Steel bottle with stickers" |
| Fleet Mitra Admin | `admin@fleetmitra.test` | administrator |
| Fleet Mitra demo | `demo@fleetmitra.test` | member: owns the six Demo listings |

The six Demo listings can't receive claims (as in the report). The steel bottle pair is a real
sample pair you can claim.

### Two-minute demo script

1. Sign in as **Sample Finder** and open **Silver steel water bottle**. Note the possible match.
2. Answer the question with `rocket` (any case or spacing), write a message, and choose **Send claim**.
   A wrong answer is refused and nothing is stored.
3. Sign out, sign in as **Sample Owner**, open the bottle: the private claim shows the finder's
   message, "Verification answer matched" and their email. Choose **Confirm return & approve**.
   The item is now **Returned** (see the Returned tab and My reports).
4. Sign in as **Fleet Mitra Admin**, open **Admin**, **Hide** the bottle, then **Restore** it.
   It comes back as Returned, not Open.
5. Footer → **Run self-test** runs the report's 31 backend checks live. **Reset demo data** starts fresh.

## How the report's layers map to this demo

The report describes a PHP + MariaDB app on XAMPP. Vercel serves static files only, so the same
three-layer design runs inside the browser:

| Report | This demo | What it does |
|---|---|---|
| `index.php`, `assets/style.css`, `assets/app.js` | `index.html`, `assets/style.css`, `assets/app.js` (+ `assets/ui.js`, `assets/art.js`) | Presentation only: board, dialogs, forms, toasts. It calls `send(action, payload)` and never touches SQL. |
| `api.php` | `assets/api.js` | `createApi({ db, store, session }).call(action, payload)` returns `{ ok: true, data }` or `{ ok: false, error, status }` like the PHP JSON. Validation, sessions, CSRF tokens, roles, ownership, rate limits and private fields are all enforced here. |
| MariaDB + `schema.sql` | `schema.sql` run by **sql.js** (SQLite compiled to WebAssembly, `vendor/`) via `assets/db.js` | Real tables with primary keys, foreign keys (`PRAGMA foreign_keys = ON`), the `UNIQUE(item_id, user_id)` claim key, the `(status, type, category)` index and the `rate_limits` table. Prepared statements with bound values only; `BEGIN`/`COMMIT`/`ROLLBACK` for approve and mark-returned. |
| Database on disk | IndexedDB `fleet-mitra-demo` / store `kv` / key `db` | The database is exported and saved after every change and restored on the next visit. |
| `uploads/` folder | IndexedDB store `uploads` | Photos are stored under a random name (`crypto.randomUUID()` + extension), never the visitor's file name. |
| PHP session cookie | `localStorage["fleet-mitra.session"] = { sid, userId, csrf }` | New `sid` on login/registration, new CSRF token on logout. |
| `password_hash` / `password_verify` | PBKDF2-SHA256 (WebCrypto), 100,000 iterations, 16-byte salt, constant-time compare | Used for passwords and for the normalised secret answers. Hashes never leave `api.js`. |
| `backend-test-results.txt` (31 checks) | `tests.html` + `assets/tests.js` | The same 31 checks in the same 8 groups, run live against a fresh in-memory database. |
| Demo seed | `assets/seed.js` | 4 accounts, 6 Demo listings and the real bottle pair (dates in Oct/Nov 2026). |

### API actions

`bootstrap`, `register`, `login`, `logout`, `items`, `item`, `matches`, `report`, `claim`,
`my_reports`, `approve_claim`, `mark_returned`, `admin_overview`, `admin_hide`, `admin_restore`.
Status codes: unknown action 404, not signed in 401, wrong role or owner 403, validation 422,
duplicate claim 409, rate limited 429. Every state-changing action needs the CSRF token (403 without).

### Rules worth showing an examiner

- Login gives the same message for a wrong email and a wrong password; 8 failed attempts per email
  in 15 minutes returns 429.
- Answers are compared after trimming, collapsing spaces and lower-casing ("  ROCKET " works).
- Possible matches: open items of the opposite type in the same category, Demo kept separate from
  real reports, ordered by exact location match, then closest date, then newest; at most 4.
- Approving a claim, closing the other pending claims and returning the item happen in one
  transaction. Hide keeps `previous_status`, so Restore brings a returned item back as Returned.
- Photos: JPG, PNG or WebP up to 5 MB, checked by MIME type, magic bytes and an actual decode.
- Dates can't be in the future (checked in `api.js` against today's date).
- Public responses never include password hashes, answer hashes or claimant emails.

## Run locally

```bash
python3 -m http.server 5130 --bind 127.0.0.1 -d .
# open http://127.0.0.1:5130/  (self-test: http://127.0.0.1:5130/tests.html)
```

It must be served over http(s) (not opened as a file) because the page loads `schema.sql` and the
WebAssembly engine, and WebCrypto needs a secure context (localhost counts).

Browser tests (Playwright, not deployed): `node e2e/selftest.mjs`, `node e2e/smoke.mjs`,
`node e2e/demo.mjs` with the server running on port 5130. `node e2e/flows.mjs [baseUrl] [1,2,...]`
drives 11 user flows through the UI (guest, register, sign in, reporting, matches, claims,
approval, mark as returned, admin, persistence/reset, mobile) and fails on any console error,
failed request or HTTP status >= 400.

## Deploy

Static files, no build step. `vercel.json` turns on clean URLs and security headers; every page
has a strict Content-Security-Policy (`script-src 'self' 'wasm-unsafe-eval'`, no inline scripts,
no third-party requests). `.vercelignore` keeps `SPEC.md` and `e2e/` out of the deployment.

## Limits (same as the report)

Data lives only in the visitor's browser, so two people on different devices don't see each
other's posts. No email/SMS is sent; there is no password recovery, report editing or pagination
(lists return at most 200 items). Matching is rule based; it does not compare images or text meaning.

Fleet Mitra · academic prototype · demo data only. Font: Plus Jakarta Sans (SIL OFL, see
`assets/fonts/plus-jakarta-sans/LICENSE`). Database engine: sql.js (MIT, see `vendor/LICENSE-sql.js`).
