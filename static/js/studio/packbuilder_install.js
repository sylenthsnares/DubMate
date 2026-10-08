// studio/packbuilder_install.js - Pack Builder installing in the background (step 39b). The
// launcher starts the install and opens the studio at once; the header chip follows it, and
// the Pack Builder line in the mode menu says the same. Finishing needs a restart, which the
// user starts ("Restart to finish Pack Builder"), with a confirm in a room.
// Desktop app on this computer only (desktopInvoke); an older app refuses
// get_packbuilder_install and everything stays hidden.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.

const PACKBUILDER_POLL_MS = 1000;
/** The launcher doesn't wait for the install to begin, so an idle first answer gets one more look. */
const PACKBUILDER_IDLE_RECHECK_MS = 3000;
const FAILED_TIP = 'Check your internet connection and free disk space, then press Try again.';
const INSTALL_STEPS = { preparing: 'Prepare', downloading: 'Download', installing: 'Install', finalizing: 'Finish' };
const STEP_ORDER = Object.keys(INSTALL_STEPS);
const MENU_COPY = {
  failed: "Its tools didn't install",
  done: 'Restart DubMate to finish installing',
};

function etaText(secs) {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) return '';
  if (secs < 60) return 'less than a minute left';
  return `about ${Math.round(secs / 60)} min left`;
}

