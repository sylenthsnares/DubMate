// app.js - High-Performance Studio Controller with Bulletproof Lifecycle, Non-Blocking Screening & Fast DSP
import { AudioEngine } from './audio_engine.js';
import { WaveformRenderer } from './waveform.js';
import { RoomSocket } from './room_socket.js';
import { initAllKnobs } from './knob.js';
import { escapeHtml, showToast, initModeDropdown, mixin } from './ui_common.js';
import { AudioSetupMethods } from './studio/audio_setup.js';
import { ExportMethods } from './studio/export.js';
import { ScreeningMethods } from './studio/screening.js';

// Public room registry (Cloudflare worker) used to resolve rooms hosted elsewhere.
const REGISTRY_BASE = 'https://dubmate.bkaproductions.com';

// Joining a room hosted elsewhere moves the whole page onto the host's tunnel,
// so every relative URL (/api/packs, "/", "/builder.html") then reaches the
// host's engine. The member's own engine (the desktop app's loopback origin)
// travels along as ?home= and is kept here, per origin, so leaving the room
// can navigate back to it.
const HOME_ORIGIN_KEY = 'dubmate_home_origin';

/** True only for a bare loopback http origin such as http://127.0.0.1:8123. */
function isLoopbackOrigin(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:'
      && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
      && u.origin === value;
  } catch (e) {
    return false;
  }
}

/** The member's own engine origin, or null when there is none (browser-only guest). */
function getHomeOrigin() {
  if (isLoopbackOrigin(window.location.origin)) return window.location.origin;
  let saved = null;
  try { saved = sessionStorage.getItem(HOME_ORIGIN_KEY); } catch (e) { }
  return isLoopbackOrigin(saved) ? saved : null;
}

/** Remembers ?home= (when valid) and drops it from the address bar. */
function captureHomeOriginParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('home')) return;
  const home = url.searchParams.get('home');
  if (isLoopbackOrigin(home)) {
    try { sessionStorage.setItem(HOME_ORIGIN_KEY, home); } catch (e) { }
  }
  url.searchParams.delete('home');
  window.history.replaceState(window.history.state, '', url);
}

class DubMateApp {
  constructor() {
    this.audio = new AudioEngine();
    this.initAudioSetupState();
    this.socket = new RoomSocket();
    this.waveform = null;
    this.knobs = [];

    // App State
    this.user = this.loadUser();
    this.packs = [];
    this.selectedPackId = null;
    this.packSearchQuery = '';
    this.roomState = null;
    this.currentLineIndex = 0;
    this.currentTakeBuffer = null;
    this.backingBuffer = null;
    this.backingBufferUrl = null;
    this.origBuffer = null;

    // Countdown & Recording Mutex
    this.recordState = 'idle'; // 'idle' | 'countdown' | 'recording' | 'processing'
    this.countdownSessionId = 0;
    this.recordingTimeout = null;
    this.filterMyLinesOnly = true;

    // Screening & Premiere State
    this.screeningBuffers = new Map();
    this.isPreloadingScreening = false;
    this.isReadyForScreening = false;

    // Noise Reduction & Mic Profile Calibration State
    this.applyNoiseReduction = localStorage.getItem('dubmate_noise_reduction') !== 'false';
    this.isCalibratingMic = false;
    this.hasCustomNoiseProfile = false;
    this.pendingJoinRoomId = null;

    // Public registry status for the current room, refreshed while it publishes.
    this.roomShare = null;
    this.shareWatchTimer = null;

    this.initDOM();
    this.initEvents();
    this.initRouter();
    window.dubMateApp = this;
  }

  // Per-room state that must not leak from one room into the next. Called by
  // leaveRoom() and at the start of joinRoom().
  resetRoomSession() {
    this.stopShareWatch();
    this.roomShare = null;
    this.roomState = null;
    this.currentLineIndex = 0;
    this.currentTakeBuffer = null;
    this.backingBuffer = null;
    this.backingBufferUrl = null;
    this.origBuffer = null;
    // Drop any line-audio load still in flight for the previous room.
    this.loadLineSeq = (this.loadLineSeq || 0) + 1;
    if (this.screeningBuffers) {
      this.screeningBuffers.clear();
    }
  }

