// shortcuts.js - The keyboard shortcut list and the "?" sheet that shows it.
// SHORTCUT_GROUPS is the one list: tests/test_shortcut_sheet.js presses every
// item's keys and checks it really does what the sheet says.

import { escapeHtml, openDialog, isDialogOpen } from './ui_common.js';

// page: 'studio', 'builder' or 'any'. Each key combo is a list of keys pressed together.
export const SHORTCUT_GROUPS = [
  {
    id: 'scenes', title: 'Scenes', page: 'studio', items: [
      { id: 'scenes-search', keys: [['/']], label: 'Search scenes' },
      { id: 'scenes-clear', keys: [['Esc']], label: 'Clear the search' },
    ],
  },
  {
    id: 'recording', title: 'Recording', page: 'studio', items: [
      { id: 'rec-toggle', keys: [['Space']], label: 'Record, or stop recording' },
      { id: 'rec-nudge', keys: [['['], [']']], label: 'Nudge the timing by 25 ms' },
      { id: 'rec-nudge-big', keys: [['Shift', '['], ['Shift', ']']], label: 'Nudge the timing by 100 ms' },
    ],
  },
  {
    id: 'watching', title: 'Watching together', page: 'studio', items: [
      { id: 'watch-play', keys: [['Space']], label: 'Play or pause' },
      { id: 'watch-replay', keys: [['R']], label: 'Replay from the start' },
    ],
  },
  {
    id: 'builder', title: 'Pack Builder', page: 'builder', items: [
      { id: 'builder-play', keys: [['Space']], label: 'Play or pause' },
      { id: 'builder-in', keys: [['I'], ['[']], label: 'Start the line here' },
      { id: 'builder-out', keys: [['O'], [']']], label: 'End the line here' },
      { id: 'builder-new', keys: [['N']], label: 'Add a new line here' },
      { id: 'builder-step', keys: [['←'], ['→']], label: 'Move back or forward 0.2 s' },
      { id: 'builder-jump', keys: [['Shift', '←'], ['Shift', '→']], label: 'Move back or forward 2 s' },
      { id: 'builder-delete', keys: [['Delete'], ['Backspace']], label: 'Remove the selected line' },
    ],
  },
  {
    id: 'everywhere', title: 'Everywhere', page: 'any', items: [
      { id: 'help', keys: [['?']], label: 'Show this list' },
      { id: 'close', keys: [['Esc']], label: 'Close windows and menus' },
    ],
  },
];

function comboHtml(combo) {
  return combo.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="shortcut-plus">+</span>');
}

function buildSheet(doc, page) {
  const groups = SHORTCUT_GROUPS.filter((g) => g.page === 'any' || g.page === page);
  const overlay = doc.createElement('div');
  overlay.id = 'shortcut-sheet';
  overlay.className = 'studio-modal-overlay shortcut-sheet-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'shortcut-sheet-title');
  overlay.innerHTML = `
    <div class="studio-modal-card shortcut-sheet-card">
      <button type="button" class="modal-close-btn shortcut-sheet-close" aria-label="Close">✕</button>
      <h2 id="shortcut-sheet-title" class="modal-title">Keyboard shortcuts</h2>
      <div class="shortcut-sheet-groups">
        ${groups.map((g) => `
        <section class="shortcut-group" aria-labelledby="shortcut-group-${g.id}">
          <h3 id="shortcut-group-${g.id}" class="shortcut-group-title">${escapeHtml(g.title)}</h3>
          <dl class="shortcut-list">
            ${g.items.map((item) => `
            <div class="shortcut-row" data-shortcut="${item.id}">
              <dt class="shortcut-keys">${item.keys.map(comboHtml).join('<span class="shortcut-or">or</span>')}</dt>
              <dd class="shortcut-label">${escapeHtml(item.label)}</dd>
            </div>`).join('')}
          </dl>
        </section>`).join('')}
      </div>
    </div>`;
  doc.body.appendChild(overlay);
  return overlay;
}

/**
 * Builds the shortcut sheet once and opens it on "?" (outside text fields, and
 * not while isBlocked() or another dialog is open) or on a click on opener.
 */
export function initShortcutSheet({ opener = null, isBlocked = () => false } = {}) {
  const doc = document;
  if (doc.getElementById('shortcut-sheet')) return;
  const page = doc.body.classList.contains('builder-body') ? 'builder' : 'studio';
  const overlay = buildSheet(doc, page);
  let close = null;

  const open = (returnFocus) => {
    if (isDialogOpen()) return;
    close = openDialog(overlay, { returnFocus });
  };
  overlay.querySelector('.shortcut-sheet-close').addEventListener('click', () => close && close());
  if (opener) opener.addEventListener('click', () => open(opener));

  window.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (isBlocked() || isDialogOpen()) return;
    e.preventDefault();
    open(doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : opener);
  });
}
