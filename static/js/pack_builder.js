// pack_builder.js - High-Performance Pack Authoring Studio Controller
// Handles Video Ingestion, Demucs/Whisper Progress SSE, Interactive Timeline & Cue Editor, and Pack Assembly
import { escapeHtml, showToast, initModeDropdown, initTooltips, isDialogOpen, openDialog, plural } from './ui_common.js';
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

// The processing screen's rows, in order: the engine's stage key, the status while it
// runs, the headline while it runs and the headline when it fails.
const PROCESS_STAGES = [
  { key: 'upload', status: 'uploading', active: 'Uploading the video', failed: "The upload didn't finish" },
  { key: 'audio_extraction', status: 'extracting_audio', active: 'Reading the audio', failed: "Couldn't read the audio" },
  { key: 'stem_separation', status: 'separating_stems', active: 'Separating the voices', failed: "Couldn't separate the voices" },
  { key: 'transcription', status: 'transcribing', active: 'Writing out the lines', failed: "Couldn't write out the lines" },
  { key: 'speakers', status: 'detecting_speakers', active: 'Detecting who speaks', failed: "Couldn't detect who speaks" },
];
// Failures before the engine runs: the subtitles show on the lines row, a refused start on the first stage.
const PROCESS_FAILURES = {
  subtitles: { row: 'transcription', headline: "Couldn't read the subtitles" },
  start: { row: 'audio_extraction', headline: "Processing didn't start" },
};
const ICON_TICK = '<svg class="icon-tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
// Whether CSS can size a textarea to its text (the selected line's text grows without JS).
const FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

// The line rows' icon actions.
const ICON_PLAY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 19 12 6 20 6 4"/></svg>';
const ICON_MIC = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const ICON_GLOBE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const ICON_SPINNER = '<svg class="spinning" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
const ICON_ALERT = '<svg class="icon-alert" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

// The steps in order. Process is never a destination of its own.
const STEP_ORDER = ['upload', 'process', 'editor', 'compile'];
// Engine statuses whose lines can be edited (a build in progress or done included).
const LINES_READY = ['transcribed', 'done', 'slicing', 'assembling'];
const UNDO_LIMIT = 50;
const UNDO_TOAST_MS = 6000;
const SAVE_FAILED = "Couldn't save your changes. Trying again…";

