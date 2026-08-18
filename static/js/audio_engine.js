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
    this.abState = 'A'; // 'A' = Dub Take, 'B' = Original Reference

    // Metronome & Monitoring Settings
    this.metronomeEnabled = true;
    this.metronomeVolume = 0.20; // Gentle -14dB
    this.backingVolume = 0.65;   // 65% calibrated DAW standard

    // Shared Reverb Impulse Buffer
    this.reverbBuffer = null;
    this.masterConvolver = null;
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
  // Fast SOLA processor optimized for immediate execution with zero thread stalls
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
    const grainSize = 1024; // Fast, lightweight grain size
    const hopSize = 256;    // 75% overlap
    const grainStep = hopSize / pitchRatio;
    if (grainStep <= 0.01 || hopSize <= 0) {
      return inputBuffer;
    }

    // Pre-calculate Hann window
    const window = new Float32Array(grainSize);
    for (let i = 0; i < grainSize; i++) {
      window[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (grainSize - 1)));
    }

    for (let ch = 0; ch < numChannels; ch++) {
      const inData = inputBuffer.getChannelData(ch);
      const outData = outBuffer.getChannelData(ch);
      let outPos = 0;
      let inPos = 0.0;

      while (outPos + grainSize < inLength && inPos + grainSize < inLength) {
        const baseIn = Math.floor(inPos);
        for (let i = 0; i < grainSize; i++) {
          const sampleIdx = baseIn + Math.floor(i * pitchRatio);
          if (sampleIdx < inLength) {
            outData[outPos + i] += inData[sampleIdx] * window[i] * 0.5;
          }
        }
        outPos += hopSize;
        inPos += grainStep;
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

  // --- 4. Recording Stream Handler ---
  async requestMicrophone() {
    if (this.stream) return this.stream;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      return this.stream;
    } catch (err) {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return this.stream;
    }
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
        const res = await fetch(url, { cache: 'no-store' });
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
    this.activeTakeGain = null;
    this.activeOrigGain = null;
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

    // 3. Volume Trim Gain Node
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = Math.pow(10, gainDb / 20);
    compressor.connect(gainNode);

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
    } else {
      gainNode.connect(submixGain);
    }

    nodes.output = submixGain;
    return nodes;
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
