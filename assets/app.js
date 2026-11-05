// app.js: the UI controller (the demo's version of the report's assets/app.js).
// It only talks to the API through send(action, payload), the same way the original
// page used fetch('api.php?action=...'). It never runs SQL itself.

import { createApi, CSRF_ERROR, todayIso } from './api.js';
import { openDemo, SESSION_KEY } from './db.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './seed.js';
import { icon, illustration } from './art.js';
import {
  $, $$, h, formatDate, plural, debounce, prefersReducedMotion, setBusy,
  setupDialog, openDialog, closeDialog, confirmAction, toast,
} from './ui.js';

const state = {
  demo: null,          // database + uploads + session (from db.js)
  api: null,           // createApi(...) instance
  csrf: null,
  user: null,
  categories: [],
  route: 'board',
  board: { tab: 'all', q: '', category: '' },
  openItemId: null,
  afterSignIn: null,   // what to do once the visitor signs in (e.g. open the report form)
};

// Clicks that arrive while the database is still loading wait for this instead of failing.
let markReady;
const appReady = new Promise((resolve) => { markReady = resolve; });

const TAB_ID = Math.random().toString(36).slice(2);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('fleet-mitra-demo') : null;
let searchCounter = 0;            // stops an older search result from replacing a newer one
let inFlight = Promise.resolve(); // lets a reload wait for running requests

const dialogs = {
  signin: $('#dlg-signin'),
  join: $('#dlg-join'),
  report: $('#dlg-report'),
  item: $('#dlg-item'),
  confirm: $('#dlg-confirm'),
};

// ---------------------------------------------------------------------------
// Talking to the API
// ---------------------------------------------------------------------------
async function send(action, payload = {}, retried = false) {
  if (!state.api) await appReady;
  const request = state.api.call(action, { ...payload, csrf: state.csrf });
  inFlight = inFlight.then(() => request).catch(() => {});
  const res = await request;
  if (!res.ok && res.status === 403 && res.error === CSRF_ERROR && !retried) {
    await refreshSession(); // the token changed in another tab: fetch the new one and retry once
    return send(action, payload, true);
  }
  if (res.ok && typeof res.data?.csrf === 'string') state.csrf = res.data.csrf;
  return res;
}

async function refreshSession() {
  const res = await state.api.call('bootstrap', {});
  if (!res.ok) return;
  state.csrf = res.data.csrf;
  state.user = res.data.user;
  state.categories = res.data.categories;
  renderAccount();
  renderStats(res.data.counts);
}

function makeApi() {
  state.api = createApi({
    db: state.demo.db,
    store: state.demo.uploads,
    session: state.demo.session,
    onWrite: async () => {
      await state.demo.save();
      channel?.postMessage({ type: 'changed', from: TAB_ID });
    },
  });
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function init() {
  Object.values(dialogs).forEach(setupDialog);
  wireEvents();
  renderDemoAccounts();
  restoreRibbon();

  try {
    state.demo = await openDemo();
  } catch (err) {
    showStartupError(err);
    return;
  }
  makeApi();
  await refreshSession();
  fillCategorySelects();
  await route();
  document.body.classList.add('is-ready');
  markReady();

  if (!state.demo.persistent) toast('This browser blocks saved data, so changes last until you reload.', 'info');
  showQueuedToast();
}

function showStartupError(err) {
  console.warn(err);
  const main = $('#main');
  main.replaceChildren(h('div', { class: 'container page' },
    h('div', { class: 'empty empty--error' },
      icon('alert', 'icon empty__icon'),
      h('h2', { class: 'empty__title' }, "The demo couldn't start"),
      h('p', { class: 'empty__text' }, 'Your browser blocked the built-in database. Try a current version of Chrome, Edge, Firefox or Safari, or reload the page.'),
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => location.reload() }, 'Reload'))));
}

// A toast that should appear after a full page reload (used by Reset demo data).
function showQueuedToast() {
  try {
    const message = sessionStorage.getItem('fleet-mitra.toast');
    if (message) {
      sessionStorage.removeItem('fleet-mitra.toast');
      toast(message);
    }
  } catch { /* storage blocked: skip */ }
}

function restoreRibbon() {
  try {
    if (sessionStorage.getItem('fleet-mitra.ribbon') === 'hidden') $('#demo-ribbon').hidden = true;
  } catch { /* keep it visible */ }
}

