// studio/booth.js - Recording booth: line navigation, countdown and recording, takes,
// waveform/nudge, A/B preview and noise reduction.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { WaveformRenderer } from '../waveform.js';
import { openDialog, plural, announce } from '../ui_common.js';
import { pickedTake, lineTakes, takeCount } from './takes.js';
import { resolveChain } from './voice.js';
import { micErrorMessage } from './audio_setup.js';
import { renderPresenceStack, closePresence } from './presence.js';
import { initLineStrip, centreChip, focusChip, updateStripEdges } from './line_strip.js';

const LOCK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const SAVING_ICON = '<span class="spinning" style="display:inline-flex;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg></span>';
const IDLE_HINT = '<kbd>Space</kbd> · 3-beat count-in';
// Inert and dimmed during the count-in and while recording: only the record button, the
// picture, the line and the waveform stay (the waveform shows the live trace, undimmed and
// not draggable: renderTakeDependents). The header goes as a whole, so a control added to
// it later is covered too; only the connection banner always stays live.
const INERT_WHILE_TAKING = [
  'header.app-header > .header-left', 'header.app-header > .header-status',
  '#view-booth .stage-top-bar', '#view-booth .nudge-preset-bar',
  '#btn-expand-video', '#prompter-resize-handle', '#view-booth .transport-seg', '#mic-sync-hint',
  '#booth-column-scroll', '#view-booth .booth-nav-group',
].join(', ');

export class BoothMethods {
  toggleFilterLines() {
    this.filterMyLinesOnly = !this.filterMyLinesOnly;
    this.chipsScrolledLine = null;
    this.renderTimelineChips();
    this.showToast(this.filterMyLinesOnly ? "Showing your lines" : "Showing all lines");
  }

