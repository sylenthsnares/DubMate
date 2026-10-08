// studio/room_check.js - The room check: a few seconds of room tone the engine measures so
// noise cleanup can be tuned to the room, and the Room row in Audio settings that runs it
// and shows the report card. The pure functions below are exported for the node tests.
// RoomCheckMethods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { micErrorMessage, safeStorageGet, safeStorageSet, safeStorageRemove, setStatusState } from './audio_setup.js';
import { chosenDevice, deviceLabel } from './mic_sync.js';
import { LEVEL_GOOD_MAX_DB, LEVEL_GOOD_MIN_DB, LEVEL_QUIET_PEAK_DB } from './level_target.js';

// localStorage: one entry {profile_id, verdict, device_label, device_id, measured_at}.
const ROOM_CHECK_KEY = 'dubmate_room_check';
const ROOM_PROFILE_ID_RE = /^[0-9a-f]{12}$/;
const ROOM_VERDICTS = ['good', 'ok', 'noisy'];
// The engine drops the first 0.3 s (it can hold the click of the recording starting).
const ROOM_CHECK_MS = 3300;
const ROOM_CLICK_SEC = 0.3;
const ROOM_DEVICE_FIELD_MAX = 200;

const ROOM_ROW_COPY = {
  good: 'Quiet room. Cleanup is tuned to it.',
  ok: 'Some background noise. Cleanup is tuned to it.',
  noisy: 'Noisy room. Cleanup is tuned to it.',
};
const ROOM_CARD_COPY = {
  good: { word: 'Quiet', sentence: 'Your room is quiet. Good to record.' },
  ok: { word: 'Some noise', sentence: 'Some background noise. Cleanup will handle it.' },
  noisy: { word: 'Noisy', sentence: 'Your room is noisy. Cleanup will help, but a quieter spot will sound better.' },
};
const ROOM_PANEL_COPY = {
  ready: 'Stay quiet for 3 seconds while DubMate listens to your room.',
  listening: 'Listening… stay quiet.',
};
const ROOM_NOT_CHECKED = 'Not checked yet';
const ROOM_NEW_MIC = 'New microphone. Check your room so cleanup fits it.';
const ROOM_SAVE_FAILED = "DubMate couldn't finish the check. Try again.";
const ROOM_REFRESH_FAILED = "DubMate couldn't refresh your older takes. Try again.";

// The loudest-line check, in dB of peak, on the meter's target (level_target.js): Good is
// -10 to -6, advice aims at -8 and an "up" never lands the loudest line above -6, so a
// shout keeps its headroom.
const LOUD_TARGET_DB = -8;
const LOUD_UP_CEILING_DB = LEVEL_GOOD_MAX_DB;
const LOUD_CLIP_DB = -0.1;
// Below the quiet peak, or this close to the room, nobody spoke.
const LOUD_MIN_ABOVE_ROOM_DB = 6;
const LOUD_UNHEARD = "DubMate couldn't hear you. Try again, a bit louder.";

function validRoomCheck(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.profile_id === 'string' && ROOM_PROFILE_ID_RE.test(value.profile_id)
    && ROOM_VERDICTS.includes(value.verdict)
    && typeof value.device_label === 'string' && typeof value.device_id === 'string'
    && Number.isFinite(value.measured_at);
}

/** The stored check, or null when there is none or it can't be read. */
export function readRoomCheck(store) {
  try {
    const value = JSON.parse(safeStorageGet(store, ROOM_CHECK_KEY) || 'null');
    if (!validRoomCheck(value)) return null;
    const { profile_id, verdict, device_label, device_id, measured_at } = value;
    return { profile_id, verdict, device_label, device_id, measured_at };
  } catch (e) {
    return null;
  }
}

/** Replaces the stored check; returns false (and stores nothing) for a malformed entry. */
export function writeRoomCheck(store, check) {
  if (!validRoomCheck(check)) return false;
  const { profile_id, verdict, device_label, device_id, measured_at } = check;
  safeStorageSet(store, ROOM_CHECK_KEY, JSON.stringify({ profile_id, verdict, device_label, device_id, measured_at }));
  return true;
}