// Character colours, in an order that keeps neighbours apart. Red (recording) and
// green (a confirmed take) mean something else in DubMate, so no character gets them.
const PALETTE = [
  '#d97706', // amber
  '#06b6d4', // cyan
  '#ec4899', // magenta
  '#cca458', // brass
  '#7c5cff', // violet
  '#60a5fa', // sky
  '#b45309', // terracotta
  '#a3a3f5', // periwinkle
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

    // Processing: each run gets a number, so a cancelled run's late callbacks are ignored.
    this.processRun = 0;
    this.processState = null; // the last state renderProcessState() drew
    this.uploadInRun = false; // the run started with a file to upload (shows the Upload row)
    this.uploadXhr = null;
    this.progressSource = null;
    this.progressPoll = null;

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

    // Never losing work: the furthest step this session reached (an index in STEP_ORDER),
    // the undo steps, the save queue, the last build and an explicit leave.
    this.reachedStep = 0;
    this.undoStack = [];
    this.save = { wanted: false, inFlight: false, failed: false, retryTimer: null, delay: 0 };
    this.builtSignature = null;
    this.compiling = false;
    this.compileFilled = false;
    this.editorWarning = '';
    this.textBefore = null; // a line's text when its field took focus, for undo
    this.leaving = false;

    this.initDOM();
    this.initEvents();
    this.initKeyboardShortcuts();
    this.loadCapabilities();
    this.initSession();
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
    if (!this.labelStartProcess) return;
    if (this.isProcessed()) this.labelStartProcess.textContent = 'Back to Edit lines';
    else this.labelStartProcess.textContent = this.willWriteLines() ? 'Process video' : 'Process video without lines';
  }

  /** This session's video has been processed: its lines have been in the editor. */
  isProcessed() {
    return !!this.sessionId && this.reachedStep >= STEP_ORDER.indexOf('editor');
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
    this.sessionEndedNotice = document.getElementById('session-ended-notice');
    this.btnReprocess = document.getElementById('btn-reprocess');
    this.reprocessConfirm = document.getElementById('reprocess-confirm');
    this.changeConfirm = document.getElementById('change-confirm');

    // Header: the stepper and Exit, and the dialog Exit opens before lines are built.
    this.stepper = document.getElementById('builder-stepper');
    this.btnExitBuilder = document.getElementById('btn-exit-builder');
    this.leaveDialog = document.getElementById('modal-leave-builder');

    // Step 2: Processing progress elements
    this.processCard = document.getElementById('process-card');
    this.processRadar = document.getElementById('process-radar');
    this.processHeadline = document.getElementById('process-headline');
    this.processSubtext = document.getElementById('process-subtext');
    this.processProgress = document.getElementById('process-progress');
    this.builderProgressFill = document.getElementById('builder-progress-fill');
    this.processStageText = document.getElementById('process-stage-text');
    this.processPercentText = document.getElementById('process-percent-text');
    this.processRows = new Map(PROCESS_STAGES.map((s) => [s.key, document.querySelector(`.pipeline-item[data-stage="${s.key}"]`)]));
    this.processActions = document.getElementById('process-actions');
    this.btnProcessRetry = document.getElementById('btn-process-retry');
    this.btnProcessWrite = document.getElementById('btn-process-write');
    this.btnProcessBack = document.getElementById('btn-process-back');
    this.btnProcessCancel = document.getElementById('btn-process-cancel');

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
    this.compileStaleBox = document.getElementById('compile-stale-box');
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
    // Change on a processed video asks first, under the video: its lines would go.
    this.btnChangeVideo.addEventListener('click', () => {
      if (!this.isProcessed()) {
        this.changeVideo();
        return;
      }
      this.askInline(this.changeConfirm, `Replace your ${plural(this.segments.length, 'line')} with a new video?`);
    });
    document.getElementById('btn-change-confirm').addEventListener('click', () => this.changeVideo());
    document.getElementById('btn-change-cancel').addEventListener('click', () => this.closeInline(this.changeConfirm, this.btnChangeVideo));
    this.btnReprocess.addEventListener('click', () => {
      this.askInline(this.reprocessConfirm, `Replace your ${plural(this.segments.length, 'line')} with a new pass?`);
    });
    document.getElementById('btn-reprocess-confirm').addEventListener('click', () => {
      this.reprocessConfirm.hidden = true;
      this.startProcessingPipeline();
    });
    document.getElementById('btn-reprocess-cancel').addEventListener('click', () => this.closeInline(this.reprocessConfirm, this.btnReprocess));

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
    // On a processed session the same button reads "Back to Edit lines".
    this.btnStartProcess.addEventListener('click', () => {
      if (this.isProcessed()) this.setStep('editor');
      else this.startProcessingPipeline();
    });
    this.btnProcessRetry.addEventListener('click', () => this.retryProcessing());
    this.btnProcessWrite.addEventListener('click', () => this.writeLinesMyself());
    this.btnProcessBack.addEventListener('click', () => this.backToVideo());
    this.btnProcessCancel.addEventListener('click', () => this.cancelProcessing());

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

    // 12. Character management and the Lines column
    this.btnAddCharacter.addEventListener('click', () => this.addCharacterChip());
    this.initCastScroller();
    this.initCastEditing();
    this.initLinesList();

    // 13. Proceed to compile. A change to the Pack details after a build offers Build again.
    this.btnProceedToCompile.addEventListener('click', () => this.goToCompileStep());
    this.btnExecuteCompile.addEventListener('click', () => this.executePackCompilation());
    document.getElementById('btn-build-again').addEventListener('click', () => this.executePackCompilation());
    [this.compilePackName, this.compileAuthor, this.compileSubtitle].forEach((field) => {
      field.addEventListener('input', () => this.updateBuildState());
    });

    // 15. Record it now
    // It opens the studio on purpose: no "leave?" question on the way.
    const record = () => {
      this.leaving = true;
      this.launchPlaytestSession();
    };
    this.btnPlaytestNow.addEventListener('click', record);
    document.getElementById('btn-stale-record').addEventListener('click', record);

    // 16a. The stepper's reached steps, Exit, and the session details kept per tab.
    this.stepper.addEventListener('click', (e) => {
      const btn = e.target.closest('button.builder-step');
      if (btn && btn.dataset.step !== this.currentStep) this.goToStep(btn.dataset.step);
    });
    this.btnExitBuilder.addEventListener('click', (e) => {
      if (!this.mustAskBeforeLeaving()) return;
      e.preventDefault();
      this.openLeaveDialog(this.btnExitBuilder.href);
    });
    document.getElementById('btn-leave-stay').addEventListener('click', () => this.closeLeaveDialog && this.closeLeaveDialog());
    document.getElementById('btn-leave-confirm').addEventListener('click', () => {
      this.leaving = true;
      if (this.closeLeaveDialog) this.closeLeaveDialog();
      window.location.href = this.leaveHref || '/';
    });
    this.inputPackTitle.addEventListener('input', () => this.saveSessionDetails());
    this.selectTranscribeLang.addEventListener('change', () => this.saveSessionDetails());

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
      const active = document.activeElement;
      const tag = active?.tagName;
      // Ctrl/Cmd+Z undoes the editor's last change. A text field keeps its own undo.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        const textField = tag === 'INPUT' || tag === 'TEXTAREA' || !!active?.isContentEditable;
        if (this.currentStep === 'editor' && !textField && !this.isDragging) {
          e.preventDefault();
          this.undo();
        }
        return;
      }
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

  /**
   * Shows a step. The URL follows (?session=&step=) with a history entry, so browser Back
   * moves between steps: fromHistory (popstate, restore) writes nothing, replace rewrites
   * the current entry. Process gets no entry of its own: it is not a destination.
   */
  setStep(stepName, { fromHistory = false, replace = false } = {}) {
    if (this.currentStep === 'editor' && stepName !== 'editor') this.pauseMedia();
    this.currentStep = stepName;
    this.reachedStep = Math.max(this.reachedStep, STEP_ORDER.indexOf(stepName));
    Object.keys(this.steps).forEach(k => {
      this.steps[k].classList.toggle('active', k === stepName);
    });
    this.renderStepper();
    if (stepName === 'upload') this.updateVideoStepActions();
    if (!fromHistory && stepName !== 'process') this.writeUrl(stepName, replace);

    if (stepName === 'editor') {
      this.setupEditorView();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * The stepper: steps already reached (Video, Edit lines, Build) are buttons, the active one
   * with aria-current="step". Process, steps not reached yet, and every step while processing
   * runs are plain text.
   */
  renderStepper() {
    const current = STEP_ORDER.indexOf(this.currentStep);
    STEP_ORDER.forEach((step, i) => {
      const old = this.navSteps[step];
      const asButton = step !== 'process' && this.currentStep !== 'process' && i <= this.reachedStep;
      let el = old;
      if ((old.tagName === 'BUTTON') !== asButton) {
        el = document.createElement(asButton ? 'button' : 'div');
        if (asButton) el.type = 'button';
        el.id = old.id;
        el.className = old.className;
        el.dataset.step = step;
        el.append(...old.childNodes);
        old.replaceWith(el);
        this.navSteps[step] = el;
      }
      el.classList.toggle('active', i === current);
      el.classList.toggle('completed', i !== current && i <= this.reachedStep);
      if (i === current) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
  }

  /** A stepper button: Video, Edit lines or Build. */
  goToStep(step) {
    if (step === 'compile') this.goToCompileStep();
    else this.setStep(step);
  }

  /** Writes ?session=<id>&step=<step> (or the bare page without a session) as a new history entry, or over the current one. */
  writeUrl(step, replace = false) {
    const url = this.sessionId
      ? `${window.location.pathname}?session=${encodeURIComponent(this.sessionId)}&step=${step}`
      : window.location.pathname;
    const same = url === window.location.pathname + window.location.search;
    if (replace || same) history.replaceState({ step }, '', url);
    else history.pushState({ step }, '', url);
  }

  // --- The session in the URL: reloads, browser Back and leaving ---

  /** Reopens a session named in the URL, follows browser Back and Forward, and guards leaving. */
  initSession() {
    window.addEventListener('popstate', (e) => this.onHistoryStep(e.state));
    window.addEventListener('beforeunload', (e) => {
      if (!this.mustAskBeforeLeaving()) return;
      e.preventDefault();
      e.returnValue = '';
    });
    const params = new URLSearchParams(window.location.search);
    const id = params.get('session');
    if (id) this.restoreSession(id, params.get('step'));
  }

  /** Browser Back or Forward: another session's entry reopens it; this session's moves to its step. */
  onHistoryStep(state) {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('session');
    const step = (state && state.step) || params.get('step') || 'upload';
    if (id && id !== this.sessionId) {
      this.restoreSession(id, step);
      return;
    }
    if ((step === 'editor' || step === 'compile') && this.isProcessed()) {
      if (step === 'compile' && this.goToCompileStep({ fromHistory: true })) return;
      this.setStep('editor', { fromHistory: true });
      return;
    }
    this.setStep('upload', { fromHistory: true });
  }

  /** Opens a session from the URL by what the engine says it is doing. An ended session says so on Step 1. */
  async restoreSession(id, step) {
    let res = null;
    try {
      res = await fetch(`/api/builder/${encodeURIComponent(id)}/status`);
    } catch (e) {
      res = null;
    }
    if (!res || !res.ok) {
      this.sessionEnded();
      return;
    }
    const data = await res.json();
    this.processRun++;
    this.stopProgressUpdates();
    this.resetSessionState();
    this.sessionId = id;
    this.uploadInRun = false;
    this.restoreSessionDetails();
    const status = data.status;

    if (LINES_READY.includes(status)) {
      let lines = {};
      try {
        const segRes = await fetch(`/api/builder/${encodeURIComponent(id)}/segments`);
        if (segRes.ok) lines = await segRes.json();
      } catch (e) {
        console.warn('[PackBuilder] Could not read the lines:', e);
      }
      if (lines.duration > 0) this.duration = lines.duration;
      const toBuild = step === 'compile' && (lines.segments || []).length > 0;
      this.openEditor(
        { segments: lines.segments || [], voices_separated: data.voices_separated, warning: data.warning },
        { quiet: true, fromHistory: toBuild, replace: !toBuild },
      );
      if (toBuild) this.goToCompileStep({ replace: true });
    } else if (status === 'error') {
      this.setStep('process', { fromHistory: true });
      this.renderProcessState(data);
    } else if (status === 'cancelled' || status === 'idle') {
      this.setStep('upload', { replace: true });
    } else {
      // Still processing: the processing screen follows the run.
      this.setStep('process', { fromHistory: true });
      this.renderProcessState(data);
      this.listenToProgressSSE();
    }
  }

  /** The session in the URL has ended (the engine restarted, or it expired): say so on Step 1 and clean the URL. */
  sessionEnded() {
    this.sessionEndedNotice.hidden = false;
    history.replaceState(null, '', window.location.pathname);
  }

  /** The pack name, spoken language and video name are kept per session for this tab. */
  saveSessionDetails() {
    if (!this.sessionId) return;
    const details = {
      packName: this.inputPackTitle.value,
      language: this.selectTranscribeLang.value,
      videoName: this.selectedVideoName.textContent,
    };
    try {
      sessionStorage.setItem(`dubmate_builder_session_${this.sessionId}`, JSON.stringify(details));
    } catch (e) { /* storage full or blocked: only the details are lost */ }
  }

  restoreSessionDetails() {
    let details = null;
    try {
      details = JSON.parse(sessionStorage.getItem(`dubmate_builder_session_${this.sessionId}`) || 'null');
    } catch (e) { details = null; }
    if (details && details.packName) this.inputPackTitle.value = details.packName;
    if (details && Array.from(this.selectTranscribeLang.options).some((o) => o.value === details.language)) {
      this.selectTranscribeLang.value = details.language;
    }
    this.showSelectedVideo((details && details.videoName) || 'Your video', '');
  }

  /** Leaving would lose something: a save that hasn't gone through, or lines on Edit lines or Build not built as they are. */
  mustAskBeforeLeaving() {
    if (this.leaving) return false;
    if (this.save.wanted || this.save.inFlight || this.save.failed) return true;
    return (this.currentStep === 'editor' || this.currentStep === 'compile') && !this.isBuiltCurrent();
  }

  /** Exit (or the menu's Studio) before the lines are built: Stay, or Leave to `href`. */
  openLeaveDialog(href) {
    this.leaveHref = href;
    this.closeLeaveDialog = openDialog(this.leaveDialog, { returnFocus: this.btnExitBuilder });
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
    this.resetSessionState();
    this.updateVideoStepActions();
    this.selectedVideoName.textContent = file.name;
    const mbSize = (file.size / (1024 * 1024)).toFixed(1);
    this.selectedVideoStats.textContent = `${mbSize} MB`;

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

  /** Change: forgets the video and its session, and shows the dropzone again. */
  changeVideo() {
    this.videoFile = null;
    this.sessionId = null;
    this.resetSessionState();
    this.writeUrl('upload');
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
    }
    this.updateVideoStepActions();
  }

  /** Shows the chosen video's card in place of the dropzone and the link field. */
  showSelectedVideo(name, stats) {
    this.selectedVideoName.textContent = name;
    this.selectedVideoStats.textContent = stats;
    if (this.ingestPanelFile) this.ingestPanelFile.style.display = 'none';
    if (this.ingestPanelUrl) this.ingestPanelUrl.style.display = 'none';
    this.videoSelectedCard.style.display = 'flex';
    this.btnStartProcess.disabled = false;
  }

  /** A new video or session: nothing of the last one's steps, undo, build or Pack details carries over. */
  resetSessionState() {
    this.reachedStep = 0;
    this.undoStack = [];
    this.builtSignature = null;
    this.compiledPackId = null;
    this.compileFilled = false;
    this.segments = [];
    this.selectedSegmentIndex = null;
    if (this.sessionEndedNotice) this.sessionEndedNotice.hidden = true;
  }

  /** Video on a processed session: the primary goes back to the lines, and processing again asks first. */
  updateVideoStepActions() {
    const processed = this.isProcessed();
    this.btnReprocess.hidden = !processed;
    if (!processed) {
      this.reprocessConfirm.hidden = true;
      this.changeConfirm.hidden = true;
    }
    this.updateStartButtonLabel();
  }

  /** Shows an inline question (a sentence, then its buttons) and moves focus to its Cancel. */
  askInline(box, question) {
    box.querySelector('.inline-confirm-text').textContent = question;
    box.hidden = false;
    box.querySelector('.btn-secondary').focus();
  }

  closeInline(box, returnFocus) {
    box.hidden = true;
    if (returnFocus) returnFocus.focus();
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
      this.resetSessionState();
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
      this.selectedVideoName.textContent = data.title || data.filename;
      this.selectedVideoStats.textContent = this.formatTime(data.duration);

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
      this.updateVideoStepActions();
      this.saveSessionDetails();
      this.writeUrl('upload', true);
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
    const run = ++this.processRun;
    this.stopProgressUpdates();
    this.uploadInRun = !this.sessionId;
    this.setStep('process');
    this.renderProcessState({ status: 'starting', progress: 0, message: 'Starting' });

    try {
      if (!this.sessionId) {
        const uploaded = await this.uploadVideo(run);
        if (run !== this.processRun) return;
        this.sessionId = uploaded.session_id;
        this.duration = uploaded.duration;
        // From here a reload finds this session again.
        this.saveSessionDetails();
        this.writeUrl('upload', true);
      }

      if (this.coverFile) {
        const coverData = new FormData();
        coverData.append('file', this.coverFile);
        const coverRes = await fetch(`/api/builder/${this.sessionId}/cover`, {
          method: 'POST',
          body: coverData,
        });
        if (run !== this.processRun) return;
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
        if (run !== this.processRun) return;
        // Never fall through to transcription when the chosen subtitles didn't arrive.
        if (!subRes.ok) {
          const err = await subRes.json().catch(() => ({}));
          throw this.processError('subtitles', detailText(err, 'Check the file and try again.'));
        }
        const subJson = await subRes.json();
        if (subJson.segments && subJson.segments.length > 0) {
          this.segments = subJson.segments;
        }
      }

      await this.requestProcessing(run);
    } catch (ex) {
      this.failProcessing(run, ex);
    }
  }

  /** An error that names where it stopped: 'upload', 'subtitles', 'start' or an engine stage. */
  processError(stage, message) {
    const err = new Error(message);
    err.stage = stage;
    return err;
  }

  /** Shows a failure the page found itself, unless that run was cancelled. */
  failProcessing(run, ex) {
    if (run !== this.processRun) return;
    console.warn('[PackBuilder] Processing stopped:', ex);
    const last = this.processState || {};
    this.renderProcessState({
      status: 'error',
      progress: 0,
      stage: ex.stage || last.stage || 'start',
      error: ex.message || "Processing didn't finish. Try again.",
      skipped: last.skipped || [],
    });
  }

  /** Uploads the chosen video with progress. Resolves the engine's answer, or null when cancelled. */
  uploadVideo(run) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.uploadXhr = xhr;
      const size = this.videoFile.size;
      xhr.upload.onprogress = (e) => {
        if (run !== this.processRun) return;
        this.renderProcessState({ status: 'uploading', progress: 0, upload: { loaded: e.loaded, total: e.lengthComputable ? e.total : size } });
      };
      xhr.onload = () => {
        this.uploadXhr = null;
        let body = {};
        try { body = JSON.parse(xhr.responseText || '{}'); } catch (e) { body = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && body.session_id) resolve(body);
        else reject(this.processError('upload', detailText(body, 'Try again.')));
      };
      xhr.onerror = () => {
        this.uploadXhr = null;
        reject(this.processError('upload', 'Check that DubMate is still running, then try again.'));
      };
      xhr.onabort = () => {
        this.uploadXhr = null;
        resolve(null);
      };
      const form = new FormData();
      form.append('file', this.videoFile);
      xhr.open('POST', '/api/builder/upload');
      this.renderProcessState({ status: 'uploading', progress: 0, upload: { loaded: 0, total: size } });
      xhr.send(form);
    });
  }

  /** POSTs /process for this session, then follows its progress. */
  async requestProcessing(run) {
    const lang = this.selectTranscribeLang.value;
    const body = { language: lang, whisper_model: 'base' };
    if (!this.willWriteLines()) body.transcribe = false;
    this.renderProcessState({ status: 'queued', progress: 0, message: 'Starting' });
    const processRes = await fetch(`/api/builder/${this.sessionId}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (run !== this.processRun) return;
    if (!processRes.ok) {
      const err = await processRes.json().catch(() => ({}));
      throw this.processError('start', detailText(err, 'Try again.'));
    }
    this.listenToProgressSSE();
  }

  /** Try again: re-POSTs /process for the same session. Only a failed upload or subtitle import starts over. */
  async retryProcessing() {
    const stage = this.processState && this.processState.stage;
    if (!this.sessionId || stage === 'upload' || stage === 'subtitles') {
      this.startProcessingPipeline();
      return;
    }
    const run = ++this.processRun;
    try {
      await this.requestProcessing(run);
    } catch (ex) {
      this.failProcessing(run, ex);
    }
  }

  /** Cancel: stops the upload, or asks the engine to stop, and returns to Video at once with everything kept. */
  cancelProcessing() {
    this.processRun++;
    if (this.uploadXhr) {
      this.uploadXhr.abort();
    } else if (this.sessionId) {
      // The engine stops at its next stage boundary; a new run waits for it.
      fetch(`/api/builder/${this.sessionId}/cancel`, { method: 'POST' })
        .catch((e) => console.warn('[PackBuilder] Cancel not sent:', e));
    }
    this.stopProgressUpdates();
    this.setStep('upload');
  }

  /** Back to video after a failure: the file, chips, pack name and language are kept. */
  backToVideo() {
    this.processRun++;
    this.stopProgressUpdates();
    this.setStep('upload');
  }

  /** Write the lines myself: the editor with no lines, on the voice track when separation finished. */
  writeLinesMyself() {
    const state = this.processState || {};
    this.processRun++;
    this.stopProgressUpdates();
    this.openEditor({ segments: [], voices_separated: state.voices_separated });
  }

  stopProgressUpdates() {
    if (this.progressSource) {
      this.progressSource.close();
      this.progressSource = null;
    }
    if (this.progressPoll) {
      clearInterval(this.progressPoll);
      this.progressPoll = null;
    }
  }

  listenToProgressSSE() {
    this.stopProgressUpdates();
    const run = this.processRun;
    const sse = new EventSource(`/api/builder/${this.sessionId}/progress`);
    this.progressSource = sse;

    sse.onmessage = (event) => {
      if (run !== this.processRun) {
        sse.close();
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.error('Error parsing SSE event:', e);
        return;
      }
      this.applyEngineState(run, data);
    };

    sse.onerror = () => {
      sse.close();
      if (run === this.processRun && this.progressSource === sse) {
        this.progressSource = null;
        this.pollProgressStatus();
      }
    };
  }

  pollProgressStatus() {
    const run = this.processRun;
    this.progressPoll = setInterval(async () => {
      try {
        const res = await fetch(`/api/builder/${this.sessionId}/status`);
        if (run !== this.processRun) return;
        if (!res.ok) throw new Error('Lost track of processing. Try again.');
        const data = await res.json();
        if (run !== this.processRun) return;
        this.applyEngineState(run, data);
      } catch (e) {
        this.stopProgressUpdates();
        this.failProcessing(run, e);
      }
    }, 1000);
  }

  /** One engine status (from the stream or /status) onto the screen; the editor opens when the lines are ready. */
  applyEngineState(run, data) {
    this.renderProcessState(data);
    const status = data.status;
    if (status === 'transcribed') {
      this.stopProgressUpdates();
      setTimeout(() => {
        if (run === this.processRun) this.openEditor(data);
      }, 600);
    } else if (status === 'error') {
      this.stopProgressUpdates();
    } else if (status === 'cancelled') {
      this.stopProgressUpdates();
      this.setStep('upload');
    }
  }

  /**
   * The only writer of the processing screen. state: status, stage, progress,
   * message, skipped, error_code, error, and upload ({loaded, total}) while uploading.
   */
  renderProcessState(state) {
    this.processState = state;
    const status = state.status;
    const failed = status === 'error';
    const finished = status === 'transcribed' || status === 'done';
    const rows = PROCESS_STAGES.filter((s) => s.key !== 'upload' || this.uploadInRun);
    const failure = failed ? (PROCESS_FAILURES[state.stage] || null) : null;

    // The row that is running, or that failed. Rows before it are finished.
    let current;
    if (failed) {
      current = rows.findIndex((s) => s.key === (failure ? failure.row : state.stage));
      if (current < 0) current = rows.findIndex((s) => s.key !== 'upload');
    } else if (finished) {
      current = rows.length;
    } else {
      current = rows.findIndex((s) => s.status === status);
    }
    // Before the engine's first stage, a finished upload is already ticked.
    const uploaded = this.uploadInRun && !!this.sessionId && status !== 'uploading';
    const skipped = new Set(state.skipped || []);
    const message = (state.error || state.message || '').trim();

    PROCESS_STAGES.forEach((stage) => {
      const row = this.processRows.get(stage.key);
      const i = rows.indexOf(stage);
      row.hidden = i < 0;
      if (i < 0) return;
      let kind = 'pending';
      if (failed && i === current) kind = 'failed';
      else if (skipped.has(stage.key)) kind = 'skipped';
      else if (i < current || (stage.key === 'upload' && uploaded)) kind = 'done';
      else if (i === current) kind = 'active';
      row.classList.toggle('active', kind === 'active');
      row.classList.toggle('is-done', kind === 'done');
      row.classList.toggle('is-skipped', kind === 'skipped');
      row.classList.toggle('is-failed', kind === 'failed');
      if (kind === 'active') row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
      const icon = row.querySelector('.stage-icon');
      if (kind === 'done') icon.innerHTML = ICON_TICK;
      else if (kind === 'failed') icon.innerHTML = ICON_ALERT;
      else icon.textContent = String(i + 1);
      const desc = row.querySelector('.stage-desc');
      if (kind === 'failed') desc.textContent = message || "Processing didn't finish. Try again.";
      else if (kind === 'skipped') desc.textContent = 'Skipped';
      else desc.textContent = desc.dataset.desc || '';
    });

    // The headline: the active stage as a sentence, or the stage that failed.
    let headline = 'Starting';
    if (failed) headline = failure ? failure.headline : rows[current].failed;
    else if (finished) headline = 'Opening the editor';
    else if (rows[current]) headline = rows[current].active;

    // On a failure the radar stops, and the message shows only in the failed row.
    if (failed) this.processCard.setAttribute('role', 'alert');
    else this.processCard.removeAttribute('role');
    this.processRadar.classList.toggle('is-stopped', failed);
    this.processHeadline.textContent = headline;
    this.processSubtext.hidden = failed;
    this.processProgress.hidden = failed;

    if (!failed) {
      const up = status === 'uploading' ? state.upload : null;
      const fraction = up ? (up.total ? up.loaded / up.total : 0) : (state.progress || 0);
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      this.builderProgressFill.style.width = `${pct}%`;
      this.processPercentText.textContent = `${pct}%`;
      this.processStageText.textContent = up
        ? `Uploading · ${this.formatMegabytes(up.loaded, up.total)} of ${this.formatMegabytes(up.total, up.total)} MB`
        : (state.message || 'Starting');
    }

    // Cancel while it runs; when it fails, a way forward with the primary first.
    this.btnProcessCancel.hidden = failed || finished;
    let order = [];
    if (failed && state.stage === 'transcription') {
      order = state.error_code === 'pipeline_missing'
        ? [this.btnProcessWrite, this.btnProcessBack]
        : [this.btnProcessRetry, this.btnProcessWrite, this.btnProcessBack];
    } else if (failed) {
      order = [this.btnProcessRetry, this.btnProcessBack];
    }
    [this.btnProcessRetry, this.btnProcessWrite, this.btnProcessBack].forEach((btn) => {
      btn.hidden = !order.includes(btn);
      btn.classList.toggle('btn-primary', btn === order[0]);
      btn.classList.toggle('btn-secondary', btn !== order[0]);
    });
    if (failed) {
      this.processActions.prepend(...order);
      order[0].focus();
    }
  }

  /** Megabytes for the upload caption: whole numbers from 10 MB, one decimal below. */
  formatMegabytes(bytes, total) {
    const mb = bytes / (1024 * 1024);
    return total >= 10 * 1024 * 1024 ? String(Math.round(mb)) : mb.toFixed(1);
  }

  /**
   * Opens the editor on lines from the engine (processing finished, or a reopened session):
   * the lines, the server's notice and a result toast (not with opts.quiet). opts also go to setStep.
   */
  openEditor(data, opts = {}) {
    this.segments = data.segments || this.segments;
    this.selectedSegmentIndex = null;
    this.undoStack = [];
    // Only an explicit false means no voice track; older engines don't send the flag.
    this.voicesSeparated = data.voices_separated !== false;
    this.editorWarning = (data.warning || '').trim();
    this.renderEditorNotice();
    this.setStep('editor', opts);
    const total = this.segments.length;
    // With no lines, the Lines column says what to do instead.
    if (!total || opts.quiet) return;
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
    return seg.text || '(no words)';
  }

  /** A block's label, and its tip and name, which also say who speaks. */
  labelBlock(block, seg) {
    const label = block.querySelector('.segment-block-label');
    if (label) label.innerText = this.blockLabel(seg);
    const name = `${seg.character}: ${this.blockLabel(seg)}`;
    block.dataset.tip = name;
    block.setAttribute('aria-label', name);
  }

  /** A block in its character's colour. */
  paintBlock(block, color) {
    block.style.borderColor = color;
    block.style.background = `${color}28`;
    block.querySelectorAll('.builder-segment-handle').forEach((h) => { h.style.background = color; });
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

      // Left resize handle
      const handleL = document.createElement('div');
      handleL.className = 'builder-segment-handle handle-left';
      handleL.dataset.idx = idx;
      handleL.dataset.type = 'start';
      handleL.dataset.tip = 'Drag to change the start';

      // Right resize handle
      const handleR = document.createElement('div');
      handleR.className = 'builder-segment-handle handle-right';
      handleR.dataset.idx = idx;
      handleR.dataset.type = 'end';
      handleR.dataset.tip = 'Drag to change the end';

      // Inner content wrap
      const contentWrap = document.createElement('div');
      contentWrap.className = 'segment-block-content';

      const label = document.createElement('div');
      label.className = 'segment-block-label';

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
      this.paintBlock(block, color);
      this.labelBlock(block, seg);

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

  /** A row's name for screen readers: "Line 4, Detective Mori, 0:12.40". */
  rowLabel(seg, idx) {
    return `Line ${idx + 1}, ${seg.character}, ${this.formatTime(seg.start)}`;
  }

  /** The selected row shows start – end; the others show their start. */
  rowTimecode(seg, selected) {
    return selected ? `${this.formatTime(seg.start)} – ${this.formatTime(seg.end)}` : this.formatTime(seg.start);
  }

  /**
   * One line as a compact row. Every action is in the markup and CSS shows the ones that
   * apply (Play on hover, all of them on the selected row), so selecting rebuilds nothing.
   * The character select holds only its own option until it is opened (fillCharacterOptions).
   */
  lineRowHtml(seg, idx, selected, tabbable, canTranscribe) {
    const text = seg.text || '';
    const name = escapeHtml(seg.character);
    const noWords = seg.nonverbal
      ? `<span class="cue-nonverbal-badge" tabindex="0" data-tip="A grunt, laugh or other sound without words. Record it like any other line."${text.trim() ? ' hidden' : ''}>No words</span>`
      : '';
    const action = (cls, label, icon, extra = '') =>
      `<button type="button" class="btn btn-ghost btn-xs line-action ${cls}" aria-label="${label}" data-tip="${label}"${extra}>${icon}</button>`;
    return `<div class="builder-line-row${selected ? ' selected' : ''}" id="cue-card-${idx}" data-idx="${idx}" role="listitem" tabindex="${tabbable ? 0 : -1}"${selected ? ' aria-current="true"' : ''} aria-label="${escapeHtml(this.rowLabel(seg, idx))}">`
      + `<span class="cue-dot" style="background: ${this.getCharacterColor(seg.character)};"></span>`
      + `<span class="cue-number" aria-hidden="true">${idx + 1}</span>`
      + `<select class="form-input cue-char-select" aria-label="Character"><option value="${name}" selected>${name}</option></select>`
      + `<div class="cue-text-cell">${noWords}<textarea class="form-input cue-text-input" rows="1" aria-label="Line text" placeholder="${seg.nonverbal ? 'No words. Type a cue like (laughs) if you want.' : 'Line text'}">${escapeHtml(text)}</textarea></div>`
      + '<div class="cue-actions">'
      + action('btn-preview-cue', 'Play this line', ICON_PLAY)
      + (canTranscribe ? action('btn-whisper-cue', 'Fill in this line&#39;s text from the audio', ICON_MIC) : '')
      + action('btn-romaji-cue', 'Convert to romaji', ICON_GLOBE, this.romajiApplies(seg) ? '' : ' hidden')
      + action('btn-delete-cue', 'Delete line', ICON_TRASH)
      + '</div>'
      + `<span class="cue-timecode-badge">${this.rowTimecode(seg, selected)}</span>`
      + '</div>';
  }

  renderSegmentsList() {
    const container = this.segmentsListContainer;
    const hadFocus = container.contains(document.activeElement);
    this.labelCueCount.innerText = `${this.segments.length} line${this.segments.length === 1 ? '' : 's'}`;
    this.updateMarkButtons();
    // aria-disabled rather than disabled, so the tooltip still says why.
    if (this.segments.length) {
      this.btnProceedToCompile.removeAttribute('aria-disabled');
      delete this.btnProceedToCompile.dataset.tip;
    } else {
      this.btnProceedToCompile.setAttribute('aria-disabled', 'true');
      this.btnProceedToCompile.dataset.tip = 'Add a line first';
      container.removeAttribute('role'); // a note, not an empty list
      container.innerHTML = `
        <div class="lines-empty">
          <p class="lines-empty-title">No lines yet</p>
          <p class="lines-empty-hint">Play the video and press N, or Add line, where someone speaks.</p>
        </div>`;
      return;
    }

    container.setAttribute('role', 'list');
    const canTranscribe = this.has('transcription');
    const selected = this.segments[this.selectedSegmentIndex] ? this.selectedSegmentIndex : null;
    // Roving tabindex: Tab reaches the selected row, or the first one before any selection.
    const tabbable = selected === null ? 0 : selected;
    container.innerHTML = this.segments
      .map((seg, idx) => this.lineRowHtml(seg, idx, idx === selected, idx === tabbable, canTranscribe))
      .join('');
    const row = document.getElementById(`cue-card-${tabbable}`);
    if (row && selected !== null) this.fitLineText(row.querySelector('.cue-text-input'));
    if (row && hadFocus) row.focus({ preventScroll: true });
  }

  /**
   * The selected row's text shows in full, up to 4 lines (CSS caps it), then scrolls. CSS
   * field-sizing grows it without a layout read; this measures only where that is missing.
   */
  fitLineText(textarea) {
    if (!textarea || FIELD_SIZING) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight + 2}px`; // + the 1px borders
  }

  /** Fills a row's character select with the whole cast, when it is about to open. */
  fillCharacterOptions(select, idx) {
    const seg = this.segments[idx];
    if (!seg) return;
    const cast = this.castNames();
    if (!cast.includes(seg.character)) cast.push(seg.character);
    select.innerHTML = cast.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')
      + '<option value="__ADD_NEW__">+ New character…</option>';
    select.value = seg.character;
  }

  /**
   * The Lines column's events, delegated once to the list: rows are plain markup, so a
   * re-render adds no listeners, and each handler finds its line by the row's data-idx.
   */
  initLinesList() {
    const list = this.segmentsListContainer;
    const rowOf = (el) => el.closest('.builder-line-row');
    const idxOf = (row) => parseInt(row.dataset.idx, 10);

    list.addEventListener('click', (e) => {
      const row = rowOf(e.target);
      if (!row) return;
      const idx = idxOf(row);
      const btn = e.target.closest('button');
      if (btn) {
        const textInput = row.querySelector('.cue-text-input');
        if (btn.classList.contains('btn-preview-cue')) this.previewSegmentAudio(idx);
        else if (btn.classList.contains('btn-whisper-cue')) this.transcribeSingleSegment(idx, btn, textInput);
        else if (btn.classList.contains('btn-romaji-cue')) this.romanizeSingleSegment(idx, btn, textInput);
        else if (btn.classList.contains('btn-delete-cue')) this.deleteSegment(idx);
        return;
      }
      if (e.target.closest('select, textarea')) return;
      this.selectSegment(idx);
      this.seekTo(this.segments[idx].start);
    });

    // A field of another line selects that line, without moving the video.
    list.addEventListener('focusin', (e) => {
      const row = rowOf(e.target);
      if (!row || e.target === row) return;
      const idx = idxOf(row);
      if (e.target.classList.contains('cue-char-select')) this.fillCharacterOptions(e.target, idx);
      // A committed text edit is one undo step, from the text the field had when it took focus.
      if (e.target.classList.contains('cue-text-input')) this.textBefore = { idx, text: this.segments[idx].text || '' };
      if (this.selectedSegmentIndex !== idx) this.selectSegment(idx);
    });
    // A click can open the select as it takes focus, so the press fills it too.
    list.addEventListener('pointerdown', (e) => {
      const select = e.target.closest('.cue-char-select');
      if (select && document.activeElement !== select) this.fillCharacterOptions(select, idxOf(rowOf(select)));
    });

    list.addEventListener('input', (e) => {
      if (!e.target.classList.contains('cue-text-input')) return;
      const row = rowOf(e.target);
      const idx = idxOf(row);
      this.segments[idx].text = e.target.value;
      this.updateNonverbalBadge(idx);
      const romaji = row.querySelector('.btn-romaji-cue');
      if (romaji) romaji.hidden = !this.romajiApplies(this.segments[idx]);
      if (row.classList.contains('selected')) this.fitLineText(e.target);
    });

    list.addEventListener('change', (e) => {
      const row = rowOf(e.target);
      if (!row) return;
      const idx = idxOf(row);
      if (e.target.classList.contains('cue-text-input')) {
        const before = this.textBefore;
        if (before && before.idx === idx && before.text !== e.target.value) {
          const step = this.snapshot();
          step.segments[idx].text = before.text;
          this.pushUndo(step);
          before.text = e.target.value;
        }
        const block = this.segmentBlocks[idx];
        if (block) this.labelBlock(block, this.segments[idx]);
        this.syncSegmentsToServer();
      } else if (e.target.classList.contains('cue-char-select')) {
        this.changeLineCharacter(idx, e.target);
      }
    });

    list.addEventListener('keydown', (e) => {
      const row = rowOf(e.target);
      if (!row) return;
      const idx = idxOf(row);
      if (e.target === row && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        // A focused row that isn't selected yet (before any selection) selects itself first.
        const next = this.selectedSegmentIndex !== idx ? idx : idx + (e.key === 'ArrowDown' ? 1 : -1);
        if (!this.segments[next]) return;
        this.selectSegment(next);
        document.getElementById(`cue-card-${next}`).focus({ preventScroll: true });
        this.seekTo(this.segments[next].start);
      } else if (e.target === row && e.key === 'Enter') {
        e.preventDefault();
        row.querySelector('.cue-text-input').focus();
      } else if (e.key === 'Escape' && e.target.classList.contains('cue-text-input')) {
        e.preventDefault();
        row.focus();
      }
    });
  }

  /** A line's new character: its dot, row name, block and the Cast row follow; nothing is rebuilt. */
  changeLineCharacter(idx, select) {
    const seg = this.segments[idx];
    const name = select.value;
    if (name === '__ADD_NEW__') {
      this.askNewCharacter(idx, select);
      return;
    }
    if (name === seg.character) return;
    this.pushUndo();
    seg.character = name;
    const color = this.getCharacterColor(name);
    const row = document.getElementById(`cue-card-${idx}`);
    if (row) {
      row.querySelector('.cue-dot').style.background = color;
      row.setAttribute('aria-label', this.rowLabel(seg, idx));
    }
    const block = this.segmentBlocks[idx];
    if (block) {
      this.paintBlock(block, color);
      this.labelBlock(block, seg);
    }
    this.renderCharacterChips();
    this.syncSegmentsToServer();
  }

  /**
   * "+ New character…" in a row: the select makes way for a name field. Enter (or leaving the
   * field with a name) creates the character and gives it the line; Esc puts the select back.
   */
  askNewCharacter(idx, select) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input cue-char-input';
    input.placeholder = 'Name';
    input.maxLength = 40;
    input.setAttribute('aria-label', 'New character name');
    select.value = this.segments[idx].character;
    select.hidden = true;
    select.after(input);
    let done = false;
    const finish = (name, refocus) => {
      if (done) return;
      done = true;
      input.remove();
      select.hidden = false;
      if (name) {
        if (!Array.from(select.options).some((o) => o.value === name)) {
          select.add(new Option(name, name), select.options[select.options.length - 1]);
        }
        select.value = name;
        this.changeLineCharacter(idx, select);
      }
      if (refocus) select.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value.trim(), true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish('', true);
      }
    });
    input.addEventListener('blur', () => finish(input.value.trim(), false));
    input.focus();
  }

  /** Start and End act on the selected line. With none they say so, and so do their keys. */
  updateMarkButtons() {
    const has = !!this.segments[this.selectedSegmentIndex];
    if (this._markButtonsOn === has) return;
    this._markButtonsOn = has;
    [[this.btnMarkIn, 'Start the selected line at the playhead (I or [)'],
      [this.btnMarkOut, 'End the selected line at the playhead (O or ])']].forEach(([btn, tip]) => {
      if (has) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', 'true');
      btn.dataset.tip = has ? tip : 'Select a line first';
    });
  }

  /** Every character: the cast's colours first (their order), then any other line's character. */
  castNames() {
    return Array.from(new Set([
      ...this.characterColors.keys(),
      ...this.segments.map(s => s.character).filter(Boolean),
    ]));
  }

  renderCharacterChips() {
    const list = this.characterChipsList;
    list.innerHTML = '';

    this.castNames().forEach(char => {
      const color = this.getCharacterColor(char);
      const count = this.segments.filter(s => s.character === char).length;
      const name = escapeHtml(char);
      const chip = document.createElement('div');
      chip.className = 'char-color-chip';
      chip.innerHTML = `
        <span class="chip-color-dot" style="background: ${color};"></span>
        <button type="button" class="chip-name" data-char="${name}" aria-label="Rename ${name}" data-tip="Rename">${name}</button>
        <span class="chip-count-badge" aria-label="${count} line${count === 1 ? '' : 's'}">(${count})</span>
        <button type="button" class="chip-del-btn" aria-label="Delete ${name}" data-tip="Delete character" data-char="${name}">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      list.appendChild(chip);
    });
    this.updateCastScroller();
  }

  /** The Cast row's names and × buttons, delegated once: a name edits in place, × deletes. */
  initCastEditing() {
    this.characterChipsList.addEventListener('click', (e) => {
      const del = e.target.closest('.chip-del-btn');
      if (del) {
        this.deleteCharacter(del.dataset.char);
        return;
      }
      const name = e.target.closest('button.chip-name');
      if (name) this.editChipName(name.closest('.char-color-chip'), name.dataset.char);
    });
  }

  /** + in the Cast row: a new chip with its name field open. */
  addCharacterChip() {
    const chip = document.createElement('div');
    chip.className = 'char-color-chip is-editing';
    chip.innerHTML = `<span class="chip-color-dot" style="background: ${PALETTE[this.characterColors.size % PALETTE.length]};"></span>`;
    this.characterChipsList.appendChild(chip);
    this.updateCastScroller();
    chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.editChipName(chip, null);
  }

  /**
   * A chip's name as a field: Enter or leaving the field keeps the name, Esc cancels.
   * oldName null is a new chip, which an empty name removes.
   */
  editChipName(chip, oldName) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input chip-name-input';
    input.value = oldName || '';
    input.placeholder = 'Name';
    input.maxLength = 40;
    input.setAttribute('aria-label', oldName ? `Rename ${oldName}` : 'New character name');
    chip.classList.add('is-editing');
    const nameEl = chip.querySelector('.chip-name');
    if (nameEl) nameEl.replaceWith(input);
    else chip.appendChild(input);
    let done = false;
    const finish = (commit, refocus) => {
      if (done) return;
      done = true;
      const result = commit ? this.commitCharacterName(oldName, input.value.trim()) : oldName;
      if (!commit) this.renderCharacterChips();
      if (!refocus) return;
      const target = result && Array.from(this.characterChipsList.querySelectorAll('button.chip-name'))
        .find((b) => b.dataset.char === result);
      (target || this.btnAddCharacter).focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false, true);
      }
    });
    input.addEventListener('blur', () => finish(true, false));
    input.focus();
    input.select();
  }

  /**
   * Keeps a chip's new name, and returns the name the chip ends with. A new name for a new
   * chip adds the character; a rename moves its lines; a rename onto another character
   * merges the two. An empty or unchanged name changes nothing.
   */
  commitCharacterName(oldName, name) {
    if (!name || name === oldName) {
      this.renderCharacterChips();
      return oldName;
    }
    const exists = this.castNames().includes(name);
    if (!oldName) {
      if (!exists) {
        this.pushUndo();
        this.getCharacterColor(name);
      }
      this.renderCharacterChips();
      const chip = Array.from(this.characterChipsList.children).find((c) => c.querySelector('.chip-name')?.dataset.char === name);
      if (chip) chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      return name;
    }
    const step = this.pushUndo();
    this.segments.forEach((s) => { if (s.character === oldName) s.character = name; });
    if (exists) {
      this.characterColors.delete(oldName);
    } else {
      // A renamed character keeps its colour and its place in the row.
      this.characterColors = new Map(Array.from(this.characterColors, ([k, v]) => [k === oldName ? name : k, v]));
    }
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.syncSegmentsToServer();
    if (exists) this.showToast(`Merged into ${name}`, { action: { label: 'Undo', onClick: () => this.undo(step) }, duration: UNDO_TOAST_MS });
    return name;
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

  /** × on a chip: the character goes at once and its lines move to the first one left. The toast can undo it. */
  deleteCharacter(name) {
    const moved = this.segments.filter((s) => s.character === name).length;
    const fallback = this.castNames().find((c) => c !== name) || 'Lead';
    const step = this.pushUndo();
    this.segments.forEach((s) => { if (s.character === name) s.character = fallback; });
    this.characterColors.delete(name);
    if (this.characterColors.size === 0) this.getCharacterColor(fallback);

    this.renderTimelineSegments();
    this.renderCharacterChips();
    this.renderSegmentsList();
    this.syncSegmentsToServer();
    const message = moved ? `${name} deleted. ${plural(moved, 'line')} moved to ${fallback}` : `${name} deleted`;
    this.showToast(message, { action: { label: 'Undo', onClick: () => this.undo(step) }, duration: UNDO_TOAST_MS });
  }

  /**
   * Moves the highlight to a line's block and row: class toggles, the rows' tabindex and
   * timecodes, and the one textarea that grows. Nothing is rebuilt.
   */
  selectSegment(idx) {
    this.selectedSegmentIndex = idx;
    const list = this.segmentsListContainer;
    const target = document.getElementById(`cue-card-${idx}`);
    const focusOnRow = document.activeElement?.parentElement === list && document.activeElement !== target;
    const previous = Array.from(list.querySelectorAll('.builder-line-row.selected, .builder-line-row[tabindex="0"]'))
      .filter((row) => row !== target);
    // Tabindex and focus go first: changed after the classes and text below, a focused
    // row's tabindex makes the browser recalculate the styles at once (about 2 ms).
    if (target) target.tabIndex = 0;
    previous.forEach((row) => { row.tabIndex = -1; });
    // Keyboard focus on a row follows the selection.
    if (target && focusOnRow) target.focus({ preventScroll: true });

    this.timelineSegmentsOverlay.querySelectorAll('.builder-segment-block.selected').forEach((b) => b.classList.remove('selected'));
    if (this.segmentBlocks[idx]) this.segmentBlocks[idx].classList.add('selected');
    previous.forEach((row) => {
      row.classList.remove('selected');
      row.removeAttribute('aria-current');
      row.querySelector('.cue-text-input').style.height = '';
      this.updateCardTimecode(parseInt(row.dataset.idx, 10));
    });
    if (target) {
      target.classList.add('selected');
      target.setAttribute('aria-current', 'true');
      this.updateCardTimecode(idx);
      this.fitLineText(target.querySelector('.cue-text-input'));
      // Scrolled into view in the next frame, with that frame's layout, so the click or
      // key that selected doesn't wait for one.
      cancelAnimationFrame(this._scrollRowFrame);
      this._scrollRowFrame = requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
    this.updateMarkButtons();
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
        // One undo step per drop that moved the line, back to where the drag started.
        const moved = this.segments[modifiedIdx];
        if (moved && (moved.start !== this.dragOrigStart || moved.end !== this.dragOrigEnd)) {
          const step = this.snapshot();
          step.segments[modifiedIdx].start = this.dragOrigStart;
          step.segments[modifiedIdx].end = this.dragOrigEnd;
          this.pushUndo(step);
        }
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

  /** A row's timecode and name, after its line moved or was selected or deselected. */
  updateCardTimecode(idx) {
    const row = document.getElementById(`cue-card-${idx}`);
    const seg = this.segments[idx];
    if (!row || !seg) return;
    row.querySelector('.cue-timecode-badge').innerText = this.rowTimecode(seg, row.classList.contains('selected'));
    row.setAttribute('aria-label', this.rowLabel(seg, idx));
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

    this.pushUndo();
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
    const step = this.pushUndo();
    this.segments.splice(idx, 1);
    this.selectedSegmentIndex = null;
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.syncSegmentsToServer();
    this.showToast(`Line ${idx + 1} deleted`, { action: { label: 'Undo', onClick: () => this.undo(step) }, duration: UNDO_TOAST_MS });
  }

  markInAtPlayhead() {
    const idx = this.selectedSegmentIndex;
    const seg = this.segments[idx];
    if (!seg) {
      this.showToast('Select a line first');
      return;
    }
    const t = Math.round(this.editorVideo.currentTime * 50) / 50;
    this.pushUndo();
    seg.start = t;
    if (seg.end <= t) seg.end = Math.min(this.duration, t + 1.0);
    this.renderTimelineSegments();
    this.updateCardTimecode(idx);
    this.syncSegmentsToServer();
    this.showToast(`Start set to ${this.formatTime(t)}`);
  }

  markOutAtPlayhead() {
    const idx = this.selectedSegmentIndex;
    const seg = this.segments[idx];
    if (!seg) {
      this.showToast('Select a line first');
      return;
    }
    const t = Math.round(this.editorVideo.currentTime * 50) / 50;
    if (t > seg.start) {
      this.pushUndo();
      seg.end = t;
      this.renderTimelineSegments();
      this.updateCardTimecode(idx);
      this.syncSegmentsToServer();
      this.showToast(`End set to ${this.formatTime(t)}`);
    }
  }

  previewSegmentAudio(idx) {
    const seg = this.segments[idx];
    if (!seg) return;
    this.seekTo(seg.start);
    this.playMedia();
    this.stopAt = seg.end; // the playback loop pauses here
  }

  /**
   * Saves the lines. One PUT at a time: edits made meanwhile go in the next one, with the
   * latest lines, so an older save never lands after a newer one. A failed save says so
   * in the editor and tries again, waiting longer each time (1 s, 2 s, 4 s… up to 30 s).
   */
  syncSegmentsToServer() {
    if (!this.sessionId) return;
    this.save.wanted = true;
    if (!this.save.inFlight) this.flushSave();
  }

  async flushSave() {
    const save = this.save;
    clearTimeout(save.retryTimer);
    save.retryTimer = null;
    while (save.wanted && this.sessionId) {
      save.wanted = false;
      save.inFlight = true;
      let ok = false;
      try {
        const res = await fetch(`/api/builder/${this.sessionId}/segments`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: this.segments }),
        });
        ok = res.ok;
      } catch (e) {
        console.warn('Failed to sync segments to server:', e);
      }
      save.inFlight = false;
      if (!ok) {
        save.wanted = true;
        save.failed = true;
        save.delay = Math.min(30000, save.delay ? save.delay * 2 : 1000);
        save.retryTimer = setTimeout(() => this.flushSave(), save.delay);
        this.renderEditorNotice();
        return;
      }
      if (save.failed) {
        save.failed = false;
        save.delay = 0;
        this.renderEditorNotice();
      }
    }
  }

  /** The editor's notice: a failed save while there is one, otherwise the engine's processing notice. */
  renderEditorNotice() {
    const failed = this.save.failed;
    const text = failed ? SAVE_FAILED : this.editorWarning;
    this.editorNotice.textContent = text;
    this.editorNotice.hidden = !text;
    this.editorNotice.classList.toggle('is-error', failed);
  }

  // --- Undo ---

  /** The editor's state for undo: the lines, the cast's colours and the selected line. */
  snapshot() {
    return {
      segments: this.segments.map((s) => ({ ...s })),
      colors: Array.from(this.characterColors),
      selected: this.selectedSegmentIndex,
    };
  }

  /** Keeps the state from before a change, up to 50 steps. Returns the step, for a toast's Undo. */
  pushUndo(step = this.snapshot()) {
    this.undoStack.push(step);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    return step;
  }

  /**
   * Undoes the last change (Ctrl+Z), or every change back to and including `step` (a toast's
   * Undo, once later changes were made). Undo is rare, so the editor is drawn again in full.
   */
  undo(step = null) {
    if (step && !this.undoStack.includes(step)) return;
    let snap = this.undoStack.pop();
    while (step && snap && snap !== step) snap = this.undoStack.pop();
    if (!snap) return;
    this.segments = snap.segments;
    this.characterColors = new Map(snap.colors);
    this.selectedSegmentIndex = this.segments[snap.selected] ? snap.selected : null;
    this.textBefore = null;
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.syncSegmentsToServer();
  }

  async transcribeSingleSegment(idx, btnEl, textInputEl) {
    if (!this.sessionId || idx < 0 || idx >= this.segments.length) return;
    const seg = this.segments[idx];
    const origText = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.innerHTML = ICON_SPINNER;
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
          this.pushUndo();
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
      btnEl.innerHTML = ICON_SPINNER;
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
          this.pushUndo();
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
      this.showToast('Select a line first');
      return;
    }
    const idx = this.selectedSegmentIndex;
    const card = document.getElementById(`cue-card-${idx}`);
    const btn = card ? card.querySelector('.btn-whisper-cue') : null;
    const textInput = card ? card.querySelector('.cue-text-input') : null;
    this.transcribeSingleSegment(idx, btn, textInput);
  }

  // --- STEP 4: Compile & Launch ---

  /** Build. The Pack details are filled in once per session, so going back and forth keeps your edits. Returns whether it opened. */
  goToCompileStep(opts = {}) {
    if (this.segments.length === 0) {
      this.showToast('Add a line first.');
      return false;
    }

    this.setStep('compile', opts);
    this.pauseMedia();

    if (!this.compileFilled) {
      this.compileFilled = true;
      const savedUser = localStorage.getItem('dubmate_user_name') || '';
      this.compilePackName.value = this.inputPackTitle.value || this.selectedVideoName.textContent.replace(/\.[^/.]+$/, '');
      this.compileAuthor.value = savedUser || 'Creator';
      this.compileSubtitle.value = `${this.segments.length} lines, ${this.characterColors.size} characters`;
    }

    this.statValDuration.innerText = this.formatTime(this.duration);
    this.statValLines.innerText = this.segments.length;
    this.statValCast.innerText = this.characterColors.size;
    this.updateBuildState();
    return true;
  }

  /** What a build is made of: the lines and the Pack details. */
  buildSignature() {
    return JSON.stringify([this.segments, this.compilePackName.value.trim(), this.compileAuthor.value.trim(), this.compileSubtitle.value.trim()]);
  }

  /** The pack was built from exactly what is here now. */
  isBuiltCurrent() {
    return !!this.builtSignature && this.builtSignature === this.buildSignature();
  }

  /** Build shows Build pack until a build, Pack ready while nothing changed since, and Build again after a change. */
  updateBuildState() {
    if (this.compiling) return;
    const built = !!this.builtSignature;
    const current = built && this.isBuiltCurrent();
    this.btnExecuteCompile.style.display = built ? 'none' : 'block';
    this.compileSuccessBox.style.display = current ? 'block' : 'none';
    this.compileStaleBox.hidden = !built || current;
  }

  async executePackCompilation() {
    const packName = this.compilePackName.value.trim() || 'Custom Dub Scene';
    const authors = [this.compileAuthor.value.trim() || 'Creator'];
    const subtitle = this.compileSubtitle.value.trim();
    const signature = this.buildSignature();

    this.compiling = true;
    this.btnExecuteCompile.style.display = 'none';
    this.compileSuccessBox.style.display = 'none';
    this.compileStaleBox.hidden = true;
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

      // Pack ready: recording is the next step, so it takes the focus.
      this.builtSignature = signature;
      this.compiling = false;
      this.compileProgressBox.style.display = 'none';
      this.updateBuildState();
      this.btnPlaytestNow.focus();
    } catch (ex) {
      this.compiling = false;
      this.compileProgressBox.style.display = 'none';
      this.updateBuildState();
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

  // The menu's Studio link leaves Pack Builder too, so it asks the same way as Exit.
  initModeDropdown() {
    initModeDropdown({
      onStudioClick: (e, closeMenu) => {
        if (!this.mustAskBeforeLeaving()) return;
        e.preventDefault();
        closeMenu();
        this.openLeaveDialog(e.currentTarget.href);
      },
    });
  }

  showToast(message, opts) { showToast(message, opts); }
}

// Instantiate Pack Builder Studio
document.addEventListener('DOMContentLoaded', () => {
  new PackBuilderApp();
});