  /** "My lines", pressed while the strip shows only yours. The name stays put and
   *  aria-pressed carries the state (a swapped label would read "All lines, not pressed"). */
  renderLineFilterToggle() {
    if (this.btnToggleFilterLines) {
      this.btnToggleFilterLines.setAttribute('aria-pressed', String(!!this.filterMyLinesOnly));
      this.btnToggleFilterLines.dataset.tip = this.filterMyLinesOnly
        ? "Showing your lines. Click to show everyone's"
        : "Showing everyone's lines, yours filled in. Click for only yours";
    }
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
      lineEnd: line.duration || 3.0,
    });
    this.waveform.emptyTakeText = this.canRecordLine(line) ? 'No takes yet. Press Space to record.' : 'No takes yet.';
  }

  /** "✓ Matched" while the take sits at its scene-matched level, and Auto for takes that
   *  have one. Reads the take's own values: the dial only moves in 0.5 dB steps. */
  renderGainMatchBadge(take) {
    const hasAuto = !!take && take.auto_gain_db !== undefined && take.auto_gain_db !== null;
    if (this.btnAutoMatchGain) this.btnAutoMatchGain.style.display = hasAuto ? 'inline-flex' : 'none';
    const matched = hasAuto && Math.abs((parseFloat(take.gain_db) || 0) - parseFloat(take.auto_gain_db)) < 0.05;
    this.renderVoiceSummary(take, matched);
    if (!this.badgeGainMatch) return;
    this.badgeGainMatch.textContent = '✓ Matched';
    this.badgeGainMatch.style.display = matched ? 'inline-block' : 'none';
  }

  /** The Voice card's summary of what All effects holds: "level matched · noise cleanup on",
   *  the level you set ("level +2 dB") once you turned it, "level as recorded" at 0 dB on a
   *  take the engine couldn't level, and "level matched when you record" before the first take. */
  renderVoiceSummary(take = this.takeForLine(this.currentLineIndex), matched = null) {
    const summary = document.getElementById('voice-summary');
    if (!summary) return;
    if (matched === null) {
      matched = !!take && take.auto_gain_db != null
        && Math.abs((parseFloat(take.gain_db) || 0) - parseFloat(take.auto_gain_db)) < 0.05;
    }
    let level = 'level matched when you record';
    if (take && matched) level = 'level matched';
    else if (take) level = this.gainText(take.gain_db) === '0 dB' ? 'level as recorded' : `level ${this.gainText(take.gain_db)}`;
    summary.textContent = `${level} · noise cleanup ${this.checkNoiseReduction?.checked ? 'on' : 'off'}`;
  }

  /** "+1.9 dB", one decimal. */
  gainText(db) {
    const v = Math.round((Number(db) || 0) * 10) / 10;
    return `${v > 0 ? '+' : ''}${v} dB`;
  }

  /** The number the next take on this line gets. */
  nextTakeNumber(line) {
    const entry = line ? this.roomState?.takes?.[line.line_id] : undefined;
    return entry?.next_number || takeCount(this.roomState?.takes, line) + 1;
  }

  /** The lines you can record, and how many of them have a take. */
  myLineProgress() {
    const lines = (this.roomState?.pack?.lines || []).filter((l) => this.canRecordLine(l));
    const recorded = lines.filter((l) => takeCount(this.roomState.takes, l) > 0).length;
    return { recorded, total: lines.length };
  }

  /** The take saving on this line right now (its upload fields), or null. */
  savingTake(line) {
    const s = line ? this.savingLines[line.line_id] : null;
    return s && s.roomId === this.roomState?.room_id ? s : null;
  }

  /** Marks a line as saving the take with these upload fields, or done, and redraws it. */
  setLineSaving(fields, saving) {
    if (saving) this.savingLines[fields.lineId] = fields;
    else if (this.savingLines[fields.lineId] === fields) delete this.savingLines[fields.lineId];
    else return;
    this.renderLineSaveState(fields.lineId);
  }

  /** The line chips; on the current line also the record deck, Takes, Voice and take lane. */
  renderLineSaveState(lineId) {
    if (!this.roomState) return;
    this.renderTimelineChips();
    if (this.roomState.pack.lines[this.currentLineIndex]?.line_id !== lineId) return;
    this.updateRecordButtonUI();
    this.renderTakesCard();
    this.refreshVoiceControls();
    this.renderTakeLaneNote();
  }

  /** "Saving… cleaning up noise" over the take lane while the current line saves. */
  renderTakeLaneNote() {
    const s = this.savingTake(this.roomState?.pack?.lines?.[this.currentLineIndex]);
    this.waveform.setTakeLaneNote(s ? (s.noiseReduction ? 'Saving… cleaning up noise' : 'Saving…') : null);
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

  /** The one place recordState changes. Counting in or recording, the rest of the page
   *  is inert (body.is-taking dims it); any other state gives it back, and the timing
   *  row keeps its own "no take yet" inert (renderTakeDependents). */
  setRecordState(state) {
    this.recordState = state;
    const taking = state === 'countdown' || state === 'recording';
    document.body.classList.toggle('is-taking', taking);
    document.querySelectorAll(INERT_WHILE_TAKING).forEach((el) => el.toggleAttribute('inert', taking));
    this.renderTakeDependents();
    if (!taking) return;
    // The who's-here popover would sit over the picture for the whole take.
    closePresence(document.getElementById('booth-presence'));
    // A take started from a take row, Next line or the stack: focus goes to Record, the one
    // control left, instead of falling to the page.
    if (document.activeElement?.closest?.('[inert]')) this.btnRecordMain?.focus();
  }

  cancelCurrentCountdown() {
    this.countdownSessionId++;
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    // An abandoned take must still stop the recorder and release the mic;
    // stopAllPlayback() no longer does that while a recording is running.
    // A recorder that's already stopping is handing its take over to be saved.
    if (this.audio && this.audio.isRecording && this.recordState !== 'stopping') {
      this.audio.stopRecording().catch(() => { });
    }
    this.setRecordState('idle');
    this.endRecordingFeedback();
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
    this.flushVoiceSave();
    // A delete waiting on its Undo goes out once you leave its line.
    if (this.pendingDelete && this.pendingDelete.lineId !== this.roomState.pack.lines[index].line_id) {
      this.flushPendingDelete();
    }
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

    // Scene numbering, as on the line chips; your own position and the time range in the tooltip.
    this.boothLineIndicator.textContent = `Line ${index + 1} of ${this.roomState.pack.lines.length}`;
    // As wide as "Line 40 of 40" (a mono face), so the strip beside it doesn't twitch.
    this.boothLineIndicator.style.minWidth = `${`Line ${this.roomState.pack.lines.length} of ${this.roomState.pack.lines.length}`.length}ch`;
    const range = `${(line.start || 0).toFixed(1)}–${(line.end || 0).toFixed(1)} s`;
    this.boothLineIndicator.dataset.tip = isMyLine && myLinePos > 0
      ? `Your line ${myLinePos} of ${myAssignedLines.length} · ${range}` : range;

    const lineDur = (line.duration !== undefined ? line.duration : Math.max(0.5, (line.end || 0) - (line.start || 0)));
    this.boothTimeBadge.textContent = `${lineDur.toFixed(1)} s`;
    this.stageCaptionChar.innerText = isMyLine ? line.character.toUpperCase() : `${line.character.toUpperCase()} (LOCKED)`;
    const lineCap = (line.caption || line.text || '').trim();
    this.stageCaptionText.innerText = lineCap ? `“${lineCap}”` : `(${line.character}, no subtitle)`;

    const take = pickedTake(this.roomState.takes, line);
    this.hideDoneAsk();
    this.setNudgeValue(take ? (take.offset_ms || 0) : 0, false);
    const activeNoiseRed = take ? (take.noise_reduction !== false) : this.applyNoiseReduction;
    if (this.checkNoiseReduction) this.checkNoiseReduction.checked = activeNoiseRed;
    const gainDb = take ? (parseFloat(take.gain_db) || 0) : 0;
    this.sliderGain.value = gainDb;
    this.valGain.textContent = this.gainText(gainDb);
    this.renderGainMatchBadge(take);

    this.startTakeVoice(line, take);
    this.updateKnobsVisuals();

    this.setRecordState('idle');
    this.updateRecordButtonUI(take);
    this.updateTimingCaption();
    this.renderTakesCard();
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
    this.renderTakeLaneNote();

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

    if (this.btnPrevLine) this.btnPrevLine.disabled = isFirst;

    if (this.btnNextLine) {
      this.btnNextLine.textContent = isLast ? 'Done ›' : 'Next line ›';
      this.btnNextLine.dataset.tip = isLast ? 'Marks you ready for the premiere (.)' : 'Next line (.)';
    }
    this.renderBoothToolbar();
  }

  /** What follows whether the line has a take (one waiting on its Undo doesn't count):
   *  - the timing row and the waveform are inert before the first take, the row dimmed,
   *    since there is nothing to move yet; on a line you can't record the row is hidden
   *    and the waveform is view only; counting in or recording, the row is inert too and the
   *    waveform shows the live trace but can't be dragged;
   *  - Next line (and Done) is amber only once your line has a take. */
  renderTakeDependents() {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (!line) return;
    const count = takeCount(this.roomState.takes, line) - (this.pendingDelete?.lineId === line.line_id ? 1 : 0);
    const mine = this.canRecordLine(line);
    const empty = count <= 0;
    const taking = this.recordState === 'countdown' || this.recordState === 'recording';
    const row = document.querySelector('#view-booth .nudge-preset-bar');
    if (row) {
      row.hidden = !mine;
      row.toggleAttribute('inert', (mine && empty) || taking);
      row.classList.toggle('is-idle-empty', mine && empty);
    }
    document.querySelector('#view-booth .waveform-canvas-box')?.toggleAttribute('inert', empty || !mine || taking);
    if (this.btnNextLine) {
      this.btnNextLine.classList.toggle('btn-primary', !(mine && empty));
      this.btnNextLine.classList.toggle('btn-secondary', mine && empty);
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

  /** The record deck: state badge, record button, the next-action lines and the transport.
   *  The badge is READY, COUNT-IN, REC, SAVING, NO MIC or OFFLINE; hidden on lines you
   *  can't record, where the line says who voices the character. */
  updateRecordButtonUI(take = null) {
    if (!take) {
      take = this.takeForLine(this.currentLineIndex);
    }
    this.renderTransport(take);
    if (!this.btnRecordMain) return;

    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const badge = this.recordEngineBadge;
    const sub = this.recordStatusSub;
    // On a line you can't record: no record button, and Monitor keeps only Backing. A take
    // under way keeps its Stop, even if the host took the role away meanwhile.
    const taking = this.recordState === 'countdown' || this.recordState === 'recording';
    const readOnly = !taking && !this.canRecordLine(line);
    const bezel = this.btnRecordMain.closest('.record-bezel-wrapper');
    if (bezel) bezel.hidden = readOnly;
    const switches = document.querySelector('#card-studio-monitoring .monitor-switches');
    if (switches) switches.hidden = readOnly;
    const show = ({ state = null, glyph, html = false, cls = '', main, hint = '', hintHtml = false, name }) => {
      if (badge) {
        badge.hidden = !state;
        badge.textContent = state || '';
        badge.classList.toggle('is-rec', state === 'REC');
        badge.classList.toggle('is-warn', state === 'NO MIC' || state === 'OFFLINE');
      }
      this.btnRecordMain.className = `btn-big-record${cls}`;
      if (html) this.recordIcon.innerHTML = glyph;
      else this.recordIcon.textContent = glyph;
      this.recordStatusLabel.textContent = main;
      if (sub) {
        if (hintHtml) sub.innerHTML = hint;
        else sub.textContent = hint;
        sub.hidden = !hint;
      }
      this.btnRecordMain.setAttribute('aria-label', name);
      this.btnRecordMain.dataset.tip = name;
    };

    if (readOnly) {
      const assignedIds = (this.roomState?.role_assignments?.[line?.character] || []);
      const assignedNames = assignedIds.map(uid => this.roomState?.users?.[uid]?.name).filter(Boolean);
      const main = assignedNames.length > 0
        ? `${line?.character} is voiced by ${assignedNames.join(', ')}`
        : `Nobody is cast as ${line?.character} yet`;
      show({ glyph: LOCK_ICON, html: true, cls: ' locked', main, name: main });
      return;
    }

    const n = this.nextTakeNumber(line);
    const saving = this.savingTake(line);
    if (this.recordState === 'recording') {
      show({ state: 'REC', glyph: '■', cls: ' recording', main: 'Recording · Space to stop', name: 'Stop recording (Space)' });
    } else if (this.recordState === 'countdown') {
      show({ state: 'COUNT-IN', glyph: '✕', main: 'Counting in… Space or click to cancel', name: 'Cancel the count-in (Space)' });
    } else if (saving) {
      show({ state: 'SAVING', glyph: SAVING_ICON, html: true, main: `Saving take ${saving.number}…`, name: `Saving take ${saving.number}` });
    } else {
      const idle = { glyph: '●', main: `Record take ${n}`, name: `Record take ${n} (Space)` };
      if (this.audioSetup?.permission === 'denied' || this.micError) {
        show({ ...idle, state: 'NO MIC', hint: micErrorMessage(this.micError || { name: 'NotAllowedError' }) });
      } else if (this.socket && this.socket.connectionState !== 'open') {
        show({ ...idle, state: 'OFFLINE', hint: "Takes will upload when you're back online." });
      } else {
        show({ ...idle, state: 'READY', hint: IDLE_HINT, hintHtml: true });
      }
    }
  }

  /** "▶ Original | ▶ Take N": Take waits for a take, and aria-pressed marks the side you hear. */
  renderTransport(take = this.takeForLine(this.currentLineIndex)) {
    if (!this.btnPlayOrig || !this.btnPreviewTake) return;
    this.btnPreviewTake.disabled = !take || !!this.savingTake(this.roomState?.pack?.lines?.[this.currentLineIndex]);
    if (this.labelPreviewTake) this.labelPreviewTake.textContent = take ? `Take ${take.number}` : 'Take';
    const playingTake = this.isPlayingCurrentTake();
    const hearOriginal = !!this.isPlayingReference || (playingTake && this.audio.abState === 'B');
    this.btnPlayOrig.setAttribute('aria-pressed', String(hearOriginal));
    this.btnPreviewTake.setAttribute('aria-pressed', String(playingTake && this.audio.abState !== 'B'));
    this.renderTakePlayButtons();
  }

  /** A transport press. While the take plays, the other side switches what you hear in
   *  place (the preview carries both); the side you hear stops. Otherwise it plays that side. */
  pressTransport(side) {
    const want = side === 'take' ? 'A' : 'B';
    if (this.isPlayingCurrentTake()) {
      if (this.audio.abState !== want) this.setABMode(want);
      else this.stopBoothPlayback();
      return;
    }
    if (side === 'take') {
      this.setABMode('A');
      this.previewCurrentTake();
    } else {
      this.playOriginalReference();
    }
  }

  /** The A key: while the take plays it swaps what you hear in place; otherwise it plays
   *  the take, or the original on a line with no take yet. */
  switchTransportSide() {
    if (this.isPlayingCurrentTake()) {
      this.setABMode(this.audio.abState === 'B' ? 'A' : 'B');
      return;
    }
    this.pressTransport(this.takeForLine(this.currentLineIndex) ? 'take' : 'original');
  }

  /** One fixed-width button per line, numbered as in the scene: "1 ✓ 3" (the spoken
   *  name and tooltip say "Line 1, Ana, recorded, 3 takes"). Your lines are filled,
   *  everyone else's hollow. The strip itself (wheel, drag, keys, fades) is line_strip.js. */
  renderTimelineChips() {
    if (!this.roomState || !this.timelineChips) return;
    const strip = this.timelineChips;
    initLineStrip(strip);
    this.renderLineFilterToggle();
    const myAssignedChars = this.getMyAssignedCharacters();
    // A redraw (a take saved, someone else's take) keeps the scroll and a focused chip;
    // when the line changed (, and . with a chip focused), focus goes with the line.
    const keepLeft = strip.scrollLeft;
    const focusedLine = strip.contains(document.activeElement) ? document.activeElement.dataset.line : undefined;
    const lineChanged = this.chipsDrawnLine !== this.currentLineIndex;
    this.chipsDrawnLine = this.currentLineIndex;
    const frag = document.createDocumentFragment();
    let activeChip = null;

    this.roomState.pack.lines.forEach((l, idx) => {
      const isMyLine = myAssignedChars.includes(l.character);
      // "My lines" hides other people's lines, except the one you're on.
      if (this.filterMyLinesOnly && !isMyLine && myAssignedChars.length > 0 && idx !== this.currentLineIndex) {
        return;
      }

      const chip = document.createElement('button');
      const count = takeCount(this.roomState.takes, l) - (this.pendingDelete?.lineId === l.line_id ? 1 : 0);
      const isActive = idx === this.currentLineIndex;

      chip.type = 'button';
      chip.dataset.line = String(idx);
      // One tab stop: the current chip. The arrows move along the rest.
      chip.tabIndex = isActive ? 0 : -1;
      const saving = !!this.savingTake(l);
      const waiting = !saving && this.waitingTakes(l).length > 0;
      chip.className = 'chip-item';
      chip.classList.toggle('active', isActive);
      chip.classList.toggle('done', count > 0);
      chip.classList.toggle('my-line', isMyLine);
      chip.classList.toggle('is-other', myAssignedChars.length > 0 && !isMyLine);
      chip.classList.toggle('is-saving', saving);
      if (isActive) {
        chip.setAttribute('aria-current', 'step');
        activeChip = chip;
      }
      // The tooltip says the same as the label, so it isn't read twice.
      const name = `Line ${idx + 1}, ${l.character}, ${count ? `recorded, ${plural(count, 'take')}` : 'not recorded'}`
        + (saving ? ', saving a take' : '') + (waiting ? ', a take waiting to upload' : '');
      chip.setAttribute('aria-label', name);
      chip.dataset.tip = name;
      const num = document.createElement('span');
      num.className = 'chip-num';
      num.textContent = String(idx + 1);
      chip.appendChild(num);
      if (saving || waiting) {
        // In place of the count, so the chip keeps its width: ↑ while a take goes up,
        // ⟳ while one waits to upload again.
        const mark = document.createElement('span');
        mark.className = 'chip-saving';
        mark.classList.toggle('is-waiting', waiting);
        mark.textContent = saving ? '↑' : '⟳';
        chip.appendChild(mark);
      } else if (count) {
        const tick = document.createElement('span');
        tick.className = 'chip-tick';
        tick.textContent = '✓';
        const n = document.createElement('span');
        n.className = 'chip-count';
        n.textContent = count > 99 ? '99+' : String(count);
        chip.append(tick, n);
      }

      chip.addEventListener('click', () => {
        this.loadBoothLine(idx);
      });

      frag.appendChild(chip);
    });

    strip.replaceChildren(frag);
    // Only if the swap moved it: setting it anyway would stop a glide that's under way.
    if (strip.scrollLeft !== keepLeft) strip.scrollLeft = keepLeft;
    if (focusedLine !== undefined) {
      const again = (!lineChanged && strip.querySelector(`.chip-item[data-line="${focusedLine}"]`)) || activeChip;
      if (again) focusChip(strip, again);
    }
    updateStripEdges(strip);

    // Centred when the line changes (or after the toggle), not on every redraw, so a
    // strip you scrolled stays put.
    if (activeChip && this.chipsScrolledLine !== this.currentLineIndex) {
      this.chipsScrolledLine = this.currentLineIndex;
      // The chip as drawn by then: another redraw may have replaced this one.
      cancelAnimationFrame(this.chipsCentreFrame);
      this.chipsCentreFrame = requestAnimationFrame(() => centreChip(strip, strip.querySelector('.chip-item[aria-current]')));
    }
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
    this.playingHistoryTakeId = null;
    if (this.soundWait) this.endSoundWait(this.soundWait);
    this.releaseVoiceWaiters();
    this.audio.stopAllPlayback();
    if (this.stageVideo) {
      this.stageVideo.pause();
    }
    this.waveform.setPlayhead(-1);
    this.renderTransport();
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
    this.renderTransport();

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
          this.renderTransport();
        }
      },
    });
  }

  // Preview Take (Bi-directional Sync & Live Waveform Animation)
  // Preview plays the take as the engine rendered it, waiting (button pulsing) while the
  // render is on its way. Without voice effects installed, it plays the take as recorded.
  async previewCurrentTake() {
    this.cancelCurrentCountdown();
    if (this.isPlayingTake || (this.soundWait && !this.playingHistoryTakeId)) {
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

    const token = this.activePlaybackToken;
    const scheduler = this.voiceScheduler;
    if (scheduler && scheduler.state !== 'current' && scheduler.state !== 'unavailable') {
      const wait = this.beginSoundWait(this.btnPreviewTake);
      await this.waitForTakeVoice();
      this.endSoundWait(wait);
      if (token !== this.activePlaybackToken) return;
    }

    let buffer = null;
    if (this.voiceUnavailable) {
      buffer = await this.rawTakeBuffer(take);
    } else if (this.voiceRender) {
      buffer = this.voiceRender.buffer;
    } else {
      this.showToast("Your take's sound isn't ready yet. Try again in a moment.");
      if (this.voiceScheduler) this.voiceScheduler.want(this.voiceChain, this.voicePlayState());
      return;
    }
    if (!buffer || token !== this.activePlaybackToken) return;

    await this.playTakeOverScene(line, buffer, {
      offsetMs: parseInt(this.sliderNudge.value, 10),
      gain: parseFloat(this.sliderGain.value),
    });
  }

  /** The current take as recorded (played only while voice effects aren't installed). */
  async rawTakeBuffer(take) {
    if (!this.currentTakeBuffer) {
      try {
        this.currentTakeBuffer = await this.audio.loadAudioBuffer(take.url, true);
      } catch (e) {
        console.warn("[App] Error loading take audio:", e);
      }
    }
    if (!this.currentTakeBuffer) {
      this.showToast("The take is still loading. Try again in a moment.");
    }
    return this.currentTakeBuffer;
  }

  /** Plays a take's sound over the scene from the line's start, at its timing and level. */
  async playTakeOverScene(line, takeBuffer, { offsetMs, gain }) {
    this.activePlaybackToken = (this.activePlaybackToken || 0) + 1;
    const token = this.activePlaybackToken;
    this.isPlayingTake = true;
    this.renderTransport();

    const offsetSec = offsetMs / 1000.0;
    const previewStartSec = Math.max(0, line.start + Math.min(0, offsetSec));

    await this.syncVideoSeek(previewStartSec);
    if (token !== this.activePlaybackToken) return;

    try {
      await this.stageVideo.play();
    } catch (e) { }

    const startAudioTime = performance.now();
    const previewDurationSec = Math.max(line.duration || 3.0, (takeBuffer?.duration || 3.0) + Math.max(0, offsetSec)) + 0.3;

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
      takeBuffer,
      origBuffer: this.origBuffer,
      offsetMs,
      gainDb: gain,
      onEnded: () => {
        if (token === this.activePlaybackToken) {
          this.isPlayingTake = false;
          this.waveform.setPlayhead(-1);
          this.stageVideo.pause();
          this.renderTransport();
        }
      },
    });
  }

  /** A = the take, B = the original, swapped in place while the take's preview plays. */
  setABMode(state) {
    this.audio.setABState(state);
    this.renderTransport();
  }

  setNudgeValue(val, syncSocket = true) {
    const clamped = Math.max(-800, Math.min(800, val));
    this.sliderNudge.value = clamped;
    this.nudgeDisplay.textContent = `${clamped > 0 ? '+' : ''}${clamped} ms`;
    this.waveform.offsetMs = clamped;
    this.waveform.render();
    if (syncSocket) {
      this.syncTakeParams();
    }
    this.updateTimingCaption();
  }

  /** "Lined up automatically" by the timing readout until the take is nudged, and
   *  Original speed on a fitted take. "Nudged" is derived: 5 ms or more off auto_offset_ms.
   *  "Reset to auto" looks active only at the take's automatic timing (0 for older takes). */
  updateTimingCaption() {
    if (!this.timingCaption) return;
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const take = this.roomState && this.takeForLine(this.currentLineIndex);
    const autoMs = typeof take?.auto_offset_ms === 'number' ? take.auto_offset_ms : 0;
    this.btnNudgeReset?.classList.toggle('is-active', !!take && parseInt(this.sliderNudge.value, 10) === autoMs);
    if (this.timingDragHint) this.timingDragHint.hidden = !take;
    const stretch = Number(take?.stretch ?? 1);
    const fitted = !!take && Number.isFinite(stretch) && stretch !== 1;
    const auto = !!take && take.aligned === true && typeof take.auto_offset_ms === 'number'
      && Math.abs(parseInt(this.sliderNudge.value, 10) - take.auto_offset_ms) < 5;
    this.timingCaption.textContent = fitted ? 'Lined up and fitted to the line' : 'Lined up automatically';
    this.timingCaption.style.display = auto ? '' : 'none';
    if (this.btnOriginalSpeed) {
      this.btnOriginalSpeed.style.display = fitted && this.canRecordLine(line) ? '' : 'none';
    }
  }

  /** Undoes a fitted take's speed change. The engine rewrites the audio and re-times it. */
  async playAtOriginalSpeed() {
    const lineIndex = this.currentLineIndex;
    const line = this.roomState?.pack?.lines?.[lineIndex];
    if (this.originalSpeedBusy || this.savingTake(line)) return;
    const take = this.roomState && this.takeForLine(lineIndex);
    if (!line || !take) return;
    this.originalSpeedBusy = true;
    try {
      const res = await fetch(
        `/api/rooms/${this.roomState.room_id}/lines/${line.line_id}/takes/${take.take_id}/original_speed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: this.user.id }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      // The take_params_updated broadcast carries the same state; apply the reply now so
      // the booth doesn't wait on the socket (its handler doesn't reload the line).
      const entryTakes = lineTakes(this.roomState.takes, line);
      const pos = data.take ? entryTakes.findIndex((t) => t.take_id === data.take.take_id) : -1;
      if (pos >= 0) entryTakes[pos] = { ...data.take, peaks: data.take.peaks || entryTakes[pos].peaks };
      this.audio.evictTakeCache(take);
      if (lineIndex === this.currentLineIndex) await this.loadBoothLine(lineIndex);
    } catch (err) {
      this.showToast(this.friendlyError(err, "Couldn't change the take's speed. Try again."));
    } finally {
      this.originalSpeedBusy = false;
    }
  }

  /** Sends the take's timing and level. Its sound (voice chain) is saved by flushVoiceSave.
   *  The Level dial shows the take's level rounded to its 0.5 dB steps: while it sits on that
   *  rounding, the take keeps its exact level (gainDb sets one outright). */
  syncTakeParams({ gainDb } = {}) {
    const lineIdx = this.currentLineIndex;
    const offsetMs = parseInt(this.sliderNudge.value, 10);

    const take = this.roomState && this.takeForLine(lineIdx);
    if (!take) return;
    const dial = parseFloat(this.sliderGain.value);
    const current = parseFloat(take.gain_db) || 0;
    const gain = gainDb ?? (Math.abs(dial - current) <= 0.25 ? current : dial);
    take.offset_ms = offsetMs;
    take.gain_db = gain;

    this.socket.updateTakeParams(this.roomState.pack.lines[lineIdx].line_id, take.take_id, {
      offset_ms: offsetMs,
      gain_db: gain,
    });
  }

  /** The Level dial, its readout and match badge, and the playing take's gain, from the take. */
  showTakeLevel(take) {
    const gainDb = parseFloat(take.gain_db) || 0;
    this.sliderGain.value = gainDb;
    this.valGain.textContent = this.gainText(gainDb);
    this.audio.setGain(gainDb);
    this.updateKnobsVisuals();
    this.renderGainMatchBadge(take);
  }

  isPlayingCurrentTake() {
    return !!this.isPlayingTake && !this.playingHistoryTakeId;
  }

  /** A play button pulses while its sound is on the way. */
  beginSoundWait(button) {
    const wait = { button };
    this.soundWait = wait;
    if (button) button.classList.add('is-waiting-sound');
    this.renderTakePlayButtons();
    return wait;
  }

  endSoundWait(wait) {
    if (wait.button) wait.button.classList.remove('is-waiting-sound');
    if (this.soundWait === wait) this.soundWait = null;
    this.renderTakePlayButtons();
  }

  // --- Studio Noise Reduction ---

  setNoiseReduction(enabled) {
    this.applyNoiseReduction = !!enabled;
    localStorage.setItem('dubmate_noise_reduction', this.applyNoiseReduction);

    if (this.checkNoiseReduction && this.checkNoiseReduction.checked !== this.applyNoiseReduction) {
      this.checkNoiseReduction.checked = this.applyNoiseReduction;
    }
    this.renderVoiceSummary();

    const currentTake = this.takeForLine(this.currentLineIndex);
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (currentTake && this.views.booth.classList.contains('active') && !this.savingTake(line)) {
      this.toggleTakeNoiseReduction(this.currentLineIndex, this.applyNoiseReduction);
    }
  }

  async toggleTakeNoiseReduction(lineIndex, enable) {
    const target = this.roomState && this.takeForLine(lineIndex);
    if (!target || this.savingTake(this.roomState.pack.lines[lineIndex])) {
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
        // The take's audio changed, so its render is of the old audio: ask for a new one.
        this.voiceRender = null;
        if (this.voiceScheduler) this.voiceScheduler.want(this.voiceChain, this.voicePlayState());

        const line = this.roomState.pack.lines[lineIndex];
        const take = this.takeForLine(lineIndex);
        let origPeaks = line.peaks || [];
        let takePeaks = take ? (take.peaks || []) : [];

        this.setWaveformForLine(line, take, origPeaks, takePeaks);

        // The server re-matches gain for the swapped audio; show the take's new level.
        if (take) this.showTakeLevel(take);

        if (take && take.url) {
          const newBuf = await this.audio.loadAudioBuffer(take.url, true);
          this.currentTakeBuffer = newBuf;
          if (newBuf && (!takePeaks || takePeaks.length === 0)) {
            takePeaks = WaveformRenderer.extractPeaksFromBuffer(newBuf, 100);
            this.setWaveformForLine(line, take, origPeaks, takePeaks);
          }
        }
      }

      this.showToast(enable ? "Noise cleanup on" : "Noise cleanup off. Original take restored.");
    } catch (err) {
      console.warn("[App] Error toggling take noise reduction:", err);
      this.showToast(this.friendlyError(err, "Couldn't change noise cleanup."));
    }
  }

  async toggleRecording() {
    if (!this.roomState) return;
    // A take under way can always be ended, even if the host took the role away meanwhile.
    if (this.recordState === 'countdown') {
      this.cancelCurrentCountdown();
      return;
    }

    if (this.recordState === 'recording') {
      await this.finishRecording();
      return;
    }

    const line = this.roomState.pack.lines[this.currentLineIndex];
    if (!this.canRecordLine(line)) {
      this.showToast(`Line ${this.currentLineIndex + 1} belongs to ${line.character}. Only their actor can record it.`);
      return;
    }

    // The recorder is handing the take over; then this line saves it in the background.
    if (this.recordState === 'stopping') return;
    const saving = this.savingTake(line);
    if (saving) {
      this.showToast(`Still saving take ${saving.number}`);
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
    this.setRecordState('countdown');
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

    this.setRecordState('recording');
    this.updateRecordButtonUI();
    // Fixed for this take: toggling the checkbox before it's saved mustn't change
    // whether the engine treats it as a guide-voice take.
    const guideVoice = !!this.checkGuideVoice?.checked;
    this.recordingGuideVoice = guideVoice;

    try {
      await this.audio.startRecording();
    } catch (err) {
      // The mic didn't open after all: give the booth back and say why (the deck shows NO MIC).
      if (this.countdownSessionId === sessionId) {
        this.micError = err;
        this.cancelCurrentCountdown();
        this.showToast(micErrorMessage(err));
      }
      return;
    }
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
    if (guideVoice && this.origBuffer) {
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

    // Each frame: the playhead, the time left on the REC tally and the mic's level in the take lane.
    this.waveform.startLiveTrace();
    if (this.recTally) this.recTally.hidden = false;
    const animRecordPlayhead = () => {
      if (this.recordState !== 'recording' || this.countdownSessionId !== sessionId) {
        this.endRecordingFeedback();
        return;
      }
      const elapsed = (performance.now() - recStartTime) / 1000.0;
      const progress = Math.min(1.0, elapsed / recordingDurationSec);
      this.waveform.setPlayhead(progress);
      if (this.recTallyLeft) this.recTallyLeft.textContent = `${Math.max(0, recordingDurationSec - elapsed).toFixed(1)} s left`;
      const level = this.audio.readInputLevel();
      if (level) this.waveform.pushLiveLevel(progress, level.peak);
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

  /** The playhead, the REC tally and the live trace go when recording ends or is cancelled. */
  endRecordingFeedback() {
    this.waveform.setPlayhead(-1);
    this.waveform.endLiveTrace();
    if (this.recTally) this.recTally.hidden = true;
  }

  async finishRecording() {
    const lineIndex = this.currentLineIndex;
    // What the upload sends, read as recording stops: by the time it goes out the booth
    // may be on another line. The line saves in the background; every other line works.
    const fields = this.takeUploadFields(lineIndex, this.recordingGuideVoice);
    this.endRecordingFeedback();
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    this.setRecordState('stopping');
    this.setLineSaving(fields, true);
    this.stageVideo.pause();

    const res = await this.audio.stopRecording();
    this.audio.stopAllPlayback();
    if (this.recordState === 'stopping') {
      this.setRecordState('idle');
      this.updateRecordButtonUI();
    }

    if (!res || !res.blob) {
      this.setLineSaving(fields, false);
      this.showToast("Nothing was recorded. Check your microphone.");
      return;
    }
    await this.uploadTake(lineIndex, res.blob, res.audioBuffer, fields);
  }

  /** Everything a take's upload sends that belongs to its line, read at once: the line,
   *  timing, level, guide voice, noise cleanup and the sound picked before the take
   *  (`chain`; null keeps the sound of the take it replaces in the dub). */
  takeUploadFields(lineIndex, guideVoice = false) {
    const line = this.roomState.pack.lines[lineIndex];
    const gain = parseFloat(this.sliderGain.value);
    // Ask the server to apply this take's scene-matched gain unless the slider was moved
    // off 0 / off the previous take's auto gain (the slider still shows that take's level).
    const prevTake = this.takeForLine(lineIndex);
    const prevAuto = prevTake ? parseFloat(prevTake.auto_gain_db) : NaN;
    // The dial rounds to 0.5 dB: an unmoved dial on a matched take still counts as matched.
    const prevGain = prevTake ? (parseFloat(prevTake.gain_db) || 0) : NaN;
    const prevMatched = !Number.isNaN(prevAuto) && (Math.abs(gain - prevAuto) < 0.05
      || (Math.abs(gain - prevGain) <= 0.25 && Math.abs(prevGain - prevAuto) < 0.05));
    return {
      roomId: this.roomState.room_id,
      lineId: line.line_id,
      number: this.nextTakeNumber(line),
      sliderOffsetMs: parseInt(this.sliderNudge.value, 10),
      gain,
      autoGain: gain === 0 || prevMatched,
      // The checkbox as it was when this take started recording.
      guideVoice: !!guideVoice,
      noiseReduction: !!this.applyNoiseReduction,
      chain: this.pendingNextTakeChain?.[line.line_id] || null,
    };
  }

  /** Uploads a take with `fields` from takeUploadFields (read now when not given). The
   *  booth reloads only if you're still on that line and not counting in or recording;
   *  "Take saved" toasts only when the line is off screen. */
  async uploadTake(lineIndex, blob, recordedBuffer = null, fields = null) {
    const f = fields || this.takeUploadFields(lineIndex);
    if (this.savingLines[f.lineId] !== f) this.setLineSaving(f, true);
    if (f.offsetMs === undefined) {
      // A synced setup starts the take its measured delay earlier; otherwise it
      // inherits the slider (the picked take's timing) as before.
      await this.updateAudioDeviceList();
      const latencyMs = this.currentLatencyMs();
      f.offsetMs = latencyMs !== null ? -latencyMs : f.sliderOffsetMs;
      // The room check for this microphone tunes the cleanup; '' means standard cleanup.
      f.noiseProfileId = this.currentRoomProfileId() || '';
    }

    const formData = new FormData();
    formData.append('file', blob, `take_${lineIndex}.webm`);
    formData.append('user_id', this.user.id);
    formData.append('user_name', this.user.name);
    // Without a chain the engine gives the new take the sound of the take it replaces.
    if (f.chain) formData.append('chain', JSON.stringify(f.chain));
    formData.append('offset_ms', f.offsetMs);
    formData.append('gain_db', f.gain);
    formData.append('noise_reduction', f.noiseReduction ? 'true' : 'false');
    formData.append('noise_profile_id', f.noiseProfileId);
    formData.append('auto_gain', f.autoGain ? 'true' : 'false');
    // The mic can pick up the guide voice, so the engine doesn't line those takes up.
    formData.append('guide_voice', f.guideVoice ? 'true' : 'false');

    let data;
    try {
      const res = await fetch(`/api/rooms/${f.roomId}/lines/${f.lineId}/takes`, {
        method: 'POST',
        body: formData,
      });
      if (res.status >= 400 && res.status < 500) {
        // The engine refused this take (unreadable audio, a recast line, a room that's gone):
        // trying again can't help, so say why and drop it.
        const detail = (await res.json().catch(() => ({}))).detail;
        this.setLineSaving(f, false);
        if (this.roomState?.room_id === f.roomId) {
          this.showToast(this.friendlyError(new Error(String(detail || `HTTP ${res.status}`)),
            "That take didn't save. Record it again."));
        }
        return;
      }
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      data = await res.json();
    } catch (err) {
      // Offline or a server error: never thrown away. The take waits in memory, in its Takes
      // card with Retry, and goes up again when the room is back.
      console.warn('[DubMate] Take upload failed:', err);
      (this.pendingUploads[f.lineId] ||= []).push({ fields: f, blob, recordedBuffer });
      this.setLineSaving(f, false);
      if (this.roomState?.room_id === f.roomId) {
        this.showToast(`A take on line ${lineIndex + 1} is waiting to upload`);
      }
      return;
    }

    if (this.savingLines[f.lineId] === f) delete this.savingLines[f.lineId];
    if (this.roomState?.room_id !== f.roomId) return;
    // The take has the picked sound now; a sound picked while it saved stays for the next one.
    if (f.chain && this.pendingNextTakeChain[f.lineId] === f.chain) delete this.pendingNextTakeChain[f.lineId];
    if (data.line) {
      if (!this.roomState.takes) this.roomState.takes = {};
      this.roomState.takes[f.lineId] = data.line;
    }
    const index = this.roomState.pack.lines.findIndex((l) => l.line_id === f.lineId);
    this.audio.evictTakeCache(this.takeForLine(index));
    const number = data.take?.number ?? f.number;
    // On screen, the new row is the confirmation.
    const onScreen = this.currentView === 'booth' && index === this.currentLineIndex;
    if (!onScreen) this.showToast(`Take ${number} saved on line ${index + 1}`);
    if (this.shouldOfferMicSync()) this.showMicSyncHint();
    if (onScreen && this.recordState === 'idle') {
      // A fitted take's audio differs from what was recorded; preview the engine's copy.
      const fitted = Number(data.take?.stretch ?? 1) !== 1;
      if (recordedBuffer && !fitted) {
        this.currentTakeBuffer = recordedBuffer;
        if (data.take && data.take.url) {
          this.screeningBuffers.set(data.take.url, recordedBuffer);
        }
      }
      announce(`Take ${number} saved`);
      await this.loadBoothLine(index);
    } else {
      this.renderLineSaveState(f.lineId);
    }
    // A take that waited while this one saved (retries skip a saving line) goes up next.
    const waiting = this.waitingTakes(this.roomState.pack.lines[index])[0];
    if (waiting && this.socket?.connectionState === 'open') this.retryWaitingTake(waiting);
  }

  /** This line's takes waiting to upload (in this room). */
  waitingTakes(line) {
    return (line && this.pendingUploads[line.line_id] || []).filter((p) => p.fields.roomId === this.roomState?.room_id);
  }

  /** Uploads a waiting take again, with the fields it was recorded with. */
  retryWaitingTake(entry) {
    const f = entry.fields;
    const list = this.pendingUploads[f.lineId] || [];
    if (!list.includes(entry) || this.savingLines[f.lineId] || this.roomState?.room_id !== f.roomId) return null;
    list.splice(list.indexOf(entry), 1);
    if (!list.length) delete this.pendingUploads[f.lineId];
    const index = this.roomState.pack.lines.findIndex((l) => l.line_id === f.lineId);
    f.number = this.nextTakeNumber(this.roomState.pack.lines[index]);
    return this.uploadTake(index, entry.blob, entry.recordedBuffer, f);
  }

  /** Back online: each line's waiting takes go up again, one after another. */
  async retryWaitingTakes() {
    await Promise.all(Object.keys(this.pendingUploads).map(async (lineId) => {
      for (const entry of [...this.pendingUploads[lineId]]) await this.retryWaitingTake(entry);
    }));
  }

  discardWaitingTake(entry) {
    const lineId = entry.fields.lineId;
    const list = this.pendingUploads[lineId] || [];
    if (!list.includes(entry)) return;
    list.splice(list.indexOf(entry), 1);
    if (!list.length) delete this.pendingUploads[lineId];
    announce('Take discarded');
    this.renderLineSaveState(lineId);
  }

  stepLine(delta) {
    if (!this.roomState) return;
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

  /** Done on your last line, for host and guests alike: with every line you can record
   *  taken it marks you ready; otherwise it asks first, inline in the footer. */
  handleUserFinishedAllLines() {
    // Ready waits for takes still saving, so the premiere doesn't start without them.
    const lines = this.roomState?.pack?.lines || [];
    const savingIndex = lines.findIndex((l) => this.savingTake(l));
    if (savingIndex >= 0) {
      this.showToast(`Still saving take ${this.savingTake(lines[savingIndex]).number} on line ${savingIndex + 1}`);
      return;
    }
    const { recorded, total } = this.myLineProgress();
    if (recorded < total) {
      this.showDoneAsk(recorded, total);
      return;
    }
    this.finishMyLines();
  }

  showDoneAsk(recorded, total) {
    if (!this.boothDoneAsk) return;
    this.boothDoneAskText.textContent = `${recorded} of ${plural(total, 'line')} recorded. Mark ready anyway?`;
    this.boothDoneAsk.hidden = false;
    this.btnPrevLine.hidden = true;
    this.btnNextLine.hidden = true;
    document.getElementById('btn-done-mark-ready')?.focus();
  }

  hideDoneAsk({ focusNext = false } = {}) {
    if (!this.boothDoneAsk || this.boothDoneAsk.hidden) return;
    this.boothDoneAsk.hidden = true;
    this.btnPrevLine.hidden = false;
    this.btnNextLine.hidden = false;
    if (focusNext) this.btnNextLine.focus();
  }

  /** Marks you ready. The host is then asked whether to go to the premiere. */
  finishMyLines() {
    const host = this.isHost({ allowDummy: true });
    if (!this.isReadyForScreening) this.toggleMyReadiness({ quiet: true });
    if (!host) {
      this.showToast("You're marked ready. The host will start the premiere.");
      return;
    }
    this.showToast("You're marked ready");
    const overlay = document.getElementById('modal-go-premiere');
    if (!overlay) return;
    const users = Object.values(this.roomState?.users || {}).filter(u => u.is_online);
    const readyCount = users.filter(u => u.is_ready).length;
    document.getElementById('go-premiere-text').textContent = `${readyCount} of ${users.length} ready.`;
    const close = openDialog(overlay, { returnFocus: this.btnNextLine });
    document.getElementById('btn-go-premiere-cancel').onclick = () => close();
    document.getElementById('btn-go-premiere').onclick = () => {
      close();
      this.cancelCurrentCountdown();
      this.showView('screening');
      this.setupScreeningView();
      this.broadcastMyStatus('screening');
    };
  }

  /** The stage bar's actions. The host's one primary is Start premiere, once everyone is
   *  ready; guests get
   *  "Back to the premiere" while it's on, and Mark ready turns into "All recorded ·
   *  Mark ready" once every line they can record has a take (their primary). */
  renderBoothToolbar() {
    if (!this.roomState) return;
    const isHost = this.isHost();
    const users = Object.values(this.roomState.users || {}).filter(u => u.is_online);
    const readyCount = users.filter(u => u.is_ready).length;
    const screening = this.roomState.status === 'screening';
    const { recorded, total } = this.myLineProgress();
    const allRecorded = total > 0 && recorded === total;

    // Who's here, with each person's line and progress in its popover.
    renderPresenceStack(document.getElementById('booth-presence'),
      { users: this.roomState.users, roomState: this.roomState, selfId: this.user.id });

    if (this.btnLaunchPremiere) {
      this.btnLaunchPremiere.style.display = isHost ? 'inline-flex' : 'none';
      const label = document.getElementById('label-launch-premiere');
      if (label) label.textContent = `Start premiere · ${readyCount}/${users.length} ready`;
      // Amber only once everyone here is ready; until then it's there, but not the next step.
      const allReady = users.length > 0 && readyCount === users.length;
      this.btnLaunchPremiere.classList.toggle('btn-primary', allReady);
      this.btnLaunchPremiere.classList.toggle('btn-secondary', !allReady);
    }
    if (this.btnJumpScreening) this.btnJumpScreening.hidden = isHost || !screening;
    if (this.btnToggleReady) {
      let label = 'Ready';
      let cls = 'btn btn-success btn-sm btn-ready-toggle ready';
      if (!this.isReadyForScreening) {
        label = allRecorded ? 'All recorded · Mark ready' : 'Mark ready';
        const primary = allRecorded && !isHost && !screening;
        cls = `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm btn-ready-toggle`;
      }
      if (this.labelReadyState) this.labelReadyState.textContent = label;
      this.btnToggleReady.className = cls;
    }
  }

  // --- Takes (the card itself: takes_card.js) ---

  /** Plays a take from the history over the scene with its own sound, timing and level,
   *  once the engine has rendered it (the button pulses meanwhile); the controls stay put. */
  async playHistoryTake(take, button = null) {
    this.cancelCurrentCountdown();
    const wasThisTake = (this.isPlayingTake || this.soundWait) && this.playingHistoryTakeId === take.take_id;
    this.stopBoothPlayback();
    if (wasThisTake || !take.url) return;

    const line = this.roomState.pack.lines[this.currentLineIndex];
    const token = this.activePlaybackToken;
    this.playingHistoryTakeId = take.take_id;
    let buffer = null;
    if (!this.voiceUnavailable) {
      const wait = this.beginSoundWait(button);
      try {
        const chain = resolveChain(this.roomState.voice, line.character, take);
        // Its own client id, so it never replaces the edited take's queued render.
        const render = await this.requestTakeRender(this.roomState.room_id, line.line_id, take.take_id, chain,
          { clientId: `${this.renderClientId()}-play` });
        if (render.status === 200) buffer = render.buffer;
        else if (render.status === 503) this.voiceUnavailable = true;
      } catch (e) {
        console.warn("[App] Error rendering take audio:", e);
      }
      this.endSoundWait(wait);
      if (token !== this.activePlaybackToken) return;
      this.refreshVoiceControls();
      if (!buffer && !this.voiceUnavailable) {
        this.playingHistoryTakeId = null;
        this.showToast("That take's sound didn't load. Try again.");
        return;
      }
    }
    if (!buffer) {
      // Voice effects aren't installed: the take as recorded.
      try {
        buffer = await this.audio.loadAudioBuffer(take.url);
      } catch (e) {
        console.warn("[App] Error loading take audio:", e);
      }
    }
    if (!buffer) {
      this.playingHistoryTakeId = null;
      this.showToast("The take is still loading. Try again in a moment.");
      return;
    }
    if (token !== this.activePlaybackToken || line !== this.roomState?.pack?.lines?.[this.currentLineIndex]) return;
    this.playingHistoryTakeId = take.take_id;
    await this.playTakeOverScene(line, buffer, {
      offsetMs: take.offset_ms || 0,
      gain: take.gain_db || 0,
    });
  }

  /** Puts one of the current line's takes in the dub. */
  async pickTake(take) {
    const lineIndex = this.currentLineIndex;
    const line = this.roomState?.pack?.lines?.[lineIndex];
    if (!line || !take || this.savingTake(line)) return;
    try {
      const res = await fetch(
        `/api/rooms/${this.roomState.room_id}/lines/${line.line_id}/takes/${take.take_id}/pick`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: this.user.id }),
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.line) this.roomState.takes[line.line_id] = data.line;
      this.showToast(`Take ${take.number} is in the dub`);
      if (lineIndex === this.currentLineIndex) this.loadBoothLine(lineIndex);
    } catch (err) {
      this.showToast(this.friendlyError(err, "That take wasn't picked. Try again."));
    }
  }
}
