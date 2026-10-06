// studio/booth.js - Recording booth: line navigation, countdown and recording, takes,
// waveform/nudge, A/B preview and noise reduction.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { WaveformRenderer } from '../waveform.js';
import { pickedTake, lineTakes, takeCount } from './takes.js';

export class BoothMethods {
  toggleFilterLines() {
    this.filterMyLinesOnly = !this.filterMyLinesOnly;
    if (this.labelFilterLines) {
      this.labelFilterLines.innerText = this.filterMyLinesOnly ? "My lines" : "All lines";
    }
    this.renderTimelineChips();
    this.showToast(this.filterMyLinesOnly ? "Showing your lines" : "Showing all lines");
  }

  /** The take used in the dub for the line at this index, or undefined. */
  takeForLine(index) {
    return pickedTake(this.roomState?.takes, this.roomState?.pack?.lines?.[index]);
  }

  /** Your assigned character, or any line when nobody is cast and you host. */
  canRecordLine(line) {
    const myAssignedChars = this.getMyAssignedCharacters();
    return !line || myAssignedChars.includes(line.character)
      || (myAssignedChars.length === 0 && this.isHost({ allowDummy: true }));
  }

  /** Reference + take waveforms for a line, padded past the line's end. */
  setWaveformForLine(line, take, origPeaks, takePeaks) {
    this.waveform.setData({
      origPeaks,
      takePeaks,
      offsetMs: take ? (take.offset_ms || 0) : 0,
      totalDuration: (line.duration || 3.0) + 0.8,
    });
  }

  /** "Matched" vs "Scene Target" badge for the take's auto-gain against gainDb. */
  renderGainMatchBadge(take, gainDb) {
    if (!this.badgeGainMatch) return;
    const matchVal = parseFloat(take.auto_gain_db);
    const label = `${matchVal >= 0 ? '+' : ''}${matchVal} dB`;
    const isMatched = Math.abs(gainDb - matchVal) < 0.1;
    this.badgeGainMatch.innerText = isMatched ? `✓ Matched` : `Match: ${label}`;
    this.badgeGainMatch.className = isMatched ? 'badge-calibrated calibrated' : 'badge-calibrated uncalibrated';
  }

  getMyAssignedCharacters() {
    if (!this.roomState) return [];
    return Object.keys(this.roomState.role_assignments || {}).filter((char) => {
      return (this.roomState.role_assignments[char] || []).includes(this.user.id);
    });
  }

  findFirstAssignedLine() {
    if (!this.roomState) return 0;
    const myAssignedChars = this.getMyAssignedCharacters();
    const line = this.roomState.pack.lines.find(l => myAssignedChars.includes(l.character));
    return line ? line.index : 0;
  }

  // --- Booth & Recording Logic ---

  cancelCurrentCountdown() {
    this.countdownSessionId++;
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    // An abandoned take must still stop the recorder and release the mic;
    // stopAllPlayback() no longer does that while a recording is running.
    if (this.audio && this.audio.isRecording) {
      this.audio.stopRecording().catch(() => { });
    }
    this.recordState = 'idle';
    if (this.videoOverlay) {
      this.videoOverlay.classList.add('hidden');
      const circle = this.videoOverlay.querySelector('.countdown-circle');
      if (circle) {
        circle.classList.remove('flash-beat', 'flash-go');
      }
    }
    this.updateRecordButtonUI();
  }

  // The cache is keyed by the pack's backing_url so a buffer from a previous
  // room's scene is never reused, and a load that finishes after the user has
  // left (or switched scenes) is dropped instead of being cached.
  async ensureBackingBuffer() {
    const url = this.roomState?.pack?.backing_url;
    if (!url) return null;
    if (this.backingBuffer && this.backingBufferUrl === url) return this.backingBuffer;
    let buf = null;
    try {
      buf = await this.audio.loadAudioBuffer(url);
    } catch (e) { }
    if (this.roomState?.pack?.backing_url !== url) return null;
    this.backingBuffer = buf || null;
    this.backingBufferUrl = buf ? url : null;
    return this.backingBuffer;
  }