  loadUser() {
    const saved = localStorage.getItem('dubmate_user');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) { }
    }
    const randomId = 'u_' + Math.random().toString(36).substring(2, 9);
    return {
      id: randomId,
      name: 'Actor ' + Math.floor(Math.random() * 900 + 100),
      color: '#d97706',
    };
  }

  saveUser() {
    localStorage.setItem('dubmate_user', JSON.stringify(this.user));
  }

  updateUserUI() {
    if (this.inputUserName && document.activeElement !== this.inputUserName) {
      this.inputUserName.value = this.user.name || '';
    }
    const displayName = (this.user.name || '').trim() || 'Actor';
    if (this.headerUserName) {
      this.headerUserName.innerText = displayName;
    }
    if (this.headerUserAvatar) {
      const initial = displayName.charAt(0).toUpperCase() || 'A';
      this.headerUserAvatar.innerText = initial;
      this.headerUserAvatar.style.backgroundColor = this.user.color || '#d97706';
    }
    if (this.colorPalette) {
      this.colorPalette.querySelectorAll('.color-option').forEach((opt) => {
        const isMatch = opt.dataset.color === this.user.color;
        opt.classList.toggle('selected', isMatch);
        opt.setAttribute('aria-checked', isMatch ? 'true' : 'false');
      });
    }
  }

  initDOM() {
    // Views
    this.views = {
      landing: document.getElementById('view-landing'),
      lobby: document.getElementById('view-lobby'),
      booth: document.getElementById('view-booth'),
      screening: document.getElementById('view-screening'),
    };

    // Header & Studio Breadcrumbs
    this.headerRoomBadge = document.getElementById('header-room-badge');
    this.headerRoomCode = document.getElementById('header-room-code');
    this.headerUserPill = document.getElementById('header-user-pill');
    this.headerUserAvatar = document.getElementById('header-user-avatar');
    this.headerUserName = document.getElementById('header-user-name');
    this.btnLeaveRoom = document.getElementById('btn-leave-room');
    this.btnAudioSettings = document.getElementById('btn-audio-settings');
    this.audioSettingsAlertDot = document.getElementById('audio-settings-alert-dot');
    this.studioBreadcrumbs = document.getElementById('studio-breadcrumbs');
    this.navStepLobby = document.getElementById('nav-step-lobby');
    this.navStepBooth = document.getElementById('nav-step-booth');
    this.navStepScreening = document.getElementById('nav-step-screening');
    this.crumbPremiereLive = document.getElementById('crumb-premiere-live');

    // Cast Activity HUD Ribbon
    this.castActivityBar = document.getElementById('cast-activity-bar');
    this.castActivityList = document.getElementById('cast-activity-list');
    this.premiereStatusSummary = document.getElementById('premiere-status-summary');

    // Landing inputs
    this.inputUserName = document.getElementById('input-user-name');
    this.colorPalette = document.getElementById('color-palette');
    this.packGrid = document.getElementById('pack-grid');
    this.packCountBadge = document.getElementById('pack-count-badge');
    this.inputPackSearch = document.getElementById('input-pack-search');
    this.btnClearSearch = document.getElementById('btn-clear-search');
    this.btnRescanPacks = document.getElementById('btn-rescan-packs');
    this.btnImportPack = document.getElementById('btn-import-pack');
    this.inputPackZip = document.getElementById('input-pack-zip');
    this.packDropzone = document.getElementById('pack-dropzone');
    this.btnOpenPackFolder = document.getElementById('btn-open-pack-folder');
    this.modalPackConfig = document.getElementById('modal-pack-config');
    this.webInputPackPath = document.getElementById('web-input-pack-path');
    this.webConfigFeedback = document.getElementById('web-config-feedback');
    this.btnSavePackConfig = document.getElementById('btn-save-pack-config');
    this.btnClosePackConfig = document.getElementById('btn-close-pack-config');
    this.webConfigActiveCount = document.getElementById('web-config-active-count');
    this.btnCreateRoom = document.getElementById('btn-create-room');
    this.btnJoinRoom = document.getElementById('btn-join-room');
    this.inputRoomCode = document.getElementById('input-room-code');

    // Lobby elements
    this.lobbyPackTitle = document.getElementById('lobby-pack-title');
    this.lobbyLineCount = document.getElementById('lobby-line-count');
    this.castingTbody = document.getElementById('casting-tbody');
    this.lobbyCastList = document.getElementById('lobby-cast-list');
    this.castOnlineCount = document.getElementById('cast-online-count');
    this.btnStartSession = document.getElementById('btn-start-session');
    this.btnCopyInvite = document.getElementById('btn-copy-invite');
    this.modeCardBooth = document.getElementById('mode-card-booth');
    this.modeCardStudio = document.getElementById('mode-card-studio');

    // Stage / Booth elements
    this.stageVideo = document.getElementById('stage-video');
    this.stageVideo.muted = true; // Permanent mute prevents double-audio bleed
    this.stageVideo.volume = 0;

    this.videoOverlay = document.getElementById('video-overlay');
    this.overlayCountdown = document.getElementById('overlay-countdown');
    this.overlayStatusText = document.getElementById('overlay-status-text');
    this.boothLineIndicator = document.getElementById('booth-line-indicator');
    this.boothTimeBadge = document.getElementById('booth-time-badge');
    this.stageCaptionCard = document.getElementById('stage-caption-card');
    this.prompterResizeHandle = document.getElementById('prompter-resize-handle');
    this.stageCaptionChar = document.getElementById('stage-caption-char');
    this.stageCaptionText = document.getElementById('stage-caption-text');
    this.timelineChips = document.getElementById('timeline-chips');

    // Premiere & Filter Controls in Booth
    this.btnToggleReady = document.getElementById('btn-toggle-ready');
    this.labelReadyState = document.getElementById('label-ready-state');
    this.btnLaunchPremiere = document.getElementById('btn-launch-premiere');
    this.btnToggleFilterLines = document.getElementById('btn-toggle-filter-lines');
    this.labelFilterLines = document.getElementById('label-filter-lines');

    // Monitoring & A/B Controls
    this.sliderBackingVol = document.getElementById('slider-backing-vol');
    this.valBackingVol = document.getElementById('val-backing-vol');
    this.checkMetronome = document.getElementById('check-metronome');
    this.checkGuideVoice = document.getElementById('check-guide-voice');
    this.btnToggleAB = document.getElementById('btn-toggle-ab');
    this.labelABState = document.getElementById('label-ab-state');

    // Audio & FX Controls
    this.btnRecordMain = document.getElementById('btn-record-main');
    this.recordIcon = document.getElementById('record-icon');
    this.recordStatusLabel = document.getElementById('record-status-label');
    this.btnPlayOrig = document.getElementById('btn-play-orig');
    this.btnPreviewTake = document.getElementById('btn-preview-take');
    this.sliderNudge = document.getElementById('slider-nudge');
    this.nudgeDisplay = document.getElementById('nudge-display');
    this.sliderPitch = document.getElementById('slider-pitch');
    this.valPitch = document.getElementById('val-pitch');
    this.sliderReverb = document.getElementById('slider-reverb');
    this.valReverb = document.getElementById('val-reverb');
    this.sliderGain = document.getElementById('slider-gain');
    this.valGain = document.getElementById('val-gain');

    // Advanced Vocal Rack Elements
    this.btnToggleAdvancedRack = document.getElementById('btn-toggle-advanced-rack');
    this.advancedVocalRack = document.getElementById('advanced-vocal-rack');
    this.checkLowcut = document.getElementById('check-lowcut');
    this.checkCompressor = document.getElementById('check-compressor');
    this.sliderDecay = document.getElementById('slider-decay');
    this.valDecay = document.getElementById('val-decay');
    this.sliderPredelay = document.getElementById('slider-predelay');
    this.valPredelay = document.getElementById('val-predelay');

    // Studio Noise Reduction & Mic Profile Calibration Elements
    this.checkLobbyNoiseReduction = document.getElementById('check-lobby-noise-reduction');
    this.checkNoiseReduction = document.getElementById('check-noise-reduction');
    this.checkRackNoiseReduction = document.getElementById('check-rack-noise-reduction');
    this.btnCalibrateMic = document.getElementById('btn-calibrate-mic');
    this.calibrateIcon = document.getElementById('calibrate-icon');
    this.calibrateLabel = document.getElementById('calibrate-label');
    this.btnResetNoiseProfile = document.getElementById('btn-reset-noise-profile');
    this.badgeNoiseStatus = document.getElementById('badge-noise-status');
    this.boothProcessingTitle = document.getElementById('booth-processing-title');
    this.boothProcessingSub = document.getElementById('booth-processing-sub');

    // Mic Calibration Modal Elements
    this.modalMicCalibration = document.getElementById('modal-mic-calibration');
    this.calibModalBadge = document.getElementById('calib-modal-badge');
    this.calibModalTitle = document.getElementById('calib-modal-title');
    this.calibModalStatus = document.getElementById('calib-modal-status');
    this.calibTimerText = document.getElementById('calib-timer-text');
    this.calibPhaseText = document.getElementById('calib-phase-text');
    this.calibProgressBar = document.getElementById('calib-progress-bar');
    this.calibModalIcon = document.getElementById('calib-modal-icon');
    this.calibRadarRing = document.getElementById('calib-radar-ring');
    this.btnCancelCalibration = document.getElementById('btn-cancel-calibration');

    // Audio Device Setup Panel Elements
    this.modalAudioSettings = document.getElementById('modal-audio-settings');
    this.btnCloseAudioSettings = document.getElementById('btn-close-audio-settings');
    this.audioSetupStatusPill = document.getElementById('audio-setup-status-pill');
    this.audioSetupSubtitle = document.getElementById('audio-setup-subtitle');
    this.audioStepIntro = document.getElementById('audio-setup-step-intro');
    this.audioStepDenied = document.getElementById('audio-setup-step-denied');
    this.audioStepDevices = document.getElementById('audio-setup-step-devices');
    this.btnGrantMic = document.getElementById('btn-grant-mic');
    this.btnGrantMicText = document.getElementById('btn-grant-mic-text');
    this.btnSkipAudioSetup = document.getElementById('btn-skip-audio-setup');
    this.btnRetryMic = document.getElementById('btn-retry-mic');
    this.btnDismissAudioDenied = document.getElementById('btn-dismiss-audio-denied');
    this.audioDeniedHeading = document.getElementById('audio-denied-heading');
    this.audioDeniedDetail = document.getElementById('audio-denied-detail');
    this.selectAudioInput = document.getElementById('select-audio-input');
    this.selectAudioOutput = document.getElementById('select-audio-output');
    this.audioInputNote = document.getElementById('audio-input-note');
    this.audioOutputNote = document.getElementById('audio-output-note');
    this.audioOutputRow = document.getElementById('audio-output-row');
    this.audioOutputUnsupported = document.getElementById('audio-output-unsupported');
    this.btnRefreshAudioDevices = document.getElementById('btn-refresh-audio-devices');
    this.btnAudioSettingsDone = document.getElementById('btn-audio-settings-done');
    this.levelMeterMask = document.getElementById('level-meter-mask');
    this.levelMeterPeakTick = document.getElementById('level-meter-peak-tick');
    this.levelMeterTrack = document.getElementById('level-meter-track');
    this.levelMeterRms = document.getElementById('level-meter-rms');
    this.levelMeterPeakReadout = document.getElementById('level-meter-peak-readout');
    this.levelMeterLamp = document.getElementById('level-meter-lamp');
    this.levelMeterHint = document.getElementById('level-meter-hint');
    this.audioExportsRow = document.getElementById('audio-exports-row');
    this.inputExportsDir = document.getElementById('input-exports-dir');
    this.btnSaveExportsDir = document.getElementById('btn-save-exports-dir');
    this.btnSaveExportsDirText = document.getElementById('btn-save-exports-dir-text');
    this.exportsDirFeedback = document.getElementById('exports-dir-feedback');

    // Navigation buttons
    this.btnPrevLine = document.getElementById('btn-prev-line');
    this.btnNextLine = document.getElementById('btn-next-line');
    this.btnClearTake = document.getElementById('btn-clear-take');
    this.btnJumpScreening = document.getElementById('btn-jump-screening');
    this.btnBackLobby = document.getElementById('btn-back-lobby');

    // Screening elements
    this.screeningVideo = document.getElementById('screening-video');
    this.screeningVideo.muted = true;
    this.screeningVideo.volume = 0;

    this.screeningHostBadge = document.getElementById('screening-host-badge');
    this.screeningMasterBadge = document.getElementById('screening-master-badge');
    this.screeningStatusDesc = document.getElementById('screening-status-desc');
    this.btnScreeningPlayPause = document.getElementById('btn-screening-play-pause');
    this.screeningPlayIcon = document.getElementById('screening-play-icon');
    this.btnScreeningReplay = document.getElementById('btn-screening-replay');
    this.btnExportVideo = document.getElementById('btn-export-video');
    this.btnBackBooth = document.getElementById('btn-back-booth');
    this.exportProgressBox = document.getElementById('export-progress-box');
    this.exportProgressFill = document.getElementById('export-progress-fill');
    this.exportStatusText = document.getElementById('export-status-text');
    this.exportDownloadContainer = document.getElementById('export-download-container');
    this.btnDownloadLink = document.getElementById('btn-download-link');
    this.btnDownloadLink916 = document.getElementById('btn-download-link-9-16');
    this.btnDownloadProjectZip = document.getElementById('btn-download-project-zip');
    this.btnToolbarProjectZip = document.getElementById('btn-toolbar-project-zip');
    this.btnAspect169 = document.getElementById('btn-aspect-16-9');
    this.btnAspect916 = document.getElementById('btn-aspect-9-16');
    this.selectedAspectRatio = '16:9';

    // Screening Master Audio Stem Mixer Elements
    this.sliderScreeningBalance = document.getElementById('slider-screening-balance');
    this.valScreeningBalance = document.getElementById('val-screening-balance');
    this.screeningBalance = 50; // 0 = Music Dominant, 50 = Balanced, 100 = Vocals Dominant
    this.screeningBackingGainNode = null;
    this.screeningVocalGainNode = null;
    this.isUsingExportedVideo = false;

    // Smart Dialogue Loudness & Prominence Controls
    this.btnAutoMatchGain = document.getElementById('btn-auto-match-gain');
    this.badgeGainMatch = document.getElementById('badge-gain-match');
    this.sliderDialoguePresence = document.getElementById('slider-dialogue-presence');
    this.valDialoguePresence = document.getElementById('val-dialogue-presence');
    this.masterDialoguePresence = 0.0;
    this.screeningSyncRafId = null;

    // Export Step Indicators
    this.stepDsp = document.getElementById('step-dsp');
    this.stepMux = document.getElementById('step-mux');
    this.stepReady = document.getElementById('step-ready');

    // Master Export Modal Elements
    this.modalExportRendering = document.getElementById('modal-export-rendering');
    this.exportModalBadge = document.getElementById('export-modal-badge');
    this.exportModalTitle = document.getElementById('export-modal-title');
    this.exportModalStatusText = document.getElementById('export-modal-status-text');
    this.exportModalProgressBar = document.getElementById('export-modal-progress-bar');
    this.modalStepDsp = document.getElementById('modal-step-dsp');
    this.modalStepMux = document.getElementById('modal-step-mux');
    this.modalStepReady = document.getElementById('modal-step-ready');
    this.connectorDspMux = document.getElementById('connector-dsp-mux');
    this.connectorMuxReady = document.getElementById('connector-mux-ready');
    this.exportModalReassurance = document.getElementById('export-modal-reassurance');
    this.exportModalActions = document.getElementById('export-modal-actions');
    this.btnModalCloseView = document.getElementById('btn-modal-close-view');
    this.btnModalCloseX = document.getElementById('btn-modal-close-x');
    this.btnModalDismiss = document.getElementById('btn-modal-dismiss');
    this.btnModalDownload169 = document.getElementById('btn-modal-download-169');
    this.btnModalDownload916 = document.getElementById('btn-modal-download-916');
    this.exportSavedPath = document.getElementById('export-saved-path');

    // Booth & Import Loading Overlays
    this.boothProcessingOverlay = document.getElementById('booth-processing-overlay');
    this.modalImportLoading = document.getElementById('modal-import-loading');

    // Global Interaction Lock Flags
    this.isRenderingExport = false;
    this.isProcessingTake = false;
    // setInterval id of exportFinalVideo's status poll, so export_failed can stop it.
    this.exportPollInterval = null;

    // Waveform canvas with real-time drag callbacks
    const canvas = document.getElementById('waveform-canvas');
    this.waveform = new WaveformRenderer(canvas, {
      onOffsetChange: (offsetMs) => {
        this.setNudgeValue(offsetMs, false);
      },
      onOffsetCommit: (offsetMs) => {
        this.syncTakeParams();
      },
    });

    // Initialize Analog Guitar Amp Knobs
    this.knobs = initAllKnobs();

    this.inputUserName.value = this.user.name;
    this.updateUserUI();
  }

  /** Toggle expand/collapse on booth and theater video containers */
  initVideoExpand() {
    const pairs = [
      { btnId: 'btn-expand-video', selector: '.stage-main-col .video-container' },
      { btnId: 'btn-expand-theater-video', selector: '.theater-player' },
    ];
    pairs.forEach(({ btnId, selector }) => {
      const btn = document.getElementById(btnId);
      const el = document.querySelector(selector);
      if (!btn || !el) return;
      btn.addEventListener('click', () => {
        el.classList.toggle('video-expanded');
        const expanded = el.classList.contains('video-expanded');
        btn.setAttribute('aria-pressed', String(expanded));
        btn.setAttribute('aria-label',
          expanded ? 'Collapse Video Monitor' : 'Expand Video Monitor');
        // Update icon to collapse arrows when expanded
        btn.innerHTML = expanded
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5"/></svg>`
          : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
      });
    });
  }

  initEvents() {
    this.initVideoPrompterSplitter();
    this.initVideoExpand();
    this.initModeDropdown();
    this.initJoinModal();

    const btnLeaveRoom = document.getElementById('btn-leave-room');
    if (btnLeaveRoom) {
      btnLeaveRoom.addEventListener('click', () => this.confirmLeaveRoom());
    }

    const btnLeaveRoomLobby = document.getElementById('btn-leave-room-lobby');
    if (btnLeaveRoomLobby) {
      btnLeaveRoomLobby.addEventListener('click', () => this.confirmLeaveRoom());
    }

    this.inputUserName.addEventListener('input', (e) => {
      this.user.name = e.target.value;
      this.saveUser();
      this.updateUserUI();
    });

    this.inputUserName.addEventListener('focus', () => {
      if (/^Actor\s+\d+$/i.test((this.inputUserName.value || '').trim())) {
        this.inputUserName.select();
      }
    });

    this.inputUserName.addEventListener('blur', () => {
      if (!this.user.name || !this.user.name.trim()) {
        this.user.name = 'Actor ' + Math.floor(Math.random() * 900 + 100);
        this.inputUserName.value = this.user.name;
        this.saveUser();
        this.updateUserUI();
      }
    });

    this.colorPalette.querySelectorAll('.color-option').forEach((opt) => {
      opt.addEventListener('click', () => {
        this.colorPalette.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        this.user.color = opt.dataset.color;
        this.saveUser();
        this.updateUserUI();
      });
    });

    // Landing Tabs
    const tabCreate = document.getElementById('tab-btn-create');
    const tabJoin = document.getElementById('tab-btn-join');
    const panelCreate = document.getElementById('panel-create-room');
    const panelJoin = document.getElementById('panel-join-room');

    tabCreate.addEventListener('click', () => {
      tabCreate.classList.add('active');
      tabCreate.setAttribute('aria-selected', 'true');
      tabJoin.classList.remove('active');
      tabJoin.setAttribute('aria-selected', 'false');
      panelCreate.style.display = 'block';
      panelJoin.style.display = 'none';
    });

    tabJoin.addEventListener('click', () => {
      tabJoin.classList.add('active');
      tabJoin.setAttribute('aria-selected', 'true');
      tabCreate.classList.remove('active');
      tabCreate.setAttribute('aria-selected', 'false');
      panelCreate.style.display = 'none';
      panelJoin.style.display = 'block';
    });

    this.btnCreateRoom.addEventListener('click', () => this.createRoom());
    this.btnJoinRoom.addEventListener('click', () => this.joinRoomFromInput());
    if (this.btnRescanPacks) {
      this.btnRescanPacks.addEventListener('click', () => this.rescanPacksDirectory());
    }

    if (this.btnImportPack && this.inputPackZip) {
      this.btnImportPack.addEventListener('click', () => {
        this.inputPackZip.click();
      });
      this.inputPackZip.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) {
          this.uploadPackZip(file);
        }
      });
    }

    if (this.btnOpenPackFolder) {
      this.btnOpenPackFolder.addEventListener('click', () => this.openPackConfigModal());
    }
    if (this.btnClosePackConfig) {
      this.btnClosePackConfig.addEventListener('click', () => this.closePackConfigModal());
    }
    if (this.btnSavePackConfig) {
      this.btnSavePackConfig.addEventListener('click', () => this.savePackConfig());
    }
    if (this.modalPackConfig) {
      this.modalPackConfig.addEventListener('click', (e) => {
        if (e.target === this.modalPackConfig) this.closePackConfigModal();
      });
    }
    if (this.webInputPackPath) {
      this.webInputPackPath.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.savePackConfig();
      });
    }

    const packPanel = document.querySelector('.panel-pack-selector');
    if (packPanel && this.packDropzone) {
      let dragCounter = 0;

      packPanel.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        this.packDropzone.style.display = 'flex';
      });

      packPanel.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });

      packPanel.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          this.packDropzone.style.display = 'none';
        }
      });

      packPanel.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        this.packDropzone.style.display = 'none';
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          this.uploadPackZip(file);
        }
      });
    }

    if (this.inputPackSearch) {
      this.inputPackSearch.addEventListener('input', (e) => {
        this.handlePackSearch(e.target.value);
      });
      this.inputPackSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.clearPackSearch();
        }
      });
    }

    if (this.btnClearSearch) {
      this.btnClearSearch.addEventListener('click', () => {
        this.clearPackSearch();
      });
    }

    // Global shortcut '/' to quickly focus the scene pack search bar
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        if (this.inputPackSearch && this.views.landing?.classList.contains('active')) {
          e.preventDefault();
          this.inputPackSearch.focus();
          this.inputPackSearch.select();
        }
      }
    });

    this.btnCopyInvite.addEventListener('click', () => this.copyRoomLink());
    this.headerRoomBadge.addEventListener('click', () => this.copyRoomLink());

    // Mode Selector
    this.modeCardBooth.addEventListener('click', () => {
      this.modeCardBooth.classList.add('selected');
      this.modeCardStudio.classList.remove('selected');
      this.socket.setMode('booth');
    });

    this.modeCardStudio.addEventListener('click', () => {
      this.modeCardStudio.classList.add('selected');
      this.modeCardBooth.classList.remove('selected');
      this.socket.setMode('studio');
    });

    this.btnStartSession.addEventListener('click', () => {
      this.socket.setStatus('recording');
      this.showView('booth');
      this.loadBoothLine(this.findFirstAssignedLine());
    });

    // Studio Breadcrumbs Navigation
    if (this.navStepLobby) {
      this.navStepLobby.addEventListener('click', () => {
        this.cancelCurrentCountdown();
        this.showView('lobby');
        this.broadcastMyStatus('lobby');
      });
    }

    if (this.navStepBooth) {
      this.navStepBooth.addEventListener('click', () => {
        this.cancelCurrentCountdown();
        this.showView('booth');
        this.loadBoothLine(this.currentLineIndex);
        this.broadcastMyStatus('booth');
      });
    }

    if (this.navStepScreening) {
      this.navStepScreening.addEventListener('click', () => {
        this.cancelCurrentCountdown();
        this.showView('screening');
        this.setupScreeningView();
        this.broadcastMyStatus('screening');
      });
    }

    this.btnBackLobby.addEventListener('click', () => {
      this.cancelCurrentCountdown();
      this.showView('lobby');
      this.broadcastMyStatus('lobby');
    });

    this.btnJumpScreening.addEventListener('click', () => {
      this.cancelCurrentCountdown();
      this.showView('screening');
      this.setupScreeningView();
      this.broadcastMyStatus('screening');
    });

    this.btnBackBooth.addEventListener('click', () => {
      this.showView('booth');
      this.loadBoothLine(this.currentLineIndex);
      this.broadcastMyStatus('booth');
    });

    // Premiere Readiness & Filter Events
    this.btnToggleReady.addEventListener('click', () => this.toggleMyReadiness());
    this.btnLaunchPremiere.addEventListener('click', () => this.launchGroupPremiere());
    this.btnToggleFilterLines.addEventListener('click', () => this.toggleFilterLines());

    // Record & Playback Controls
    this.btnRecordMain.addEventListener('click', () => this.toggleRecording());
    this.btnPlayOrig.addEventListener('click', () => this.playOriginalReference());
    this.btnPreviewTake.addEventListener('click', () => this.previewCurrentTake());

    this.sliderBackingVol.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.valBackingVol.innerText = `${val}%`;
      this.audio.backingVolume = val / 100.0;
    });

    this.checkMetronome.addEventListener('change', (e) => {
      this.audio.metronomeEnabled = e.target.checked;
      const tag = document.getElementById('tag-metronome');
      if (tag) tag.innerText = e.target.checked ? 'ACTIVE' : 'MUTED';
    });

    if (this.checkGuideVoice) {
      this.checkGuideVoice.addEventListener('change', (e) => {
        const tag = document.getElementById('tag-guide-voice');
        if (tag) tag.innerText = e.target.checked ? 'ACTIVE' : 'MUTED';
      });
    }

    this.btnToggleAB.addEventListener('click', () => this.toggleABState());

    this.sliderNudge.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.setNudgeValue(val, true);
    });

    document.querySelectorAll('.btn-nudge').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.nudge;
        if (val === 'reset') {
          this.setNudgeValue(0, true);
        } else {
          const current = parseInt(this.sliderNudge.value, 10);
          this.setNudgeValue(current + parseInt(val, 10), true);
        }
      });
    });

    this.sliderPitch.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.valPitch.innerText = (val > 0 ? '+' : '') + val + ' st';
      this.syncTakeParams();
    });

    this.sliderReverb.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      this.valReverb.innerText = val + '%';
      this.syncTakeParams();
    });

    this.sliderGain.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.valGain.innerText = (val > 0 ? '+' : '') + val + ' dB';
      const take = this.roomState?.takes?.[this.currentLineIndex];
      if (take && take.auto_gain_db !== undefined) this.renderGainMatchBadge(take, val);
      this.syncTakeParams();
    });

    if (this.btnAutoMatchGain) {
      this.btnAutoMatchGain.addEventListener('click', () => {
        const take = this.roomState?.takes?.[this.currentLineIndex];
        if (take && take.auto_gain_db !== undefined) {
          const targetGain = parseFloat(take.auto_gain_db);
          this.sliderGain.value = targetGain;
          this.valGain.innerText = (targetGain > 0 ? '+' : '') + targetGain + ' dB';
          this.audio.setGain(targetGain);
          this.syncTakeParams();
          this.renderGainMatchBadge(take, targetGain);
          this.showToast(`Vocal gain calibrated to scene dialogue target (${targetGain >= 0 ? '+' : ''}${targetGain} dB)`);
        }
      });
    }

    // Advanced Vocal Rack
    this.btnToggleAdvancedRack.addEventListener('click', () => {
      const controlsPanel = document.getElementById('booth-controls-panel') || document.querySelector('.booth-controls');
      const isOpen = this.advancedVocalRack.classList.contains('open');
      if (isOpen) {
        this.advancedVocalRack.classList.remove('open');
        controlsPanel?.classList.remove('fx-expanded');
        this.btnToggleAdvancedRack.setAttribute('aria-expanded', 'false');
        this.btnToggleAdvancedRack.innerText = 'Advanced ▾';
      } else {
        this.advancedVocalRack.classList.add('open');
        controlsPanel?.classList.add('fx-expanded');
        this.btnToggleAdvancedRack.setAttribute('aria-expanded', 'true');
        this.btnToggleAdvancedRack.innerText = 'Advanced ▴';
      }
    });

    this.checkLowcut.addEventListener('change', () => this.syncTakeParams());
    this.checkCompressor.addEventListener('change', () => this.syncTakeParams());

    this.sliderDecay.addEventListener('input', (e) => {
      const decay = parseFloat(e.target.value);
      this.valDecay.innerText = decay.toFixed(1) + 's';
      const predelay = parseFloat(this.sliderPredelay.value);
      this.audio.updateReverbImpulse(decay, 0.5, predelay);
      this.syncTakeParams();
    });

    this.sliderPredelay.addEventListener('input', (e) => {
      const predelay = parseFloat(e.target.value);
      this.valPredelay.innerText = Math.round(predelay) + 'ms';
      const decay = parseFloat(this.sliderDecay.value);
      this.audio.updateReverbImpulse(decay, 0.5, predelay);
      this.syncTakeParams();
    });

    this.btnPrevLine.addEventListener('click', () => this.stepLine(-1));
    this.btnNextLine.addEventListener('click', () => this.stepLine(1));
    this.btnClearTake.addEventListener('click', () => this.clearCurrentTake());

    // Studio Noise Reduction Synchronization & Calibration Listeners
    const onNoiseToggleChange = (e) => {
      this.setNoiseReduction(e.target.checked);
    };

    if (this.checkLobbyNoiseReduction) {
      this.checkLobbyNoiseReduction.checked = this.applyNoiseReduction;
      this.checkLobbyNoiseReduction.addEventListener('change', onNoiseToggleChange);
    }
    if (this.checkNoiseReduction) {
      this.checkNoiseReduction.checked = this.applyNoiseReduction;
      this.checkNoiseReduction.addEventListener('change', (e) => {
        const tag = document.getElementById('tag-noise-cleaner');
        if (tag) tag.innerText = e.target.checked ? 'DFN3' : 'OFF';
        this.syncTakeParams();
        onNoiseToggleChange(e);
      });
    }
    if (this.checkRackNoiseReduction) {
      this.checkRackNoiseReduction.checked = this.applyNoiseReduction;
      this.checkRackNoiseReduction.addEventListener('change', onNoiseToggleChange);
    }

    if (this.btnCalibrateMic) {
      this.btnCalibrateMic.addEventListener('click', () => this.calibrateMicNoiseProfile());
    }
    if (this.btnResetNoiseProfile) {
      this.btnResetNoiseProfile.addEventListener('click', () => this.resetMicNoiseProfile());
    }
    if (this.btnCancelCalibration) {
      this.btnCancelCalibration.addEventListener('click', () => this.cancelMicNoiseCalibration());
    }

    this.initAudioSettingsEvents();

    // Studio & Screening Keyboard Shortcuts
    // Booth: Space (Record), [ / ] (Micro-Nudge ±25ms/±100ms)
    // Screening: Space (Play/Pause), KeyR (Replay / Seek to 0:00)
    window.addEventListener('keydown', (e) => {
      // Escape key closes modals if they are open and not actively rendering
      if (e.key === 'Escape') {
        if (this.isAudioSettingsOpen()) {
          this.closeAudioSettings();
          return;
        }
        if (this.modalMicCalibration && this.modalMicCalibration.style.display !== 'none') {
          this.cancelMicNoiseCalibration();
          return;
        }
        if (this.modalExportRendering && this.modalExportRendering.style.display !== 'none' && !this.isRenderingExport) {
          this.closeExportModal();
          return;
        }
      }

      // Ignore shortcut triggers when locked or when user is focused in text/input fields
      if (this.isProcessingTake || this.isRenderingExport) {
        return;
      }

      // Never let booth/screening transport shortcuts fire behind the modal
      // audio settings panel (Space would otherwise start a recording).
      if (this.isAudioSettingsOpen()) {
        return;
      }

      if (
        e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.tagName === 'SELECT' ||
        e.target.isContentEditable
      ) {
        return;
      }

      if (this.views.booth.classList.contains('active')) {
        if (e.code === 'Space') {
          e.preventDefault();
          this.toggleRecording();
        } else if (e.key === '[') {
          e.preventDefault();
          const delta = e.shiftKey ? -100 : -25;
          this.setNudgeValue(parseInt(this.sliderNudge.value, 10) + delta, true);
        } else if (e.key === ']') {
          e.preventDefault();
          const delta = e.shiftKey ? 100 : 25;
          this.setNudgeValue(parseInt(this.sliderNudge.value, 10) + delta, true);
        }
      } else if (this.views.screening.classList.contains('active')) {
        if (e.code === 'Space') {
          e.preventDefault();
          this.handleScreeningPlayPause();
        } else if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          this.handleScreeningReplay();
        }
      }
    });

    this.initExportEvents();

    this.initScreeningEvents();

    this.socket.on('connection_state', (data) => {
      this.renderConnectionState(data.payload || {});
    });

    // A message that could not be sent is a change the user thinks they made and
    // nobody else will ever see. Say so rather than dropping it in silence.
    this.socket.on('send_failed', () => {
      if (this._sendFailureToastAt && Date.now() - this._sendFailureToastAt < 5000) return;
      this._sendFailureToastAt = Date.now();
      this.showToast("You're offline — that change wasn't saved to the room.");
    });

    // Socket events
    // room_socket emits the typed event before '*', so every typed handler that
    // reads this.roomState merges the incoming state first. The merge is
    // idempotent, so running it again here is harmless.
    this.socket.on('*', (data) => {
      if (data.state) {
        this.applyIncomingState(data);

        if (this.currentView === 'lobby') {
          this.renderLobbyState();
        }
        if (this.currentView === 'booth') {
          this.renderTimelineChips();
        }
        this.renderCastActivityHUD();
        this.updateScreeningControls();
      }
    });

    this.socket.on('line_changed', (data) => {
      const lineIdx = data.payload?.line_index;
      const targetUserId = data.payload?.user_id;
      if (targetUserId && this.roomState?.users?.[targetUserId]) {
        this.roomState.users[targetUserId].current_line = lineIdx;
        this.renderCastActivityHUD();
      }
      // Only sync client line automatically if in "studio" (synced prompter) mode
      if (this.roomState?.mode === 'studio' && lineIdx !== undefined && lineIdx !== this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
    });

    this.socket.on('user_status_updated', (data) => {
      this.applyIncomingState(data);
      if (this.roomState && data.payload?.user) {
        this.roomState.users[data.payload.user_id] = data.payload.user;
        this.renderCastActivityHUD();
      }
    });

    this.socket.on('take_recorded', async (data) => {
      this.applyIncomingState(data);
      const lineIdx = data.payload?.line_index;
      // Invalidate old take buffer from audio engine cache immediately
      this.audio.evictTakeCache(lineIdx);

      // Preload updated buffer for instant premiere playback
      const take = this.roomState?.takes?.[lineIdx];
      if (take && take.url) {
        try {
          const freshBuf = await this.audio.loadAudioBuffer(take.url, true);
          this.screeningBuffers.set(take.url, freshBuf);
        } catch (e) { }
      }

      if (lineIdx === this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
      this.renderTimelineChips();
      this.renderCastActivityHUD();

      const userName = data.payload?.user_name || this.roomState?.takes?.[lineIdx]?.user_name || 'Cast member';
      if (data.payload?.user_id === this.user.id) {
        this.showToast("Take recorded & saved! 🎙️");
      } else {
        this.showToast(`🎙️ ${userName} recorded their take for Line ${(lineIdx !== undefined ? lineIdx + 1 : '')}!`);
      }
    });

    this.socket.on('take_cleared', (data) => {
      this.applyIncomingState(data);
      const lineIdx = data.payload?.line_index;
      this.audio.evictTakeCache(lineIdx);
      if (lineIdx === this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
      this.renderTimelineChips();
      this.renderCastActivityHUD();
    });

    this.socket.on('status_changed', (data) => {
      this.applyIncomingState(data);
      const newStatus = data.payload?.status || data.status;
      if (newStatus === 'recording' && this.currentView === 'lobby') {
        this.showView('booth');
        this.loadBoothLine(this.findFirstAssignedLine());
        this.showToast("🎙️ Session started! Entering recording booth.");
      } else if (newStatus === 'screening' && this.currentView !== 'screening') {
        this.showView('screening');
        this.setupScreeningView();
      }
    });

    this.socket.on('warp_to_screening', (data) => {
      this.applyIncomingState(data);
      this.cancelCurrentCountdown();
      if (this.crumbPremiereLive) {
        this.crumbPremiereLive.style.display = 'inline-block';
      }
      this.showView('screening');
      this.setupScreeningView();
      this.broadcastMyStatus('screening');
      this.showToast("🍿 The Cast Premiere is Starting!");
    });

    this.socket.on('screening_sync', (data) => {
      this.handleIncomingScreeningSync(data.payload);
    });

    this.socket.on('export_started', (data) => {
      // The client that pressed Export already has the modal open and locked, and
      // its own POST/poll drives the progress; re-opening here would rewind it.
      if (this.isRenderingExport) return;
      if (this.views.screening.classList.contains('active')) {
        // Someone else started this render: show it, but leave the modal closable.
        this.openExportModal({ locked: false });
        this.updateExportModalStep(1, 30, "Applying vocal EQ, studio compression & acoustic room reverb...");
      }
    });

    this.socket.on('export_ready', (data) => {
      this.applyIncomingState(data);
      const payload = data.payload || data;
      if (payload && (payload.download_url || payload.export_video_url || payload.download_url_16_9)) {
        this.handleExportSuccess(payload);
        this.showToast("🎬 Master Dubbed Video is ready for the Cast!");
      }
    });

    this.socket.on('export_failed', (data) => {
      const payload = data.payload || data;
      const modalOpen = this.modalExportRendering && this.modalExportRendering.style.display !== 'none';
      if (!modalOpen) return;
      // The initiator's poll would report the same failure a tick later; stop it so
      // the failure is shown once.
      if (this.exportPollInterval) {
        clearInterval(this.exportPollInterval);
        this.exportPollInterval = null;
      }
      this.failExport(new Error(payload?.error || 'failed'));
    });

    this.socket.on('dialogue_presence_sync', (data) => {
      const pres = parseFloat(data.payload?.presence_db ?? 0.0);
      this.masterDialoguePresence = pres;
      this.renderPresenceUI(pres);
      if (this.screeningVocalGainNode && this.audio?.ctx) {
        const { vocalGain } = this.getScreeningStemGains();
        this.screeningVocalGainNode.gain.setValueAtTime(vocalGain, this.audio.ctx.currentTime);
      }
    });
  }

  /**
   * Merges a socket message's room state into this.roomState. Local take peaks
   * are kept when the incoming take carries none, and the local line is kept
   * unless the room is in studio (synced prompter) mode. Safe to call more than
   * once for the same message.
   */
  applyIncomingState(data) {
    if (!data || !data.state) return;
    const incoming = data.state;
    if (!this.roomState) {
      this.roomState = incoming;
    } else {
      // Preserve local take peaks if incoming take state does not specify them
      const oldTakes = this.roomState.takes || {};
      const newTakes = incoming.takes || {};
      const mergedTakes = {};

      for (const [k, take] of Object.entries(newTakes)) {
        const oldTake = oldTakes[k];
        mergedTakes[k] = {
          ...take,
          peaks: (take.peaks && take.peaks.length > 0) ? take.peaks : (oldTake?.peaks || []),
        };
      }

      this.roomState = {
        ...this.roomState,
        ...incoming,
        pack: incoming.pack || this.roomState.pack,
        users: incoming.users || this.roomState.users,
        role_assignments: incoming.role_assignments || this.roomState.role_assignments,
        takes: mergedTakes,
        // Keep local current_line if in booth mode (solo self-paced dubbing)
        current_line: (incoming.mode === 'studio') ? incoming.current_line : this.currentLineIndex,
      };
    }
  }

  initVideoPrompterSplitter() {
    const handle = this.prompterResizeHandle || document.getElementById('prompter-resize-handle');
    const videoContainer = this.stageVideo ? this.stageVideo.closest('.video-container') : document.querySelector('.video-container');
    if (!handle || !videoContainer) return;

    // Apply saved height preference or default fallback
    const savedHeight = localStorage.getItem('dubmate_video_height');
    if (savedHeight) {
      const parsed = parseInt(savedHeight, 10);
      if (!isNaN(parsed) && parsed >= 160 && parsed <= 500) {
        videoContainer.style.setProperty('--video-h', `${parsed}px`);
      }
    }

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;
    let rafId = null;

    const endDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      document.body.classList.remove('resizing');
      if (rafId) cancelAnimationFrame(rafId);

      if (e && e.pointerId) {
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch (err) { }
      }

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);

      const measured = videoContainer.getBoundingClientRect().height;
      const finalHeight = Math.round(measured || 0);
      if (finalHeight >= 160 && finalHeight <= 500) {
        localStorage.setItem('dubmate_video_height', finalHeight.toString());
      }
    };

    const onPointerDown = (e) => {
      e.preventDefault();
      isDragging = true;
      startY = e.clientY;
      const measured = videoContainer.getBoundingClientRect().height;
      startHeight = (measured && measured > 100) ? measured : 270;
      document.body.classList.add('resizing');

      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) { }

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('blur', endDrag);
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      if (e.cancelable) e.preventDefault();

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const deltaY = e.clientY - startY;
        const newHeight = startHeight + deltaY;
        const maxH = Math.min(Math.round(window.innerHeight * 0.52), 460);
        const clamped = Math.max(160, Math.min(maxH, Math.round(newHeight)));

        videoContainer.style.setProperty('--video-h', `${clamped}px`);
      });
    };

    // Double-click to snap reset to default (270px)
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      videoContainer.style.removeProperty('--video-h');
      localStorage.removeItem('dubmate_video_height');
      this.showToast('Video size reset to default');
    });

    // Keyboard navigation (Arrow keys on handle)
    handle.addEventListener('keydown', (e) => {
      let handled = false;
      const measured = videoContainer.getBoundingClientRect().height;
      const currentH = (measured && measured > 100) ? measured : 270;
      const maxH = Math.min(Math.round(window.innerHeight * 0.52), 460);
      const step = 15;

      if (e.key === 'ArrowDown') {
        const nextH = Math.max(160, Math.min(maxH, currentH + step));
        videoContainer.style.setProperty('--video-h', `${Math.round(nextH)}px`);
        localStorage.setItem('dubmate_video_height', Math.round(nextH).toString());
        handled = true;
      } else if (e.key === 'ArrowUp') {
        const nextH = Math.max(160, Math.min(maxH, currentH - step));
        videoContainer.style.setProperty('--video-h', `${Math.round(nextH)}px`);
        localStorage.setItem('dubmate_video_height', Math.round(nextH).toString());
        handled = true;
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Home') {
        videoContainer.style.removeProperty('--video-h');
        localStorage.removeItem('dubmate_video_height');
        this.showToast('Video size reset to default');
        handled = true;
      }

      if (handled) {
        e.preventDefault();
      }
    });

    handle.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) endDrag();
    });
  }

  async initRouter() {
    captureHomeOriginParam();
    this.pointHomeLinksAtOwnEngine();
    await this.fetchPacks();

    // First-run audio setup / remembered device routing. Deliberately not
    // awaited so a slow permissions query cannot stall the router.
    this.initAudioSetupOnBoot().catch((err) => {
      console.warn('[DubMate] Audio setup bootstrap failed:', err);
    });

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const selectPackParam = params.get('select_pack');
    if (roomParam) {
      this.promptJoinRoom(roomParam);
    } else {
      this.showView('landing');
      if (selectPackParam) {
        this.selectPack(selectPackParam);
        setTimeout(() => {
          const card = document.querySelector(`.pack-card[data-pack-id="${selectPackParam}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 200);
      }
    }
  }

  showView(viewName) {
    // The home screen lists the packs of the engine serving this page. On a
    // host's tunnel page that is the host's engine, so go back to our own.
    if (viewName === 'landing' && this.goHome()) return;
    document.body.classList.remove('resizing');
    this.currentView = viewName;
    this.cancelCurrentCountdown();
    this.stopScreeningSyncMonitor();
    Object.keys(this.views).forEach((k) => {
      this.views[k].classList.toggle('active', k === viewName);
    });
    this.audio.stopAllPlayback();
    if (this.stageVideo) {
      this.stageVideo.pause();
    }
    if (this.screeningVideo) {
      this.screeningVideo.pause();
    }

    if (viewName === 'lobby') {
      this.renderLobbyState();
    } else if (viewName === 'booth') {
      this.renderTimelineChips();
    }

    // Toggle HUD & Breadcrumbs visibility
    if (this.castActivityBar) {
      this.castActivityBar.style.display = (viewName === 'landing' || !this.roomState) ? 'none' : 'flex';
    }
    if (this.studioBreadcrumbs) {
      this.studioBreadcrumbs.style.display = (viewName === 'landing' || !this.roomState) ? 'none' : 'flex';
      this.navStepLobby.classList.toggle('active', viewName === 'lobby');
      this.navStepBooth.classList.toggle('active', viewName === 'booth');
      this.navStepScreening.classList.toggle('active', viewName === 'screening');
      if (this.crumbPremiereLive) {
        const isScreening = this.roomState?.status === 'screening' || viewName === 'screening';
        this.crumbPremiereLive.style.display = isScreening ? 'inline-block' : 'none';
      }
    }

    if (viewName === 'landing') {
      if (!this.packs || this.packs.length === 0) {
        this.fetchPacks();
      } else {
        this.renderPacks();
      }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  updateKnobsVisuals() {
    if (this.knobs && Array.isArray(this.knobs)) {
      this.knobs.forEach(item => {
        if (item.knob && typeof item.knob.updateVisuals === 'function') {
          item.knob.updateVisuals();
        }
      });
    }
  }

  /** Asks first; returns true only if the user actually left. */
  confirmLeaveRoom() {
    if (!confirm('Leave current dubbing session and return to scenes?')) return false;
    this.leaveRoom();
    return true;
  }

  /** Drops ?room= (pushState to the bare path, so the whole query string goes). */
  clearRoomQueryParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url.pathname);
  }

  leaveRoom() {
    document.body.classList.remove('resizing');
    this.cancelCurrentCountdown();
    this.stopScreeningSyncMonitor();
    this.audio.stopAllPlayback();
    if (this.socket) {
      this.socket.disconnect();
    }
    // A deliberate leave is not a dropped connection: hide any reconnect banner
    // (disconnect() emits no connection_state, so nothing else would clear it).
    const connectionBanner = document.getElementById('connection-banner');
    if (connectionBanner) {
      clearTimeout(this._connectionBannerTimer);
      connectionBanner.style.display = 'none';
      connectionBanner.classList.remove('is-recovered');
    }
    this.resetRoomSession();
    this.selectedPackId = null;

    // Clean URL query parameters (?room=...)
    this.clearRoomQueryParam();

    // Reset Header & HUD
    if (this.headerRoomBadge) this.headerRoomBadge.style.display = 'none';
    if (this.headerUserPill) this.headerUserPill.style.display = 'none';
    if (this.btnLeaveRoom) this.btnLeaveRoom.style.display = 'none';
    if (this.studioBreadcrumbs) this.studioBreadcrumbs.style.display = 'none';
    if (this.castActivityBar) this.castActivityBar.style.display = 'none';

    this.showView('landing');
    this.showToast('Left studio session room.');
  }

  navigateTo(url) {
    window.location.href = url;
  }

  /**
   * Sends a member who is on another host's page back to their own engine.
   * Returns true when it navigated away. A top-level navigation, so it is not
   * subject to CORS, mixed-content or private-network rules.
   */
  goHome() {
    const home = getHomeOrigin();
    if (!home || home === window.location.origin) return false;
    this.navigateTo(`${home}/`);
    return true;
  }

  /** On a host's page, the Studio and Pack Builder links must open the member's own engine. */
  pointHomeLinksAtOwnEngine() {
    const home = getHomeOrigin();
    if (!home || home === window.location.origin) return;
    const links = { 'mode-opt-studio': '/', 'mode-opt-builder': '/builder.html', 'btn-open-builder': '/builder.html' };
    Object.entries(links).forEach(([id, path]) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('href', `${home}${path}`);
    });
  }

  /**
   * Turns anything thrown -- a backend `detail`, a DOMException, an ffmpeg command
   * array, a bare HTTP status -- into a sentence a person can act on.
   *
   * The house style used to be `showToast(err.message)`, which put things like
   * "Command '['C:\\...\\ffmpeg.exe', '-y', ...]' returned non-zero exit status 1"
   * and "HTTP 500" in front of people who want to dub anime clips. The raw text is
   * still logged, just not shown.
   */
  friendlyError(err, fallback = "Something went wrong. Please try again.") {
    const raw = String(err?.message ?? err ?? '').trim();
    if (raw) console.warn('[DubMate] Underlying error:', raw);
    if (!raw) return fallback;

    const known = [
      [/still rendering|409/i,
        "The video is still rendering. Try again when it's ready."],
      [/failed to fetch|networkerror|load failed|err_connection/i,
        "Couldn't reach DubMate. Check your connection and try again."],
      [/timed out|timeout|etimedout/i,
        "That took longer than expected. Please try again."],
      [/room not found|no active session|session has ended/i,
        "That session has ended. Start a new room to continue."],
      [/not found|404/i,
        "That file is no longer available. Try creating it again."],
      [/no space|disk full|enospc/i,
        "Your disk is full. Free up some space and try again."],
      [/permission|denied|eacces|not allowed/i,
        "DubMate doesn't have permission to do that."],
      [/zip.?slip|path traversal|compression ratio|zip bomb/i,
        "That pack file looks corrupted or unsafe, so it wasn't imported."],
      [/yt-dlp|requirements_builder|pip install/i,
        "The Pack Builder tools aren't installed yet. Install them from the app's start-up screen."],
    ];
    for (const [pattern, message] of known) {
      if (pattern.test(raw)) return message;
    }

    // Machine output must never reach a toast verbatim.
    const isTechnical = /traceback|errno|command '|non-zero exit|exit status|\bHTTP \d{3}\b|[A-Za-z]:\\|\/usr\/|is not valid JSON|<html|\[object |undefined|null/i.test(raw);
    return isTechnical ? fallback : raw;
  }

  showToast(message) { showToast(message); }

  /**
   * Shows the connection banner while the room is not live.
   *
   * The socket already tracked this state and already reconnected with backoff --
   * it just never told anyone. To the user a dropped connection was a room that
   * had quietly stopped working.
   */
  renderConnectionState({ state, retryInMs } = {}) {
    const banner = document.getElementById('connection-banner');
    const text = document.getElementById('connection-banner-text');
    if (!banner || !text) return;

    if (state === 'open') {
      // Only announce recovery if the user actually saw a problem.
      if (banner.style.display === 'flex' && !banner.classList.contains('is-recovered')) {
        banner.classList.add('is-recovered');
        text.innerText = 'Back online';
        clearTimeout(this._connectionBannerTimer);
        this._connectionBannerTimer = setTimeout(() => {
          banner.style.display = 'none';
          banner.classList.remove('is-recovered');
        }, 2500);
      } else {
        banner.style.display = 'none';
        banner.classList.remove('is-recovered');
      }
      return;
    }

    clearTimeout(this._connectionBannerTimer);
    banner.classList.remove('is-recovered');
    banner.style.display = 'flex';
    if (state === 'reconnecting') {
      const seconds = Math.max(1, Math.round((retryInMs || 2000) / 1000));
      text.innerText = `Reconnecting in ${seconds}s — changes aren't being saved`;
    } else if (state === 'connecting') {
      text.innerText = 'Connecting…';
    } else {
      text.innerText = "Disconnected — you're no longer in the room";
    }
  }

  // --- Invite / Registry Status ---

  /**
   * Pulls the room's registry status from the host engine. A room code is only
   * usable once the engine has published it to the public registry, which cannot
   * happen until the cloudflared tunnel is up -- several seconds after the studio
   * opens. Until then the direct tunnel link is the only working invite.
   */
  async refreshRoomShare() {
    const code = this.roomState?.room_id || '';
    if (!code) return null;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/share`);
      if (!res.ok) return null;
      this.roomShare = await res.json();
      this.applyShareStatusToBadge();
      return this.roomShare;
    } catch (err) {
      console.warn('[Registry] Could not read room share status:', err);
      return null;
    }
  }

  applyShareStatusToBadge() {
    const share = this.roomShare;
    if (!this.headerRoomBadge || !share) return;
    this.headerRoomBadge.classList.toggle('room-badge-unpublished', !share.code_is_live);
    this.headerRoomBadge.title = share.code_is_live
      ? 'Room code is live — click to copy it'
      : `${share.message || 'Room code is not published yet.'} Click to copy an invite link.`;
  }

  /**
   * Polls the registry status after joining until the code goes live, so the host
   * finds out that a code is unusable instead of handing out one that silently
   * fails for everybody.
   */
  startShareWatch() {
    this.stopShareWatch();
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const share = await this.refreshRoomShare();
      if (share?.code_is_live) {
        this.stopShareWatch();
        return;
      }
      if (attempts >= 12) {
        this.stopShareWatch();
        // Only the host hands the code out, so only the host needs telling that
        // it does not work. Guests are already connected by this point.
        const isHost = this.roomState?.host_id && this.isHost();
        if (isHost && share && !share.code_is_live) {
          if (share.state === 'tunnel_unavailable') {
            // The shell told the engine the tunnel failed, so say what went wrong
            // rather than implying it is still on its way.
            this.showToast(share.message || "Couldn't open a public connection — only people on your network can join.");
          } else {
            this.showToast(share.direct_url
              ? 'Room code is not public yet — use Copy Code for a direct invite link.'
              : 'Room code is local only — guests on other networks cannot join yet.');
          }
        }
      }
    };
    tick();
    this.shareWatchTimer = setInterval(tick, 5000);
  }

  stopShareWatch() {
    if (this.shareWatchTimer) {
      clearInterval(this.shareWatchTimer);
      this.shareWatchTimer = null;
    }
  }

  async copyRoomLink() {
    const code = this.roomState?.room_id || '';
    if (!code) return;

    const share = (await this.refreshRoomShare()) || this.roomShare;

    // Prefer the short code once it actually resolves. When it does not, fall back
    // to the direct tunnel link so the session is still shareable rather than the
    // host copying a code that nobody can redeem.
    let text = code;
    let message = `Room code ${code} copied! 📋`;
    if (share && !share.code_is_live) {
      if (share.direct_url) {
        text = share.direct_url;
        message = 'Room code is not public yet — direct invite link copied instead. 🔗';
      } else {
        message = `Room code ${code} copied — local network only for now.`;
      }
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Clipboard API needs a secure context and can be denied; a manual-copy
      // prompt beats silently copying nothing.
      console.warn('[Invite] Clipboard write failed:', err);
      window.prompt('Copy this invite:', text);
      return;
    }
    this.showToast(message);
  }

  // --- Packs & Landing Logic ---

  renderSkeletonPacks() {
    if (!this.packGrid) return;
    if (this.packCountBadge) {
      this.packCountBadge.innerHTML = `<span class="spinning" style="display: inline-block; font-size: 10px;">⚙️</span> Scanning...`;
    }
    this.packGrid.innerHTML = `
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
      <div class="pack-card pack-card-skeleton">
        <div class="pack-card-thumb skeleton-thumb"></div>
        <div class="pack-card-body">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
          <div class="skeleton-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>
      </div>
    `;
  }

  async fetchPacks() {
    if (!this.packs || this.packs.length === 0) {
      this.renderSkeletonPacks();
    }
    try {
      const res = await fetch('/api/packs?t=' + Date.now());
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.packs = await res.json();
      console.log(`[DubMate] Successfully loaded ${this.packs.length} scene packs:`, this.packs.map(p => p.name || p.title));

      if (!this.packs || this.packs.length === 0) {
        // Cold start auto-rescan if server just started with 0 indexed packs
        await this.rescanPacksDirectory(true);
      } else {
        this.renderPacks();
      }
    } catch (err) {
      console.error("Error fetching packs:", err);
      if (this.packGrid) {
        this.packGrid.innerHTML = `
          <div style="color: var(--foreground-muted); padding: 32px 24px; text-align: center; grid-column: 1 / -1;">
            <div style="font-size: 32px; margin-bottom: 8px;">🔌</div>
            <p style="margin-bottom: 8px; font-weight: 600; color: #fca5a5;">Could not connect to DubMate Engine</p>
            <p style="font-size: 12px; color: var(--foreground-muted); max-width: 440px; margin: 0 auto 16px;">
              The studio could not reach <code>${escapeHtml(window.location.origin)}</code>. Please ensure the DubMate engine is running.
            </p>
            <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
              <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.fetchPacks()">↺ Retry Connection</button>
              <button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">📁 Configure Packs Folder</button>
            </div>
          </div>
        `;
      }
    }
  }

  /** Plain GET /api/config: parsed body, or null on a non-2xx answer. Throws on network errors. */
  async fetchConfig() {
    const res = await fetch('/api/config');
    return res.ok ? res.json() : null;
  }

  async openPackConfigModal() {
    if (!this.modalPackConfig) return;
    this.modalPackConfig.style.display = 'flex';
    if (this.webConfigFeedback) this.webConfigFeedback.style.display = 'none';

    try {
      const data = await this.fetchConfig();
      if (data) {
        if (this.webInputPackPath) {
          this.webInputPackPath.value = data.packs_dir || '';
        }
        if (this.webConfigActiveCount) {
          this.webConfigActiveCount.innerText = `${data.pack_count || 0} Packs Loaded`;
        }
      }
    } catch (err) {
      console.warn("Could not fetch active packs config:", err);
    }

    if (this.webInputPackPath) {
      setTimeout(() => this.webInputPackPath.focus(), 50);
    }
  }

  closePackConfigModal() {
    if (this.modalPackConfig) {
      this.modalPackConfig.style.display = 'none';
    }
  }

  async savePackConfig() {
    const rawPath = this.webInputPackPath ? this.webInputPackPath.value.trim() : '';
    if (!rawPath) {
      this.showWebConfigFeedback("Please enter a valid directory path.", false);
      return;
    }

    if (this.btnSavePackConfig) {
      this.btnSavePackConfig.disabled = true;
      const textSpan = document.getElementById('web-save-config-text');
      if (textSpan) textSpan.innerText = 'Scanning & Saving...';
    }

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs_dir: rawPath })
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || data.message || "Failed to update directory");
      }

      this.packs = data.packs || [];
      this.renderPacks();
      this.showWebConfigFeedback(`✅ ${data.message || `Loaded ${data.pack_count} scene packs!`}`, true);
      this.showToast(`✨ ${data.message || `Loaded ${data.pack_count} scene packs!`}`);

      if (this.webConfigActiveCount) {
        this.webConfigActiveCount.innerText = `${data.pack_count || 0} Packs Loaded`;
      }

      setTimeout(() => {
        this.closePackConfigModal();
      }, 1200);
    } catch (err) {
      // Server details (bad path, unreadable folder) are shown as-is.
      let errMsg = err.message || "Unknown error";
      if (errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError")) {
        errMsg = this.friendlyError(err);
      }
      this.showWebConfigFeedback(`❌ ${errMsg}`, false);
    } finally {
      if (this.btnSavePackConfig) {
        this.btnSavePackConfig.disabled = false;
        const textSpan = document.getElementById('web-save-config-text');
        if (textSpan) textSpan.innerText = '📁 Scan & Save Location';
      }
    }
  }

  showWebConfigFeedback(msg, isSuccess) {
    if (!this.webConfigFeedback) return;
    this.webConfigFeedback.style.display = 'block';
    this.webConfigFeedback.style.background = isSuccess ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
    this.webConfigFeedback.style.border = isSuccess ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)';
    this.webConfigFeedback.style.color = isSuccess ? '#6ee7b7' : '#fca5a5';
    this.webConfigFeedback.innerText = msg;
  }

  async rescanPacksDirectory(silent = false) {
    if (this.isRescanningPacks) return;
    this.isRescanningPacks = true;

    const icon = this.btnRescanPacks?.querySelector('svg');
    if (icon) icon.classList.add('spinning');
    if (this.btnRescanPacks) {
      this.btnRescanPacks.disabled = true;
      const textSpan = this.btnRescanPacks.querySelector('span');
      if (textSpan) textSpan.innerText = 'Scanning...';
    }
    if (this.packCountBadge) {
      this.packCountBadge.innerHTML = `<span class="spinning" style="display: inline-block; font-size: 10px;">⚙️</span> Scanning...`;
    }

    try {
      const res = await fetch('/api/packs/rescan?t=' + Date.now(), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      this.packs = data.packs || [];
      console.log(`[DubMate] Rescan complete. Loaded ${this.packs.length} packs.`);
      this.renderPacks();
      const count = (this.packs || []).length;
      if (!silent) {
        this.showToast(`✨ Rescan complete: ${count} scene pack${count === 1 ? '' : 's'} indexed!`);
      }
    } catch (err) {
      console.error("Error during pack rescan:", err);
      if (!silent) {
        this.showToast(`⚠️ ${this.friendlyError(err, "Couldn't rescan your packs folder.")}`);
      }
    } finally {
      this.isRescanningPacks = false;
      if (icon) icon.classList.remove('spinning');
      if (this.btnRescanPacks) {
        this.btnRescanPacks.disabled = false;
        const textSpan = this.btnRescanPacks.querySelector('span');
        if (textSpan) textSpan.innerText = 'Rescan Packs';
      }
    }
  }

  async uploadPackZip(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      this.showToast("⚠️ Security Check: Only valid .zip pack archives are supported.");
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      this.showToast("⚠️ Pack archive exceeds maximum 500 MB upload limit.");
      return;
    }

    const btn = this.btnImportPack;
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinning" style="display:inline-block;">⚙️</span> <span>Importing...</span>`;
    }

    this.showToast(`🛡️ Verifying & importing pack "${file.name}"...`);
    if (this.modalImportLoading) {
      const statusText = document.getElementById('import-modal-status-text');
      if (statusText) {
        statusText.innerText = "Checking the pack file and loading its audio...";
      }
      this.modalImportLoading.style.display = 'flex';
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/packs/import', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const importedPack = data.pack;

      await this.fetchPacks();

      if (importedPack && importedPack.id) {
        this.selectedPackId = importedPack.id;
        this.renderPacks();
        const card = document.querySelector(`.pack-card[data-pack-id="${importedPack.id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }

      this.showToast(`✨ Pack "${importedPack?.name || file.name}" verified & imported successfully!`);
    } catch (err) {
      console.error("Pack import error:", err);
      this.showToast(`⚠️ ${this.friendlyError(err, "Couldn't import that pack. Please check the file and try again.")}`);
    } finally {
      if (this.modalImportLoading) {
        this.modalImportLoading.style.display = 'none';
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
      if (this.inputPackZip) {
        this.inputPackZip.value = '';
      }
    }
  }

  handlePackSearch(query) {
    this.packSearchQuery = (query || '').trim().toLowerCase();
    if (this.btnClearSearch) {
      this.btnClearSearch.style.display = this.packSearchQuery ? 'inline-flex' : 'none';
    }
    this.renderPacks();
  }

  clearPackSearch() {
    this.packSearchQuery = '';
    if (this.inputPackSearch) {
      this.inputPackSearch.value = '';
    }
    if (this.btnClearSearch) {
      this.btnClearSearch.style.display = 'none';
    }
    this.renderPacks();
    if (this.inputPackSearch) {
      this.inputPackSearch.focus();
    }
  }

  highlightMatch(text, query) {
    const safeText = escapeHtml(text ?? '');
    if (!query) return safeText;
    const safeQuery = escapeHtml(query);
    const escapedQuery = safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedQuery) return safeText;
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return safeText.replace(regex, '<span class="search-highlight">$1</span>');
  }

  renderPacks() {
    if (!this.packGrid) return;
    this.packGrid.innerHTML = '';

    const allPacks = this.packs || [];
    const query = this.packSearchQuery;

    if (!allPacks.length) {
      this.selectedPackId = null;
      if (this.packCountBadge) {
        this.packCountBadge.innerText = '0 Packs';
      }
      this.packGrid.innerHTML = `
        <div class="empty-packs-guide glass-card" style="grid-column: 1 / -1; padding: 36px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <div style="font-size: 38px; margin-bottom: 12px;">📦</div>
          <h3 style="font-size: 17px; font-weight: 700; margin-bottom: 8px; color: var(--foreground);">No Scene Packs Loaded</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 500px; margin: 0 auto 18px; line-height: 1.6;">
            Select your Scene Packs folder on disk, import a .zip pack from GameBanana, or create a new pack with Pack Builder.
          </p>
          <div style="display: flex; justify-content: center; gap: 10px; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" onclick="window.dubMateApp.openPackConfigModal()">📁 Set Scene Packs Folder</button>
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('input-pack-zip').click()">Import .ZIP Pack</button>
            <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.rescanPacksDirectory()">↺ Rescan</button>
          </div>
        </div>
      `;
      return;
    }

    const filteredPacks = !query ? allPacks : allPacks.filter(pack => {
      const title = (pack.title || pack.name || pack.id || '').toLowerCase();
      const subtitle = (pack.subtitle || '').toLowerCase();
      const authors = (pack.authors || []).join(' ').toLowerCase();
      const id = (pack.id || '').toLowerCase();
      const chars = (pack.characters || []).join(' ').toLowerCase();
      const linesText = (pack.lines || []).map(l => (l.caption || l.raw_caption || l.text || '') + ' ' + (l.character || '')).join(' ').toLowerCase();
      return title.includes(query) || subtitle.includes(query) || authors.includes(query) || id.includes(query) || chars.includes(query) || linesText.includes(query);
    });

    if (this.packCountBadge) {
      if (query) {
        this.packCountBadge.innerText = `${filteredPacks.length} of ${allPacks.length} Packs`;
      } else {
        this.packCountBadge.innerText = `${allPacks.length} Packs`;
      }
    }

    if (!filteredPacks.length) {
      this.selectedPackId = null;
      const safeQuery = escapeHtml(query);
      this.packGrid.innerHTML = `
        <div class="empty-search-state glass-card" style="grid-column: 1 / -1; padding: 32px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <div style="font-size: 32px; margin-bottom: 12px;">🔍</div>
          <h3 style="font-size: 15px; font-weight: 700; margin-bottom: 6px; color: var(--foreground);">No Scenes Matching "${safeQuery}"</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 440px; margin: 0 auto 16px; line-height: 1.5;">
            Try searching for another character name, author, scene title, or spoken dialogue keyword.
          </p>
          <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.clearPackSearch()">✕ Clear Search</button>
        </div>
      `;
      return;
    }

    const hasCurrentSelection = filteredPacks.some(p => p.id === this.selectedPackId);
    if (!hasCurrentSelection && filteredPacks.length > 0) {
      this.selectedPackId = filteredPacks[0].id;
    }

    filteredPacks.forEach((pack) => {
      const card = document.createElement('div');
      const isSelected = (this.selectedPackId === pack.id);
      card.className = `pack-card ${isSelected ? 'selected' : ''}`;
      card.dataset.packId = pack.id;

      const rawTitle = pack.title || pack.name || pack.id;
      const displayTitle = this.highlightMatch(rawTitle, query);
      const duration = Math.round(pack.duration || (pack.lines && pack.lines.length ? pack.lines[pack.lines.length - 1].end : 0));
      const lineCount = pack.line_count || (pack.lines ? pack.lines.length : 0);
      const characters = pack.characters || [];

      const subtitleHtml = pack.subtitle ? `
        <div class="pack-card-subtitle" title="${escapeHtml(pack.subtitle)}">
          ${this.highlightMatch(pack.subtitle, query)}
        </div>
      ` : '';

      const authorsHtml = (pack.authors && pack.authors.length) ? `
        <span class="badge-author" title="Author: ${escapeHtml(pack.authors.join(', '))}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${pack.authors.map(a => this.highlightMatch(a, query)).join(', ')}
        </span>
      ` : '';

      const isCV = (pack.pack_type === 'choicer_voicer');
      const formatBadge = isCV
        ? `<span class="badge-format cv" title="Choicer Voicer Native Format">CV Pack</span>`
        : `<span class="badge-format dubmate" title="DubMate Standard Format">DubMate</span>`;

      const thumbImg = (pack.has_icon && pack.icon_url)
        ? `<div class="pack-card-thumb"><img src="${escapeHtml(pack.icon_url)}" alt="${escapeHtml(rawTitle)} cover" loading="lazy"></div>`
        : `<div class="pack-card-thumb placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/></svg></div>`;

      // Check if a dialogue line matched query
      let matchedLineSnippet = '';
      if (query && pack.lines) {
        const foundLine = pack.lines.find(l => ((l.caption || '') + ' ' + (l.raw_caption || '') + ' ' + (l.text || '')).toLowerCase().includes(query));
        if (foundLine) {
          const charPrefix = foundLine.character ? `<strong>${escapeHtml(foundLine.character)}:</strong> ` : '';
          const cap = foundLine.caption || foundLine.raw_caption || foundLine.text || '';
          matchedLineSnippet = `
            <div style="font-size: 11px; color: var(--accent-brass); margin-top: 6px; font-style: italic; background: var(--input); padding: 4px 8px; border-radius: var(--radius-sm); border-left: 2px solid var(--primary);">
              ${charPrefix}"${this.highlightMatch(cap, query)}"
            </div>
          `;
        }
      }

      card.innerHTML = `
        <div class="pack-card-top-row">
          ${thumbImg}
          <div class="pack-card-meta-col">
            <div class="pack-card-header">
              <div class="pack-card-title">${displayTitle}</div>
              <span class="pack-card-duration">${duration}s</span>
            </div>
            ${subtitleHtml}
            <div class="pack-card-badges-row">
              ${formatBadge}
              ${authorsHtml}
              <span class="pack-line-badge">${lineCount} lines</span>
              <a href="${escapeHtml(pack.export_url || `/api/packs/${encodeURIComponent(pack.id)}/export`)}" class="btn-pack-download-icon" title="Download ${escapeHtml(rawTitle)} (.zip)" download>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>ZIP</span>
              </a>
            </div>
          </div>
        </div>
        ${matchedLineSnippet}
        <div class="pack-card-characters">
          ${characters.map(c => `<span class="char-tag">${this.highlightMatch(c, query)}</span>`).join('')}
        </div>
      `;

      // Same bare-anchor problem as the export buttons: the webview navigated to
      // the export route, so a missing pack showed a JSON page instead of a toast.
      const packZipLink = card.querySelector('.btn-pack-download-icon');
      if (packZipLink) {
        packZipLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation(); // the card behind it is the "select this pack" target
          const safeName = (pack.name || pack.id || 'pack').replace(/[^a-zA-Z0-9_-]/g, '_');
          this.saveRemoteFile(packZipLink.getAttribute('href'), `${safeName}.zip`, {
            control: packZipLink,
            busyText: '…', // the button is a 10px icon; anything longer reflows the row
            startMessage: `⏳ Packaging "${rawTitle}"…`,
            doneMessage: `✅ "${rawTitle}" downloaded.`,
            errorText: "Couldn't download that pack. Please try again.",
          });
        });
      }

      card.addEventListener('click', () => {
        this.packGrid.querySelectorAll('.pack-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedPackId = pack.id;
      });

      this.packGrid.appendChild(card);
    });
  }

  async createRoom() {
    if (!this.selectedPackId) {
      this.showToast("Please select a dub pack first!");
      return;
    }

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pack_id: this.selectedPackId,
          host_name: this.user.name,
          host_color: this.user.color,
        }),
      });
      const data = await res.json();
      this.user.id = data.user_id;
      this.saveUser();

      // Room registration with the public registry is performed server-side by
      // app.py's register_room_with_worker(), which uses the room's real 6-char
      // code and holds the per-room ownership token. The browser-side copy that
      // used to live here sent no code (minting a second, weak 4-char room in the
      // registry), embedded the shared API key in page source, and wrote
      // window.__dubmate_room_code/_token which nothing ever read.

      this.joinRoom(data.room_id);
    } catch (err) {
      this.showToast(this.friendlyError(err, "Couldn't create the room. Please try again."));
    }
  }

  initModeDropdown() {
    initModeDropdown({
      onStudioClick: (e, closeMenu) => {
        if (this.roomState) {
          e.preventDefault();
          if (this.confirmLeaveRoom()) {
            closeMenu();
          }
        } else {
          closeMenu();
        }
      },
    });
  }

  initJoinModal() {
    this.modalJoinRoom = document.getElementById('modal-join-room');
    this.joinModalRoomBadge = document.getElementById('join-modal-room-badge');
    this.inputJoinActorName = document.getElementById('input-join-actor-name');
    this.joinModalAvatarPreview = document.getElementById('join-modal-avatar-preview');
    this.joinColorPalette = document.getElementById('join-color-palette');
    this.btnCancelJoinModal = document.getElementById('btn-cancel-join-modal');
    this.btnConfirmJoinModal = document.getElementById('btn-confirm-join-modal');

    if (!this.modalJoinRoom) return;

    if (this.inputJoinActorName) {
      this.inputJoinActorName.addEventListener('input', (e) => {
        const name = (e.target.value || '').trim();
        const initial = name ? name.charAt(0).toUpperCase() : 'A';
        if (this.joinModalAvatarPreview) {
          this.joinModalAvatarPreview.innerText = initial;
        }
      });

      this.inputJoinActorName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.confirmJoinModal();
        }
      });
    }

    if (this.joinColorPalette) {
      this.joinColorPalette.querySelectorAll('.color-option').forEach((opt) => {
        opt.addEventListener('click', () => {
          this.joinColorPalette.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          this.user.color = opt.dataset.color;
          if (this.joinModalAvatarPreview) {
            this.joinModalAvatarPreview.style.backgroundColor = this.user.color;
          }
        });
      });
    }

    if (this.btnCancelJoinModal) {
      this.btnCancelJoinModal.addEventListener('click', () => {
        this.closeJoinModal();
      });
    }

    if (this.btnConfirmJoinModal) {
      this.btnConfirmJoinModal.addEventListener('click', () => {
        this.confirmJoinModal();
      });
    }

    this.modalJoinRoom.addEventListener('click', (e) => {
      if (e.target === this.modalJoinRoom) {
        this.closeJoinModal();
      }
    });
  }

  promptJoinRoom(roomId) {
    const cleanCode = (roomId || '').trim().toUpperCase();
    if (!cleanCode) {
      this.showToast("Please enter a room code!");
      return;
    }
    this.pendingJoinRoomId = cleanCode;

    if (this.joinModalRoomBadge) {
      this.joinModalRoomBadge.innerText = `ROOM: ${cleanCode}`;
    }
    if (this.inputJoinActorName) {
      this.inputJoinActorName.value = this.user.name || '';
      const initial = (this.user.name || 'Actor').trim().charAt(0).toUpperCase() || 'A';
      if (this.joinModalAvatarPreview) {
        this.joinModalAvatarPreview.innerText = initial;
        this.joinModalAvatarPreview.style.backgroundColor = this.user.color || '#d97706';
      }
    }
    if (this.joinColorPalette) {
      this.joinColorPalette.querySelectorAll('.color-option').forEach((opt) => {
        const isMatch = (opt.dataset.color === this.user.color);
        opt.classList.toggle('selected', isMatch);
        opt.setAttribute('aria-checked', isMatch ? 'true' : 'false');
      });
    }
    if (this.modalJoinRoom) {
      this.modalJoinRoom.style.display = 'flex';
      setTimeout(() => {
        if (this.inputJoinActorName) {
          this.inputJoinActorName.focus();
          this.inputJoinActorName.select();
        }
      }, 50);
    }
  }

  confirmJoinModal() {
    const name = (this.inputJoinActorName?.value || '').trim() || ('Actor ' + Math.floor(Math.random() * 900 + 100));
    this.user.name = name;
    this.saveUser();
    this.updateUserUI();

    if (this.modalJoinRoom) {
      this.modalJoinRoom.style.display = 'none';
    }

    if (this.pendingJoinRoomId) {
      const codeToJoin = this.pendingJoinRoomId;
      this.pendingJoinRoomId = null;
      this.joinRoom(codeToJoin);
    }
  }

  closeJoinModal() {
    if (this.modalJoinRoom) {
      this.modalJoinRoom.style.display = 'none';
    }
    this.pendingJoinRoomId = null;
    if (new URL(window.location.href).searchParams.has('room')) {
      this.clearRoomQueryParam();
      // Declined a host's room: don't stay behind on the host's home screen.
      this.goHome();
    }
  }

  joinRoomFromInput() {
    const code = (this.inputRoomCode?.value || '').trim().toUpperCase();
    if (!code) {
      this.showToast("Please enter a room code!");
      return;
    }
    this.promptJoinRoom(code);
  }

  async joinRoom(roomId) {
    this.resetRoomSession();
    const cleanCode = (roomId || '').trim().toUpperCase();
    try {
      let res = await fetch(`/api/rooms/${cleanCode}`);
      if (!res.ok) {
        // If room is not hosted on this local instance, resolve via dubmate.bkaproductions.com
        try {
          const resolveResp = await fetch(`${REGISTRY_BASE}/rooms/${encodeURIComponent(cleanCode)}/resolve`, {
            headers: { 'Accept': 'application/json' }
          });
          if (resolveResp.ok) {
            const data = await resolveResp.json();
            if (data && data.tunnel_url) {
              // Navigate to host's tunnel room session, carrying the member's own
              // engine along so leaving the room can come back to it.
              const target = new URL(data.tunnel_url);
              target.searchParams.set('room', cleanCode);
              const home = getHomeOrigin();
              if (home) target.searchParams.set('home', home);
              this.showToast(`Connecting to host for room ${cleanCode}... 🚀`);
              this.navigateTo(target.toString());
              return;
            }
          }
        } catch (resolveErr) {
          console.warn('[Registry] Public resolve check:', resolveErr);
        }

        // Strip stale room parameter so user is returned cleanly to scene explorer
        this.clearRoomQueryParam();

        this.showToast(`Room '${cleanCode}' not found or expired.`);
        this.showView('landing');
        return;
      }
      this.roomState = await res.json();

      const url = new URL(window.location);
      url.searchParams.set('room', this.roomState.room_id);
      window.history.pushState({}, '', url);

      this.socket.connect(this.roomState.room_id, this.user.id, this.user.name, this.user.color);

      this.headerRoomBadge.style.display = 'inline-flex';
      this.headerRoomCode.innerText = this.roomState.room_id;
      this.headerUserPill.style.display = 'inline-flex';
      if (this.btnLeaveRoom) this.btnLeaveRoom.style.display = 'inline-flex';

      // The registry publish is asynchronous and may still be waiting on the
      // tunnel, so watch it rather than assuming the code works.
      this.startShareWatch();

      // Lazy load backing buffer when entering booth instead of blocking joinRoom
      if (this.roomState.status === 'screening') {
        this.showView('screening');
        this.setupScreeningView();
        this.broadcastMyStatus('screening');
      } else if (this.roomState.status === 'recording') {
        this.showView('booth');
        this.loadBoothLine(this.findFirstAssignedLine());
        this.broadcastMyStatus('booth');
      } else {
        this.showView('lobby');
        this.renderLobbyState();
        this.renderCastActivityHUD();
        this.broadcastMyStatus('lobby');
      }
    } catch (err) {
      this.clearRoomQueryParam();
      this.showToast(this.friendlyError(err, "Couldn't join that room. Please try again."));
      this.showView('landing');
    }
  }

  // --- Live Cast Activity HUD & Premiere Gate ---

  broadcastMyStatus(location = 'booth') {
    if (!this.socket || !this.roomState) return;
    this.socket.send('set_user_status', {
      current_line: this.currentLineIndex,
      location: location,
      is_ready: this.isReadyForScreening,
    });
  }

  toggleMyReadiness() {
    this.isReadyForScreening = !this.isReadyForScreening;
    if (this.isReadyForScreening) {
      if (this.labelReadyState) this.labelReadyState.innerText = "Ready for Premiere";
      this.btnToggleReady.className = "btn btn-success btn-sm btn-ready-toggle ready";
      this.showToast("Marked READY for the Premiere");
    } else {
      if (this.labelReadyState) this.labelReadyState.innerText = "Mark Ready";
      this.btnToggleReady.className = "btn btn-secondary btn-sm btn-ready-toggle";
    }
    if (this.roomState && this.roomState.users && this.roomState.users[this.user.id]) {
      this.roomState.users[this.user.id].is_ready = this.isReadyForScreening;
      this.renderCastActivityHUD();
    }
    this.broadcastMyStatus('booth');
  }

  launchGroupPremiere() {
    if (!this.roomState) return;
    const isHost = this.isHost();
    if (!isHost) {
      this.showToast("Only the Room Host can launch the Group Premiere");
      return;
    }
    this.showToast("Mastering Dubbed Video & Launching Premiere for the Cast...");
    this.socket.send('launch_premiere', {});
  }

  toggleFilterLines() {
    this.filterMyLinesOnly = !this.filterMyLinesOnly;
    if (this.labelFilterLines) {
      this.labelFilterLines.innerText = this.filterMyLinesOnly ? "My Lines Only" : "All Scene Lines";
    }
    this.renderTimelineChips();
    this.showToast(this.filterMyLinesOnly ? "Filtering timeline to your assigned lines" : "Showing all scene lines");
  }

  renderCastActivityHUD() {
    if (!this.roomState || !this.castActivityList) return;
    const users = Object.values(this.roomState.users || {}).filter(u => u.is_online);
    const isHost = this.isHost();

    let readyCount = 0;
    this.castActivityList.innerHTML = '';

    users.forEach((u) => {
      // Find assigned characters
      const assignedChars = Object.keys(this.roomState.role_assignments || {}).filter((char) => {
        return (this.roomState.role_assignments[char] || []).includes(u.id);
      });

      // Calculate lines completed
      const assignedLineObjs = this.roomState.pack.lines.filter(l => assignedChars.includes(l.character));
      const totalAssigned = assignedLineObjs.length;
      const completedTakes = assignedLineObjs.filter(l => !!this.roomState.takes[l.index]).length;
      const pct = totalAssigned > 0 ? Math.round((completedTakes / totalAssigned) * 100) : 0;

      if (u.is_ready) readyCount++;

      const chip = document.createElement('div');
      chip.className = `actor-hud-chip ${u.is_ready ? 'ready' : ''}`;

      let charDisplayText = 'Unassigned';
      let charFullTooltip = 'Unassigned';
      if (assignedChars.length > 0) {
        charFullTooltip = assignedChars.join(', ');
        if (assignedChars.length <= 2) {
          charDisplayText = assignedChars.join(', ');
        } else {
          charDisplayText = `${assignedChars[0]}, ${assignedChars[1]} +${assignedChars.length - 2}`;
        }
      }

      const loc = u.location === 'screening' ? 'Screening' : (u.location === 'lobby' ? 'Lobby' : `Line ${(u.current_line || 0) + 1}`);

      chip.innerHTML = `
        <div class="actor-hud-avatar" style="background: ${escapeHtml(u.color)};">${escapeHtml(u.name.charAt(0).toUpperCase())}</div>
        <span class="actor-hud-name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}${u.id === this.user.id ? ' (You)' : ''}</span>
        <span class="actor-hud-char" title="${escapeHtml(charFullTooltip)}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${escapeHtml(charDisplayText)}</span>
        <span class="actor-hud-progress">${completedTakes}/${totalAssigned} (${pct}%)</span>
        <span class="actor-hud-status-badge ${u.is_ready ? 'badge-ready' : (u.location === 'screening' ? 'badge-screening' : 'badge-recording')}">
          ${u.is_ready ? '✓ Ready' : loc}
        </span>
      `;

      this.castActivityList.appendChild(chip);
    });

    if (this.premiereStatusSummary) {
      this.premiereStatusSummary.innerText = `${readyCount}/${users.length} Cast Ready`;
    }

    // Host Premiere Button Visibility
    if (this.btnLaunchPremiere) {
      if (isHost) {
        this.btnLaunchPremiere.style.display = 'inline-flex';
        this.btnLaunchPremiere.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Launch Premiere (${readyCount}/${users.length} Ready) ›</span>`;
      } else {
        this.btnLaunchPremiere.style.display = 'none';
      }
    }
  }

  // --- Room & Lobby Logic ---

  renderLobbyState() {
    if (!this.roomState) return;

    if (this.lobbyPackTitle) this.lobbyPackTitle.innerText = this.roomState.pack.name;
    if (this.lobbyLineCount) this.lobbyLineCount.innerText = `${this.roomState.pack.line_count} Lines`;

    const users = Object.values(this.roomState.users || {});
    if (this.castOnlineCount) this.castOnlineCount.innerText = `${users.filter(u => u.is_online).length} Online`;

    // Only update lobby cast list if user list changed
    const userSummary = users.map(u => `${u.id}:${u.name}:${u.is_online}:${u.color}`).join('|');
    if (this._lastUserSummary !== userSummary) {
      this._lastUserSummary = userSummary;
      if (this.lobbyCastList) {
        this.lobbyCastList.innerHTML = users.map(u => `
          <div class="user-pill lobby-user-item" style="justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="user-avatar" style="background: ${escapeHtml(u.color)};">${escapeHtml(u.name.charAt(0).toUpperCase())}</div>
              <span class="lobby-user-name">${escapeHtml(u.name)} ${u.id === this.user.id ? '<span class="user-you-tag">(You)</span>' : ''} ${u.id === this.roomState.host_id ? '<span class="user-you-tag" style="color: #f59e0b; border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.1);">Host</span>' : ''}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="cast-status-pill ${u.is_online ? 'online' : 'offline'}">
                <span class="status-dot ${u.is_online ? 'dot-online' : 'dot-offline'}" aria-hidden="true"></span>
                <span>${u.is_online ? 'Online' : 'Offline'}</span>
              </span>
            </div>
          </div>
        `).join('');
      }
    }

    if (!this.castingTbody) return;

    const charCounts = {};
    this.roomState.pack.lines.forEach(l => {
      charCounts[l.character] = (charCounts[l.character] || 0) + 1;
    });

    const usersChanged = (this._lastUserOptionsSummary !== userSummary);
    this._lastUserOptionsSummary = userSummary;

    // Check if table rows already exist for all characters
    const existingRows = this.castingTbody.querySelectorAll('tr[data-character]');
    if (existingRows.length === this.roomState.pack.characters.length && !usersChanged) {
      // IN-PLACE UPDATE: Do not recreate DOM elements to avoid closing active <select> dropdowns
      this.roomState.pack.characters.forEach((char) => {
        const tr = this.castingTbody.querySelector(`tr[data-character="${char}"]`);
        if (!tr) return;

        const assignedIds = this.roomState.role_assignments[char] || [];
        const assignedUser = users.find(u => assignedIds.includes(u.id));
        const isAssignedToMe = assignedIds.includes(this.user.id);
        const targetVal = assignedUser ? assignedUser.id : '';

        tr.classList.toggle('assigned-to-me', isAssignedToMe);
        const roleBadge = tr.querySelector('.your-role-badge');
        if (isAssignedToMe && !roleBadge) {
          const badgeCell = tr.querySelector('.char-badge-cell');
          if (badgeCell) {
            const span = document.createElement('span');
            span.className = 'your-role-badge';
            span.innerText = 'YOUR ROLE';
            badgeCell.appendChild(span);
          }
        } else if (!isAssignedToMe && roleBadge) {
          roleBadge.remove();
        }

        const dot = tr.querySelector('.actor-color-dot');
        if (dot) {
          dot.className = `actor-color-dot ${assignedUser ? 'active' : 'unassigned'}`;
          dot.style.backgroundColor = assignedUser ? assignedUser.color : 'transparent';
          dot.title = assignedUser ? assignedUser.name : 'Unassigned';
        }

        const select = tr.querySelector('.cast-select');
        if (select && select.value !== targetVal && document.activeElement !== select) {
          select.value = targetVal;
        }
      });
      return;
    }

    // FULL REBUILD (Initial render or when user list changes)
    this.castingTbody.innerHTML = '';
    this.roomState.pack.characters.forEach((char) => {
      const assignedIds = this.roomState.role_assignments[char] || [];
      const assignedUser = users.find(u => assignedIds.includes(u.id));
      const isAssignedToMe = assignedIds.includes(this.user.id);
      const safeCharId = char.replace(/\s+/g, '-').toLowerCase();

      const tr = document.createElement('tr');
      tr.setAttribute('data-character', char);
      if (isAssignedToMe) {
        tr.classList.add('assigned-to-me');
      }

      tr.innerHTML = `
        <td>
          <div class="char-badge-cell">
            <span class="char-badge">🎭 ${escapeHtml(char)}</span>
            ${isAssignedToMe ? '<span class="your-role-badge">YOUR ROLE</span>' : ''}
          </div>
        </td>
        <td><span class="char-line-count">${charCounts[char] || 0} lines</span></td>
        <td>
          <div class="cast-assign-cell">
            <span class="actor-color-dot ${assignedUser ? 'active' : 'unassigned'}" 
                  style="background-color: ${assignedUser ? escapeHtml(assignedUser.color) : 'transparent'};" 
                  title="${assignedUser ? escapeHtml(assignedUser.name) : 'Unassigned'}" 
                  aria-hidden="true"></span>
            <select class="cast-select" 
                    id="cast-select-${escapeHtml(safeCharId)}" 
                    data-char="${escapeHtml(char)}" 
                    aria-label="Assign actor for ${escapeHtml(char)}">
              <option value="">-- Unassigned (Original Voice) --</option>
              ${users.map(u => `
                <option value="${escapeHtml(u.id)}" ${assignedIds.includes(u.id) ? 'selected' : ''}>
                  ${escapeHtml(u.name)} ${u.id === this.user.id ? '(You)' : ''}
                </option>
              `).join('')}
            </select>
          </div>
        </td>
      `;

      const select = tr.querySelector('.cast-select');
      select.addEventListener('change', (e) => {
        const val = e.target.value;
        const newIds = val ? [val] : [];
        if (this.roomState && this.roomState.role_assignments) {
          this.roomState.role_assignments[char] = newIds;
          this.renderCastActivityHUD();
        }
        this.socket.assignRole(char, newIds);
      });

      this.castingTbody.appendChild(tr);
    });
  }

  /**
   * Strict by default: only the real host. allowDummy also accepts the legacy
   * 'host' placeholder id that rooms restored from disk can carry.
   */
  isHost({ allowDummy = false } = {}) {
    const hostId = this.roomState?.host_id;
    return this.user.id === hostId || (allowDummy && hostId === 'host');
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
    this.badgeGainMatch.innerText = isMatched ? `✓ ${label} (Matched)` : `${label} (Scene Target)`;
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
      ? (myAssignedLines.length > 0 ? `Your Line ${myLinePos} / ${myAssignedLines.length} (Scene Line ${index + 1})` : `Scene Line ${index + 1} / ${this.roomState.pack.lines.length}`)
      : `Scene Line ${index + 1} / ${this.roomState.pack.lines.length} (Locked)`;

    const lineDur = (line.duration !== undefined ? line.duration : Math.max(0.5, (line.end || 0) - (line.start || 0)));
    this.boothTimeBadge.innerText = `${(line.start || 0).toFixed(2)}s - ${(line.end || 0).toFixed(2)}s (${lineDur.toFixed(2)}s)`;
    this.stageCaptionChar.innerText = isMyLine ? line.character.toUpperCase() : `${line.character.toUpperCase()} (LOCKED)`;
    const lineCap = (line.caption || line.text || '').trim();
    this.stageCaptionText.innerText = lineCap ? `“${lineCap}”` : `(${line.character} vocal line)`;

    const take = this.roomState.takes[index];
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
          this.badgeGainMatch.title = `Take Speech Loudness: ${take.speech_loudness_db || '-'} dBFS (Scene Target: ${take.target_loudness_db || '-'} dBFS)`;
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
      if (this.takePeaksCache?.has(index)) {
        takePeaks = this.takePeaksCache.get(index);
      } else {
        // Asynchronously fetch compact peaks from dedicated endpoint
        fetch(`/api/rooms/${this.roomState.room_id}/takes/${index}/peaks`)
          .then(r => r.ok ? r.json() : null)
          .then(pData => {
            if (pData && pData.peaks && pData.peaks.length > 0 && currentSeq === this.loadLineSeq) {
              if (!this.takePeaksCache) this.takePeaksCache = new Map();
              this.takePeaksCache.set(index, pData.peaks);
              if (this.roomState?.takes?.[index]) {
                this.roomState.takes[index].peaks = pData.peaks;
              }
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
            this.takePeaksCache.set(index, takePeaks);
            if (this.roomState?.takes?.[index]) {
              this.roomState.takes[index].peaks = takePeaks;
            }
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
        this.btnNextLine.innerHTML = '<span>I\'m Finished ✓</span>';
        this.btnNextLine.className = 'btn btn-success btn-sm btn-finished-pulse';
        this.btnNextLine.setAttribute('title', "All lines reviewed! Mark yourself ready for Premiere");
      } else {
        this.btnNextLine.innerHTML = '<span>Next Line ›</span>';
        this.btnNextLine.className = 'btn btn-primary btn-sm';
        this.btnNextLine.setAttribute('title', "Go to next dialogue line");
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
      const nTake = this.roomState.takes?.[nIdx];
      if (nTake && nTake.url) {
        this.audio.loadAudioBuffer(nTake.url).catch(() => { });
      }
    }
  }

  updateRecordButtonUI(take = null) {
    if (!take) {
      take = this.roomState?.takes?.[this.currentLineIndex];
    }

    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const isMyLine = this.canRecordLine(line);

    if (!isMyLine) {
      this.btnRecordMain.className = 'btn-big-record locked';
      this.recordIcon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      const assignedIds = (this.roomState?.role_assignments?.[line?.character] || []);
      const assignedNames = assignedIds.map(uid => this.roomState?.users?.[uid]?.name).filter(Boolean);
      const actorText = assignedNames.length > 0 ? assignedNames.join(', ') : 'Another actor';
      this.recordStatusLabel.innerText = `Assigned to ${line?.character} (${actorText}) — Read Only`;
      return;
    }

    if (this.recordState === 'recording') {
      this.btnRecordMain.className = 'btn-big-record recording';
      this.recordIcon.innerText = '■';
      this.recordStatusLabel.innerText = "Recording Live... Click or Space to Stop";
    } else if (this.recordState === 'countdown') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerText = '✕';
      this.recordStatusLabel.innerText = "Counting in... Click to Cancel";
    } else if (this.recordState === 'processing') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerHTML = `<span class="spinning" style="display:inline-flex;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg></span>`;
      this.recordStatusLabel.innerText = "Saving take...";
    } else {
      this.btnRecordMain.className = 'btn-big-record';
      if (take) {
        this.recordIcon.innerText = '↺';
        this.recordStatusLabel.innerText = `Recorded by ${take.user_name} (${take.duration}s)`;
      } else {
        this.recordIcon.innerText = '●';
        this.recordStatusLabel.innerText = 'Click or Press Space to Record';
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
      const hasTake = !!(this.roomState.takes && this.roomState.takes[idx]);
      const isActive = idx === this.currentLineIndex;

      chip.className = `chip-item ${isActive ? 'active' : ''} ${hasTake ? 'done' : ''} ${isMyLine ? 'my-line' : ''}`;
      chip.title = `Line ${idx + 1}: ${l.character} (${l.start}s - ${l.end}s) ${hasTake ? '✓ Take Recorded' : ''}`;
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
    const take = this.roomState?.takes?.[this.currentLineIndex];

    if (!take || !take.url) {
      this.showToast("No take recorded yet for this line!");
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
      this.showToast("⏳ Loading take audio... Please retry in a moment.");
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
    const comp = this.checkCompressor.checked;

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
      enableCompressor: comp,
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

    if (this.roomState && this.roomState.takes && this.roomState.takes[lineIdx]) {
      this.roomState.takes[lineIdx].offset_ms = offsetMs;
      this.roomState.takes[lineIdx].pitch_semitones = pitch;
      this.roomState.takes[lineIdx].reverb_wet = reverb;
      this.roomState.takes[lineIdx].gain_db = gain;
    }

    this.socket.updateTakeParams(lineIdx, {
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

    const currentTake = this.roomState?.takes?.[this.currentLineIndex];
    if (currentTake && this.views.booth.classList.contains('active') && !this.isProcessingTake) {
      this.toggleTakeNoiseReduction(this.currentLineIndex, this.applyNoiseReduction);
    }
  }

  async calibrateMicNoiseProfile() {
    if (this.isCalibratingMic) return;
    if (!this.roomState) {
      this.showToast("Please join or create a session before calibrating.");
      return;
    }
    if (!(await this.ensureMicReady())) return;

    this.isCalibratingMic = true;
    const btn = this.btnCalibrateMic;
    const origIcon = this.calibrateIcon ? this.calibrateIcon.innerText : '🎯';
    const origLabel = this.calibrateLabel ? this.calibrateLabel.innerText : 'Calibrate Mic (3s Quiet)';

    if (btn) {
      btn.disabled = true;
      btn.classList.add('calibrating-pulse');
    }
    if (this.calibrateIcon) this.calibrateIcon.innerText = '🤫';
    if (this.calibrateLabel) this.calibrateLabel.innerText = 'Calibrating...';

    // 1. Open the Calibration Modal
    if (this.modalMicCalibration) {
      this.modalMicCalibration.style.display = 'flex';
      if (this.calibModalBadge) this.calibModalBadge.innerText = 'PRE-ROLL (1s)';
      if (this.calibModalTitle) this.calibModalTitle.innerText = 'Microphone Room Calibration';
      if (this.calibModalStatus) this.calibModalStatus.innerText = 'Get ready... Releasing mouse click and preparing room tone sample.';
      if (this.calibTimerText) this.calibTimerText.innerText = '1.0s';
      if (this.calibPhaseText) this.calibPhaseText.innerText = 'Phase 1: Pre-Roll Delay (Mouse Release)';
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
          if (this.calibPhaseText) this.calibPhaseText.innerText = 'Phase 1: 1s Pre-Roll Delay (Mouse Release)';
          if (this.calibProgressBar) this.calibProgressBar.style.width = `${percent}%`;
          if (this.calibModalBadge) this.calibModalBadge.innerText = 'PRE-ROLL (1s)';
          if (this.calibModalStatus) this.calibModalStatus.innerText = '🤫 Get ready: Releasing mouse click and quieting room...';
          if (this.calibModalIcon) this.calibModalIcon.innerText = '🤫';
        } else if (phase === 'recording') {
          if (this.calibTimerText) this.calibTimerText.innerText = `${remainingSec}s`;
          if (this.calibPhaseText) this.calibPhaseText.innerText = 'Phase 2: Sampling Room Tone (Stay Quiet)';
          if (this.calibProgressBar) this.calibProgressBar.style.width = `${percent}%`;
          if (this.calibModalBadge) this.calibModalBadge.innerText = 'SAMPLING (3s)';
          if (this.calibModalStatus) this.calibModalStatus.innerText = '🎙️ Listening to room tone (fan hum, AC, mic hiss)...';
          if (this.calibModalIcon) this.calibModalIcon.innerText = '🎙️';
          if (this.calibRadarRing) this.calibRadarRing.className = 'calib-radar-ring active-radar';
        }
      });

      if (!blob || blob.size < 32) {
        throw new Error("No audio captured from microphone.");
      }

      if (this.calibModalBadge) this.calibModalBadge.innerText = 'ANALYZING';
      if (this.calibModalStatus) this.calibModalStatus.innerText = 'Computing spectral noise fingerprint via FFT...';
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
      if (this.calibModalTitle) this.calibModalTitle.innerText = 'Microphone Calibrated!';
      if (this.calibModalStatus) this.calibModalStatus.innerText = `✨ Custom noise fingerprint saved (${data.noise_floor_db || -30} dB floor).`;
      if (this.calibModalIcon) this.calibModalIcon.innerText = '✨';

      if (this.badgeNoiseStatus) {
        this.badgeNoiseStatus.innerText = '✨ Calibrated ✓';
        this.badgeNoiseStatus.className = 'badge-calibrated calibrated';
        this.badgeNoiseStatus.title = `Calibrated custom noise profile (${data.noise_floor_db || -30} dB floor)`;
      }

      if (this.btnResetNoiseProfile) {
        this.btnResetNoiseProfile.style.display = 'inline-flex';
      }

      this.showToast("✨ Microphone noise profile calibrated (1s delay + 3s room sample)!");

      // If active line has a take with noise reduction enabled, re-apply with new profile
      const take = this.roomState?.takes?.[this.currentLineIndex];
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
        this.showToast("Mic calibration cancelled.");
      } else {
        console.warn("[App] Calibration failed:", err);
        this.showToast(`⚠️ ${this.friendlyError(err, "Mic calibration didn't finish. Please try again.")}`);
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
    if (this.calibrateLabel) this.calibrateLabel.innerText = 'Calibrate Mic (3s Quiet)';
  }

  resetMicNoiseProfile() {
    this.hasCustomNoiseProfile = false;
    if (this.badgeNoiseStatus) {
      this.badgeNoiseStatus.innerText = '● Auto-Tracking';
      this.badgeNoiseStatus.className = 'badge-calibrated uncalibrated';
      this.badgeNoiseStatus.title = 'Using intelligent automatic FFT noise floor tracking';
    }
    if (this.btnResetNoiseProfile) {
      this.btnResetNoiseProfile.style.display = 'none';
    }
    this.showToast("Microphone profile reset to automatic FFT tracking.");

    const take = this.roomState?.takes?.[this.currentLineIndex];
    if (take && this.applyNoiseReduction && !this.isProcessingTake) {
      this.toggleTakeNoiseReduction(this.currentLineIndex, true);
    }
  }

  async toggleTakeNoiseReduction(lineIndex, enable) {
    if (!this.roomState || !this.roomState.takes || !this.roomState.takes[lineIndex]) {
      return;
    }

    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/takes/${lineIndex}/noise_reduction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noise_reduction: enable }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.take) {
        this.roomState.takes[lineIndex] = data.take;
      }

      this.audio.evictTakeCache(lineIndex);

      if (lineIndex === this.currentLineIndex) {
        const line = this.roomState.pack.lines[lineIndex];
        const take = this.roomState.takes[lineIndex];
        let origPeaks = line.peaks || [];
        let takePeaks = take ? (take.peaks || []) : [];

        this.setWaveformForLine(line, take, origPeaks, takePeaks);

        if (take && take.url) {
          const newBuf = await this.audio.loadAudioBuffer(take.url, true);
          this.currentTakeBuffer = newBuf;
          if (newBuf && (!takePeaks || takePeaks.length === 0)) {
            takePeaks = WaveformRenderer.extractPeaksFromBuffer(newBuf, 100);
            this.setWaveformForLine(line, take, origPeaks, takePeaks);
          }
        }
      }

      this.showToast(enable ? "✨ Studio Noise Reduction applied to take!" : "Raw original take restored (Noise Reduction OFF)");
    } catch (err) {
      console.warn("[App] Error toggling take noise reduction:", err);
      this.showToast(`⚠️ ${this.friendlyError(err, "Couldn't change the noise reduction setting.")}`);
    }
  }

  async toggleRecording() {
    if (!this.roomState) return;
    const line = this.roomState.pack.lines[this.currentLineIndex];
    const isMyLine = this.canRecordLine(line);
    if (!isMyLine) {
      this.showToast(`🔒 Line ${this.currentLineIndex + 1} is assigned to ${line.character}. You cannot record over it.`);
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
      this.showToast("Saving previous take... please wait.");
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
      this.overlayStatusText.innerText = "GET READY...";

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
    this.overlayCountdown.innerText = "GO!";
    this.overlayStatusText.innerText = "RECORDING...";

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
        this.boothProcessingTitle.innerText = "✨ AI Voice Clean (DeepFilterNet 3)...";
      } else {
        this.boothProcessingTitle.innerText = "🎙️ Processing Voice Take";
      }
    }
    if (this.boothProcessingSub) {
      if (this.applyNoiseReduction) {
        this.boothProcessingSub.innerText = "Deep neural filtering isolating voice, removing room fans & AC...";
      } else {
        this.boothProcessingSub.innerText = "Transcoding audio, computing waveform peaks & saving to session...";
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
      this.showToast("No audio recorded.");
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

    const formData = new FormData();
    formData.append('file', blob, `take_${lineIndex}.webm`);
    formData.append('user_id', this.user.id);
    formData.append('user_name', this.user.name);
    formData.append('offset_ms', offsetMs);
    formData.append('pitch_semitones', pitch);
    formData.append('reverb_wet', reverb);
    formData.append('gain_db', gain);
    formData.append('noise_reduction', this.applyNoiseReduction ? 'true' : 'false');

    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/takes/${lineIndex}`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();
      if (data.take) {
        if (!this.roomState.takes) this.roomState.takes = {};
        this.roomState.takes[lineIndex] = data.take;
        // If gain wasn't manually altered away from 0, auto-apply the calculated scene gain
        if (gain === 0 && data.take.auto_gain_db !== undefined && data.take.auto_gain_db !== 0) {
          data.take.gain_db = data.take.auto_gain_db;
          this.sliderGain.value = data.take.auto_gain_db;
          this.valGain.innerText = (data.take.auto_gain_db > 0 ? '+' : '') + data.take.auto_gain_db + ' dB';
          this.audio.setGain(data.take.auto_gain_db);
          this.syncTakeParams();
        }
      }
      this.audio.evictTakeCache(lineIndex);
      if (recordedBuffer) {
        this.currentTakeBuffer = recordedBuffer;
        if (data.take && data.take.url) {
          this.screeningBuffers.set(data.take.url, recordedBuffer);
        }
      }
      this.showToast("Take recorded & saved! 🎙️");
      await this.loadBoothLine(lineIndex);
    } catch (err) {
      this.recordState = 'idle';
      this.updateRecordButtonUI();
      this.showToast(this.friendlyError(err, "That take didn't save. Please record it again."));
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
      this.showToast("🎉 You're marked Ready for the Premiere! 🍿");
    }

    const isHost = this.isHost({ allowDummy: true });
    if (isHost) {
      const users = Object.values(this.roomState?.users || {}).filter(u => u.is_online);
      const readyCount = users.filter(u => u.is_ready).length;
      if (confirm(`🎉 All your lines are complete! ${readyCount}/${users.length} cast members are marked Ready.\n\nProceed to the Premiere Screening Theater now?`)) {
        this.showView('screening');
        this.setupScreeningView();
        this.broadcastMyStatus('screening');
      }
    } else {
      this.showToast("🎉 Great job! All your lines are finished. Waiting for Room Host to begin the Premiere!");
    }
  }

  clearCurrentTake() {
    if (this.isProcessingTake) return;
    this.cancelCurrentCountdown();
    if (confirm("Are you sure you want to clear this take?")) {
      this.socket.clearTake(this.currentLineIndex);
      this.audio.evictTakeCache(this.currentLineIndex);
      delete this.roomState.takes[this.currentLineIndex];
      this.loadBoothLine(this.currentLineIndex);
    }
  }
}

mixin(DubMateApp, AudioSetupMethods, ExportMethods, ScreeningMethods);

// Instantiate on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new DubMateApp();
  });
} else {
  new DubMateApp();
}