export function clearRoomCheck(store) {
  safeStorageRemove(store, ROOM_CHECK_KEY);
}

/** True when the microphone in use is the one the check was made with (by label, else deviceId). */
export function checkMatchesMic(check, inputs, selectedId) {
  if (!check) return false;
  return (check.device_label || check.device_id) === deviceLabel(inputs, selectedId);
}

/** The check's id for a new take, or null when there is no check for this microphone. */
export function currentProfileId(check, inputs, selectedId) {
  return validRoomCheck(check) && checkMatchesMic(check, inputs, selectedId) ? check.profile_id : null;
}

function formatRoomDb(db) {
  const n = Math.round(db);
  return `${n < 0 ? '−' : ''}${Math.abs(n)}`;
}

// Hum harmonics are covered by the hum line; any other steady tone is a whine.
function hasOtherTone(tones, humHz) {
  return tones.some((hz) => !(humHz > 0 && Array.from({ length: 8 }, (_, k) => humHz * (k + 1))
    .some((h) => Math.abs(hz - h) <= 3)));
}

/**
 * What the report card shows for an engine report: {light, word, sentence, tooltip, advice,
 * unusable}. `unusable` is the reason a check saved nothing, else null. Null for a report
 * that can't be read.
 */
export function roomCardModel(report) {
  if (!report || typeof report !== 'object') return null;
  let unusable = null;
  if (report.suppressed) {
    unusable = "Your mic sounds completely silent, so something is already removing noise. Turn off Windows mic enhancements, or noise removal in your mic's app, then check again.";
  } else if (report.clipped) {
    unusable = 'Something was very loud while DubMate listened. Check again in a quiet moment.';
  }
  const light = ROOM_VERDICTS.includes(report.verdict) ? report.verdict : null;
  if (!light && !unusable) return null;

  let tooltip = '';
  if (Number.isFinite(report.speech_floor_db)) {
    tooltip = `Background noise: ${formatRoomDb(report.speech_floor_db)} dB.`;
    if (report.rumble_share > 0.5) tooltip += ' Low rumble is removed automatically.';
  }
  const advice = [];
  const humHz = Number.isFinite(report.hum_hz) ? report.hum_hz : null;
  const tones = Array.isArray(report.tones_hz) ? report.tones_hz.filter(Number.isFinite) : [];
  if (humHz) advice.push(`Mains hum at ${Math.round(humHz)} Hz: check cables, USB hub or ground loop. Cleanup removes most of it.`);
  if (hasOtherTone(tones, humHz)) advice.push('A steady whine, like a fan or a computer. Cleanup removes it; moving away from it helps too.');
  if (report.hiss) advice.push("Your mic hisses. Turn up the gain on the mic or interface, and turn down the level in your computer's sound settings.");
  if (report.unstable) advice.push('The noise kept changing. Check again in a quiet moment.');

  const copy = light ? ROOM_CARD_COPY[light] : { word: '', sentence: '' };
  return { light, word: copy.word, sentence: copy.sentence, tooltip, advice, unusable };
}

/**
 * The peak and the speech level of a recording, in dB: the level is the mean power of the
 * 100 ms frames within 20 dB of the loudest one, so pauses don't pull it down.
 */
export function clipLevels(samples, sampleRate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const frame = Math.max(1, Math.round(sampleRate * 0.1));
  const powers = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += samples[i] * samples[i];
    powers.push(sum / frame);
  }
  if (!powers.length || peak === 0) return { peakDb: -Infinity, voiceDb: -Infinity };
  const loudest = Math.max(...powers);
  const loud = powers.filter((p) => p >= loudest / 100);
  return {
    peakDb: 20 * Math.log10(peak),
    voiceDb: 10 * Math.log10(loud.reduce((a, b) => a + b, 0) / loud.length),
  };
}

/**
 * Level advice for a loudest line: {text, snrText}. `floorDb` is the room's background
 * noise from the check (null when unknown); snrText is '' when it can't be worked out.
 */