/** "Step 2 of 4: Download · {headline} · {detail} · about 6 min left", leaving out empty parts. */
export function installTip(progress) {
  if (!progress) return '';
  const index = STEP_ORDER.indexOf(progress.phase);
  const step = index >= 0 ? `Step ${index + 1} of ${STEP_ORDER.length}: ${INSTALL_STEPS[progress.phase]}` : '';
  return [step, progress.headline, progress.detail, etaText(progress.eta_secs)]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

export class PackBuilderInstallMethods {
  initPackBuilderInstall() {
    this.pbInstallChip = document.getElementById('packbuilder-install-chip');
    if (!this.pbInstallChip) return;
    this.pbInstallRunning = document.getElementById('packbuilder-install-running');
    this.pbInstallFailed = document.getElementById('packbuilder-install-failed');
    this.btnPackBuilderRestart = document.getElementById('btn-packbuilder-restart');
    this.pbRestartConfirm = document.getElementById('packbuilder-restart-confirm');
    this.pbMenuDesc = document.querySelector('#mode-opt-builder .mode-item-desc');
    this.pbMenuDescOriginal = this.pbMenuDesc ? this.pbMenuDesc.textContent : '';
    this.pbInstallTimer = null;
    this.pbInstallRechecked = false;

    document.getElementById('btn-packbuilder-install-retry')
      ?.addEventListener('click', () => this.retryPackBuilderInstall());
    this.btnPackBuilderRestart?.addEventListener('click', () => this.finishPackBuilderInstall());
    document.getElementById('btn-cancel-packbuilder-restart')
      ?.addEventListener('click', () => this.showPackBuilderRestartConfirm(false));
    document.getElementById('btn-confirm-packbuilder-restart')
      ?.addEventListener('click', () => this.restartForPackBuilder());
    this.pbRestartConfirm?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.showPackBuilderRestartConfirm(false);
        this.btnPackBuilderRestart?.focus();
      }
    });

    this.pollPackBuilderInstall();
  }

  /** Reads the install state, renders it, and asks again in a second while it runs. */
  async pollPackBuilderInstall() {
    clearTimeout(this.pbInstallTimer);
    this.pbInstallTimer = null;
    const invoke = this.desktopInvoke();
    if (!invoke) return;
    let install = null;
    try {
      install = await invoke('get_packbuilder_install');
    } catch (err) {
      // An older desktop app doesn't have this command, or doesn't allow it here.
      console.warn('[DubMate] Could not read the Pack Builder install:', err);
    }
    this.renderPackBuilderInstall(install);
    // Two answers in flight (a double-clicked Try again) still leave one loop.
    clearTimeout(this.pbInstallTimer);
    if (install && install.state === 'running') {
      this.pbInstallRechecked = true;
      this.pbInstallTimer = setTimeout(() => this.pollPackBuilderInstall(), PACKBUILDER_POLL_MS);
    } else if (install && install.state === 'idle' && !this.pbInstallRechecked) {
      this.pbInstallRechecked = true;
      this.pbInstallTimer = setTimeout(() => this.pollPackBuilderInstall(), PACKBUILDER_IDLE_RECHECK_MS);
    }
  }

  renderPackBuilderInstall(install) {
    if (!this.pbInstallChip) return;
    const state = install && ['running', 'failed', 'done'].includes(install.state) ? install.state : 'idle';
    this.pbInstallChip.hidden = state === 'idle';
    this.pbInstallChip.dataset.state = state;
    this.pbInstallRunning.hidden = state !== 'running';
    this.pbInstallFailed.hidden = state !== 'failed';
    this.btnPackBuilderRestart.hidden = state !== 'done';
    if (state !== 'done') this.showPackBuilderRestartConfirm(false);

    let menuLine = this.pbMenuDescOriginal;
    if (state === 'running') {
      const raw = Number(install.progress?.percent);
      const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
      this.pbInstallRunning.querySelector('.pb-install-fill').style.width = `${percent}%`;
      this.pbInstallRunning.querySelector('.pb-install-percent').textContent = `${Math.floor(percent)}%`;
      this.pbInstallRunning.setAttribute('data-tip', installTip(install.progress) || 'Installing Pack Builder');
      menuLine = `Installing its tools · ${Math.floor(percent)}%`;
    } else if (state === 'failed') {
      this.setPackBuilderInstallError(install.error);
      menuLine = MENU_COPY.failed;
    } else if (state === 'done') {
      menuLine = MENU_COPY.done;
    }
    if (this.pbMenuDesc) this.pbMenuDesc.textContent = menuLine;
  }

  /** The failed line's tooltip says what to do; what went wrong is technical, so it goes to the log. */
  setPackBuilderInstallError(error) {
    if (error) console.warn('[DubMate] Pack Builder did not install:', error);
    this.pbInstallFailed.querySelector('.pb-install-label').setAttribute('data-tip', FAILED_TIP);
  }

  async retryPackBuilderInstall() {
    const invoke = this.desktopInvoke();
    if (!invoke) return;
    try {
      await invoke('start_packbuilder_install');
    } catch (err) {
      // Refused before it began (no internet, a read-only install folder): say why.
      this.renderPackBuilderInstall({ state: 'failed', progress: null, error: String(err) });
      return;
    }
    this.pollPackBuilderInstall();
  }

  /** Restart to finish: at once outside a room, after a confirm in one. */
  finishPackBuilderInstall() {
    if (this.roomState) this.showPackBuilderRestartConfirm(true);
    else this.restartForPackBuilder();
  }

  showPackBuilderRestartConfirm(show) {
    if (!this.pbRestartConfirm) return;
    this.pbRestartConfirm.hidden = !show;
    this.btnPackBuilderRestart?.setAttribute('aria-expanded', String(show));
    if (show) document.getElementById('btn-cancel-packbuilder-restart')?.focus();
  }

  async restartForPackBuilder() {
    const invoke = this.desktopInvoke();
    if (!invoke || this.pbRestarting) return;
    this.showPackBuilderRestartConfirm(false);
    this.pbRestarting = true;
    this.btnPackBuilderRestart.disabled = true;
    this.btnPackBuilderRestart.textContent = 'Restarting…';
    try {
      // Resolves once the engine is back up, now with Pack Builder.
      await invoke('trigger_start_sidecars');
    } catch (err) {
      console.warn('[DubMate] DubMate did not restart:', err);
      this.pbRestarting = false;
      this.btnPackBuilderRestart.disabled = false;
      this.btnPackBuilderRestart.textContent = 'Restart to finish Pack Builder';
      this.showToast("DubMate couldn't restart. Close it and open it again to finish Pack Builder.", { tone: 'error' });
      return;
    }

    // The engine may have picked another port, so reopen the studio there.
    let port = Number(window.location.port);
    try {
      const current = await invoke('get_engine_port');
      if (Number.isInteger(current) && current > 0) port = current;
    } catch (err) {
      console.warn('[DubMate] Could not read the engine port:', err);
    }
    this.navigateTo(`http://127.0.0.1:${port}/`);
  }
}