  async loadBoothLine(index) {
    if (!this.roomState || !this.roomState.pack.lines[index]) return;
    this.cancelCurrentCountdown();
    this.currentLineIndex = index;
    const line = this.roomState.pack.lines[index];
    this.loadLineSeq = (this.loadLineSeq || 0) + 1;
    const currentSeq = this.loadLineSeq;

    this.broadcastMyStatus('booth');

    if (this.stageVideo) {
      const targetSrc = this.roomState.pack.video_url;
      if (!this.stageVideo.src.endsWith(targetSrc)) {
        this.stageVideo.src = targetSrc;
      }
      try {
        if (this.stageVideo.readyState >= 1) {
          this.stageVideo.currentTime = Math.max(0, line.start);
        } else {
          this.stageVideo.addEventListener('loadedmetadata', () => {
            try { this.stageVideo.currentTime = Math.max(0, line.start); } catch (e) { }
          }, { once: true });
        }
      } catch (e) { }
    }

    // Calculate your line numbering (e.g. Line 3 of 6)
    const myAssignedChars = this.getMyAssignedCharacters();
    const isMyLine = this.canRecordLine(line);
    const myAssignedLines = this.roomState.pack.lines.filter(l => myAssignedChars.includes(l.character));
    const myLinePos = myAssignedLines.findIndex(l => l.index === index) + 1;

    this.boothLineIndicator.innerText = isMyLine
      ? (myAssignedLines.length > 0 ? `Your line ${myLinePos}/${myAssignedLines.length} (line ${index + 1})` : `Line ${index + 1}/${this.roomState.pack.lines.length}`)
      : `Line ${index + 1}/${this.roomState.pack.lines.length} (locked)`;

    const lineDur = (line.duration !== undefined ? line.duration : Math.max(0.5, (line.end || 0) - (line.start || 0)));
    this.boothTimeBadge.innerText = `${(line.start || 0).toFixed(2)}s - ${(line.end || 0).toFixed(2)}s (${lineDur.toFixed(2)}s)`;
    this.stageCaptionChar.innerText = isMyLine ? line.character.toUpperCase() : `${line.character.toUpperCase()} (LOCKED)`;
    const lineCap = (line.caption || line.text || '').trim();
    this.stageCaptionText.innerText = lineCap ? `“${lineCap}”` : `(${line.character}, no subtitle)`;

    const take = pickedTake(this.roomState.takes, line);
    if (take) {
      this.sliderNudge.value = take.offset_ms || 0;
      this.nudgeDisplay.innerText = (take.offset_ms || 0) + ' ms';
      this.sliderPitch.value = take.pitch_semitones || 0;
      this.valPitch.innerText = (take.pitch_semitones > 0 ? '+' : '') + (take.pitch_semitones || 0) + ' st';
      this.sliderReverb.value = (take.reverb_wet || 0) * 100;
      this.valReverb.innerText = Math.round((take.reverb_wet || 0) * 100) + '%';
      this.sliderGain.value = take.gain_db || 0;
      this.valGain.innerText = (take.gain_db > 0 ? '+' : '') + (take.gain_db || 0) + ' dB';

      if (take.auto_gain_db !== undefined) {
        if (this.btnAutoMatchGain) this.btnAutoMatchGain.style.display = 'inline-flex';
        if (this.badgeGainMatch) {
          this.badgeGainMatch.style.display = 'inline-block';
          this.renderGainMatchBadge(take, parseFloat(this.sliderGain.value) || 0);
        }
      } else {
        if (this.btnAutoMatchGain) this.btnAutoMatchGain.style.display = 'none';
        if (this.badgeGainMatch) this.badgeGainMatch.style.display = 'none';
      }
    } else {
      this.sliderNudge.value = 0;
      this.nudgeDisplay.innerText = '0 ms';
      this.sliderPitch.value = 0;
      this.valPitch.innerText = '0 st';
      this.sliderReverb.value = 0;
      this.valReverb.innerText = '0%';
      this.sliderGain.value = 0;
      this.valGain.innerText = '0 dB';
      if (this.btnAutoMatchGain) this.btnAutoMatchGain.style.display = 'none';
      if (this.badgeGainMatch) this.badgeGainMatch.style.display = 'none';
    }

    const activeNoiseRed = take ? (take.noise_reduction !== false) : this.applyNoiseReduction;
    if (this.checkNoiseReduction) this.checkNoiseReduction.checked = activeNoiseRed;
    if (this.checkRackNoiseReduction) this.checkRackNoiseReduction.checked = activeNoiseRed;
    if (this.checkLobbyNoiseReduction) this.checkLobbyNoiseReduction.checked = this.applyNoiseReduction;

    this.updateKnobsVisuals();

    this.recordState = 'idle';
    this.updateRecordButtonUI(take);
    this.setABMode('A');

    // 1. INSTANT WAVEFORM RENDERING (0ms latency via precomputed peaks)
    let origPeaks = line.peaks || [];
    let takePeaks = take ? (take.peaks || []) : [];

    // Fallback: If take exists but peaks are not yet loaded in state, fetch on-demand or check cache
    if (take && (!takePeaks || takePeaks.length === 0)) {
      if (this.takePeaksCache?.has(take.take_id)) {
        takePeaks = this.takePeaksCache.get(take.take_id);
      } else {
        // Asynchronously fetch compact peaks from dedicated endpoint
        fetch(`/api/rooms/${this.roomState.room_id}/lines/${line.line_id}/takes/${take.take_id}/peaks`)
          .then(r => r.ok ? r.json() : null)
          .then(pData => {
            if (pData && pData.peaks && pData.peaks.length > 0 && currentSeq === this.loadLineSeq) {
              if (!this.takePeaksCache) this.takePeaksCache = new Map();
              this.takePeaksCache.set(take.take_id, pData.peaks);
              const shownTake = this.takeForLine(index);
              if (shownTake?.take_id === take.take_id) shownTake.peaks = pData.peaks;
              this.waveform.setData({ takePeaks: pData.peaks });
            }
          })
          .catch(() => { });
      }
    }

    this.setWaveformForLine(line, take, origPeaks, takePeaks);

    this.renderTimelineChips();

    // 2. Intelligent Adjacent-Line Prefetching (loads neighbors into memory for 0ms transitions)
    this.prefetchAdjacentLines(index);

    // 3. Asynchronous Audio Buffer Loading (with race condition guarding & fault tolerance)
    (async () => {
      try {
        const origBuf = await this.audio.loadAudioBuffer(line.audio_url);
        if (currentSeq !== this.loadLineSeq) return;
        this.origBuffer = origBuf;
        if ((!origPeaks || origPeaks.length === 0) && origBuf) {
          origPeaks = WaveformRenderer.extractPeaksFromBuffer(origBuf, 100);
          this.setWaveformForLine(line, take, origPeaks, takePeaks);
        }
      } catch (e) {
        console.warn("[App] Error loading reference audio:", e);
      }

      if (take && take.url) {
        try {
          const takeBuf = await this.audio.loadAudioBuffer(take.url);
          if (currentSeq !== this.loadLineSeq) return;
          this.currentTakeBuffer = takeBuf;
          if ((!takePeaks || takePeaks.length === 0) && takeBuf) {
            takePeaks = WaveformRenderer.extractPeaksFromBuffer(takeBuf, 100);
            if (!this.takePeaksCache) this.takePeaksCache = new Map();
            this.takePeaksCache.set(take.take_id, takePeaks);
            const shownTake = this.takeForLine(index);
            if (shownTake?.take_id === take.take_id) shownTake.peaks = takePeaks;
            this.setWaveformForLine(line, take, origPeaks, takePeaks);
          }
        } catch (e) {
          console.warn("[App] Error loading take audio:", e);
        }
      } else {
        if (currentSeq === this.loadLineSeq) {
          this.currentTakeBuffer = null;
        }
      }
    })();

    // Update Prev / Next navigation button states (including "I'm Finished" state)
    let isFirst = false;
    let isLast = false;
    if (myAssignedChars.length > 0 && this.filterMyLinesOnly && myAssignedLines.length > 0) {
      const myIdx = myAssignedLines.findIndex(l => l.index === index);
      isFirst = (myIdx <= 0);
      isLast = (myIdx >= myAssignedLines.length - 1);
    } else {
      isFirst = (index <= 0);
      isLast = (index >= this.roomState.pack.lines.length - 1);
    }

    if (this.btnPrevLine) {
      this.btnPrevLine.disabled = isFirst;
      this.btnPrevLine.style.opacity = isFirst ? '0.4' : '1';
    }

    if (this.btnNextLine) {
      if (isLast) {
        this.btnNextLine.innerHTML = '<span>Finish ✓</span>';
        this.btnNextLine.className = 'btn btn-success btn-sm btn-finished-pulse';
        this.btnNextLine.dataset.tip = "Marks you ready for the premiere";
      } else {
        this.btnNextLine.innerHTML = '<span>Next line ›</span>';
        this.btnNextLine.className = 'btn btn-primary btn-sm';
        this.btnNextLine.removeAttribute('data-tip');
      }
    }
  }