export function loudLineAdvice(peakDb, voiceDb, floorDb) {
  const known = (v) => typeof v === 'number' && Number.isFinite(v);
  const aboveRoom = known(voiceDb) && known(floorDb) ? voiceDb - floorDb : null;
  if (!known(peakDb) || peakDb < LEVEL_QUIET_PEAK_DB || (aboveRoom !== null && aboveRoom < LOUD_MIN_ABOVE_ROOM_DB)) {
    return { text: LOUD_UNHEARD, snrText: '' };
  }
  let text = 'Good level.';
  const down = Math.max(1, Math.round(peakDb - LOUD_TARGET_DB));
  if (peakDb >= LOUD_CLIP_DB) {
    text = `Your loudest line clips. Turn your mic down by about ${down} dB.`;
  } else if (peakDb > LEVEL_GOOD_MAX_DB) {
    text = `Turn your mic down by about ${down} dB.`;
  } else if (peakDb < LEVEL_GOOD_MIN_DB) {
    const up = Math.min(Math.round(LOUD_TARGET_DB - peakDb), Math.floor(LOUD_UP_CEILING_DB - peakDb));
    text = `Turn your mic up by about ${up} dB.`;
  }
  const snr = aboveRoom === null ? 0 : Math.round(aboveRoom);
  return { text, snrText: snr > 0 ? `Your voice is about ${snr} dB louder than the room.` : '' };
}

/**
 * How many of this person's takes with noise reduction on were cleaned with another check
 * than `profileId` (null: standard cleanup). `takesByLine` is the room state's takes.
 */
export function olderTakeCount(takesByLine, userId, profileId) {
  if (!takesByLine || typeof takesByLine !== 'object' || !userId) return 0;
  const current = profileId || null;
  let count = 0;
  for (const entry of Object.values(takesByLine)) {
    for (const take of (entry && Array.isArray(entry.takes)) ? entry.takes : []) {
      if (!take || take.user_id !== userId || !take.noise_reduction) continue;
      const made = (take.nr_settings && take.nr_settings.profile_id) || null;
      if (made !== current) count++;
    }
  }
  return count;
}

function roomCheckStorage() {
  try {
    return (typeof window !== 'undefined' && window.localStorage) || null;
  } catch (e) {
    return null;
  }
}

export class RoomCheckMethods {
  initRoomCheckEvents() {
    this.roomCheckRun = 0;
    this.roomCheckBusy = false;
    this.roomCheckStep = null;
    // The background noise of the check on the card, for the loudest-line comparison.
    this.roomCheckFloorDb = null;
    // The room whose older takes are being refreshed, or null.
    this.roomCheckRefreshingRoom = null;
    // True while my Refresh request is on its way (room state may predate it).
    this.roomCheckRefreshPosting = false;
    if (this.btnRoomCheck) this.btnRoomCheck.addEventListener('click', () => this.openRoomCheckPanel());
    if (this.btnStartRoomCheck) this.btnStartRoomCheck.addEventListener('click', () => this.runRoomCheck());
    if (this.btnCancelRoomCheck) this.btnCancelRoomCheck.addEventListener('click', () => this.cancelRoomCheck());
    if (this.btnRoomCheckStandard) this.btnRoomCheckStandard.addEventListener('click', () => this.useStandardCleanup());
    if (this.btnRoomLoudLine) this.btnRoomLoudLine.addEventListener('click', () => this.runLoudLineCheck());
    if (this.btnRoomCheckAgain) this.btnRoomCheckAgain.addEventListener('click', () => this.openRoomCheckPanel());
    if (this.btnRoomCheckRefresh) this.btnRoomCheckRefresh.addEventListener('click', () => this.refreshOlderTakes());
  }

  roomCheckInputs() {
    return (this.audioSetup.devices && this.audioSetup.devices.inputs) || [];
  }

  /** The check id a new take is cleaned with, or null for standard cleanup. */
  currentRoomProfileId() {
    return currentProfileId(readRoomCheck(roomCheckStorage()), this.roomCheckInputs(), this.audioSetup.inputId);
  }