// ---------------------------------------------------------------------------
// Routing (#/, #/mine, #/admin)
// ---------------------------------------------------------------------------
function routeFromHash() {
  const name = location.hash.replace(/^#\/?/, '');
  return ['mine', 'admin'].includes(name) ? name : 'board';
}

async function route() {
  let next = routeFromHash();
  if (next === 'mine' && !state.user) {
    next = 'board';
    history.replaceState(null, '', '#/');
    openSignIn('Sign in to see your reports.', () => { location.hash = '#/mine'; });
  }
  if (next === 'admin' && state.user?.role !== 'admin') {
    next = 'board';
    history.replaceState(null, '', '#/');
    if (state.user) toast('The admin dashboard is only for administrators.', 'error');
    else openSignIn('Sign in with an admin account to open the dashboard.', () => { location.hash = '#/admin'; });
  }

  const changed = next !== state.route;
  state.route = next;
  for (const view of $$('[data-view]')) view.hidden = view.dataset.view !== next;
  for (const link of $$('.nav__link')) {
    const active = link.dataset.route === next;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (changed) window.scrollTo({ top: 0 });
  await renderRoute();
}

async function renderRoute() {
  if (state.route === 'mine') await loadMine();
  else if (state.route === 'admin') await loadAdmin();
  else await loadBoard();
}

/** Re-reads everything visible: header, current view and an open item dialog. */
async function refreshAll() {
  await refreshSession();
  if ((state.route === 'mine' && !state.user) || (state.route === 'admin' && state.user?.role !== 'admin')) {
    history.replaceState(null, '', '#/');
  }
  await route();
  if (dialogs.item.open && state.openItemId) await showItem(state.openItemId, { keepScroll: true });
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderAccount() {
  const box = $('#account');
  const user = state.user;
  if (!user) {
    box.replaceChildren(
      h('button', { type: 'button', class: 'btn btn--ghost', 'data-action': 'signin' }, 'Sign in'),
      h('button', { type: 'button', class: 'btn btn--soft hide-sm', 'data-action': 'join' }, 'Join'));
  } else {
    box.replaceChildren(
      h('div', { class: 'who' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, user.name.trim().charAt(0).toUpperCase()),
        h('span', { class: 'who__text' },
          h('span', { class: 'who__name' }, user.name),
          h('span', { class: 'who__role' }, user.role === 'admin' ? 'Administrator' : 'Member'))),
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'signout', 'aria-label': 'Sign out', title: 'Sign out' },
        icon('logout')));
  }
  $('.nav__link[data-route="mine"]').hidden = !user;
  $('.nav__link[data-route="admin"]').hidden = user?.role !== 'admin';
  $('#nav').dataset.links = String($$('.nav__link').filter((link) => !link.hidden).length);
}

function renderStats(counts) {
  if (!counts) return;
  $('#stat-lost').textContent = counts.lost;
  $('#stat-found').textContent = counts.found;
  $('#stat-returned').textContent = counts.returned;
}

function fillCategorySelects() {
  for (const select of $$('.category-select')) {
    const keepFirst = select.options[0]?.value === '' ? [select.options[0]] : [];
    select.replaceChildren(...keepFirst, ...state.categories.map((c) => h('option', { value: c }, c)));
  }
}

function renderDemoAccounts() {
  $('#demo-accounts').replaceChildren(...DEMO_ACCOUNTS.map((account) => h('li', { class: 'demo-account' },
    h('span', { class: 'avatar avatar--sm', 'aria-hidden': 'true' }, account.name.charAt(0)),
    h('span', { class: 'demo-account__text' },
      h('span', { class: 'demo-account__name' }, account.name),
      h('span', { class: 'demo-account__meta' }, account.email),
      h('span', { class: 'demo-account__hint' }, account.hint)),
    h('button', { type: 'button', class: 'btn btn--soft btn--sm', 'data-action': 'use-account', 'data-email': account.email,
      'aria-label': `Use the ${account.name} account` }, 'Use this account'))));
}

// ---------------------------------------------------------------------------
// Shared pieces: pills, media, cards, empty states
// ---------------------------------------------------------------------------
const STATUS_LABEL = { lost: 'Lost', found: 'Found', returned: 'Returned', hidden: 'Hidden' };

function statusKey(item) {
  return item.status === 'open' ? item.type : item.status;
}

function statusPill(item) {
  const key = statusKey(item);
  return h('span', { class: `pill pill--${key}` }, h('span', { class: 'pill__dot', 'aria-hidden': 'true' }), STATUS_LABEL[key]);
}

function demoPill() {
  return h('span', { class: 'pill pill--demo' }, 'Demo');
}

const photoUrls = new Map();
async function photoUrl(name) {
  if (!photoUrls.has(name)) {
    const blob = await state.demo.uploads.get(name).catch(() => null);
    photoUrls.set(name, blob ? URL.createObjectURL(blob) : null);
  }
  return photoUrls.get(name);
}

/** The category illustration, swapped for the uploaded photo once it has loaded. */
function itemMedia(item) {
  const frame = h('div', { class: 'media' }, illustration(item.category));
  if (item.image) {
    photoUrl(item.image).then((url) => {
      if (!url) return;
      const img = h('img', { class: 'media__photo', src: url, alt: `Photo of ${item.title}` });
      img.addEventListener('load', () => frame.replaceChildren(img), { once: true });
    });
  }
  return frame;
}

function metaLine(iconName, text) {
  return h('span', { class: 'meta' }, icon(iconName, 'icon meta__icon'), h('span', {}, text));
}

function itemCard(item) {
  return h('article', { class: `card card--${statusKey(item)}` },
    h('div', { class: 'card__media' },
      itemMedia(item),
      h('div', { class: 'card__pills' }, statusPill(item), item.is_demo ? demoPill() : null)),
    h('div', { class: 'card__body' },
      h('p', { class: 'eyebrow' }, item.category),
      h('h3', { class: 'card__title' },
        h('button', { type: 'button', class: 'card__link', 'data-action': 'open-item', 'data-id': item.id }, item.title)),
      h('p', { class: 'card__desc' }, item.description),
      h('div', { class: 'card__meta' },
        metaLine('pin', item.location),
        metaLine('calendar', formatDate(item.event_date)))),
    h('span', { class: 'card__go', 'aria-hidden': 'true' }, icon('arrow')));
}

function emptyState({ iconName = 'inbox', title, text, action = null }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty__badge', 'aria-hidden': 'true' }, icon(iconName, 'icon empty__icon')),
    h('h3', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    action);
}

function errorState(message) {
  return emptyState({ iconName: 'alert', title: 'Something went wrong', text: message });
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------
async function loadBoard() {
  const ticket = ++searchCounter;
  const grid = $('#board-grid');
  grid.setAttribute('aria-busy', 'true');
  const { tab, q, category } = state.board;
  const res = await send('items', { type: tab, q, category });
  if (ticket !== searchCounter) return; // a newer search already started
  grid.setAttribute('aria-busy', 'false');

  if (!res.ok) {
    grid.replaceChildren(errorState(res.error));
    return;
  }
  renderStats(res.data.counts);
  const items = res.data.items;
  if (items.length) {
    grid.replaceChildren(...items.map(itemCard));
  } else {
    const filtered = q || category;
    grid.replaceChildren(emptyState({
      iconName: 'search',
      title: filtered ? 'Nothing matches those filters' : 'No reports here yet',
      text: filtered ? 'Try another keyword or category, or check the other tabs.' : 'When someone posts in this view it will show up here.',
      action: filtered ? h('button', { type: 'button', class: 'btn btn--soft', 'data-action': 'clear-filters' }, 'Clear filters') : null,
    }));
  }
  $('#board-summary').textContent = boardSummary(items.length);
}

function boardSummary(count) {
  const { tab, q, category } = state.board;
  const noun = { all: 'open report', lost: 'open lost report', found: 'open found report', returned: 'returned item' }[tab];
  let text = plural(count, noun);
  if (q) text += ` matching “${q}”`;
  if (category) text += ` in ${category}`;
  return `${text}.`;
}

function syncBoardControls() {
  for (const tab of $$('.tab')) tab.setAttribute('aria-pressed', String(tab.dataset.tab === state.board.tab));
  for (const stat of $$('.stat')) stat.classList.toggle('is-active', stat.dataset.tab === state.board.tab);
  $('#board-q').value = state.board.q;
  $('#board-category').value = state.board.category;
}

function scrollToBoard() {
  $('#board').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

async function setBoardFilters(changes, { scroll = false } = {}) {
  Object.assign(state.board, changes);
  syncBoardControls();
  if (state.route !== 'board') {
    location.hash = '#/';
    return; // the hashchange handler loads the board
  }
  if (scroll) scrollToBoard();
  await loadBoard();
}

const debouncedSearch = debounce(() => {
  state.board.q = $('#board-q').value.trim();
  loadBoard();
}, 250);

// ---------------------------------------------------------------------------
// Item details dialog
// ---------------------------------------------------------------------------
async function showItem(id, { keepScroll = false } = {}) {
  state.openItemId = id;
  const body = $('#item-body');
  const scroller = $('.modal__inner', dialogs.item);
  if (!dialogs.item.open) {
    body.replaceChildren(itemSkeleton());
    openDialog(dialogs.item);
  }
  const [detail, matches] = await Promise.all([send('item', { id }), send('matches', { id })]);
  if (state.openItemId !== id) return;
  const scrollTop = scroller.scrollTop;
  if (!detail.ok) {
    body.replaceChildren(errorState(detail.error));
    return;
  }
  body.replaceChildren(renderItem(detail.data.item, matches.ok ? matches.data.matches : []));
  scroller.scrollTop = keepScroll ? scrollTop : 0;
}

function itemSkeleton() {
  return h('div', { class: 'detail', 'aria-hidden': 'true' },
    h('div', { class: 'detail__media sk-block' }),
    h('span', { class: 'sk sk--sm' }), h('span', { class: 'sk sk--lg' }), h('span', { class: 'sk' }));
}

function renderItem(item, matches) {
  const key = statusKey(item);
  const detail = h('div', { class: 'detail' });

  detail.append(
    h('div', { class: 'detail__pills' }, statusPill(item), item.is_demo ? demoPill() : null),
    h('div', { class: `detail__media detail__media--${key}` }, itemMedia(item)),
    h('p', { class: 'eyebrow' }, `${item.category} · ${item.type === 'lost' ? 'Lost item' : 'Found item'}`),
    h('h2', { class: 'detail__title', id: 'item-title' }, item.title),
    h('div', { class: 'detail__meta' },
      metaLine('pin', item.location),
      metaLine('calendar', formatDate(item.event_date)),
      metaLine('user', `Posted by ${item.posted_by}`)),
    h('p', { class: 'detail__desc' }, item.description));

  if (item.status === 'returned') {
    detail.append(h('p', { class: 'notice notice--returned' }, icon('checkCircle'),
      h('span', {}, 'Returned to its owner. The report stays here as a record.')));
  }
  if (item.status === 'hidden') {
    detail.append(h('p', { class: 'notice notice--hidden' }, icon('eyeOff'),
      h('span', {}, `Hidden by an admin. Only the poster and admins can see it. When restored it goes back to “${item.previous_status === 'returned' ? 'Returned' : 'Open'}”.`)));
  }

  const actions = manageActions(item);
  if (actions) detail.append(actions);
  if (item.claims) detail.append(privateClaims(item));
  if (!item.is_owner && state.user?.role !== 'admin') detail.append(claimSection(item));
  detail.append(matchesSection(matches));
  return detail;
}

function manageActions(item) {
  const buttons = [];
  if (item.can_manage && item.status === 'open') {
    buttons.push(h('button', { type: 'button', class: 'btn btn--dark', 'data-action': 'mark-returned', 'data-id': item.id },
      icon('check'), 'Mark as returned'));
  }
  if (state.user?.role === 'admin') {
    buttons.push(item.status === 'hidden'
      ? h('button', { type: 'button', class: 'btn btn--soft', 'data-action': 'admin-restore', 'data-id': item.id }, icon('restore'), 'Restore')
      : h('button', { type: 'button', class: 'btn btn--danger-soft', 'data-action': 'admin-hide', 'data-id': item.id }, icon('eyeOff'), 'Hide'));
  }
  return buttons.length ? h('div', { class: 'detail__actions' }, buttons) : null;
}

function privateClaims(item) {
  const claims = item.claims;
  const section = h('section', { class: 'detail__section', 'aria-labelledby': 'claims-title' },
    h('h3', { class: 'detail__h', id: 'claims-title' }, 'Private claims ', h('span', { class: 'count' }, claims.length)),
    h('p', { class: 'detail__hint' }, icon('lock', 'icon icon--inline'), 'Only the poster and admins can see these messages and email addresses.'));

  if (!claims.length) {
    section.append(h('p', { class: 'muted-box' }, 'No claims yet. Verified claims will appear here.'));
    return section;
  }
  for (const claim of claims) {
    const canApprove = claim.status === 'pending' && item.status === 'open';
    section.append(h('article', { class: 'claim-card' },
      h('div', { class: 'claim-card__head' },
        h('span', { class: 'avatar avatar--sm', 'aria-hidden': 'true' }, claim.claimant_name.charAt(0).toUpperCase()),
        h('strong', { class: 'claim-card__name' }, claim.claimant_name),
        h('span', { class: `chip-status chip-status--${claim.status}` }, claim.status),
        h('span', { class: 'claim-card__date' }, formatDate(claim.created_at))),
      h('p', { class: 'claim-card__msg' }, claim.message),
      claim.answer_verified ? h('p', { class: 'claim-card__ok' }, icon('check', 'icon icon--inline'), 'Verification answer matched') : null,
      h('p', { class: 'claim-card__contact' }, icon('mail', 'icon icon--inline'), 'Contact: ',
        h('a', { href: `mailto:${claim.claimant_email}` }, claim.claimant_email)),
      canApprove ? h('button', { type: 'button', class: 'btn btn--dark btn--sm', 'data-action': 'approve-claim',
        'data-id': claim.id, 'data-item': item.id, 'data-name': claim.claimant_name }, 'Confirm return & approve') : null));
  }
  return section;
}

function claimSection(item) {
  const heading = item.type === 'lost' ? 'Found this item?' : 'Is this yours?';
  const section = h('section', { class: 'detail__section claim-box', 'aria-labelledby': 'claim-title' },
    h('h3', { class: 'detail__h', id: 'claim-title' }, heading));

  if (item.is_demo) {
    section.append(h('p', { class: 'notice notice--demo' }, icon('info'), h('span', {}, "Demo listings can't receive claims.")));
    return section;
  }
  if (item.status !== 'open') {
    section.append(h('p', { class: 'muted-box' }, 'This item has been returned, so it no longer takes claims.'));
    return section;
  }
  if (!state.user) {
    section.append(h('div', { class: 'signin-cta' },
      h('p', {}, 'Answer the poster’s private question to send them a message. You need an account so they can reach you.'),
      h('button', { type: 'button', class: 'btn btn--dark', 'data-action': 'signin-to-claim', 'data-id': item.id }, icon('lock'), 'Sign in to claim')));
    return section;
  }
  if (item.my_claim) {
    const notes = {
      pending: 'The poster can now see your message and email address. They will contact you to arrange the handover.',
      approved: 'The poster approved your claim and marked the item as returned.',
      closed: 'This claim was closed because the item was returned another way.',
    };
    section.append(h('div', { class: 'my-claim' },
      h('p', { class: 'my-claim__head' }, `You sent a claim on ${formatDate(item.my_claim.created_at)}`,
        h('span', { class: `chip-status chip-status--${item.my_claim.status}` }, item.my_claim.status)),
      h('p', { class: 'my-claim__text' }, notes[item.my_claim.status])));
    return section;
  }

  const form = h('form', { class: 'form claim-form', 'data-item': item.id },
    h('p', { class: 'detail__hint' }, 'Answer the poster’s question. If it matches, your message and email are shared with them privately.'),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, item.verification_question),
      h('input', { type: 'text', name: 'answer', required: true, maxlength: 80, autocomplete: 'off', 'aria-describedby': 'claim-answer-hint' }),
      h('span', { class: 'field__hint', id: 'claim-answer-hint' }, 'Answers are not case-sensitive.')),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'Message to the poster'),
      h('textarea', { name: 'message', rows: 3, required: true, minlength: 5, maxlength: 500,
        placeholder: 'Where did you see it, and when can you meet to hand it over?' })),
    h('p', { class: 'form-error', role: 'alert', hidden: true }),
    h('button', { type: 'submit', class: 'btn btn--dark' }, icon('message'), 'Send claim'));
  form.addEventListener('submit', submitClaim);
  section.append(form);
  return section;
}

