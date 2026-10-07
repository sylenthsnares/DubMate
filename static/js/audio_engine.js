// audio_engine.js - High-Performance Voice DSP Engine, Lightweight Pitch Shifting & Shared Mix Busses
import { takeAudioKey } from './studio/takes.js';
import { clickTrainSamples } from './studio/timing.js';
import { levelGain } from './studio/voice.js';

// Booth crossfades between renders of a take (crossfadeTo).
const CROSSFADE_S = 0.03;
// A partial render hands back to the last whole render this long before it runs out.
const PREFIX_HANDBACK_S = 0.05;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.stream = null;

    // Buffer Caches & In-Flight Request Deduplication
    this.bufferCache = new Map();
    this.inFlightRequests = new Map();

    // Active Audio Nodes
    this.currentPlayingNodes = [];
    this.activeTakeGain = null;
    this.activeOrigGain = null;
    // The booth's take: its playing render, level and meter (previewTakeIsolated, crossfadeTo).
    this.takeVoice = null;
    this.abState = 'A'; // 'A' = Dub Take, 'B' = Original Reference

    // Metronome & Monitoring Settings
    this.metronomeEnabled = true;
    this.metronomeVolume = 0.20; // Gentle -14dB
    this.backingVolume = 0.65;   // 65% calibrated DAW standard

    // --- Device Routing (see setPreferredInputDevice / setPreferredOutputDevice) ---
    // preferredInputId is fed into the getUserMedia deviceId constraint.
    // preferredOutputId is applied to <audio>/<video> elements via setSinkId().
    // Both are `null` for "system default", which is also the safe fallback
    // whenever a remembered device has been unplugged.
    this.preferredInputId = null;
    this.preferredOutputId = null;
    this.activeInputDeviceId = null;

    // Live Input Level Monitor (settings meter only, never routed to speakers)
    this.monitorStream = null;
    this.monitorSource = null;
    this.monitorAnalyser = null;
    this.monitorFloatData = null;
    this.monitorByteData = null;
  }

  // --- dBFS helpers (shared with the settings level meter UI) ---
  static amplitudeToDbFS(amplitude) {
    if (!(amplitude > 0)) return -Infinity;
    return 20 * Math.log10(amplitude);
  }

  // Maps a dBFS reading onto 0..100 for a linear-in-dB meter bar.
  static dbToMeterPercent(db, floorDb = -60) {
    if (typeof db !== 'number' || !isFinite(db)) return 0;
    const span = 0 - floorDb;
    if (span <= 0) return 0;
    const clamped = Math.max(floorDb, Math.min(0, db));
    return ((clamped - floorDb) / span) * 100;
  }

  initContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        try {
          this.ctx = new AudioCtx();
        } catch (e) {
          try {
            this.ctx = new AudioCtx({ sampleRate: 44100 });
          } catch (e2) {}
        }
        // Clicks, previews and the backing track go to the chosen output from the start.
        if (this.ctx && this.preferredOutputId && typeof this.ctx.setSinkId === 'function') {
          this.ctx.setSinkId(this.preferredOutputId).catch(() => {});
        }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  // --- 3. Gentle Metronome Acoustic Pip ---
  playMetronomePip(isGo = false) {
    if (!this.metronomeEnabled) return;
    this.initContext();

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(isGo ? 1760 : 880, now);

    const peakGain = this.metronomeVolume;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (isGo ? 0.08 : 0.045));

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.09);
  }

  // Mic sync: schedules one short click per time at ctx.currentTime + leadSec + t
  // on the chosen output. Returns the context time the last click ends.
  playClickTrain(times, leadSec) {
    this.initContext();
    const ctx = this.ctx;
    const data = clickTrainSamples(ctx.sampleRate, [0]);
    const click = ctx.createBuffer(1, data.length, ctx.sampleRate);
    const channel = click.getChannelData(0);
    for (let i = 0; i < data.length; i++) channel[i] = data[i] * 0.5;
    const start = ctx.currentTime + leadSec;
    for (const t of times) {
      const source = ctx.createBufferSource();
      source.buffer = click;
      source.connect(ctx.destination);
      source.start(start + t);
      this.currentPlayingNodes.push(source);
    }
    return start + (times.length ? Math.max(...times) : 0) + data.length / ctx.sampleRate;
  }

  // --- 4. Device Enumeration & Routing ---

  _hasMediaDevices() {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  // Device labels are empty strings until microphone permission has been
  // granted, so callers should only enumerate *after* a successful
  // getUserMedia(). `labelled` reports whether real names came back.
  async enumerateAudioDevices() {
    const result = { inputs: [], outputs: [], labelled: false, supported: false };
    if (typeof navigator === 'undefined'
      || !navigator.mediaDevices
      || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      return result;
    }
    result.supported = true;

    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      console.warn('[AudioEngine] enumerateDevices failed:', err);
      return result;
    }

    for (const d of (devices || [])) {
      if (!d) continue;
      const entry = {
        deviceId: d.deviceId || '',
        label: d.label || '',
        groupId: d.groupId || '',
      };
      if (d.kind === 'audioinput') result.inputs.push(entry);
      else if (d.kind === 'audiooutput') result.outputs.push(entry);
    }
    result.labelled = result.inputs.concat(result.outputs).some((d) => !!d.label);
    return result;
  }

  async getMicPermissionState() {
    if (typeof navigator === 'undefined'
      || !navigator.permissions
      || typeof navigator.permissions.query !== 'function') {
      return 'unknown';
    }
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      return (status && status.state) ? status.state : 'unknown';
    } catch (err) {
      // Safari and several embedded webviews reject the 'microphone' name.
      return 'unknown';
    }
  }

  // Selecting the capture device. Returns true when the preference changed.
  setPreferredInputDevice(deviceId) {
    const next = deviceId || null;
    if (next === this.preferredInputId) return false;
    this.preferredInputId = next;
    // Drop any cached capture stream so the next recording opens the new
    // device. Never yank the stream out from under a live MediaRecorder.
    if (!this.isRecording) this.releaseMicrophone();
    return true;
  }

  // setSinkId() is Chromium-only at time of writing; Firefox and Safari have
  // no output routing at all, so the UI must hide the picker when this is false.
  supportsOutputRouting() {
    if (typeof window === 'undefined' || !window.HTMLMediaElement) return false;
    return typeof window.HTMLMediaElement.prototype.setSinkId === 'function';
  }

  async setPreferredOutputDevice(deviceId) {
    this.preferredOutputId = deviceId || null;
    return this.applyOutputRouting();
  }

  // Applies the remembered output device to every media element on the page
  // (plus the WebAudio graph where the browser supports it). Passing '' to
  // setSinkId resets an element back to the system default.
  async applyOutputRouting(elements = null) {
    if (!this.supportsOutputRouting()) {
      return { ok: false, reason: 'unsupported' };
    }
    const sinkId = this.preferredOutputId || '';
    const targets = elements
      || (typeof document !== 'undefined' ? Array.from(document.querySelectorAll('audio, video')) : []);

    let failure = null;
    for (const el of targets) {
      if (!el || typeof el.setSinkId !== 'function') continue;
      try {
        await el.setSinkId(sinkId);
      } catch (err) {
        failure = failure || err;
      }
    }

    // Chrome 110+ can also re-point the AudioContext itself, which is what
    // carries take previews, the metronome and the backing track.
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(sinkId);
      } catch (err) {
        failure = failure || err;
      }
    }

    if (failure) {
      return { ok: false, reason: failure.name || 'error', error: failure };
    }
    return { ok: true, deviceId: sinkId };
  }

  _buildAudioConstraints(deviceId) {
    const constraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    if (deviceId) {
      constraints.deviceId = { exact: deviceId };
    }
    return constraints;
  }

  // A device another stream just released can still be closing (Windows reports
  // NotReadableError or AbortError), so that one case is tried again once after 300 ms.
  async _getUserMediaRetry(audio) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (!err || (err.name !== 'NotReadableError' && err.name !== 'AbortError')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return navigator.mediaDevices.getUserMedia({ audio });
    }
  }

  _streamIsLive(stream) {
    if (!stream) return false;
    if (typeof stream.getAudioTracks !== 'function') return true;
    const tracks = stream.getAudioTracks();
    if (!tracks || tracks.length === 0) return false;
    return tracks.some((t) => !t.readyState || t.readyState === 'live');
  }

  // --- 4a. Recording Stream Handler ---
  // Tries the user's chosen device first, then degrades to the system default
  // (remembered device unplugged), then to a bare `{ audio: true }`.
  async requestMicrophone() {
    if (this.stream) {
      if (this.activeInputDeviceId === (this.preferredInputId || null) && this._streamIsLive(this.stream)) {
        return this.stream;
      }
      this.releaseMicrophone();
    }
    if (!this._hasMediaDevices()) {
      throw new Error("This browser can't record from a microphone.");
    }

    const wanted = this.preferredInputId || null;
    const attempts = [];
    if (wanted) attempts.push({ audio: this._buildAudioConstraints(wanted), id: wanted });
    attempts.push({ audio: this._buildAudioConstraints(null), id: null });
    attempts.push({ audio: true, id: null });

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const stream = await this._getUserMediaRetry(attempt.audio);
        this.stream = stream;
        this.activeInputDeviceId = attempt.id;
        return this.stream;
      } catch (err) {
        lastErr = err;
        // A hard permission refusal will never be fixed by retrying with a
        // looser constraint, so stop immediately and surface it to the UI.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
      }
    }

    this.stream = null;
    this.activeInputDeviceId = null;
    throw lastErr || new Error('Microphone unavailable');
  }

  // --- 4b. Live Input Level Monitor (dBFS meter source) ---
  // Opens its own short-lived stream so it never collides with, or gets torn
  // down by, the recording stream that releaseMicrophone()/stopAllPlayback()
  // manage. The analyser is deliberately NOT connected to ctx.destination:
  // monitoring must not feed the mic back into the speakers.
  async startInputMonitor(deviceId = undefined) {
    this.stopInputMonitor();
    this.initContext();
    if (!this.ctx) throw new Error("This browser can't play DubMate's audio.");
    if (typeof this.ctx.createMediaStreamSource !== 'function' || typeof this.ctx.createAnalyser !== 'function') {
      throw new Error("This browser can't show a level meter.");
    }
    if (!this._hasMediaDevices()) {
      throw new Error("This browser can't record from a microphone.");
    }

    const wanted = (deviceId === undefined) ? (this.preferredInputId || null) : (deviceId || null);
    let stream = null;
    let didFallBack = false;
    try {
      stream = await this._getUserMediaRetry(this._buildAudioConstraints(wanted));
    } catch (err) {
      if (!wanted || (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))) throw err;
      stream = await this._getUserMediaRetry(this._buildAudioConstraints(null));
      didFallBack = true;
    }

    let source = null;
    let analyser = null;
    try {
      source = this.ctx.createMediaStreamSource(stream);
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
    } catch (err) {
      try { stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); } catch (e) {}
      throw err;
    }

    const size = analyser.fftSize || 2048;
    this.monitorStream = stream;
    this.monitorSource = source;
    this.monitorAnalyser = analyser;
    this.monitorFloatData = new Float32Array(size);
    this.monitorByteData = new Uint8Array(size);

    let actualId = didFallBack ? null : wanted;
    let actualLabel = '';
    try {
      const track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
      if (track) {
        actualLabel = track.label || '';
        const settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
        if (settings && settings.deviceId) actualId = settings.deviceId;
      }
    } catch (e) {}

    return { deviceId: actualId, label: actualLabel, didFallBack };
  }

  // Returns { rms, peak, rmsDb, peakDb } for the current analyser frame,
  // or null when no monitor is running.
  readInputLevel() {
    const analyser = this.monitorAnalyser;
    if (!analyser) return null;

    let peak = 0;
    let sumSq = 0;
    let count = 0;

    if (typeof analyser.getFloatTimeDomainData === 'function' && this.monitorFloatData) {
      analyser.getFloatTimeDomainData(this.monitorFloatData);
      const data = this.monitorFloatData;
      count = data.length;
      for (let i = 0; i < count; i++) {
        const v = data[i];
        sumSq += v * v;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }
    } else if (typeof analyser.getByteTimeDomainData === 'function' && this.monitorByteData) {
      // Older WebKit builds only ship the 8-bit variant.
      analyser.getByteTimeDomainData(this.monitorByteData);
      const data = this.monitorByteData;
      count = data.length;
      for (let i = 0; i < count; i++) {
        const v = (data[i] - 128) / 128;
        sumSq += v * v;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }
    } else {
      return null;
    }

    if (!count) return null;
    const rms = Math.sqrt(sumSq / count);
    return {
      rms,
      peak,
      rmsDb: AudioEngine.amplitudeToDbFS(rms),
      peakDb: AudioEngine.amplitudeToDbFS(peak),
    };
  }

  stopInputMonitor() {
    if (this.monitorSource) {
      try { this.monitorSource.disconnect(); } catch (e) {}
    }
    if (this.monitorAnalyser) {
      try { this.monitorAnalyser.disconnect(); } catch (e) {}
    }
    if (this.monitorStream) {
      try {
        this.monitorStream.getTracks().forEach((track) => {
          try { track.stop(); } catch (e) {}
        });
      } catch (e) {}
    }
    this.monitorStream = null;
    this.monitorSource = null;
    this.monitorAnalyser = null;
    this.monitorFloatData = null;
    this.monitorByteData = null;
  }

  /** First MediaRecorder type the webview supports; '' lets the browser choose. */
  _pickRecorderMimeType() {
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  async startRecording() {
    this.initContext();
    await this.requestMicrophone();
    this.audioChunks = [];

    const mimeType = this._pickRecorderMimeType();
    const options = mimeType ? { mimeType } : {};
    this.mediaRecorder = new MediaRecorder(this.stream, options);

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.start(100);
    this.isRecording = true;
  }

  releaseMicrophone() {
    if (this.stream) {
      try {
        this.stream.getTracks().forEach((track) => {
          try { track.stop(); } catch (e) {}
        });
      } catch (e) {}
      this.stream = null;
    }
    this.activeInputDeviceId = null;
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.isRecording = false;
        this.releaseMicrophone();
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false;
        this.releaseMicrophone();
        const mime = this.mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this.audioChunks, { type: mime });
        let audioBuffer = null;
        try {
          const arrayBuffer = await blob.arrayBuffer();
          audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
        } catch (e) {}
        resolve({ blob, audioBuffer });
      };

      if (this.mediaRecorder.state === 'recording') {
        try { this.mediaRecorder.requestData(); } catch (e) {}
      }
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        this.isRecording = false;
        this.releaseMicrophone();
        resolve(null);
      }
    });
  }

  // --- 4c. A short clip from the microphone (the room check) ---
  // Resolves with the recorded Blob after `durationMs`; onProgress(elapsedMs, durationMs)
  // ticks while it records. cancelClip() rejects it. The microphone is released after unless something else is recording.
  async recordClip(durationMs, onProgress = null) {
    this.initContext();
    await this.requestMicrophone();

    return new Promise((resolve, reject) => {
      const mimeType = this._pickRecorderMimeType();
      const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});
      const chunks = [];
      let timer = null;
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.currentClip = null;
        // A take or mic sync may still be recording from the same stream.
        if (!this.isRecording) this.releaseMicrophone();
        fn();
      };

      this.currentClip = {
        cancel: () => {
          try {
            if (recorder.state === 'recording') recorder.stop();
          } catch (e) {}
          settle(() => reject(new Error('Recording cancelled')));
        },
      };
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => settle(() => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })));
      recorder.onerror = (e) => settle(() => reject((e && e.error) || new Error('Recording failed')));

      try {
        recorder.start(50);
      } catch (err) {
        settle(() => reject(err));
        return;
      }
      const startedAt = performance.now();
      if (onProgress) onProgress(0, durationMs);
      timer = setInterval(() => {
        const elapsed = Math.min(durationMs, performance.now() - startedAt);
        if (onProgress) onProgress(elapsed, durationMs);
        if (elapsed < durationMs) return;
        clearInterval(timer);
        try {
          recorder.stop();
        } catch (e) {
          settle(() => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })));
        }
      }, 40);
    });
  }

  cancelClip() {
    if (this.currentClip) this.currentClip.cancel();
  }

  /** Decodes a recordClip() blob into an AudioBuffer. */
  async decodeClip(blob) {
    this.initContext();
    return this.ctx.decodeAudioData(await blob.arrayBuffer());
  }

  /** Drops every cached version of this take's audio (any ?v=). */
  evictTakeCache(take) {
    const audioKey = takeAudioKey(take);
    if (audioKey) {
      for (const key of Array.from(this.bufferCache.keys())) {
        if (takeAudioKey({ url: key }) === audioKey) {
          this.bufferCache.delete(key);
        }
      }
    }
  }

  async loadAudioBuffer(url, bypassCache = false) {
    if (!url) return null;
    if (!bypassCache && this.bufferCache.has(url)) {
      return this.bufferCache.get(url);
    }
    if (!bypassCache && this.inFlightRequests.has(url)) {
      return this.inFlightRequests.get(url);
    }

    const fetchPromise = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn(`[AudioEngine] HTTP ${res.status} fetching ${url}`);
          return null;
        }
        const arrayBuffer = await res.arrayBuffer();
        if (!arrayBuffer || arrayBuffer.byteLength < 32) {
          return null;
        }
        this.initContext();
        if (!this.ctx) return null;

        const copy = arrayBuffer.slice(0);
        let audioBuffer = null;
        try {
          audioBuffer = await this.ctx.decodeAudioData(copy);
        } catch (decodeErr) {
          console.warn(`[AudioEngine] decodeAudioData failed (${url}):`, decodeErr);
          return null;
        }

        if (audioBuffer) {
          this.bufferCache.set(url, audioBuffer);
        }
        return audioBuffer;
      } catch (err) {
        console.warn(`[AudioEngine] Failed loading audio buffer (${url}):`, err);
        return null;
      } finally {
        this.inFlightRequests.delete(url);
      }
    })();

    if (!bypassCache) {
      this.inFlightRequests.set(url, fetchPromise);
    }
    return fetchPromise;
  }

  stopAllPlayback() {
    // Never cut the mic out from under a take in progress (e.g. an export_ready
    // arriving mid-take); abandoned takes are stopped via stopRecording().
    if (!this.isRecording) this.releaseMicrophone();
    for (const node of this.currentPlayingNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch (e) {}
    }
    this.currentPlayingNodes = [];

    // Tear down the booth take's graph (crossfade gains, level, meter) too.
    if (this.takeVoice) {
      for (const node of [...this.takeVoice.nodes, this.takeVoice.level, this.takeVoice.analyser]) {
        try { node.disconnect(); } catch (e) {}
      }
    }
    if (this.activeTakeGain && typeof this.activeTakeGain.disconnect === 'function') {
      try { this.activeTakeGain.disconnect(); } catch (e) {}
    }
    if (this.activeOrigGain && typeof this.activeOrigGain.disconnect === 'function') {
      try { this.activeOrigGain.disconnect(); } catch (e) {}
    }

    this.activeTakeGain = null;
    this.activeOrigGain = null;
    this.takeVoice = null;
  }

  /** The booth take's level, a gain after its render. */
  setGain(gainDb) {
    if (this.takeVoice && this.ctx) {
      try {
        this.takeVoice.level.gain.setValueAtTime(levelGain(gainDb), this.ctx.currentTime);
      } catch (e) {}
    }
  }

  /** The booth take's output peak in dBFS (after its level), or null when it isn't playing. */
  takeOutputDb() {
    const analyser = this.takeVoice?.analyser;
    if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') return null;
    if (!this.takeMeterData || this.takeMeterData.length !== analyser.fftSize) {
      this.takeMeterData = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.takeMeterData);
    let peak = 0;
    for (const v of this.takeMeterData) peak = Math.max(peak, Math.abs(v));
    return AudioEngine.amplitudeToDbFS(peak);
  }

  /** Where the booth take is now, in seconds of the take (negative before it starts), or null. */
  takePositionS() {
    if (!this.takeVoice || !this.ctx) return null;
    return this.ctx.currentTime - this.takeVoice.origin;
  }

  // Starts `buffer` at context time `when`, `offset` seconds into it, through its own
  // crossfade gain (starting at `gain`) into the take's level.
  _startTakeSource(buffer, when, offset, gain) {
    const tv = this.takeVoice;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const fade = this.ctx.createGain();
    fade.gain.value = gain;
    source.connect(fade);
    fade.connect(tv.level);
    source.start(when, Math.max(0, offset));
    this.currentPlayingNodes.push(source);
    tv.nodes.push(fade);
    const playing = { source, fade, buffer, readyAt: when };
    source.onended = () => {
      if (this.takeVoice === tv && tv.current === playing && tv.onEnded) tv.onEnded();
    };
    return playing;
  }

  static _equalPowerCurve(rising) {
    const curve = new Float32Array(32);
    for (let i = 0; i < curve.length; i++) {
      const t = (i / (curve.length - 1)) * (Math.PI / 2);
      curve[i] = rising ? Math.sin(t) : Math.cos(t);
    }
    return curve;
  }

  // Equal-power crossfade from `from` to `to` starting at context time `at`; `from` then stops.
  _crossfade(from, to, at) {
    to.fade.gain.setValueCurveAtTime(AudioEngine._equalPowerCurve(true), at, CROSSFADE_S);
    to.readyAt = at + CROSSFADE_S;
    if (!from) return;
    from.fade.gain.cancelScheduledValues(at);
    from.fade.gain.setValueCurveAtTime(AudioEngine._equalPowerCurve(false), at, CROSSFADE_S);
    // Some browsers refuse a second stop() (a prefix already has one for its hand-back);
    // it is silent from here on either way.
    try { from.source.stop(at + CROSSFADE_S); } catch (e) {}
  }

  /**
   * Switches the booth take to another render of it while it plays. Renders share the
   * take's timeline, so the new one starts at the current position in the take (or `atS`
   * seconds into it) with 30 ms equal-power ramps, and the old one stops. A `prefix`
   * render covers only the take's start: unless another render replaces it first, the
   * take goes back to the last whole render 50 ms before the prefix ends, so what plays
   * is always a real render. Returns false when it didn't switch.
   */
  crossfadeTo(buffer, { atS = null, prefix = false } = {}) {
    const tv = this.takeVoice;
    if (!tv || !this.ctx || !buffer) return false;
    const now = this.ctx.currentTime;

    // A hand-back already under way is what plays now; one still ahead is called off.
    if (tv.handback) {
      const { from, to, at } = tv.handback;
      tv.handback = null;
      if (now >= at) {
        tv.current = to;
      } else {
        to.source.onended = null;
        try { to.source.stop(); } catch (e) {}
        from.fade.gain.cancelScheduledValues(at);
      }
    }

    const old = tv.current;
    const at = Math.max(atS == null ? now : tv.origin + atS, now, tv.startAt, old ? old.readyAt : 0);
    const position = at - tv.origin;
    const runsOut = tv.origin + buffer.duration;   // context time the new render ends
    if (position >= buffer.duration) return false;
    if (prefix && runsOut - PREFIX_HANDBACK_S <= at + CROSSFADE_S) return false;   // ends before it's heard

    const next = this._startTakeSource(buffer, at, position, 0);
    this._crossfade(old, next, at);
    tv.current = next;

    if (!prefix) {
      tv.fullBuffer = buffer;
    } else if (tv.fullBuffer) {
      const back = runsOut - PREFIX_HANDBACK_S;
      const to = this._startTakeSource(tv.fullBuffer, back, back - tv.origin, 0);
      this._crossfade(next, to, back);
      tv.handback = { from: next, to, at: back };
      // Once the prefix has stopped, the whole render is what plays.
      next.source.onended = () => {
        if (this.takeVoice === tv && tv.current === next) {
          tv.current = to;
          tv.handback = null;
        }
      };
    }
    return true;
  }

  // --- 6. Isolated Preview & Real-Time A/B Switching ---
  // takeBuffer is the take as the engine rendered it through its voice chain (the raw
  // take while voice effects aren't installed); the level is a gain after it.
  previewTakeIsolated({
    backingBuffer,
    lineStartSec = 0,
    takeBuffer,
    origBuffer,
    offsetMs = 0,
    gainDb = 0,
    onEnded = null,
  }) {
    this.stopAllPlayback();
    this.initContext();

    const now = this.ctx.currentTime + 0.005;
    const duration = takeBuffer ? takeBuffer.duration : (origBuffer ? origBuffer.duration : 2.0);
    const offsetSec = (offsetMs || 0) / 1000.0;
    const linePlayTime = lineStartSec + offsetSec;

    // Anchor preview to the earliest of scene line start or take play time (min 0)
    const previewStartSec = Math.max(0, Math.min(lineStartSec, linePlayTime));
    const maxDuration = Math.max(duration + 1.2, (lineStartSec + (origBuffer ? origBuffer.duration : 2.0)) - previewStartSec + 0.8);

    // 1. Backing Track Sub-Bus (Isolated)
    if (backingBuffer) {
      const backingSource = this.ctx.createBufferSource();
      backingSource.buffer = backingBuffer;
      const backingGain = this.ctx.createGain();
      backingGain.gain.value = this.backingVolume;
      backingSource.connect(backingGain);
      backingGain.connect(this.ctx.destination);

      backingSource.start(now, previewStartSec, maxDuration);
      this.currentPlayingNodes.push(backingSource);
    }

    // 2. The take (Channel A): render -> crossfade gain -> level -> meter -> A/B gain
    if (takeBuffer) {
      const level = this.ctx.createGain();
      level.gain.value = levelGain(gainDb);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 2048;
      this.activeTakeGain = this.ctx.createGain();
      this.activeTakeGain.gain.value = (this.abState === 'A') ? 1.0 : 0.0;
      level.connect(analyser);
      analyser.connect(this.activeTakeGain);
      this.activeTakeGain.connect(this.ctx.destination);

      const takeDelay = Math.max(0, linePlayTime - previewStartSec);
      const takeSampleOffset = linePlayTime < 0 ? Math.abs(linePlayTime) : 0;
      const startAt = now + takeDelay;
      this.takeVoice = {
        level,
        analyser,
        nodes: [],
        origin: startAt - takeSampleOffset,   // context time of the take's first sample
        startAt,
        onEnded,
        current: null,
        fullBuffer: takeBuffer,
        handback: null,
      };
      this.takeVoice.current = this._startTakeSource(takeBuffer, startAt, takeSampleOffset, 1);
    }

    // 3. Setup Original Reference Audio for Instant A/B Comparison (Channel B)
    if (origBuffer) {
      const origSource = this.ctx.createBufferSource();
      origSource.buffer = origBuffer;

      this.activeOrigGain = this.ctx.createGain();
      this.activeOrigGain.gain.value = (this.abState === 'B') ? 1.0 : 0.0;

      origSource.connect(this.activeOrigGain);
      this.activeOrigGain.connect(this.ctx.destination);

      const origDelay = Math.max(0, lineStartSec - previewStartSec);
      origSource.start(now + origDelay);
      this.currentPlayingNodes.push(origSource);
    }

    return { previewStartSec, duration: maxDuration };
  }

  // Flip A/B instantly during preview
  setABState(state) {
    this.abState = state; // 'A' or 'B'
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.activeTakeGain) {
      this.activeTakeGain.gain.setValueAtTime(state === 'A' ? 1.0 : 0.0, now);
    }
    if (this.activeOrigGain) {
      this.activeOrigGain.gain.setValueAtTime(state === 'B' ? 1.0 : 0.0, now);
    }
  }

  // Play Original Reference Clip (Strictly isolated, no video audio bleed)
  playOriginalReference({ backingBuffer, lineStartSec, origBuffer, onEnded = null }) {
    this.stopAllPlayback();
    this.initContext();

    const now = this.ctx.currentTime + 0.005;
    const duration = origBuffer ? origBuffer.duration : 2.0;

    // Backing track
    if (backingBuffer) {
      const backingSource = this.ctx.createBufferSource();
      backingSource.buffer = backingBuffer;
      const backingGain = this.ctx.createGain();
      backingGain.gain.value = this.backingVolume;
      backingSource.connect(backingGain);
      backingGain.connect(this.ctx.destination);

      backingSource.start(now, Math.max(0, lineStartSec), duration + 0.6);
      this.currentPlayingNodes.push(backingSource);
    }

    // Original clip
    if (origBuffer) {
      const origSource = this.ctx.createBufferSource();
      origSource.buffer = origBuffer;
      const origGain = this.ctx.createGain();
      origGain.gain.value = 0.95;
      origSource.connect(origGain);
      origGain.connect(this.ctx.destination);

      origSource.start(now);
      this.currentPlayingNodes.push(origSource);

      origSource.onended = () => {
        if (onEnded) onEnded();
      };
    }
  }
}
