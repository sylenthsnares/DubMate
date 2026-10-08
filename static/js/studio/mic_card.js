// studio/mic_card.js - "Check your mic" in the lobby's rail: allow the microphone and pick
// the devices, check the level, then sync (the clicks, or claps). It replaces the Audio
// settings dialog that used to open at launch, and collapses to one line once the mic is
// set. The sync runs are mic_sync.js's; showMicSyncPanel() redraws this card as they go.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { AudioEngine } from '../audio_engine.js';
import { AUDIO_SETUP_DONE_KEY, micErrorMessage, safeStorageGet, safeStorageSet } from './audio_setup.js';
import { PANEL_COPY, START_LABEL, chosenDevice } from './mic_sync.js';
import { levelHint, levelZone } from './level_target.js';

// sessionStorage: "Skip sync" was pressed in this tab, so the card stays a line.
const SYNC_SKIPPED_KEY = 'dubmate_mic_sync_skipped';
// Audio settings' words: the meter's bands are grey, green (good) and red.
const LEVEL_HINT = levelHint().text;
const CLICK_STEPS = new Set(['ready', 'listening', 'clicksFailed']);
const METER_FLOOR_DB = -60;
const METER_FALL_DB_PER_FRAME = 0.6;

function storage(name) {
  try {
    return window[name] || null;
  } catch (e) {
    return null;
  }
}

