// studio/audio_setup.js - Audio device setup, first-run onboarding, input meter, export folder setting
// and removing Pack Builder in the desktop app.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { AudioEngine } from '../audio_engine.js';
import { escapeHtml } from '../ui_common.js';

// --- Audio Device Setup persistence keys & meter constants ---
export const AUDIO_SETUP_DONE_KEY = 'dubmate_audio_setup_done';
const AUDIO_INPUT_DEVICE_KEY = 'dubmate_audio_input_device';
const AUDIO_OUTPUT_DEVICE_KEY = 'dubmate_audio_output_device';
const AUDIO_SETUP_SKIP_KEY = 'dubmate_audio_setup_skipped';
// Device labels a member brought from their own DubMate (join handoff), waiting for labelled devices.
const AUDIO_HANDOFF_KEY = 'dubmate_audio_handoff';

// Meter spans -60 dBFS (silence floor) up to 0 dBFS (digital full scale).
const METER_FLOOR_DB = -60;
const METER_AMBER_DB = -12; // Hot but usable
const METER_RED_DB = -3;    // Near clipping
const METER_PEAK_HOLD_MS = 1100;
const METER_PEAK_DECAY_DB_PER_FRAME = 0.45;

// localStorage/sessionStorage throw in some locked-down webviews and in
// private-mode Safari, so every access goes through these guards.
export function safeStorageGet(store, key) {
  try {
    return store ? store.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

export function safeStorageSet(store, key, value) {
  try {
    if (store) store.setItem(key, value);
  } catch (e) { }
}

export function safeStorageRemove(store, key) {
  try {
    if (store) store.removeItem(key);
  } catch (e) { }
}

// One plain line per getUserMedia / MediaRecorder failure, shared by the meter, mic sync and room checks.
export function micErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "DubMate isn't allowed to use your microphone. Allow it, then try again.";
    case 'NotFoundError':
      return 'No microphone was found. Plug one in and press Rescan.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Another app is using your microphone. Close it and try again.';
    case 'OverconstrainedError':
      return "Your saved microphone isn't connected. Choose another one.";
    default:
      return "Can't read this microphone. Try another one or press Rescan.";
  }
}

