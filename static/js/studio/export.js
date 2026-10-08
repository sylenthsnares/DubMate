// studio/export.js - Save on the premiere (the split button and its menu), the master
// export modal (saving, failed, done), render/export, downloads and Show in folder.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { joinLocalPath, openDialog } from '../ui_common.js';

/** The two video formats a room saves. */
const EXPORT_ASPECTS = ['16:9', '9:16'];

/** m:ss (0:06), for the export modal's facts and the premiere's timeline. */
export function clockTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A folder's last segment, shortened in the middle when it is long. */
function shortFolderName(dir) {
  const name = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(dir);
  return name.length > 28 ? `${name.slice(0, 14).trimEnd()}…${name.slice(-13).trimStart()}` : name;
}

export class ExportMethods {
  initExportEvents() {
    // The export modal. Esc and the backdrop are openDialog's (closed only once it isn't saving).
    this.btnModalCloseView?.addEventListener('click', () => {
      // Watch the dub: from the start, for everyone when the host presses it.
      this.closeExportModal();
      this.handleScreeningReplay();
    });
    for (const btn of [this.btnModalCloseX, this.btnModalCloseFailed, this.btnModalKeepWorking]) {
      btn?.addEventListener('click', () => this.closeExportModal());
    }
    this.btnModalRetry?.addEventListener('click', () => this.exportFinalVideo(this.exportModalAspect || '16:9'));
    this.btnModalReveal?.addEventListener('click', () => this.revealExport('video', this.exportModalAspect || '16:9'));
    this.btnModalMake916?.addEventListener('click', () => this.exportFinalVideo('9:16'));

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

    // A remote host's Download 16:9 / 9:16 in the done modal. These were bare
    // `<a download href>`. The webview followed the href, so a backend error answered
    // as JSON replaced the studio with `{"detail":"..."}`, and a working download gave
    // no sign it had started or finished. Same fetch/blob route (saveRemoteFile) as
    // the Save menu's downloads.
    for (const [anchor, aspectRatio] of [
      [this.btnModalDownload169, '16:9'],
      [this.btnModalDownload916, '9:16'],
    ]) {
      if (!anchor) continue;
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        // Not saved yet (9:16 on demand): make it here, visibly, then download it.
        if (this.exportState(aspectRatio) !== 'ready' && this.isHost({ allowDummy: true })) {
          this.exportFinalVideo(aspectRatio, { thenDownload: true });
          return;
        }
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
  // One state at a time (data-state on the overlay): rendering, timeout, failed or done.

  isExportModalOpen() {
    return !!this.modalExportRendering && !this.modalExportRendering.hidden;
  }

  /** Opens the modal in its rendering state, or puts an open one back into it (Try again, Make 9:16 version). */
  openExportModal() {
    this.isRenderingExport = true;
    this.setExportModalState('rendering');
    this.updateExportModalStep(1, 'Mixing your takes…');
    this.pauseScreeningPlayback();
    this.lockScreeningUI(true);
    if (!this.modalExportRendering) return;
    if (!this.isExportModalOpen()) {
      this.closeExportDialog = openDialog(this.modalExportRendering, {
        returnFocus: this.btnExportVideo,
        canClose: () => !this.isRenderingExport,
      });
    }
    // Nothing to press while it saves: the title holds the focus, inside the modal. Always,
    // since the button just pressed (Try again, Make 9:16 version) is hidden now and a
    // browser drops its focus to the page.
    this.exportModalTitle?.focus();
  }

  /** Shows the parts of the modal that belong to this state, and its title. */
  setExportModalState(state) {
    if (!this.modalExportRendering) return;
    this.modalExportRendering.dataset.state = state;
    const saving = state === 'rendering' || state === 'timeout';
    const show = (el, on) => { if (el) el.hidden = !on; };
    show(this.exportModalReel, saving);
    show(this.exportModalIconDone, state === 'done');
    show(this.exportModalIconFailed, state === 'failed');
    show(this.exportModalBadges, state === 'rendering' || state === 'failed');
    show(this.exportModalSteps, state === 'rendering');
    show(this.exportModalProgress, state === 'rendering');
    // Closing DubMate on the engine's computer stops the render; a remote host's window doesn't.
    show(this.exportModalReassurance, state === 'rendering' && this.isEngineLocal());
    show(this.btnModalCloseX, state === 'done' || state === 'failed');
    show(this.exportModalActions, state === 'done');
    show(this.exportModalFailedActions, state === 'failed');
    show(this.exportModalTimeoutActions, state === 'timeout');
    if (this.exportModalBadge) {
      this.exportModalBadge.textContent = state === 'failed' ? 'FAILED' : 'SAVING';
      this.exportModalBadge.classList.toggle('failed', state === 'failed');
    }
    if (this.exportModalTitle) {
      this.exportModalTitle.textContent = saving ? 'Saving your dub'
        : state === 'failed' ? "The export didn't finish" : 'Your dub is ready';
    }
    this.exportModalStatusText?.removeAttribute('title');
  }

  /** Step 1 (Mix audio) until the engine says the audio is mixed (its status poll's step),
   *  then step 2 (Make video). A restart goes back to step 1. */
  updateExportModalStep(step, statusText) {
    if (this.exportModalStatusText) this.exportModalStatusText.textContent = statusText;
    if (this.modalStepDsp) this.modalStepDsp.className = `modal-step-item ${step > 1 ? 'completed' : 'active'}`;
    if (this.modalStepMux) this.modalStepMux.className = `modal-step-item${step === 2 ? ' active' : ''}`;
    if (this.connectorDspMux) this.connectorDspMux.className = `step-connector${step > 1 ? ' completed' : ''}`;
    this.exportModalProgress?.setAttribute('aria-valuetext', step > 1 ? 'Make video' : 'Mix audio');
  }

  /** A render this client asked for is on disk: the done state, if the modal is still open. */
  handleExportSuccess(data) {
    this.isRenderingExport = false;
    this.lockScreeningUI(false);
    const aspect = (data.aspect_ratio || this.exportModalAspect) === '9:16' ? '9:16' : '16:9';

    const download169 = data.download_url_16_9 || data.download_url || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=16:9`;
    const download916 = data.download_url_9_16 || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=9:16`;
    if (this.btnModalDownload169) this.btnModalDownload169.href = download169;
    if (this.btnModalDownload916) this.btnModalDownload916.href = download916;

    this.onExportReady(aspect, data.export_video_url);

    // After Keep working the modal stays closed; Save already reads Saved.
    if (this.isExportModalOpen()) {
      this.setExportModalState('done');
      const local = this.isEngineLocal();
      const show = (el, on) => { if (el) el.hidden = !on; };
      show(this.btnModalReveal, local);
      show(this.btnModalMake916, local && this.exportState('9:16') !== 'ready');
      show(this.btnModalDownload169, !local);
      show(this.btnModalDownload916, !local);
      // Fire and forget: the render is already on disk, this only names where.
      this.showExportFacts(aspect, data.duration ?? this.roomState?.pack?.duration);
      this.btnModalCloseView?.focus();
    }

    if (this.exportDownloadAfter === aspect) {
      this.exportDownloadAfter = null;
      this.downloadExportVideo(aspect, aspect === '9:16' ? this.btnModalDownload916 : this.btnModalDownload169);
    }
  }

  /**
   * The done state's subtitle: "16:9 · 0:06 · in DubMate Exports". The folder (its last
   * segment, shortened in the middle, the full path in title) only on the engine's
   * computer; a remote host's file is on someone else's disk.
   */
  async showExportFacts(aspectRatio, duration) {
    const el = this.exportModalStatusText;
    if (!el) return;
    const facts = `${aspectRatio} · ${clockTime(duration)}`;
    el.textContent = facts;
    el.removeAttribute('title');
    const dir = await this.fetchExportsDir();
    // Still this done state: another save may have started meanwhile.
    if (!dir || this.modalExportRendering.dataset.state !== 'done' || el.textContent !== facts) return;
    el.textContent = `${facts} · in ${shortFolderName(dir)}`;
    el.title = dir;
  }

  closeExportModal() {
    this.isRenderingExport = false;
    this.lockScreeningUI(false);
    const close = this.closeExportDialog;
    this.closeExportDialog = null;
    // Focus goes back to Save.
    if (close) close();
  }

  /**
   * Lets the user leave the export modal (Esc, the backdrop, Leave room, the breadcrumbs).
   *
   * While `isRenderingExport` is true there is no close button, Esc and the backdrop do
   * nothing, and Leave room and the breadcrumbs are locked. Any path that stops the
   * render MUST come through here, or the user is sealed inside a modal with a page
   * reload as their only way out.
   */
  releaseExportModal() {
    this.isRenderingExport = false;
    this.lockScreeningUI(false);
  }

  /** The render didn't finish: why, with Try again (the same format) and Close. No toast. */
  failExport(err) {
    const aspect = this.exportModalAspect || '16:9';
    const reason = this.friendlyError(err, 'Something went wrong.').replace(/\s*Try again\.?$/, '');
    this.releaseExportModal();
    this.exportDownloadAfter = null;
    this.setExportState(aspect, 'failed');
    this.exportFailures[aspect] = reason;
    this.updateScreeningControls();
    if (!this.isExportModalOpen()) return;
    this.setExportModalState('failed');
    if (this.exportModalStatusText) this.exportModalStatusText.textContent = reason;
    this.btnModalRetry?.focus();
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

  /**
   * The host's Save for one format: renders it with the export modal open on this client
   * only. thenDownload: a remote host's Download for a format not saved yet.
   */
  async exportFinalVideo(aspectRatio = '16:9', { thenDownload = false } = {}) {
    if (!this.roomState) return;
    this.exportModalAspect = aspectRatio;
    this.exportDownloadAfter = thenDownload ? aspectRatio : null;
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

      // The engine renders in the background; poll until it is ready. "processing" only
      // says it started: the steps follow the poll's step (mix, then video).

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
            } else if (pollData.step && this.modalExportRendering?.dataset.state === 'rendering') {
              if (pollData.step === 'video') this.updateExportModalStep(2, 'Making the video…');
              else this.updateExportModalStep(1, 'Mixing your takes…');
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

        if (attempts === maxAttempts) {
          // Rendering a long scene legitimately takes minutes. Stop holding the
          // user hostage, but keep watching so the video still appears if it lands.
          this.releaseExportModal();
          if (this.isExportModalOpen()) {
            this.setExportModalState('timeout');
            this.exportModalStatusText.textContent =
              "Still saving. Long scenes take a few minutes. Save reads Saved when it's done.";
            this.btnModalKeepWorking?.focus();
          }
        }
        if (attempts >= maxAttempts * 4) {
          stopPolling();
          this.failExport("timed out");
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
    // A member in a second tab on this computer gets a normal download (the folder is the host's).
    if (this.isEngineLocal() && this.isHost({ allowDummy: true })) {
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
        // Same route as Save: writes into the export folder and ends in the export
        // modal's done state, which names the folder.
        await this.exportFinalVideo(aspectRatio);
        return false;
      }
      const dir = await this.fetchExportsDir();
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
}
