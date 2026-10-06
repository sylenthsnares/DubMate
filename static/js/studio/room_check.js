// studio/room_check.js - The room check: a few seconds of room tone the engine measures so
// noise cleanup can be tuned to the room, and the Room row in Audio settings that runs it
// and shows the report card. The pure functions below are exported for the node tests.
// RoomCheckMethods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { safeStorageGet, safeStorageSet, safeStorageRemove } from './audio_setup.js';
import { chosenDevice, deviceLabel } from './mic_sync.js';

// localStorage: one entry {profile_id, verdict, device_label, device_id, measured_at}.
const ROOM_CHECK_KEY = 'dubmate_room_check';
const ROOM_PROFILE_ID_RE = /^[0-9a-f]{12}$/;
const ROOM_VERDICTS = ['good', 'ok', 'noisy'];
// The engine drops the first 0.3 s (it can hold the click of the recording starting).
const ROOM_CHECK_MS = 3300;
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
    if (this.btnRoomCheck) this.btnRoomCheck.addEventListener('click', () => this.openRoomCheckPanel());
    if (this.btnStartRoomCheck) this.btnStartRoomCheck.addEventListener('click', () => this.runRoomCheck());
    if (this.btnCancelRoomCheck) this.btnCancelRoomCheck.addEventListener('click', () => this.cancelRoomCheck());
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
      this.btnRoomCheck.disabled = !!this.roomCheckBusy;
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
      this.btnStartRoomCheck.textContent = step === 'listening' ? 'Listening…' : 'Start';
    }
    this.renderRoomCheckRow();
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
    if (!model) return;
    const unusable = !!model.unusable;
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

  roomCheckRefused() {
    if (this.recordState !== 'countdown' && this.recordState !== 'recording') return false;
    this.showToast('Finish your take, then check your room.');
    return true;
  }

  cancelRoomCheck() {
    const wasBusy = this.roomCheckBusy;
    const wasOpen = !!this.roomCheckStep;
    this.roomCheckRun++;
    this.roomCheckBusy = false;
    this.showRoomCheckPanel(null);
    if (wasBusy) {
      this.audio.cancelClip();
      if (this.isAudioSettingsOpen()) this.startInputMeter().catch(() => { });
    }
    if (wasOpen && this.isAudioSettingsOpen() && this.btnRoomCheck) this.btnRoomCheck.focus();
  }

  // Records the room, has the engine measure it, keeps the check when it can be used and
  // shows the card. The previous check is removed from the engine once a new one is kept.
  async runRoomCheck() {
    if (this.roomCheckBusy || this.micSyncBusy || this.roomCheckRefused()) return;
    const run = ++this.roomCheckRun;
    this.roomCheckBusy = true;
    this.stopInputMeter();
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
        console.warn('[DubMate] Room check could not record:', err);
        this.showRoomCheckPanel('ready');
        this.showToast("Can't read this microphone. Try another one or press Rescan.");
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
      this.showRoomCard(model);
      if (this.btnRoomCheck) this.btnRoomCheck.focus();
    } finally {
      if (run === this.roomCheckRun) {
        this.roomCheckBusy = false;
        this.renderRoomCheckRow();
        if (this.isAudioSettingsOpen()) this.startInputMeter().catch(() => { });
      }
    }
  }

  // Best effort: a check left behind is pruned by the engine eventually.
  deleteRoomProfile(profileId) {
    fetch(`/api/noise_profiles/${profileId}`, { method: 'DELETE' }).catch((err) => {
      console.warn('[DubMate] Could not remove the previous room check:', err);
    });
  }
}
