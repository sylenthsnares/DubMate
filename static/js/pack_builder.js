// pack_builder.js - High-Performance Pack Authoring Studio Controller
// Handles Video Ingestion, Demucs/Whisper Progress SSE, Interactive Timeline & Cue Editor, and Pack Assembly
import { escapeHtml, showToast, initModeDropdown, initTooltips, isDialogOpen } from './ui_common.js';
import { initShortcutSheet } from './shortcuts.js';
import { packLanes } from './builder_lanes.js';

// The engine's error body is {detail: "..."} or {detail: {code, message}}.
function detailText(body, fallback) {
  const d = body && body.detail;
  if (typeof d === 'string' && d.trim()) return d;
  if (d && typeof d.message === 'string' && d.message.trim()) return d.message;
  return fallback;
}

// Kana and CJK ideographs: a line in Japanese script can be converted to romaji.
const JAPANESE_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

// Step 1's hero line names only the steps that are installed.
const HERO_LINES = {
  both: 'Add a clip. DubMate separates the voices from the background and writes out each line for you to check.',
  separation: 'Add a clip and a subtitle file. DubMate separates the voices from the background.',
  neither: 'Add a clip and a subtitle file. DubMate turns them into a scene you can dub.',
};

const PALETTE = [
  '#d97706', // Vintage Amber
  '#cca458', // Walnut Gold
  '#dc2626', // Pilot Red
  '#16a34a', // Studio Olive
  '#b45309', // Terracotta Bronze
  '#7c5cff', // Electric Violet
  '#ec4899', // Magenta Neon
  '#06b6d4', // Cyan Console
  '#8b5cf6', // Purple Tone
  '#f59e0b', // Amber Glow
];

export class PackBuilderApp {
  constructor() {
    this.sessionId = null;
    this.videoFile = null;
    this.coverFile = null;
    this.subFile = null;
    // Lines in the subtitles a link import brought (kept on the engine), 0 for none.
    this.linkSubtitleCount = 0;
    // GET /api/builder/capabilities: what is installed. Null until it answers, and
    // nothing is hidden until then.
    this.capabilities = null;
    this.duration = 0.0;
    this.segments = [];
    this.characterColors = new Map();
    this.currentStep = 'upload';
    this.currentIngestTab = 'file'; // 'file' | 'url'

    // Waveform & Timeline Engine State
    this.waveformPeaks = [];
    this.waveformCache = new Map(); // track -> { peaks, duration } for the open session
    this.segmentBlocks = []; // timeline block per line index, from the last full render
    this.pixelsPerSecond = 80; // Zoom factor
    this.selectedSegmentIndex = null;
    this.activeAudioTrack = 'vocals'; // 'vocals' | 'full'
    // False when separation fell back to the basic filter: there is no voice track to play.
    this.voicesSeparated = true;
    // True while 'full' was forced (fallback or no voice track) rather than chosen.
    this.audioTrackForced = false;
    this.editorSessionId = null;
    this.voiceHeld = false; // the voice waits while the video seeks or buffers
    this.lastVoiceCorrection = -Infinity;
    this.stopAt = null; // a line's Play pauses when the video reaches this time

    // Drag & Pan States
    this.isDragging = false;
    this.dragType = null; // 'move' | 'start' | 'end'
    this.dragSegmentIndex = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragOrigStart = 0;
    this.dragOrigEnd = 0;
    this.hasMovedPastThreshold = false;
    this._dragFrameId = null; // a drag moves its block once per animation frame

    // Timeline Canvas Panning State (Grab to pan)
    this.isPanning = false;
    this.panStartX = 0;
    this.panScrollLeft = 0;

    // Timeline Vertical Splitter Resizing
    this.isResizingTimeline = false;
    this.resizeStartY = 0;
    this.resizeStartHeight = 240;
    this._resizeFrameId = null;

    this.animationFrameId = null;

    this.initDOM();
    this.initEvents();
    this.initKeyboardShortcuts();
    this.loadCapabilities();
  }

