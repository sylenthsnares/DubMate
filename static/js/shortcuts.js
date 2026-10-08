// shortcuts.js - The keyboard shortcut list and the "?" sheet that shows it.
// SHORTCUT_GROUPS is the one list: tests/test_shortcut_sheet.js presses every
// item's keys and checks it really does what the sheet says.

import { escapeHtml, openDialog, isDialogOpen } from './ui_common.js';

// page: 'studio', 'builder' or 'any'. view: the screen the keys work on ('any' for
// everywhere); the sheet lists that screen's group first. Each key combo is a list
// of keys pressed together.
export const SHORTCUT_GROUPS = [
  {
    id: 'scenes', title: 'Choose a scene', page: 'studio', view: 'landing', items: [
      { id: 'scenes-search', keys: [['/']], label: 'Search scenes' },
      { id: 'scenes-clear', keys: [['Esc']], label: 'Clear the search' },
    ],
  },
  {
    id: 'recording', title: 'Booth', page: 'studio', view: 'booth', items: [
      { id: 'rec-toggle', keys: [['Space']], label: 'Record, or stop recording' },
      { id: 'rec-nudge', keys: [['[']], label: 'Move my take 25 ms earlier' },
      { id: 'rec-nudge-later', keys: [[']']], label: 'Move my take 25 ms later' },
      { id: 'rec-nudge-big', keys: [['Shift', '['], ['Shift', ']']], label: 'Same, by 100 ms' },
      { id: 'rec-switch', keys: [['A']], label: 'Switch between the original and your take' },
      { id: 'line-prev', keys: [[',']], label: 'Previous line' },
      { id: 'line-next', keys: [['.']], label: 'Next line' },
      { id: 'takes-focus', keys: [['T']], label: 'Go to the take in the dub' },
      { id: 'takes-move', keys: [['↑'], ['↓']], label: 'In the takes: move up or down' },
      { id: 'takes-play', keys: [['P']], label: 'In the takes: play this take' },
      { id: 'takes-use', keys: [['Enter']], label: 'In the takes: use this take in the dub' },
      { id: 'takes-delete', keys: [['Delete']], label: 'In the takes: delete this take (you can undo)' },
    ],
  },
  {
    id: 'watching', title: 'Premiere', page: 'studio', view: 'screening', items: [
      { id: 'watch-play', keys: [['Space']], label: 'Play or pause' },
      { id: 'watch-replay', keys: [['R']], label: 'Replay from the start' },
    ],
  },
  {
    id: 'builder', title: 'In the editor', page: 'builder', view: 'editor', items: [
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
    id: 'everywhere', title: 'Everywhere', page: 'any', view: 'any', items: [
      { id: 'help', keys: [['?']], label: 'Show this list' },
      { id: 'close', keys: [['Esc']], label: 'Close windows and menus' },
    ],
  },
];

function comboHtml(combo) {
  const keys = combo.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('<span class="shortcut-plus">+</span>');
  return `<span class="shortcut-combo">${keys}</span>`;
}

function groupHtml(g) {
  return `
        <section class="shortcut-group" aria-labelledby="shortcut-group-${g.id}">
          <h3 id="shortcut-group-${g.id}" class="shortcut-group-title">${escapeHtml(g.title)}</h3>
          <dl class="shortcut-list">
            ${g.items.map((item) => `
            <div class="shortcut-row" data-shortcut="${item.id}">
              <dt class="shortcut-keys">${item.keys.map(comboHtml).join('<span class="shortcut-or">or</span>')}</dt>
              <dd class="shortcut-label">${escapeHtml(item.label)}</dd>
            </div>`).join('')}
          </dl>
        </section>`;
}

const EDITOR_NOTE = 'These work once your video is in the editor.';

/** This screen's keys, then Everywhere, then the other screens in a closed <details>. */
function groupsHtml(page, view) {
  const groups = SHORTCUT_GROUPS.filter((g) => g.page === 'any' || g.page === page);
  const current = groups.find((g) => g.view === view && g.view !== 'any');
  const everywhere = groups.filter((g) => g.view === 'any');
  const others = groups.filter((g) => g !== current && g.view !== 'any');
  // Pack Builder has one group; before the editor step, say when its keys start working.
  const note = page === 'builder' && !current
    ? `<p class="shortcut-note">${escapeHtml(EDITOR_NOTE)}</p>` : '';
  const head = current ? groupHtml(current) : note;
  const more = others.length ? `
        <details class="shortcut-more">
          <summary class="shortcut-more-title">On other screens</summary>
          <div class="shortcut-more-groups">${others.map(groupHtml).join('')}</div>
        </details>` : '';
  return head + everywhere.map(groupHtml).join('') + more;
}

function buildSheet(doc) {
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
      <div class="shortcut-sheet-groups"></div>
    </div>`;
  doc.body.appendChild(overlay);
  return overlay;
}

/**
 * Builds the shortcut sheet once and opens it on "?" (outside text fields, and
 * not while isBlocked() or another dialog is open) or on a click on opener.
 * getView() names the current screen; the list is reordered for it on each open.
 */
export function initShortcutSheet({ opener = null, isBlocked = () => false, getView = () => null } = {}) {
  const doc = document;
  if (doc.getElementById('shortcut-sheet')) return;
  const page = doc.body.classList.contains('builder-body') ? 'builder' : 'studio';
  const overlay = buildSheet(doc);
  const body = overlay.querySelector('.shortcut-sheet-groups');
  const render = () => { body.innerHTML = groupsHtml(page, getView()); };
  render();
  let close = null;

  const open = (returnFocus) => {
    if (isDialogOpen()) return;
    render();
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
