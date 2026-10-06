// studio/packs.js - Pack library on the home screen: listing, search, pack cards,
// import, rescan and the packs folder setting.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { escapeHtml } from '../ui_common.js';

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
    if (this.packCountBadge) {
      this.packCountBadge.innerHTML = `<span class="spinning" style="display: inline-block; font-size: 10px;">⚙️</span> Scanning…`;
    }
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
              <button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">Packs folder</button>
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
    if (!this.modalPackConfig) return;
    this.modalPackConfig.style.display = 'flex';
    if (this.webConfigFeedback) this.webConfigFeedback.style.display = 'none';

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

    if (this.webInputPackPath) {
      setTimeout(() => this.webInputPackPath.focus(), 50);
    }
  }

  closePackConfigModal() {
    if (this.modalPackConfig) {
      this.modalPackConfig.style.display = 'none';
    }
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
    if (this.packCountBadge) {
      this.packCountBadge.innerHTML = `<span class="spinning" style="display: inline-block; font-size: 10px;">⚙️</span> Scanning…`;
    }

    try {
      const res = await fetch('/api/packs/rescan?t=' + Date.now(), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.packs = data.packs || [];
      console.log(`[DubMate] Rescan complete. Loaded ${this.packs.length} packs.`);
      this.renderPacks();
      const count = (this.packs || []).length;
      if (!silent) {
        this.showToast(`Found ${count} pack${count === 1 ? '' : 's'}`);
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
      this.selectedPackId = null;
      if (this.packCountBadge) {
        this.packCountBadge.innerText = '0 packs';
      }
      this.packGrid.innerHTML = `
        <div class="empty-packs-guide glass-card" style="grid-column: 1 / -1; padding: 36px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <h3 style="font-size: 17px; font-weight: 700; margin-bottom: 8px; color: var(--foreground);">No scene packs yet</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 500px; margin: 0 auto 18px; line-height: 1.6;">
            Choose your packs folder, import a pack .zip, or make one in Pack Builder.
          </p>
          <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">Choose folder</button>
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
        this.packCountBadge.innerText = `${filteredPacks.length} of ${allPacks.length} packs`;
      } else {
        this.packCountBadge.innerText = `${allPacks.length} packs`;
      }
    }

    if (!filteredPacks.length) {
      this.selectedPackId = null;
      const safeQuery = escapeHtml(query);
      this.packGrid.innerHTML = `
        <div class="empty-search-state glass-card" style="grid-column: 1 / -1; padding: 32px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 12px; color: var(--foreground);">No scenes match "${safeQuery}"</h3>
          <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.clearPackSearch()">Clear search</button>
        </div>
      `;
      return;
    }

    const hasCurrentSelection = filteredPacks.some(p => p.id === this.selectedPackId);
    if (!hasCurrentSelection && filteredPacks.length > 0) {
      this.selectedPackId = filteredPacks[0].id;
    }

    filteredPacks.forEach((pack) => {
      const card = document.createElement('div');
      const isSelected = (this.selectedPackId === pack.id);
      card.className = `pack-card ${isSelected ? 'selected' : ''}`;
      card.dataset.packId = pack.id;

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
              <a href="${escapeHtml(pack.export_url || `/api/packs/${encodeURIComponent(pack.id)}/export`)}" class="btn-pack-download-icon" data-tip="Download this pack" aria-label="Download ${escapeHtml(rawTitle)}" download>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>ZIP</span>
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
            doneMessage: `Downloaded "${rawTitle}"`,
            errorText: "Couldn't download that pack. Try again.",
            // packs_api writes the ZIP into the export folder's packs/ subfolder.
            exportSubfolder: 'packs',
          });
        });
      }

      card.addEventListener('click', () => {
        this.packGrid.querySelectorAll('.pack-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedPackId = pack.id;
      });

      this.packGrid.appendChild(card);
    });
  }
}
