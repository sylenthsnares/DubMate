// studio/screening.js - Premiere screening theater: theater source, stem preload,
// balance/presence mix, host-synced playback and the sample-accurate audio schedule,
// the timeline under the video and the In this dub list.
// Before the exported video is ready, each picked take plays the engine's render of its
// voice chain (no browser effects); the theater switches to the exported video when ready.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { pickedTake, lineTakes } from './takes.js';
import { resolveChain, levelGain } from './voice.js';
import { clockTime } from './export.js';
import { plural } from '../ui_common.js';

/** The Mix presets: balance (0 more music, 50 even, 100 more voice) and dialogue level in dB. */
const MIX_PRESETS = [
  { id: 'balanced', name: 'Balanced', balance: 50, presence: 0 },
  { id: 'voices', name: 'Voices forward', balance: 65, presence: 2.5 },
  { id: 'music', name: 'Music forward', balance: 35, presence: 0 },
];

export class ScreeningMethods {
  initScreeningEvents() {
    // Screening Master Stem Balance Slider
    if (this.sliderScreeningBalance) {
      this.sliderScreeningBalance.addEventListener('input', (e) => {
        this.setScreeningBalance(parseInt(e.target.value, 10), { share: true });
      });
    }

    // Master Dialogue Presence / Vocal Prominence Slider & Presets
    if (this.sliderDialoguePresence) {
      this.sliderDialoguePresence.addEventListener('input', (e) => {
        this.setMasterDialoguePresence(parseFloat(e.target.value));
      });
    }

    // Mix presets: a radio group, arrow keys move and choose (host only; members see none).
    this.mixPresetButtons.forEach((btn, i) => {
      btn.addEventListener('click', () => this.applyMixPreset(btn.dataset.preset));
      btn.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = this.mixPresetButtons[(i + step + this.mixPresetButtons.length) % this.mixPresetButtons.length];
        this.applyMixPreset(next.dataset.preset);
        next.focus();
      });
    });

    // Screening Controls (Host Sync)
    this.btnScreeningPlayPause.addEventListener('click', () => this.handleScreeningPlayPause());
    this.btnScreeningReplay.addEventListener('click', () => this.handleScreeningReplay());

    if (this.screeningVideo) {
      this.screeningVideo.addEventListener('ended', () => {
        // Rewound first, so a finished video waiting for this pause starts from 0:00.
        this.screeningVideo.currentTime = 0;
        this.pauseScreeningPlayback();
      });
      this.screeningVideo.addEventListener('pause', () => {
        this.renderScreeningPlayState(false);
        // Leaving the premiere pauses it too; the booth's playback is not the premiere's to stop.
        if (!this.isUsingExportedVideo && this.isScreeningShown()) {
          this.audio.stopAllPlayback();
          this.stopScreeningSyncMonitor();
        }
      });
      // The timeline follows the video: timeupdate, and every frame while it plays.
      this.screeningVideo.addEventListener('timeupdate', () => this.renderPremierePosition());
      this.screeningVideo.addEventListener('play', () => this.startPremiereClock());
      this.screeningVideo.addEventListener('durationchange', () => this.renderPremiereTimeline());
    }

    this.initPremiereTimeline();
  }

  /**
   * The timeline: a click or a drag seeks when let go (until then only the thumb and the
   * time move); a click on a tick seeks to its line's start. Home and End go to either end;
   * the arrows and , / . are the premiere's keys (app.js).
   */
  initPremiereTimeline() {
    const track = this.screeningTrack;
    if (!track) return;
    const timeAt = (e) => {
      const r = track.getBoundingClientRect();
      const share = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(1, share)) * this.premiereDuration();
    };
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.roomState) return;
      e.preventDefault();
      track.focus();
      try { track.setPointerCapture(e.pointerId); } catch (err) { }
      const tick = e.target.closest?.('.screening-tick');
      this.premiereDragTime = tick ? Number(tick.dataset.start) : timeAt(e);
      this.renderPremierePosition(this.premiereDragTime);
    });
    track.addEventListener('pointermove', (e) => {
      if (this.premiereDragTime === null) return;
      this.premiereDragTime = timeAt(e);
      this.renderPremierePosition(this.premiereDragTime);
    });
    track.addEventListener('pointerup', () => {
      if (this.premiereDragTime === null) return;
      const t = this.premiereDragTime;
      this.premiereDragTime = null;
      this.seekPremiere(t);
    });
    track.addEventListener('pointercancel', () => {
      this.premiereDragTime = null;
      this.renderPremierePosition();
    });
    track.addEventListener('keydown', (e) => {
      if (e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      this.seekPremiere(e.key === 'Home' ? 0 : this.premiereDuration());
    });
  }

  // --- Finale Screening & Host Sync Logic ---

  async setupScreeningView() {
    if (!this.roomState) return;
    // Files saved for editing on an earlier visit may predate a take changed since.
    this.editingSaved = { stems: false, project: false };
    this.pendingExportSwap = null;

    const presenceVal = parseFloat(this.roomState.master_dialogue_presence_db ?? 0.0);
    this.masterDialoguePresence = presenceVal;
    this.renderPresenceUI(presenceVal);
    const balance = Number(this.roomState.master_mix_balance ?? 50);
    this.setScreeningBalance(Number.isFinite(balance) ? Math.round(balance) : 50);

    if (this.exportState('16:9') === 'ready') {
      this.applyExportedVideoToTheater();
    } else {
      this.applyLiveMixToTheater();
    }

    this.updateScreeningControls();
    // In this dub starts open for the host, who picks the takes, and closed for members.
    if (this.screeningLines) this.screeningLines.open = this.isHost({ allowDummy: true });
    this.premiereDragTime = null;
    this.renderPremiereLines();

    // Preload screening audio in parallel non-blocking queue
    this.preloadScreeningAudio();
  }

  /** The premiere is the screen in view (the theater's sources are only set there: setting one
   *  stops every playing sound, the booth's take and record stream included). */
  isScreeningShown() {
    return !!this.views?.screening?.classList.contains('active');
  }

  applyExportedVideoToTheater(directUrl = null, { position = 0 } = {}) {
    if (!this.roomState || !this.screeningVideo) return;
    this.isUsingExportedVideo = true;
    const videoUrl = directUrl || this.roomState.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
    this.setTheaterSource(videoUrl, { muted: false, position });
  }

  applyLiveMixToTheater({ position = 0 } = {}) {
    if (!this.roomState || !this.screeningVideo) return;
    this.isUsingExportedVideo = false;
    // The live mix plays the stems through Web Audio, so the pack video stays silent.
    this.setTheaterSource(this.roomState.pack.video_url, { muted: true, position });
  }

  /**
   * A finished 16:9 video: it goes into the theater now if it is paused, or at the next
   * pause if the live mix is playing (never mid-play). Either way the position stays.
   * Off the premiere nothing changes here; setupScreeningView puts it in on the way back.
   */
  offerExportedVideo(videoUrl = null) {
    if (!this.roomState || !this.screeningVideo || this.isUsingExportedVideo || !this.isScreeningShown()) return;
    if (!this.screeningVideo.paused) {
      this.pendingExportSwap = videoUrl || true;
      return;
    }
    this.applyExportedVideoToTheater(videoUrl, { position: this.screeningVideo.currentTime || 0 });
    this.updateScreeningControls();
  }

  swapPendingExport() {
    if (!this.pendingExportSwap) return;
    const videoUrl = typeof this.pendingExportSwap === 'string' ? this.pendingExportSwap : null;
    this.pendingExportSwap = null;
    this.applyExportedVideoToTheater(videoUrl, { position: this.screeningVideo.currentTime || 0 });
    this.updateScreeningControls();
  }

  /**
   * Points the theater at a video at a position (0:00 by default), and sets its audio.
   * Unmuted means the source carries the finished mix (the exported video).
   */
  setTheaterSource(url, { muted, position = 0 }) {
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    if (!this.screeningVideo.src.endsWith(url) && this.screeningVideo.getAttribute('src') !== url) {
      this.screeningVideo.src = url;
    }
    const seek = () => {
      try { this.screeningVideo.currentTime = position; } catch (e) { }
    };
    if (this.screeningVideo.readyState >= 1) seek();
    else this.screeningVideo.addEventListener('loadedmetadata', seek, { once: true });

    this.screeningVideo.muted = muted;
    this.screeningVideo.volume = muted ? 0 : 1.0;

    this.renderSourceLabel();
    this.renderScreeningPlayState(!this.screeningVideo.paused);
  }

  /** "Live mix" (amber dot) while the theater plays the stems, "Final video" for the saved MP4. */
  renderSourceLabel() {
    if (!this.screeningSourceLabel) return;
    const live = !this.isUsingExportedVideo;
    this.screeningSourceLabel.classList.toggle('is-live', live);
    this.screeningSourceText.textContent = live ? 'Live mix' : 'Final video';
    // Members have no Save, so their tip doesn't mention it.
    const tip = this.isHost({ allowDummy: true }) ? 'What everyone hears now. Save makes the video from this mix.' : 'What everyone hears now.';
    if (live) this.screeningSourceLabel.setAttribute('data-tip', tip);
    else this.screeningSourceLabel.removeAttribute('data-tip');
  }

  /** Play or Pause on the one primary button (the SVG icon follows .is-playing). */
  renderScreeningPlayState(playing) {
    if (!this.btnScreeningPlayPause) return;
    this.btnScreeningPlayPause.classList.toggle('is-playing', playing);
    if (this.screeningPlayLabel) this.screeningPlayLabel.textContent = playing ? 'Pause' : 'Play';
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

  /**
   * The Mix slider (0 more music, 50 even, 100 more voice). With share, it is this user's
   * own change: the final video no longer matches, and the host's change becomes the room's,
   * which every render uses (a member's stays in their own preview).
   */
  setScreeningBalance(val, { share = false } = {}) {
    this.screeningBalance = Math.max(0, Math.min(100, Number.isFinite(val) ? val : 50));
    if (this.sliderScreeningBalance && String(this.sliderScreeningBalance.value) !== String(this.screeningBalance)) {
      this.sliderScreeningBalance.value = this.screeningBalance;
    }
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
    this.renderMixSummary();

    const { backingGain, vocalGain } = this.getScreeningStemGains();
    if (this.screeningBackingGainNode && this.audio.ctx) {
      this.screeningBackingGainNode.gain.setValueAtTime(backingGain, this.audio.ctx.currentTime);
    }
    if (this.screeningVocalGainNode && this.audio.ctx) {
      this.screeningVocalGainNode.gain.setValueAtTime(vocalGain, this.audio.ctx.currentTime);
    }

    if (share) {
      this.dropStaleExport();
      if (this.roomState) this.roomState.master_mix_balance = this.screeningBalance;
      if (this.socket && this.isHost({ allowDummy: true })) {
        // client_id: this tab ignores its own echo (app.js), another window of the host's doesn't.
        this.socket.send('set_mix_balance', { balance: this.screeningBalance, client_id: this.renderClientId() });
      }
    }
  }

  /**
   * The mix or a take changed, so a saved video is out of date: the theater plays the live
   * mix (from the same spot, still playing if it was) and Save reads "Mix changed · Save
   * again" until a new one is made. A render still running keeps its Saving…. Off the
   * premiere only the flag goes (a take changed in the booth); setupScreeningView sets the
   * theater on the way back.
   */
  dropStaleExport() {
    if (this.exportState('16:9') === 'ready') this.exportStale = true;
    if (this.roomState) {
      this.roomState.has_export = false;
      const exports = { ...(this.roomState.exports || {}) };
      for (const aspect of Object.keys(exports)) {
        if (exports[aspect] === 'ready') exports[aspect] = 'idle';
      }
      this.roomState.exports = exports;
      this.roomState.export_video_url = null;
    }
    this.pendingExportSwap = null;
    this.editingSaved = { stems: false, project: false };
    if (this.isUsingExportedVideo && this.screeningVideo && this.isScreeningShown()) {
      const playing = !this.screeningVideo.paused;
      const position = this.screeningVideo.currentTime || 0;
      this.applyLiveMixToTheater({ position });
      if (playing) this.startScreeningPlayback(position);
    }
    this.isUsingExportedVideo = false;
    this.updateScreeningControls();
  }

  /** The Fine-tune level readout (dB only there) and the slider, unless it is the source. */
  renderPresenceUI(db, { syncSlider = true } = {}) {
    if (syncSlider && this.sliderDialoguePresence) this.sliderDialoguePresence.value = db;
    const readout = (db === 0) ? '0.0 dB (default)' : ((db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
    if (this.valDialoguePresence) this.valDialoguePresence.textContent = readout;
    if (this.sliderDialoguePresence) {
      this.sliderDialoguePresence.setAttribute('aria-valuenow', db);
      this.sliderDialoguePresence.setAttribute('aria-valuetext', readout);
    }
    this.renderMixSummary();
  }

  /** The preset the room's mix matches, or null (Custom). */
  currentMixPreset() {
    const presence = this.masterDialoguePresence || 0;
    return MIX_PRESETS.find((p) => p.balance === Math.round(this.screeningBalance)
      && Math.abs(p.presence - presence) < 0.05) || null;
  }

  /** "Mix · Voices forward" (members: "· set by the host"), and which preset is checked. */
  renderMixSummary() {
    const preset = this.currentMixPreset();
    const name = preset ? preset.name : 'Custom';
    const host = this.isHost({ allowDummy: true });
    if (this.screeningMixSummary) this.screeningMixSummary.textContent = host ? `· ${name}` : `· ${name} · set by the host`;
    if (this.screeningMixMemberPreset) this.screeningMixMemberPreset.textContent = name;
    const buttons = this.mixPresetButtons || [];
    buttons.forEach((btn) => {
      const checked = !!preset && btn.dataset.preset === preset.id;
      btn.setAttribute('aria-checked', String(checked));
      btn.classList.toggle('active', checked);
      btn.tabIndex = -1;
    });
    // One tab stop: the checked preset, or the first when the mix is Custom.
    const stop = buttons.find((btn) => btn.getAttribute('aria-checked') === 'true') || buttons[0];
    if (stop) stop.tabIndex = 0;
  }

  /** A preset sets both the balance and the dialogue level, for the whole room. */
  applyMixPreset(id) {
    const preset = MIX_PRESETS.find((p) => p.id === id);
    // The preset already checked changes nothing, so the saved video stays.
    if (!preset || !this.isHost({ allowDummy: true }) || this.currentMixPreset()?.id === id) return;
    if (this.sliderDialoguePresence) this.sliderDialoguePresence.value = preset.presence;
    this.setMasterDialoguePresence(preset.presence);
    this.setScreeningBalance(preset.balance, { share: true });
  }

  setMasterDialoguePresence(val) {
    this.masterDialoguePresence = Math.max(-12.0, Math.min(12.0, val));
    this.renderPresenceUI(this.masterDialoguePresence, { syncSlider: false });

    this.applyScreeningPresence();

    this.dropStaleExport();
    if (this.roomState) this.roomState.master_dialogue_presence_db = this.masterDialoguePresence;

    // The room's level is the host's; a member's change stays in their own preview.
    if (this.socket && this.isHost({ allowDummy: true })) {
      this.socket.send('set_dialogue_presence', {
        presence_db: this.masterDialoguePresence,
        client_id: this.renderClientId(),
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

  /**
   * The status line, the failure line, the Mix (presets for the host, read-only for
   * members), the source label and Save, from the room's state.
   */
  updateScreeningControls() {
    if (!this.roomState) return;
    const isHost = this.isHost({ allowDummy: true });
    const state = this.exportState('16:9');
    const failure = state === 'failed' ? (this.exportFailures['16:9'] || 'Something went wrong.') : null;
    let status = 'The host controls playback. Space or Replay plays it just for you.';
    if (isHost) status = 'You control playback for everyone.';
    else if (state === 'processing') status = 'The host is saving the video…';
    else if (failure) status = `The video didn't save: ${failure}`;
    this.screeningStatusDesc.textContent = status;
    if (this.screeningSaveError) {
      this.screeningSaveError.hidden = !(isHost && failure);
      if (isHost && failure) this.screeningSaveErrorText.textContent = `The video didn't save: ${failure}`;
    }
    if (this.screeningMixHost) this.screeningMixHost.hidden = !isHost;
    if (this.screeningMixMember) this.screeningMixMember.hidden = isHost;
    this.renderMixSummary();
    this.renderSourceLabel();
    this.renderSaveControl();
    this.renderUpdateNotice();
  }

  /** The scene's length: the theater's video once it knows, else the pack's. */
  premiereDuration() {
    const d = this.screeningVideo?.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return Number(this.roomState?.pack?.duration) || 0;
  }

  /** A line's first cast actor (their colour marks the line), or null when unassigned. */
  premiereLineActor(line) {
    const uid = (this.roomState?.role_assignments?.[line.character] || [])[0];
    return (uid && this.roomState.users?.[uid]) || null;
  }

  /** A tick or a row's dot in its actor's colour; muted when nobody is cast. */
  paintLineMark(el, actor) {
    if (actor?.color) el.style.backgroundColor = actor.color;
    else el.classList.add('is-unassigned');
  }

  /** The ticks at each line's start, the total time, then the position. */
  renderPremiereTimeline() {
    if (!this.screeningTrack || !this.roomState) return;
    const duration = this.premiereDuration();
    const ticks = (this.roomState.pack?.lines || []).map((line) => {
      const tick = document.createElement('span');
      tick.className = 'screening-tick';
      tick.dataset.start = line.start;
      tick.style.left = `${duration > 0 ? Math.min(100, (line.start / duration) * 100) : 0}%`;
      this.paintLineMark(tick, this.premiereLineActor(line));
      return tick;
    });
    this.screeningTrackTicks.replaceChildren(...ticks);
    this.screeningTimeTotal.textContent = clockTime(duration);
    this.screeningTrack.setAttribute('aria-valuemax', String(Math.round(duration * 10) / 10));
    this.renderPremierePosition();
  }

  /** The thumb, the played part and the elapsed time at t (the video's time by default;
   *  a drag in progress owns them until it is let go). */
  renderPremierePosition(t = null) {
    if (!this.screeningTrack) return;
    if (t === null) {
      if (this.premiereDragTime !== null) return;
      t = this.screeningVideo?.currentTime || 0;
    }
    const duration = this.premiereDuration();
    const at = Math.max(0, Math.min(duration, t));
    const share = duration > 0 ? (at / duration) * 100 : 0;
    this.screeningTrackPlayed.style.width = `${share}%`;
    this.screeningTrackThumb.style.left = `${share}%`;
    this.screeningTimeElapsed.textContent = clockTime(at);
    this.screeningTrack.setAttribute('aria-valuenow', String(Math.round(at * 10) / 10));
    this.screeningTrack.setAttribute('aria-valuetext', `${clockTime(at)} of ${clockTime(duration)}`);
  }

  /** Moves the timeline every frame while the theater plays (timeupdate is only ~4 a second). */
  startPremiereClock() {
    cancelAnimationFrame(this.premiereClockRaf);
    const step = () => {
      this.renderPremierePosition();
      this.premiereClockRaf = this.screeningVideo.paused ? null : requestAnimationFrame(step);
    };
    this.premiereClockRaf = requestAnimationFrame(step);
  }

  /**
   * The one seek for the timeline, the keys and In this dub. The host's moves everyone
   * (playback carries on from there if it was playing: handleIncomingScreeningSync); a
   * member's stays on this page.
   */
  seekPremiere(t) {
    if (!this.roomState || !this.screeningVideo) return;
    const duration = this.premiereDuration();
    const at = Math.max(0, duration > 0 ? Math.min(duration, Number(t) || 0) : Number(t) || 0);
    this.renderPremierePosition(at);
    if (this.isHost({ allowDummy: true })) {
      // Paused, the thumb stays where it was let go while the room answers.
      if (this.screeningVideo.paused) this.screeningVideo.currentTime = at;
      this.socket.send('screening_control', { action: 'seek', timestamp: at });
      return;
    }
    this.screeningVideo.currentTime = at;
    if (!this.screeningVideo.paused) this.startScreeningPlayback(at);
  }

  /** , and . : the previous or next line's start. Just after a start, , goes to the one before. */
  stepPremiereLine(dir) {
    const t = this.screeningVideo?.currentTime || 0;
    const starts = (this.roomState?.pack?.lines || []).map((l) => Number(l.start))
      .filter(Number.isFinite).sort((a, b) => a - b);
    const target = dir < 0 ? starts.filter((s) => s < t - 0.25).pop() : starts.find((s) => s > t + 0.05);
    if (target !== undefined) this.seekPremiere(target);
  }

  /**
   * In this dub: each line's actor and take ("Take 3", the number the TAKES card shows, or
   * the original voice). A row click seeks there, and Change take (Record on a line with no
   * takes yet) shows where this user may pick the take. The summary counts the lines that
   * use the original voice. The timeline's ticks follow the same casting. A rebuild keeps
   * the keyboard focus on the same row's button.
   */
  renderPremiereLines() {
    if (!this.roomState) return;
    this.renderPremiereTimeline();
    if (!this.screeningLinesList) return;
    const focused = this.screeningLinesList.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = focused ? [...this.screeningLinesList.children].indexOf(focused.closest('.screening-line')) : -1;
    const focusChange = !!focused?.classList.contains('screening-line-change');
    const lines = this.roomState.pack?.lines || [];
    const takes = this.roomState.takes;
    const span = (cls, text) => {
      const el = document.createElement('span');
      el.className = cls;
      el.textContent = text;
      return el;
    };
    let original = 0;
    const rows = lines.map((line, index) => {
      const take = pickedTake(takes, line);
      if (!take) original += 1;
      const actor = this.premiereLineActor(line);
      const row = document.createElement('li');
      row.className = 'screening-line';

      const seek = document.createElement('button');
      seek.type = 'button';
      seek.className = 'screening-line-seek';
      const dot = span('screening-line-dot', '');
      this.paintLineMark(dot, actor);
      const status = span('screening-line-status',
        take ? `Take ${take.number}` : 'Original voice · Unrecorded');
      status.classList.toggle('is-original', !take);
      const speaker = span('screening-line-speaker', actor ? actor.name : 'Unassigned');
      seek.append(dot, span('screening-line-num', `#${index + 1}`), span('screening-line-char', line.character),
        speaker, status);
      seek.addEventListener('click', () => this.seekPremiere(line.start));
      row.appendChild(seek);

      if (this.canRecordLine(line)) {
        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'btn btn-ghost btn-xs screening-line-change';
        const hasTakes = lineTakes(takes, line).length > 0;
        change.textContent = hasTakes ? 'Change take' : 'Record';
        change.setAttribute('aria-label', hasTakes ? `Change take for line ${index + 1}` : `Record line ${index + 1}`);
        change.addEventListener('click', () => this.changePremiereTake(index));
        row.appendChild(change);
      }
      return row;
    });
    this.screeningLinesList.replaceChildren(...rows);
    if (rows[focusRow]) {
      (focusChange && rows[focusRow].querySelector('.screening-line-change')
        || rows[focusRow].querySelector('.screening-line-seek')).focus();
    }
    this.screeningLinesList.classList.toggle('has-change', rows.some((r) => r.childElementCount > 1));
    const originals = original ? ` · ${original} ${original === 1 ? 'uses' : 'use'} the original voice` : '';
    this.screeningLinesSummary.textContent = `· ${plural(lines.length, 'line')}${originals}`;
  }

  /** Change take: that line in the booth, with the take in the dub focused in TAKES. */
  async changePremiereTake(index) {
    this.showView('booth');
    const loading = this.loadBoothLine(index);
    this.broadcastMyStatus('booth');
    await loading;
    const radios = [...document.querySelectorAll('#card-takes [role="radio"]')];
    (radios.find((r) => r.getAttribute('aria-checked') === 'true') || radios[0])?.focus();
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

    this.renderScreeningPlayState(true);

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
    this.renderScreeningPlayState(false);
    this.screeningVideo.pause();
    if (!this.isUsingExportedVideo) {
      this.audio.stopAllPlayback();
    }
    // A video saved while the live mix played goes in now, at this spot.
    this.swapPendingExport();
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
