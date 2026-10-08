// studio/update_notice.js - Where to get DubMate 2.0 when this engine lacks what only its
// installer brings (voice effects, the stronger cleanup): an in-app update from 1.1.3 can't
// add them (documentation/design/v2-update-path.md, section 2). "Open download page" asks the
// desktop app to open the releases page (open_download_page in external.rs) and is a plain
// link in a browser. The premiere tells the host once; the room check row says it too.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { safeStorageGet, safeStorageSet } from './audio_setup.js';

export const DOWNLOAD_PAGE_URL = 'https://github.com/sylenthsnares/DubMate/releases/latest';
export const DOWNLOAD_PAGE_LABEL = 'github.com/sylenthsnares/DubMate/releases';

// localStorage: "<engine version>|<missing parts>" of the notice the host dismissed.
const UPDATE_NOTICE_KEY = 'dubmate_update_notice';

/** The premiere notice's first clause and the rest, or null when nothing it knows is missing. */
export function updateNoticeCopy(missing) {
  const effects = missing.includes('voice_effects');
  const cleanup = missing.includes('strong_cleanup');
  if (effects) {
    return {
      lead: 'This DubMate saves videos, stems and projects without voice effects.',
      rest: ` Install DubMate 2.0 from ${DOWNLOAD_PAGE_LABEL} to add them${cleanup ? ' and stronger noise cleanup' : ''}.`,
    };
  }
  if (cleanup) return { lead: 'Install DubMate 2.0', rest: ` from ${DOWNLOAD_PAGE_LABEL} for stronger noise cleanup.` };
  return null;
}

/** What a dismissed notice is stored as: it comes back for another version or another set. */
export function updateNoticeKey(version, missing) {
  return `${version || ''}|${missing.join(',')}`;
}

function noticeStorage() {
  try {
    return window.localStorage || null;
  } catch (e) {
    return null;
  }
}

export class UpdateNoticeMethods {
  /**
   * "Open download page". In the desktop app, on this computer's engine, a button that asks
   * the app to open the page; an app older than 2.0 refuses, so it copies the address and
   * says so beside it (or shows the address when the copy fails too). Elsewhere a link.
   */
  downloadPageControl() {
    const wrap = document.createElement('span');
    wrap.className = 'download-page-control';
    const hint = document.createElement('span');
    hint.className = 'download-page-hint';
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    const invoke = this.desktopInvoke();
    let control;
    if (invoke) {
      control = document.createElement('button');
      control.type = 'button';
      control.addEventListener('click', async () => {
        try {
          await invoke('open_download_page');
          hint.hidden = true;
        } catch (err) {
          console.warn('[DubMate] The app could not open the download page:', err);
          try {
            await navigator.clipboard.writeText(DOWNLOAD_PAGE_URL);
            hint.textContent = 'Link copied. Paste it into your browser.';
            hint.classList.remove('is-address');
          } catch (e) {
            hint.textContent = DOWNLOAD_PAGE_URL;
            hint.classList.add('is-address');
          }
          hint.hidden = false;
        }
      });
    } else {
      control = document.createElement('a');
      control.href = DOWNLOAD_PAGE_URL;
      control.target = '_blank';
      control.rel = 'noopener noreferrer';
    }
    control.className = 'btn btn-secondary btn-sm';
    control.textContent = 'Open download page';
    control.setAttribute('data-tip', DOWNLOAD_PAGE_URL);
    wrap.append(control, hint);
    return wrap;
  }

  /** Reads this engine's version and missing parts from /health once (the same answer the lobby reads). */
  loadEngineHealth() {
    if (!this.engineHealthLoad) {
      this.engineHealthLoad = fetch('/health', { headers: { 'Accept': 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((data) => {
          this.engineHealth = {
            version: typeof data?.version === 'string' ? data.version : '',
            missing: Array.isArray(data?.missing) ? data.missing : [],
          };
        });
    }
    return this.engineHealthLoad;
  }

  /** The premiere's notice: the host's, until Got it for this engine version and missing set. */
  renderUpdateNotice() {
    const notice = document.getElementById('screening-update-notice');
    if (!notice) return;
    const missing = this.roomState?.engine_missing || [];
    const copy = this.isHost() ? updateNoticeCopy(missing) : null;
    if (!copy || !this.engineHealth) {
      notice.hidden = true;
      if (copy) this.loadEngineHealth().then(() => this.renderUpdateNotice());
      return;
    }
    const key = updateNoticeKey(this.engineHealth.version, missing);
    if (safeStorageGet(noticeStorage(), UPDATE_NOTICE_KEY) === key) {
      notice.hidden = true;
      return;
    }
    const text = notice.querySelector('.update-notice-text');
    const lead = document.createElement('span');
    lead.className = 'update-notice-lead';
    lead.textContent = copy.lead;
    text.replaceChildren(lead, copy.rest);
    const actions = notice.querySelector('.update-notice-actions');
    if (!actions.firstChild) {
      const gotIt = document.createElement('button');
      gotIt.type = 'button';
      gotIt.className = 'btn btn-ghost btn-sm';
      gotIt.textContent = 'Got it';
      gotIt.addEventListener('click', () => {
        notice.hidden = true;
        safeStorageSet(noticeStorage(), UPDATE_NOTICE_KEY, notice.dataset.key);
      });
      actions.append(this.downloadPageControl(), gotIt);
    }
    notice.dataset.key = key;
    notice.hidden = false;
  }

  /** Audio settings' Room row: the stronger cleanup needs the installer (this computer's engine only). */
  renderRoomCheckCleanupNote() {
    const note = document.getElementById('room-check-cleanup-note');
    if (!note) return;
    const local = this.isEngineLocal();
    let missing = this.roomState ? (this.roomState.engine_missing || []) : this.engineHealth?.missing;
    if (!missing) {
      missing = [];
      if (local) this.loadEngineHealth().then(() => this.renderRoomCheckCleanupNote());
    }
    const show = local && missing.includes('strong_cleanup');
    note.hidden = !show;
    if (show && !note.firstChild) note.append('Stronger cleanup needs the DubMate 2.0 installer.', this.downloadPageControl());
  }
}