function matchesSection(matches) {
  const section = h('section', { class: 'detail__section', 'aria-labelledby': 'matches-title' },
    h('h3', { class: 'detail__h', id: 'matches-title' }, 'Possible matches'),
    h('p', { class: 'detail__hint' }, 'Similar category, with nearby dates or a matching location. Please compare the details.'));
  if (!matches.length) {
    section.append(h('p', { class: 'muted-box' }, 'No possible matches right now. New reports are compared automatically.'));
    return section;
  }
  const list = h('div', { class: 'matches' });
  for (const match of matches) {
    const days = match.days_apart === 0 ? 'Same day' : `${plural(match.days_apart, 'day')} apart`;
    list.append(h('button', { type: 'button', class: 'match', 'data-action': 'open-item', 'data-id': match.id },
      h('span', { class: `match__art match__art--${statusKey(match)}` }, illustration(match.category)),
      h('span', { class: 'match__text' },
        h('span', { class: 'match__title' }, match.title),
        h('span', { class: 'match__meta' }, `${match.location} · ${formatDate(match.event_date)}`),
        h('span', { class: 'match__chips' },
          statusPill(match),
          match.same_location ? h('span', { class: 'chip-soft' }, 'Same location') : null,
          h('span', { class: 'chip-soft' }, days))),
      icon('arrow', 'icon match__go')));
  }
  section.append(list);
  return section;
}

