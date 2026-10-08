// studio/packs.js - Pack library on the home screen: listing, search, pack cards,
// import, rescan and the packs folder setting.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { escapeHtml, openDialog, joinLocalPath, plural } from '../ui_common.js';

export class PackMethods {
  /**
   * Select a pack on the landing grid and scroll to it, the same as clicking its
   * card. Pack Builder sends the user here with ?select_pack= after a build; if
   * that pack is not in the list yet, rescan once before giving up.
   */
  async selectPack(packId) {
    const isListed = () => (this.packs || []).some((p) => p.id === packId);
    if (!isListed()) {
      await this.rescanPacksDirectory(true);
    }
    if (!isListed() || !this.packGrid) return;
    this.selectedPackId = packId;
    this.renderPacks();
    const card = Array.from(this.packGrid.querySelectorAll('.pack-card'))
      .find((c) => c.dataset.packId === packId);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // --- Packs & Landing Logic ---

  renderSkeletonPacks() {
    if (!this.packGrid) return;
    if (this.packCountBadge) this.packCountBadge.textContent = 'Looking…';
    this.packGrid.innerHTML = `
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
    `;
  }

  async fetchPacks() {
    // The packs folder is on the engine's computer: only its own user may choose it.
    if (this.btnOpenPackFolder && !this.isEngineLocal()) this.btnOpenPackFolder.style.display = 'none';
    if (!this.packs || this.packs.length === 0) {
      this.renderSkeletonPacks();
    }
    try {
      const res = await fetch('/api/packs?t=' + Date.now());
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.packs = await res.json();
      console.log(`[DubMate] Successfully loaded ${this.packs.length} scene packs:`, this.packs.map(p => p.name || p.title));

      if (!this.packs || this.packs.length === 0) {
        // Cold start auto-rescan if server just started with 0 indexed packs
        await this.rescanPacksDirectory(true);
      } else {
        this.renderPacks();
      }
    } catch (err) {
      console.error("Error fetching packs:", err);
      if (this.packGrid) {
        this.packGrid.innerHTML = `
          <div style="color: var(--foreground-muted); padding: 32px 24px; text-align: center; grid-column: 1 / -1;">
            <p style="margin-bottom: 8px; font-weight: 600; color: #fca5a5;">Can't reach DubMate</p>
            <p style="font-size: 12px; color: var(--foreground-muted); max-width: 440px; margin: 0 auto 16px;">
              Make sure DubMate is still running, then retry.
            </p>
            <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.fetchPacks()">Retry</button>
              ${this.isEngineLocal() ? '<button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">Packs folder</button>' : ''}
            </div>
          </div>
        `;
      }
    }
  }

  /** Plain GET /api/config: parsed body, or null on a non-2xx answer. Throws on network errors. */
  async fetchConfig() {
    const res = await fetch('/api/config');
    return res.ok ? res.json() : null;
  }

  async openPackConfigModal() {
    if (!this.modalPackConfig || !this.isEngineLocal() || !this.modalPackConfig.hidden) return;
    if (this.webConfigFeedback) this.webConfigFeedback.style.display = 'none';
    // From the ⋯ menu (closed by now) focus goes back to its button.
    const from = document.activeElement;
    const returnFocus = this.sceneMenu?.contains(from) ? this.btnSceneMenu : from;
    this._closePackConfig = openDialog(this.modalPackConfig, { returnFocus });

    try {
      const data = await this.fetchConfig();
      if (data) {
        if (this.webInputPackPath) {
          this.webInputPackPath.value = data.packs_dir || '';
        }
        if (this.webConfigActiveCount) {
          this.webConfigActiveCount.innerText = `${data.pack_count || 0} packs`;
        }
      }
    } catch (err) {
      console.warn("Could not fetch active packs config:", err);
    }

    if (this.webInputPackPath && !this.modalPackConfig.hidden) this.webInputPackPath.focus();
  }

  closePackConfigModal() {
    if (this._closePackConfig) this._closePackConfig();
    this._closePackConfig = null;
  }

  /** The ⋯ menu beside Make a scene: Import, Packs folder and Rescan. */
  initSceneMenu() {
    const button = this.btnSceneMenu;
    const menu = this.sceneMenu;
    if (!button || !menu) return;
    const items = () => Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((el) => el.style.display !== 'none');
    const show = (open, { focus = true } = {}) => {
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) items()[0]?.focus();
      else if (focus) button.focus();
    };
    button.addEventListener('click', () => show(menu.hidden));
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && menu.hidden) {
        e.preventDefault();
        show(true);
      }
    });
    menu.addEventListener('keydown', (e) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      const moves = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
      if (e.key in moves) {
        e.preventDefault();
        list[(moves[e.key] + list.length) % list.length]?.focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        show(false, { focus: e.key === 'Escape' });
      }
    });
    // Choosing an item closes the menu first (its own handler then runs).
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[role="menuitem"]')) show(false, { focus: false });
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) show(false, { focus: false });
    });
  }

  async savePackConfig() {
    const rawPath = this.webInputPackPath ? this.webInputPackPath.value.trim() : '';
    if (!rawPath) {
      this.showWebConfigFeedback("Enter a folder path.", false);
      return;
    }

    if (this.btnSavePackConfig) {
      this.btnSavePackConfig.disabled = true;
      const textSpan = document.getElementById('web-save-config-text');
      if (textSpan) textSpan.innerText = 'Saving…';
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs_dir: rawPath })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || data.message || "Couldn't save that folder.");
      }

      this.packs = data.packs || [];
      this.renderPacks();
      this.showWebConfigFeedback(data.message || `Loaded ${data.pack_count} packs.`, true);
      this.showToast(data.message || `Loaded ${data.pack_count} packs.`);

      if (this.webConfigActiveCount) {
        this.webConfigActiveCount.innerText = `${data.pack_count || 0} packs`;
      }

      setTimeout(() => {
        this.closePackConfigModal();
      }, 1200);
    } catch (err) {
      // Server details (bad path, unreadable folder) are shown as-is.
      let errMsg = err.message || "Couldn't save that folder.";
      if (errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError")) {
        errMsg = this.friendlyError(err);
      }
      this.showWebConfigFeedback(errMsg, false);
    } finally {
      if (this.btnSavePackConfig) {
        this.btnSavePackConfig.disabled = false;
        const textSpan = document.getElementById('web-save-config-text');
        if (textSpan) textSpan.innerText = 'Save';
      }
    }
  }

  showWebConfigFeedback(msg, isSuccess) {
    if (!this.webConfigFeedback) return;
    this.webConfigFeedback.style.display = 'block';
    this.webConfigFeedback.style.background = isSuccess ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
    this.webConfigFeedback.style.border = isSuccess ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)';
    this.webConfigFeedback.style.color = isSuccess ? '#6ee7b7' : '#fca5a5';
    this.webConfigFeedback.innerText = msg;
  }

  async rescanPacksDirectory(silent = false) {
    if (this.isRescanningPacks) return;
    this.isRescanningPacks = true;

    const icon = this.btnRescanPacks?.querySelector('svg');
    if (icon) icon.classList.add('spinning');
    if (this.btnRescanPacks) {
      this.btnRescanPacks.disabled = true;
      const textSpan = this.btnRescanPacks.querySelector('span');
      if (textSpan) textSpan.innerText = 'Scanning…';
    }
    if (this.packCountBadge) this.packCountBadge.textContent = 'Looking…';

    try {
      const res = await fetch('/api/packs/rescan?t=' + Date.now(), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.packs = data.packs || [];
      console.log(`[DubMate] Rescan complete. Loaded ${this.packs.length} packs.`);
      this.renderPacks();
      const count = (this.packs || []).length;
      if (!silent) {
        this.showToast(`Found ${plural(count, 'scene')}`);
      }
    } catch (err) {
      console.error("Error during pack rescan:", err);
      if (!silent) {
        this.showToast(this.friendlyError(err, "Couldn't rescan your packs folder."));
      }
    } finally {
      this.isRescanningPacks = false;
      if (icon) icon.classList.remove('spinning');
      if (this.btnRescanPacks) {
        this.btnRescanPacks.disabled = false;
        const textSpan = this.btnRescanPacks.querySelector('span');
        if (textSpan) textSpan.innerText = 'Rescan';
      }
    }
  }

  async uploadPackZip(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      this.showToast("Choose a .zip file.");
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      this.showToast("That file is over the 500 MB limit.");
      return;
    }

    const btn = this.btnImportPack;
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinning" style="display:inline-block;">⚙️</span> <span>Importing…</span>`;
    }

    this.showToast(`Importing "${file.name}"…`);
    if (this.modalImportLoading) {
      const statusText = document.getElementById('import-modal-status-text');
      if (statusText) {
        statusText.innerText = "Checking the file…";
      }
      this.modalImportLoading.style.display = 'flex';
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/packs/import', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const importedPack = data.pack;

      await this.fetchPacks();

      if (importedPack && importedPack.id) {
        this.selectedPackId = importedPack.id;
        this.renderPacks();
        const card = document.querySelector(`.pack-card[data-pack-id="${importedPack.id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      this.showToast(`Imported "${importedPack?.name || file.name}"`);
    } catch (err) {
      console.error("Pack import error:", err);
      this.showToast(this.friendlyError(err, "Couldn't import that pack. Check the file and try again."));
    } finally {
      if (this.modalImportLoading) {
        this.modalImportLoading.style.display = 'none';
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
      if (this.inputPackZip) {
        this.inputPackZip.value = '';
      }
    }
  }

  handlePackSearch(query) {
    this.packSearchQuery = (query || '').trim().toLowerCase();
    if (this.btnClearSearch) {
      this.btnClearSearch.style.display = this.packSearchQuery ? 'inline-flex' : 'none';
    }
    this.renderPacks();
  }

  clearPackSearch() {
    this.packSearchQuery = '';
    if (this.inputPackSearch) {
      this.inputPackSearch.value = '';
    }
    if (this.btnClearSearch) {
      this.btnClearSearch.style.display = 'none';
    }
    this.renderPacks();
    if (this.inputPackSearch) {
      this.inputPackSearch.focus();
    }
  }

  highlightMatch(text, query) {
    const safeText = escapeHtml(text ?? '');
    if (!query) return safeText;
    const safeQuery = escapeHtml(query);
    const escapedQuery = safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedQuery) return safeText;
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return safeText.replace(regex, '<span class="search-highlight">$1</span>');
  }

  renderPacks() {
    if (!this.packGrid) return;
    this.packGrid.innerHTML = '';

    const allPacks = this.packs || [];
    const query = this.packSearchQuery;

    if (!allPacks.length) {
      this.renderSceneBar();
      if (this.packCountBadge) {
        this.packCountBadge.textContent = '0 scenes';
      }
      const local = this.isEngineLocal();
      this.packGrid.innerHTML = `
        <div class="empty-packs-guide glass-card" style="grid-column: 1 / -1; padding: 36px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <h3 style="font-size: 17px; font-weight: 700; margin-bottom: 8px; color: var(--foreground);">No scene packs yet</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 500px; margin: 0 auto 18px; line-height: 1.6;">
            ${local ? 'Choose your packs folder, import' : 'Import'} a pack .zip, or make one in Pack Builder.
          </p>
          <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
            ${local ? '<button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">Choose folder</button>' : ''}
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('input-pack-zip').click()">Import pack</button>
            <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.rescanPacksDirectory()">↺ Rescan</button>
          </div>
        </div>
      `;
      return;
    }

    const filteredPacks = !query ? allPacks : allPacks.filter(pack => {
      const title = (pack.title || pack.name || pack.id || '').toLowerCase();
      const subtitle = (pack.subtitle || '').toLowerCase();
      const authors = (pack.authors || []).join(' ').toLowerCase();
      const id = (pack.id || '').toLowerCase();
      const chars = (pack.characters || []).join(' ').toLowerCase();
      const linesText = (pack.lines || []).map(l => (l.caption || l.raw_caption || l.text || '') + ' ' + (l.character || '')).join(' ').toLowerCase();
      return title.includes(query) || subtitle.includes(query) || authors.includes(query) || id.includes(query) || chars.includes(query) || linesText.includes(query);
    });

    if (this.packCountBadge) {
      if (query) {
        this.packCountBadge.textContent = `${filteredPacks.length} of ${plural(allPacks.length, 'scene')}`;
      } else {
        this.packCountBadge.textContent = plural(allPacks.length, 'scene');
      }
    }

    if (!filteredPacks.length) {
      const safeQuery = escapeHtml(query);
      this.packGrid.innerHTML = `
        <div class="empty-search-state glass-card" style="grid-column: 1 / -1; padding: 32px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px; color: var(--foreground);">No scenes match "${safeQuery}"</h3>
          <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.clearPackSearch()">Clear search</button>
        </div>
      `;
      this.renderSceneBar();
      return;
    }

    // One tab stop: the chosen card, else the first one shown.
    const tabStop = filteredPacks.some((p) => p.id === this.selectedPackId) ? this.selectedPackId : filteredPacks[0].id;

    filteredPacks.forEach((pack) => {
      const card = document.createElement('div');
      const isSelected = (this.selectedPackId === pack.id);
      card.className = `pack-card ${isSelected ? 'selected' : ''}`;
      card.dataset.packId = pack.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(isSelected));
      card.tabIndex = pack.id === tabStop ? 0 : -1;

      const rawTitle = pack.title || pack.name || pack.id;
      const displayTitle = this.highlightMatch(rawTitle, query);
      const duration = Math.round(pack.duration || (pack.lines && pack.lines.length ? pack.lines[pack.lines.length - 1].end : 0));
      const lineCount = pack.line_count || (pack.lines ? pack.lines.length : 0);
      const characters = pack.characters || [];

      const subtitleHtml = pack.subtitle ? `
        <div class="pack-card-subtitle" title="${escapeHtml(pack.subtitle)}">
          ${this.highlightMatch(pack.subtitle, query)}
        </div>
      ` : '';

      const authorsHtml = (pack.authors && pack.authors.length) ? `
        <span class="badge-author" title="Author: ${escapeHtml(pack.authors.join(', '))}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${pack.authors.map(a => this.highlightMatch(a, query)).join(', ')}
        </span>
      ` : '';

      const isCV = (pack.pack_type === 'choicer_voicer');
      const formatBadge = isCV
        ? `<span class="badge-format cv" data-tip="Choicer Voicer pack">CV Pack</span>`
        : `<span class="badge-format dubmate">DubMate</span>`;

      const thumbImg = (pack.has_icon && pack.icon_url)
        ? `<div class="pack-card-thumb"><img src="${escapeHtml(pack.icon_url)}" alt="${escapeHtml(rawTitle)} cover" loading="lazy"></div>`
        : `<div class="pack-card-thumb placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/></svg></div>`;

      // Check if a dialogue line matched query
      let matchedLineSnippet = '';
      if (query && pack.lines) {
        const foundLine = pack.lines.find(l => ((l.caption || '') + ' ' + (l.raw_caption || '') + ' ' + (l.text || '')).toLowerCase().includes(query));
        if (foundLine) {
          const charPrefix = foundLine.character ? `<strong>${escapeHtml(foundLine.character)}:</strong> ` : '';
          const cap = foundLine.caption || foundLine.raw_caption || foundLine.text || '';
          matchedLineSnippet = `
            <div style="font-size: 11px; color: var(--accent-brass); margin-top: 6px; font-style: italic; background: var(--input); padding: 4px 8px; border-radius: var(--radius-sm); border-left: 2px solid var(--primary);">
              ${charPrefix}"${this.highlightMatch(cap, query)}"
            </div>
          `;
        }
      }

      card.setAttribute('aria-label', rawTitle);
      card.innerHTML = `
        <div class="pack-card-top-row">
          ${thumbImg}
          <div class="pack-card-meta-col">
            <div class="pack-card-header">
              <div class="pack-card-title">${displayTitle}</div>
              <span class="pack-card-duration">${duration}s</span>
            </div>
            ${subtitleHtml}
            <div class="pack-card-badges-row">
              ${formatBadge}
              ${authorsHtml}
              <span class="pack-line-badge">${lineCount} lines</span>
              <a href="${escapeHtml(pack.export_url || `/api/packs/${encodeURIComponent(pack.id)}/export`)}" class="btn-pack-download-icon" data-tip="Save this scene as a file to send to a friend" aria-label="Share ${escapeHtml(rawTitle)}" download>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>Share</span>
              </a>
            </div>
          </div>
        </div>
        ${matchedLineSnippet}
        <div class="pack-card-characters">
          ${characters.map(c => `<span class="char-tag">${this.highlightMatch(c, query)}</span>`).join('')}
        </div>
      `;

      // Same bare-anchor problem as the export buttons: the webview navigated to
      // the export route, so a missing pack showed a JSON page instead of a toast.
      const packZipLink = card.querySelector('.btn-pack-download-icon');
      if (packZipLink) {
        packZipLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation(); // the card behind it is the "select this pack" target
          const safeName = (pack.name || pack.id || 'pack').replace(/[^a-zA-Z0-9_-]/g, '_');
          this.saveRemoteFile(packZipLink.getAttribute('href'), `${safeName}.zip`, {
            control: packZipLink,
            busyText: '…', // the button is a 10px icon; anything longer reflows the row
            startMessage: `Preparing "${rawTitle}"…`,
            doneMessage: `Downloaded "${rawTitle}". Send the file to a friend.`,
            errorText: "Couldn't download that pack. Try again.",
            // packs_api writes the ZIP into the export folder's packs/ subfolder.
            exportSubfolder: 'packs',
            onSaved: (res, dir) => this.openSharePack(res.headers.get('X-DubMate-File'), dir, packZipLink),
          });
        });
      }

      card.addEventListener('click', () => this.chooseScene(pack.id));
      card.addEventListener('keydown', (e) => this.onSceneCardKey(e, card));

      this.packGrid.appendChild(card);
    });
    this.renderSceneBar();
  }

  /** Chooses a scene: marks its card, moves the tab stop to it and updates the bar. */
  chooseScene(packId, { focus = false } = {}) {
    this.selectedPackId = packId;
    let chosen = null;
    this.packGrid?.querySelectorAll('.pack-card[role="radio"]').forEach((c) => {
      const on = c.dataset.packId === packId;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
      if (on) chosen = c;
    });
    if (focus && chosen) chosen.focus();
    this.renderSceneBar();
  }

  /** Arrows move and choose, Space chooses, Enter starts a room with the focused card. */
  onSceneCardKey(e, card) {
    if (e.target !== card) return; // the card's Share link keeps its own keys
    const cards = Array.from(this.packGrid.querySelectorAll('.pack-card[role="radio"]'));
    const at = cards.indexOf(card);
    const moves = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: cards.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      const next = cards[(moves[e.key] + cards.length) % cards.length];
      this.chooseScene(next.dataset.packId, { focus: true });
    } else if (e.key === ' ') {
      e.preventDefault();
      this.chooseScene(card.dataset.packId);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.chooseScene(card.dataset.packId);
      this.createRoom();
    }
  }

  /**
   * The pinned bar under the scenes: the chosen scene with its lines, characters and
   * length, and Start a room (disabled as "Pick a scene" until one is chosen). A scene
   * hidden by the search stays chosen and says so.
   */
  renderSceneBar() {
    const button = this.btnCreateRoom;
    const name = document.getElementById('scene-bar-name');
    const meta = document.getElementById('scene-bar-meta');
    const thumb = document.getElementById('scene-bar-thumb');
    if (!button || !name || !meta) return;
    const pack = (this.packs || []).find((p) => p.id === this.selectedPackId);
    if (!pack) {
      name.textContent = 'No scene chosen';
      meta.textContent = 'Choose one above, then start a room.';
      if (thumb) thumb.replaceChildren();
      button.disabled = true;
      button.textContent = 'Pick a scene';
      button.removeAttribute('aria-label');
      return;
    }
    const title = pack.title || pack.name || pack.id;
    const lines = pack.line_count || (pack.lines ? pack.lines.length : 0);
    const seconds = Math.round(pack.duration || (pack.lines && pack.lines.length ? pack.lines[pack.lines.length - 1].end : 0));
    const shown = !this.packGrid || Array.from(this.packGrid.querySelectorAll('.pack-card')).some((c) => c.dataset.packId === pack.id);
    name.textContent = title;
    meta.textContent = `${plural(lines, 'line')} · ${plural((pack.characters || []).length, 'character')} · ${seconds} s${shown ? '' : ' (hidden by search)'}`;
    if (thumb) {
      if (pack.has_icon && pack.icon_url) {
        const img = document.createElement('img');
        img.src = pack.icon_url;
        img.alt = '';
        thumb.replaceChildren(img);
      } else {
        thumb.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/></svg>';
      }
    }
    button.disabled = false;
    button.textContent = 'Start a room ›';
    button.setAttribute('aria-label', `Start a room with ${title}`);
  }

  /** Shows where the shared scene file was saved (engine's own computer only). */
  openSharePack(fileName, dir, returnFocus) {
    const overlay = document.getElementById('modal-share-pack');
    const input = document.getElementById('share-pack-path');
    if (!overlay || !input || !fileName || !dir) {
      this.showToast('Saved in your export folder.');
      return;
    }
    try { fileName = decodeURIComponent(fileName); } catch { /* sent as is */ }
    input.value = joinLocalPath(dir, 'packs', fileName);
    const close = openDialog(overlay, { returnFocus });
    const copyBtn = document.getElementById('btn-share-pack-copy');
    const doneBtn = document.getElementById('btn-share-pack-done');
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        this.showToast('Copied.');
      } catch {
        // No clipboard access: select it so the user can copy it themselves.
        input.focus();
        input.select();
      }
    };
    doneBtn.onclick = () => close();
  }
}