  renderRoomCheckRow() {
    if (!this.roomCheckStatus) return;
    const check = readRoomCheck(roomCheckStorage());
    const matches = checkMatchesMic(check, this.roomCheckInputs(), this.audioSetup.inputId);
    if (!check) this.roomCheckStatus.textContent = ROOM_NOT_CHECKED;
    else this.roomCheckStatus.textContent = matches ? ROOM_ROW_COPY[check.verdict] : ROOM_NEW_MIC;
    // A noisy room, or a check made with another microphone, needs attention.
    let state = 'pending';
    if (check) state = matches && check.verdict !== 'noisy' ? 'done' : 'attention';
    setStatusState(this.roomCheckStatus, state);
    // A guest's page lives on an address that changes whenever the host restarts DubMate.
    if (this.isEngineLocal()) {
      this.roomCheckStatus.removeAttribute('data-tip');
      this.roomCheckStatus.removeAttribute('tabindex');
    } else {
      this.roomCheckStatus.setAttribute('data-tip', 'Your browser keeps this until the host restarts DubMate.');
      this.roomCheckStatus.setAttribute('tabindex', '0');
    }
    if (this.btnRoomCheck) {
      this.btnRoomCheck.textContent = check && matches ? 'Check again' : 'Check your room';
      this.btnRoomCheck.disabled = !!(this.roomCheckBusy || this.micSyncBusy);
    }
    if (this.btnRoomCheckStandard) {
      this.btnRoomCheckStandard.style.display = check ? '' : 'none';
      this.btnRoomCheckStandard.disabled = !!this.roomCheckBusy;
    }
    this.renderRoomCheckRefresh(check, !!check && !matches);
  }

  isRefreshingOlderTakes() {
    return !!this.roomCheckRefreshingRoom && this.roomCheckRefreshingRoom === (this.roomState && this.roomState.room_id);
  }

  // Offers Refresh older takes while some of my takes were cleaned with another check,
  // except when the row is asking for a check of a new microphone.
  renderRoomCheckRefresh(check, newMic) {
    if (!this.roomCheckRefresh) return;
    const refreshing = this.isRefreshingOlderTakes();
    const count = newMic ? 0 : olderTakeCount(
      this.roomState && this.roomState.takes, this.user && this.user.id, check ? check.profile_id : null);
    this.roomCheckRefresh.style.display = refreshing || count > 0 ? '' : 'none';
    if (this.roomCheckRefreshText) {
      setStatusState(this.roomCheckRefreshText, 'attention');
      const when = check ? 'before this check' : 'with an earlier room check';
      this.roomCheckRefreshText.textContent = refreshing
        ? 'Refreshing older takes…'
        : `${count} of your takes ${count === 1 ? 'was' : 'were'} cleaned ${when}.`;
    }
    if (this.btnRoomCheckRefresh) {
      this.btnRoomCheckRefresh.disabled = refreshing;
      this.btnRoomCheckRefresh.setAttribute('data-tip', check
        ? 'Cleans them again with your latest room check. Your original recordings are kept.'
        : 'Cleans them again with standard cleanup. Your original recordings are kept.');
    }
  }

  // Drops a stored check the engine no longer has (deleted, pruned, or another engine).
  async verifyRoomCheck() {
    const check = readRoomCheck(roomCheckStorage());
    if (!check) return;
    try {
      const res = await fetch(`/api/noise_profiles/${check.profile_id}`);
      if (res.status !== 404) return;
      const now = readRoomCheck(roomCheckStorage());
      if (now && now.profile_id === check.profile_id) clearRoomCheck(roomCheckStorage());
      this.renderRoomCheckRow();
    } catch (err) {
      console.warn('[DubMate] Could not look up the room check:', err);
    }
  }