export class MicCardMethods {
  initMicCardEvents() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    on('btn-mic-card-allow', () => this.micCardAllow());
    on('btn-mic-card-settings', () => this.openAudioSettings());
    on('btn-mic-card-change', () => this.openAudioSettings());
    on('btn-mic-card-devices-next', () => this.micCardGoTo('level', 'btn-mic-card-level-next'));
    on('btn-mic-card-level-next', () => this.micCardGoTo('sync', 'btn-mic-card-clicks'));
    on('btn-mic-card-clicks', () => this.micCardRun(() => this.runMicSync()));
    on('btn-mic-card-clapping', () => this.micCardRun(() => this.runClapSync()));
    on('btn-mic-card-clap-instead', () => {
      if (this.micSyncBusy) return;
      this.showMicSyncPanel('clap');
      document.getElementById('btn-mic-card-clapping')?.focus();
    });
    on('btn-mic-card-skip', () => this.micCardSkipSync());
    document.getElementById('mic-card-input')?.addEventListener('change', async (e) => {
      await this.applyInputDevice(e.target.value);
      this.renderMicCard();
    });
    document.getElementById('mic-card-output')?.addEventListener('change', async (e) => {
      await this.applyOutputDevice(e.target.value);
      this.renderMicCard();
    });
  }

  /** True once the mic is allowed here and synced for this mic and output, or the sync was skipped. */
  micCardDone() {
    if (!this.audioSetup?.setupComplete) return false;
    return this.currentLatencyMs() !== null || safeStorageGet(storage('sessionStorage'), SYNC_SKIPPED_KEY) === '1';
  }

  /** Draws the card for the current setup: the step it is on, or the "Mic set" line. */
  renderMicCard() {
    const card = document.getElementById('mic-card');
    if (!card || !this.audioSetup) return;
    const $ = (id) => document.getElementById(id);
    const done = this.micCardDone();
    $('mic-card-steps').hidden = done;
    $('mic-card-done').hidden = !done;
    if (done) {
      this.stopMicCardMeter();
      const synced = this.currentLatencyMs() !== null;
      const label = chosenDevice(this.audioSetup.devices?.inputs, this.audioSetup.inputId)?.label || '';
      $('mic-card-done-text').textContent = synced ? ['Mic set', label].filter(Boolean).join(' · ') : 'Mic set · not synced';
      return;
    }

    const step = this.micCardStep || 'mic';
    $('mic-card-step-mic').hidden = step !== 'mic';
    $('mic-card-step-level').hidden = step !== 'level';
    $('mic-card-step-sync').hidden = step !== 'sync';
    $('mic-card-meter').hidden = step === 'mic';

    // 1. Microphone: allow it (the only cold getUserMedia here), then choose the devices.
    // A finished setup counts when the browser can't say (Firefox, some WebViews).
    const allowed = this.audioSetup.permission === 'granted'
      || (this.audioSetup.setupComplete && this.audioSetup.permission === 'unknown');
    const allow = $('btn-mic-card-allow');
    allow.hidden = allowed;
    allow.disabled = !!this.audioSetup.requesting;
    allow.textContent = this.audioSetup.requesting ? 'Waiting for permission…'
      : (this.micCardError ? 'Try again' : 'Allow microphone');
    $('mic-card-error').hidden = !this.micCardError;
    $('mic-card-error').textContent = this.micCardError || '';
    $('btn-mic-card-settings').hidden = !this.micCardError;
    $('mic-card-devices').hidden = !allowed;
    if (allowed && step === 'mic') {
      const devices = this.audioSetup.devices || {};
      const input = $('mic-card-input');
      const output = $('mic-card-output');
      if (document.activeElement !== input) {
        this.populateDeviceSelect(input, devices.inputs, this.audioSetup.inputId, 'System default', 'Microphone');
      }
      const routable = this.audio.supportsOutputRouting();
      $('mic-card-output-row').hidden = !routable;
      if (routable && document.activeElement !== output) {
        this.populateDeviceSelect(output, devices.outputs, this.audioSetup.outputId, 'System default', 'Output');
      }
    }

    // 2. Level: the hint, or why the meter can't open the mic.
    const hint = $('mic-card-level-hint');
    hint.textContent = this.micCardMeterError || LEVEL_HINT;
    hint.classList.toggle('is-error', !!this.micCardMeterError);

    // 3. Sync: mic_sync.js's step. Its words come first, so "take your earbuds out" is read
    // before Play clicks.
    const syncStep = this.micSyncStep || 'ready';
    $('mic-card-sync-copy').textContent = PANEL_COPY[syncStep] || PANEL_COPY.ready;
    const clicks = CLICK_STEPS.has(syncStep);
    const play = $('btn-mic-card-clicks');
    play.hidden = !clicks;
    play.disabled = syncStep === 'listening';
    play.textContent = START_LABEL[syncStep] || START_LABEL.ready;
    $('btn-mic-card-clap-instead').hidden = syncStep !== 'clicksFailed';
    const clap = $('btn-mic-card-clapping');
    clap.hidden = clicks;
    clap.disabled = syncStep === 'clapping';
    clap.textContent = syncStep === 'clapping' ? 'Listening…' : 'Start clapping';

    // A friend's only task while they wait, so amber for them; the host's amber is Start
    // recording (and a friend's is Back to the booth once recording is on).
    const amber = !this.isHost({ allowDummy: true }) && this.roomState?.status === 'lobby';
    card.querySelectorAll('.mic-card-action').forEach((b) => {
      b.classList.toggle('btn-primary', amber);
      b.classList.toggle('btn-secondary', !amber);
    });

    if (step === 'mic') this.stopMicCardMeter();
    else this.startMicCardMeter();
  }

  micCardGoTo(step, focusId) {
    this.micCardStep = step;
    this.micCardMeterError = '';
    this.renderMicCard();
    document.getElementById(focusId)?.focus();
  }

  /** Allow microphone: the card's own permission request. Updates the same state as
   *  Audio settings' Allow button (requestMicAccessFromPanel) without opening it. */
  async micCardAllow() {
    if (this.audioSetup.requesting) return;
    this.audioSetup.requesting = true;
    this.micCardError = '';
    this.renderMicCard();
    try {
      await this.audio.requestMicrophone();
      // Hand the device straight back; the meter and every take open their own stream.
      this.audio.releaseMicrophone();
      this.audioSetup.permission = 'granted';
      this.audioSetup.setupComplete = true;
      safeStorageSet(storage('localStorage'), AUDIO_SETUP_DONE_KEY, '1');
      await this.refreshAudioDevices();
    } catch (err) {
      const name = (err && err.name) || '';
      this.audioSetup.permission = (name === 'NotAllowedError' || name === 'SecurityError') ? 'denied' : 'error';
      this.micCardError = micErrorMessage(err);
    } finally {
      this.audioSetup.requesting = false;
      this.updateAudioSettingsAffordance();
      this.renderMicCard();
    }
    const next = this.micCardError ? 'btn-mic-card-settings' : 'mic-card-input';
    document.getElementById(next)?.focus();
  }

  /** Play clicks / Start clapping: mic_sync.js's run; then the card's meter opens again. */
  async micCardRun(run) {
    await run();
    this.micCardMeterError = '';
    this.renderMicCard();
    // mic_sync.js moves focus to Audio settings' own Try again / Start clapping, in the
    // closed dialog: bring it back to the card's.
    if (this.isAudioSettingsOpen() || this.micCardDone()) return;
    const card = document.getElementById('mic-card');
    if (card?.contains(document.activeElement) && !document.activeElement.disabled) return;
    const next = ['btn-mic-card-clicks', 'btn-mic-card-clapping'].map((id) => document.getElementById(id))
      .find((el) => el && !el.hidden && !el.disabled);
    next?.focus();
  }

  micCardSkipSync() {
    if (this.micSyncBusy) this.cancelMicSync();
    safeStorageSet(storage('sessionStorage'), SYNC_SKIPPED_KEY, '1');
    this.renderMicCard();
    document.getElementById('btn-mic-card-change')?.focus();
  }

  // --- The card's level meter: its own loop and stream (Audio settings' meter only runs
  // while that dialog is open). While the dialog is open, or a sync run records, the card
  // leaves the mic to them and opens its stream again afterwards.

  micCardMeterLive() {
    return this.currentView === 'lobby' && (this.micCardStep === 'level' || this.micCardStep === 'sync')
      && !this.micCardDone() && !this.isDocumentHidden();
  }

  startMicCardMeter() {
    if (this.micCardRaf != null || typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (!this.micCardMeterLive()) {
        this.stopMicCardMeter();
        return;
      }
      if (this.micSyncBusy) {
        // The run's own recording stream is what the meter reads meanwhile.
        this.renderMicCardLevel();
      } else if (!this.isAudioSettingsOpen()) {
        if (this.audio.monitorAnalyser) this.renderMicCardLevel();
        else if (!this.micCardOpening && !this.micCardMeterError) this.openMicCardStream();
      }
      this.micCardRaf = requestAnimationFrame(tick);
    };
    this.micCardRaf = requestAnimationFrame(tick);
  }

  async openMicCardStream() {
    const run = this.micCardMeterRun || 0;
    this.micCardOpening = true;
    try {
      await this.audio.startInputMonitor(this.audioSetup.inputId || null);
      // Stopped while the mic was opening: close it again.
      if (run !== (this.micCardMeterRun || 0) && !this.isAudioSettingsOpen()) this.audio.stopInputMonitor();
    } catch (err) {
      if (run === (this.micCardMeterRun || 0)) {
        this.micCardMeterError = micErrorMessage(err);
        this.renderMicCard();
      }
    } finally {
      if (run === (this.micCardMeterRun || 0)) this.micCardOpening = false;
    }
  }

  stopMicCardMeter() {
    if (this.micCardRaf == null && !this.micCardOpening) return;
    this.micCardMeterRun = (this.micCardMeterRun || 0) + 1;
    this.micCardOpening = false;
    if (this.micCardRaf != null) cancelAnimationFrame(this.micCardRaf);
    this.micCardRaf = null;
    if (!this.isAudioSettingsOpen() && !this.micSyncBusy) this.audio.stopInputMonitor();
    this.micCardLevelDb = -Infinity;
    this.drawMicCardLevel(-Infinity);
  }

  renderMicCardLevel() {
    const level = this.audio.readInputLevel();
    // The peak, as Audio settings' meter and its bands; falls back slowly, so a short word
    // still reads on the meter.
    const now = level ? level.peakDb : -Infinity;
    const db = Math.max(now, (this.micCardLevelDb ?? -Infinity) - METER_FALL_DB_PER_FRAME);
    this.micCardLevelDb = db;
    this.drawMicCardLevel(level ? db : -Infinity);
  }

  drawMicCardLevel(db) {
    const meter = document.getElementById('mic-card-meter');
    if (!meter) return;
    const fill = meter.querySelector('.level-meter-fill');
    if (fill) fill.style.width = `${AudioEngine.dbToMeterPercent(db, METER_FLOOR_DB).toFixed(1)}%`;
    const zone = levelZone(db);
    ['quiet', 'good', 'loud'].forEach((z) => meter.classList.toggle(`is-${z}`, z === zone));
    meter.setAttribute('aria-valuenow', (Number.isFinite(db) ? Math.max(METER_FLOOR_DB, Math.min(0, db)) : METER_FLOOR_DB).toFixed(1));
  }
}
