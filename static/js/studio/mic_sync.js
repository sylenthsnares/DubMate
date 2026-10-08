// studio/mic_sync.js - Mic sync: the measured delay of this microphone and output pair,
// remembered per pair and used as a new take's starting timing, and the Timing row in
// Audio settings that measures it (a click pattern heard back through the mic, or claps).
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { micErrorMessage, safeStorageGet, safeStorageSet } from './audio_setup.js';
import { CLAP_BEAT_SEC, CLICK_TIMES_SEC, combineRuns, devicePairKey, findClapLag, findClickTrainLag, judgeClaps, snapMs } from './timing.js';

// localStorage: {"<mic>|<output>": {latency_ms, method, measured_at}}.
export const MIC_SYNC_KEY = 'dubmate_mic_sync';
// sessionStorage prefix: the "please sync" toast was shown for this pair in this tab.
const MIC_SYNC_ASKED_KEY = 'dubmate_mic_sync_asked:';
const MAX_LATENCY_MS = 800;

// The sound starts this long after the recorder, so even a zero delay lands inside the recording.
const LEAD_SEC = 0.3;
// The clap beat starts later, so the quiet before it shows how loud the room is.
const CLAP_LEAD_SEC = 0.8;
const TAIL_SEC = 0.5;
const CLICK_RUNS = 3;
// The clap beat plays in the ears, so about 10 dB below the full-level sync clicks.
const CLAP_BEAT_LEVEL = 0.3;
const MAX_CLICK_SPREAD_MS = 20;

// The clicks play at full level, so they must not be in anyone's ears.
const CLICKS_COPY = 'The clicks are loud. Take out your earbuds or headphones and hold them right next to the mic.';
const CLAP_COPY = 'Put your headphones back on, then clap on each beat you hear.';
const PANEL_COPY = {
  ready: CLICKS_COPY,
  listening: CLICKS_COPY,
  clicksFailed: "DubMate couldn't hear the clicks. Turn your computer's volume up, hold your earbuds closer to the mic and try again.",
  clap: CLAP_COPY,
  clapping: CLAP_COPY,
  failedQuiet: "DubMate couldn't hear your claps. Clap closer to the mic, right on each click.",
  failedUneven: 'Your claps were uneven. Try again, clapping right on each click.',
  failedNoisy: 'DubMate heard other sounds besides your claps. Try again somewhere quieter, clapping right on each click.',
};
const ERROR_STEPS = new Set(['clicksFailed', 'failedQuiet', 'failedUneven', 'failedNoisy']);
const CLAP_FAILED_STEP = { quiet: 'failedQuiet', noisy: 'failedNoisy', uneven: 'failedUneven' };
const CLICK_STEPS = new Set(['ready', 'listening', 'clicksFailed']);
const START_LABEL = { ready: 'Play clicks', listening: 'Listening…', clicksFailed: 'Try again' };

function webStorage(name) {
  try {
    return (typeof window !== 'undefined' && window[name]) || null;
  } catch (e) {
    return null;
  }
}

export function validEntry(entry) {
  return !!entry && typeof entry === 'object' && Number.isFinite(entry.latency_ms)
    && entry.latency_ms >= 0 && entry.latency_ms <= MAX_LATENCY_MS;
}

// The chosen device, else the system default entry, else the first one listed.
export function chosenDevice(list, selectedId) {
  const devices = Array.isArray(list) ? list : [];
  return (selectedId && devices.find((d) => d.deviceId === selectedId))
    || devices.find((d) => d.deviceId === 'default') || devices[0] || null;
}

export function deviceLabel(list, selectedId) {
  const device = chosenDevice(list, selectedId);
  return device ? (device.label || device.deviceId) : '';
}

export class MicSyncMethods {
  // On the host's computer the engine config also keeps each sync, because the
  // page's origin (and so its localStorage) changes when the port does.
  async loadEngineMicSync() {
    if (!this.isEngineLocal()) return;
    try {
      const data = await this.fetchConfig();
      if (data && data.mic_sync && typeof data.mic_sync === 'object') this.engineMicSync = data.mic_sync;
      this.renderMicSyncRow();
    } catch (err) {
      console.warn('[DubMate] Could not read mic sync from /api/config:', err);
    }
  }

  // Lists devices again so a microphone plugged in since Audio settings was open counts.
  async updateAudioDeviceList() {
    try {
      this.audioSetup.devices = await this.audio.enumerateAudioDevices();
    } catch (e) { }
  }

