// studio/screening.js - Premiere screening theater: theater source, stem preload,
// balance/presence mix, host-synced playback and the sample-accurate audio schedule.
// Before the exported video is ready, each picked take plays the engine's render of its
// voice chain (no browser effects); the theater switches to the exported video when ready.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { pickedTake } from './takes.js';
import { resolveChain, levelGain } from './voice.js';

export class ScreeningMethods {
  initScreeningEvents() {
    // Screening Master Stem Balance Slider
    if (this.sliderScreeningBalance) {
      this.sliderScreeningBalance.addEventListener('input', (e) => {
        this.setScreeningBalance(parseInt(e.target.value, 10));
      });
    }

    // Master Dialogue Presence / Vocal Prominence Slider & Presets
    if (this.sliderDialoguePresence) {
      this.sliderDialoguePresence.addEventListener('input', (e) => {
        this.setMasterDialoguePresence(parseFloat(e.target.value));
      });
    }

    document.querySelectorAll('.btn-presence-preset').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const pres = parseFloat(e.currentTarget.dataset.presence || '0');
        if (this.sliderDialoguePresence) {
          this.sliderDialoguePresence.value = pres;
        }
        this.setMasterDialoguePresence(pres);
      });
    });

    // Screening Controls (Host Sync)
    this.btnScreeningPlayPause.addEventListener('click', () => this.handleScreeningPlayPause());
    this.btnScreeningReplay.addEventListener('click', () => this.handleScreeningReplay());

    // Screening Video State Listeners
    if (this.btnAspect169 && this.btnAspect916) {
      this.btnAspect169.addEventListener('click', () => {
        this.selectedAspectRatio = '16:9';
        this.btnAspect169.classList.add('active');
        this.btnAspect169.setAttribute('aria-checked', 'true');
        this.btnAspect916.classList.remove('active');
        this.btnAspect916.setAttribute('aria-checked', 'false');
        document.querySelector('.theater-player')?.classList.remove('shorts-mode');
        this.showToast("Video shape: 16:9 landscape");
      });

      this.btnAspect916.addEventListener('click', () => {
        this.selectedAspectRatio = '9:16';
        this.btnAspect916.classList.add('active');
        this.btnAspect916.setAttribute('aria-checked', 'true');
        this.btnAspect169.classList.remove('active');
        this.btnAspect169.setAttribute('aria-checked', 'false');
        document.querySelector('.theater-player')?.classList.add('shorts-mode');
        this.showToast("Video shape: 9:16 vertical");
      });
    }

    if (this.screeningVideo) {
      this.screeningVideo.addEventListener('ended', () => {
        this.pauseScreeningPlayback();
        this.screeningVideo.currentTime = 0;
      });
      this.screeningVideo.addEventListener('pause', () => {
        if (this.screeningPlayIcon) {
          this.screeningPlayIcon.innerText = '▶ Play';
        }
        if (!this.isUsingExportedVideo) {
          this.audio.stopAllPlayback();
          this.stopScreeningSyncMonitor();
        }
      });
    }
  }

  // --- Finale Screening & Host Sync Logic ---

  async setupScreeningView() {
    if (!this.roomState) return;

    const presenceVal = parseFloat(this.roomState.master_dialogue_presence_db ?? 0.0);
    this.masterDialoguePresence = presenceVal;
    this.renderPresenceUI(presenceVal);

    if (this.roomState.has_export && (this.roomState.export_video_url || this.roomState.download_url)) {
      this.applyExportedVideoToTheater();
    } else {
      this.applyLiveMixToTheater();
    }

    this.updateScreeningControls();

    // Preload screening audio in parallel non-blocking queue
    this.preloadScreeningAudio();
  }

  applyExportedVideoToTheater(directUrl = null) {
    if (!this.roomState || !this.screeningVideo) return;
    this.isUsingExportedVideo = true;
    const videoUrl = directUrl || this.roomState.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
    this.setTheaterSource(videoUrl, { muted: false });
  }

  applyLiveMixToTheater() {
    if (!this.roomState || !this.screeningVideo) return;
    this.isUsingExportedVideo = false;
    // The live mix plays the stems through Web Audio, so the pack video stays silent.
    this.setTheaterSource(this.roomState.pack.video_url, { muted: true });
  }

  /**
   * Points the theater at a video, rewinds it, and sets audio + master badge.
   * Unmuted means the source carries the finished mix (the exported video).
   */
  setTheaterSource(url, { muted }) {
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    if (!this.screeningVideo.src.endsWith(url) && this.screeningVideo.getAttribute('src') !== url) {
      this.screeningVideo.src = url;
    }
    try {
      if (this.screeningVideo.readyState >= 1) {
        this.screeningVideo.currentTime = 0;
      } else {
        this.screeningVideo.addEventListener('loadedmetadata', () => {
          try { this.screeningVideo.currentTime = 0; } catch (e) { }
        }, { once: true });
      }
    } catch (e) { }

    this.screeningVideo.muted = muted;
    this.screeningVideo.volume = muted ? 0 : 1.0;

    if (this.screeningMasterBadge) {
      this.screeningMasterBadge.style.display = muted ? 'none' : 'inline-flex';
    }
    if (this.screeningPlayIcon) {
      this.screeningPlayIcon.innerText = this.screeningVideo.paused ? '▶ Play' : '⏸ Pause';
    }
  }

  /** Where the premiere keeps a picked take's render: its audio and its resolved chain. */
  screeningRenderKey(line, take) {
    return `${take.url}|${JSON.stringify(resolveChain(this.roomState.voice, line.character, take))}`;
  }

  /** The sound a picked take plays in the premiere: its render, or the take as recorded
   *  when there is no render (voice effects not installed, or the render failed). */
  screeningTakeBuffer(line, take) {
    return this.screeningRenders.get(this.screeningRenderKey(line, take)) || this.screeningBuffers.get(take.url) || null;
  }

  isScreeningBuffersReady() {
    if (!this.roomState) return true;
    if (this.roomState.pack.backing_url && !this.screeningBuffers.has(this.roomState.pack.backing_url)) {
      return false;
    }
    for (const line of this.roomState.pack.lines) {
      const take = pickedTake(this.roomState.takes, line);
      if (take && take.url) {
        if (!this.screeningRenders.has(this.screeningRenderKey(line, take))) return false;
      } else if (line.audio_url && !this.screeningBuffers.has(line.audio_url)) {
        return false;
      }
    }
    return true;
  }

  /** Fetches a picked take's render through its resolved chain. Without one (503 while voice
   *  effects aren't installed, or a failed render) the take as recorded is loaded to play
   *  instead, and the render is asked for again on the next play. */
  async loadScreeningTake(line, take) {
    const key = this.screeningRenderKey(line, take);
    const chain = resolveChain(this.roomState.voice, line.character, take);
    try {
      const render = await this.requestTakeRender(this.roomState.room_id, line.line_id, take.take_id, chain,
        { clientId: `${this.renderClientId()}-premiere` });
      if (render.status === 200) {
        this.screeningRenders.set(key, render.buffer);
        return;
      }
    } catch (e) {
      console.warn("[App] Premiere render failed; playing the take as recorded:", e);
    }
    if (!this.screeningBuffers.has(take.url)) {
      try {
        const raw = await this.audio.loadAudioBuffer(take.url);
        if (raw) this.screeningBuffers.set(take.url, raw);
      } catch (e) { }
    }
  }

  async preloadScreeningAudio() {
    if (!this.roomState || this.isPreloadingScreening) return;
    this.isPreloadingScreening = true;

    try {
      const loadTasks = [];

      // 1. Backing track in parallel
      if (this.roomState.pack.backing_url && !this.screeningBuffers.has(this.roomState.pack.backing_url)) {
        loadTasks.push(
          this.audio.loadAudioBuffer(this.roomState.pack.backing_url)
            .then(b => {
              if (b) this.screeningBuffers.set(this.roomState.pack.backing_url, b);
            })
            .catch(() => { })
        );
      }

      // 2. Picked takes' renders and the originals of lines without a take, in parallel
      for (const line of this.roomState.pack.lines) {
        const take = pickedTake(this.roomState.takes, line);
        if (take && take.url) {
          if (!this.screeningRenders.has(this.screeningRenderKey(line, take))) {
            loadTasks.push(this.loadScreeningTake(line, take));
          }
        } else if (line.audio_url && !this.screeningBuffers.has(line.audio_url)) {
          loadTasks.push(
            this.audio.loadAudioBuffer(line.audio_url)
              .then(b => {
                if (b) this.screeningBuffers.set(line.audio_url, b);
              })
              .catch(() => { })
          );
        }
      }

      await Promise.allSettled(loadTasks);
    } catch (e) {
      console.warn("Screening preloading warning:", e);
    } finally {
      this.isPreloadingScreening = false;
    }
  }

  setScreeningBalance(val) {
    this.screeningBalance = Math.max(0, Math.min(100, val));
    if (this.valScreeningBalance) {
      if (this.screeningBalance === 50) {
        this.valScreeningBalance.innerText = 'Even';
      } else if (this.screeningBalance < 50) {
        const musicBoost = (50 - this.screeningBalance) * 2;
        this.valScreeningBalance.innerText = `More music (+${musicBoost}%)`;
      } else {
        const vocalBoost = (this.screeningBalance - 50) * 2;
        this.valScreeningBalance.innerText = `More voice (+${vocalBoost}%)`;
      }
    }
    if (this.sliderScreeningBalance) {
      this.sliderScreeningBalance.setAttribute('aria-valuenow', this.screeningBalance);
      this.sliderScreeningBalance.setAttribute('aria-valuetext', `${this.screeningBalance} percent`);
    }

    const { backingGain, vocalGain } = this.getScreeningStemGains();
    if (this.screeningBackingGainNode && this.audio.ctx) {
      this.screeningBackingGainNode.gain.setValueAtTime(backingGain, this.audio.ctx.currentTime);
    }
    if (this.screeningVocalGainNode && this.audio.ctx) {
      this.screeningVocalGainNode.gain.setValueAtTime(vocalGain, this.audio.ctx.currentTime);
    }
  }

  /** Presence label and preset highlight (and the slider, unless it is the source). */
  renderPresenceUI(db, { syncSlider = true } = {}) {
    if (syncSlider && this.sliderDialoguePresence) this.sliderDialoguePresence.value = db;
    if (this.valDialoguePresence) {
      this.valDialoguePresence.innerText = (db === 0) ? '0.0 dB (default)' : ((db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
    }
    document.querySelectorAll('.btn-presence-preset').forEach((btn) => {
      const btnVal = parseFloat(btn.dataset.presence || '0');
      btn.classList.toggle('active', Math.abs(btnVal - db) < 0.1);
    });
  }

  setMasterDialoguePresence(val) {
    this.masterDialoguePresence = Math.max(-12.0, Math.min(12.0, val));
    this.renderPresenceUI(this.masterDialoguePresence, { syncSlider: false });

    this.applyScreeningPresence();

    // Reset pre-rendered export cache since dialogue presence changed
    if (this.roomState) {
      this.roomState.has_export = false;
      this.roomState.master_dialogue_presence_db = this.masterDialoguePresence;
      this.isUsingExportedVideo = false;
      if (this.screeningMasterBadge) this.screeningMasterBadge.style.display = 'none';
    }

    if (this.socket) {
      this.socket.send('set_dialogue_presence', {
        presence_db: this.masterDialoguePresence
      });
    }
  }

  getScreeningStemGains() {
    // 0 = Backing Dominant, 50 = Balanced (0.65 backing / 0.95 vocals), 100 = Vocals Dominant
    const balanceNorm = (this.screeningBalance - 50) / 50.0; // -1.0 to +1.0
    let backingGain = 0.65;
    let vocalGain = 0.95;

    if (balanceNorm <= 0) {
      // Shifting towards backing track
      backingGain = 0.65 + (-balanceNorm) * 0.35; // 0.65 up to 1.00
      vocalGain = 0.95 * (1.0 + balanceNorm * 0.80); // 0.95 down to 0.19
    } else {
      // Shifting towards vocal dub takes
      backingGain = 0.65 * (1.0 - balanceNorm * 0.75); // 0.65 down to 0.16
      vocalGain = 0.95 + balanceNorm * 0.35; // 0.95 up to 1.30
    }

    return { backingGain, vocalGain };
  }

  /** Each playing line's level: its take's level plus dialogue presence, clamped like the
   *  export's (an original voice has level 0). */
  applyScreeningPresence() {
    if (!this.audio?.ctx) return;
    const presence = this.masterDialoguePresence || 0.0;
    for (const { node, gainDb } of this.screeningLineLevels || []) {
      node.gain.setValueAtTime(levelGain(gainDb + presence), this.audio.ctx.currentTime);
    }
  }

  updateScreeningControls() {
    if (!this.roomState) return;
    const isHost = this.isHost({ allowDummy: true });
    this.screeningHostBadge.style.display = isHost ? 'inline-block' : 'none';
    this.screeningStatusDesc.innerText = isHost
      ? "You control playback for everyone."
      : "The host controls playback. Space or Replay plays it just for you.";
  }

  async handleScreeningPlayPause() {
    if (!this.roomState) return;
    const isHost = this.isHost({ allowDummy: true });
    if (!isHost) {
      // Local preview playback fallback if not host
      if (this.screeningVideo.paused) {
        this.startScreeningPlayback(this.screeningVideo.currentTime || 0.0);
      } else {
        this.pauseScreeningPlayback();
      }
      return;
    }

    const nextAction = this.screeningVideo.paused ? 'play' : 'pause';
    this.socket.send('screening_control', {
      action: nextAction,
      timestamp: this.screeningVideo.currentTime,
    });
  }

  async handleScreeningReplay() {
    if (!this.roomState) return;
    const isHost = this.isHost({ allowDummy: true });
    if (!isHost) {
      this.screeningVideo.currentTime = 0.0;
      this.startScreeningPlayback(0.0);
      return;
    }

    this.socket.send('screening_control', {
      action: 'seek',
      timestamp: 0.0,
    });
    this.socket.send('screening_control', {
      action: 'play',
      timestamp: 0.0,
    });
  }

  async handleIncomingScreeningSync(payload) {
    if (!payload || !this.views.screening.classList.contains('active')) return;
    const { action, timestamp } = payload;

    if (action === 'seek') {
      this.screeningVideo.currentTime = timestamp || 0.0;
      if (!this.screeningVideo.paused) {
        this.startScreeningPlayback(timestamp || 0.0);
      }
    } else if (action === 'play') {
      this.startScreeningPlayback(timestamp !== undefined ? timestamp : this.screeningVideo.currentTime);
    } else if (action === 'pause') {
      this.pauseScreeningPlayback();
    }
  }

  async startScreeningPlayback(timestamp = 0.0) {
    this.stopScreeningSyncMonitor();
    this.audio.stopAllPlayback();

    this.screeningPlayIcon.innerText = '⏸ Pause';

    if (this.isUsingExportedVideo) {
      // Using Master Rendered MP4: native embedded audio is 100% in hardware sync
      this.screeningVideo.muted = false;
      this.screeningVideo.volume = 1.0;
      this.screeningVideo.currentTime = timestamp;
      try {
        await this.screeningVideo.play();
      } catch (err) {
        console.warn("Screening video play error:", err);
      }
      return;
    }

    // Live Web Audio Rehearsal / Preview Mode
    this.screeningVideo.muted = true;
    this.screeningVideo.volume = 0;
    this.audio.initContext();

    // Ensure buffers are preloaded before starting
    if (!this.isScreeningBuffersReady()) {
      await this.preloadScreeningAudio();
    }

    // Set video currentTime to exact timestamp
    this.screeningVideo.currentTime = timestamp;

    // Schedule audio with minimal lead-time (5ms)
    const scheduleLead = 0.005;
    const audioCtxStart = this.audio.ctx.currentTime + scheduleLead;

    this.scheduleScreeningAudioNodes(timestamp, audioCtxStart);

    try {
      await this.screeningVideo.play();
    } catch (err) {
      console.warn("Screening video play error:", err);
    }

    // Start sync drift monitor loop
    this.startScreeningSyncMonitor(timestamp, audioCtxStart);
  }

  pauseScreeningPlayback() {
    this.stopScreeningSyncMonitor();
    this.screeningPlayIcon.innerText = '▶ Play';
    this.screeningVideo.pause();
    if (!this.isUsingExportedVideo) {
      this.audio.stopAllPlayback();
    }
  }

  startScreeningSyncMonitor(startTime, audioCtxStart) {
    this.stopScreeningSyncMonitor();
    this.screeningSyncRafId = null;

    let lastCheckTime = performance.now();
    const checkSync = () => {
      if (this.screeningVideo.paused || this.isUsingExportedVideo) {
        return;
      }

      const now = performance.now();
      if (now - lastCheckTime >= 250) {
        lastCheckTime = now;
        const elapsedAudio = this.audio.ctx.currentTime - audioCtxStart;
        if (elapsedAudio > 0) {
          const expectedVideoTime = startTime + elapsedAudio;
          const currentVideoTime = this.screeningVideo.currentTime;
          const drift = currentVideoTime - expectedVideoTime; // positive = video is ahead, negative = video is behind

          // Micro-adjust video playbackRate instead of seeking to eliminate video decoder stalls
          if (Math.abs(drift) > 0.05 && Math.abs(drift) < 0.35) {
            if (drift > 0) {
              this.screeningVideo.playbackRate = 0.96; // Gently slow down video
            } else {
              this.screeningVideo.playbackRate = 1.04; // Gently speed up video
            }
          } else if (Math.abs(drift) >= 0.35 && !this.screeningVideo.seeking) {
            // Large drift: perform smooth hard seek
            try { this.screeningVideo.currentTime = expectedVideoTime; } catch (e) { }
            this.screeningVideo.playbackRate = 1.0;
          } else {
            this.screeningVideo.playbackRate = 1.0;
          }
        }
      }

      this.screeningSyncRafId = requestAnimationFrame(checkSync);
    };

    this.screeningSyncRafId = requestAnimationFrame(checkSync);
  }

  stopScreeningSyncMonitor() {
    if (this.screeningSyncRafId) {
      cancelAnimationFrame(this.screeningSyncRafId);
      this.screeningSyncRafId = null;
    }
    if (this.screeningVideo) {
      this.screeningVideo.playbackRate = 1.0;
    }
  }

  // Sample-Accurate Lightweight Master Screening Audio Pipeline
  scheduleScreeningAudioNodes(startTime = 0.0, audioCtxStart = 0.0) {
    const { backingGain, vocalGain } = this.getScreeningStemGains();

    // 1. Backing track
    if (this.roomState.pack.backing_url && this.screeningBuffers.has(this.roomState.pack.backing_url)) {
      const backingBuf = this.screeningBuffers.get(this.roomState.pack.backing_url);
      const backingSource = this.audio.ctx.createBufferSource();
      backingSource.buffer = backingBuf;
      const gainNode = this.audio.ctx.createGain();
      gainNode.gain.value = backingGain;
      backingSource.connect(gainNode);
      gainNode.connect(this.audio.ctx.destination);

      backingSource.start(audioCtxStart, Math.max(0, startTime));
      this.audio.currentPlayingNodes.push(backingSource);
      this.screeningBackingGainNode = gainNode;
    } else {
      this.screeningBackingGainNode = null;
    }

    // 2. Shared vocal bus (the balance); each line has its own level into it
    const masterVocalGain = this.audio.ctx.createGain();
    masterVocalGain.gain.value = vocalGain;
    masterVocalGain.connect(this.audio.ctx.destination);
    this.screeningVocalGainNode = masterVocalGain;
    this.screeningLineLevels = [];
    const presence = this.masterDialoguePresence || 0.0;
    const lineLevel = (gainDb) => {
      const node = this.audio.ctx.createGain();
      node.gain.value = levelGain(gainDb + presence);
      node.connect(masterVocalGain);
      this.screeningLineLevels.push({ node, gainDb });
      return node;
    };

    // 3. Schedule dialogue takes & unassigned original character clips
    for (const line of this.roomState.pack.lines) {
      const take = pickedTake(this.roomState.takes, line);

      const takeBuf = (take && take.url) ? this.screeningTakeBuffer(line, take) : null;
      if (takeBuf) {
        const offsetSec = (take.offset_ms || 0) / 1000.0;
        const linePlayTime = line.start + offsetSec;
        const takeDuration = takeBuf.duration || 3.0;

        // Line is audible if its sound ends after startTime
        if (linePlayTime + takeDuration > startTime) {
          const source = this.audio.ctx.createBufferSource();
          source.buffer = takeBuf;
          source.connect(lineLevel(Number(take.gain_db) || 0));

          if (linePlayTime >= startTime) {
            const delta = linePlayTime - startTime;
            source.start(audioCtxStart + delta, 0);
          } else {
            // Already started prior to startTime (e.g. negative offset or seeking mid-line)
            const offsetIntoSample = startTime - linePlayTime;
            source.start(audioCtxStart, offsetIntoSample);
          }
          this.audio.currentPlayingNodes.push(source);
        }
      } else if (line.audio_url && this.screeningBuffers.has(line.audio_url)) {
        // Unassigned or unrecorded line: Play original character voice
        const origBuf = this.screeningBuffers.get(line.audio_url);
        const duration = origBuf.duration || 3.0;
        if (line.start + duration > startTime) {
          const source = this.audio.ctx.createBufferSource();
          source.buffer = origBuf;
          source.connect(lineLevel(0));

          if (line.start >= startTime) {
            const delta = line.start - startTime;
            source.start(audioCtxStart + delta, 0);
          } else {
            const offsetIntoSample = startTime - line.start;
            source.start(audioCtxStart, offsetIntoSample);
          }
          this.audio.currentPlayingNodes.push(source);
        }
      }
    }
  }
}
