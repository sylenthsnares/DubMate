// studio/export.js - Save on the premiere (the split button and its menu), the master
// export modal, render/export, downloads, Show in folder and the saved-path line.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { joinLocalPath } from '../ui_common.js';

/** The two video formats a room saves. */
const EXPORT_ASPECTS = ['16:9', '9:16'];

export class ExportMethods {
  initExportEvents() {
    // Master Export Modal Actions
    if (this.btnModalCloseView) {
      this.btnModalCloseView.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.btnModalDismiss) {
      this.btnModalDismiss.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.modalExportRendering) {
      this.modalExportRendering.addEventListener('click', (e) => {
        // If clicking on the backdrop and not actively rendering, dismiss modal
        if (e.target === this.modalExportRendering && !this.isRenderingExport) {
          this.closeExportModal();
        }
      });
    }

    // Save: the main part acts on the 16:9 video, the chevron opens the menu.
    this.btnExportVideo.addEventListener('click', () => this.onSaveMainClick());
    if (this.btnSaveMenu && this.saveMenu) {
      this.btnSaveMenu.addEventListener('click', () => {
        if (this.saveMenu.hidden) this.openSaveMenu();
        else this.closeSaveMenu();
      });
      this.btnSaveMenu.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        this.openSaveMenu({ last: e.key === 'ArrowUp' });
      });
      for (const [key, row] of Object.entries(this.saveMenuRows || {})) {
        row?.addEventListener('click', () => this.onSaveMenuRow(key));
      }
      this.saveMenu.addEventListener('keydown', (e) => {
        const items = this.saveMenuItems();
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeSaveMenu({ focus: true });
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
        } else if (e.key === ' ' || e.key === 'Enter') {
          // The row's own click; Space must not also play or pause the premiere.
          e.stopPropagation();
        } else if (e.key === 'Tab') {
          this.closeSaveMenu();
        }
      });
      document.addEventListener('pointerdown', (e) => {
        if (!this.saveMenu.hidden && !this.screeningSave.contains(e.target)) this.closeSaveMenu();
      });
    }
    if (this.btnSaveRetry) {
      this.btnSaveRetry.addEventListener('click', () => this.exportFinalVideo('16:9'));
    }

    // These were bare `<a download href>`. The webview followed the href, so a
    // backend error answered as JSON replaced the studio with `{"detail":"..."}`,
    // and a working download gave no sign it had started or finished. Same
    // fetch/blob route (saveRemoteFile) as the Save menu's downloads.
    for (const [anchor, aspectRatio] of [
      [this.btnModalDownload169, '16:9'],
      [this.btnModalDownload916, '9:16'],
    ]) {
      if (!anchor) continue;
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        this.downloadExportVideo(aspectRatio, anchor);
      });
    }
  }

  // --- Save: the room's export state, the split button and its menu ---

  /** "idle", "processing", "ready" or "failed": the room's export of this video format. */
  exportState(aspectRatio) {
    const state = this.roomState?.exports?.[aspectRatio];
    if (state) return state;
    return aspectRatio === '16:9' && this.roomState?.has_export ? 'ready' : 'idle';
  }

  setExportState(aspectRatio, state) {
    if (!this.roomState) return;
    this.roomState.exports = { ...(this.roomState.exports || {}), [aspectRatio]: state };
  }

  /** A video finished rendering. The 16:9 one goes into the theater at the next pause. */
  onExportReady(aspectRatio, videoUrl = null) {
    this.setExportState(aspectRatio, 'ready');
    delete this.exportFailures[aspectRatio];
    if (aspectRatio === '16:9') {
      this.exportStale = false;
      if (this.roomState) {
        this.roomState.has_export = true;
        if (videoUrl) this.roomState.export_video_url = videoUrl;
      }
      this.offerExportedVideo(videoUrl);
    }
    this.updateScreeningControls();
  }

  /**
   * Save's main label from the 16:9 video's state (a member's reads Download video), and
   * the menu's rows. The width is fixed in CSS, so a label change never shifts the row.
   */
  renderSaveControl() {
    const main = this.btnExportVideo;
    if (!this.screeningSave || !main) return;
    const host = this.isHost({ allowDummy: true });
    const state = this.exportState('16:9');
    let view = 'idle';
    let label = 'Save video';
    let tip = null;
    let disabled = false;
    if (!host) {
      view = 'member';
      label = 'Download video';
      disabled = state !== 'ready';
      if (disabled) tip = "The host hasn't saved the video yet.";
    } else if (state === 'processing') {
      view = 'processing';
      label = 'Saving…';
      disabled = true;
    } else if (state === 'ready') {
      view = 'ready';
      label = 'Saved';
    } else if (this.exportStale) {
      view = 'stale';
      label = 'Mix changed · Save again';
      tip = 'Save makes a new video with the new mix.';
    }
    this.screeningSave.dataset.state = view;
    // A download in flight owns the label ("Preparing…") until it ends.
    if (!main.dataset.downloading) {
      this.labelExportBtn.textContent = label;
      if (disabled) main.setAttribute('aria-disabled', 'true');
      else main.removeAttribute('aria-disabled');
    }
    if (view === 'processing') main.setAttribute('aria-busy', 'true');
    else if (!main.dataset.downloading) main.removeAttribute('aria-busy');
    if (tip) main.setAttribute('data-tip', tip);
    else main.removeAttribute('data-tip');
    this.renderSaveMenu(host);
  }

  /** Each menu row says its own state: Making…, saved · Show in folder, Download, Not saved yet. */
  renderSaveMenu(host = this.isHost({ allowDummy: true })) {
    const rows = this.saveMenuRows || {};
    if (this.saveMenuEditing) this.saveMenuEditing.hidden = !host;
    const local = this.isEngineLocal();
    for (const aspect of EXPORT_ASPECTS) {
      const state = this.exportState(aspect);
      let text = '';
      let disabled = false;
      if (!host) {
        if (state === 'ready') text = 'Download';
        else {
          text = 'Not saved yet';
          disabled = true;
        }
      } else if (state === 'ready') {
        text = local ? 'saved · Show in folder' : 'Download';
      } else if (state === 'processing') {
        text = 'Making…';
      } else if (state === 'failed') {
        text = "Didn't save · Try again";
      }
      this.setSaveMenuRow(rows[aspect], { text, disabled, making: host && state === 'processing' });
    }
    const editing = {
      stems: ['Separate tracks (WAV)', 'Separate tracks'],
      project: ['Editing project (.zip)', 'Editing project'],
    };
    for (const [kind, [label, savedLabel]] of Object.entries(editing)) {
      const saved = local && this.editingSaved[kind];
      this.setSaveMenuRow(rows[kind], {
        label: saved ? savedLabel : label,
        text: saved ? 'saved · Show in folder' : '',
      });
    }
  }

  setSaveMenuRow(row, { label = null, text = '', disabled = false, making = false }) {
    // A download in flight owns the row ("Preparing…") until it ends.
    if (!row || row.dataset.downloading) return;
    if (label !== null) row.querySelector('.save-menu-label').textContent = label;
    row.querySelector('.save-menu-state').textContent = text;
    let bar = row.querySelector('.save-menu-bar');
    if (making && !bar) {
      bar = row.appendChild(document.createElement('span'));
      bar.className = 'save-menu-bar';
      bar.setAttribute('aria-hidden', 'true');
    } else if (!making && bar) {
      bar.remove();
    }
    if (making) row.setAttribute('aria-busy', 'true');
    else row.removeAttribute('aria-busy');
    if (disabled || making) row.setAttribute('aria-disabled', 'true');
    else row.removeAttribute('aria-disabled');
  }

  saveMenuItems() {
    if (!this.saveMenu) return [];
    return [...this.saveMenu.querySelectorAll('[role="menuitem"]')].filter((el) => !el.closest('[hidden]'));
  }

  openSaveMenu({ last = false } = {}) {
    if (!this.saveMenu) return;
    this.renderSaveControl();
    this.saveMenu.hidden = false;
    this.btnSaveMenu.setAttribute('aria-expanded', 'true');
    const items = this.saveMenuItems();
    items[last ? items.length - 1 : 0]?.focus();
  }

  closeSaveMenu({ focus = false } = {}) {
    if (!this.saveMenu || this.saveMenu.hidden) return;
    this.saveMenu.hidden = true;
    this.btnSaveMenu.setAttribute('aria-expanded', 'false');
    if (focus) this.btnSaveMenu.focus();
  }

  /** Save's main part. Host: save, then Show in folder (or download, remotely). Member: download. */
  onSaveMainClick() {
    const main = this.btnExportVideo;
    if (!this.roomState || main.getAttribute('aria-disabled') === 'true' || main.dataset.downloading) return;
    this.closeSaveMenu();
    const state = this.exportState('16:9');
    if (!this.isHost({ allowDummy: true })) {
      if (state === 'ready') this.downloadExportVideo('16:9', main);
      return;
    }
    if (state === 'processing') return;
    if (state === 'ready') {
      if (this.isEngineLocal()) this.revealExport('video', '16:9');
      else this.downloadExportVideo('16:9', main);
      return;
    }
    this.exportFinalVideo('16:9');
  }

  /** A menu row. It stays open while a row works, so its state reads inline. */
  async onSaveMenuRow(key) {
    const row = this.saveMenuRows?.[key];
    if (!row || !this.roomState || row.getAttribute('aria-disabled') === 'true' || row.dataset.downloading) return;
    const host = this.isHost({ allowDummy: true });
    if (key === 'stems' || key === 'project') {
      if (!host) return;
      if (this.editingSaved[key] && this.isEngineLocal()) {
        this.revealExport(key);
        return;
      }
      await (key === 'stems' ? this.downloadStems(row) : this.downloadFullProjectZip(row));
      this.renderSaveControl();
      return;
    }
    const state = this.exportState(key);
    if (state === 'ready') {
      if (host && this.isEngineLocal()) {
        this.revealExport('video', key);
        return;
      }
      await this.downloadExportVideo(key, row);
      this.renderSaveControl();
      return;
    }
    if (!host || state === 'processing') return;
    if (key === '16:9') {
      this.exportFinalVideo('16:9');
      return;
    }
    this.makeExportFormat(key);
  }

  /** Renders another format (9:16) in the background: its menu row shows Making…, no modal. */
  async makeExportFormat(aspectRatio) {
    if (!this.roomState) return;
    this.setExportState(aspectRatio, 'processing');
    delete this.exportFailures[aspectRatio];
    this.renderSaveControl();
    try {
      const res = await fetch(this.exportRequestUrl(aspectRatio), { method: 'POST' });
      if (!res.ok) throw await this.responseError(res);
      const data = await res.json();
      if (data.status === 'ok' || data.status === 'ready') this.onExportReady(aspectRatio, data.export_video_url);
      // Otherwise export_ready or export_failed arrives on the socket.
    } catch (err) {
      this.setExportState(aspectRatio, 'failed');
      this.exportFailures[aspectRatio] = this.friendlyError(err, "Couldn't make that video. Try again.");
      this.renderSaveControl();
    }
  }

  /** Show in folder (the engine's computer, host only): a saved video, the separate tracks or the editing project. */
  async revealExport(kind, aspectRatio = '16:9') {
    if (!this.roomState) return false;
    const body = kind === 'video'
      ? { kind, aspect_ratio: aspectRatio, user_id: this.user?.id || '' }
      : { kind, user_id: this.user?.id || '' };
    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/export/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await this.responseError(res);
      return true;
    } catch (err) {
      this.showToast(this.friendlyError(err, "Couldn't open the export folder. Try again."));
      return false;
    }
  }

  /** The engine's reason for a refused request (it answers {detail}), or its status. */
  async responseError(res) {
    let detail = `Server returned HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch { /* not JSON; the status is all we have */ }
    return new Error(detail);
  }

  /** POST /export for this format, with the dialogue level and the Mix this host hears. */
  exportRequestUrl(aspectRatio) {
    const presenceParam = encodeURIComponent(this.masterDialoguePresence || 0.0);
    const userParam = encodeURIComponent(this.user?.id || '');
    // The Mix the host hears, in case its set_mix_balance hasn't reached the room yet.
    const balanceParam = encodeURIComponent(this.screeningBalance ?? 50);
    return `/api/rooms/${this.roomState.room_id}/export?aspect_ratio=${aspectRatio}&presence=${presenceParam}&balance=${balanceParam}&user_id=${userParam}`;
  }

  // --- The export modal: only for the host's explicit Save ---

  openExportModal() {
    this.isRenderingExport = true;
    if (this.modalExportRendering) {
      this.modalExportRendering.style.display = 'flex';
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.style.display = 'none';
    }
    if (this.exportModalBadge) {
      this.exportModalBadge.className = 'badge-render-live';
      this.exportModalBadge.innerText = 'RENDERING';
    }
    if (this.exportModalTitle) {
      this.exportModalTitle.innerText = 'Rendering your dub';
    }
    if (this.exportModalReassurance) {
      this.exportModalReassurance.style.display = 'flex';
    }
    if (this.exportModalActions) {
      this.exportModalActions.style.display = 'none';
    }
    // Hidden until this render finishes, so a re-render never leaves the previous
    // "Saved to ..." line sitting under a progress bar.
    if (this.exportSavedPath) {
      this.exportSavedPath.classList.remove('is-visible');
    }
    this.updateExportModalStep(1, 25, "Mixing your takes with the scene…");
    this.pauseScreeningPlayback();
    this.lockScreeningUI(true);
  }

  updateExportModalStep(step, percent, statusText) {
    if (this.exportModalStatusText) {
      this.exportModalStatusText.innerText = statusText;
    }
    if (this.exportModalProgressBar) {
      this.exportModalProgressBar.style.width = `${percent}%`;
    }
    if (this.modalStepDsp && this.modalStepMux && this.modalStepReady) {
      this.modalStepDsp.className = 'modal-step-item' + (step > 1 ? ' completed' : (step === 1 ? ' active' : ''));
      this.modalStepMux.className = 'modal-step-item' + (step > 2 ? ' completed' : (step === 2 ? ' active' : ''));
      this.modalStepReady.className = 'modal-step-item' + (step >= 3 ? ' active' : '');
    }
    if (this.connectorDspMux) {
      this.connectorDspMux.className = 'step-connector' + (step > 1 ? ' completed' : '');
    }
    if (this.connectorMuxReady) {
      this.connectorMuxReady.className = 'step-connector' + (step > 2 ? ' completed' : '');
    }
  }

  handleExportSuccess(data) {
    this.isRenderingExport = false;

    this.updateExportModalStep(3, 100, "Your video is ready.");

    if (this.modalStepReady) {
      this.modalStepReady.className = 'modal-step-item completed';
    }
    if (this.connectorMuxReady) {
      this.connectorMuxReady.className = 'step-connector completed';
    }
    if (this.exportModalBadge) {
      this.exportModalBadge.className = 'badge-render-live ready';
      this.exportModalBadge.innerText = 'READY';
    }
    if (this.exportModalTitle) {
      this.exportModalTitle.innerText = 'Your dub is ready';
    }
    if (this.exportModalReassurance) {
      this.exportModalReassurance.style.display = 'none';
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.style.display = 'flex';
    }

    const download169 = data.download_url_16_9 || data.download_url || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=16:9`;
    const download916 = data.download_url_9_16 || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=9:16`;

    if (this.btnModalDownload169) {
      this.btnModalDownload169.href = download169;
    }
    if (this.btnModalDownload916) {
      this.btnModalDownload916.href = download916;
    }
    if (this.exportModalActions) {
      this.exportModalActions.style.display = 'flex';
    }

    // Fire and forget: the render is already on disk, this only names where.
    this.showExportSavedPath();

    this.lockScreeningUI(false);
    const aspect = (data.aspect_ratio || this.exportModalAspect) === '9:16' ? '9:16' : '16:9';
    this.onExportReady(aspect, data.export_video_url);
  }

  closeExportModal() {
    if (this.modalExportRendering) {
      this.modalExportRendering.style.display = 'none';
    }
    this.isRenderingExport = false;
    this.lockScreeningUI(false);
  }

  /**
   * Releases the export modal so the user can leave it.
   *
   * While `isRenderingExport` is true the close button is hidden and Esc, the
   * backdrop, Leave Room and the breadcrumbs are all disabled. Any path that stops
   * the render MUST come through here, or the user is sealed inside a modal with
   * a page reload as their only way out.
   */
  releaseExportModal() {
    this.isRenderingExport = false;
    if (this.btnModalCloseX) this.btnModalCloseX.style.display = 'flex';
    if (this.exportModalActions) this.exportModalActions.style.display = 'flex';
    this.lockScreeningUI(false);
  }

  failExport(err) {
    const message = this.friendlyError(err, "The export didn't finish. Try again.");
    this.releaseExportModal();
    this.updateExportModalStep(1, 0, message);
    if (this.exportModalBadge) {
      this.exportModalBadge.innerText = 'FAILED';
    }
    this.showToast(message);
  }

  lockScreeningUI(isLocked) {
    if (isLocked) this.closeSaveMenu();
    const controls = [
      this.btnScreeningPlayPause,
      this.btnScreeningReplay,
      this.btnExportVideo,
      this.btnSaveMenu,
      this.sliderScreeningBalance,
      this.btnLeaveRoom,
      this.navStepLobby,
      this.navStepBooth
    ];
    controls.forEach((el) => {
      if (el) {
        el.disabled = isLocked;
        el.classList.toggle('ui-interaction-locked', isLocked);
      }
    });
  }

  /** The host's Save for one format: renders it with the export modal open on this client only. */
  async exportFinalVideo(aspectRatio = '16:9') {
    if (!this.roomState) return;
    this.exportModalAspect = aspectRatio;
    this.closeSaveMenu();
    this.openExportModal();

    try {
      const res = await fetch(this.exportRequestUrl(aspectRatio), { method: 'POST' });
      // Say why when the engine does (e.g. older takes are being refreshed).
      if (!res.ok) throw await this.responseError(res);
      const data = await res.json();

      if (data.status === 'ok' || data.status === 'ready') {
        this.handleExportSuccess({ aspect_ratio: aspectRatio, ...data });
        return;
      }
      this.setExportState(aspectRatio, 'processing');
      this.updateScreeningControls();

      // If background rendering in progress, update step 2 and poll until ready
      this.updateExportModalStep(2, 65, "Making the video…");

      const pollUrl = `/api/rooms/${this.roomState.room_id}/export/status?aspect_ratio=${aspectRatio}`;
      let attempts = 0;
      const maxAttempts = 90; // up to 3 minutes

      if (this.exportPollInterval) clearInterval(this.exportPollInterval);
      const stopPolling = () => {
        clearInterval(pollInterval);
        if (this.exportPollInterval === pollInterval) this.exportPollInterval = null;
      };
      const pollInterval = setInterval(async () => {
        attempts++;
        // Decided inside the try, acted on outside it. Throwing from in here used
        // to be caught by this function's own catch two lines down, which left
        // isRenderingExport true and sealed the user inside the modal forever.
        let failure = null;
        try {
          const pollRes = await fetch(pollUrl);
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            if (pollData.status === 'ready' || pollData.status === 'ok') {
              stopPolling();
              this.handleExportSuccess({ aspect_ratio: aspectRatio, ...pollData });
              return;
            }
            if (String(pollData.status).startsWith('failed')) {
              failure = pollData.status;
            }
          }
        } catch (e) {
          // A single dropped poll is not a failure; the next tick retries.
          console.warn("[ExportPoll] Polling update:", e);
        }

        if (failure !== null) {
          stopPolling();
          this.failExport(failure);
          return;
        }

        if (attempts >= maxAttempts) {
          // Rendering a long scene legitimately takes minutes. Stop holding the
          // user hostage, but keep watching so the video still appears if it
          // lands -- the old code stopped polling and told them to "check back",
          // which nothing in the app let them do.
          this.releaseExportModal();
          this.updateExportModalStep(2, 85,
            "Still rendering. Long scenes can take a few minutes. " +
            "You can close this and keep working. The video will show up here when it's done.");
          if (attempts >= maxAttempts * 4) {
            stopPolling();
            this.failExport("timed out");
          }
        }
      }, 2000);
      this.exportPollInterval = pollInterval;

    } catch (err) {
      this.failExport(err);
    }
  }

  /**
   * Pulls a file from the backend and hands the finished blob to the browser.
   *
   * Everything that used to be an `<a download href>` goes through here: an anchor
   * navigates on click, so an endpoint that answers errors as JSON tore down the
   * studio (and its websocket) to render `{"detail":"..."}` as a page, and a
   * successful save was completely silent. Checks res.ok, takes the blob,
   * clicks a throwaway anchor and revokes late.
   *
   * `exportSubfolder` is for routes that write the file into the Render & Export
   * folder before sending it ('' for the folder itself). On the engine's own
   * computer that file is the user's copy, so the response is dropped and the
   * toast names the folder instead of saving a second copy to Downloads.
   *
   * Returns true only if the file actually reached the browser (or, with
   * `exportSubfolder` on the engine's computer, the export folder).
   */
  async saveRemoteFile(url, filename, options = {}) {
    const {
      control = null,
      busyText = 'Preparing…',
      startMessage = '',
      doneMessage = 'Download saved',
      errorText = "Couldn't download that file. Try again.",
      exportSubfolder = null,
      onSaved = null, // (res, dir) => {}: replaces the "Saved to" toast when kept on the engine
    } = options;
    const keepOnEngine = exportSubfolder !== null && this.isEngineLocal();

    if (!url) {
      this.showToast(errorText);
      return false;
    }
    // A second click mid-transfer would render and save the file twice.
    if (control && control.dataset.downloading === '1') return false;

    const label = control ? control.querySelector('span') : null;
    const originalText = label ? label.textContent : '';
    // Anchors ignore `disabled`, and a disabled Save or menu row would drop the keyboard
    // focus mid-download, so those use aria-disabled instead.
    const softDisable = control && (control.tagName === 'A' || control.matches('[role="menuitem"], .save-split-main'));
    if (control) {
      control.dataset.downloading = '1';
      control.setAttribute('aria-busy', 'true');
      if (softDisable) control.setAttribute('aria-disabled', 'true');
      else control.disabled = true;
      if (label) label.textContent = busyText;
    }
    if (startMessage) this.showToast(startMessage);

    let objectUrl = null;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          detail = (await res.json())?.detail || detail;
        } catch { /* not JSON; the status is all we have */ }
        throw new Error(detail);
      }

      if (keepOnEngine) {
        // The server finished writing the file before it started answering.
        try { await res.body?.cancel(); } catch { /* nothing left to read */ }
        const dir = await this.fetchExportsDir();
        if (onSaved) {
          onSaved(res, dir);
        } else if (!dir) {
          this.showToast('Saved in your export folder.');
        } else {
          this.showToast(`Saved to ${exportSubfolder ? joinLocalPath(dir, exportSubfolder) : dir}`);
        }
        return true;
      }

      // A big file the browser could not hold fails here with the browser's own
      // words ("network error"); the user gets the plain error line instead.
      let blob;
      try {
        blob = await res.blob();
      } catch {
        this.showToast(errorText);
        return false;
      }
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = objectUrl;
      a.setAttribute('download', filename);
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.showToast(doneMessage);
      return true;
    } catch (err) {
      this.showToast(this.friendlyError(err, errorText));
      return false;
    } finally {
      if (objectUrl) {
        // Revoked late so the browser has definitely started the save.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      }
      if (control) {
        delete control.dataset.downloading;
        control.removeAttribute('aria-busy');
        if (softDisable) control.removeAttribute('aria-disabled');
        else control.disabled = false;
        if (label) label.textContent = originalText;
      }
    }
  }

  /**
   * Gets the rendered master to the user, saved exactly once.
   *
   * On the engine's own computer the render is already in the Render & Export
   * folder, so pulling it through the browser only made a second copy in the OS
   * Downloads folder. There the button names the folder instead (rendering that
   * aspect into it first if it has not been rendered yet). Everyone else, whose
   * file lives on the host's machine, gets a normal browser download.
   */
  async downloadExportVideo(aspectRatio, control) {
    const roomId = this.roomState?.room_id;
    if (this.isEngineLocal()) {
      if (!roomId) {
        this.showToast('Render the dubbed video first.');
        return false;
      }
      let ready = false;
      try {
        const res = await fetch(`/api/rooms/${roomId}/export/status?aspect_ratio=${encodeURIComponent(aspectRatio)}`);
        ready = res.ok && (await res.json())?.status === 'ready';
      } catch { /* unknown: the render route below answers at once if the file exists */ }
      if (!ready) {
        // Same route as the Render button: writes into the export folder and ends
        // with the "Saved to ..." line in the export modal.
        await this.exportFinalVideo(aspectRatio);
        return false;
      }
      const dir = await this.fetchExportsDir();
      this.showExportSavedPath();
      this.showToast(dir
        ? `Already saved to ${dir}`
        : 'Already saved in your export folder.');
      return true;
    }

    const href = control ? control.getAttribute('href') : '';
    // handleExportSuccess fills the href; fall back to the canonical route so a
    // reconnect that never replayed the export event still downloads.
    const url = (href && href !== '#')
      ? href
      : (roomId ? `/api/rooms/${roomId}/export/download?aspect_ratio=${encodeURIComponent(aspectRatio)}` : '');
    if (!url) {
      this.showToast('Render the dubbed video first, then download it.');
      return false;
    }

    const packName = (this.roomState?.pack?.name || 'Dub').replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = aspectRatio === '9:16' ? '9x16' : '16x9';
    return this.saveRemoteFile(url, `DubMate_${packName}_${suffix}.mp4`, {
      control,
      busyText: 'Preparing…',
      doneMessage: 'Video downloaded',
      errorText: "Couldn't download that video. Try again.",
    });
  }

  async downloadFullProjectZip(control = null) {
    if (!this.roomState?.room_id) {
      this.showToast("Join a room first.");
      return false;
    }
    const roomId = this.roomState.room_id;
    const packName = (this.roomState.pack?.name || 'Dub').replace(/[^a-zA-Z0-9_-]/g, '_');
    const zipUrl = `/api/rooms/${roomId}/export/project_zip?user_id=${encodeURIComponent(this.user?.id || '')}&v=${Date.now()}`;

    // Fetched rather than navigated to. The endpoint answers errors as JSON, so
    // window.location.assign() rendered "{"detail":"Room not found"}" as a page --
    // unloading the studio, dropping the websocket and throwing the host out of
    // their own session over a failed download.
    return this.saveRemoteFile(zipUrl, `DubMate_Project_${packName}_${roomId}.zip`, {
      control,
      busyText: 'Preparing…',
      doneMessage: "Project files downloaded",
      errorText: "Couldn't build the project files. Try again.",
      // rooms_api writes the ZIP straight into the export folder; on the engine's computer
      // the Save menu's row then reads "saved · Show in folder".
      exportSubfolder: '',
      onSaved: () => { this.editingSaved.project = true; },
    });
  }

  async downloadStems(control = null) {
    if (!this.roomState?.room_id) {
      this.showToast("Join a room first.");
      return false;
    }
    const roomId = this.roomState.room_id;
    const packName = (this.roomState.pack?.name || 'Dub').replace(/[^a-zA-Z0-9_-]/g, '_');
    return this.saveRemoteFile(`/api/rooms/${roomId}/export/stems?user_id=${encodeURIComponent(this.user?.id || '')}&v=${Date.now()}`, `DubMate_Stems_${packName}_${roomId}.zip`, {
      control,
      busyText: 'Preparing…',
      doneMessage: 'Separate tracks downloaded',
      errorText: "Couldn't get the separate tracks. Try again.",
      // Like the project ZIP, the engine writes the stems ZIP into the export folder.
      exportSubfolder: '',
      onSaved: () => { this.editingSaved.stems = true; },
    });
  }

  /**
   * Reads (and remembers) the folder the backend renders into.
   *
   * The render always went to the "Render & Export Folder" from settings, but no
   * screen ever named it, so the setting looked like it was being ignored.
   * Cached because the export modal asks for it on every successful render;
   * saveExportsDir() refreshes the cache when the user changes it.
   */
  async fetchExportsDir() {
    if (!this.isEngineLocal()) return null;
    if (typeof this.exportsDirCache === 'string') return this.exportsDirCache;
    try {
      const data = await this.fetchConfig();
      if (!data || typeof data.exports_dir !== 'string' || !data.exports_dir) return null;
      this.exportsDirCache = data.exports_dir;
      return this.exportsDirCache;
    } catch (err) {
      console.warn('[DubMate] Could not read exports_dir from /api/config:', err);
      return null;
    }
  }

  /**
   * Names the folder the finished render was written to, in the export modal.
   * Stays hidden rather than guessing if the backend does not report a folder,
   * and for remote members, where that folder is on the host's computer.
   */
  async showExportSavedPath() {
    if (!this.exportSavedPath) return;
    if (!this.isEngineLocal()) {
      this.exportSavedPath.classList.remove('is-visible');
      return;
    }
    const dir = await this.fetchExportsDir();
    if (!dir) {
      this.exportSavedPath.classList.remove('is-visible');
      return;
    }
    this.exportSavedPath.innerText = `Saved to ${dir}`;
    // The line is clamped to two lines, so hover/screen readers get the whole path.
    this.exportSavedPath.title = dir;
    this.exportSavedPath.classList.add('is-visible');
  }
}
