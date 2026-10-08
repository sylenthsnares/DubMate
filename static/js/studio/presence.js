// studio/presence.js - "Who's here": one overlapping avatar per person online, and a
// popover with each person's roles, where they are, their progress and Ready. One
// component for every screen that shows the room's people: the booth bar now, the
// lobby title row next. It only reads the room state it is given; no app state.
import { escapeHtml, plural } from '../ui_common.js';
import { takeCount } from './takes.js';

// Avatars shown before the "+N" disc.
const PRESENCE_MAX = 5;
// Hover waits this long to open, so a pointer passing over doesn't flash the popover, and
// to close, so crossing the gap to the popover doesn't close it.
const HOVER_DELAY_MS = 150;
// Each container's stack: its elements, the last drawn content and the open state.
const presenceStacks = new WeakMap();

/** A person's avatar as HTML: their initial on their colour, `size` px across. */
export function avatarHtml(user, size = 28) {
  const initial = Array.from(String(user?.name || '?').trim())[0] || '?';
  const sizeStyle = size === 28 ? '' : ` --avatar-size: ${Number(size) || 28}px;`;
  return `<span class="avatar" aria-hidden="true" style="background: ${escapeHtml(user?.color || '')};${sizeStyle}">${escapeHtml(initial.toUpperCase())}</span>`;
}

/** The same avatar as an element (take rows put the person's name in its tooltip). */
export function avatarEl(user, size = 28) {
  const t = document.createElement('template');
  t.innerHTML = avatarHtml(user, size);
  return t.content.firstElementChild;
}

/** One popover row: avatar, name, roles and where they are, progress, Ready. */
function presenceRowHtml(user, roomState, selfId) {
  const assignments = roomState?.role_assignments || {};
  const roles = Object.keys(assignments).filter((c) => (assignments[c] || []).includes(user.id));
  // The same count as the cast strip: their lines that have at least one take.
  const lines = (roomState?.pack?.lines || []).filter((l) => roles.includes(l.character));
  const recorded = lines.filter((l) => takeCount(roomState.takes, l) > 0).length;
  const roleText = roles.length === 0 ? 'No role yet'
    : (roles.length === 1 ? roles[0] : `${plural(roles.length, 'role')}: ${roles.join(', ')}`);
  const where = user.location === 'screening' ? 'Premiere'
    : (user.location === 'lobby' ? 'Lobby' : `Line ${(user.current_line || 0) + 1}`);
  const name = `${user.name}${user.id === selfId ? ' (you)' : ''}`;
  return `<li class="presence-row">${avatarHtml(user)}
    <div class="presence-who">
      <span class="presence-name">${escapeHtml(name)}</span>
      <span class="presence-meta">${escapeHtml(roleText)} · ${escapeHtml(where)}</span>
      ${lines.length ? `<span class="presence-meta">${recorded} of ${plural(lines.length, 'line')} recorded</span>` : ''}
    </div>
    ${user.is_ready ? '<span class="presence-ready">Ready</span>' : ''}
  </li>`;
}

/** Builds the button and popover once per container, with their listeners. */
function buildPresenceStack(container) {
  const popId = `${container.id || 'presence'}-pop`;
  container.innerHTML = `<div class="presence">
    <button type="button" class="presence-stack" aria-expanded="false" aria-controls="${escapeHtml(popId)}"></button>
    <div class="presence-pop" id="${escapeHtml(popId)}" role="group" aria-label="Who's here" hidden>
      <ul class="presence-list"></ul>
    </div>
  </div>`;
  const root = container.firstElementChild;
  const stack = {
    root,
    button: root.querySelector('.presence-stack'),
    pop: root.querySelector('.presence-pop'),
    list: root.querySelector('.presence-list'),
    html: '',
    hover: false,
    hoverTimer: 0,
    pinned: false, // opened by a click: stays open until a second click, Esc or focus leaving
    ctrl: new AbortController(),
  };
  const { signal } = stack.ctrl;
  const show = (open) => {
    stack.pop.hidden = !open;
    stack.button.setAttribute('aria-expanded', String(open));
    if (!open) stack.pinned = false;
  };
  stack.show = show;
  const later = (fn) => {
    clearTimeout(stack.hoverTimer);
    stack.hoverTimer = setTimeout(fn, HOVER_DELAY_MS);
  };
  root.addEventListener('mouseenter', () => {
    stack.hover = true;
    later(() => { if (stack.hover && !root.closest('[inert]')) show(true); });
  }, { signal });
  root.addEventListener('mouseleave', () => {
    stack.hover = false;
    later(() => { if (!stack.hover && !root.contains(document.activeElement)) show(false); });
  }, { signal });
  root.addEventListener('focusin', () => show(true), { signal });
  root.addEventListener('focusout', (e) => {
    if (!root.contains(e.relatedTarget) && !stack.hover) show(false);
  }, { signal });
  stack.button.addEventListener('click', () => {
    clearTimeout(stack.hoverTimer); // a click decides, not a hover still waiting
    if (stack.pinned) show(false);
    else { show(true); stack.pinned = true; }
  }, { signal });
  // Esc closes it before the booth's own Esc handling (on window) sees the key. Not while
  // the stack is inert (the booth while recording): Esc belongs to the take then.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || stack.pop.hidden || root.closest('[inert]')) return;
    e.preventDefault();
    e.stopPropagation();
    const hadFocus = root.contains(document.activeElement);
    show(false);
    if (hadFocus) stack.button.focus();
  }, { signal });
  presenceStacks.set(container, stack);
  return stack;
}

/** Closes the popover of the stack in `container`, if it is open. */
export function closePresence(container) {
  const stack = container && presenceStacks.get(container);
  if (!stack) return;
  clearTimeout(stack.hoverTimer);
  if (!stack.pop.hidden) stack.show(false);
}

/**
 * Draws "who's here" into `container`: the people online in `users` (the room's users,
 * an object or an array), with roles and progress from `roomState`, and "(you)" for
 * `selfId`. Call it on every room update: it redraws only when the content changes,
 * and keeps the same button, so a focused or open popover survives socket updates.
 */
export function renderPresenceStack(container, { users, roomState, selfId } = {}) {
  if (!container) return;
  const online = Object.values(users || {}).filter((u) => u && u.is_online);
  let stack = presenceStacks.get(container);
  if (!online.length) {
    if (stack) stack.ctrl.abort();
    presenceStacks.delete(container);
    container.replaceChildren();
    return;
  }
  if (!stack) stack = buildPresenceStack(container);

  const ready = online.filter((u) => u.is_ready).length;
  const label = `Who's here: ${online.map((u) => u.name).join(', ')}, ${ready} of ${online.length} ready`;
  const extra = online.length - PRESENCE_MAX;
  const faces = online.slice(0, PRESENCE_MAX).map((u) => avatarHtml(u)).join('')
    + (extra > 0 ? `<span class="avatar presence-more" aria-hidden="true">+${extra}</span>` : '');
  const rows = online.map((u) => presenceRowHtml(u, roomState, selfId)).join('');
  const html = `${label}\n${faces}\n${rows}`;
  if (html === stack.html) return;
  stack.html = html;
  stack.button.setAttribute('aria-label', label);
  stack.button.innerHTML = faces;
  stack.list.innerHTML = rows;
}
