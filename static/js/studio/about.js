// studio/about.js - About DubMate (documentation/design/v2-notices.md, section 4): the version,
// the licence, links to the source and the notices, what is private, and where this computer
// keeps your data. The folders come from GET /api/data-folders, which only answers this
// computer's own page; someone else's room never asks, so a guest never sees the host's paths.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { openDialog, isDialogOpen } from '../ui_common.js';

const REPO_URL = 'https://github.com/sylenthsnares/DubMate';

// The same pages as open_dubmate_page in tauri/src-tauri/src/external.rs.
export const ABOUT_LINKS = [
  { page: 'source', label: 'Source code', url: REPO_URL },
  { page: 'licence', label: 'Licence', url: `${REPO_URL}/blob/main/LICENSE` },
  { page: 'notices', label: 'Third-party notices', url: `${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md` },
  { page: 'privacy', label: 'Privacy', url: `${REPO_URL}/blob/main/PRIVACY.md` },
  { page: 'security', label: 'Security', url: `${REPO_URL}/blob/main/SECURITY.md` },
];

export class AboutMethods {
  initAbout() {
    document.getElementById('btn-close-about')?.addEventListener('click', () => this.closeAbout?.());
  }

  /** Opens About; focus goes back to returnFocus when it closes. */
  openAbout(returnFocus = document.activeElement) {
    const overlay = document.getElementById('modal-about');
    // Not on the join card or You left without a DubMate of your own: the logo menu and ? are off there.
    if (!overlay || isDialogOpen() || document.body.classList.contains('no-home-chrome')) return;
    document.getElementById('about-links').replaceChildren(...ABOUT_LINKS.map((link) => this.externalLinkControl(link)));
    this.renderAboutVersion();
    this.renderAboutFolders();
    this.closeAbout = openDialog(overlay, { returnFocus });
  }

  /** "Version X" here, "This room runs DubMate X" in someone else's room; hidden when /health can't say. */
  renderAboutVersion() {
    const line = document.getElementById('about-version');
    line.hidden = true;
    this.loadEngineHealth().then(() => {
      const version = this.engineHealth?.version;
      if (!version) return;
      line.textContent = this.isEngineLocal() ? `Version ${version}` : `This room runs DubMate ${version}`;
      line.hidden = false;
    });
  }

  async renderAboutFolders() {
    const list = document.getElementById('about-folders');
    const error = document.getElementById('about-folders-error');
    const note = document.getElementById('about-folders-note');
    const local = this.isEngineLocal();
    list.replaceChildren();
    error.hidden = true;
    note.hidden = true;
    document.getElementById('about-guest-data').hidden = local;
    document.getElementById('about-takes-own').hidden = !local;
    document.getElementById('about-takes-guest').hidden = local;
    if (!local) return;
    const token = (this.aboutFoldersToken = (this.aboutFoldersToken || 0) + 1);
    let folders = null;
    try {
      const res = await fetch('/api/data-folders', { headers: { 'Accept': 'application/json' } });
      if (res.ok) folders = (await res.json())?.folders;
    } catch (e) { }
    if (token !== this.aboutFoldersToken) return;
    if (!Array.isArray(folders)) {
      error.hidden = false;
      return;
    }
    list.replaceChildren(...folders.map((folder) => this.aboutFolderRow(folder)));
    note.hidden = false;
  }

  /**
   * One folder: its name, its path as selectable text, Open folder (or "Not created yet"),
   * and "May hold other files" when it isn't DubMate's own (a folder you chose).
   */
  aboutFolderRow(folder) {
    const row = document.createElement('li');
    row.className = 'about-folder';
    const label = document.createElement('span');
    label.className = 'about-folder-label';
    label.textContent = folder.label;
    const path = document.createElement('span');
    path.className = 'about-folder-path';
    path.textContent = folder.path;
    const error = document.createElement('p');
    error.className = 'about-folder-error';
    error.setAttribute('role', 'status');
    error.hidden = true;
    let action;
    if (folder.exists) {
      action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn-secondary btn-xs';
      action.textContent = 'Open folder';
      action.addEventListener('click', () => this.openDataFolder(folder.key, error));
    } else {
      action = document.createElement('span');
      action.className = 'about-folder-missing';
      action.textContent = 'Not created yet';
    }
    row.append(label, action, path);
    if (!folder.own) {
      const shared = document.createElement('span');
      shared.className = 'about-folder-shared';
      shared.textContent = 'May hold other files';
      row.append(shared);
    }
    row.append(error);
    return row;
  }

  /** Asks the engine to open one folder by its key; a failure says why under the row. */
  async openDataFolder(key, error) {
    let detail = '';
    try {
      const res = await fetch('/api/data-folders/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        error.hidden = true;
        return;
      }
      detail = (await res.json().catch(() => null))?.detail;
    } catch (e) { }
    error.textContent = typeof detail === 'string' && detail ? detail : "Couldn't open the folder.";
    error.hidden = false;
  }
}