  /** step: 'ready' | 'listening' | 'failed' (with `message`), or null to hide the panel. */
  showRoomCheckPanel(step, message = '') {
    this.roomCheckStep = step;
    if (!this.roomCheckPanel) return;
    this.roomCheckPanel.style.display = step ? 'block' : 'none';
    this.roomCheckPanel.classList.toggle('is-error', step === 'failed');
    if (this.roomCheckMessage) this.roomCheckMessage.textContent = step === 'failed' ? message : (ROOM_PANEL_COPY[step] || '');
    if (this.roomCheckProgress) {
      this.roomCheckProgress.style.display = step === 'listening' ? '' : 'none';
      if (step !== 'listening') this.setRoomCheckProgress(0);
    }
    if (this.btnStartRoomCheck) {
      this.btnStartRoomCheck.disabled = step === 'listening';
      this.btnStartRoomCheck.textContent = { listening: 'Listening…', failed: 'Check again' }[step] || 'Start';
    }
    this.renderRoomCheckRow();
    this.renderMicSyncRow();
  }

  setRoomCheckProgress(fraction) {
    if (this.roomCheckProgressFill) {
      this.roomCheckProgressFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    }
  }

  /** Shows the report card for a roomCardModel(), or hides it for null. */
  showRoomCard(model) {
    if (!this.roomCheckCard) return;
    this.roomCheckCard.style.display = model ? 'block' : 'none';
    this.showLoudLineResult('');
    this.setLoudLineListening(false);
    if (!model) return;
    const unusable = !!model.unusable;
    if (this.roomCheckLoud) this.roomCheckLoud.style.display = unusable ? 'none' : '';
    if (this.btnRoomCheckAgain) this.btnRoomCheckAgain.style.display = unusable ? '' : 'none';
    this.roomCheckCard.classList.toggle('is-error', unusable);
    if (this.roomCheckVerdict) this.roomCheckVerdict.style.display = unusable ? 'none' : '';
    if (this.roomCheckLight) {
      this.roomCheckLight.className = `room-check-light is-${model.light || 'none'}`;
      this.roomCheckLight.setAttribute('aria-label', model.tooltip || model.word);
      if (model.tooltip) this.roomCheckLight.setAttribute('data-tip', model.tooltip);
      else this.roomCheckLight.removeAttribute('data-tip');
    }
    if (this.roomCheckWord) this.roomCheckWord.textContent = model.word;
    if (this.roomCheckSentence) this.roomCheckSentence.textContent = unusable ? model.unusable : model.sentence;
    if (this.roomCheckAdvice) {
      this.roomCheckAdvice.replaceChildren(...(unusable ? [] : model.advice).map((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        return li;
      }));
      this.roomCheckAdvice.style.display = !unusable && model.advice.length ? '' : 'none';
    }
  }

  openRoomCheckPanel() {
    if (this.roomCheckBusy || this.roomCheckRefused()) return;
    this.showRoomCard(null);
    this.showRoomCheckPanel('ready');
    if (this.btnStartRoomCheck) this.btnStartRoomCheck.focus();
  }

  // Both record from the same microphone stream, so one waits for the other.
  roomCheckRefused() {
    if (this.micSyncBusy) {
      this.showToast('Wait for mic sync to finish, then check your room.');
      return true;
    }
    if (this.recordState !== 'countdown' && this.recordState !== 'recording') return false;
    this.showToast('Finish your take, then check your room.');
    return true;
  }

  cancelRoomCheck() {
    const wasBusy = this.roomCheckBusy;
    const wasOpen = !!this.roomCheckStep;
    this.roomCheckRun++;
    this.roomCheckBusy = false;
    this.setLoudLineListening(false);
    this.showRoomCheckPanel(null);
    if (wasBusy) {
      this.audio.cancelClip();
      this.resumeInputMeter();
    }
    if (wasOpen && this.isAudioSettingsOpen() && this.btnRoomCheck) this.btnRoomCheck.focus();
  }

