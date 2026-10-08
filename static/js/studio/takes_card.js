// studio/takes_card.js - The booth's TAKES card: every take of the current line, newest
// first, as a radio group with one tab stop. The green row is the take in the dub; a click
// on another row (or Enter) puts that one there, ▶ (or P) plays a take, and Delete removes
// it after a 6 s in-place Undo. On lines you can't record the rows are read-only and only play.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { announce } from '../ui_common.js';
import { pickedTake, lineTakes, syncWords } from './takes.js';
import { avatarEl } from './presence.js';

// How long "Take 3 deleted · Undo" stays before the DELETE goes out.
const UNDO_MS = 6000;

function takeEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TakesCardMethods {
  initTakesCardEvents() {
    if (!this.takesList) return;
    this.takesList.addEventListener('keydown', (e) => this.onTakesKeydown(e));
    // An open ⋯ menu closes on a click anywhere else.
    document.addEventListener('click', (e) => {
      if (this.openTakeMenu && !this.openTakeMenu.row.contains(e.target)) this.closeTakeMenu();
    });
    // A delete still waiting on its Undo goes out when the page closes.
    window.addEventListener('pagehide', () => this.flushPendingDelete({ keepalive: true }));
    // Closing the page loses a take still saving or waiting to upload: ask first.
    window.addEventListener('beforeunload', (e) => {
      if (!this.hasUnsavedTakes()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /** A take is still saving (in any room: its upload goes on after you leave), or one in
   *  this room is waiting to upload. */
  hasUnsavedTakes() {
    return Object.keys(this.savingLines).length > 0
      || Object.values(this.pendingUploads).some((list) => list.some((p) => p.fields.roomId === this.roomState?.room_id));
  }

  /** One of the current line's takes by ID. */
  currentLineTake(takeId) {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    return lineTakes(this.roomState?.takes, line).find((t) => t.take_id === takeId);
  }

  renderTakesCard() {
    if (!this.takesList) return;
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const takes = line ? lineTakes(this.roomState.takes, line) : [];
    const mine = !!line && this.canRecordLine(line);
    const inDub = pickedTake(this.roomState?.takes, line);
    const pending = line && this.pendingDelete?.lineId === line.line_id ? this.pendingDelete : null;
    // A take saving on this line: a row of its own, and the other rows can't change meanwhile.
    const saving = line ? this.savingTake(line) : null;
    const waiting = this.waitingTakes(line);

    // Keyboard focus on a row stays on that take's row through the redraw.
    const active = document.activeElement;
    const hadFocus = !!active && this.takesList.contains(active);
    const focusedId = hadFocus ? active.closest('.take-row')?.dataset.takeId : null;
    // Many takes scroll inside the list. A redraw of the same line keeps where you
    // scrolled to; a new line, or a new take in the dub, brings that take into view.
    const sameLine = !!line && this.takesListView?.lineId === line.line_id;
    const reveal = !sameLine || this.takesListView?.pickedId !== inDub?.take_id;
    const scrollTop = sameLine ? this.takesList.scrollTop : 0;
    this.takesListView = line ? { lineId: line.line_id, pickedId: inDub?.take_id } : null;
    this.closeTakeMenu();
    this.takesList.innerHTML = '';

    const live = takes.filter((t) => t.take_id !== pending?.takeId);
    if (this.takesCardTitle) this.takesCardTitle.textContent = live.length ? `TAKES · ${live.length}` : 'TAKES';
    if (this.takesEmpty) {
      this.takesEmpty.hidden = takes.length > 0 || !!saving || waiting.length > 0;
      this.takesEmpty.textContent = mine ? 'No takes yet. Press Space to record.' : 'No takes yet.';
    }
    if (this.takesHint) this.takesHint.hidden = !(mine && live.length === 1 && !saving && !waiting.length);
    if (this.takesKeyHint) this.takesKeyHint.hidden = !(mine && live.length > 0);
    if (mine) this.takesList.removeAttribute('aria-readonly');
    else this.takesList.setAttribute('aria-readonly', 'true');

    // The best-timed take's sync reads a little brighter (never a 0 score).
    let best = null;
    for (const t of live) {
      if (Number.isFinite(t.timing_score) && t.timing_score > 0 && (!best || t.timing_score >= best.timing_score)) best = t;
    }
    // Your take's echo can arrive before the upload's reply: then the take's own row shows.
    if (saving && !takes.some((t) => t.number === saving.number && t.user_id === this.user.id)) {
      this.takesList.appendChild(this.savingTakeRow(saving));
    }
    for (const entry of waiting) this.takesList.appendChild(this.waitingTakeRow(entry, { locked: !!saving }));
    for (const take of [...takes].reverse()) {
      this.takesList.appendChild(take.take_id === pending?.takeId
        ? this.deletedTakeRow(take)
        : this.takeRow(take, { inDub: take.take_id === inDub?.take_id, mine, best: take === best, locked: !!saving }));
    }

    this.renderTakePlayButtons();
    this.renderTakeDependents();

    // Three rows or more: the card may shrink to two rows when the column runs short.
    this.takesList.closest('.takes-card')?.classList.toggle('is-long', this.takesList.children.length >= 3);
    this.takesList.scrollTop = scrollTop;
    if (reveal) this.revealTakeRow(this.takesList.querySelector('.take-row.picked'));

    const radios = [...this.takesList.querySelectorAll('[role="radio"]')];
    const row = focusedId ? [...this.takesList.children].find((r) => r.dataset.takeId === focusedId) : null;
    const stop = row?.querySelector('[role="radio"]')
      || radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0];
    if (stop) stop.tabIndex = 0;
    // A focused row that's gone (its delete went out) hands focus to the card's tab stop.
    if (hadFocus) (row?.querySelector('[role="radio"], .take-undo') || stop)?.focus();
  }

  /** Scrolls the list (only the list, not the column or the page) the least it takes to
   *  show this row whole. */
  revealTakeRow(row) {
    const list = this.takesList;
    if (!row || !list || list.scrollHeight <= list.clientHeight) return;
    const box = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(list).paddingTop) || 0;
    if (r.top < box.top + pad) list.scrollTop -= box.top + pad - r.top;
    else if (r.bottom > box.bottom - pad) list.scrollTop += r.bottom - (box.bottom - pad);
  }

  /** "◉ Take 3 · 0.8 s · (M) · Tight sync · In the dub | ▶ | ⋯". The slot after the sync
   *  reads "In the dub" on the picked row, and "Use this take" on your other rows on hover
   *  and focus (a click on the row uses it). ▶ sits at the same x on every row; ⋯ holds
   *  Delete and is only on rows you can delete. */
  takeRow(take, { inDub, mine, best, locked = false }) {
    const row = takeEl('div', `take-row${inDub ? ' picked' : ''}`);
    row.dataset.takeId = take.take_id;

    const radio = takeEl('div', 'take-pick');
    radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-checked', String(inDub));
    radio.tabIndex = -1;
    radio.appendChild(takeEl('span', 'take-radio')).setAttribute('aria-hidden', 'true');
    radio.appendChild(takeEl('span', 'take-name', `Take ${take.number}`));
    radio.appendChild(takeEl('span', 'take-dur', `${(Number(take.duration) || 0).toFixed(1)} s`));
    if (take.user_id && take.user_id !== this.user.id) {
      // Who recorded it: their avatar, with the name in its tooltip.
      const by = this.roomState?.users?.[take.user_id];
      const name = by?.name || take.user_name || 'Cast member';
      const avatar = radio.appendChild(avatarEl({ name, color: by?.color }, 20));
      avatar.removeAttribute('aria-hidden');
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', `Recorded by ${name}`);
      avatar.dataset.tip = `Recorded by ${name}`;
    }
    const score = take.timing_score;
    const sync = radio.appendChild(takeEl('span', `take-sync${best ? ' best' : ''}`, syncWords(score)));
    sync.dataset.tip = syncWords(score) === '–'
      ? "Timing wasn't measured for this take"
      : `Timing ${Math.round(score * 100)}%: how closely this take follows the original line's timing`;
    const slot = radio.appendChild(takeEl('span', 'take-slot'));
    if (inDub) {
      slot.appendChild(takeEl('span', 'take-in-dub', 'In the dub'));
    } else if (mine && !locked) {
      slot.appendChild(takeEl('span', 'take-use-cue', 'Use this take')).dataset.tip = 'Use this take in the dub (Enter)';
    }
    radio.addEventListener('click', () => {
      if (mine && !inDub) this.pickTake(take);
    });
    row.appendChild(radio);

    const play = row.appendChild(takeEl('button', 'btn btn-ghost btn-xs take-play', '▶'));
    play.type = 'button';
    play.setAttribute('aria-label', `Play take ${take.number}`);
    play.setAttribute('aria-pressed', 'false');
    play.dataset.tip = `Play take ${take.number} (P)`;
    play.addEventListener('click', () => this.playHistoryTake(take, play));

    if (mine) {
      this.appendTakeMenu(row, `Take ${take.number}`, [
        { label: 'Delete take', key: 'Del', onClick: () => this.deleteTake(take), disabled: locked },
      ]);
    }
    return row;
  }

  /** ▶ on each row reads ■ while that take plays, or while its sound is on the way. */
  renderTakePlayButtons() {
    if (!this.takesList) return;
    const busy = !!this.isPlayingTake || !!this.soundWait;
    for (const play of this.takesList.querySelectorAll('.take-play')) {
      const playing = busy && !!this.playingHistoryTakeId
        && play.closest('.take-row')?.dataset.takeId === this.playingHistoryTakeId;
      play.textContent = playing ? '■' : '▶';
      play.setAttribute('aria-pressed', String(playing));
    }
  }

  /** A row's ⋯ button and its menu: [{ label, key, onClick, disabled }]. */
  appendTakeMenu(row, name, items) {
    const more = row.appendChild(takeEl('button', 'btn btn-ghost btn-xs take-more', '⋯'));
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', `More for ${name.toLowerCase()}`);
    // Nothing in it can be used now (its line is saving): the button is off too.
    more.disabled = items.every((item) => item.disabled);
    // The menu opens in the row's flow, under it, so the scrolling column never clips it.
    const menu = row.appendChild(takeEl('div', 'take-menu'));
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', name);
    menu.hidden = true;
    for (const { label, key, onClick, disabled = false } of items) {
      const b = menu.appendChild(takeEl('button', 'take-menu-item'));
      b.type = 'button';
      b.disabled = disabled;
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.appendChild(takeEl('span', 'take-menu-label', label));
      if (key) b.appendChild(takeEl('kbd', 'take-menu-key', key)).setAttribute('aria-hidden', 'true');
      b.addEventListener('click', () => {
        this.closeTakeMenu();
        onClick();
      });
    }
    more.addEventListener('click', () => {
      if (this.openTakeMenu?.menu === menu) this.closeTakeMenu();
      else this.openTakesMenu({ row, more, menu });
    });
    menu.addEventListener('keydown', (e) => {
      // A locked Delete (its line is saving) is skipped.
      const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeTakeMenu({ focus: true });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Tab') {
        this.closeTakeMenu();
      }
    });
  }

  /** "Take 4 · Saving… cleaning up noise" while the take uploads and is cleaned. */
  savingTakeRow(saving) {
    const row = takeEl('div', 'take-row is-pending');
    row.appendChild(takeEl('span', 'take-pending-spin spinning')).setAttribute('aria-hidden', 'true');
    row.appendChild(takeEl('span', 'take-pending-text',
      `Take ${saving.number} · ${saving.noiseReduction ? 'Saving… cleaning up noise' : 'Saving…'}`));
    return row;
  }

  /** "Take · waiting to upload | Retry | ⋯ (Discard take)" for a take whose upload failed. */
  waitingTakeRow(entry, { locked }) {
    const row = takeEl('div', 'take-row is-pending is-waiting');
    row.appendChild(takeEl('span', 'take-pending-text', 'Take · waiting to upload'));
    const retry = row.appendChild(takeEl('button', 'btn btn-secondary btn-xs take-retry', 'Retry'));
    retry.type = 'button';
    retry.dataset.tip = 'Uploads it now. It also tries again by itself when you\'re back online.';
    retry.disabled = locked;
    retry.addEventListener('click', () => this.retryWaitingTake(entry));
    this.appendTakeMenu(row, 'Take waiting to upload', [
      { label: 'Discard take', onClick: () => this.discardWaitingTake(entry) },
    ]);
    return row;
  }

  /** "Take 3 deleted · Undo", until the delete goes out. */
  deletedTakeRow(take) {
    const row = takeEl('div', 'take-row is-deleted');
    row.dataset.takeId = take.take_id;
    row.appendChild(takeEl('span', 'take-deleted-text', `Take ${take.number} deleted`));
    row.appendChild(takeEl('span', 'take-deleted-dot', '·')).setAttribute('aria-hidden', 'true');
    const undo = row.appendChild(takeEl('button', 'btn btn-secondary btn-xs take-undo', 'Undo'));
    undo.type = 'button';
    undo.setAttribute('aria-label', `Undo deleting take ${take.number}`);
    undo.addEventListener('click', () => this.undoDeleteTake());
    return row;
  }

  openTakesMenu(open) {
    this.closeTakeMenu();
    open.menu.hidden = false;
    open.more.setAttribute('aria-expanded', 'true');
    this.openTakeMenu = open;
    open.menu.querySelector('[role="menuitem"]')?.focus();
  }

  closeTakeMenu({ focus = false } = {}) {
    const open = this.openTakeMenu;
    if (!open) return;
    this.openTakeMenu = null;
    open.menu.hidden = true;
    open.more.setAttribute('aria-expanded', 'false');
    if (focus) open.more.focus();
  }

  focusTakeRadio(radio) {
    if (!radio) return;
    this.takesList.querySelectorAll('[role="radio"]').forEach((r) => { r.tabIndex = -1; });
    radio.tabIndex = 0;
    radio.focus();
  }

  /** T: the take in the dub (or the newest take) takes the keyboard focus. All effects
   *  hides the card, so it closes first. */
  focusPickedTake() {
    if (!this.takesList) return;
    this.toggleAllEffects(false, { focus: false });
    const radios = [...this.takesList.querySelectorAll('[role="radio"]')];
    this.focusTakeRadio(radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0]);
  }

  /** Inside the card: ↑/↓ move, P plays, Enter uses, Delete (Backspace on a Mac) deletes
   *  (with Undo). */
  onTakesKeydown(e) {
    const radio = e.target.closest?.('[role="radio"]');
    if (!radio || e.ctrlKey || e.metaKey || e.altKey) return;
    const take = this.currentLineTake(radio.closest('.take-row')?.dataset.takeId);
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const mine = !!line && this.canRecordLine(line);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const radios = [...this.takesList.querySelectorAll('[role="radio"]')];
      const i = radios.indexOf(radio) + (e.key === 'ArrowDown' ? 1 : -1);
      this.focusTakeRadio(radios[Math.max(0, Math.min(radios.length - 1, i))]);
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      if (take) this.playHistoryTake(take, radio.closest('.take-row')?.querySelector('.take-play'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (take && mine && radio.getAttribute('aria-checked') !== 'true') this.pickTake(take);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (take && mine) this.deleteTake(take);
    }
  }

  /** Deletes a take of the current line after a 6 s in-place Undo. The DELETE goes out
   *  when the time is up, at once on a line change, on leaving the booth or on pagehide. */
  deleteTake(take) {
    if (!this.roomState) return;
    const line = this.roomState.pack.lines[this.currentLineIndex];
    if (!line || !take || !this.canRecordLine(line) || this.savingTake(line)) return;
    this.flushPendingDelete();
    this.pendingDelete = {
      roomId: this.roomState.room_id,
      lineId: line.line_id,
      takeId: take.take_id,
      url: `/api/rooms/${this.roomState.room_id}/lines/${line.line_id}/takes/${take.take_id}?user_id=${encodeURIComponent(this.user.id)}`,
      timer: setTimeout(() => this.flushPendingDelete(), UNDO_MS),
    };
    announce(`Take ${take.number} deleted`);
    this.renderTakesCard();
    this.renderTimelineChips();
  }

  undoDeleteTake() {
    if (!this.pendingDelete) return;
    clearTimeout(this.pendingDelete.timer);
    this.pendingDelete = null;
    this.renderTakesCard();
    this.renderTimelineChips();
  }

  /** Sends the waiting delete now, if there is one. */
  flushPendingDelete({ keepalive = false } = {}) {
    const p = this.pendingDelete;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingDelete = null;
    this.sendTakeDelete(p, keepalive);
  }

  async sendTakeDelete(p, keepalive) {
    let data;
    try {
      const res = await fetch(p.url, { method: 'DELETE', keepalive });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      if (this.roomState?.room_id !== p.roomId) return;
      this.showToast(this.friendlyError(err, "That take wasn't deleted. Try again."));
      this.renderTakesCard();
      return;
    }
    if (this.roomState?.room_id !== p.roomId) return;
    const lines = this.roomState.pack.lines;
    const lineIndex = lines.findIndex((l) => l.line_id === p.lineId);
    const line = lines[lineIndex];
    const before = pickedTake(this.roomState.takes, line)?.take_id;
    this.audio.evictTakeCache(lineTakes(this.roomState.takes, line).find((t) => t.take_id === p.takeId));
    if (data.line) this.roomState.takes[p.lineId] = data.line;
    else delete this.roomState.takes[p.lineId];
    this.renderTimelineChips();
    if (lineIndex !== this.currentLineIndex) return;
    // A changed take in the dub redraws the booth, unless a take is being recorded.
    const busy = this.recordState === 'countdown' || this.recordState === 'recording';
    if (pickedTake(this.roomState.takes, line)?.take_id !== before && !busy) this.loadBoothLine(lineIndex);
    else this.renderTakesCard();
  }
}