async function submitClaim(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  clearFormError(form);
  setBusy(button, true, 'Checking answer…');
  const itemId = Number(form.dataset.item);
  const res = await send('claim', { item_id: itemId, answer: form.elements.answer.value, message: form.elements.message.value });
  setBusy(button, false);
  if (!res.ok) {
    showFormError(form, res);
    return;
  }
  toast('Claim sent. Only the poster can see your message.');
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Owner / admin actions
// ---------------------------------------------------------------------------
async function approveClaim(button) {
  const ok = await confirmAction({
    title: 'Confirm the handover?',
    text: `This approves ${button.dataset.name}'s claim, closes any other pending claims and marks the item as returned.`,
    confirmLabel: 'Confirm return & approve',
  });
  if (!ok) return;
  setBusy(button, true, 'Approving…');
  const res = await send('approve_claim', { claim_id: Number(button.dataset.id) });
  if (!res.ok) {
    setBusy(button, false);
    toast(res.error, 'error');
    return;
  }
  toast('Claim approved. The item is now marked as returned.');
  await refreshAll();
}

async function markReturned(button) {
  const ok = await confirmAction({
    title: 'Mark as returned?',
    text: 'Use this when the handover happened outside Fleet Mitra. Any pending claims on this item will be closed.',
    confirmLabel: 'Mark as returned',
  });
  if (!ok) return;
  setBusy(button, true, 'Saving…');
  const res = await send('mark_returned', { item_id: Number(button.dataset.id) });
  if (!res.ok) {
    setBusy(button, false);
    toast(res.error, 'error');
    return;
  }
  toast('Marked as returned. Nice work closing the loop.');
  await refreshAll();
}

async function moderate(button, action) {
  setBusy(button, true, action === 'admin_hide' ? 'Hiding…' : 'Restoring…');
  const res = await send(action, { item_id: Number(button.dataset.id) });
  if (!res.ok) {
    setBusy(button, false);
    toast(res.error, 'error');
    return;
  }
  toast(action === 'admin_hide'
    ? 'Report hidden from the public board.'
    : `Report restored as ${res.data.status === 'returned' ? 'Returned' : 'Open'}.`);
  await refreshAll();
}

// ---------------------------------------------------------------------------
// My reports
// ---------------------------------------------------------------------------
async function loadMine() {
  const res = await send('my_reports');
  if (!res.ok) {
    if (res.status === 401) { location.hash = '#/'; return; }
    $('#mine-items').replaceChildren(errorState(res.error));
    return;
  }
  const { items, claims } = res.data;
  $('#mine-items-count').textContent = items.length;
  $('#mine-claims-count').textContent = claims.length;

  $('#mine-items').replaceChildren(...(items.length ? items.map(itemCard) : [emptyState({
    iconName: 'layers',
    title: "You haven't posted anything yet",
    text: 'Lost something, or holding something that isn’t yours? Post it and the board will look for matches.',
    action: h('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'report' }, icon('plus'), 'Report an item'),
  })]));

  $('#mine-claims').replaceChildren(...(claims.length ? claims.map((claim) => h('div', { class: 'row' },
    h('span', { class: `row__art row__art--${claim.item_status === 'open' ? claim.item_type : claim.item_status}` },
      illustration(claim.item_category)),
    h('div', { class: 'row__text' },
      h('p', { class: 'row__title' }, claim.item_title),
      h('p', { class: 'row__meta' }, `Sent ${formatDate(claim.created_at)}`)),
    h('span', { class: `chip-status chip-status--${claim.status}` }, claim.status),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'open-item', 'data-id': claim.item_id,
      'aria-label': `Open ${claim.item_title}` }, 'Open', icon('arrow')))) : [emptyState({
    iconName: 'message',
    title: "You haven't sent any claims yet",
    text: 'Open a report on the board and answer its private question to send a claim.',
  })]));
}

