// studio/mic_sync.js - Mic sync: the measured delay of this microphone and output pair,
// remembered per pair and used as a new take's starting timing.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { safeStorageGet, safeStorageSet } from './audio_setup.js';
import { devicePairKey, snapMs } from './timing.js';

// localStorage: {"<mic>|<output>": {latency_ms, method, measured_at}}.
const MIC_SYNC_KEY = 'dubmate_mic_sync';
// sessionStorage prefix: the "please sync" toast was shown for this pair in this tab.
const MIC_SYNC_ASKED_KEY = 'dubmate_mic_sync_asked:';
const MAX_LATENCY_MS = 800;

function webStorage(name) {
  try {
    return (typeof window !== 'undefined' && window[name]) || null;
  } catch (e) {
    return null;
  }
}

function validEntry(entry) {
  return !!entry && typeof entry === 'object' && Number.isFinite(entry.latency_ms)
    && entry.latency_ms >= 0 && entry.latency_ms <= MAX_LATENCY_MS;
}

// The chosen device, else the system default entry, else the first one listed.
function deviceLabel(list, selectedId) {
  const devices = Array.isArray(list) ? list : [];
  const device = (selectedId && devices.find((d) => d.deviceId === selectedId))
    || devices.find((d) => d.deviceId === 'default') || devices[0];
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
  takeSavedMessage() {
    const plain = 'Take saved';
    if (!this.isEngineLocal() || this.currentLatencyMs() !== null) return plain;
    const asked = MIC_SYNC_ASKED_KEY + this.currentDevicePairKey();
    if (!this.micSyncAsked) this.micSyncAsked = new Set();
    if (this.micSyncAsked.has(asked) || safeStorageGet(webStorage('sessionStorage'), asked) === '1') return plain;
    this.micSyncAsked.add(asked);
    safeStorageSet(webStorage('sessionStorage'), asked, '1');
    return 'Take saved. Sync your mic in Audio settings so takes line up on their own.';
  }
}