  prefetchAdjacentLines(currentIndex) {
    if (!this.roomState || !this.roomState.pack || !this.roomState.pack.lines) return;
    const lines = this.roomState.pack.lines;
    const neighbors = [currentIndex + 1, currentIndex - 1, currentIndex + 2].filter(
      i => i >= 0 && i < lines.length
    );

    for (const nIdx of neighbors) {
      const nLine = lines[nIdx];
      if (nLine && nLine.audio_url) {
        this.audio.loadAudioBuffer(nLine.audio_url).catch(() => { });
      }
      const nTake = pickedTake(this.roomState.takes, nLine);
      if (nTake && nTake.url) {
        this.audio.loadAudioBuffer(nTake.url).catch(() => { });
      }
    }
  }

  updateRecordButtonUI(take = null) {
    if (!take) {
      take = this.takeForLine(this.currentLineIndex);
    }

    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const isMyLine = this.canRecordLine(line);

    if (!isMyLine) {
      this.btnRecordMain.className = 'btn-big-record locked';
      this.recordIcon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const assignedIds = (this.roomState?.role_assignments?.[line?.character] || []);
      const assignedNames = assignedIds.map(uid => this.roomState?.users?.[uid]?.name).filter(Boolean);
      const actorText = assignedNames.length > 0 ? assignedNames.join(', ') : 'another actor';
      this.recordStatusLabel.innerText = `${line?.character} is voiced by ${actorText}`;
      return;
    }

    if (this.recordState === 'recording') {
      this.btnRecordMain.className = 'btn-big-record recording';
      this.recordIcon.innerText = '■';
      this.recordStatusLabel.innerText = "Recording. Press Space to stop";
    } else if (this.recordState === 'countdown') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerText = '✕';
      this.recordStatusLabel.innerText = "Counting in. Click to cancel";
    } else if (this.recordState === 'processing') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerHTML = `<span class="spinning" style="display:inline-flex;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg></span>`;
      this.recordStatusLabel.innerText = "Saving take…";
    } else {
      this.btnRecordMain.className = 'btn-big-record';
      if (take) {
        this.recordIcon.innerText = '↺';
        this.recordStatusLabel.innerText = `Take ${take.number} by ${take.user_name} (${take.duration}s)`;
      } else {
        this.recordIcon.innerText = '●';
        this.recordStatusLabel.innerText = 'Press Space to record';
      }
    }
  }

  renderTimelineChips() {
    if (!this.roomState || !this.timelineChips) return;
    this.timelineChips.innerHTML = '';
    const myAssignedChars = this.getMyAssignedCharacters();

    this.roomState.pack.lines.forEach((l, idx) => {
      const isMyLine = myAssignedChars.includes(l.character);
      if (this.filterMyLinesOnly && !isMyLine && myAssignedChars.length > 0) {
        return; // Filter out other characters' lines when in "My Lines Only" mode
      }

      const chip = document.createElement('div');
      const hasTake = takeCount(this.roomState.takes, l) > 0;
      const isActive = idx === this.currentLineIndex;

      chip.className = `chip-item ${isActive ? 'active' : ''} ${hasTake ? 'done' : ''} ${isMyLine ? 'my-line' : ''}`;
      chip.dataset.tip = `Line ${idx + 1}: ${l.character}${hasTake ? ' · recorded' : ''}`;
      chip.innerText = String(idx + 1);

      chip.addEventListener('click', () => {
        this.loadBoothLine(idx);
      });

      this.timelineChips.appendChild(chip);

      if (isActive) {
        requestAnimationFrame(() => {
          try {
            chip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          } catch (e) { }
        });
      }
    });
  }

  async syncVideoSeek(targetTime) {
    if (!this.stageVideo) return;
    this.stageVideo.pause();
    const clamped = Math.max(0, targetTime);
    if (Math.abs(this.stageVideo.currentTime - clamped) < 0.03) {
      return;
    }
    return new Promise((resolve) => {
      let resolved = false;
      const onSeeked = () => {
        if (!resolved) {
          resolved = true;
          this.stageVideo.removeEventListener('seeked', onSeeked);
          resolve();
        }
      };
      this.stageVideo.addEventListener('seeked', onSeeked, { once: true });
      try {
        this.stageVideo.currentTime = clamped;
      } catch (e) {
        resolved = true;
        resolve();
      }
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stageVideo.removeEventListener('seeked', onSeeked);
          resolve();
        }
      }, 100);
    });
  }

  stopBoothPlayback() {
    this.activePlaybackToken = (this.activePlaybackToken || 0) + 1;
    this.isPlayingReference = false;
    this.isPlayingTake = false;
    this.audio.stopAllPlayback();
    if (this.stageVideo) {
      this.stageVideo.pause();
    }
    this.waveform.setPlayhead(-1);
  }

  // Play Original Reference Clip with Animated Playhead
  async playOriginalReference() {
    this.cancelCurrentCountdown();
    if (this.isPlayingReference) {
      this.stopBoothPlayback();
      return;
    }
    this.stopBoothPlayback();

    const line = this.roomState.pack.lines[this.currentLineIndex];
    this.activePlaybackToken = (this.activePlaybackToken || 0) + 1;
    const token = this.activePlaybackToken;
    this.isPlayingReference = true;

    await this.syncVideoSeek(line.start);
    if (token !== this.activePlaybackToken) return;

    try {
      await this.stageVideo.play();
    } catch (e) { }

    const startAudioTime = performance.now();
    const durationSec = Math.max(line.duration || 3.0, (this.origBuffer?.duration || 3.0)) + 0.2;

    const animPlayhead = () => {
      if (token !== this.activePlaybackToken) return;
      const elapsed = (performance.now() - startAudioTime) / 1000.0;
      const progress = Math.min(1.0, elapsed / durationSec);
      this.waveform.setPlayhead(progress);
      if (progress < 1.0) {
        requestAnimationFrame(animPlayhead);
      } else {
        this.waveform.setPlayhead(-1);
      }
    };
    requestAnimationFrame(animPlayhead);

    this.audio.playOriginalReference({
      backingBuffer: this.backingBuffer,
      lineStartSec: line.start,
      origBuffer: this.origBuffer,
      onEnded: () => {
        if (token === this.activePlaybackToken) {
          this.isPlayingReference = false;
          this.waveform.setPlayhead(-1);
          this.stageVideo.pause();
        }
      },
    });
  }

  // Preview Take (Bi-directional Sync & Live Waveform Animation)
  async previewCurrentTake() {
    this.cancelCurrentCountdown();
    if (this.isPlayingTake) {
      this.stopBoothPlayback();
      return;
    }
    this.stopBoothPlayback();

    const line = this.roomState.pack.lines[this.currentLineIndex];
    const take = this.takeForLine(this.currentLineIndex);

    if (!take || !take.url) {
      this.showToast("Record a take first");
      return;
    }

    // Ensure take audio buffer is ready
    if (!this.currentTakeBuffer) {
      try {
        this.currentTakeBuffer = await this.audio.loadAudioBuffer(take.url, true);
      } catch (e) {
        console.warn("[App] Error loading take audio:", e);
      }
    }

    if (!this.currentTakeBuffer) {
      this.showToast("The take is still loading. Try again in a moment.");
      return;
    }

    this.activePlaybackToken = (this.activePlaybackToken || 0) + 1;
    const token = this.activePlaybackToken;
    this.isPlayingTake = true;

    const offsetMs = parseInt(this.sliderNudge.value, 10);
    const offsetSec = offsetMs / 1000.0;
    const previewStartSec = Math.max(0, line.start + Math.min(0, offsetSec));

    await this.syncVideoSeek(previewStartSec);
    if (token !== this.activePlaybackToken) return;

    try {
      await this.stageVideo.play();
    } catch (e) { }

    const pitch = parseFloat(this.sliderPitch.value);
    const reverb = parseFloat(this.sliderReverb.value) / 100.0;
    const gain = parseFloat(this.sliderGain.value);
    const lowcut = this.checkLowcut.checked;

    const startAudioTime = performance.now();
    const previewDurationSec = Math.max(line.duration || 3.0, (this.currentTakeBuffer?.duration || 3.0) + Math.max(0, offsetSec)) + 0.3;

    const animPlayhead = () => {
      if (token !== this.activePlaybackToken) return;
      const elapsed = (performance.now() - startAudioTime) / 1000.0;
      const progress = Math.min(1.0, elapsed / previewDurationSec);
      this.waveform.setPlayhead(progress);
      if (progress < 1.0) {
        requestAnimationFrame(animPlayhead);
      } else {
        this.waveform.setPlayhead(-1);
      }
    };
    requestAnimationFrame(animPlayhead);

    this.audio.previewTakeIsolated({
      backingBuffer: this.backingBuffer,
      lineStartSec: line.start,
      takeBuffer: this.currentTakeBuffer,
      origBuffer: this.origBuffer,
      offsetMs,
      pitchSemitones: pitch,
      reverbWet: reverb,
      gainDb: gain,
      enableLowCut: lowcut,
      onEnded: () => {
        if (token === this.activePlaybackToken) {
          this.isPlayingTake = false;
          this.waveform.setPlayhead(-1);
          this.stageVideo.pause();
        }
      },
    });
  }

  toggleABState() {
    const nextState = this.audio.abState === 'A' ? 'B' : 'A';
    this.setABMode(nextState);
  }

  setABMode(state) {
    this.audio.setABState(state);
    if (state === 'A') {
      this.labelABState.innerHTML = `<span style="color: var(--primary); font-weight: 700;">[ A: Your Dub ]</span> <span style="color: var(--foreground-dim);">⇄ B: Orig</span>`;
    } else {
      this.labelABState.innerHTML = `<span style="color: var(--foreground-dim);">A: Dub ⇄</span> <span style="color: var(--accent-brass); font-weight: 700;">[ B: Original ]</span>`;
    }
  }

  setNudgeValue(val, syncSocket = true) {
    const clamped = Math.max(-800, Math.min(800, val));
    this.sliderNudge.value = clamped;
    this.nudgeDisplay.innerText = `${clamped > 0 ? '+' : ''}${clamped} ms`;
    const legendElem = document.getElementById('waveform-offset-legend');
    if (legendElem) {
      legendElem.innerText = `Offset: ${clamped > 0 ? '+' : ''}${clamped} ms`;
    }
    this.waveform.offsetMs = clamped;
    this.waveform.render();
    if (syncSocket) {
      this.syncTakeParams();
    }
  }

  syncTakeParams() {
    const lineIdx = this.currentLineIndex;
    const offsetMs = parseInt(this.sliderNudge.value, 10);
    const pitch = parseFloat(this.sliderPitch.value);
    const reverb = parseFloat(this.sliderReverb.value) / 100.0;
    const gain = parseFloat(this.sliderGain.value);

    const take = this.roomState && this.takeForLine(lineIdx);
    if (!take) return;
    take.offset_ms = offsetMs;
    take.pitch_semitones = pitch;
    take.reverb_wet = reverb;
    take.gain_db = gain;

    this.socket.updateTakeParams(this.roomState.pack.lines[lineIdx].line_id, take.take_id, {
      offset_ms: offsetMs,
      pitch_semitones: pitch,
      reverb_wet: reverb,
      gain_db: gain,
    });
  }

  // --- Studio Noise Reduction & Mic Profile Calibration ---

  setNoiseReduction(enabled) {
    this.applyNoiseReduction = !!enabled;
    localStorage.setItem('dubmate_noise_reduction', this.applyNoiseReduction);

    if (this.checkLobbyNoiseReduction && this.checkLobbyNoiseReduction.checked !== this.applyNoiseReduction) {
      this.checkLobbyNoiseReduction.checked = this.applyNoiseReduction;
    }
    if (this.checkNoiseReduction && this.checkNoiseReduction.checked !== this.applyNoiseReduction) {
      this.checkNoiseReduction.checked = this.applyNoiseReduction;
    }
    if (this.checkRackNoiseReduction && this.checkRackNoiseReduction.checked !== this.applyNoiseReduction) {
      this.checkRackNoiseReduction.checked = this.applyNoiseReduction;
    }

    const currentTake = this.takeForLine(this.currentLineIndex);
    if (currentTake && this.views.booth.classList.contains('active') && !this.isProcessingTake) {
      this.toggleTakeNoiseReduction(this.currentLineIndex, this.applyNoiseReduction);
    }
  }

  async calibrateMicNoiseProfile() {
    if (this.isCalibratingMic) return;
    if (!this.roomState) {
      this.showToast("Join or create a room first.");
      return;
    }
    if (!(await this.ensureMicReady())) return;

    this.isCalibratingMic = true;
    const btn = this.btnCalibrateMic;
    const origIcon = this.calibrateIcon ? this.calibrateIcon.innerText : '🎯';
    const origLabel = this.calibrateLabel ? this.calibrateLabel.innerText : 'Calibrate mic';

    if (btn) {
      btn.disabled = true;
      btn.classList.add('calibrating-pulse');
    }
    if (this.calibrateIcon) this.calibrateIcon.innerText = '🤫';
    if (this.calibrateLabel) this.calibrateLabel.innerText = 'Calibrating…';

    // 1. Open the Calibration Modal
    if (this.modalMicCalibration) {
      this.modalMicCalibration.style.display = 'flex';
      if (this.calibModalBadge) this.calibModalBadge.innerText = 'GET READY';
      if (this.calibModalTitle) this.calibModalTitle.innerText = 'Mic calibration';
      if (this.calibModalStatus) this.calibModalStatus.innerText = 'Stay quiet for a few seconds.';
      if (this.calibTimerText) this.calibTimerText.innerText = '1.0s';
      if (this.calibPhaseText) this.calibPhaseText.innerText = 'Get ready';
      if (this.calibProgressBar) {
        this.calibProgressBar.style.width = '0%';
        this.calibProgressBar.className = 'modal-progress-fill';
      }
      if (this.calibModalIcon) this.calibModalIcon.innerText = '🤫';
      if (this.calibRadarRing) this.calibRadarRing.className = 'calib-radar-ring';
    }

    try {
      // 1-second pre-roll delay followed by 3-second room tone recording
      const blob = await this.audio.recordNoiseProfile(3000, 1000, (phase, elapsedMs, totalMs) => {
        const remainingSec = Math.max(0, (totalMs - elapsedMs) / 1000.0).toFixed(1);
        const percent = Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100));

        if (phase === 'preroll') {
          if (this.calibTimerText) this.calibTimerText.innerText = `${remainingSec}s`;
          if (this.calibPhaseText) this.calibPhaseText.innerText = 'Get ready';
          if (this.calibProgressBar) this.calibProgressBar.style.width = `${percent}%`;
          if (this.calibModalBadge) this.calibModalBadge.innerText = 'GET READY';
          if (this.calibModalStatus) this.calibModalStatus.innerText = 'Stay quiet for a few seconds.';
          if (this.calibModalIcon) this.calibModalIcon.innerText = '🤫';
        } else if (phase === 'recording') {
          if (this.calibTimerText) this.calibTimerText.innerText = `${remainingSec}s`;
          if (this.calibPhaseText) this.calibPhaseText.innerText = 'Listening to the room';
          if (this.calibProgressBar) this.calibProgressBar.style.width = `${percent}%`;
          if (this.calibModalBadge) this.calibModalBadge.innerText = 'LISTENING';
          if (this.calibModalStatus) this.calibModalStatus.innerText = 'Listening to the room…';
          if (this.calibModalIcon) this.calibModalIcon.innerText = '🎙️';
          if (this.calibRadarRing) this.calibRadarRing.className = 'calib-radar-ring active-radar';
        }
      });

      if (!blob || blob.size < 32) {
        throw new Error("No audio captured from microphone.");
      }

      if (this.calibModalBadge) this.calibModalBadge.innerText = 'SAVING';
      if (this.calibModalStatus) this.calibModalStatus.innerText = 'Saving…';
      if (this.calibTimerText) this.calibTimerText.innerText = '0.0s';
      if (this.calibProgressBar) this.calibProgressBar.style.width = '100%';

      const formData = new FormData();
      formData.append('file', blob, 'profile.webm');
      formData.append('user_id', this.user.id);

      const res = await fetch(`/api/rooms/${this.roomState.room_id}/noise_profile`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const data = await res.json();
      this.hasCustomNoiseProfile = true;

      if (this.calibModalBadge) this.calibModalBadge.innerText = 'CALIBRATED ✓';
      if (this.calibModalTitle) this.calibModalTitle.innerText = 'Mic calibrated';
      if (this.calibModalStatus) this.calibModalStatus.innerText = 'Noise reduction is now tuned to your room.';
      if (this.calibModalIcon) this.calibModalIcon.innerText = '✨';

      if (this.badgeNoiseStatus) {
        this.badgeNoiseStatus.innerText = 'Calibrated ✓';
        this.badgeNoiseStatus.className = 'badge-calibrated calibrated';
        this.badgeNoiseStatus.dataset.tip = 'Noise reduction is tuned to your room';
      }

      if (this.btnResetNoiseProfile) {
        this.btnResetNoiseProfile.style.display = 'inline-flex';
      }

      this.showToast("Mic calibrated");

      // If active line has a take with noise reduction enabled, re-apply with new profile
      const take = this.takeForLine(this.currentLineIndex);
      if (take && this.applyNoiseReduction && !this.isProcessingTake) {
        this.toggleTakeNoiseReduction(this.currentLineIndex, true);
      }

      // Automatically close modal smoothly after brief confirmation
      await new Promise(r => setTimeout(r, 450));
      if (this.modalMicCalibration) {
        this.modalMicCalibration.style.display = 'none';
      }
    } catch (err) {
      if (this.modalMicCalibration) {
        this.modalMicCalibration.style.display = 'none';
      }
      if (err.message && err.message.includes("cancelled")) {
        this.showToast("Calibration cancelled");
      } else {
        console.warn("[App] Calibration failed:", err);
        this.showToast(this.friendlyError(err, "Mic calibration didn't finish. Try again."));
      }
    } finally {
      this.isCalibratingMic = false;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('calibrating-pulse');
      }
      if (this.calibrateIcon) this.calibrateIcon.innerText = origIcon;
      if (this.calibrateLabel) this.calibrateLabel.innerText = origLabel;
    }
  }

  cancelMicNoiseCalibration() {
    this.audio.cancelNoiseProfileCalibration();
    if (this.modalMicCalibration) {
      this.modalMicCalibration.style.display = 'none';
    }
    this.isCalibratingMic = false;
    if (this.btnCalibrateMic) {
      this.btnCalibrateMic.disabled = false;
      this.btnCalibrateMic.classList.remove('calibrating-pulse');
    }
    if (this.calibrateIcon) this.calibrateIcon.innerText = '🎯';
    if (this.calibrateLabel) this.calibrateLabel.innerText = 'Calibrate mic';
  }

  resetMicNoiseProfile() {
    this.hasCustomNoiseProfile = false;
    if (this.badgeNoiseStatus) {
      this.badgeNoiseStatus.innerText = '● Auto';
      this.badgeNoiseStatus.className = 'badge-calibrated uncalibrated';
      this.badgeNoiseStatus.dataset.tip = 'Background noise is detected automatically';
    }
    if (this.btnResetNoiseProfile) {
      this.btnResetNoiseProfile.style.display = 'none';
    }
    this.showToast("Mic calibration reset");

    const take = this.takeForLine(this.currentLineIndex);
    if (take && this.applyNoiseReduction && !this.isProcessingTake) {
      this.toggleTakeNoiseReduction(this.currentLineIndex, true);
    }
  }

  async toggleTakeNoiseReduction(lineIndex, enable) {
    const target = this.roomState && this.takeForLine(lineIndex);
    if (!target) {
      return;
    }
    const lineId = this.roomState.pack.lines[lineIndex].line_id;

    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/lines/${lineId}/takes/${target.take_id}/noise_reduction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noise_reduction: enable }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const entryTakes = lineTakes(this.roomState.takes, this.roomState.pack.lines[lineIndex]);
      const pos = data.take ? entryTakes.findIndex((t) => t.take_id === data.take.take_id) : -1;
      if (pos >= 0) {
        entryTakes[pos] = data.take;
      }

      this.audio.evictTakeCache(this.takeForLine(lineIndex));

      if (lineIndex === this.currentLineIndex) {
        const line = this.roomState.pack.lines[lineIndex];
        const take = this.takeForLine(lineIndex);
        let origPeaks = line.peaks || [];
        let takePeaks = take ? (take.peaks || []) : [];

        this.setWaveformForLine(line, take, origPeaks, takePeaks);

        // The server re-matches gain for the swapped audio; show the take's new level.
        if (take) {
          const gainDb = parseFloat(take.gain_db) || 0;
          this.sliderGain.value = gainDb;
          this.valGain.innerText = (gainDb > 0 ? '+' : '') + gainDb + ' dB';
          this.audio.setGain(gainDb);
          this.updateKnobsVisuals();
          if (take.auto_gain_db !== undefined) this.renderGainMatchBadge(take, gainDb);
        }

        if (take && take.url) {
          const newBuf = await this.audio.loadAudioBuffer(take.url, true);
          this.currentTakeBuffer = newBuf;
          if (newBuf && (!takePeaks || takePeaks.length === 0)) {
            takePeaks = WaveformRenderer.extractPeaksFromBuffer(newBuf, 100);
            this.setWaveformForLine(line, take, origPeaks, takePeaks);
          }
        }
      }

      this.showToast(enable ? "Noise reduction on" : "Noise reduction off. Original take restored.");
    } catch (err) {
      console.warn("[App] Error toggling take noise reduction:", err);
      this.showToast(this.friendlyError(err, "Couldn't change the noise reduction setting."));
    }
  }

  async toggleRecording() {
    if (!this.roomState) return;
    const line = this.roomState.pack.lines[this.currentLineIndex];
    const isMyLine = this.canRecordLine(line);
    if (!isMyLine) {
      this.showToast(`Line ${this.currentLineIndex + 1} belongs to ${line.character}. Only their actor can record it.`);
      return;
    }

    if (this.recordState === 'countdown') {
      this.cancelCurrentCountdown();
      return;
    }

    if (this.recordState === 'recording') {
      await this.finishRecording();
      return;
    }

    if (this.recordState === 'processing') {
      this.showToast("Still saving the last take");
      return;
    }

    await this.startCountdownAndRecord();
  }

  async startCountdownAndRecord() {
    // Show the styled explainer instead of letting a bare browser permission
    // prompt ambush the user mid-countdown.
    if (!(await this.ensureMicReady())) return;

    const line = this.roomState.pack.lines[this.currentLineIndex];
    const sessionId = ++this.countdownSessionId;

    this.ensureBackingBuffer(); // Preload backing in background during 3s countdown
    this.recordState = 'countdown';
    this.audio.stopAllPlayback();
    this.updateRecordButtonUI();

    this.videoOverlay.classList.remove('hidden');
    this.stageVideo.currentTime = Math.max(0, line.start);

    const countdownCircle = this.videoOverlay.querySelector('.countdown-circle');

    for (let count = 3; count > 0; count--) {
      if (this.countdownSessionId !== sessionId) return;
      this.overlayCountdown.innerText = count;
      this.overlayStatusText.innerText = "GET READY";

      // Visual flash ring effect on each beat for headphone / silent cueing
      if (countdownCircle) {
        countdownCircle.classList.remove('flash-beat', 'flash-go');
        void countdownCircle.offsetWidth; // Force DOM reflow to re-trigger CSS keyframe
        countdownCircle.classList.add('flash-beat');
      }

      this.audio.playMetronomePip(false);
      await new Promise(r => setTimeout(r, 650));
    }

    if (this.countdownSessionId !== sessionId) return;
    this.overlayCountdown.innerText = "GO";
    this.overlayStatusText.innerText = "RECORDING";

    // Emerald / Cyan flash ring on GO!
    if (countdownCircle) {
      countdownCircle.classList.remove('flash-beat', 'flash-go');
      void countdownCircle.offsetWidth;
      countdownCircle.classList.add('flash-go');
    }

    this.audio.playMetronomePip(true);
    await new Promise(r => setTimeout(r, 280));
    this.videoOverlay.classList.add('hidden');
    if (countdownCircle) {
      countdownCircle.classList.remove('flash-beat', 'flash-go');
    }

    if (this.countdownSessionId !== sessionId) return;

    this.recordState = 'recording';
    this.updateRecordButtonUI();

    await this.audio.startRecording();
    this.stageVideo.currentTime = Math.max(0, line.start);
    try {
      const p = this.stageVideo.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { });
      }
    } catch (e) { }

    // Backing track
    if (this.backingBuffer) {
      const backingSource = this.audio.ctx.createBufferSource();
      backingSource.buffer = this.backingBuffer;
      const gainNode = this.audio.ctx.createGain();
      gainNode.gain.value = this.audio.backingVolume;
      backingSource.connect(gainNode);
      gainNode.connect(this.audio.ctx.destination);
      backingSource.start(this.audio.ctx.currentTime, Math.max(0, line.start));
      this.audio.currentPlayingNodes.push(backingSource);
    }

    // Guide reference voice if toggled
    if (this.checkGuideVoice && this.checkGuideVoice.checked && this.origBuffer) {
      const guideSource = this.audio.ctx.createBufferSource();
      guideSource.buffer = this.origBuffer;
      const guideGain = this.audio.ctx.createGain();
      guideGain.gain.value = 0.85;
      guideSource.connect(guideGain);
      guideGain.connect(this.audio.ctx.destination);
      guideSource.start(this.audio.ctx.currentTime);
      this.audio.currentPlayingNodes.push(guideSource);
    }

    const recordingDurationSec = line.duration + 0.8;
    const recStartTime = performance.now();

    // Live playhead animation synced with voice recording duration
    const animRecordPlayhead = () => {
      if (this.recordState !== 'recording' || this.countdownSessionId !== sessionId) {
        this.waveform.setPlayhead(-1);
        return;
      }
      const elapsed = (performance.now() - recStartTime) / 1000.0;
      const progress = Math.min(1.0, elapsed / recordingDurationSec);
      this.waveform.setPlayhead(progress);
      if (progress < 1.0) {
        requestAnimationFrame(animRecordPlayhead);
      } else {
        this.waveform.setPlayhead(-1);
      }
    };
    requestAnimationFrame(animRecordPlayhead);

    this.recordingTimeout = setTimeout(() => {
      if (this.recordState === 'recording' && this.countdownSessionId === sessionId) {
        this.finishRecording();
      }
    }, recordingDurationSec * 1000);
  }

  setBoothProcessing(isProcessing) {
    this.isProcessingTake = isProcessing;
    if (this.boothProcessingOverlay) {
      this.boothProcessingOverlay.style.display = isProcessing ? 'flex' : 'none';
    }

    if (this.boothProcessingTitle) {
      if (this.applyNoiseReduction) {
        this.boothProcessingTitle.innerText = "Saving take…";
      } else {
        this.boothProcessingTitle.innerText = "Saving take…";
      }
    }
    if (this.boothProcessingSub) {
      if (this.applyNoiseReduction) {
        this.boothProcessingSub.innerText = "Removing background noise";
      } else {
        this.boothProcessingSub.innerText = "";
      }
    }

    const interactiveElements = [
      this.btnPrevLine,
      this.btnNextLine,
      this.btnClearTake,
      this.btnToggleReady,
      this.btnJumpScreening,
      this.btnBackLobby,
      this.btnToggleAB,
      this.btnPlayOrig,
      this.btnPreviewTake,
      this.btnToggleFilterLines,
      this.sliderNudge,
      this.sliderBackingVol,
      this.checkMetronome,
      this.checkGuideVoice,
      this.sliderPitch,
      this.sliderReverb,
      this.sliderGain,
      this.btnLeaveRoom,
      this.navStepLobby,
      this.navStepBooth,
      this.navStepScreening
    ];

    interactiveElements.forEach((el) => {
      if (el) {
        el.disabled = isProcessing;
        el.classList.toggle('ui-interaction-locked', isProcessing);
      }
    });

    if (this.timelineChips) {
      this.timelineChips.classList.toggle('ui-interaction-locked', isProcessing);
    }
  }

  async finishRecording() {
    this.waveform.setPlayhead(-1);
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    this.recordState = 'processing';
    this.updateRecordButtonUI();
    this.setBoothProcessing(true);
    this.stageVideo.pause();

    const res = await this.audio.stopRecording();
    this.audio.stopAllPlayback();

    if (!res || !res.blob) {
      this.recordState = 'idle';
      this.updateRecordButtonUI();
      this.setBoothProcessing(false);
      this.showToast("Nothing was recorded. Check your microphone.");
      return;
    }

    const currentTakeBlob = res.blob;
    await this.uploadTake(this.currentLineIndex, currentTakeBlob, res.audioBuffer);
  }

  async uploadTake(lineIndex, blob, recordedBuffer = null) {
    const offsetMs = parseInt(this.sliderNudge.value, 10);
    const pitch = parseFloat(this.sliderPitch.value);
    const reverb = parseFloat(this.sliderReverb.value) / 100.0;
    const gain = parseFloat(this.sliderGain.value);
    // Ask the server to apply this take's scene-matched gain unless the slider was moved
    // off 0 / off the previous take's auto gain (the slider still shows that take's level).
    const prevTake = this.takeForLine(lineIndex);
    const prevAuto = prevTake ? parseFloat(prevTake.auto_gain_db) : NaN;
    const autoGain = gain === 0 || (!Number.isNaN(prevAuto) && Math.abs(gain - prevAuto) < 0.05);

    const formData = new FormData();
    formData.append('file', blob, `take_${lineIndex}.webm`);
    formData.append('user_id', this.user.id);
    formData.append('user_name', this.user.name);
    formData.append('offset_ms', offsetMs);
    formData.append('pitch_semitones', pitch);
    formData.append('reverb_wet', reverb);
    formData.append('gain_db', gain);
    formData.append('noise_reduction', this.applyNoiseReduction ? 'true' : 'false');
    formData.append('auto_gain', autoGain ? 'true' : 'false');

    try {
      const lineId = this.roomState.pack.lines[lineIndex].line_id;
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/lines/${lineId}/takes`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();
      if (data.line) {
        if (!this.roomState.takes) this.roomState.takes = {};
        this.roomState.takes[lineId] = data.line;
      }
      this.audio.evictTakeCache(this.takeForLine(lineIndex));
      if (recordedBuffer) {
        this.currentTakeBuffer = recordedBuffer;
        if (data.take && data.take.url) {
          this.screeningBuffers.set(data.take.url, recordedBuffer);
        }
      }
      this.showToast("Take saved");
      await this.loadBoothLine(lineIndex);
    } catch (err) {
      this.recordState = 'idle';
      this.updateRecordButtonUI();
      this.showToast(this.friendlyError(err, "That take didn't save. Record it again."));
    } finally {
      this.setBoothProcessing(false);
    }
  }

  stepLine(delta) {
    if (this.isProcessingTake || !this.roomState) return;
    this.cancelCurrentCountdown();
    const totalLines = this.roomState.pack.lines.length;
    const myAssignedChars = this.getMyAssignedCharacters();

    if (myAssignedChars.length > 0 && this.filterMyLinesOnly) {
      const myLines = this.roomState.pack.lines.filter(l => myAssignedChars.includes(l.character));
      if (myLines.length > 0) {
        const currentPos = myLines.findIndex(l => l.index === this.currentLineIndex);
        if (delta > 0 && currentPos >= myLines.length - 1) {
          this.handleUserFinishedAllLines();
          return;
        }
        let nextPos = (currentPos >= 0 ? currentPos : 0) + delta;
        if (nextPos < 0) nextPos = 0;
        if (nextPos >= myLines.length) nextPos = myLines.length - 1;
        this.loadBoothLine(myLines[nextPos].index);
        return;
      }
    }

    if (delta > 0 && this.currentLineIndex >= totalLines - 1) {
      this.handleUserFinishedAllLines();
      return;
    }

    const target = Math.max(0, Math.min(totalLines - 1, this.currentLineIndex + delta));
    this.loadBoothLine(target);
  }

  handleUserFinishedAllLines() {
    if (this.isProcessingTake) return;
    if (!this.isReadyForScreening) {
      this.toggleMyReadiness();
    } else {
      this.showToast("You're marked ready");
    }

    const isHost = this.isHost({ allowDummy: true });
    if (isHost) {
      const users = Object.values(this.roomState?.users || {}).filter(u => u.is_online);
      const readyCount = users.filter(u => u.is_ready).length;
      if (confirm(`All your lines are done. ${readyCount} of ${users.length} actors are ready.\n\nGo to the premiere now?`)) {
        this.showView('screening');
        this.setupScreeningView();
        this.broadcastMyStatus('screening');
      }
    } else {
      this.showToast("All your lines are done. The host will start the premiere.");
    }
  }

  /** Deletes the take in the dub; the line falls back to its newest other take. */
  async clearCurrentTake() {
    if (this.isProcessingTake) return;
    this.cancelCurrentCountdown();
    const lineIndex = this.currentLineIndex;
    const line = this.roomState?.pack?.lines?.[lineIndex];
    const take = this.takeForLine(lineIndex);
    if (!line || !take) {
      this.showToast("Record a take first");
      return;
    }
    if (!confirm(`Delete take ${take.number}? This can't be undone.`)) return;

    try {
      const res = await fetch(
        `/api/rooms/${this.roomState.room_id}/lines/${line.line_id}/takes/${take.take_id}?user_id=${encodeURIComponent(this.user.id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      this.audio.evictTakeCache(take);
      if (data.line) {
        this.roomState.takes[line.line_id] = data.line;
      } else {
        delete this.roomState.takes[line.line_id];
      }
      this.showToast("Take deleted");
      if (lineIndex === this.currentLineIndex) this.loadBoothLine(lineIndex);
    } catch (err) {
      this.showToast(this.friendlyError(err, "That take wasn't deleted. Try again."));
    }
  }
}