// ---------------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------------
async function loadAdmin() {
  const res = await send('admin_overview');
  if (!res.ok) {
    toast(res.error, 'error');
    history.replaceState(null, '', '#/');
    await route();
    return;
  }
  const { counts, reports, claims } = res.data;
  const kpi = (iconName, value, label) => h('div', { class: 'kpi' },
    h('span', { class: 'kpi__icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('span', { class: 'kpi__num' }, value), h('span', { class: 'kpi__label' }, label));
  $('#admin-kpis').replaceChildren(
    kpi('users', counts.accounts, counts.accounts === 1 ? 'account' : 'accounts'),
    kpi('layers', counts.reports, counts.reports === 1 ? 'report' : 'reports'),
    kpi('message', counts.claims, counts.claims === 1 ? 'claim' : 'claims'),
    kpi('eyeOff', counts.hidden, 'hidden'));
  $('#admin-reports-count').textContent = reports.length;
  $('#admin-claims-count').textContent = claims.length;

  $('#admin-reports').replaceChildren(...(reports.length ? reports.map((item) => h('div', { class: `row${item.status === 'hidden' ? ' row--hidden' : ''}` },
    h('span', { class: `row__art row__art--${statusKey(item)}` }, illustration(item.category)),
    h('div', { class: 'row__text' },
      h('p', { class: 'row__title' }, item.title, item.is_demo ? demoPill() : null),
      h('p', { class: 'row__meta' }, `${item.posted_by} · ${item.location} · ${item.status}`)),
    h('div', { class: 'row__actions' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'open-item', 'data-id': item.id,
        'aria-label': `Review ${item.title}` }, 'Review', icon('arrow')),
      item.status === 'hidden'
        ? h('button', { type: 'button', class: 'btn btn--soft btn--sm', 'data-action': 'admin-restore', 'data-id': item.id,
          'aria-label': `Restore ${item.title}` }, 'Restore')
        : h('button', { type: 'button', class: 'btn btn--danger-soft btn--sm', 'data-action': 'admin-hide', 'data-id': item.id,
          'aria-label': `Hide ${item.title}` }, 'Hide')))) : [emptyState({ title: 'No reports yet' })]));

  $('#admin-claims').replaceChildren(...(claims.length ? claims.map((claim) => h('div', { class: 'row' },
    h('div', { class: 'row__text' },
      h('p', { class: 'row__title' }, claim.item_title),
      h('p', { class: 'row__meta' }, `${claim.claimant_name} · ${formatDate(claim.created_at)}`)),
    h('span', { class: `chip-status chip-status--${claim.status}` }, claim.status),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'open-item', 'data-id': claim.item_id,
      'aria-label': `Review the claim on ${claim.item_title}` }, 'Review', icon('arrow')))) : [emptyState({
    iconName: 'message', title: 'No claims yet', text: 'Verified claims from every report appear here.',
  })]));
}