  // Records the room, has the engine measure it, keeps the check when it can be used and
  // shows the card. The previous check is removed from the engine once a new one is kept.
  async runRoomCheck() {
    if (this.roomCheckBusy || this.roomCheckRefused()) return;
    const run = ++this.roomCheckRun;
    this.roomCheckBusy = true;
    this.pauseMeterStream();
    this.showRoomCheckPanel('listening');
    try {
      await this.updateAudioDeviceList();
      const device = chosenDevice(this.roomCheckInputs(), this.audioSetup.inputId);
      const deviceId = (device && device.deviceId) || '';
      const label = (device && device.label) || '';
      let blob;
      try {
        blob = await this.audio.recordClip(ROOM_CHECK_MS, (elapsed, total) => {
          if (run === this.roomCheckRun) this.setRoomCheckProgress(elapsed / total);
        });
      } catch (err) {
        if (run !== this.roomCheckRun) return;
        console.warn('[DubMate] Room check could not record:', err?.name, err?.message, err);
        this.showRoomCheckPanel('ready');
        this.showToast(micErrorMessage(err));
        return;
      }
      if (run !== this.roomCheckRun) return;

      const form = new FormData();
      form.append('file', blob, 'room.webm');
      form.append('device_id', deviceId.slice(0, ROOM_DEVICE_FIELD_MAX));
      form.append('device_label', label.slice(0, ROOM_DEVICE_FIELD_MAX));
      let data = null;
      let failure = ROOM_SAVE_FAILED;
      try {
        const res = await fetch('/api/noise_profiles', { method: 'POST', body: form });
        const body = await res.json().catch(() => null);
        if (res.ok) data = body;
        else if (body && typeof body.detail === 'string') failure = body.detail;
      } catch (err) {
        console.warn('[DubMate] Room check did not reach the engine:', err);
      }
      const profileId = data && typeof data.profile_id === 'string' ? data.profile_id : null;
      if (run !== this.roomCheckRun) {
        // Cancelled while the engine measured it: don't leave an unused check behind.
        if (profileId) this.deleteRoomProfile(profileId);
        return;
      }
      const model = data ? roomCardModel(data.report) : null;
      if (!model) {
        this.showRoomCheckPanel('failed', failure);
        return;
      }
      if (!model.unusable && profileId) {
        const store = roomCheckStorage();
        const previous = readRoomCheck(store);
        const kept = writeRoomCheck(store, {
          profile_id: profileId, verdict: model.light, device_label: label, device_id: deviceId, measured_at: Date.now(),
        });
        if (kept && previous && previous.profile_id !== profileId) this.deleteRoomProfile(previous.profile_id);
      }
      this.showRoomCheckPanel(null);
      // A silent or clipped check measured nothing useful: the loudest line keeps comparing
      // against the check that is still in use.
      if (!model.unusable) {
        this.roomCheckFloorDb = Number.isFinite(data.report.speech_floor_db) ? data.report.speech_floor_db : null;
      }
      this.showRoomCard(model);
      if (this.btnRoomCheck) this.btnRoomCheck.focus();
    } finally {
      if (run === this.roomCheckRun) {
        this.roomCheckBusy = false;
        this.renderRoomCheckRow();
        this.renderMicSyncRow();
        this.resumeInputMeter();
      }
    }
  }

  // Best effort: a check left behind is pruned by the engine eventually.
  deleteRoomProfile(profileId) {
    fetch(`/api/noise_profiles/${profileId}`, { method: 'DELETE' }).catch((err) => {
      console.warn('[DubMate] Could not remove a room check:', err);
    });
  }

  // Use standard cleanup: forgets the check here and on the engine. Takes already cleaned
  // keep their sound until Refresh older takes, which the row then offers.
  useStandardCleanup() {
    const store = roomCheckStorage();
    const check = readRoomCheck(store);
    if (!check || this.roomCheckBusy) return;
    this.deleteRoomProfile(check.profile_id);
    clearRoomCheck(store);
    this.roomCheckFloorDb = null;
    this.showRoomCard(null);
    this.renderRoomCheckRow();
    if (this.btnRoomCheck) this.btnRoomCheck.focus();
  }

  showLoudLineResult(text) {
    if (!this.roomCheckLoudResult) return;
    this.roomCheckLoudResult.textContent = text;
    this.roomCheckLoudResult.style.display = text ? '' : 'none';
  }

  setLoudLineListening(on) {
    if (!this.btnRoomLoudLine) return;
    this.btnRoomLoudLine.disabled = on;
    this.btnRoomLoudLine.textContent = on ? 'Listening…' : 'Check your loudest line';
  }