  /** Reads what is installed, and asks again each second (up to 20 s) while the GPU check runs. */
  async loadCapabilities() {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000));
      let caps = null;
      try {
        const res = await fetch('/api/builder/capabilities');
        if (res.ok) caps = await res.json();
      } catch (e) {
        console.warn('[PackBuilder] Could not read what is installed:', e);
      }
      if (!caps) return;
      this.applyCapabilities(caps);
      if (caps.gpu !== null) return;
    }
  }

  /** Whether a Pack Builder tool is installed. Unknown counts as installed, so nothing is hidden by mistake. */
  has(tool) {
    return !this.capabilities || this.capabilities[tool] !== false;
  }

  applyCapabilities(caps) {
    const before = this.capabilities;
    this.capabilities = caps;

    // The pill has one signal: whether the graphics card speeds up the AI steps.
    const gpu = caps.gpu;
    const showPill = typeof gpu === 'boolean' && (this.has('separation') || this.has('transcription'));
    if (this.devicePill) {
      this.devicePill.hidden = !showPill;
      this.devicePill.classList.toggle('is-gpu', gpu === true);
      this.devicePill.dataset.tip = gpu
        ? 'Your graphics card speeds up separating voices and writing out lines.'
        : 'No supported graphics card, so separating voices and writing out lines use the processor and take longer.';
    }
    if (this.deviceLabel) this.deviceLabel.textContent = gpu ? 'Fast processing' : 'Standard processing';

    if (this.heroSub) {
      const separation = this.has('separation');
      const key = separation && this.has('transcription') ? 'both' : (separation ? 'separation' : 'neither');
      this.heroSub.textContent = HERO_LINES[key];
    }

    // Paste link: without the tools, say how to add them instead of failing after a paste.
    const canImport = this.has('link_import');
    if (this.urlInputGroup) this.urlInputGroup.hidden = !canImport;
    if (this.urlImporterSub) this.urlImporterSub.hidden = !canImport;
    if (this.urlImportMissing) {
      this.urlImportMissing.hidden = canImport;
      const desktop = typeof window.__TAURI__?.core?.invoke === 'function';
      this.urlImportMissingDesktop.hidden = !desktop;
      this.urlImportMissingSource.hidden = desktop;
    }

    const canTranscribe = this.has('transcription');
    if (this.subLabel) this.subLabel.textContent = canTranscribe ? 'Subtitles (optional)' : 'Subtitles (needed for lines)';
    if (this.subHint) this.subHint.hidden = canTranscribe;
    this.updateStartButtonLabel();

    // aria-disabled rather than disabled, so the tooltip still says why on hover and focus.
    if (this.btnTranscribeLine) {
      if (canTranscribe) {
        this.btnTranscribeLine.removeAttribute('aria-disabled');
        this.btnTranscribeLine.dataset.tip = "Fill in the selected line's text from the audio";
      } else {
        this.btnTranscribeLine.setAttribute('aria-disabled', 'true');
        this.btnTranscribeLine.dataset.tip = "Automatic transcription isn't installed.";
      }
    }
    // The line rows offer Transcribe and Romaji by what is installed.
    const rowsChanged = !before || before.transcription !== caps.transcription || before.romaji !== caps.romaji;
    if (this.currentStep === 'editor' && rowsChanged) this.renderSegmentsList();
  }

  /** Subtitles will give the lines: a checked file, or the ones a link import brought. */
  hasSubtitles() {
    return !!this.subFile || this.linkSubtitleCount > 0;
  }

  /** Without transcription and without subtitles, processing writes no lines. */
  willWriteLines() {
    return this.has('transcription') || this.hasSubtitles();
  }

  updateStartButtonLabel() {
    if (this.labelStartProcess) {
      this.labelStartProcess.textContent = this.willWriteLines() ? 'Process video' : 'Process video without lines';
    }
  }

  /** Romaji applies to a Japanese line (by the chosen language or its script), when the tool is installed. */
  romajiApplies(seg) {
    if (!this.has('romaji')) return false;
    const lang = this.selectTranscribeLang ? this.selectTranscribeLang.value : '';
    return lang === 'ja' || lang === 'ja_romaji' || JAPANESE_SCRIPT.test((seg && seg.text) || '');
  }

  initDOM() {
    // Stepper navigation elements
    this.steps = {
      upload: document.getElementById('view-step-upload'),
      process: document.getElementById('view-step-process'),
      editor: document.getElementById('view-step-editor'),
      compile: document.getElementById('view-step-compile'),
    };
    this.navSteps = {
      upload: document.getElementById('step-nav-upload'),
      process: document.getElementById('step-nav-process'),
      editor: document.getElementById('step-nav-editor'),
      compile: document.getElementById('step-nav-compile'),
    };

    // Hardware Pill
    this.devicePill = document.getElementById('device-pill');
    this.deviceLabel = document.getElementById('device-label');

    // Step 1: Ingestion tabs & Upload inputs
    this.tabBtnFile = document.getElementById('tab-btn-file');
    this.tabBtnUrl = document.getElementById('tab-btn-url');
    this.ingestPanelFile = document.getElementById('ingest-panel-file');
    this.ingestPanelUrl = document.getElementById('ingest-panel-url');
    this.inputYoutubeUrl = document.getElementById('input-youtube-url');
    this.btnFetchUrl = document.getElementById('btn-fetch-url');
    this.urlFetchLoading = document.getElementById('url-fetch-loading');
    this.urlFetchStatusText = document.getElementById('url-fetch-status-text');
    this.urlImportError = document.getElementById('url-import-error');
    this.urlImportErrorText = document.getElementById('url-import-error-text');
    this.urlImportErrorDetails = document.getElementById('url-import-error-details');
    this.urlImportErrorSteps = document.getElementById('url-import-error-steps');

    this.videoDropzone = document.getElementById('video-dropzone');
    this.inputVideoFile = document.getElementById('input-video-file');
    this.videoSelectedCard = document.getElementById('video-selected-card');
    this.selectedVideoName = document.getElementById('selected-video-name');
    this.selectedVideoStats = document.getElementById('selected-video-stats');
    this.videoThumbContainer = document.getElementById('video-thumb-container');
    this.btnChangeVideo = document.getElementById('btn-change-video');
    this.inputPackTitle = document.getElementById('input-pack-title');
    this.selectTranscribeLang = document.getElementById('select-transcribe-lang');
    this.heroSub = document.getElementById('builder-hero-sub');
    this.urlInputGroup = document.getElementById('url-input-group');
    this.urlImporterSub = document.getElementById('url-importer-sub');
    this.urlImportMissing = document.getElementById('url-import-missing');
    this.urlImportMissingDesktop = document.getElementById('url-import-missing-desktop');
    this.urlImportMissingSource = document.getElementById('url-import-missing-source');
    this.subLabel = document.getElementById('sub-label');
    this.subHint = document.getElementById('sub-hint');
    this.subDropzone = document.getElementById('sub-dropzone');
    this.inputSubFile = document.getElementById('input-sub-file');
    this.subChip = document.getElementById('sub-chip');
    this.btnRemoveSub = document.getElementById('btn-remove-sub');
    this.subError = document.getElementById('sub-error');
    this.coverDropzone = document.getElementById('cover-dropzone');
    this.inputCoverFile = document.getElementById('input-cover-file');
    this.coverChip = document.getElementById('cover-chip');
    this.btnRemoveCover = document.getElementById('btn-remove-cover');
    this.btnStartProcess = document.getElementById('btn-start-process');
    this.labelStartProcess = document.getElementById('label-start-process');

    // Step 2: Processing progress elements
    this.processHeadline = document.getElementById('process-headline');
    this.processSubtext = document.getElementById('process-subtext');
    this.builderProgressFill = document.getElementById('builder-progress-fill');
    this.processStageText = document.getElementById('process-stage-text');
    this.processPercentText = document.getElementById('process-percent-text');
    this.stageExtract = document.getElementById('stage-extract');
    this.stageStems = document.getElementById('stage-stems');
    this.stageWhisper = document.getElementById('stage-whisper');
    this.stageSpeakers = document.getElementById('stage-speakers');

    // Step 3: Editor elements
    this.editorVideo = document.getElementById('editor-video');
    this.editorStemAudio = document.getElementById('editor-stem-audio');
    this.videoTimeDisplay = document.getElementById('video-time-display');
    this.btnToggleAudioTrack = document.getElementById('btn-toggle-audio-track');
    this.labelActiveTrack = document.getElementById('label-active-track');
    this.btnPlayPause = document.getElementById('btn-play-pause');
    this.iconPlay = document.getElementById('icon-play');
    this.iconPause = document.getElementById('icon-pause');
    this.labelPlayBtn = document.getElementById('label-play-btn');
    this.btnStepBackward = document.getElementById('btn-step-backward');
    this.btnStepForward = document.getElementById('btn-step-forward');
    this.btnMarkIn = document.getElementById('btn-mark-in');
    this.btnMarkOut = document.getElementById('btn-mark-out');
    this.btnAddLineAtPlayhead = document.getElementById('btn-add-line-at-playhead');
    this.btnTranscribeLine = document.getElementById('btn-transcribe-line');
    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.labelZoom = document.getElementById('label-zoom');

    // Timeline Canvas & Multi-Track Overlay
    this.timelineScrollWrap = document.getElementById('timeline-scroll-wrap');
    this.timelineRuler = document.getElementById('timeline-ruler');
    this.timelineViewport = document.getElementById('timeline-viewport');
    this.canvasWaveform = document.getElementById('canvas-waveform');
    this.timelineSegmentsOverlay = document.getElementById('timeline-segments-overlay');
    this.timelinePlayhead = document.getElementById('timeline-playhead');
    this.dawChannelColumn = document.getElementById('daw-channel-column');
    this.dawChannelStrips = document.getElementById('daw-channel-strips');
    this.labelDawChannelCount = document.getElementById('label-daw-channel-count');
    this.timelineChannelGuides = document.getElementById('timeline-channel-guides');
    this.timelineSplitterHandle = document.getElementById('timeline-splitter-handle');
    this.editorBottomTimelinePanel = document.querySelector('.editor-bottom-timeline-panel');
    // Tracks follow overlapping lines (builder_lanes.js); nothing about them is saved.
    this.laneCount = 1;

    // Sidebar & Cues
    this.labelCueCount = document.getElementById('label-cue-count');
    this.characterChipsList = document.getElementById('character-chips-list');
    this.btnAddCharacter = document.getElementById('btn-add-character');
    this.segmentsListContainer = document.getElementById('segments-list-container');
    this.editorNotice = document.getElementById('editor-notice');
    this.btnProceedToCompile = document.getElementById('btn-proceed-to-compile');

    // Step 4: Compile inputs
    this.compilePackName = document.getElementById('compile-pack-name');
    this.compileAuthor = document.getElementById('compile-author');
    this.compileSubtitle = document.getElementById('compile-subtitle');
    this.statValDuration = document.getElementById('stat-val-duration');
    this.statValLines = document.getElementById('stat-val-lines');
    this.statValCast = document.getElementById('stat-val-cast');
    this.btnExecuteCompile = document.getElementById('btn-execute-compile');
    this.compileProgressBox = document.getElementById('compile-progress-box');
    this.compileStatusMsg = document.getElementById('compile-status-msg');
    this.compileSuccessBox = document.getElementById('compile-success-box');
    this.btnDownloadPackZip = document.getElementById('btn-download-pack-zip');
    this.btnPlaytestNow = document.getElementById('btn-playtest-now');
  }

  initEvents() {
    this.initModeDropdown();
    initTooltips();
    initShortcutSheet({
      opener: document.getElementById('btn-shortcuts'),
      getView: () => (this.currentStep === 'editor' ? 'editor' : null),
    });

    // 0. Mode Tabs (File vs YouTube URL)
    if (this.tabBtnFile && this.tabBtnUrl) {
      this.tabBtnFile.addEventListener('click', () => this.switchIngestTab('file'));
      this.tabBtnUrl.addEventListener('click', () => this.switchIngestTab('url'));
    }

    if (this.btnFetchUrl && this.inputYoutubeUrl) {
      this.btnFetchUrl.addEventListener('click', () => this.handleUrlImport());
      this.inputYoutubeUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleUrlImport();
        }
      });
    }

    // 1. Drag & Drop for Video
    ['dragenter', 'dragover'].forEach(name => {
      this.videoDropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.videoDropzone.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      this.videoDropzone.addEventListener(name, (e) => {
        e.preventDefault();
        this.videoDropzone.classList.remove('drag-over');
      });
    });
    this.videoDropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        this.handleVideoSelected(files[0]);
      }
    });
    this.videoDropzone.addEventListener('click', () => this.inputVideoFile.click());
    // The dropzones are role=button: Enter and Space open the file picker too.
    [this.videoDropzone, this.subDropzone, this.coverDropzone].forEach((zone) => {
      zone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          zone.click();
        }
      });
    });
    this.inputVideoFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.handleVideoSelected(e.target.files[0]);
      }
    });
    this.btnChangeVideo.addEventListener('click', () => {
      this.videoFile = null;
      this.sessionId = null;
      this.videoSelectedCard.style.display = 'none';
      if (this.ingestPanelFile) this.ingestPanelFile.style.display = this.currentIngestTab === 'file' ? 'block' : 'none';
      if (this.ingestPanelUrl) this.ingestPanelUrl.style.display = this.currentIngestTab === 'url' ? 'block' : 'none';
      if (this.videoThumbContainer) {
        this.videoThumbContainer.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      }
      this.btnStartProcess.disabled = true;
      // A link's subtitles belonged to the session that just went.
      if (this.linkSubtitleCount) {
        this.linkSubtitleCount = 0;
        this.showFileChip(this.subChip, this.subDropzone, null);
        this.updateStartButtonLabel();
      }
    });

    // 2. Subtitle file selection: checked at once, then shown as a chip.
    this.subDropzone.addEventListener('click', () => this.inputSubFile.click());
    this.inputSubFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.handleSubtitleSelected(e.target.files[0]);
      }
    });
    this.btnRemoveSub.addEventListener('click', () => this.removeSubtitles());

    // 3. Cover art selection
    this.coverDropzone.addEventListener('click', () => this.inputCoverFile.click());
    this.inputCoverFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) this.setCoverFile(e.target.files[0]);
    });
    this.btnRemoveCover.addEventListener('click', () => {
      this.inputCoverFile.value = '';
      this.setCoverFile(null);
      this.coverDropzone.focus();
    });

    ['dragenter', 'dragover'].forEach((name) => {
      [this.subDropzone, this.coverDropzone].forEach((zone) => zone.addEventListener(name, (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
      }));
    });
    ['dragleave', 'drop'].forEach((name) => {
      [this.subDropzone, this.coverDropzone].forEach((zone) => zone.addEventListener(name, (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
      }));
    });
    this.subDropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) this.handleSubtitleSelected(files[0]);
    });
    this.coverDropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) this.setCoverFile(files[0]);
    });

    // 4. Start AI processing button
    this.btnStartProcess.addEventListener('click', () => this.startProcessingPipeline());

    // 5. Video player controls
    this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    // The button shows Pause from the click (playMedia); these set the final state.
    this.editorVideo.addEventListener('pause', () => this.onVideoPlayState(false));
    this.editorVideo.addEventListener('ended', () => this.onVideoPlayState(false));
    // The video is the clock; the voice track follows it, and waits while the video
    // seeks or buffers, so it never replays its first moments.
    this.editorVideo.addEventListener('seeking', () => {
      this.alignVoice(0.01);
      this.holdVoice();
    });
    this.editorVideo.addEventListener('waiting', () => this.holdVoice());
    this.editorVideo.addEventListener('playing', () => this.followVideo());
    this.editorVideo.addEventListener('seeked', () => this.followVideo());
    this.editorVideo.addEventListener('ratechange', () => {
      this.editorStemAudio.playbackRate = this.editorVideo.playbackRate;
    });
    this.editorVideo.addEventListener('pause', () => this.editorStemAudio.pause());
    this.editorVideo.addEventListener('ended', () => this.editorStemAudio.pause());
    this.editorStemAudio.addEventListener('error', () => this.fallbackToFullAudio());
    this.btnStepBackward.addEventListener('click', () => this.seekRelative(-1.0));
    this.btnStepForward.addEventListener('click', () => this.seekRelative(1.0));

    // 6. Audio track switch (vocals only vs full audio)
    this.btnToggleAudioTrack.addEventListener('click', () => {
      if (!this.voicesSeparated) return; // nothing to switch to; the tooltip says why
      this.audioTrackForced = false;
      const next = this.activeAudioTrack === 'vocals' ? 'full' : 'vocals';
      this.showToast(next === 'vocals' ? 'Playing voices only' : 'Playing full audio');
      this.setAudioTrack(next);
    });

    // 7. Timeline In / Out / Add Cue Markers / Whisper Transcribe
    this.btnMarkIn.addEventListener('click', () => this.markInAtPlayhead());
    this.btnMarkOut.addEventListener('click', () => this.markOutAtPlayhead());
    this.btnAddLineAtPlayhead.addEventListener('click', () => this.addNewSegmentAtPlayhead());
    if (this.btnTranscribeLine) {
      this.btnTranscribeLine.addEventListener('click', () => this.transcribeSelectedSegment());
    }

    // 8. Zoom buttons
    this.btnZoomIn.addEventListener('click', () => this.setZoom(this.pixelsPerSecond * 1.3));
    this.btnZoomOut.addEventListener('click', () => this.setZoom(this.pixelsPerSecond / 1.3));

    // 9. Timeline Scroll Wrap Wheel Listener (Pan & Zoom without affecting page zoom)
    this.timelineScrollWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        // Zoom in / out
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        this.setZoom(this.pixelsPerSecond * factor);
      } else {
        // Horizontal pan; a sideways trackpad swipe pans by its own distance.
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.timelineScrollWrap.scrollLeft += delta;
      }
    }, { passive: false });

    // The track numbers scroll with the tracks, and a wheel over them scrolls the tracks
    // up and down. The page keeps the wheel once the tracks can't move that way.
    this.timelineScrollWrap.addEventListener('scroll', () => {
      if (this.dawChannelStrips) this.dawChannelStrips.scrollTop = this.timelineScrollWrap.scrollTop;
    });
    if (this.dawChannelColumn) {
      this.dawChannelColumn.addEventListener('wheel', (e) => {
        const wrap = this.timelineScrollWrap;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const maxTop = wrap.scrollHeight - wrap.clientHeight;
        if ((dy < 0 && wrap.scrollTop > 0) || (dy > 0 && wrap.scrollTop < maxTop)) {
          e.preventDefault();
          wrap.scrollTop = Math.max(0, Math.min(maxTop, wrap.scrollTop + dy));
        }
      }, { passive: false });
    }

    // 10. Timeline Canvas Pan (Grab to Pan & Click to Seek). Pointer Events
    // cover mouse, touch and pen with one path.
    this.timelineScrollWrap.addEventListener('pointerdown', (e) => {
      if (e.isPrimary === false) return;
      // Don't initiate pan if clicked on a segment handle, block, delete button, or interactive element
      if (e.target.closest('.builder-segment-handle') || e.target.closest('.builder-segment-block') || e.target.closest('.segment-inline-delete-btn') || e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      // A press on a scrollbar scrolls; it is neither a pan nor a seek.
      const wrap = this.timelineScrollWrap;
      const box = wrap.getBoundingClientRect();
      const onSideBar = wrap.offsetWidth > wrap.clientWidth && e.clientX - box.left - wrap.clientLeft >= wrap.clientWidth;
      const onBottomBar = wrap.offsetHeight > wrap.clientHeight && e.clientY - box.top - wrap.clientTop >= wrap.clientHeight;
      if (onSideBar || onBottomBar) return;
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panScrollLeft = this.timelineScrollWrap.scrollLeft;
      this.panScrollTop = this.timelineScrollWrap.scrollTop;
      this.hasMovedPastThreshold = false;
      this.timelineScrollWrap.classList.add('panning');
      document.body.style.userSelect = 'none';
      this.capturePointer(this.timelineScrollWrap, e);
    });

    // 11. Drag handlers for segment blocks, handles, panning and the splitter
    window.addEventListener('pointermove', (e) => this.handleGlobalPointerMove(e));
    window.addEventListener('pointerup', (e) => this.handleGlobalPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.handleGlobalPointerUp(e, true));

    // 12. Character management
    this.btnAddCharacter.addEventListener('click', () => this.promptAddCharacter());
    this.initCastScroller();

    // 13. Proceed to compile
    this.btnProceedToCompile.addEventListener('click', () => this.goToCompileStep());
    this.btnExecuteCompile.addEventListener('click', () => this.executePackCompilation());

    // 15. Playtest button
    this.btnPlaytestNow.addEventListener('click', () => this.launchPlaytestSession());

    // 16. Window resize listener for dynamic timeline layout scaling
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (this.currentStep !== 'editor') return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.renderWaveformCanvas();
        this.renderTimelineSegments();
      }, 80);
    });

    // 17. Timeline Vertical Splitter Resizing
    this.initSplitterEvents();
  }

  initSplitterEvents() {
    if (!this.timelineSplitterHandle || !this.editorBottomTimelinePanel) return;

    const startResize = (clientY) => {
      this.isResizingTimeline = true;
      this.resizeStartY = clientY;
      this.resizeStartHeight = this.editorBottomTimelinePanel.clientHeight || 240;
      this.timelineSplitterHandle.classList.add('dragging');
      document.body.classList.add('resizing-timeline');
    };

    this.timelineSplitterHandle.addEventListener('pointerdown', (e) => {
      if (e.isPrimary === false) return;
      e.preventDefault();
      startResize(e.clientY);
      this.capturePointer(this.timelineSplitterHandle, e);
    });

    // Double-click to reset to default height (240px)
    this.timelineSplitterHandle.addEventListener('dblclick', () => {
      const defaultH = 240;
      this.editorBottomTimelinePanel.style.setProperty('--timeline-panel-height', `${defaultH}px`);
      this.editorBottomTimelinePanel.style.height = `${defaultH}px`;
      localStorage.removeItem('dubmate_pack_builder_timeline_h');
      this.renderWaveformCanvas();
      this.renderTimelineSegments();
      this.showToast('Timeline height reset');
    });
  }

  initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // A focused control that already handled the key (the Cast row's arrows) keeps it.
      if (isDialogOpen() || e.defaultPrevented) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }

      if (this.currentStep !== 'editor') return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.key === 'i' || e.key === 'I' || e.key === '[') {
        e.preventDefault();
        this.markInAtPlayhead();
      } else if (e.key === 'o' || e.key === 'O' || e.key === ']') {
        e.preventDefault();
        this.markOutAtPlayhead();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        this.addNewSegmentAtPlayhead();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.seekRelative(e.shiftKey ? -2.0 : -0.2);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.seekRelative(e.shiftKey ? 2.0 : 0.2);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedSegmentIndex !== null && this.selectedSegmentIndex >= 0 && this.selectedSegmentIndex < this.segments.length && !e.repeat) {
          e.preventDefault();
          this.deleteSegment(this.selectedSegmentIndex);
        }
      }
    });
  }

  setStep(stepName) {
    this.currentStep = stepName;
    Object.keys(this.steps).forEach(k => {
      this.steps[k].classList.toggle('active', k === stepName);
      this.navSteps[k].classList.toggle('active', k === stepName);
      const isPast = ['upload', 'process', 'editor', 'compile'].indexOf(k) < ['upload', 'process', 'editor', 'compile'].indexOf(stepName);
      this.navSteps[k].classList.toggle('completed', isPast);
    });

    if (stepName === 'editor') {
      this.setupEditorView();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- STEP 1: Video Selection & Ingestion ---

  switchIngestTab(tab) {
    this.currentIngestTab = tab;
    if (this.tabBtnFile && this.tabBtnUrl) {
      this.tabBtnFile.classList.toggle('active', tab === 'file');
      this.tabBtnUrl.classList.toggle('active', tab === 'url');
      this.tabBtnFile.setAttribute('aria-selected', tab === 'file');
      this.tabBtnUrl.setAttribute('aria-selected', tab === 'url');
    }
    if (this.ingestPanelFile) {
      this.ingestPanelFile.style.display = tab === 'file' ? 'block' : 'none';
    }
    if (this.ingestPanelUrl) {
      this.ingestPanelUrl.style.display = tab === 'url' ? 'block' : 'none';
      if (tab === 'url' && this.inputYoutubeUrl) {
        setTimeout(() => this.inputYoutubeUrl.focus(), 50);
      }
    }
  }

  handleVideoSelected(file) {
    this.videoFile = file;
    this.sessionId = null;
    this.selectedVideoName.innerText = file.name;
    const mbSize = (file.size / (1024 * 1024)).toFixed(1);
    this.selectedVideoStats.innerText = `${mbSize} MB`;

    if (!this.inputPackTitle.value) {
      const base = file.name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ');
      this.inputPackTitle.value = base.charAt(0).toUpperCase() + base.slice(1);
    }

    if (this.videoThumbContainer) {
      this.videoThumbContainer.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }

    if (this.ingestPanelFile) this.ingestPanelFile.style.display = 'none';
    if (this.ingestPanelUrl) this.ingestPanelUrl.style.display = 'none';
    this.videoSelectedCard.style.display = 'flex';
    this.btnStartProcess.disabled = false;
  }

  /** Shows a chosen file as a chip (name, summary, ×) in place of its dropzone; null shows the dropzone. */
  showFileChip(chip, dropzone, name, summary = '') {
    chip.hidden = !name;
    dropzone.hidden = !!name;
    chip.querySelector('.file-chip-name').textContent = name || '';
    chip.querySelector('.file-chip-summary').textContent = summary;
  }

  setCoverFile(file) {
    this.coverFile = file;
    this.showFileChip(this.coverChip, this.coverDropzone, file ? file.name : null, file ? this.formatFileSize(file.size) : '');
  }

  formatFileSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  showSubError(message) {
    this.subError.textContent = message || '';
    this.subError.hidden = !message;
  }

  /** Checks a subtitle file at once. A good one becomes a chip; a bad one isn't kept and says why. */
  async handleSubtitleSelected(file) {
    this.showSubError('');
    const form = new FormData();
    form.append('file', file);
    let error = '';
    let data = null;
    try {
      const res = await fetch('/api/builder/subtitles/check', { method: 'POST', body: form });
      if (res.ok) {
        data = await res.json();
      } else {
        error = detailText(await res.json().catch(() => ({})), 'No timed lines in this file. Use an SRT or VTT file.');
      }
    } catch (e) {
      error = "Couldn't read this file. Try again.";
    }
    this.inputSubFile.value = '';
    if (!data) {
      this.showSubError(error);
      return;
    }
    this.subFile = file;
    const lines = `${data.count} line${data.count === 1 ? '' : 's'}`;
    // The parser names a line nobody claims "Actor"; that isn't a speaker found.
    const speakers = (data.characters || []).filter((c) => c && c !== 'Actor').length;
    const summary = speakers ? `${lines} · ${speakers} speaker${speakers === 1 ? '' : 's'} found` : lines;
    this.showFileChip(this.subChip, this.subDropzone, file.name, summary);
    this.updateStartButtonLabel();
  }

  /** × on the subtitles chip: forgets the file, and the session's subtitles on the engine. */
  async removeSubtitles() {
    if (this.sessionId) {
      try {
        const res = await fetch(`/api/builder/${this.sessionId}/subtitles`, { method: 'DELETE' });
        if (!res.ok) throw new Error(String(res.status));
      } catch (e) {
        this.showToast("Couldn't remove the subtitles. Try again.");
        return;
      }
    }
    this.subFile = null;
    this.linkSubtitleCount = 0;
    this.showSubError('');
    this.showFileChip(this.subChip, this.subDropzone, null);
    this.updateStartButtonLabel();
    this.subDropzone.focus();
  }

  async handleUrlImport() {
    const url = (this.inputYoutubeUrl.value || '').trim();
    if (!url) {
      this.showToast('Paste a video link first.');
      if (this.inputYoutubeUrl) this.inputYoutubeUrl.focus();
      return;
    }

    this.showUrlImportError('');

    const stage1 = document.getElementById('fetch-stage-1');
    const stage2 = document.getElementById('fetch-stage-2');
    const stage3 = document.getElementById('fetch-stage-3');
    const timeDesc = document.getElementById('fetch-status-time');

    // Reset stages
    if (stage1) { stage1.className = 'fetch-step-row active'; stage1.querySelector('.fetch-stage-indicator').innerHTML = '<div class="mini-spinner"></div>'; }
    if (stage2) { stage2.className = 'fetch-step-row'; stage2.querySelector('.fetch-stage-indicator').innerHTML = '<span>2</span>'; }
    if (stage3) { stage3.className = 'fetch-step-row'; stage3.querySelector('.fetch-stage-indicator').innerHTML = '<span>3</span>'; }

    this.btnFetchUrl.disabled = true;
    this.urlFetchLoading.style.display = 'block';

    let elapsed = 0;
    const timerInterval = setInterval(() => {
      elapsed++;
      if (timeDesc) {
        timeDesc.innerText = `${elapsed}s`;
      }
      if (elapsed > 4 && stage1 && stage2 && stage1.classList.contains('active')) {
        stage1.className = 'fetch-step-row completed';
        stage1.querySelector('.fetch-stage-indicator').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
        stage2.className = 'fetch-step-row active';
        stage2.querySelector('.fetch-stage-indicator').innerHTML = '<div class="mini-spinner"></div>';
      }
    }, 1000);

    try {
      const res = await fetch('/api/builder/import_url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      clearInterval(timerInterval);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const failure = new Error(detailText(err, "Couldn't import that video. Check the link and try again."));
        const d = err && err.detail;
        failure.details = d && typeof d.details === 'string' ? d.details : '';
        throw failure;
      }

      // Mark stage 2 & 3 as completed
      if (stage2) {
        stage2.className = 'fetch-step-row completed';
        stage2.querySelector('.fetch-stage-indicator').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }
      if (stage3) {
        stage3.className = 'fetch-step-row completed';
        stage3.querySelector('.fetch-stage-indicator').innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      }

      const data = await res.json();
      this.sessionId = data.session_id;
      this.duration = data.duration;
      this.videoFile = null;

      // Auto-populate pack title if empty
      if (!this.inputPackTitle.value && data.title) {
        this.inputPackTitle.value = data.title;
      }

      // Display thumbnail preview if available
      if (data.cover_url && this.videoThumbContainer) {
        this.videoThumbContainer.innerHTML = `<img src="${escapeHtml(data.cover_url)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;" alt="Cover Thumbnail">`;
      }

      // Brief delay so user sees all green checkmarks
      await new Promise(r => setTimeout(r, 450));

      // Update selected card
      this.selectedVideoName.innerText = data.title || data.filename;
      this.selectedVideoStats.innerText = this.formatTime(data.duration);

      if (this.ingestPanelFile) this.ingestPanelFile.style.display = 'none';
      if (this.ingestPanelUrl) this.ingestPanelUrl.style.display = 'none';
      this.videoSelectedCard.style.display = 'flex';
      this.btnStartProcess.disabled = false;

      // The video's own subtitles give the lines, unless a file was chosen (it replaces them).
      this.linkSubtitleCount = data.has_subtitles ? data.subtitles_count : 0;
      if (this.linkSubtitleCount && !this.subFile) {
        const n = this.linkSubtitleCount;
        this.showFileChip(this.subChip, this.subDropzone, 'From the video', `${n} line${n === 1 ? '' : 's'}`);
      }
      this.updateStartButtonLabel();
      this.showToast('Video imported');
    } catch (e) {
      clearInterval(timerInterval);
      this.showUrlImportError(e.message, e.details);
    } finally {
      this.btnFetchUrl.disabled = false;
      this.urlFetchLoading.style.display = 'none';
    }
  }

  /**
   * Shows why a link import failed in the import panel, where it stays until the
   * next attempt. Steps to fix it (which can include a folder path) sit behind
   * "Show details". An empty message hides the box.
   */
  showUrlImportError(message, details = '') {
    if (!this.urlImportError) {
      if (message) this.showToast(message);
      return;
    }
    this.urlImportErrorText.innerText = message || '';
    const steps = typeof details === 'string' ? details.trim() : '';
    this.urlImportErrorSteps.innerText = steps;
    this.urlImportErrorDetails.style.display = steps ? 'block' : 'none';
    this.urlImportErrorDetails.open = false;
    this.urlImportError.style.display = message ? 'block' : 'none';
  }

  // --- STEP 2: Upload & AI Pipeline ---

  async startProcessingPipeline() {
    if (!this.videoFile && !this.sessionId) return;

    this.setStep('process');
    this.processHeadline.innerText = 'Preparing your video';
    this.processSubtext.innerText = '';
    this.builderProgressFill.style.width = '10%';
    this.processPercentText.innerText = '10%';

    try {
      // If local file was selected and session hasn't been created yet
      if (this.videoFile && !this.sessionId) {
        this.processHeadline.innerText = 'Uploading';
        this.processSubtext.innerText = '';

        const formData = new FormData();
        formData.append('file', this.videoFile);

        const uploadRes = await fetch('/api/builder/upload', {
          method: 'POST',
          body: formData,
        });

        if (!uploadRes.ok) {
          const err = await uploadRes.json().catch(() => ({}));
          throw new Error(detailText(err, "The upload didn't finish. Try again."));
        }

        const uploadData = await uploadRes.json();
        this.sessionId = uploadData.session_id;
        this.duration = uploadData.duration;

      }

      if (this.coverFile) {
        const coverData = new FormData();
        coverData.append('file', this.coverFile);
        const coverRes = await fetch(`/api/builder/${this.sessionId}/cover`, {
          method: 'POST',
          body: coverData,
        });
        if (!coverRes.ok) {
          this.showToast("The cover image didn't upload. You can build the pack without it.");
        }
      }

      if (this.subFile) {
        const subData = new FormData();
        subData.append('file', this.subFile);
        const subRes = await fetch(`/api/builder/${this.sessionId}/import_subtitles`, {
          method: 'POST',
          body: subData,
        });
        // Never fall through to transcription when the chosen subtitles didn't arrive.
        if (!subRes.ok) {
          const err = await subRes.json().catch(() => ({}));
          throw new Error(detailText(err, "Couldn't read the subtitles. Check the file and try again."));
        }
        const subJson = await subRes.json();
        if (subJson.segments && subJson.segments.length > 0) {
          this.segments = subJson.segments;
        }
      }

      const lang = this.selectTranscribeLang.value;
      const body = { language: lang, whisper_model: 'base' };
      if (!this.willWriteLines()) body.transcribe = false;
      const processRes = await fetch(`/api/builder/${this.sessionId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!processRes.ok) {
        const err = await processRes.json().catch(() => ({}));
        throw new Error(detailText(err, "Processing didn't start. Try again."));
      }

      this.listenToProgressSSE();

    } catch (ex) {
      this.processHeadline.innerText = 'Processing stopped';
      this.processSubtext.innerText = ex.message;
      this.showToast(ex.message);
    }
  }

  listenToProgressSSE() {
    const sse = new EventSource(`/api/builder/${this.sessionId}/progress`);

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const pct = Math.round((data.progress || 0.0) * 100);
        this.builderProgressFill.style.width = `${pct}%`;
        this.processPercentText.innerText = `${pct}%`;
        this.processStageText.innerText = data.message || 'Processing';

        const status = data.status;
        this.stageExtract.classList.toggle('active', status === 'extracting_audio');
        this.stageStems.classList.toggle('active', status === 'separating_stems');
        this.stageWhisper.classList.toggle('active', status === 'transcribing');
        this.stageSpeakers.classList.toggle('active', status === 'detecting_speakers');

        if (status === 'transcribed') {
          sse.close();
          setTimeout(() => this.openEditor(data), 600);
        } else if (status === 'error') {
          sse.close();
          this.processHeadline.innerText = 'Processing stopped';
          this.processSubtext.innerText = data.error || "Processing didn't finish. Try again.";
          this.showToast(data.error || "Processing didn't finish. Try again.");
        }
      } catch (e) {
        console.error('Error parsing SSE event:', e);
      }
    };

    sse.onerror = () => {
      sse.close();
      this.pollProgressStatus();
    };
  }

  async pollProgressStatus() {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/builder/${this.sessionId}/status`);
        if (!res.ok) throw new Error("Lost track of processing. Reload the page and try again.");
        const data = await res.json();
        const pct = Math.round((data.progress || 0.0) * 100);
        this.builderProgressFill.style.width = `${pct}%`;
        this.processPercentText.innerText = `${pct}%`;
        this.processStageText.innerText = data.message || 'Processing';
        this.stageExtract.classList.toggle('active', data.status === 'extracting_audio');
        this.stageStems.classList.toggle('active', data.status === 'separating_stems');
        this.stageWhisper.classList.toggle('active', data.status === 'transcribing');
        this.stageSpeakers.classList.toggle('active', data.status === 'detecting_speakers');

        if (data.status === 'transcribed') {
          clearInterval(interval);
          this.openEditor(data);
        } else if (data.status === 'error') {
          clearInterval(interval);
          this.processHeadline.innerText = 'Processing stopped';
          this.processSubtext.innerText = data.error || "Processing didn't finish. Try again.";
        }
      } catch (e) {
        clearInterval(interval);
        this.processHeadline.innerText = 'Processing stopped';
        this.processSubtext.innerText = e.message;
        this.showToast(e.message);
      }
    }, 1000);
  }

  /** Opens the editor on finished processing: lines, the server's notice and a result toast. */
  openEditor(data) {
    this.segments = data.segments || this.segments;
    // Only an explicit false means no voice track; older engines don't send the flag.
    this.voicesSeparated = data.voices_separated !== false;
    const notice = (data.warning || '').trim();
    this.editorNotice.textContent = notice;
    this.editorNotice.hidden = !notice;
    this.setStep('editor');
    const total = this.segments.length;
    const noWords = this.segments.filter(s => s.nonverbal).length;
    let summary = `Found ${total} line${total === 1 ? '' : 's'}`;
    if (noWords) summary += `, ${noWords} without words`;
    this.showToast(summary);
  }

  // --- STEP 3: Timeline & Cue Editor ---

  async setupEditorView() {
    this.editorVideo.src = `/api/builder/${this.sessionId}/video`;
    this.editorVideo.load();
    // The editor opens after every processing run, which may have rewritten the tracks.
    this.waveformCache.clear();
    if (this.editorSessionId !== this.sessionId) {
      this.editorSessionId = this.sessionId;
      // A fallback in an earlier session doesn't carry over to this one.
      if (this.audioTrackForced) {
        this.activeAudioTrack = 'vocals';
        this.audioTrackForced = false;
      }
      if (this.voicesSeparated) {
        this.editorStemAudio.src = `/api/builder/${this.sessionId}/audio/vocals`;
        this.editorStemAudio.load();
      } else {
        // The basic filter's "voice" track is the full mix, so there is nothing to request.
        this.editorStemAudio.removeAttribute('src');
        if (this.activeAudioTrack === 'vocals') {
          this.activeAudioTrack = 'full';
          this.audioTrackForced = true;
        }
      }
    }
    this.updateAudioTrackToggle();
    this.editorVideo.muted = this.activeAudioTrack === 'vocals';
    this.editorVideo.addEventListener('loadeddata', () => {
      if (this.editorVideo.duration && !isNaN(this.editorVideo.duration) && this.editorVideo.duration > 0) {
        this.duration = this.editorVideo.duration;
      }
      this.editorVideo.currentTime = 0.001;
      this.renderWaveformCanvas();
      this.renderTimelineSegments();
    }, { once: true });

    // Restore custom timeline height if saved
    const savedTimelineH = localStorage.getItem('dubmate_pack_builder_timeline_h');
    if (savedTimelineH && this.editorBottomTimelinePanel) {
      const parsedH = parseInt(savedTimelineH, 10);
      if (!isNaN(parsedH) && parsedH >= 120 && parsedH <= (window.innerHeight || 800) - 200) {
        this.editorBottomTimelinePanel.style.setProperty('--timeline-panel-height', `${parsedH}px`);
        this.editorBottomTimelinePanel.style.height = `${parsedH}px`;
      }
    }

    this.updateCharacterPalette();
    const fitZoom = () => {
      const containerWidth = this.timelineScrollWrap.clientWidth || 800;
      this.pixelsPerSecond = Math.max(40, Math.min(180, (containerWidth * 1.5) / Math.max(1, this.duration)));
      this.updateZoomLabel();
    };
    // Lines and tracks show at once; the waveform is drawn when its peaks arrive.
    const durationBefore = this.duration;
    const peaksLoaded = this.fetchWaveformPeaks(this.activeAudioTrack || 'vocals');
    fitZoom();
    this.renderWaveformCanvas();
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.startPlaybackLoop();

    await peaksLoaded;
    if (this.duration !== durationBefore) {
      fitZoom();
      this.renderTimelineSegments();
      this.updatePlayheadPosition();
    }
    this.renderWaveformCanvas();
  }

  /** Loads a track's waveform peaks, once per session: switching back uses the kept copy at once. */
  async fetchWaveformPeaks(track = 'vocals') {
    if (!this.sessionId) return;
    const apply = (data) => {
      // A later switch of track wins over a slower earlier request.
      if (track !== (this.activeAudioTrack || 'vocals')) return;
      this.waveformPeaks = data.peaks || [];
      if (data.duration > 0) {
        this.duration = data.duration;
      }
    };
    if (this.waveformCache.has(track)) {
      apply(this.waveformCache.get(track));
      return;
    }
    const sessionId = this.sessionId;
    try {
      const res = await fetch(`/api/builder/${sessionId}/waveform?columns=1200&track=${track}`);
      if (res.ok) {
        const data = await res.json();
        if (sessionId !== this.editorSessionId) return; // another session opened meanwhile
        if ((data.peaks || []).length) this.waveformCache.set(track, data);
        apply(data);
      }
    } catch (e) {
      console.warn('Could not fetch peaks:', e);
    }
  }

  updateCharacterPalette() {
    const chars = Array.from(new Set(this.segments.map(s => s.character).filter(Boolean)));
    chars.forEach((char, idx) => {
      if (!this.characterColors.has(char)) {
        this.characterColors.set(char, PALETTE[idx % PALETTE.length]);
      }
    });
  }

  getCharacterColor(charName) {
    const clean = (charName || 'Lead').trim();
    if (!this.characterColors.has(clean)) {
      const nextColor = PALETTE[this.characterColors.size % PALETTE.length];
      this.characterColors.set(clean, nextColor);
    }
    return this.characterColors.get(clean);
  }

  setZoom(newPxPerSec) {
    this.pixelsPerSecond = Math.max(20, Math.min(300, newPxPerSec));
    this.updateZoomLabel();
    this.renderWaveformCanvas();
    this.renderTimelineSegments();
    this.updatePlayheadPosition();
  }

  updateZoomLabel() {
    const pct = Math.round((this.pixelsPerSecond / 80) * 100);
    this.labelZoom.innerText = `${pct}%`;
  }

  getLaneDimensions() {
    const numLanes = this.laneCount || 1;
    const containerHeight = Math.max(160, this.timelineScrollWrap?.clientHeight || 200);
    const TOTAL_HEIGHT = Math.max(140, containerHeight - 24);

    // One track: ~50-70px (well-proportioned, not a giant full-height block).
    // More: they share the panel (38-64px each); past that the timeline scrolls vertically.
    let laneHeight;
    if (numLanes === 1) {
      laneHeight = Math.min(70, Math.max(50, Math.floor(TOTAL_HEIGHT * 0.45)));
    } else {
      laneHeight = Math.max(38, Math.min(64, Math.floor(TOTAL_HEIGHT / numLanes)));
    }
    const totalHeight = laneHeight * numLanes;
    return { numLanes, laneHeight, totalHeight, TOTAL_HEIGHT };
  }

  /** Track numbers A1..An and the lane guides. Rebuilt only when the count or height changes. */
  renderChannelStrips() {
    if (!this.dawChannelStrips) return;
    const { numLanes, laneHeight } = this.getLaneDimensions();
    const key = `${numLanes}x${laneHeight}`;
    if (this._channelStripsKey === key) return;
    this._channelStripsKey = key;

    this.dawChannelStrips.innerHTML = '';
    if (this.timelineChannelGuides) this.timelineChannelGuides.innerHTML = '';
    if (this.labelDawChannelCount) {
      this.labelDawChannelCount.innerText = `${numLanes} track${numLanes === 1 ? '' : 's'}`;
    }

    for (let idx = 0; idx < numLanes; idx++) {
      const header = document.createElement('div');
      header.className = 'daw-channel-header';
      header.style.height = `${laneHeight}px`;
      const badge = document.createElement('div');
      badge.className = 'channel-id-badge';
      badge.textContent = `A${idx + 1}`;
      header.appendChild(badge);
      this.dawChannelStrips.appendChild(header);

      if (this.timelineChannelGuides) {
        const guide = document.createElement('div');
        guide.className = 'channel-lane-guide';
        guide.style.height = `${laneHeight}px`;
        this.timelineChannelGuides.appendChild(guide);
      }
    }
    this.dawChannelStrips.scrollTop = this.timelineScrollWrap.scrollTop;
  }

  /**
   * Tracks while a line is dragged: the other lines stay where they were at drag start,
   * and the dragged line takes the lowest track free at its current time, or a new one (up to 5).
   */
  lanesDuringDrag() {
    const { lane: frozen, count: frozenCount } = this.dragLanes;
    const idx = this.dragSegmentIndex;
    const seg = this.segments[idx];
    const lane = frozen.slice();
    const busy = (l) => this.segments.some((o, j) =>
      j !== idx && lane[j] === l && o.end > seg.start + 0.05 && seg.end > o.start + 0.05);
    let free = 0;
    while (free < 5 && busy(free)) free++;
    lane[idx] = free < 5 ? free : frozen[idx];
    return { lane, count: Math.max(frozenCount, lane[idx] + 1) };
  }

  renderWaveformCanvas() {
    const canvas = this.canvasWaveform;
    if (!canvas || !this.timelineScrollWrap) return;

    const totalWidth = Math.max(this.timelineScrollWrap.clientWidth || 800, Math.ceil((this.duration || 5) * this.pixelsPerSecond));
    const { numLanes, laneHeight, totalHeight } = this.getLaneDimensions();

    const dpr = window.devicePixelRatio || 1;
    canvas.width = totalWidth * dpr;
    canvas.height = totalHeight * dpr;
    canvas.style.width = `${totalWidth}px`;
    canvas.style.height = `${totalHeight}px`;

    this.timelineViewport.style.width = `${totalWidth}px`;
    this.timelineViewport.style.height = `${totalHeight}px`;
    this.renderTimelineRuler(totalWidth);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, totalWidth, totalHeight);

    // Draw center guidelines for all audio track lanes
    for (let l = 0; l < numLanes; l++) {
      const midY = l * laneHeight + laneHeight / 2;
      ctx.strokeStyle = 'rgba(204, 164, 88, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(totalWidth, midY);
      ctx.stroke();
    }

    if (!this.waveformPeaks || this.waveformPeaks.length === 0) return;

    const numPeaks = this.waveformPeaks.length;
    // Draw rich waveform on primary track (Lane 0) and subtle presence on other lanes
    for (let l = 0; l < numLanes; l++) {
      const midY = l * laneHeight + laneHeight / 2;
      const ampScale = l === 0 ? 0.44 : 0.28;

      const grad = ctx.createLinearGradient(0, midY - (laneHeight * ampScale), 0, midY + (laneHeight * ampScale));
      if (l === 0) {
        grad.addColorStop(0, 'rgba(245, 158, 11, 0.85)');
        grad.addColorStop(0.5, 'rgba(204, 164, 88, 0.95)');
        grad.addColorStop(1, 'rgba(217, 119, 6, 0.85)');
      } else {
        grad.addColorStop(0, 'rgba(204, 164, 88, 0.2)');
        grad.addColorStop(0.5, 'rgba(204, 164, 88, 0.35)');
        grad.addColorStop(1, 'rgba(204, 164, 88, 0.2)');
      }
      ctx.fillStyle = grad;

      for (let i = 0; i < numPeaks; i++) {
        const [minVal, maxVal] = this.waveformPeaks[i];
        const peakTime = (i / numPeaks) * (this.duration || 5);
        const x = peakTime * this.pixelsPerSecond;
        const barWidth = Math.max(1.8, (this.pixelsPerSecond * ((this.duration || 5) / numPeaks)) - 0.5);

        const top = midY - (Math.abs(maxVal) * (laneHeight * ampScale));
        const bottom = midY + (Math.abs(minVal) * (laneHeight * ampScale));
        const barH = Math.max(2, bottom - top);

        ctx.fillRect(x, top, barWidth, barH);
      }
    }
  }

  renderTimelineRuler(totalWidth) {
    const ruler = this.timelineRuler;
    ruler.style.width = `${totalWidth}px`;
    ruler.innerHTML = '';

    let step = 1;
    if (this.pixelsPerSecond < 35) step = 5;
    else if (this.pixelsPerSecond > 150) step = 0.5;

    const totalSeconds = Math.ceil(this.duration);
    for (let s = 0; s <= totalSeconds; s += step) {
      const x = s * this.pixelsPerSecond;
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = `${x}px`;

      const min = Math.floor(s / 60);
      const sec = (s % 60).toFixed(step < 1 ? 1 : 0);
      tick.innerText = `${min}:${sec < 10 && step >= 1 ? '0' : ''}${sec}`;
      ruler.appendChild(tick);
    }
  }

  /** The text on a line's timeline block. */
  blockLabel(seg) {
    return `[${seg.character}] ${seg.text || '(no words)'}`;
  }

  /** Puts a line's block at its time and track. A dragged line brings its track into view. */
  placeBlock(block, seg, lane, laneHeight, isDragged) {
    const blockHeight = Math.max(24, laneHeight - 8);
    const topPos = lane * laneHeight + 4;
    // The 24px ruler stays on top of the tracks.
    if (isDragged) {
      const wrap = this.timelineScrollWrap;
      if (topPos < wrap.scrollTop) {
        wrap.scrollTop = topPos - 4;
      } else if (24 + topPos + blockHeight > wrap.scrollTop + wrap.clientHeight) {
        wrap.scrollTop = 24 + topPos + blockHeight + 4 - wrap.clientHeight;
      }
    }
    block.style.left = `${seg.start * this.pixelsPerSecond}px`;
    block.style.width = `${Math.max(18, (seg.end - seg.start) * this.pixelsPerSecond)}px`;
    block.style.top = `${topPos}px`;
    block.style.height = `${blockHeight}px`;
  }

  renderTimelineSegments() {
    const overlay = this.timelineSegmentsOverlay;
    overlay.innerHTML = '';

    // Overlapping lines get their own track, up to 5.
    const dragging = this.isDragging && this.dragLanes && this.segments[this.dragSegmentIndex];
    const { lane: segmentLanes, count } = dragging ? this.lanesDuringDrag() : packLanes(this.segments);
    if (count !== this.laneCount) {
      this.laneCount = count;
      this.renderWaveformCanvas();
    }
    const { numLanes, laneHeight, totalHeight } = this.getLaneDimensions();
    this.renderChannelStrips();

    this.timelineViewport.style.height = `${totalHeight}px`;

    this.segmentBlocks = [];
    this.segments.forEach((seg, idx) => {
      const color = this.getCharacterColor(seg.character);
      const isSelected = idx === this.selectedSegmentIndex;
      const lane = Math.min(numLanes - 1, segmentLanes[idx] || 0);

      const block = document.createElement('div');
      block.className = `builder-segment-block ${isSelected ? 'selected' : ''}`;
      this.placeBlock(block, seg, lane, laneHeight, dragging && idx === this.dragSegmentIndex);
      block.style.borderColor = color;
      block.style.background = `${color}28`;

      // Left resize handle
      const handleL = document.createElement('div');
      handleL.className = 'builder-segment-handle handle-left';
      handleL.style.background = color;
      handleL.dataset.idx = idx;
      handleL.dataset.type = 'start';
      handleL.dataset.tip = 'Drag to change the start';

      // Right resize handle
      const handleR = document.createElement('div');
      handleR.className = 'builder-segment-handle handle-right';
      handleR.style.background = color;
      handleR.dataset.idx = idx;
      handleR.dataset.type = 'end';
      handleR.dataset.tip = 'Drag to change the end';

      // Inner content wrap
      const contentWrap = document.createElement('div');
      contentWrap.className = 'segment-block-content';

      const label = document.createElement('div');
      label.className = 'segment-block-label';
      label.innerText = this.blockLabel(seg);

      // Inline Delete Action Button right on the block
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'segment-inline-delete-btn';
      deleteBtn.type = 'button';
      deleteBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" style="pointer-events: none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      deleteBtn.setAttribute('aria-label', 'Delete line');
      deleteBtn.dataset.tip = 'Delete line';

      // Prevent pointerdown / pointerup from triggering segment block drag or deselect
      deleteBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      deleteBtn.addEventListener('pointerup', (e) => {
        e.stopPropagation();
      });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.deleteSegment(idx);
      });

      contentWrap.appendChild(label);
      contentWrap.appendChild(deleteBtn);

      block.appendChild(handleL);
      block.appendChild(contentWrap);
      block.appendChild(handleR);

      // Drag handlers on segment block (mouse, touch and pen). Capture goes on
      // the scroll wrap: this block is replaced by every re-render mid-drag.
      block.addEventListener('pointerdown', (e) => {
        if (e.isPrimary === false) return;
        if (e.target.closest('.segment-inline-delete-btn')) {
          e.stopPropagation();
          return;
        }
        if (e.target === handleL || e.target === handleR) {
          this.startDrag(idx, e.target.dataset.type, e.clientX, e.clientY);
        } else {
          this.selectSegment(idx);
          this.startDrag(idx, 'move', e.clientX, e.clientY);
        }
        this.capturePointer(this.timelineScrollWrap, e);
        e.stopPropagation();
      });

      overlay.appendChild(block);
      this.segmentBlocks[idx] = block;
    });
  }

  renderSegmentsList() {
    const container = this.segmentsListContainer;
    container.innerHTML = '';
    this.labelCueCount.innerText = `${this.segments.length} line${this.segments.length === 1 ? '' : 's'}`;

    const allCast = Array.from(new Set([
      ...this.characterColors.keys(),
      ...this.segments.map(s => s.character).filter(Boolean)
    ]));
    if (allCast.length === 0) allCast.push('Lead');
    const canTranscribe = this.has('transcription');

    this.segments.forEach((seg, idx) => {
      const isSelected = idx === this.selectedSegmentIndex;
      const color = this.getCharacterColor(seg.character);

      const card = document.createElement('div');
      card.className = `builder-cue-card ${isSelected ? 'selected' : ''}`;
      card.id = `cue-card-${idx}`;

      // Build options for character dropdown
      const charOptionsHtml = allCast.map(c =>
        `<option value="${escapeHtml(c)}" ${c === seg.character ? 'selected' : ''}>${escapeHtml(c)}</option>`
      ).join('') + '<option value="__ADD_NEW__">+ New character</option>';

      card.innerHTML = `
        <div class="cue-card-header">
          <div class="cue-index-wrap">
            <span class="cue-dot" style="background: ${color};"></span>
            <span class="cue-number">#${idx + 1}</span>
            ${seg.nonverbal ? `<span class="cue-nonverbal-badge" tabindex="0" data-tip="A grunt, laugh or other sound without words. Record it like any other line."${(seg.text || '').trim() ? ' hidden' : ''}>No words</span>` : ''}
          </div>
          <div class="cue-timecode-badge">${this.formatTime(seg.start)} → ${this.formatTime(seg.end)}</div>
          <div style="display: flex; gap: 4px; align-items: center;">
            ${canTranscribe ? `<button class="btn btn-secondary btn-xs btn-whisper-cue" data-idx="${idx}" data-tip="Fill in this line's text from the audio">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
              <span>Transcribe</span>
            </button>` : ''}
            <button class="btn btn-secondary btn-xs btn-romaji-cue" data-idx="${idx}" data-tip="Convert Japanese text to romaji"${this.romajiApplies(seg) ? '' : ' hidden'}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span>Romaji</span>
            </button>
            <button class="btn-delete-cue" data-idx="${idx}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              <span>Delete</span>
            </button>
          </div>
        </div>
        <div class="cue-card-body">
          <div class="cue-field-row">
            <div class="cue-char-select-wrap">
              <select class="form-input cue-char-select" data-idx="${idx}" aria-label="Character">
                ${charOptionsHtml}
              </select>
            </div>
            <button class="btn btn-secondary btn-xs btn-preview-cue" data-idx="${idx}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>Play</span>
            </button>
          </div>
          <textarea class="form-input cue-text-input" rows="2" placeholder="${seg.nonverbal ? 'No words. Type a cue like (laughs) if you want.' : 'Line text'}" data-idx="${idx}">${escapeHtml(seg.text || '')}</textarea>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (!e.target.closest('input') && !e.target.closest('textarea') && !e.target.closest('select') && !e.target.closest('button')) {
          this.selectSegment(idx);
          this.seekTo(seg.start);
        }
      });

      // Character dropdown selection change
      const charSelect = card.querySelector('.cue-char-select');
      charSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === '__ADD_NEW__') {
          const newName = prompt('Character name');
          if (newName && newName.trim()) {
            const clean = newName.trim();
            this.getCharacterColor(clean);
            this.segments[idx].character = clean;
          } else {
            charSelect.value = seg.character;
            return;
          }
        } else {
          this.segments[idx].character = val;
        }

        this.updateCharacterPalette();
        this.renderTimelineSegments();
        this.renderCharacterChips();
        this.renderSegmentsList();
        this.syncSegmentsToServer();
      });

      const textInput = card.querySelector('.cue-text-input');
      const btnRomaji = card.querySelector('.btn-romaji-cue');
      textInput.addEventListener('input', (e) => {
        this.segments[idx].text = e.target.value;
        this.updateNonverbalBadge(idx);
        btnRomaji.hidden = !this.romajiApplies(this.segments[idx]);
      });
      textInput.addEventListener('change', () => {
        const label = this.segmentBlocks[idx]?.querySelector('.segment-block-label');
        if (label) label.innerText = this.blockLabel(this.segments[idx]);
        this.syncSegmentsToServer();
      });

      const btnDel = card.querySelector('.btn-delete-cue');
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteSegment(idx);
      });

      const btnPrev = card.querySelector('.btn-preview-cue');
      btnPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        this.previewSegmentAudio(idx);
      });

      const btnWhisper = card.querySelector('.btn-whisper-cue');
      if (btnWhisper) {
        btnWhisper.addEventListener('click', (e) => {
          e.stopPropagation();
          this.transcribeSingleSegment(idx, btnWhisper, textInput);
        });
      }

      btnRomaji.addEventListener('click', (e) => {
        e.stopPropagation();
        this.romanizeSingleSegment(idx, btnRomaji, textInput);
      });

      container.appendChild(card);
    });
  }

  renderCharacterChips() {
    const list = this.characterChipsList;
    list.innerHTML = '';

    // Only include distinct characters that actually exist
    const allChars = Array.from(new Set([
      ...this.characterColors.keys(),
      ...this.segments.map(s => s.character).filter(Boolean)
    ]));

    allChars.forEach(char => {
      const color = this.getCharacterColor(char);
      const count = this.segments.filter(s => s.character === char).length;
      const chip = document.createElement('div');
      chip.className = 'char-color-chip';
      chip.innerHTML = `
        <span class="chip-color-dot" style="background: ${color};"></span>
        <span class="chip-name" data-tip="Click to rename">${escapeHtml(char)}</span>
        <span class="chip-count-badge" aria-label="${count} line${count === 1 ? '' : 's'}">(${count})</span>
        <button class="chip-del-btn" aria-label="Delete ${escapeHtml(char)}" data-tip="Delete character" data-char="${escapeHtml(char)}">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;

      chip.querySelector('.chip-name').addEventListener('click', () => this.promptRenameCharacter(char));
      chip.querySelector('.chip-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteCharacter(char);
      });
      list.appendChild(chip);
    });
    this.updateCastScroller();
  }

  // The Cast row scrolls sideways: a mouse wheel, a mouse or pen drag and the arrow keys
  // move it. Touch and trackpad swipes scroll natively.
  initCastScroller() {
    const list = this.characterChipsList;
    list.addEventListener('scroll', () => this.updateCastScroller());
    window.addEventListener('resize', () => this.updateCastScroller());

    list.addEventListener('wheel', (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (list.scrollWidth <= list.clientWidth) return;
      const before = list.scrollLeft;
      list.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (list.scrollLeft !== before) e.preventDefault();
    }, { passive: false });

    // Capture the pointer only once it is a drag, so a plain click still reaches the chip.
    let drag = null;
    let swallowClick = false;
    list.addEventListener('pointerdown', (e) => {
      swallowClick = false;
      drag = null;
      if (e.pointerType === 'touch' || e.button !== 0 || e.isPrimary === false) return;
      drag = { id: e.pointerId, x: e.clientX, left: list.scrollLeft, moved: false };
    });
    list.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!(e.buttons & 1)) { drag = null; return; }
      const dx = e.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) <= 5) return;
        drag.moved = true;
        list.setPointerCapture(e.pointerId);
      }
      list.scrollLeft = drag.left - dx;
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) {
        swallowClick = true;
        if (list.hasPointerCapture(e.pointerId)) list.releasePointerCapture(e.pointerId);
      }
      drag = null;
    };
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);
    // A drag never renames or deletes: drop the click that ends it.
    list.addEventListener('click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    list.addEventListener('keydown', (e) => {
      if (e.target !== list) return;
      const max = list.scrollWidth - list.clientWidth;
      const to = { ArrowLeft: list.scrollLeft - 120, ArrowRight: list.scrollLeft + 120, Home: 0, End: max }[e.key];
      if (to === undefined || max <= 0) return;
      e.preventDefault();
      list.scrollLeft = to;
    });
  }

  // Fades the edges that have more chips, and makes the row focusable only while it overflows.
  updateCastScroller() {
    const list = this.characterChipsList;
    const max = list.scrollWidth - list.clientWidth;
    const overflows = max > 1;
    list.classList.toggle('has-more-start', overflows && list.scrollLeft > 1);
    list.classList.toggle('has-more-end', overflows && list.scrollLeft < max - 1);
    if (overflows) list.setAttribute('tabindex', '0');
    else list.removeAttribute('tabindex');
  }

  deleteCharacter(charName) {
    const segmentsWithChar = this.segments.filter(s => s.character === charName);
    const remainingChars = Array.from(this.characterColors.keys()).filter(c => c !== charName);
    const fallbackChar = remainingChars.length > 0 ? remainingChars[0] : 'Lead';

    if (segmentsWithChar.length > 0) {
      if (!confirm(`Delete "${charName}"? Their ${segmentsWithChar.length} line${segmentsWithChar.length === 1 ? '' : 's'} will move to "${fallbackChar}".`)) {
        return;
      }
      this.segments.forEach(s => {
        if (s.character === charName) {
          s.character = fallbackChar;
        }
      });
    }

    this.characterColors.delete(charName);
    if (this.characterColors.size === 0) {
      this.getCharacterColor(fallbackChar);
    }

    this.renderTimelineSegments();
    this.renderCharacterChips();
    this.renderSegmentsList();
    this.syncSegmentsToServer();
    this.showToast(`"${charName}" deleted`);
  }

  promptRenameCharacter(oldName) {
    const newName = prompt(`Rename "${oldName}" to`, oldName);
    if (newName && newName.trim() && newName.trim() !== oldName) {
      const cleanNew = newName.trim();
      const existingColor = this.characterColors.get(oldName) || PALETTE[0];
      this.characterColors.delete(oldName);
      this.characterColors.set(cleanNew, existingColor);

      // Rename across all segments
      this.segments.forEach(seg => {
        if (seg.character === oldName) {
          seg.character = cleanNew;
        }
      });

      this.renderTimelineSegments();
      this.renderCharacterChips();
      this.renderSegmentsList();
      this.syncSegmentsToServer();
      this.showToast(`"${oldName}" renamed to "${cleanNew}"`);
    }
  }

  /** Moves the highlight to a line's block and card; nothing is rebuilt. */
  selectSegment(idx) {
    this.selectedSegmentIndex = idx;
    this.timelineSegmentsOverlay.querySelectorAll('.builder-segment-block.selected').forEach((b) => b.classList.remove('selected'));
    if (this.segmentBlocks[idx]) this.segmentBlocks[idx].classList.add('selected');

    this.segmentsListContainer.querySelectorAll('.builder-cue-card.selected').forEach((c) => c.classList.remove('selected'));
    const targetCard = document.getElementById(`cue-card-${idx}`);
    if (targetCard) {
      targetCard.classList.add('selected');
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // --- Drag & Drop Segment Resizing, Moving, and Canvas Panning ---

  startDrag(segmentIndex, dragType, clientX, clientY) {
    this.isDragging = true;
    this.dragSegmentIndex = segmentIndex;
    this.dragType = dragType;
    this.dragStartX = clientX;
    this.dragStartY = clientY;
    this.dragOrigStart = this.segments[segmentIndex].start;
    this.dragOrigEnd = this.segments[segmentIndex].end;
    this.dragLanes = packLanes(this.segments);
    this.hasMovedPastThreshold = false;
    document.body.style.userSelect = 'none';
  }

  /** Keeps a drag's pointer events coming to `el` even when the pointer leaves it. */
  capturePointer(el, e) {
    this._pointerId = e.pointerId;
    this._pointerCaptureEl = el;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
  }

  releaseCapturedPointer() {
    const el = this._pointerCaptureEl;
    const id = this._pointerId;
    this._pointerCaptureEl = null;
    this._pointerId = null;
    try {
      if (el && el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch (err) { /* pointer already gone */ }
  }

  handleGlobalPointerMove(e) {
    if (this._pointerId != null && e.pointerId !== this._pointerId) return;
    // 0. Handle Timeline Vertical Resizing
    if (this.isResizingTimeline) {
      const clientY = e.clientY;
      if (this.editorBottomTimelinePanel) {
        const deltaY = this.resizeStartY - clientY;
        const minH = 130;
        const maxH = Math.max(minH, (window.innerHeight || 800) - 260);
        const newH = Math.max(minH, Math.min(maxH, this.resizeStartHeight + deltaY));
        this.editorBottomTimelinePanel.style.setProperty('--timeline-panel-height', `${newH}px`);
        this.editorBottomTimelinePanel.style.height = `${newH}px`;
        if (!this._resizeFrameId) {
          this._resizeFrameId = requestAnimationFrame(() => {
            this._resizeFrameId = null;
            this.renderWaveformCanvas();
            this.renderTimelineSegments();
          });
        }
      }
      return;
    }

    // 1. Handle Canvas Grab Panning (both ways)
    if (this.isPanning) {
      const deltaX = e.clientX - this.panStartX;
      const deltaY = e.clientY - this.panStartY;
      if (Math.hypot(deltaX, deltaY) > 4) {
        this.hasMovedPastThreshold = true;
      }
      this.timelineScrollWrap.scrollLeft = this.panScrollLeft - deltaX;
      this.timelineScrollWrap.scrollTop = this.panScrollTop - deltaY;
      return;
    }

    // 2. Handle Segment Dragging / Trimming
    if (!this.isDragging || this.dragSegmentIndex === null) return;

    const deltaX = e.clientX - this.dragStartX;
    const deltaY = e.clientY - this.dragStartY;
    const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (dist > 5) {
      this.hasMovedPastThreshold = true;
    }

    // Only apply movement if past threshold (to prevent micro-clicks from shifting times)
    if (!this.hasMovedPastThreshold && this.dragType === 'move') {
      return;
    }

    const deltaSeconds = deltaX / this.pixelsPerSecond;
    const seg = this.segments[this.dragSegmentIndex];

    if (this.dragType === 'start') {
      const newStart = Math.max(0, Math.min(seg.end - 0.2, this.dragOrigStart + deltaSeconds));
      seg.start = Math.round(newStart * 50) / 50; // Snap to 20ms
    } else if (this.dragType === 'end') {
      const newEnd = Math.max(seg.start + 0.2, Math.min(this.duration, this.dragOrigEnd + deltaSeconds));
      seg.end = Math.round(newEnd * 50) / 50;
    } else if (this.dragType === 'move') {
      const dur = this.dragOrigEnd - this.dragOrigStart;
      const newStart = Math.max(0, Math.min(this.duration - dur, this.dragOrigStart + deltaSeconds));
      seg.start = Math.round(newStart * 50) / 50;
      seg.end = Math.round((newStart + dur) * 50) / 50;
    }

    if (!this._dragFrameId) this._dragFrameId = requestAnimationFrame(() => this.renderDragFrame());
  }

  /**
   * One drag frame: only the dragged block and its card's timecode move. The whole timeline is
   * redrawn only when the drag opens or closes a track.
   */
  renderDragFrame() {
    this._dragFrameId = null;
    const idx = this.dragSegmentIndex;
    const block = this.segmentBlocks[idx];
    if (!this.isDragging || !this.dragLanes || !block) return;
    const { lane, count } = this.lanesDuringDrag();
    if (count !== this.laneCount) {
      this.renderTimelineSegments();
    } else {
      const { numLanes, laneHeight } = this.getLaneDimensions();
      this.placeBlock(block, this.segments[idx], Math.min(numLanes - 1, lane[idx]), laneHeight, true);
    }
    this.updateCardTimecode(idx);
  }

  /** Ends a drag, pan or resize. A cancelled pointer (`cancelled`) never seeks or selects. */
  handleGlobalPointerUp(e, cancelled = false) {
    if (this._pointerId != null && e.pointerId !== this._pointerId) return;
    this.releaseCapturedPointer();
    // 0. End Timeline Vertical Resizing
    if (this.isResizingTimeline) {
      this.isResizingTimeline = false;
      if (this.timelineSplitterHandle) {
        this.timelineSplitterHandle.classList.remove('dragging');
      }
      document.body.classList.remove('resizing-timeline');
      const finalH = this.editorBottomTimelinePanel?.clientHeight;
      if (finalH) {
        try {
          localStorage.setItem('dubmate_pack_builder_timeline_h', String(finalH));
        } catch (err) { /* ignore quota */ }
      }
      this.renderWaveformCanvas();
      this.renderTimelineSegments();
      return;
    }

    // 1. End Canvas Panning
    if (this.isPanning) {
      this.isPanning = false;
      this.timelineScrollWrap.classList.remove('panning');
      document.body.style.userSelect = '';

      // If user clicked without dragging, seek to click position
      if (!cancelled && !this.hasMovedPastThreshold && e && e.target) {
        const rect = this.timelineViewport.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const targetTime = Math.max(0, Math.min(this.duration, clickX / this.pixelsPerSecond));
        this.seekTo(targetTime);
      }
      return;
    }

    // 2. End Segment Dragging
    if (this.isDragging) {
      const hadMovement = this.hasMovedPastThreshold;
      const modifiedIdx = this.dragSegmentIndex;
      cancelAnimationFrame(this._dragFrameId);
      this._dragFrameId = null;
      this.isDragging = false;
      this.dragSegmentIndex = null;
      this.dragType = null;
      this.dragLanes = null;
      document.body.style.userSelect = '';

      if (hadMovement) {
        const before = this.segments.slice();
        const selected = this.segments[this.selectedSegmentIndex];
        this.segments.sort((a, b) => a.start - b.start);
        if (selected) this.selectedSegmentIndex = this.segments.indexOf(selected);
        this.renderTimelineSegments();
        // The cards edit lines by index, so the list is rebuilt whenever any line changed places.
        if (this.segments.every((seg, i) => seg === before[i])) {
          this.updateCardTimecode(modifiedIdx);
        } else {
          this.renderSegmentsList();
        }
        this.syncSegmentsToServer();
      } else if (!cancelled && modifiedIdx !== null && this.segments[modifiedIdx]) {
        this.selectSegment(modifiedIdx);
        this.seekTo(this.segments[modifiedIdx].start);
      }
    }
  }

  /** "No words" only while a line found without words still has no text. */
  updateNonverbalBadge(idx) {
    const card = document.getElementById(`cue-card-${idx}`);
    const badge = card ? card.querySelector('.cue-nonverbal-badge') : null;
    const seg = this.segments[idx];
    if (badge && seg) badge.hidden = !!(seg.text || '').trim();
  }

  updateCardTimecode(idx) {
    const card = document.getElementById(`cue-card-${idx}`);
    if (card && this.segments[idx]) {
      const badge = card.querySelector('.cue-timecode-badge');
      if (badge) {
        badge.innerText = `${this.formatTime(this.segments[idx].start)} → ${this.formatTime(this.segments[idx].end)}`;
      }
    }
  }

  // --- Playback & Transport ---

  togglePlayPause() {
    if (this.editorVideo.paused) {
      this.playMedia();
    } else {
      this.pauseMedia();
    }
  }

  // Both elements start in the same call stack so the user's click still counts
  // as the gesture that allows playback. If the video isn't ready yet, the voice is
  // still played here, then held until the video's 'playing' event.
  playMedia() {
    this.stopAt = null;
    this.onVideoPlayState(true);
    const vocals = this.activeAudioTrack === 'vocals';
    if (vocals) {
      this.editorVideo.muted = true;
      this.voiceHeld = false;
      this.alignVoice(0.03);
      this.playStemAudio();
    } else {
      this.editorVideo.muted = false;
      this.editorStemAudio.pause();
    }
    const played = this.editorVideo.play();
    if (played && played.catch) played.catch(() => this.onVideoPlayState(!this.editorVideo.paused));
    if (vocals && !this.isVideoReady()) this.holdVoice();
  }

  pauseMedia() {
    this.stopAt = null;
    this.editorVideo.pause();
    this.editorStemAudio.pause();
  }

  /** The video can play on from where it is: enough data, and not mid-seek. */
  isVideoReady() {
    return this.editorVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !this.editorVideo.seeking;
  }

  /** Moves the voice to the video's time, only if it is more than `tolerance` seconds off. */
  alignVoice(tolerance) {
    const t = this.editorVideo.currentTime;
    if (Math.abs(this.editorStemAudio.currentTime - t) > tolerance) this.editorStemAudio.currentTime = t;
  }

  /** The voice waits while the video seeks or buffers. */
  holdVoice() {
    this.voiceHeld = true;
    this.editorStemAudio.pause();
  }

  /** Once the video is moving, a waiting voice joins it at the video's time. */
  followVideo() {
    if (this.activeAudioTrack !== 'vocals' || this.editorVideo.paused) return;
    if (!this.isVideoReady()) {
      this.holdVoice();
      return;
    }
    if (!this.voiceHeld && !this.editorStemAudio.paused) return;
    this.voiceHeld = false;
    this.alignVoice(0.03);
    this.playStemAudio();
  }

  playStemAudio() {
    const played = this.editorStemAudio.play();
    if (played && played.catch) {
      played.catch((err) => {
        // AbortError only means a pause came before play started.
        if (err && err.name === 'AbortError') return;
        this.fallbackToFullAudio();
      });
    }
  }

  async setAudioTrack(track) {
    this.activeAudioTrack = track;
    this.updateAudioTrackToggle();
    if (track === 'vocals') {
      this.editorVideo.muted = true;
      this.followVideo();
    } else {
      this.editorVideo.muted = false;
      this.editorStemAudio.pause();
    }
    await this.fetchWaveformPeaks(track);
    this.renderWaveformCanvas();
  }

  /** The toggle's label, and whether it can switch at all (not without a voice track). */
  updateAudioTrackToggle() {
    this.labelActiveTrack.innerText = this.activeAudioTrack === 'vocals' ? 'Voices only' : 'Full audio';
    const btn = this.btnToggleAudioTrack;
    // aria-disabled rather than disabled, so the tooltip still opens on hover and focus.
    if (this.voicesSeparated) {
      btn.removeAttribute('aria-disabled');
      btn.setAttribute('data-tip', 'Hear and see voices only, or the full audio');
    } else {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('data-tip', "Voices weren't separated for this video, so only the full audio can play.");
    }
  }

  fallbackToFullAudio() {
    if (this.activeAudioTrack !== 'vocals') return;
    this.audioTrackForced = true;
    this.setAudioTrack('full');
    // Tell the user once per session; later failures switch back quietly.
    if (this.stemFallbackSessionId === this.sessionId) return;
    this.stemFallbackSessionId = this.sessionId;
    this.showToast("Voices-only playback isn't available, so you're hearing the full audio.");
  }

  // Corrects real drift only: never while either element seeks or the video waits for
  // data (its clock is stopped then), and at most once every 750 ms.
  syncStemAudio() {
    if (this.activeAudioTrack !== 'vocals' || this.editorVideo.paused || !this.isVideoReady()) return;
    const audio = this.editorStemAudio;
    if (this.voiceHeld) {
      this.followVideo(); // in case the video's 'playing' event was missed
      return;
    }
    if (audio.seeking) return;
    const now = performance.now();
    if (now - this.lastVoiceCorrection < 750) return;
    if (Math.abs(audio.currentTime - this.editorVideo.currentTime) > 0.15) {
      audio.currentTime = this.editorVideo.currentTime;
      this.lastVoiceCorrection = now;
    }
  }

  onVideoPlayState(isPlaying) {
    this.iconPlay.style.display = isPlaying ? 'none' : 'block';
    this.iconPause.style.display = isPlaying ? 'block' : 'none';
    if (this.labelPlayBtn) {
      this.labelPlayBtn.innerText = isPlaying ? 'Pause' : 'Play';
    }
  }

  seekTo(seconds) {
    this.stopAt = null; // a seek cancels a line's Play stop
    const clamped = Math.max(0, Math.min(this.duration, seconds));
    this.editorVideo.currentTime = clamped;
    this.updatePlayheadPosition();
  }

  seekRelative(deltaSeconds) {
    this.seekTo(this.editorVideo.currentTime + deltaSeconds);
  }

  startPlaybackLoop() {
    cancelAnimationFrame(this.animationFrameId); // opening another session doesn't add a second loop
    const loop = () => {
      // A line's Play stops at the line's end by the video's clock, however late the video started.
      if (this.stopAt != null && !this.editorVideo.paused && this.editorVideo.currentTime >= this.stopAt) {
        this.pauseMedia();
      }
      this.updatePlayheadPosition();
      this.syncStemAudio();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  updatePlayheadPosition() {
    const t = this.editorVideo.currentTime || 0;
    const dur = this.duration || 1;
    this.videoTimeDisplay.innerText = `${this.formatTime(t)} / ${this.formatTime(dur)}`;

    const x = t * this.pixelsPerSecond;
    this.timelinePlayhead.style.left = `${x}px`;

    // Auto-scroll timeline to follow playhead during playback
    if (!this.editorVideo.paused && !this.isPanning && !this.isDragging) {
      const container = this.timelineScrollWrap;
      const scrollLeft = container.scrollLeft;
      const visibleWidth = container.clientWidth;
      if (x < scrollLeft || x > scrollLeft + visibleWidth - 100) {
        container.scrollLeft = Math.max(0, x - 100);
      }
    }
  }

  // --- Cue Marker Actions ---

  addNewSegmentAtPlayhead() {
    const playheadTime = this.editorVideo.currentTime || 0;
    const dur = 2.5;
    const startTime = Math.round(playheadTime * 50) / 50;
    const endTime = Math.round(Math.min(this.duration, startTime + dur) * 50) / 50;

    const allChars = Array.from(this.characterColors.keys());
    const defaultChar = allChars.length > 0 ? allChars[0] : 'Lead';

    const newSeg = {
      start: startTime,
      end: endTime,
      text: '',
      character: defaultChar
    };

    this.segments.push(newSeg);
    this.segments.sort((a, b) => a.start - b.start);
    const newIdx = this.segments.indexOf(newSeg);

    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.selectSegment(newIdx);
    this.syncSegmentsToServer();
    this.showToast('Line added');
  }

  deleteSegment(idx) {
    if (idx < 0 || idx >= this.segments.length) return;
    this.isDragging = false;
    this.dragSegmentIndex = null;
    this.dragType = null;
    this.dragLanes = null;
    cancelAnimationFrame(this._dragFrameId);
    this._dragFrameId = null;
    this.segments.splice(idx, 1);
    this.selectedSegmentIndex = null;
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.syncSegmentsToServer();
    this.showToast('Line deleted');
  }

  promptAddCharacter() {
    const name = prompt('Character name');
    if (name && name.trim()) {
      const clean = name.trim();
      this.getCharacterColor(clean);
      this.renderCharacterChips();
      const chip = Array.from(this.characterChipsList.children)
        .find(c => c.querySelector('.chip-del-btn')?.dataset.char === clean);
      if (chip) chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      this.renderSegmentsList();
      this.showToast(`"${clean}" added`);
    }
  }

  markInAtPlayhead() {
    const t = Math.round(this.editorVideo.currentTime * 50) / 50;
    if (this.selectedSegmentIndex !== null && this.segments[this.selectedSegmentIndex]) {
      this.segments[this.selectedSegmentIndex].start = t;
      if (this.segments[this.selectedSegmentIndex].end <= t) {
        this.segments[this.selectedSegmentIndex].end = Math.min(this.duration, t + 1.0);
      }
      this.renderTimelineSegments();
      this.renderSegmentsList();
      this.syncSegmentsToServer();
      this.showToast(`Start set to ${this.formatTime(t)}`);
    } else {
      this.addNewSegmentAtPlayhead();
    }
  }

  markOutAtPlayhead() {
    const t = Math.round(this.editorVideo.currentTime * 50) / 50;
    if (this.selectedSegmentIndex !== null && this.segments[this.selectedSegmentIndex]) {
      const seg = this.segments[this.selectedSegmentIndex];
      if (t > seg.start) {
        seg.end = t;
        this.renderTimelineSegments();
        this.renderSegmentsList();
        this.syncSegmentsToServer();
        this.showToast(`End set to ${this.formatTime(t)}`);
      }
    }
  }

  previewSegmentAudio(idx) {
    const seg = this.segments[idx];
    if (!seg) return;
    this.seekTo(seg.start);
    this.playMedia();
    this.stopAt = seg.end; // the playback loop pauses here
  }

  async syncSegmentsToServer() {
    if (!this.sessionId) return;
    try {
      await fetch(`/api/builder/${this.sessionId}/segments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: this.segments })
      });
    } catch (e) {
      console.warn('Failed to sync segments to server:', e);
    }
  }

  async transcribeSingleSegment(idx, btnEl, textInputEl) {
    if (!this.sessionId || idx < 0 || idx >= this.segments.length) return;
    const seg = this.segments[idx];
    const origText = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.innerHTML = '<svg class="spinning" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><span>Transcribing</span>';
      btnEl.disabled = true;
    }

    const lang = this.selectTranscribeLang ? this.selectTranscribeLang.value : 'auto';
    const isRomaji = lang === 'ja_romaji';

    try {
      const res = await fetch(`/api/builder/${this.sessionId}/transcribe_segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: seg.start,
          end: seg.end,
          language: isRomaji ? 'ja' : lang,
          romanize: isRomaji,
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.text && data.text.trim()) {
          seg.text = data.text.trim();
          if (textInputEl) textInputEl.value = seg.text;
          this.updateNonverbalBadge(idx);
          this.renderTimelineSegments();
          this.syncSegmentsToServer();
          this.showToast(`Line ${idx + 1}: "${seg.text}"`);
        } else {
          this.showToast('No clear speech in this line. Type the text instead.');
        }
      } else {
        this.showToast("Couldn't transcribe this line. Type the text instead.");
      }
    } catch (e) {
      console.warn('Transcription error:', e);
      this.showToast("Couldn't transcribe this line. Type the text instead.");
    } finally {
      if (btnEl) {
        btnEl.innerHTML = origText;
        btnEl.disabled = false;
      }
    }
  }

  async romanizeSingleSegment(idx, btnEl, textInputEl) {
    if (!this.sessionId || idx < 0 || idx >= this.segments.length) return;
    const seg = this.segments[idx];
    if (!seg.text || !seg.text.trim()) {
      this.showToast('This line has no text yet.');
      return;
    }

    const origText = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.innerHTML = '<svg class="spinning" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><span>Converting</span>';
      btnEl.disabled = true;
    }

    try {
      const res = await fetch(`/api/builder/${this.sessionId}/romanize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: seg.text })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.romaji && data.romaji.trim()) {
          seg.text = data.romaji.trim();
          if (textInputEl) textInputEl.value = seg.text;
          this.updateNonverbalBadge(idx);
          this.renderTimelineSegments();
          this.syncSegmentsToServer();
          this.showToast(`Line ${idx + 1}: "${seg.text}"`);
        }
      } else {
        this.showToast("Couldn't convert this line to romaji.");
      }
    } catch (e) {
      console.warn('Romanization error:', e);
    } finally {
      if (btnEl) {
        btnEl.innerHTML = origText;
        btnEl.disabled = false;
      }
    }
  }

  transcribeSelectedSegment() {
    if (!this.has('transcription')) return; // the button's tooltip says why
    if (this.selectedSegmentIndex === null) {
      this.showToast('Select a line first.');
      return;
    }
    const idx = this.selectedSegmentIndex;
    const card = document.getElementById(`cue-card-${idx}`);
    const btn = card ? card.querySelector('.btn-whisper-cue') : null;
    const textInput = card ? card.querySelector('.cue-text-input') : null;
    this.transcribeSingleSegment(idx, btn, textInput);
  }

  // --- STEP 4: Compile & Launch ---

  goToCompileStep() {
    if (this.segments.length === 0) {
      this.showToast('Add at least one line before building.');
      return;
    }

    this.setStep('compile');
    this.pauseMedia();

    const savedUser = localStorage.getItem('dubmate_user_name') || '';
    this.compilePackName.value = this.inputPackTitle.value || this.selectedVideoName.innerText.replace(/\.[^/.]+$/, '');
    this.compileAuthor.value = savedUser || 'Creator';
    this.compileSubtitle.value = `${this.segments.length} lines, ${this.characterColors.size} characters`;

    this.statValDuration.innerText = this.formatTime(this.duration);
    this.statValLines.innerText = this.segments.length;
    this.statValCast.innerText = this.characterColors.size;
  }

  async executePackCompilation() {
    const packName = this.compilePackName.value.trim() || 'Custom Dub Scene';
    const authors = [this.compileAuthor.value.trim() || 'Creator'];
    const subtitle = this.compileSubtitle.value.trim();

    this.btnExecuteCompile.style.display = 'none';
    this.compileProgressBox.style.display = 'flex';
    this.compileStatusMsg.innerText = 'Building the pack';

    try {
      const res = await fetch(`/api/builder/${this.sessionId}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pack_name: packName,
          authors: authors,
          subtitle: subtitle,
          segments: this.segments,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(detailText(err, "The pack didn't build. Try again."));
      }

      const data = await res.json();
      this.compiledPackId = data.pack_id;
      const downloadUrl = data.download_url || `/api/packs/${encodeURIComponent(data.pack_id)}/export`;
      if (this.btnDownloadPackZip) {
        this.btnDownloadPackZip.href = downloadUrl;
        this.btnDownloadPackZip.setAttribute('download', `${packName}.zip`);
      }

      this.compileProgressBox.style.display = 'none';
      this.compileSuccessBox.style.display = 'block';
      this.showToast(`'${packName}' is ready`);

    } catch (ex) {
      this.compileProgressBox.style.display = 'none';
      this.btnExecuteCompile.style.display = 'block';
      this.showToast(ex.message);
    }
  }

  async launchPlaytestSession() {
    if (!this.compiledPackId) {
      window.location.href = '/';
      return;
    }

    const hostName = (this.compileAuthor.value && this.compileAuthor.value.trim()) ||
      localStorage.getItem('dubmate_user_name') ||
      'Host';

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pack_id: this.compiledPackId,
          host_name: hostName,
          host_color: '#d97706',
        }),
      });

      if (res.ok) {
        const roomData = await res.json();
        window.location.href = `/?room=${roomData.room_id}`;
      } else {
        window.location.href = `/?select_pack=${encodeURIComponent(this.compiledPackId)}`;
      }
    } catch (e) {
      window.location.href = `/?select_pack=${encodeURIComponent(this.compiledPackId)}`;
    }
  }

  // --- Utilities ---

  formatTime(seconds) {
    const s = Math.max(0, seconds || 0);
    const mins = Math.floor(s / 60);
    const secs = (s % 60).toFixed(2);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  initModeDropdown() { initModeDropdown(); }

  showToast(message) { showToast(message); }
}

// Instantiate Pack Builder Studio
document.addEventListener('DOMContentLoaded', () => {
  new PackBuilderApp();
});