// ---------------------------------------------------------------------------
// Sign in / join / sign out
// ---------------------------------------------------------------------------
function clearFormError(form) {
  const box = $('.form-error', form);
  if (box) { box.hidden = true; box.textContent = ''; }
  for (const el of $$('[aria-invalid]', form)) el.removeAttribute('aria-invalid');
}

function showFormError(form, res) {
  const box = $('.form-error', form);
  box.textContent = res.error;
  box.hidden = false;
  const field = res.field ? form.elements.namedItem(res.field) : null;
  if (field && field.setAttribute) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function setReason(id, reason) {
  const box = $(id);
  box.textContent = reason ?? '';
  box.hidden = !reason;
}

function openSignIn(reason = null, after = null) {
  if (after) state.afterSignIn = after;
  closeDialog(dialogs.join);
  const form = $('#form-signin');
  clearFormError(form);
  setReason('#signin-reason', reason);
  openDialog(dialogs.signin);
  form.elements.email.focus();
}

function openJoin(reason = null) {
  closeDialog(dialogs.signin);
  const form = $('#form-join');
  clearFormError(form);
  setReason('#join-reason', reason ?? $('#signin-reason').textContent ?? null);
  openDialog(dialogs.join);
  form.elements.name.focus();
}

async function afterAuth(dialog, form, message) {
  form.reset();
  closeDialog(dialog);
  toast(message);
  const next = state.afterSignIn;
  state.afterSignIn = null;
  await refreshAll();
  if (next) next();
}

async function submitSignIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  clearFormError(form);
  setBusy(button, true, 'Signing in…');
  const res = await send('login', { email: form.elements.email.value, password: form.elements.password.value });
  setBusy(button, false);
  if (!res.ok) {
    showFormError(form, res);
    form.elements.password.select();
    return;
  }
  await afterAuth(dialogs.signin, form, `Welcome back, ${res.data.user.name}.`);
}