  currentDevicePairKey() {
    const devices = this.audioSetup.devices || {};
    return devicePairKey(deviceLabel(devices.inputs, this.audioSetup.inputId),
      deviceLabel(devices.outputs, this.audioSetup.outputId));
  }

  readMicSync() {
    try {
      const map = JSON.parse(safeStorageGet(webStorage('localStorage'), MIC_SYNC_KEY) || '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch (e) {
      return {};
    }
  }

  /** The measured delay for the current pair in ms, or null when it isn't synced. */
  currentLatencyMs() {
    const key = this.currentDevicePairKey();
    const map = this.readMicSync();
    if (validEntry(map[key])) return snapMs(map[key].latency_ms);
    const kept = this.isEngineLocal() && this.engineMicSync ? this.engineMicSync[key] : null;
    if (!validEntry(kept)) return null;
    map[key] = kept;
    safeStorageSet(webStorage('localStorage'), MIC_SYNC_KEY, JSON.stringify(map));
    return snapMs(kept.latency_ms);
  }

  async saveMicSync(latencyMs, method) {
    const key = this.currentDevicePairKey();
    const entry = {
      latency_ms: Math.min(MAX_LATENCY_MS, Math.max(0, snapMs(latencyMs))),
      method,
      measured_at: Date.now(),
    };
    const map = this.readMicSync();
    map[key] = entry;
    safeStorageSet(webStorage('localStorage'), MIC_SYNC_KEY, JSON.stringify(map));
    if (this.isEngineLocal()) {
      this.engineMicSync = { ...(this.engineMicSync || {}), [key]: entry };
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mic_sync: { [key]: entry } }),
        });
        if (!res.ok) console.warn('[DubMate] Engine did not keep the mic sync: HTTP', res.status);
      } catch (err) {
        console.warn('[DubMate] Engine did not keep the mic sync:', err);
      }
    }
    return entry;
  }

  // The toast after a take saves: once per unsynced pair per tab session, and only on
  // the host's computer (a guest's sync is lost whenever the host restarts DubMate).
  shouldOfferMicSync() {
    if (!this.isEngineLocal() || this.currentLatencyMs() !== null) return false;
    const asked = MIC_SYNC_ASKED_KEY + this.currentDevicePairKey();
    if (!this.micSyncAsked) this.micSyncAsked = new Set();
    if (this.micSyncAsked.has(asked) || safeStorageGet(webStorage('sessionStorage'), asked) === '1') return false;
    this.micSyncAsked.add(asked);
    safeStorageSet(webStorage('sessionStorage'), asked, '1');
    return true;
  }

  /** The booth's inline mic-sync advice under the transport ("Audio settings" or ×). */
  showMicSyncHint() {
    if (this.micSyncHint) this.micSyncHint.hidden = false;
  }

  hideMicSyncHint() {
    if (this.micSyncHint) this.micSyncHint.hidden = true;
  }

  // --- Timing row in Audio settings ---

  initMicSyncEvents() {
    this.micSyncRun = 0;
    this.micSyncBusy = false;
    this.micSyncStep = null;
    if (this.btnMicSync) this.btnMicSync.addEventListener('click', () => this.openMicSyncPanel());
    if (this.btnStartMicSync) this.btnStartMicSync.addEventListener('click', () => this.runMicSync());
    if (this.btnStartClapping) this.btnStartClapping.addEventListener('click', () => this.runClapSync());
    if (this.btnClapInstead) this.btnClapInstead.addEventListener('click', () => this.openClapStep());
    if (this.btnCancelMicSync) this.btnCancelMicSync.addEventListener('click', () => this.cancelMicSync());
  }

  renderMicSyncRow() {
    if (!this.micSyncStatus) return;
    const ms = this.currentLatencyMs();
    if (ms === null) this.micSyncStatus.textContent = 'Not synced yet';
    else this.micSyncStatus.textContent = ms > 0 ? `Synced. New takes move ${ms} ms earlier.` : 'Synced.';
    // A guest's page lives on an address that changes whenever the host restarts DubMate.
    // A member from their own DubMate brings that one's sync along when joining.
    if (this.isEngineLocal()) {
      this.micSyncStatus.removeAttribute('data-tip');
      this.micSyncStatus.removeAttribute('tabindex');
    } else {
      this.micSyncStatus.setAttribute('data-tip', this.hasHomeEngine()
        ? 'Sync on your own DubMate to keep it for every room.'
        : 'Your browser keeps this until the host restarts DubMate.');
      this.micSyncStatus.setAttribute('tabindex', '0');
    }
    if (this.btnMicSync) {
      this.btnMicSync.textContent = ms === null ? 'Sync your mic' : 'Sync again';
      this.btnMicSync.disabled = !!(this.micSyncBusy || this.roomCheckBusy);
    }
  }

  /**
   * step: 'ready' | 'listening' | 'clicksFailed' | 'clap' | 'clapping' | 'failedQuiet' | 'failedUneven'
   * | 'failedNoisy', or null to hide the panel.
   */
  showMicSyncPanel(step) {
    this.micSyncStep = step;
    if (!this.micSyncPanel) return;
    this.micSyncPanel.style.display = step ? 'block' : 'none';
    this.micSyncPanel.classList.toggle('is-error', ERROR_STEPS.has(step));
    if (this.micSyncMessage) this.micSyncMessage.textContent = step ? PANEL_COPY[step] : '';
    const clicks = CLICK_STEPS.has(step);
    if (this.btnStartMicSync) {
      this.btnStartMicSync.style.display = clicks ? '' : 'none';
      this.btnStartMicSync.disabled = step === 'listening';
      this.btnStartMicSync.textContent = START_LABEL[step] || START_LABEL.ready;
    }
    if (this.btnClapInstead) this.btnClapInstead.style.display = step === 'clicksFailed' ? '' : 'none';
    if (this.btnStartClapping) {
      this.btnStartClapping.style.display = step && !clicks ? '' : 'none';
      this.btnStartClapping.disabled = step === 'clapping';
      this.btnStartClapping.textContent = step === 'clapping' ? 'Listening…' : 'Start clapping';
    }
    this.renderMicSyncRow();
    this.renderRoomCheckRow();
  }

  openMicSyncPanel() {
    if (this.micSyncBusy || this.micSyncRefused()) return;
    this.showMicSyncPanel('ready');
    if (this.btnStartMicSync) this.btnStartMicSync.focus();
  }

  // After unheard clicks: the clap test, once the headphones are back on.
  openClapStep() {
    if (this.micSyncBusy) return;
    this.showMicSyncPanel('clap');
    if (this.btnStartClapping) this.btnStartClapping.focus();
  }

  // Both record from the same microphone stream, so one waits for the other.
  micSyncRefused() {
    if (this.roomCheckBusy) {
      this.showToast('Wait for the room check to finish, then sync your mic.');
      return true;
    }
    if (this.recordState !== 'countdown' && this.recordState !== 'recording') return false;
    this.showToast('Finish your take, then sync your mic.');
    return true;
  }

  // Closes the meter's own mic stream (the meter shows the run's stream) and starts a run that Cancel can end.
  beginMicSyncRun(step) {
    this.micSyncRun++;
    this.micSyncBusy = true;
    this.pauseMeterStream();
    this.showMicSyncPanel(step);
    return this.micSyncRun;
  }

  endMicSyncRun(run) {
    if (run !== this.micSyncRun) return;
    this.micSyncBusy = false;
    this.renderMicSyncRow();
    this.renderRoomCheckRow();
    this.resumeInputMeter();
  }

  cancelMicSync() {
    const wasBusy = this.micSyncBusy;
    const wasOpen = !!this.micSyncStep;
    this.micSyncRun++;
    this.micSyncBusy = false;
    this.showMicSyncPanel(null);
    if (wasBusy) {
      if (this.audio.isRecording) Promise.resolve(this.audio.stopRecording()).catch(() => { });
      this.audio.stopAllPlayback();
      this.resumeInputMeter();
    }
    if (wasOpen && this.isAudioSettingsOpen() && this.btnMicSync) this.btnMicSync.focus();
  }

  // What the browser itself reports for this setup, in ms; each part is 0 when unknown.
  browserLatencyEstimateMs() {
    const ctx = this.audio.ctx || {};
    let trackLatency = 0;
    try {
      trackLatency = this.audio.stream.getAudioTracks()[0].getSettings().latency;
    } catch (e) { }
    const sec = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    return (sec(ctx.outputLatency) + sec(ctx.baseLatency) + sec(trackLatency)) * 1000;
  }

  // Records one pass the way a take is recorded (fresh stream, recorder, then the sound)
  // and returns its decoded first channel, or null when the run was cancelled meanwhile.
  async recordMicSyncPass(times, run, level = 1, leadSec = LEAD_SEC) {
    await this.audio.startRecording();
    if (run !== this.micSyncRun) {
      if (!this.micSyncBusy) Promise.resolve(this.audio.stopRecording()).catch(() => { });
      return null;
    }
    const estimateMs = this.browserLatencyEstimateMs();
    const end = this.audio.playClickTrain(times, leadSec, level);
    const now = (this.audio.ctx && this.audio.ctx.currentTime) || 0;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, (end - now) * 1000) + TAIL_SEC * 1000));
    if (run !== this.micSyncRun) return null;
    const res = await this.audio.stopRecording();
    if (run !== this.micSyncRun) return null;
    const buffer = res && res.audioBuffer;
    return {
      samples: buffer ? buffer.getChannelData(0) : null,
      sampleRate: buffer ? buffer.sampleRate : 0,
      estimateMs,
    };
  }

  async finishMicSync(run, latencyMs, method) {
    await this.saveMicSync(latencyMs, method);
    if (run !== this.micSyncRun) return;
    this.showMicSyncPanel(null);
    if (this.btnMicSync) this.btnMicSync.focus();
  }

  // Three click passes: all found, within 20 ms of each other and not below the browser's
  // own estimate. Otherwise the user is told what to try, or can clap instead.
  async runMicSync() {
    if (this.micSyncBusy || this.micSyncRefused()) return;
    const run = this.beginMicSyncRun('listening');
    try {
      const lags = [];
      let estimateMs = 0;
      for (let i = 0; i < CLICK_RUNS; i++) {
        const rec = await this.recordMicSyncPass(CLICK_TIMES_SEC, run);
        if (!rec) return;
        estimateMs = Math.max(estimateMs, rec.estimateMs);
        const found = rec.samples
          ? findClickTrainLag(rec.samples, rec.sampleRate, CLICK_TIMES_SEC, LEAD_SEC * 1000 + MAX_LATENCY_MS)
          : null;
        if (!found || !found.confident) break;
        lags.push(found.lagMs - LEAD_SEC * 1000);
      }
      const { medianMs, spreadMs } = combineRuns(lags);
      if (lags.length === CLICK_RUNS && spreadMs <= MAX_CLICK_SPREAD_MS
        && medianMs >= estimateMs - 20 && medianMs <= MAX_LATENCY_MS) {
        await this.finishMicSync(run, snapMs(medianMs), 'clicks');
      } else if (run === this.micSyncRun) {
        this.showMicSyncPanel('clicksFailed');
        if (this.btnStartMicSync) this.btnStartMicSync.focus();
      }
    } catch (err) {
      this.micSyncError(run, err, 'ready');
    } finally {
      this.endMicSyncRun(run);
    }
  }

  // Eight steady clicks; the actor claps on each. Saved when 4 claps land within 40 ms of
  // their median and few sharp sounds fall between the beats (judgeClaps).
  async runClapSync() {
    if (this.micSyncBusy || this.micSyncRefused()) return;
    const run = this.beginMicSyncRun('clapping');
    try {
      const rec = await this.recordMicSyncPass(CLAP_BEAT_SEC, run, CLAP_BEAT_LEVEL, CLAP_LEAD_SEC);
      if (!rec) return;
      const beats = CLAP_BEAT_SEC.map((t) => t + CLAP_LEAD_SEC);
      const found = rec.samples ? findClapLag(rec.samples, rec.sampleRate, beats) : null;
      const verdict = judgeClaps(found);
      if (verdict === 'ok' && found.lagMs <= MAX_LATENCY_MS) {
        await this.finishMicSync(run, snapMs(Math.max(found.lagMs, rec.estimateMs)), 'claps');
      } else if (run === this.micSyncRun) {
        this.showMicSyncPanel(CLAP_FAILED_STEP[verdict] || 'failedUneven');
        if (this.btnStartClapping) this.btnStartClapping.focus();
      }
    } catch (err) {
      this.micSyncError(run, err, 'clap');
    } finally {
      this.endMicSyncRun(run);
    }
  }

  micSyncError(run, err, step) {
    console.warn('[DubMate] Mic sync did not finish:', err?.name, err?.message, err);
    if (run !== this.micSyncRun) return;
    if (this.audio.isRecording) Promise.resolve(this.audio.stopRecording()).catch(() => { });
    this.audio.stopAllPlayback();
    this.showMicSyncPanel(step);
    this.showToast(micErrorMessage(err));
  }
}
