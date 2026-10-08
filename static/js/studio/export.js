// studio/export.js - Master export modal, render/export, downloads and the saved-path line.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { joinLocalPath } from '../ui_common.js';

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

    this.btnExportVideo.addEventListener('click', () => this.exportFinalVideo());

    if (this.btnDownloadProjectZip) {
      this.btnDownloadProjectZip.addEventListener('click', () => this.downloadFullProjectZip(this.btnDownloadProjectZip));
    }
    if (this.btnToolbarProjectZip) {
      this.btnToolbarProjectZip.addEventListener('click', () => this.downloadFullProjectZip(this.btnToolbarProjectZip));
    }
    if (this.btnDownloadStems) {
      this.btnDownloadStems.addEventListener('click', () => this.downloadStems(this.btnDownloadStems));
    }
    if (this.btnToolbarStems) {
      this.btnToolbarStems.addEventListener('click', () => this.downloadStems(this.btnToolbarStems));
    }

    // These four were bare `<a download href="/api/...">`. The webview followed the
    // href, so a backend error answered as JSON replaced the studio with
    // `{"detail":"..."}`, and a working download gave no sign it had started or
    // finished. Same fetch/blob route (saveRemoteFile) as downloadFullProjectZip().
    for (const [anchor, aspectRatio] of [
      [this.btnDownloadLink, '16:9'],
      [this.btnDownloadLink916, '9:16'],
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

  /**
   * `locked: false` is for watching a render another client started: the close
   * button stays and nothing is locked, because this client has no request of
   * its own that could release the modal later.
   */
  openExportModal({ locked = true } = {}) {
    this.isRenderingExport = locked;
    if (this.modalExportRendering) {
      this.modalExportRendering.style.display = 'flex';
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.style.display = locked ? 'none' : 'flex';
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
    if (locked) this.lockScreeningUI(true);
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
    this.isUsingExportedVideo = true;
    this.isRenderingExport = false;
    if (this.roomState) {
      this.roomState.has_export = true;
      this.roomState.export_video_url = data.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
      this.roomState.download_url = data.download_url || data.download_url_16_9;
    }

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

    // Also update legacy inline panel if displayed
    if (this.exportProgressBox) {
      this.exportProgressBox.style.display = 'block';
    }
    if (this.exportProgressFill) {
      this.exportProgressFill.style.transform = 'scaleX(1)';
    }
    if (this.stepDsp) { this.stepDsp.className = 'step-item completed'; }
    if (this.stepMux) { this.stepMux.className = 'step-item completed'; }
    if (this.stepReady) { this.stepReady.className = 'step-item active'; }
    if (this.exportStatusText) {
      this.exportStatusText.innerText = "Your video is ready.";
    }
    if (this.btnDownloadLink) {
      this.btnDownloadLink.href = download169;
    }
    if (this.btnDownloadLink916) {
      this.btnDownloadLink916.href = download916;
    }
    if (this.exportDownloadContainer) {
      this.exportDownloadContainer.style.display = 'flex';
    }

    this.applyExportedVideoToTheater(data.export_video_url);
    this.lockScreeningUI(false);
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
   * backdrop, Leave Room and Back to Booth are all disabled. Any path that stops
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
    const controls = [
      this.btnScreeningPlayPause,
      this.btnScreeningReplay,
      this.btnAspect169,
      this.btnAspect916,
      this.btnExportVideo,
      this.btnToolbarProjectZip,
      this.btnToolbarStems,
      this.btnBackBooth,
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

  async exportFinalVideo(aspectRatio = this.selectedAspectRatio) {
    if (!this.roomState) return;
    this.openExportModal();

    try {
      const presenceParam = encodeURIComponent(this.masterDialoguePresence || 0.0);
      const userParam = encodeURIComponent(this.user?.id || '');
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/export?aspect_ratio=${aspectRatio}&presence=${presenceParam}&user_id=${userParam}`, {
        method: 'POST',
      });

      if (!res.ok) {
        // Say why when the engine does (e.g. older takes are being refreshed).
        let detail = `Server returned HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (typeof body?.detail === 'string') detail = body.detail;
        } catch { /* not JSON; the status is all we have */ }
        throw new Error(detail);
      }
      const data = await res.json();

      if (data.status === 'ok' || data.status === 'ready') {
        this.handleExportSuccess(data);
        return;
      }

      // If background rendering in progress, update step 2 and poll until ready
      this.updateExportModalStep(2, 65, "Making the video…");

      const pollUrl = `/api/rooms/${this.roomState.room_id}/export/status?aspect_ratio=${aspectRatio}`;
      let attempts = 0;
      const maxAttempts = 90; // up to 3 minutes

      if (this.exportPollInterval) clearInterval(this.exportPollInterval);
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
              clearInterval(pollInterval);
              this.handleExportSuccess(pollData);
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
          clearInterval(pollInterval);
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
            clearInterval(pollInterval);
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
    const originalText = label ? label.innerText : '';
    if (control) {
      control.dataset.downloading = '1';
      control.setAttribute('aria-busy', 'true');
      // Anchors ignore `disabled`, so keyboard users need aria-disabled instead.
      if (control.tagName === 'A') control.setAttribute('aria-disabled', 'true');
      else control.disabled = true;
      if (label) label.innerText = busyText;
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
        if (control.tagName === 'A') control.removeAttribute('aria-disabled');
        else control.disabled = false;
        if (label) label.innerText = originalText;
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
      busyText: '⏳ Preparing…',
      startMessage: 'Preparing download…',
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
      startMessage: "Preparing project files…",
      doneMessage: "Project files downloaded",
      errorText: "Couldn't build the project files. Try again.",
      // rooms_api writes the ZIP straight into the export folder.
      exportSubfolder: '',
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
      startMessage: 'Preparing stems…',
      doneMessage: 'Stems downloaded',
      errorText: "Couldn't get the stems. Try again.",
      // Like the project ZIP, the engine writes the stems ZIP into the export folder.
      exportSubfolder: '',
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