async function submitJoin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  clearFormError(form);
  setBusy(button, true, 'Creating account…');
  const res = await send('register', {
    name: form.elements.name.value, email: form.elements.email.value, password: form.elements.password.value,
  });
  setBusy(button, false);
  if (!res.ok) {
    showFormError(form, res);
    return;
  }
  await afterAuth(dialogs.join, form, `Welcome to Fleet Mitra, ${res.data.user.name}.`);
}

async function signOut() {
  const res = await send('logout');
  if (!res.ok) {
    toast(res.error, 'error');
    return;
  }
  state.afterSignIn = null;
  toast("You've signed out.", 'info');
  if (state.route !== 'board') history.replaceState(null, '', '#/');
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Report an item
// ---------------------------------------------------------------------------
let previewUrl = null;

function resetPhoto() {
  const input = $('#report-photo');
  input.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('#photo-preview').replaceChildren(icon('camera'));
  $('#photo-preview').classList.remove('has-photo');
  $('#photo-remove').hidden = true;
}

function previewPhoto() {
  const file = $('#report-photo').files[0];
  if (!file) { resetPhoto(); return; }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  const img = h('img', { src: previewUrl, alt: 'Selected photo preview' });
  img.addEventListener('error', () => $('#photo-preview').replaceChildren(icon('alert')), { once: true });
  $('#photo-preview').replaceChildren(img);
  $('#photo-preview').classList.add('has-photo');
  $('#photo-remove').hidden = false;
}

function openReport(type = 'lost') {
  if (!state.user) {
    openSignIn('Sign in to report an item.', () => openReport(type));
    return;
  }
  const form = $('#form-report');
  form.reset();
  clearFormError(form);
  resetPhoto();
  form.elements.type.value = type === 'found' ? 'found' : 'lost';
  const today = todayIso();
  form.elements.event_date.max = today;
  form.elements.event_date.value = today;
  openDialog(dialogs.report);
  $('.modal__inner', dialogs.report).scrollTop = 0;
  form.elements.title.focus();
}

async function submitReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  clearFormError(form);
  setBusy(button, true, 'Posting…');
  const f = form.elements;
  const res = await send('report', {
    type: f.type.value, category: f.category.value, title: f.title.value, description: f.description.value,
    location: f.location.value, event_date: f.event_date.value, photo: f.photo.files[0] ?? null,
    verification_question: f.verification_question.value, secret_answer: f.secret_answer.value,
  });
  setBusy(button, false);
  if (!res.ok) {
    showFormError(form, res);
    return;
  }
  closeDialog(dialogs.report);
  form.reset();
  resetPhoto();
  toast('Your report is on the board. Here are its possible matches.');
  await refreshAll();
  await showItem(res.data.id);
}

