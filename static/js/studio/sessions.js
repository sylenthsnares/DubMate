// sessions.js - "Continue where you left off": the host's recent sessions on the
// landing page (only on the engine's own computer), with Continue and Remove.
import { escapeHtml } from '../ui_common.js';

const BIN_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

export class SessionMethods {
  async loadRecentSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.renderRecentSessions(Array.isArray(data?.sessions) ? data.sessions : []);
    } catch (err) {
      console.warn('[Sessions] Could not load recent sessions:', err);
    }
  }

  renderRecentSessions(list) {
    const section = document.getElementById('recent-sessions');
    const listEl = document.getElementById('recent-sessions-list');
    if (!section || !listEl) return;
    const sessions = Array.isArray(list) ? list : [];
    listEl.innerHTML = sessions.map((s) => {
      const id = escapeHtml(s.room_id);
      const when = escapeHtml(this.relativeTime(s.last_active_at));
      const exact = escapeHtml(s.last_active_at ? new Date(s.last_active_at * 1000).toLocaleString() : '');
      const time = `<span data-tip="${exact}">${when}</span>`;
      if (s.readable === false) {
        return `<li class="recent-session-row" data-room-id="${id}">
          <div class="recent-session-info">
            <div class="recent-session-title">A session that couldn't be opened</div>
            <div class="recent-session-meta">${time}</div>
          </div>
          <div class="recent-session-actions">
            <button type="button" class="btn btn-ghost btn-sm btn-session-remove" aria-label="Remove this session" data-tip="Remove this session">${BIN_ICON}</button>
          </div>
        </li>`;
      }
      const title = escapeHtml(s.pack_name || s.pack_id || 'Untitled scene');
      const missing = s.pack_found === false;
      const counts = `${Number(s.recorded_lines) || 0} of ${Number(s.total_lines) || 0} lines recorded`;
      const meta = missing
        ? `This scene isn't in your library · ${time}`
        : `${counts} · ${time}`;
      const continueBtn = missing
        ? `<button type="button" class="btn btn-primary btn-sm btn-session-continue" disabled data-tip="Add the scene again to continue">Continue</button>`
        : `<button type="button" class="btn btn-primary btn-sm btn-session-continue">Continue</button>`;
      return `<li class="recent-session-row" data-room-id="${id}">
        <div class="recent-session-info">
          <div class="recent-session-title">${title}</div>
          <div class="recent-session-meta">${meta}</div>
        </div>
        <div class="recent-session-actions">
          ${continueBtn}
          <button type="button" class="btn btn-ghost btn-sm btn-session-remove" aria-label="Remove ${title}" data-tip="Remove this session">${BIN_ICON}</button>
        </div>
      </li>`;
    }).join('');
    listEl.querySelectorAll('.recent-session-row').forEach((row) => {
      const roomId = row.dataset.roomId;
      row.querySelector('.btn-session-continue')?.addEventListener('click', () => this.continueSession(roomId));
      row.querySelector('.btn-session-remove')?.addEventListener('click', () => this.removeSession(roomId));
    });
    section.hidden = sessions.length === 0;
  }

  /** "2 hours ago" style text for a Unix time in seconds. */
  relativeTime(ts) {
    const then = Number(ts) * 1000;
    if (!then) return '';
    const mins = Math.floor((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(then).toLocaleDateString();
  }

  async continueSession(roomId) {
    let data = null;
    let detail = '';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(roomId)}/open`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body && body.room_id && body.user_id) data = body;
      else detail = typeof body?.detail === 'string' ? body.detail : '';
    } catch (err) {
      console.warn('[Sessions] Continue failed:', err);
    }
    if (!data) {
      this.showToast(detail || "Couldn't open that session. Try again.");
      this.loadRecentSessions();
      return;
    }
    this.user.id = data.user_id;
    this.saveUser();
    await this.joinRoom(data.room_id);
  }

  async removeSession(roomId) {
    if (!confirm('Remove this session? Its takes are deleted. Videos you saved stay in your export folder.')) return;
    let res = null;
    try {
      res = await fetch(`/api/sessions/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('[Sessions] Remove failed:', err);
    }
    if (res && res.ok) {
      const section = document.getElementById('recent-sessions');
      const listEl = document.getElementById('recent-sessions-list');
      listEl?.querySelectorAll('.recent-session-row').forEach((row) => {
        if (row.dataset.roomId === roomId) row.remove();
      });
      if (section && listEl && !listEl.querySelector('.recent-session-row')) section.hidden = true;
      return;
    }
    this.showToast(res && res.status === 409
      ? 'Someone is still in this session.'
      : "Couldn't remove that session. Try again.");
  }
}
