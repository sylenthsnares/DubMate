// studio/update_notice.js - Where to get DubMate 2.0 when this engine lacks what only its
// installer brings (voice effects, the stronger cleanup): an in-app update from 1.1.3 can't
// add them (documentation/design/v2-update-path.md, section 2). "Open download page" asks the
// desktop app to open the releases page (open_download_page in external.rs) and is a plain
// link in a browser. A desktop app older than 2.0 can't open it, so there the button is
// "Copy download link". The premiere tells the host once; the room check row says it too.
// externalLinkControl is the same control for About's links (studio/about.js).
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { safeStorageGet, safeStorageSet } from './audio_setup.js';

export const DOWNLOAD_PAGE_URL = 'https://github.com/sylenthsnares/DubMate/releases/latest';
export const DOWNLOAD_PAGE_LABEL = 'github.com/sylenthsnares/DubMate/releases';
const OPEN_LABEL = 'Open download page';
const COPY_LABEL = 'Copy download link';

// localStorage: "<engine version>|<missing parts>" of the notice the host dismissed.
const UPDATE_NOTICE_KEY = 'dubmate_update_notice';

/**
 * The premiere notice's first clause and the rest, and whether it offers the download page,
 * or null when nothing it knows is missing. A source install (not `bundled`) gets voice
 * effects by running its update script again; it never has the stronger cleanup to miss.
 */
export function updateNoticeCopy(missing, bundled = true) {
  const effects = missing.includes('voice_effects');
  const cleanup = missing.includes('strong_cleanup');
  if (effects) {
    const lead = 'This DubMate saves videos, stems and projects without voice effects.';
    if (!bundled) return { lead, rest: ' Run update.bat or update.sh again to add them.', download: false };
    return {
      lead,
      rest: ` Run the DubMate 2.0 installer from ${DOWNLOAD_PAGE_LABEL} to add them${cleanup ? ' and stronger noise cleanup' : ''}.`,
      download: true,
    };
  }
  if (cleanup) return { lead: 'For stronger noise cleanup,', rest: ` run the DubMate 2.0 installer from ${DOWNLOAD_PAGE_LABEL}.`, download: true };
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
   * A link out of DubMate (a page on GitHub). In a browser, a link that opens a new tab. In
   * the desktop app, on this computer's engine, a button that asks the app to open it:
   * open_dubmate_page with the page's name, or open_download_page when there is no page.
   * An app older than 2.0 refuses (noteOlderDesktopApp), so there the button copies the
   * address and says so beside it (or shows the address when the copy fails too).
   */
  externalLinkControl({ url, label, page = null, copyLabel = `Copy ${label.toLowerCase()} link` }) {
    const wrap = document.createElement('span');
    wrap.className = 'external-link-control';
    const hint = document.createElement('span');
    hint.className = 'external-link-hint';
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    const invoke = this.desktopInvoke();
    let control;
    if (invoke) {
      control = document.createElement('button');
      control.type = 'button';
      control.className = 'btn btn-secondary btn-sm external-link-button';
      control.dataset.copyLabel = copyLabel;
      control.textContent = this.olderDesktopApp ? copyLabel : label;
      control.addEventListener('click', async () => {
        if (!this.olderDesktopApp) {
          try {
            await (page ? invoke('open_dubmate_page', { page }) : invoke('open_download_page'));
            hint.hidden = true;
            return;
          } catch (err) {
            console.warn('[DubMate] The app could not open the page:', err);
            this.noteOlderDesktopApp();
          }
        }
        try {
          await navigator.clipboard.writeText(url);
          hint.textContent = 'Link copied. Paste it into your browser.';
          hint.classList.remove('is-address');
        } catch (e) {
          hint.textContent = url;
          hint.classList.add('is-address');
        }
        hint.hidden = false;
      });
    } else {
      control = document.createElement('a');
      control.className = 'btn btn-secondary btn-sm';
      control.href = url;
      control.target = '_blank';
      control.rel = 'noopener noreferrer';
      control.textContent = label;
      control.setAttribute('aria-label', `${label} (opens in a new tab)`);
    }
    control.setAttribute('data-tip', url);
    wrap.append(control, hint);
    return wrap;
  }

  /** "Open download page", or "Copy download link" in a desktop app older than 2.0. */
  downloadPageControl() {
    const wrap = this.externalLinkControl({ url: DOWNLOAD_PAGE_URL, label: OPEN_LABEL, copyLabel: COPY_LABEL });
    wrap.classList.add('download-page-control');
    wrap.querySelector('.external-link-hint').classList.add('download-page-hint');
    return wrap;
  }

  /**
   * The desktop app is older than 2.0: it refused a command the 2.0 app allows this page
   * (get_packbuilder_install at boot, or opening a page). It can't open pages, so every
   * link button copies the address instead, and says so.
   */
  noteOlderDesktopApp() {
    this.olderDesktopApp = true;
    for (const btn of document.querySelectorAll('.external-link-button')) btn.textContent = btn.dataset.copyLabel;
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
    const copy = this.isHost() ? updateNoticeCopy(missing, this.roomState?.engine_bundled !== false) : null;
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
        // Focus moves on to Mix, the next control, instead of dropping to the page.
        const hadFocus = notice.contains(document.activeElement);
        notice.hidden = true;
        safeStorageSet(noticeStorage(), UPDATE_NOTICE_KEY, notice.dataset.key);
        if (hadFocus) document.querySelector('#screening-mix > summary')?.focus();
      });
      actions.append(gotIt);
    }
    const download = actions.querySelector('.download-page-control');
    if (copy.download && !download) actions.prepend(this.downloadPageControl());
    else if (!copy.download && download) download.remove();
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