// ---------------------------------------------------------------------------
// Reset demo data
// ---------------------------------------------------------------------------
async function resetDemo() {
  const ok = await confirmAction({
    title: 'Reset the demo?',
    text: 'This removes every account, report, claim and photo saved in this browser, signs you out and brings back the original sample data.',
    confirmLabel: 'Reset demo data',
    danger: true,
  });
  if (!ok) return;
  await inFlight;
  await state.demo.reset();
  channel?.postMessage({ type: 'reset', from: TAB_ID });
  try { sessionStorage.setItem('fleet-mitra.toast', 'Demo data reset. Everything is back to the original sample data.'); } catch { /* optional */ }
  history.replaceState(null, '', '#/');
  location.reload();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (!state.api && el.dataset.action !== 'dismiss-ribbon') await appReady;
    const id = Number(el.dataset.id);
    switch (el.dataset.action) {
      case 'report': openReport(el.dataset.type); break;
      case 'open-item': showItem(id); break;
      case 'signin': openSignIn(); break;
      case 'join': openJoin(); break;
      case 'signout': signOut(); break;
      case 'signin-to-claim': openSignIn('Sign in to send a claim.'); break;
      case 'use-account': {
        const form = $('#form-signin');
        form.elements.email.value = el.dataset.email;
        form.elements.password.value = DEMO_PASSWORD;
        clearFormError(form);
        $('button[type="submit"]', form).focus();
        break;
      }
      case 'tab': setBoardFilters({ tab: el.dataset.tab }, { scroll: el.classList.contains('stat') }); break;
      case 'quick-search': {
        const form = $('#hero-search');
        form.elements.q.value = el.dataset.q;
        form.requestSubmit();
        break;
      }
      case 'clear-filters': setBoardFilters({ q: '', category: '' }); break;
      case 'approve-claim': approveClaim(el); break;
      case 'mark-returned': markReturned(el); break;
      case 'admin-hide': moderate(el, 'admin_hide'); break;
      case 'admin-restore': moderate(el, 'admin_restore'); break;
      case 'reset': resetDemo(); break;
      case 'dismiss-ribbon':
        $('#demo-ribbon').hidden = true;
        try { sessionStorage.setItem('fleet-mitra.ribbon', 'hidden'); } catch { /* optional */ }
        break;
      default: break;
    }
  });

  $('#hero-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBoardFilters({ tab: 'all', q: form.elements.q.value.trim(), category: form.elements.category.value }, { scroll: true });
  });
  $('#board-q').addEventListener('input', debouncedSearch);
  $('#board-q').addEventListener('search', debouncedSearch); // the little × in search inputs
  $('#board-category').addEventListener('change', (event) => setBoardFilters({ category: event.target.value }));

  $('#form-signin').addEventListener('submit', submitSignIn);
  $('#form-join').addEventListener('submit', submitJoin);
  $('#form-report').addEventListener('submit', submitReport);
  $('#report-photo').addEventListener('change', previewPhoto);
  $('#photo-remove').addEventListener('click', resetPhoto);

  dialogs.item.addEventListener('close', () => { state.openItemId = null; });
  dialogs.signin.addEventListener('close', () => {
    // Keep the "after sign-in" step only while the visitor is still signing in or joining.
    setTimeout(() => { if (!dialogs.join.open && !dialogs.signin.open) state.afterSignIn = null; }, 0);
  });

  window.addEventListener('hashchange', () => route());

  // Another tab changed the data or the session: reload and redraw.
  channel?.addEventListener('message', async (event) => {
    if (event.data?.from === TAB_ID) return;
    if (event.data?.type === 'reset') { location.reload(); return; }
    if (event.data?.type === 'changed') {
      await inFlight;
      if (await state.demo.reload()) makeApi();
      await refreshAll();
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_KEY && state.api) refreshAll();
  });
}

init();
