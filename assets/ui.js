// ui.js: small DOM helpers shared by the app and the self-test page.
// Dynamic text always goes in as text nodes (never through innerHTML).

import { icon } from './art.js';

/**
 * h('p', { class: 'note' }, 'Hello ', h('b', {}, name))
 * Strings become text nodes, so user data can never turn into HTML.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-01' or an ISO timestamp -> '1 Nov 2026' */
export function formatDate(value) {
  if (!value) return '';
  const text = String(value);
  let y; let m; let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    [y, m, d] = text.split('-').map(Number);
  } else {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return '';
    y = date.getFullYear(); m = date.getMonth() + 1; d = date.getDate();
  }
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const savedLabels = new WeakMap();

/** Shows a spinner + label on a button while work is running, then puts the label back. */
export function setBusy(button, busy, busyLabel = 'Please wait…') {
  if (!button) return;
  if (busy) {
    if (!savedLabels.has(button)) savedLabels.set(button, [...button.childNodes]);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (savedLabels.has(button)) {
      button.replaceChildren(...savedLabels.get(button));
      savedLabels.delete(button);
    }
  }
}

// ---------------------------------------------------------------------------
// Dialogs: close on Escape (native), on the close button, and on a backdrop click
// ---------------------------------------------------------------------------
export function setupDialog(dialog) {
  let pressedOnBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => { pressedOnBackdrop = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && pressedOnBackdrop) dialog.close();
    pressedOnBackdrop = false;
  });
  for (const button of dialog.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => dialog.close());
  }
}

export function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  raiseToasts();
}

export function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

/** A promise-based confirm built on #dlg-confirm. Resolves true when confirmed. */
export function confirmAction({ title, text, confirmLabel = 'Confirm', danger = false }) {
  const dialog = $('#dlg-confirm');
  $('#confirm-title', dialog).textContent = title;
  $('#confirm-text', dialog).textContent = text;
  const ok = $('#confirm-ok', dialog);
  ok.textContent = confirmLabel;
  ok.className = `btn ${danger ? 'btn--danger' : 'btn--dark'}`;
  dialog.classList.toggle('is-danger', danger);

  return new Promise((resolve) => {
    const finish = (value) => {
      ok.removeEventListener('click', onOk);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onOk = () => { finish(true); dialog.close(); };
    const onClose = () => finish(false);
    ok.addEventListener('click', onOk);
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
    ok.focus();
  });
}

// ---------------------------------------------------------------------------
// Toasts. The region is a manual popover so it shows above open modal dialogs.
// ---------------------------------------------------------------------------
const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

function toastRegion() {
  return $('#toasts');
}

function raiseToasts() {
  const region = toastRegion();
  if (!region || !region.childElementCount) return;
  if (supportsPopover) {
    if (region.matches(':popover-open')) region.hidePopover();
    region.showPopover();
  } else {
    const dialogs = $$('dialog[open]');
    (dialogs.at(-1) ?? document.body).append(region);
  }
}

export function toast(message, kind = 'success') {
  const region = toastRegion();
  if (!region) return;
  const iconName = kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'checkCircle';
  const item = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(iconName, 'icon toast__icon'),
    h('p', { class: 'toast__text' }, message));
  const close = h('button', { type: 'button', class: 'toast__close', 'aria-label': 'Dismiss' }, icon('x'));
  item.append(close);

  const remove = () => {
    item.classList.add('is-leaving');
    setTimeout(() => {
      item.remove();
      if (!region.childElementCount && supportsPopover && region.matches(':popover-open')) region.hidePopover();
    }, prefersReducedMotion() ? 0 : 180);
  };
  close.addEventListener('click', remove);
  while (region.childElementCount >= 3) region.firstElementChild.remove(); // keep at most three
  region.append(item);
  raiseToasts();
  setTimeout(remove, kind === 'error' ? 6000 : 4200);
}
