// audio_engine.js - High-Performance Voice DSP Engine, Lightweight Pitch Shifting & Shared Mix Busses

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.stream = null;

    // Buffer Caches & In-Flight Request Deduplication
    this.bufferCache = new Map();
    this.pitchShiftCache = new Map();
    this.inFlightRequests = new Map();

    // Active Audio Nodes
    this.currentPlayingNodes = [];
    this.activeTakeGain = null;
    this.activeOrigGain = null;
    this.activeDSPNodes = null;
    this.abState = 'A'; // 'A' = Dub Take, 'B' = Original Reference

    // Metronome & Monitoring Settings
    this.metronomeEnabled = true;
    this.metronomeVolume = 0.20; // Gentle -14dB
    this.backingVolume = 0.65;   // 65% calibrated DAW standard

    // Shared Reverb Impulse Buffer
    this.reverbBuffer = null;
    this.masterConvolver = null;

    // --- Device Routing (see setPreferredInputDevice / setPreferredOutputDevice) ---
    // preferredInputId is fed into the getUserMedia deviceId constraint.
    // preferredOutputId is applied to <audio>/<video> elements via setSinkId().
    // Both are `null` for "system default", which is also the safe fallback
    // whenever a remembered device has been unplugged.
    this.preferredInputId = null;
    this.preferredOutputId = null;
    this.activeInputDeviceId = null;
    this.lastInputFallbackReason = null;

    // Live Input Level Monitor (settings meter only, never routed to speakers)
    this.monitorStream = null;
    this.monitorSource = null;
    this.monitorAnalyser = null;
    this.monitorFloatData = null;
    this.monitorByteData = null;
    this.monitorDeviceId = null;
    this.monitorDidFallBack = false;
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
        if (this.ctx) {
          this._generateReverbImpulse(1.5, 0.5, 20); // Default studio room
        }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  // --- 1. Algorithmic Acoustic Room Impulse Generator ---
  _generateReverbImpulse(decaySec = 1.5, roomSize = 0.5, preDelayMs = 20) {
    if (!this.ctx) return null;
    const rate = this.ctx.sampleRate;
    const totalDuration = Math.min(2.0, Math.max(0.2, decaySec)); // Cap at 2.0s for zero CPU drag
    const length = Math.floor(rate * totalDuration);
    const preDelaySamples = Math.floor(rate * (preDelayMs / 1000.0));

    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    const decayConstant = 3.2 / Math.max(0.1, decaySec);
    const diffusion = 0.5 + roomSize * 0.45;

    let sumSqL = 0;
    let sumSqR = 0;

    for (let i = 0; i < length; i++) {
      if (i < preDelaySamples) {
        left[i] = 0;
        right[i] = 0;
        continue;
      }

      const t = (i - preDelaySamples) / rate;
      const envelope = Math.exp(-decayConstant * t);

      // Stereo decorrelated diffusion
      const noiseL = (Math.random() * 2 - 1) * envelope;
      const noiseR = (Math.random() * 2 - 1) * envelope;

      const sL = noiseL * (1.0 - diffusion * 0.2) + noiseR * (diffusion * 0.2);
      const sR = noiseR * (1.0 - diffusion * 0.2) + noiseL * (diffusion * 0.2);
      left[i] = sL;
      right[i] = sR;
      sumSqL += sL * sL;
      sumSqR += sR * sR;
    }

    // Normalize impulse response to unit L2 energy for exact mathematical parity with DSP render
    const normL = Math.sqrt(sumSqL) || 1.0;
    const normR = Math.sqrt(sumSqR) || 1.0;
    for (let i = 0; i < length; i++) {
      left[i] /= normL;
      right[i] /= normR;
    }

    this.reverbBuffer = impulse;
    return this.reverbBuffer;
  }

  updateReverbImpulse(decaySec = 1.5, roomSize = 0.5, preDelayMs = 20) {
    if (!this.ctx) this.initContext();
    return this._generateReverbImpulse(decaySec, roomSize, preDelayMs);
  }

  // --- 2. High-Speed Time-Invariant Pitch Shifter ---
  // Pure time-invariant rotating overlap-add crossfader with linear sub-sample interpolation.
  // Preserves 100% exact phrase duration, zero speed variation, with seamless phrase synchronicity.
  pitchShiftBuffer(inputBuffer, pitchSemitones) {
    if (!inputBuffer || Math.abs(pitchSemitones) < 0.05) {
      return inputBuffer;
    }

    const cacheKey = `${inputBuffer.duration}_${inputBuffer.length}_${pitchSemitones.toFixed(2)}`;
    if (this.pitchShiftCache.has(cacheKey)) {
      return this.pitchShiftCache.get(cacheKey);
    }

    this.initContext();
    const numChannels = inputBuffer.numberOfChannels;
    const sampleRate = inputBuffer.sampleRate;
    const inLength = inputBuffer.length;
    const outBuffer = this.ctx.createBuffer(numChannels, inLength, sampleRate);

    const pitchRatio = Math.max(0.25, Math.min(4.0, Math.pow(2.0, pitchSemitones / 12.0)));
    // Optimal window size for human speech vocals (~46ms at 44.1k/48k)
    const D = 2048.0;
    const halfD = D / 2.0;
    const twoPiOverD = (2.0 * Math.PI) / D;
    const rateDiff = pitchRatio - 1.0;

    for (let ch = 0; ch < numChannels; ch++) {
      const inData = inputBuffer.getChannelData(ch);
      const outData = outBuffer.getChannelData(ch);

      for (let n = 0; n < inLength; n++) {
        // Dual crossfading phases separated by 180 degrees (D / 2)
        const phase1 = ((n * rateDiff) % D + D) % D;
        const phase2 = (phase1 + halfD) % D;

        // Raised-cosine / Hann windows (w1 + w2 = 1.0 strictly everywhere)
        const w1 = 0.5 * (1.0 - Math.cos(phase1 * twoPiOverD));
        const w2 = 0.5 * (1.0 - Math.cos(phase2 * twoPiOverD));

        // Sub-sample linear interpolation for Reader 1
        const f1 = n + phase1 - halfD;
        const i1 = Math.floor(f1);
        const frac1 = f1 - i1;
        const i1_0 = Math.max(0, Math.min(inLength - 1, i1));
        const i1_1 = Math.max(0, Math.min(inLength - 1, i1 + 1));
        const s1 = (1.0 - frac1) * inData[i1_0] + frac1 * inData[i1_1];

        // Sub-sample linear interpolation for Reader 2
        const f2 = n + phase2 - halfD;
        const i2 = Math.floor(f2);
        const frac2 = f2 - i2;
        const i2_0 = Math.max(0, Math.min(inLength - 1, i2));
        const i2_1 = Math.max(0, Math.min(inLength - 1, i2 + 1));
        const s2 = (1.0 - frac2) * inData[i2_0] + frac2 * inData[i2_1];

        outData[n] = w1 * s1 + w2 * s2;
      }
    }

    this.pitchShiftCache.set(cacheKey, outBuffer);
    return outBuffer;
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
      throw new Error('This browser does not expose microphone capture (navigator.mediaDevices).');
    }

    const wanted = this.preferredInputId || null;
    const attempts = [];
    if (wanted) attempts.push({ audio: this._buildAudioConstraints(wanted), id: wanted });
    attempts.push({ audio: this._buildAudioConstraints(null), id: null });
    attempts.push({ audio: true, id: null });

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: attempt.audio });
        this.stream = stream;
        this.activeInputDeviceId = attempt.id;
        this.lastInputFallbackReason = (wanted && attempt.id === null)
          ? ((lastErr && lastErr.name) || 'unavailable')
          : null;
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
    if (!this.ctx) throw new Error('Web Audio is unavailable in this browser.');
    if (typeof this.ctx.createMediaStreamSource !== 'function' || typeof this.ctx.createAnalyser !== 'function') {
      throw new Error('Web Audio analyser nodes are unavailable in this browser.');
    }
    if (!this._hasMediaDevices()) {
      throw new Error('This browser does not expose microphone capture (navigator.mediaDevices).');
    }

    const wanted = (deviceId === undefined) ? (this.preferredInputId || null) : (deviceId || null);
    let stream = null;
    let didFallBack = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this._buildAudioConstraints(wanted) });
    } catch (err) {
      if (!wanted || (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))) throw err;
      stream = await navigator.mediaDevices.getUserMedia({ audio: this._buildAudioConstraints(null) });
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
    this.monitorDidFallBack = didFallBack;

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
    this.monitorDeviceId = actualId;

    return { deviceId: actualId, label: actualLabel, didFallBack };
  }

  isMonitoringInput() {
    return !!this.monitorAnalyser;
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
    this.monitorDeviceId = null;
    this.monitorDidFallBack = false;
  }

  async startRecording() {
    this.initContext();
    await this.requestMicrophone();
    this.audioChunks = [];

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = '';
        }
      }
    }

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

  // --- 4c. Calibrate Idle Room Noise Profile (1s Pre-Roll + 3s Sampling) ---
  async recordNoiseProfile(durationMs = 3000, delayMs = 1000, onProgress = null) {
    this.initContext();
    await this.requestMicrophone();

    return new Promise((resolve, reject) => {
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      }
      const options = mimeType ? { mimeType } : {};
      const recorder = new MediaRecorder(this.stream, options);
      const chunks = [];
      let isCancelled = false;

      this.currentNoiseRecorder = {
        cancel: () => {
          isCancelled = true;
          try {
            if (recorder.state === 'recording') recorder.stop();
          } catch (e) {}
          reject(new Error("Calibration cancelled by user"));
        }
      };

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        this.currentNoiseRecorder = null;
        if (isCancelled) return;
        const mime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: mime });
        resolve(blob);
      };

      recorder.onerror = (err) => {
        this.currentNoiseRecorder = null;
        reject(err);
      };

      // Phase 1: Pre-Roll Delay (Mouse click acoustic release)
      const preRollInterval = 40;
      let preRollElapsed = 0;
      if (onProgress) onProgress('preroll', 0, delayMs);

      const preRollTimer = setInterval(() => {
        if (isCancelled) {
          clearInterval(preRollTimer);
          return;
        }
        preRollElapsed += preRollInterval;
        if (onProgress) {
          onProgress('preroll', Math.min(delayMs, preRollElapsed), delayMs);
        }
        if (preRollElapsed >= delayMs) {
          clearInterval(preRollTimer);
          if (isCancelled) return;

          // Phase 2: 3-Second Room Tone Sampling
          try {
            recorder.start(50);
            let sampleElapsed = 0;
            const sampleInterval = 40;
            if (onProgress) onProgress('recording', 0, durationMs);

            const sampleTimer = setInterval(() => {
              if (isCancelled) {
                clearInterval(sampleTimer);
                return;
              }
              sampleElapsed += sampleInterval;
              if (onProgress) {
                onProgress('recording', Math.min(durationMs, sampleElapsed), durationMs);
              }
              if (sampleElapsed >= durationMs) {
                clearInterval(sampleTimer);
                try {
                  if (recorder.state === 'recording') {
                    recorder.stop();
                  }
                } catch (e) {
                  const mime = recorder.mimeType || 'audio/webm';
                  resolve(new Blob(chunks, { type: mime }));
                }
              }
            }, sampleInterval);
          } catch (err) {
            reject(err);
          }
        }
      }, preRollInterval);
    });
  }

  cancelNoiseProfileCalibration() {
    if (this.currentNoiseRecorder && typeof this.currentNoiseRecorder.cancel === 'function') {
      this.currentNoiseRecorder.cancel();
      this.currentNoiseRecorder = null;
    }
  }

  evictTakeCache(lineIndex) {
    if (lineIndex !== undefined && lineIndex !== null) {
      for (const key of Array.from(this.bufferCache.keys())) {
        if (key.includes(`/takes/${lineIndex}/audio`)) {
          this.bufferCache.delete(key);
        }
      }
    }
    this.pitchShiftCache.clear();
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
          audioBuffer = await new Promise((resolve, reject) => {
            let handled = false;
            try {
              const res = this.ctx.decodeAudioData(
                copy,
                (buf) => { if (!handled) { handled = true; resolve(buf); } },
                (err) => { if (!handled) { handled = true; reject(err); } }
              );
              if (res && typeof res.then === 'function') {
                res.then((buf) => { if (!handled) { handled = true; resolve(buf); } }).catch((err) => { if (!handled) { handled = true; reject(err); } });
              }
            } catch (e) {
              if (!handled) { handled = true; reject(e); }
            }
          });
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
    this.releaseMicrophone();
    for (const node of this.currentPlayingNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch (e) {}
    }
    this.currentPlayingNodes = [];

    // Fully tear down the previous per-preview DSP chain (high-pass filter,
    // compressor, gain trim, reverb convolver + dry/wet sends, sub-mix)
    // rather than just dropping references. buildVocalDSPChain() now returns
    // every node it creates so all of them can be disconnected here, not just
    // the 3 (input/gainNode/output) that used to be tracked. This runs before
    // previewTakeIsolated()/playOriginalReference() build a fresh chain, since
    // both call stopAllPlayback() first.
    if (this.activeDSPNodes) {
      for (const key of Object.keys(this.activeDSPNodes)) {
        const node = this.activeDSPNodes[key];
        if (node && typeof node.disconnect === 'function') {
          try { node.disconnect(); } catch (e) {}
        }
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
    this.activeDSPNodes = null;
  }

  // --- 5. Studio Vocal DSP Chain ---
  buildVocalDSPChain(options = {}) {
    const {
      pitchSemitones = 0,
      reverbWet = 0,
      gainDb = 0,
      enableLowCut = true,
      enableCompressor = true,
    } = options;

    const nodes = {};

    // 1. High-Pass Filter (80Hz low-cut)
    const highPass = this.ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = enableLowCut ? 80 : 10;
    highPass.Q.value = 0.707;
    nodes.input = highPass;

    // 2. Studio Vocal Compressor
    const compressor = this.ctx.createDynamicsCompressor();
    if (enableCompressor) {
      compressor.threshold.value = -24;
      compressor.knee.value = 12;
      compressor.ratio.value = 3.0;
      compressor.attack.value = 0.015;
      compressor.release.value = 0.150;
    } else {
      compressor.threshold.value = 0;
    }
    highPass.connect(compressor);
    nodes.compressor = compressor;

    // 3. Volume Trim Gain Node
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = Math.pow(10, gainDb / 20);
    compressor.connect(gainNode);
    nodes.gainNode = gainNode;

    // 4. Reverb Sub-Mix
    const submixGain = this.ctx.createGain();
    if (reverbWet > 0.03 && this.reverbBuffer) {
      const convolver = this.ctx.createConvolver();
      convolver.buffer = this.reverbBuffer;

      const dryGain = this.ctx.createGain();
      const wetGain = this.ctx.createGain();

      dryGain.gain.value = 1.0; // Keep vocal speech punchy and clear
      wetGain.gain.value = reverbWet * 0.70;

      gainNode.connect(dryGain);
      gainNode.connect(convolver);
      convolver.connect(wetGain);

      dryGain.connect(submixGain);
      wetGain.connect(submixGain);

      // Tracked so stopAllPlayback() can fully tear down the reverb send/
      // return chain instead of leaking it once the preview ends.
      nodes.convolver = convolver;
      nodes.dryGain = dryGain;
      nodes.wetGain = wetGain;
    } else {
      gainNode.connect(submixGain);
    }

    nodes.output = submixGain;
    return nodes;
  }

  setGain(gainDb) {
    if (this.activeDSPNodes && this.activeDSPNodes.gainNode && this.ctx) {
      try {
        const linear = Math.pow(10.0, gainDb / 20.0);
        this.activeDSPNodes.gainNode.gain.setValueAtTime(linear, this.ctx.currentTime);
      } catch (e) {}
    }
  }

  // --- 6. Isolated Preview & Real-Time A/B Switching ---
  previewTakeIsolated({
    backingBuffer,
    lineStartSec = 0,
    takeBuffer,
    origBuffer,
    offsetMs = 0,
    pitchSemitones = 0,
    reverbWet = 0,
    gainDb = 0,
    enableLowCut = true,
    enableCompressor = true,
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

    // 2. Process Vocal Take with Time-Invariant Pitch Shift
    const processedTake = this.pitchShiftBuffer(takeBuffer, pitchSemitones);

    // 3. Setup Take Vocal Chain (Channel A)
    if (processedTake) {
      const takeSource = this.ctx.createBufferSource();
      takeSource.buffer = processedTake;

      const dsp = this.buildVocalDSPChain({
        pitchSemitones,
        reverbWet,
        gainDb,
        enableLowCut,
        enableCompressor,
      });
      this.activeDSPNodes = dsp;

      this.activeTakeGain = this.ctx.createGain();
      this.activeTakeGain.gain.value = (this.abState === 'A') ? 1.0 : 0.0;

      takeSource.connect(dsp.input);
      dsp.output.connect(this.activeTakeGain);
      this.activeTakeGain.connect(this.ctx.destination);

      const takeDelay = Math.max(0, linePlayTime - previewStartSec);
      const takeSampleOffset = linePlayTime < 0 ? Math.abs(linePlayTime) : 0;
      takeSource.start(now + takeDelay, takeSampleOffset);
      this.currentPlayingNodes.push(takeSource);

      takeSource.onended = () => {
        if (onEnded) onEnded();
      };
    }

    // 4. Setup Original Reference Audio for Instant A/B Comparison (Channel B)
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