function formatDbFS(db) {
  if (typeof db !== 'number' || !isFinite(db)) return '-∞';
  if (db <= METER_FLOOR_DB) return '-∞';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

// "2.1 GB" or "340 MB"; empty when the size is unknown.
function formatDiskSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export class AudioSetupMethods {
  // ==============================================================
  // AUDIO DEVICE SETUP / FIRST-RUN ONBOARDING
  // ==============================================================

  initAudioSetupState() {
    // --- Audio Device Setup / First-Run Onboarding State ---
    const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    this.audioSetup = {
      firstRunMode: false,
      requesting: false,
      permission: 'unknown', // 'unknown' | 'granted' | 'denied' | 'error'
      setupComplete: safeStorageGet(ls, AUDIO_SETUP_DONE_KEY) === '1',
      inputId: safeStorageGet(ls, AUDIO_INPUT_DEVICE_KEY) || '',
      outputId: safeStorageGet(ls, AUDIO_OUTPUT_DEVICE_KEY) || '',
      devices: { inputs: [], outputs: [], labelled: false, supported: false },
      meterRaf: null,
      // Bumped by every startInputMeter(), so a start that waited for the mic can tell it was superseded.
      meterToken: 0,
      peakDb: -Infinity,
      peakHoldUntil: 0,
      // Guards against two overlapping openAudioSettings() calls landing their
      // post-await UI updates out of order.
      openToken: 0,
    };
    // Hand the remembered device preferences to the engine before anything can
    // open a capture stream or play back audio.
    this.audio.preferredInputId = this.audioSetup.inputId || null;
    this.audio.preferredOutputId = this.audioSetup.outputId || null;
  }

  initAudioSettingsEvents() {
    if (this.btnAudioSettings) {
      this.btnAudioSettings.addEventListener('click', () => this.openAudioSettings());
    }
    if (this.btnCloseAudioSettings) {
      this.btnCloseAudioSettings.addEventListener('click', () => this.closeAudioSettings());
    }
    if (this.btnAudioSettingsDone) {
      this.btnAudioSettingsDone.addEventListener('click', () => this.closeAudioSettings());
    }
    if (this.modalAudioSettings) {
      this.modalAudioSettings.addEventListener('click', (e) => {
        if (e.target === this.modalAudioSettings) this.closeAudioSettings();
      });
    }
    if (this.btnGrantMic) {
      this.btnGrantMic.addEventListener('click', () => this.requestMicAccessFromPanel());
    }
    if (this.btnRetryMic) {
      this.btnRetryMic.addEventListener('click', () => this.requestMicAccessFromPanel());
    }
    if (this.btnSkipAudioSetup) {
      this.btnSkipAudioSetup.addEventListener('click', () => this.skipAudioSetup());
    }
    if (this.btnDismissAudioDenied) {
      this.btnDismissAudioDenied.addEventListener('click', () => this.skipAudioSetup());
    }
    if (this.btnRefreshAudioDevices) {
      this.btnRefreshAudioDevices.addEventListener('click', () => this.rescanAudioDevices());
    }
    if (this.selectAudioInput) {
      this.selectAudioInput.addEventListener('change', (e) => this.applyInputDevice(e.target.value));
    }
    if (this.selectAudioOutput) {
      this.selectAudioOutput.addEventListener('change', (e) => this.applyOutputDevice(e.target.value));
    }
    if (this.btnSaveExportsDir) {
      this.btnSaveExportsDir.addEventListener('click', () => this.saveExportsDir());
    }
    if (this.inputExportsDir) {
      this.inputExportsDir.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.saveExportsDir();
      });
    }
    if (this.btnRemovePackBuilder) {
      this.btnRemovePackBuilder.addEventListener('click', () => this.showPackBuilderRemoveConfirm(true));
    }
    if (this.btnCancelRemovePackBuilder) {
      this.btnCancelRemovePackBuilder.addEventListener('click', () => {
        this.showPackBuilderRemoveConfirm(false);
        if (this.btnRemovePackBuilder) this.btnRemovePackBuilder.focus();
      });
    }
    if (this.btnConfirmRemovePackBuilder) {
      this.btnConfirmRemovePackBuilder.addEventListener('click', () => this.removePackBuilder());
    }

    // Devices can be hot-plugged while the panel is open.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof navigator.mediaDevices.addEventListener === 'function') {
      try {
        navigator.mediaDevices.addEventListener('devicechange', () => {
          if (this.isAudioSettingsOpen() && this.audioSetup.permission === 'granted') {
            this.refreshAudioDevices().catch(() => { });
          }
        });
      } catch (e) { }
    }

    // A meter must never keep a requestAnimationFrame loop alive in a hidden
    // tab; pause it on blur and resume when the panel comes back into view.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (this.isDocumentHidden()) {
          this.stopInputMeter();
        } else if (this.isAudioSettingsOpen() && this.audioSetup.permission === 'granted'
          && this.audioStepDevices && this.audioStepDevices.style.display !== 'none') {
          this.startInputMeter().catch(() => { });
        }
      });
    }
  }

  isAudioSettingsOpen() {
    return !!(this.modalAudioSettings && this.modalAudioSettings.style.display !== 'none');
  }

  // Checks visibilityState rather than document.hidden: some embedded webviews
  // (and JSDOM) report the legacy 'prerender' state, which would otherwise
  // wedge the meter permanently off.
  isDocumentHidden() {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'hidden';
  }

  // Runs once on boot, before anything can trigger a bare permission prompt.
  async initAudioSetupOnBoot() {
    const ls = (typeof localStorage !== 'undefined') ? localStorage : null;

    // Re-apply the remembered output device to the <video> elements that
    // already exist in the document.
    if (this.audioSetup.outputId && this.audio.supportsOutputRouting()) {
      try {
        const routed = await this.audio.applyOutputRouting();
        if (!routed.ok) {
          // Remembered sink is gone (headphones unplugged) - drop back to default.
          console.warn('[DubMate] Remembered output device unavailable, using system default.');
          this.audio.preferredOutputId = null;
        }
      } catch (e) { }
    }

    let state = 'unknown';
    try {
      state = await this.audio.getMicPermissionState();
    } catch (e) { }

    if (state === 'granted') {
      this.audioSetup.permission = 'granted';
      this.audioSetup.setupComplete = true;
      safeStorageSet(ls, AUDIO_SETUP_DONE_KEY, '1');
      this.updateAudioSettingsAffordance();
      await this.refreshAudioDevices();
      return;
    }
    if (state === 'denied') {
      this.audioSetup.permission = 'denied';
    }

    // No dialog at launch: the lobby's "Check your mic" card sets the mic up while
    // friends join (mic_card.js), and the booth still asks anyone who skipped it.
    this.updateAudioSettingsAffordance();
  }

  updateAudioSettingsAffordance() {
    if (!this.audioSettingsAlertDot) return;
    const needsAttention = this.audioSetup.permission !== 'granted' && !this.audioSetup.setupComplete;
    this.audioSettingsAlertDot.style.display = needsAttention ? 'block' : 'none';
  }

  showAudioSetupStep(step) {
    const steps = {
      intro: this.audioStepIntro,
      denied: this.audioStepDenied,
      devices: this.audioStepDevices,
    };
    Object.keys(steps).forEach((key) => {
      if (steps[key]) steps[key].style.display = (key === step) ? 'block' : 'none';
    });

    if (this.audioSetupStatusPill) {
      if (step === 'devices') {
        this.audioSetupStatusPill.innerText = 'MIC READY';
      } else if (step === 'denied') {
        this.audioSetupStatusPill.innerText = 'MIC BLOCKED';
      } else {
        this.audioSetupStatusPill.innerText = 'NO MIC';
      }
    }
    if (this.audioSetupSubtitle) {
      if (step === 'devices') {
        this.audioSetupSubtitle.innerText =
          'Choose your microphone and headphones.';
      } else if (step === 'denied') {
        this.audioSetupSubtitle.innerText =
          'Recording is off until DubMate can use your microphone.';
      } else {
        this.audioSetupSubtitle.innerText =
          'Set up your microphone before you record.';
      }
    }
  }

  async openAudioSettings(options = {}) {
    if (!this.modalAudioSettings) return;

    const token = ++this.audioSetup.openToken;
    this.audioSetup.firstRunMode = !!options.firstRun;
    this.modalAudioSettings.style.display = 'flex';

    if (this.btnCloseAudioSettings) {
      // On a genuine first run the close button is redundant with "Skip for now".
      this.btnCloseAudioSettings.style.display = this.audioSetup.firstRunMode ? 'none' : 'flex';
    }

    let state = this.audioSetup.permission;
    if (state !== 'granted') {
      try {
        const queried = await this.audio.getMicPermissionState();
        if (queried === 'granted' || queried === 'denied') state = queried;
      } catch (e) { }
    }
    // A newer open (or a close) superseded this call while it was awaiting.
    if (token !== this.audioSetup.openToken) return;
    this.audioSetup.permission = state;

    // Fire and forget: hidden entirely if the backend has no exports_dir yet.
    this.loadExportsDirSetting();
    this.loadPackBuilderRemoval();
    this.verifyRoomCheck();

    if (state === 'granted') {
      this.showAudioSetupStep('devices');
      await this.refreshAudioDevices();
      await this.startInputMeter();
    } else if (state === 'denied') {
      this.renderMicDenial(null);
      this.showAudioSetupStep('denied');
    } else {
      this.showAudioSetupStep('intro');
    }

    this.updateAudioSettingsAffordance();
  }

  closeAudioSettings() {
    // Invalidate any in-flight openAudioSettings() so it cannot repaint the
    // panel after the user has dismissed it.
    this.audioSetup.openToken++;
    this.stopInputMeter();
    if (this.modalAudioSettings) {
      this.modalAudioSettings.style.display = 'none';
    }
    this.cancelMicSync();
    this.cancelRoomCheck();
    this.showRoomCard(null);
    this.audioSetup.firstRunMode = false;
    this.setExportsFeedback('', null);
    this.showPackBuilderRemoveConfirm(false);
    this.updateAudioSettingsAffordance();
  }

  skipAudioSetup() {
    const ss = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
    safeStorageSet(ss, AUDIO_SETUP_SKIP_KEY, '1');
    this.closeAudioSettings();
    this.showToast('You can set up audio later from Audio in the top bar.');
  }

  // The one place in the app that is allowed to trigger getUserMedia cold,
  // and it only ever runs from an explicit click on the explainer screen.
  async requestMicAccessFromPanel() {
    if (this.audioSetup.requesting) return;
    this.audioSetup.requesting = true;

    const restoreGrantBtn = () => {
      if (this.btnGrantMic) this.btnGrantMic.disabled = false;
      if (this.btnRetryMic) this.btnRetryMic.disabled = false;
      if (this.btnGrantMicText) this.btnGrantMicText.innerText = 'Allow microphone';
    };

    if (this.btnGrantMic) this.btnGrantMic.disabled = true;
    if (this.btnRetryMic) this.btnRetryMic.disabled = true;
    if (this.btnGrantMicText) this.btnGrantMicText.innerText = 'Waiting for permission…';

    try {
      await this.audio.requestMicrophone();
      // Hand the capture device straight back; the meter opens its own stream
      // and recording re-acquires on demand.
      this.audio.releaseMicrophone();

      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      this.audioSetup.permission = 'granted';
      this.audioSetup.setupComplete = true;
      safeStorageSet(ls, AUDIO_SETUP_DONE_KEY, '1');

      this.showAudioSetupStep('devices');
      await this.refreshAudioDevices();
      await this.startInputMeter();
      this.showToast('Microphone connected');
    } catch (err) {
      const name = (err && err.name) || '';
      this.audioSetup.permission = (name === 'NotAllowedError' || name === 'SecurityError') ? 'denied' : 'error';
      this.renderMicDenial(err);
      this.showAudioSetupStep('denied');
    } finally {
      this.audioSetup.requesting = false;
      restoreGrantBtn();
      this.updateAudioSettingsAffordance();
    }
  }

  renderMicDenial(err) {
    const name = (err && err.name) || '';
    let heading = 'Microphone access was blocked';
    let detail = 'Recording is off until you allow microphone access.';

    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      heading = 'No microphone was found';
      detail = 'Plug in a microphone or headset, then press Try again.';
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      heading = 'The microphone is in use by another app';
      detail = 'Close Discord, OBS, Teams or any other app using the microphone, then press Try again.';
    } else if (name === 'OverconstrainedError') {
      heading = 'The saved microphone is no longer available';
      detail = 'Your saved microphone was unplugged. Press Try again to use the system default.';
    } else if (name && name !== 'NotAllowedError' && name !== 'SecurityError') {
      detail = 'Recording is off until the microphone works. Check that it is plugged in and allowed, then press Try again.';
    }

    if (this.audioDeniedHeading) this.audioDeniedHeading.innerText = heading;
    if (this.audioDeniedDetail) this.audioDeniedDetail.innerText = detail;
  }

  async rescanAudioDevices() {
    if (this.audioSetup.permission !== 'granted') return;
    await this.refreshAudioDevices();
    this.showToast('Device list updated');
  }

  // Labels only come back populated once permission has been granted, which is
  // why this is never called before requestMicAccessFromPanel() succeeds.
  async refreshAudioDevices() {
    let devices = { inputs: [], outputs: [], labelled: false, supported: false };
    try {
      devices = await this.audio.enumerateAudioDevices();
    } catch (e) { }
    this.audioSetup.devices = devices;

    const inputResult = this.populateDeviceSelect(
      this.selectAudioInput, devices.inputs, this.audioSetup.inputId,
      'System default', 'Microphone'
    );
    this.renderDeviceNote(this.audioInputNote, inputResult, devices, 'microphone');

    const outputSupported = this.audio.supportsOutputRouting();
    if (this.audioOutputRow) this.audioOutputRow.style.display = outputSupported ? 'block' : 'none';
    if (this.audioOutputUnsupported) this.audioOutputUnsupported.style.display = outputSupported ? 'none' : 'block';

    if (outputSupported) {
      const outputResult = this.populateDeviceSelect(
        this.selectAudioOutput, devices.outputs, this.audioSetup.outputId,
        'System default', 'Output'
      );
      this.renderDeviceNote(this.audioOutputNote, outputResult, devices, 'output device');
    }
    this.renderMicSyncRow();
    this.renderRoomCheckRow();
    await this.resolveHandoffDevices();

    return devices;
  }

  // Picks the microphone and headphones a member chose on their own DubMate. Device ids differ
  // per origin, so the handoff carries labels; they only match once the browser shows labels.
  async resolveHandoffDevices() {
    const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    const raw = safeStorageGet(ls, AUDIO_HANDOFF_KEY);
    const devices = this.audioSetup.devices || {};
    if (!raw || !devices.labelled) return;
    safeStorageRemove(ls, AUDIO_HANDOFF_KEY);
    let wanted = null;
    try {
      wanted = JSON.parse(raw);
    } catch (e) { }
    if (!wanted || typeof wanted !== 'object') return;
    const find = (list, label) => {
      if (typeof label !== 'string' || !label) return null;
      const match = (Array.isArray(list) ? list : []).find((d) => d && d.label === label && d.deviceId);
      return match ? match.deviceId : null;
    };
    const inputId = find(devices.inputs, wanted.input_label);
    const outputId = find(devices.outputs, wanted.output_label);
    if (inputId) {
      await this.applyInputDevice(inputId);
      if (this.selectAudioInput) this.selectAudioInput.value = inputId;
    }
    if (outputId) {
      await this.applyOutputDevice(outputId);
      if (this.selectAudioOutput) this.selectAudioOutput.value = outputId;
    }
  }

  // Builds options with createElement/textContent so attacker-influenceable
  // device labels can never be parsed as markup.
  populateDeviceSelect(select, list, savedId, defaultLabel, fallbackPrefix) {
    const result = { missing: false, count: 0, savedLabel: '' };
    if (!select) return result;

    while (select.firstChild) select.removeChild(select.firstChild);

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = defaultLabel;
    select.appendChild(defaultOpt);

    const devices = Array.isArray(list) ? list : [];
    result.count = devices.length;

    let found = false;
    devices.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId || '';
      // Labels are blank until permission is granted; index fallback keeps the
      // list usable rather than rendering a column of empty rows.
      opt.textContent = device.label || `${fallbackPrefix} ${index + 1}`;
      opt.title = opt.textContent;
      select.appendChild(opt);
      if (savedId && device.deviceId === savedId) {
        found = true;
        result.savedLabel = device.label || '';
      }
    });

    select.value = found ? savedId : '';
    result.missing = !!savedId && !found;
    return result;
  }

  renderDeviceNote(noteEl, result, devices, kindLabel) {
    if (!noteEl) return;
    noteEl.className = 'audio-device-note';

    if (!devices.supported) {
      noteEl.style.display = 'block';
      noteEl.classList.add('is-error');
      noteEl.innerText = "This browser can't list audio devices.";
      return;
    }
    if (result.count === 0) {
      noteEl.style.display = 'block';
      noteEl.classList.add('is-warning');
      noteEl.innerText = `No ${kindLabel} was detected. Plug one in and press Rescan.`;
      return;
    }
    if (result.missing) {
      noteEl.style.display = 'block';
      noteEl.classList.add('is-warning');
      // escapeHtml() because the remembered label is device-supplied text.
      noteEl.innerHTML =
        `Your saved ${escapeHtml(kindLabel)} isn’t connected. Using the system default.`;
      return;
    }
    if (!devices.labelled) {
      noteEl.style.display = 'block';
      noteEl.innerText = 'Device names show after you allow microphone access.';
      return;
    }
    noteEl.style.display = 'none';
    noteEl.innerText = '';
  }

  async applyInputDevice(deviceId) {
    const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    const next = deviceId || '';
    this.audioSetup.inputId = next;
    if (next) {
      safeStorageSet(ls, AUDIO_INPUT_DEVICE_KEY, next);
    } else {
      safeStorageRemove(ls, AUDIO_INPUT_DEVICE_KEY);
    }
    this.audio.setPreferredInputDevice(next || null);
    this.renderMicSyncRow();
    this.renderRoomCheckRow();

    // Re-point the meter at the newly selected capture device.
    if (this.isAudioSettingsOpen()) {
      await this.startInputMeter();
    }
  }

  async applyOutputDevice(deviceId) {
    const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    const next = deviceId || '';
    this.audioSetup.outputId = next;
    if (next) {
      safeStorageSet(ls, AUDIO_OUTPUT_DEVICE_KEY, next);
    } else {
      safeStorageRemove(ls, AUDIO_OUTPUT_DEVICE_KEY);
    }
    this.renderMicSyncRow();

    let routed = { ok: false, reason: 'unsupported' };
    try {
      routed = await this.audio.setPreferredOutputDevice(next || null);
    } catch (err) {
      routed = { ok: false, reason: (err && err.name) || 'error' };
    }

    if (this.audioOutputNote) {
      this.audioOutputNote.className = 'audio-device-note';
      if (routed.ok) {
        this.audioOutputNote.style.display = 'block';
        this.audioOutputNote.innerText = next
          ? '✓ Using this output.'
          : '✓ Using the system default.';
      } else if (routed.reason === 'unsupported') {
        this.audioOutputNote.style.display = 'none';
      } else {
        this.audioOutputNote.style.display = 'block';
        this.audioOutputNote.classList.add('is-error');
        this.audioOutputNote.innerText =
          "Couldn't switch to that device. Using the system default.";
      }
    }
  }

  // --- Live Input Level Meter (dBFS) ---

  async startInputMeter() {
    const token = ++this.audioSetup.meterToken;
    this.stopInputMeter();
    if (!this.isAudioSettingsOpen()) return;
    if (this.isDocumentHidden()) return;
    if (typeof requestAnimationFrame !== 'function') return;

    if (!(await this.openMeterStream(token))) return;

    // Between the await above and here the user may already have closed the panel.
    if (!this.isAudioSettingsOpen()) {
      this.audio.stopInputMonitor();
      return;
    }

    if (this.levelMeterLamp) this.levelMeterLamp.classList.add('is-live');
    this.audioSetup.peakDb = -Infinity;
    this.audioSetup.peakHoldUntil = 0;

    const tick = () => {
      // Hard stop: the loop must not outlive the visible panel.
      if (!this.isAudioSettingsOpen() || this.isDocumentHidden()) {
        this.stopInputMeter();
        return;
      }
      this.renderInputMeterFrame();
      this.audioSetup.meterRaf = requestAnimationFrame(tick);
    };
    this.audioSetup.meterRaf = requestAnimationFrame(tick);
  }

  // Opens the meter's own mic stream and sets the hint. False when it failed or a newer
  // start (or a test pausing the meter) superseded it.
  async openMeterStream(token) {
    let info;
    try {
      info = await this.audio.startInputMonitor(this.audioSetup.inputId || null);
    } catch (err) {
      if (token !== this.audioSetup.meterToken) return false;
      const name = (err && err.name) || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.stopInputMeter();
        this.audioSetup.permission = 'denied';
        this.renderMicDenial(err);
        this.showAudioSetupStep('denied');
        return false;
      }
      console.warn('[DubMate] Input meter could not open the microphone:', err?.name, err?.message, err);
      this.setMeterHint(micErrorMessage(err), true);
      return false;
    }
    if (token !== this.audioSetup.meterToken || !info) return false;
    if (info.didFallBack) {
      this.setMeterHint("Your saved microphone isn't connected. Showing the system default.", true);
    } else {
      this.setMeterHint('Say your loudest line. Aim for the amber zone.', false);
    }
    return true;
  }

  // Mic sync and the room checks record through a fresh stream of their own, so they close
  // the meter's stream; the loop keeps running and shows their stream meanwhile.
  pauseMeterStream() {
    this.audio.stopInputMonitor();
  }

  // After a test ends, fails or is cancelled: reopens the meter's stream, keeping a running loop.
  resumeInputMeter() {
    if (!this.isAudioSettingsOpen() || this.audio.monitorAnalyser) return;
    if (this.audioSetup.meterRaf === null || this.audioSetup.meterRaf === undefined) {
      this.startInputMeter().catch(() => { });
      return;
    }
    this.openMeterStream(++this.audioSetup.meterToken).catch(() => { });
  }

  stopInputMeter() {
    if (this.audioSetup && this.audioSetup.meterRaf !== null && this.audioSetup.meterRaf !== undefined) {
      try { cancelAnimationFrame(this.audioSetup.meterRaf); } catch (e) { }
      this.audioSetup.meterRaf = null;
    }
    if (this.audio && typeof this.audio.stopInputMonitor === 'function') {
      this.audio.stopInputMonitor();
    }
    this.resetInputMeterUI();
  }

  resetInputMeterUI() {
    if (this.levelMeterMask) this.levelMeterMask.style.width = '100%';
    if (this.levelMeterPeakTick) {
      this.levelMeterPeakTick.style.display = 'none';
      this.levelMeterPeakTick.classList.remove('is-clipping');
    }
    if (this.levelMeterRms) this.levelMeterRms.innerText = '-∞ dB';
    if (this.levelMeterPeakReadout) {
      this.levelMeterPeakReadout.innerText = 'PK -∞';
      this.levelMeterPeakReadout.classList.remove('is-clipping');
    }
    if (this.levelMeterLamp) this.levelMeterLamp.classList.remove('is-live', 'is-clipping');
    if (this.levelMeterTrack) {
      this.levelMeterTrack.setAttribute('aria-valuenow', String(METER_FLOOR_DB));
      this.levelMeterTrack.setAttribute('aria-valuetext', '-infinity dBFS');
    }
    if (this.audioSetup) {
      this.audioSetup.peakDb = -Infinity;
      this.audioSetup.peakHoldUntil = 0;
    }
  }

  setMeterHint(message, isError) {
    if (!this.levelMeterHint) return;
    this.levelMeterHint.className = isError ? 'level-meter-hint is-error' : 'level-meter-hint';
    this.levelMeterHint.innerText = message;
  }

  renderInputMeterFrame() {
    const level = this.audio.readInputLevel();
    // No stream open (between test passes): rest at the floor instead of freezing.
    if (!level) {
      this.resetInputMeterUI();
      return;
    }

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const rmsDb = level.rmsDb;
    const peakDb = level.peakDb;

    // Peak hold, then a slow ballistic decay (classic PPM behaviour).
    if (!(this.audioSetup.peakDb > peakDb)) {
      this.audioSetup.peakDb = peakDb;
      this.audioSetup.peakHoldUntil = now + METER_PEAK_HOLD_MS;
    } else if (now > this.audioSetup.peakHoldUntil) {
      this.audioSetup.peakDb = Math.max(peakDb, this.audioSetup.peakDb - METER_PEAK_DECAY_DB_PER_FRAME);
    }

    const rmsPct = AudioEngine.dbToMeterPercent(rmsDb, METER_FLOOR_DB);
    const peakPct = AudioEngine.dbToMeterPercent(this.audioSetup.peakDb, METER_FLOOR_DB);
    const isClipping = this.audioSetup.peakDb >= METER_RED_DB;

    if (this.levelMeterMask) {
      this.levelMeterMask.style.width = `${(100 - rmsPct).toFixed(1)}%`;
    }
    if (this.levelMeterPeakTick) {
      if (peakPct > 0.1) {
        this.levelMeterPeakTick.style.display = 'block';
        this.levelMeterPeakTick.style.left = `${peakPct.toFixed(1)}%`;
      } else {
        this.levelMeterPeakTick.style.display = 'none';
      }
      this.levelMeterPeakTick.classList.toggle('is-clipping', isClipping);
    }
    if (this.levelMeterRms) {
      this.levelMeterRms.innerText = `${formatDbFS(rmsDb)} dB`;
    }
    if (this.levelMeterPeakReadout) {
      this.levelMeterPeakReadout.innerText = `PK ${formatDbFS(this.audioSetup.peakDb)}`;
      this.levelMeterPeakReadout.classList.toggle('is-clipping', isClipping);
    }
    if (this.levelMeterLamp) {
      this.levelMeterLamp.classList.toggle('is-clipping', isClipping);
      this.levelMeterLamp.classList.toggle('is-live', !isClipping);
    }
    if (this.levelMeterTrack) {
      const shown = Math.max(METER_FLOOR_DB, Math.min(0, isFinite(rmsDb) ? rmsDb : METER_FLOOR_DB));
      this.levelMeterTrack.setAttribute('aria-valuenow', shown.toFixed(1));
      this.levelMeterTrack.setAttribute('aria-valuetext', `${formatDbFS(rmsDb)} dBFS`);
    }

    if (isClipping) {
      this.setMeterHint('Too loud. Move back from the mic or turn down its input level.', true);
    } else if (this.audioSetup.peakDb > METER_AMBER_DB) {
      this.setMeterHint('Good level.', false);
    }
  }

  // --- Export Folder Setting (GET/POST /api/config -> exports_dir) ---

  async loadExportsDirSetting() {
    if (!this.audioExportsRow) return;
    // Stay hidden unless the running backend actually reports the key; the
    // server-side half of this feature may ship after this UI does.
    this.audioExportsRow.style.display = 'none';
    // The export folder is on the engine's computer; other computers never see it.
    if (!this.isEngineLocal()) return;
    try {
      const data = await this.fetchConfig();
      if (!data || typeof data !== 'object') return;
      if (!Object.prototype.hasOwnProperty.call(data, 'exports_dir')) return;

      this.audioExportsRow.style.display = 'block';
      if (typeof data.exports_dir === 'string' && data.exports_dir) {
        this.exportsDirCache = data.exports_dir;
      }
      if (this.inputExportsDir) {
        this.inputExportsDir.value = typeof data.exports_dir === 'string' ? data.exports_dir : '';
      }
    } catch (err) {
      console.warn('[DubMate] Could not read exports_dir from /api/config:', err);
    }
  }

  async saveExportsDir() {
    const raw = this.inputExportsDir ? this.inputExportsDir.value.trim() : '';
    if (!raw) {
      this.setExportsFeedback('Enter a folder path first.', false);
      return;
    }

    if (this.btnSaveExportsDir) this.btnSaveExportsDir.disabled = true;
    if (this.btnSaveExportsDirText) this.btnSaveExportsDirText.innerText = 'Saving…';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exports_dir: raw }),
      });
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }

      if (!res.ok) {
        throw new Error(data.detail || data.message || `HTTP ${res.status}`);
      }
      if (typeof data.exports_dir === 'string' && data.exports_dir) {
        // The backend may normalise the path it was given, so trust its answer.
        this.exportsDirCache = data.exports_dir;
        if (this.inputExportsDir) this.inputExportsDir.value = data.exports_dir;
      }
      this.setExportsFeedback('Export folder saved.', true);
      this.showToast('Export folder saved');
    } catch (err) {
      // Server details (unwritable folder) are shown as-is.
      let msg = (err && err.message) || "Couldn't save that folder.";
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        msg = this.friendlyError(err);
      }
      this.setExportsFeedback(msg, false);
    } finally {
      if (this.btnSaveExportsDir) this.btnSaveExportsDir.disabled = false;
      if (this.btnSaveExportsDirText) this.btnSaveExportsDirText.innerText = 'Save';
    }
  }

  setExportsFeedback(message, isSuccess) {
    if (!this.exportsDirFeedback) return;
    if (!message) {
      this.exportsDirFeedback.style.display = 'none';
      this.exportsDirFeedback.innerText = '';
      return;
    }
    this.exportsDirFeedback.style.display = 'block';
    this.exportsDirFeedback.className =
      isSuccess ? 'audio-inline-feedback is-success' : 'audio-inline-feedback is-error';
    this.exportsDirFeedback.innerText = message;
  }

  // --- Remove Pack Builder (desktop app only) ---

  /**
   * The desktop app's command bridge, or null in a browser or on a host's page.
   * The desktop app only answers this page on this computer's loopback address
   * (tauri/src-tauri/capabilities/studio.json), so nothing else even asks.
   */
  desktopInvoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    return typeof invoke === 'function' && this.isEngineLocal() ? invoke : null;
  }

  async loadPackBuilderRemoval() {
    if (!this.packBuilderRow || this.packBuilderRemoving) return;
    this.packBuilderRow.style.display = 'none';
    this.showPackBuilderRemoveConfirm(false);
    this.setPackBuilderRemoveFeedback('');

    const invoke = this.desktopInvoke();
    if (!invoke) return;
    let status = null;
    try {
      status = await invoke('get_packbuilder_status', { withSize: true });
    } catch (err) {
      // An older desktop app without this permission refuses the call.
      console.warn('[DubMate] Could not read the Pack Builder status:', err);
      return;
    }
    if (!status || !status.installed) return;

    if (this.packBuilderSizeNote) {
      const size = formatDiskSize(status.size_bytes);
      this.packBuilderSizeNote.innerText = size ? `Removing it frees ${size}.` : '';
    }
    this.packBuilderRow.style.display = 'block';
  }

  showPackBuilderRemoveConfirm(show) {
    if (this.packBuilderRemoving) return;
    if (this.packBuilderRemoveConfirm) this.packBuilderRemoveConfirm.style.display = show ? 'block' : 'none';
    if (this.btnRemovePackBuilder) this.btnRemovePackBuilder.style.display = show ? 'none' : '';
    if (show && this.btnCancelRemovePackBuilder) this.btnCancelRemovePackBuilder.focus();
  }

  setPackBuilderRemoveFeedback(message) {
    if (!this.packBuilderRemoveFeedback) return;
    this.packBuilderRemoveFeedback.innerText = message;
    this.packBuilderRemoveFeedback.style.display = message ? 'block' : 'none';
  }

  async removePackBuilder() {
    const invoke = this.desktopInvoke();
    if (!invoke || this.packBuilderRemoving) return;
    this.showPackBuilderRemoveConfirm(false);
    this.setPackBuilderRemoveFeedback('');
    this.packBuilderRemoving = true;
    if (this.btnRemovePackBuilder) this.btnRemovePackBuilder.disabled = true;
    if (this.btnRemovePackBuilderText) this.btnRemovePackBuilderText.innerText = 'Removing…';

    try {
      // Resolves once the engine is back up without Pack Builder.
      await invoke('remove_packbuilder');
    } catch (err) {
      console.warn('[DubMate] Pack Builder was not removed:', err);
      this.packBuilderRemoving = false;
      if (this.btnRemovePackBuilder) this.btnRemovePackBuilder.disabled = false;
      if (this.btnRemovePackBuilderText) this.btnRemovePackBuilderText.innerText = 'Remove Pack Builder';
      this.setPackBuilderRemoveFeedback("Pack Builder couldn't be removed. Restart DubMate and try again.");
      return;
    }

    // The engine restarted and may have picked another port, so reopen the studio there.
    let port = Number(window.location.port);
    try {
      const current = await invoke('get_engine_port');
      if (Number.isInteger(current) && current > 0) port = current;
    } catch (err) {
      console.warn('[DubMate] Could not read the engine port:', err);
    }
    this.navigateTo(`http://127.0.0.1:${port}/`);
  }

  // Guard used by the record path so the browser permission
  // prompt is never the first thing a user sees. A failed open is kept in micError,
  // so the record deck shows NO MIC and why until the mic opens again.
  async ensureMicReady() {
    const ready = await this.checkMicReady();
    if (ready) this.micError = null;
    this.updateRecordButtonUI();
    return ready;
  }

  async checkMicReady() {
    if (this.audioSetup.permission === 'granted') return true;

    let state = 'unknown';
    try {
      state = await this.audio.getMicPermissionState();
    } catch (e) { }

    if (state !== 'granted' && this.audioSetup.setupComplete) {
      // Set up elsewhere (a member on a host's page): ask for the mic now, before the count-in,
      // then hand it back so the take opens its own fresh stream.
      try {
        await this.audio.requestMicrophone();
        this.audio.releaseMicrophone();
      } catch (err) {
        this.micError = err;
        const name = (err && err.name) || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.audioSetup.permission = 'denied';
          await this.openAudioSettings();
          this.renderMicDenial(err);
          this.showAudioSetupStep('denied');
        } else {
          this.showToast(micErrorMessage(err));
        }
        this.updateAudioSettingsAffordance();
        return false;
      }
      this.audioSetup.permission = 'granted';
      this.updateAudioSettingsAffordance();
      await this.refreshAudioDevices();
      return true;
    }

    if (state === 'granted') {
      const ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      this.audioSetup.permission = 'granted';
      this.audioSetup.setupComplete = true;
      safeStorageSet(ls, AUDIO_SETUP_DONE_KEY, '1');
      this.updateAudioSettingsAffordance();
      return true;
    }

    this.showToast('Set up your microphone before recording.');
    this.openAudioSettings({ firstRun: true });
    return false;
  }
}
