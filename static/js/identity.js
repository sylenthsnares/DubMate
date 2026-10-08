// identity.js - Who you are in a room: the eight person colours, the old colours they
// replace, the name rule and the colour picker. Everything that shows or picks a
// person's colour uses this list.
//
// The engine reads IDENTITY_COLORS and LEGACY_COLORS from this file (dubmate/identity.py)
// and refuses to start unless it finds exactly 8 hues, so keep both tables in this
// literal format: one entry per line, lower-case 6-digit hexes, single quotes.

// The person palette (Palette B), in the order the server hands out free hues. None is
// the record red, the done green or the amber; the person's initial always sits on it.
export const IDENTITY_COLORS = [
  { name: 'Coral', hex: '#f08a6c' },
  { name: 'Lime', hex: '#b5cf5a' },
  { name: 'Mint', hex: '#6fd3a8' },
  { name: 'Cornflower', hex: '#7d9cf0' },
  { name: 'Orchid', hex: '#d987d9' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Blush', hex: '#e9a3b8' },
];

// Colours saved by older versions (and their server fallbacks), mapped to the hue
// that replaces each one.
export const LEGACY_COLORS = {
  '#d97706': 'Coral',
  '#dc2626': 'Coral',
  '#b45309': 'Coral',
  '#f59e0b': 'Coral',
  '#cca458': 'Lime',
  '#16a34a': 'Mint',
  '#25d3a4': 'Mint',
  '#7c5cff': 'Cornflower',
  '#8a6eff': 'Cornflower',
  '#8b5cf6': 'Orchid',
  '#ec4899': 'Pink',
  '#06b6d4': 'Cyan',
};

export const NAME_MAX = 24;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
let pickerCount = 0;

/** A hue's name ("Lime"), or '' for a colour outside the palette. */
export function colorName(hex) {
  return IDENTITY_COLORS.find((c) => c.hex === hex)?.name || '';
}

/**
 * A palette hex for any saved or received colour: palette hues stay, old colours
 * become their new hue, any other colour becomes Coral. '' when it isn't a colour.
 */
export function normalizeColor(value) {
  if (typeof value !== 'string') return '';
  const hex = value.trim().toLowerCase();
  if (!HEX_RE.test(hex)) return '';
  if (colorName(hex)) return hex;
  const legacy = IDENTITY_COLORS.find((c) => c.name === LEGACY_COLORS[hex]);
  return (legacy || IDENTITY_COLORS[0]).hex;
}

/** A name as rooms show it: trimmed, inner spaces collapsed, at most NAME_MAX characters. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim();
}

const initialOf = (name) => (Array.from(String(name || '').trim())[0] || '').toUpperCase();

/**
 * Draws the colour picker into `container`, replacing what was there: the 8 hues as
 * native radios in a fieldset (one tab stop, arrow keys move, Space selects). Your
 * initial (from `name`) sits on the `selected` hue. A hue in `taken` (hex -> the user
 * holding it) is disabled and shows the holder's initial. `onChange(hex)` runs when
 * a free hue is chosen.
 */
export function renderColorPicker(container, { selected = '', taken = new Map(), label = 'Your colour', name = '', onChange } = {}) {
  if (!container) return;
  const group = `id-color-${++pickerCount}`;
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'id-picker';
  const legend = document.createElement('legend');
  legend.className = 'form-label';
  legend.textContent = label;
  const row = document.createElement('div');
  row.className = 'id-swatches';
  fieldset.append(legend, row);

  const dots = new Map();
  for (const { name: hue, hex } of IDENTITY_COLORS) {
    const holder = taken.get(hex);
    const swatch = document.createElement('label');
    swatch.className = 'id-swatch';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = group;
    input.value = hex;
    input.disabled = !!holder;
    input.checked = !holder && hex === selected;
    const accessible = holder ? `${hue}, taken by ${holder.name || 'someone'}` : hue;
    input.setAttribute('aria-label', accessible);
    swatch.dataset.tip = accessible;
    const dot = document.createElement('span');
    dot.className = 'id-swatch-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.background = hex;
    dot.textContent = holder ? initialOf(holder.name) : (input.checked ? initialOf(name) : '');
    if (!holder) dots.set(hex, dot);
    swatch.append(input, dot);
    row.append(swatch);
  }

  fieldset.addEventListener('change', (e) => {
    const hex = e.target?.value;
    if (!dots.has(hex)) return;
    for (const [h, dot] of dots) dot.textContent = h === hex ? initialOf(name) : '';
    if (onChange) onChange(hex);
  });
  container.replaceChildren(fieldset);
}