  // Check your loudest line: 3 s measured in the browser and turned into level advice.
  // Nothing is stored or sent.
  async runLoudLineCheck() {
    if (this.roomCheckBusy || this.roomCheckRefused()) return;
    const run = ++this.roomCheckRun;
    this.roomCheckBusy = true;
    this.pauseMeterStream();
    this.setLoudLineListening(true);
    this.showLoudLineResult('Say your loudest line now.');
    this.renderRoomCheckRow();
    this.renderMicSyncRow();
    try {
      let levels;
      try {
        const blob = await this.audio.recordClip(ROOM_CHECK_MS);
        if (run !== this.roomCheckRun) return;
        const buffer = await this.audio.decodeClip(blob);
        if (run !== this.roomCheckRun) return;
        const rate = buffer.sampleRate;
        // Skips the click of the recording starting, as the room check does.
        levels = clipLevels(buffer.getChannelData(0).subarray(Math.round(rate * ROOM_CLICK_SEC)), rate);
      } catch (err) {
        if (run !== this.roomCheckRun) return;
        console.warn('[DubMate] Loudest line check could not record:', err?.name, err?.message, err);
        this.showLoudLineResult('');
        this.showToast(micErrorMessage(err));
        return;
      }
      const advice = loudLineAdvice(levels.peakDb, levels.voiceDb, this.roomCheckFloorDb);
      this.showLoudLineResult([advice.text, advice.snrText].filter(Boolean).join(' '));
    } finally {
      if (run === this.roomCheckRun) {
        this.roomCheckBusy = false;
        this.setLoudLineListening(false);
        this.renderRoomCheckRow();
        this.renderMicSyncRow();
        this.resumeInputMeter();
      }
    }
  }

  // Refresh older takes: the engine moves my takes to the current check (or standard
  // cleanup) and re-cleans them in the background; cleanup_refreshed says when it's done.
  async refreshOlderTakes() {
    if (this.isRefreshingOlderTakes() || !this.roomState || !this.user) return;
    const check = readRoomCheck(roomCheckStorage());
    const roomId = this.roomState.room_id;
    this.roomCheckRefreshingRoom = roomId;
    this.roomCheckRefreshPosting = true;
    this.renderRoomCheckRow();
    let failure = null;
    try {
      const res = await fetch(`/api/rooms/${roomId}/cleanup/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: this.user.id, noise_profile_id: check ? check.profile_id : null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body && typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`;
        failure = this.friendlyError(new Error(detail), ROOM_REFRESH_FAILED);
      }
    } catch (err) {
      failure = this.friendlyError(err, ROOM_REFRESH_FAILED);
    } finally {
      this.roomCheckRefreshPosting = false;
    }
    if (failure === null) return;
    if (this.roomCheckRefreshingRoom === roomId) this.roomCheckRefreshingRoom = null;
    this.showToast(failure);
    this.renderRoomCheckRow();
  }

  /**
   * Follows the room state's list of people whose older takes are being refreshed, so a
   * tab that missed cleanup_refreshed (a dropped socket) stops showing the refresh, and a
   * reloaded one shows a refresh still running. Not while my request is on its way.
   */
  syncRefreshingFromState() {
    const state = this.roomState;
    if (!state || !this.user || this.roomCheckRefreshPosting || !Array.isArray(state.cleanup_refreshing)) return;
    const running = state.cleanup_refreshing.includes(this.user.id);
    if (running === this.isRefreshingOlderTakes()) return;
    this.roomCheckRefreshingRoom = running ? state.room_id : null;
    this.renderRoomCheckRow();
  }

  /** The cleanup_refreshed message: my older takes are done. Takes that failed keep their sound. */
  onCleanupRefreshed(data) {
    if (!this.applyIncomingState(data)) return;
    if (!this.user || !data.payload || data.payload.user_id !== this.user.id) return;
    this.roomCheckRefreshingRoom = null;
    const failed = Number(data.payload.failed) || 0;
    this.showToast(failed > 0
      ? `DubMate couldn't refresh ${failed} of your older takes. Try again.`
      : 'Older takes refreshed.');
    this.renderRoomCheckRow();
  }
}
