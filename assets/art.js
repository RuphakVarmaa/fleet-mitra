// art.js: inline SVG icons and the line-art category illustrations (teal + saffron).
// All markup here is constant text written for this app. It never contains user data,
// so it is safe to turn into DOM nodes with a <template>.

const T = '#1d5c66';  // teal ink
const S = '#e8a33d';  // saffron
const SOFT = '#d6e8e6';
const SOFT_S = '#f6dcae';
const LINE = `stroke="${T}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"`;
const SHADOW = `<ellipse cx="100" cy="125" rx="58" ry="6" fill="${T}" opacity=".09"/>`;

// --- 24px UI icons (stroke = currentColor) ---
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5"/>',
  arrow: '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.6M6.6 6.6C4.4 8 2.9 10.1 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c1-3.2 3.5-5 6.5-5s5.5 1.8 6.5 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 15.2c1.7.7 2.9 2.3 3.5 4.8"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  message: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z"/>',
  handoff: '<path d="M3 12h4l3 3 4-4"/><path d="M21 12h-4l-3-3"/><circle cx="12" cy="12" r="9"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};

/** A 24px stroke icon as an <svg> element. */
export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] ?? ICONS.info; // constant markup only
  return svg;
}

// --- category illustrations (viewBox 200 x 140) ---
const ART = {
  Electronics: `
    ${SHADOW}
    <rect x="56" y="14" width="62" height="102" rx="12" fill="#fff" ${LINE}/>
    <rect x="66" y="25" width="42" height="21" rx="4" fill="${SOFT}" stroke="${T}" stroke-width="3"/>
    <path d="M74 36h16" stroke="${T}" stroke-width="3" stroke-linecap="round"/>
    <g fill="${T}">
      <circle cx="73" cy="59" r="4"/><circle cx="87" cy="59" r="4"/><circle cx="101" cy="59" r="4"/>
      <circle cx="73" cy="73" r="4"/><circle cx="87" cy="73" r="4"/><circle cx="101" cy="73" r="4"/>
      <circle cx="73" cy="87" r="4"/><circle cx="87" cy="87" r="4"/>
      <circle cx="73" cy="101" r="4"/><circle cx="87" cy="101" r="4"/>
    </g>
    <rect x="96" y="82" width="10" height="24" rx="5" fill="${S}"/>
    <path d="M147 74l6 30" stroke="${T}" stroke-width="11" stroke-linecap="round"/>
    <path d="M147 74l6 30" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    <circle cx="143" cy="62" r="15" fill="#fff" ${LINE}/>
    <circle cx="143" cy="62" r="6" fill="${S}"/>`,

  'Bags & wallets': `
    ${SHADOW}
    <rect x="62" y="20" width="58" height="36" rx="5" fill="${SOFT_S}" stroke="${T}" stroke-width="3" transform="rotate(-9 91 38)"/>
    <rect x="42" y="36" width="116" height="80" rx="13" fill="#fff" ${LINE}/>
    <rect x="51" y="45" width="98" height="62" rx="8" fill="none" stroke="${T}" stroke-width="2" stroke-dasharray="4 5" opacity=".45"/>
    <path d="M114 58h44v38h-44a19 19 0 0 1 0-38z" fill="${SOFT}" ${LINE}/>
    <circle cx="117" cy="77" r="6.5" fill="${S}" stroke="${T}" stroke-width="3"/>`,

  Keys: `
    ${SHADOW}
    <circle cx="66" cy="54" r="21" fill="none" ${LINE}/>
    <path d="M104 63h52a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-6v10h-9V76h-6v14h-9V76h-22z" fill="#fff" ${LINE}/>
    <circle cx="92" cy="70" r="18" fill="#fff" ${LINE}/>
    <circle cx="92" cy="70" r="6" fill="${SOFT}" stroke="${T}" stroke-width="3"/>
    <g transform="rotate(-16 54 92)">
      <rect x="40" y="76" width="28" height="38" rx="6" fill="${SOFT_S}" stroke="${T}" stroke-width="3"/>
      <circle cx="54" cy="86" r="3.5" fill="${T}"/>
      <path d="M47 98h14M47 105h9" stroke="${T}" stroke-width="2.5" stroke-linecap="round"/>
    </g>`,

  Clothing: `
    ${SHADOW}
    <path d="M80 18l20 12 20-12 30 15 12 58-17 5-6-30v54H61V66l-6 30-17-5 12-58z" fill="#fff" ${LINE}/>
    <path d="M80 18l12 40 8-28M120 18l-12 40-8-28" fill="${SOFT}" ${LINE}/>
    <path d="M100 58v58" stroke="${T}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="107" cy="72" r="3.6" fill="${S}"/><circle cx="107" cy="87" r="3.6" fill="${S}"/><circle cx="107" cy="102" r="3.6" fill="${S}"/>
    <path d="M69 88h19v13a4 4 0 0 1-4 4H73a4 4 0 0 1-4-4z" fill="${SOFT}" stroke="${T}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M124 82V69" stroke="${S}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M115 80h19v13a4 4 0 0 1-4 4h-11a4 4 0 0 1-4-4z" fill="#fff" stroke="${T}" stroke-width="3" stroke-linejoin="round"/>`,

  Documents: `
    ${SHADOW}
    <path d="M100 4v26" stroke="${S}" stroke-width="7" stroke-linecap="round"/>
    <rect x="44" y="32" width="112" height="82" rx="11" fill="#fff" ${LINE}/>
    <path d="M44 43a11 11 0 0 1 11-11h90a11 11 0 0 1 11 11v8H44z" fill="${SOFT}" ${LINE}/>
    <rect x="90" y="24" width="20" height="13" rx="3.5" fill="#fff" stroke="${T}" stroke-width="3"/>
    <rect x="57" y="61" width="32" height="40" rx="6" fill="${SOFT_S}" stroke="${T}" stroke-width="3"/>
    <circle cx="73" cy="76" r="6.5" fill="${T}"/>
    <path d="M63 97c2-6 5.5-8.5 10-8.5s8 2.5 10 8.5" fill="${T}"/>
    <path d="M100 68h42M100 80h34M100 92h24" stroke="${T}" stroke-width="3.5" stroke-linecap="round" opacity=".75"/>`,

  Other: `
    ${SHADOW}
    <path d="M86 28v-6" ${LINE}/>
    <path d="M42 72a44 44 0 0 1 88 0q-11-8-22 0-11-8-22 0-11-8-22 0-11-8-22 0z" fill="${SOFT}" ${LINE}/>
    <path d="M86 28q-14 20-22 44M86 28q14 20 22 44" fill="none" stroke="${T}" stroke-width="2.5" opacity=".55"/>
    <path d="M86 72v34a8 8 0 0 1-16 0" fill="none" ${LINE}/>
    <rect x="138" y="44" width="30" height="72" rx="10" fill="#fff" ${LINE}/>
    <rect x="143" y="29" width="20" height="15" rx="3.5" fill="${S}" stroke="${T}" stroke-width="3"/>
    <path d="M138 64h30" stroke="${T}" stroke-width="3"/>
    <circle cx="153" cy="88" r="7" fill="${SOFT_S}" stroke="${T}" stroke-width="2.5"/>`,
};

const template = document.createElement('template');

/** The illustration for a category, as an <svg> element. */
export function illustration(category, className = 'art') {
  const body = ART[category] ?? ART.Other;
  template.innerHTML = `<svg viewBox="0 0 200 140" class="${className}" aria-hidden="true" focusable="false">${body}</svg>`;
  return template.content.firstElementChild.cloneNode(true);
}
