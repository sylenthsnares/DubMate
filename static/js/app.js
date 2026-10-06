// app.js - High-Performance Studio Controller with Bulletproof Lifecycle, Non-Blocking Screening & Fast DSP
import { AudioEngine } from './audio_engine.js';
import { WaveformRenderer } from './waveform.js';
import { RoomSocket } from './room_socket.js';
import { initAllKnobs } from './knob.js';
import { showToast, initModeDropdown, initTooltips, mixin } from './ui_common.js';
import { AudioSetupMethods } from './studio/audio_setup.js';
import { ExportMethods } from './studio/export.js';
import { ScreeningMethods } from './studio/screening.js';
import { BoothMethods } from './studio/booth.js';
import { VoiceRackMethods } from './studio/voice_rack.js';
import { MicSyncMethods } from './studio/mic_sync.js';
import { RoomCheckMethods } from './studio/room_check.js';
import { PackMethods } from './studio/packs.js';
import { LobbyMethods, isLoopbackOrigin, getHomeOrigin, captureHomeOriginParam } from './studio/lobby.js';
import { TAKE_STATE_VERSION, lineTakes } from './studio/takes.js';

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
    this.recordingGuideVoice = false; // guide-voice checkbox as it was when the current take started
    this.countdownSessionId = 0;
    this.recordingTimeout = null;
    this.filterMyLinesOnly = true;

    // Screening & Premiere State
    this.screeningBuffers = new Map();
    // Picked takes' renders for the live premiere, keyed by take audio + resolved chain.
    this.screeningRenders = new Map();
    this.screeningLineLevels = [];
    this.isPreloadingScreening = false;
    this.isReadyForScreening = false;

    // Noise Reduction State
    this.applyNoiseReduction = localStorage.getItem('dubmate_noise_reduction') !== 'false';
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
    this.stopTakeVoice();
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
    if (this.screeningRenders) this.screeningRenders.clear();
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
      left: document.getElementById('view-left'),
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
    this.inputLeftRoomCode = document.getElementById('input-left-room-code');
    this.btnLeftJoinRoom = document.getElementById('btn-left-join-room');

    // Lobby elements
    this.lobbyPackTitle = document.getElementById('lobby-pack-title');
    this.lobbyLineCount = document.getElementById('lobby-line-count');
    this.castingTbody = document.getElementById('casting-tbody');
    this.lobbyCastList = document.getElementById('lobby-cast-list');
    this.castOnlineCount = document.getElementById('cast-online-count');
    this.btnStartSession = document.getElementById('btn-start-session');
    this.btnCopyInvite = document.getElementById('btn-copy-invite');

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
    this.btnTakeHistory = document.getElementById('btn-take-history');
    this.takeHistoryPanel = document.getElementById('take-history-panel');
    this.btnPlayOrig = document.getElementById('btn-play-orig');
    this.btnPreviewTake = document.getElementById('btn-preview-take');
    this.sliderNudge = document.getElementById('slider-nudge');
    this.nudgeDisplay = document.getElementById('nudge-display');
    this.timingCaption = document.getElementById('timing-caption');
    this.btnOriginalSpeed = document.getElementById('btn-original-speed');
    // Level (the Voice panel's other controls: voice_rack.js initVoiceRackEvents)
    this.sliderGain = document.getElementById('slider-gain');
    this.valGain = document.getElementById('val-gain');

    // Studio Noise Reduction Elements
    this.checkLobbyNoiseReduction = document.getElementById('check-lobby-noise-reduction');
    this.checkNoiseReduction = document.getElementById('check-noise-reduction');
    this.checkRackNoiseReduction = document.getElementById('check-rack-noise-reduction');
    this.boothProcessingTitle = document.getElementById('booth-processing-title');
    this.boothProcessingSub = document.getElementById('booth-processing-sub');

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
    this.packBuilderRow = document.getElementById('packbuilder-row');
    this.packBuilderSizeNote = document.getElementById('packbuilder-size-note');
    this.packBuilderRemoveConfirm = document.getElementById('packbuilder-remove-confirm');
    this.packBuilderRemoveFeedback = document.getElementById('packbuilder-remove-feedback');
    this.btnRemovePackBuilder = document.getElementById('btn-remove-packbuilder');
    this.btnRemovePackBuilderText = document.getElementById('btn-remove-packbuilder-text');
    this.btnCancelRemovePackBuilder = document.getElementById('btn-cancel-remove-packbuilder');
    this.btnConfirmRemovePackBuilder = document.getElementById('btn-confirm-remove-packbuilder');
    this.micSyncStatus = document.getElementById('mic-sync-status');
    this.btnMicSync = document.getElementById('btn-mic-sync');
    this.micSyncPanel = document.getElementById('mic-sync-panel');
    this.micSyncMessage = document.getElementById('mic-sync-message');
    this.btnStartMicSync = document.getElementById('btn-start-mic-sync');
    this.btnStartClapping = document.getElementById('btn-start-clapping');
    this.btnCancelMicSync = document.getElementById('btn-cancel-mic-sync');
    this.roomCheckStatus = document.getElementById('room-check-status');
    this.btnRoomCheck = document.getElementById('btn-room-check');
    this.roomCheckPanel = document.getElementById('room-check-panel');
    this.roomCheckMessage = document.getElementById('room-check-message');
    this.roomCheckProgress = document.getElementById('room-check-progress');
    this.roomCheckProgressFill = document.getElementById('room-check-progress-fill');
    this.btnStartRoomCheck = document.getElementById('btn-start-room-check');
    this.btnCancelRoomCheck = document.getElementById('btn-cancel-room-check');
    this.roomCheckCard = document.getElementById('room-check-card');
    this.roomCheckVerdict = document.getElementById('room-check-verdict');
    this.roomCheckLight = document.getElementById('room-check-light');
    this.roomCheckWord = document.getElementById('room-check-word');
    this.roomCheckSentence = document.getElementById('room-check-sentence');
    this.roomCheckAdvice = document.getElementById('room-check-advice');
    this.btnRoomCheckStandard = document.getElementById('btn-room-check-standard');
    this.roomCheckLoud = document.getElementById('room-check-loud');
    this.roomCheckLoudResult = document.getElementById('room-check-loud-result');
    this.btnRoomLoudLine = document.getElementById('btn-room-loud-line');
    this.roomCheckRefresh = document.getElementById('room-check-refresh');
    this.roomCheckRefreshText = document.getElementById('room-check-refresh-text');
    this.btnRoomCheckRefresh = document.getElementById('btn-room-check-refresh');

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
    this.btnDownloadStems = document.getElementById('btn-download-stems');
    this.btnToolbarStems = document.getElementById('btn-toolbar-stems');
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
        btn.dataset.tip = expanded ? 'Collapse video' : 'Expand video';
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
    initTooltips();
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
    if (this.btnLeftJoinRoom) {
      this.btnLeftJoinRoom.addEventListener('click', () => this.joinRoomFromInput(this.inputLeftRoomCode));
    }
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
      if (tag) tag.innerText = e.target.checked ? 'ON' : 'OFF';
    });

    if (this.checkGuideVoice) {
      this.checkGuideVoice.addEventListener('change', (e) => {
        const tag = document.getElementById('tag-guide-voice');
        if (tag) tag.innerText = e.target.checked ? 'ON' : 'OFF';
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
          // Auto: back to the take's automatic timing (0 for takes from before it existed).
          const autoMs = this.takeForLine(this.currentLineIndex)?.auto_offset_ms;
          this.setNudgeValue(typeof autoMs === 'number' ? autoMs : 0, true);
        } else {
          const current = parseInt(this.sliderNudge.value, 10);
          this.setNudgeValue(current + parseInt(val, 10), true);
        }
      });
    });

    // Level is not an effect: a gain after the take's sound, sent with its timing.
    this.sliderGain.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.valGain.innerText = (val > 0 ? '+' : '') + val + ' dB';
      const take = this.takeForLine(this.currentLineIndex);
      if (take && take.auto_gain_db !== undefined) this.renderGainMatchBadge(take, val);
      this.audio.setGain(val);
      this.syncTakeParams();
    });

    if (this.btnAutoMatchGain) {
      this.btnAutoMatchGain.addEventListener('click', () => {
        const take = this.takeForLine(this.currentLineIndex);
        if (take && take.auto_gain_db !== undefined) {
          const targetGain = parseFloat(take.auto_gain_db);
          this.sliderGain.value = targetGain;
          this.valGain.innerText = (targetGain > 0 ? '+' : '') + targetGain + ' dB';
          this.audio.setGain(targetGain);
          this.syncTakeParams();
          this.renderGainMatchBadge(take, targetGain);
          this.showToast(`Level matched to the original (${targetGain >= 0 ? '+' : ''}${targetGain} dB)`);
        }
      });
    }

    this.btnPrevLine.addEventListener('click', () => this.stepLine(-1));
    this.btnNextLine.addEventListener('click', () => this.stepLine(1));
    this.btnClearTake.addEventListener('click', () => this.clearCurrentTake());
    this.btnTakeHistory.addEventListener('click', () => this.toggleTakeHistory());
    this.btnOriginalSpeed?.addEventListener('click', () => this.playAtOriginalSpeed());

    // Studio Noise Reduction Synchronization Listeners
    const onNoiseToggleChange = (e) => {
      this.setNoiseReduction(e.target.checked);
    };

    if (this.checkLobbyNoiseReduction) {
      this.checkLobbyNoiseReduction.checked = this.applyNoiseReduction;
      this.checkLobbyNoiseReduction.addEventListener('change', onNoiseToggleChange);
    }
    if (this.checkNoiseReduction) {
      this.checkNoiseReduction.checked = this.applyNoiseReduction;
      this.checkNoiseReduction.addEventListener('change', onNoiseToggleChange);
    }
    if (this.checkRackNoiseReduction) {
      this.checkRackNoiseReduction.checked = this.applyNoiseReduction;
      this.checkRackNoiseReduction.addEventListener('change', onNoiseToggleChange);
    }

    this.initAudioSettingsEvents();
    this.initMicSyncEvents();
    this.initVoiceRackEvents();
    this.initRoomCheckEvents();

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
      this.showToast("You're offline. That change wasn't saved.");
    });

    // Socket events
    // room_socket emits the typed event before '*', so every typed handler that
    // reads this.roomState merges the incoming state first. The merge is
    // idempotent, so running it again here is harmless.
    this.socket.on('*', (data) => {
      if (data.state) {
        if (!this.applyIncomingState(data)) return;
        this.syncRefreshingFromState();

        if (this.currentView === 'lobby') {
          this.renderLobbyState();
        }
        if (this.currentView === 'booth') {
          this.renderTimelineChips();
          this.renderTakeHistory();
        }
        this.renderCastActivityHUD();
        this.updateScreeningControls();
      }
    });

    this.socket.on('user_status_updated', (data) => {
      if (!this.applyIncomingState(data)) return;
      if (this.roomState && data.payload?.user) {
        this.roomState.users[data.payload.user_id] = data.payload.user;
        this.renderCastActivityHUD();
      }
    });

    this.socket.on('take_recorded', async (data) => {
      if (!this.applyIncomingState(data)) return;
      const lineIdx = data.payload?.line_index;
      const take = this.takeForLine(lineIdx);
      // Invalidate old take buffer from audio engine cache immediately
      this.audio.evictTakeCache(take);

      // Preload updated buffer for instant premiere playback
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

      const userName = data.payload?.user_name || take?.user_name || 'Cast member';
      if (data.payload?.user_id === this.user.id) {
        this.showToast("Take saved");
      } else {
        this.showToast(`${userName} recorded line ${(lineIdx !== undefined ? lineIdx + 1 : '')}`);
      }
    });

    // Someone put another take in the dub, or deleted one: the line now plays a different take.
    const onTakeChanged = (data) => {
      const lineIdx = data.payload?.line_index;
      if (data.type === 'take_deleted') {
        // Look the take up before the new state drops it
        const line = this.roomState?.pack?.lines?.[lineIdx];
        this.audio.evictTakeCache(lineTakes(this.roomState?.takes, line).find((t) => t.take_id === data.payload?.take_id));
      }
      if (!this.applyIncomingState(data)) return;
      if (lineIdx === this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
      this.renderTimelineChips();
      this.renderCastActivityHUD();
    };
    this.socket.on('take_picked', onTakeChanged);
    this.socket.on('take_deleted', onTakeChanged);

    // The engine matched levels again after a sound change; a take that sat at its
    // matched level moved with it, so show the current take's new level.
    this.socket.on('levels_updated', (data) => {
      if (!this.applyIncomingState(data)) return;
      const take = this.currentView === 'booth' && this.takeForLine(this.currentLineIndex);
      if (!take || !(data.payload?.takes || []).some((t) => t.take_id === take.take_id)) return;
      this.showTakeLevel(take);
    });

    // Someone changed a character's or every line's sound, or a take's: play what now applies.
    this.socket.on('voice_updated', (data) => {
      if (this.applyIncomingState(data)) this.onRoomVoiceChanged();
    });
    this.socket.on('take_params_updated', (data) => {
      if (this.applyIncomingState(data)) this.onRoomVoiceChanged();
    });

    this.socket.on('status_changed', (data) => {
      if (!this.applyIncomingState(data)) return;
      const newStatus = data.payload?.status || data.status;
      if (newStatus === 'recording' && this.currentView === 'lobby') {
        this.showView('booth');
        this.loadBoothLine(this.findFirstAssignedLine());
        this.showToast("Recording has started");
      } else if (newStatus === 'screening' && this.currentView !== 'screening') {
        this.showView('screening');
        this.setupScreeningView();
      }
    });

    this.socket.on('warp_to_screening', (data) => {
      if (!this.applyIncomingState(data)) return;
      this.cancelCurrentCountdown();
      if (this.crumbPremiereLive) {
        this.crumbPremiereLive.style.display = 'inline-block';
      }
      this.showView('screening');
      this.setupScreeningView();
      this.broadcastMyStatus('screening');
      this.showToast("The premiere is starting");
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
        this.updateExportModalStep(1, 30, "Mixing your takes with the scene…");
      }
    });

    this.socket.on('export_ready', (data) => {
      if (!this.applyIncomingState(data)) return;
      const payload = data.payload || data;
      if (payload && (payload.download_url || payload.export_video_url || payload.download_url_16_9)) {
        this.handleExportSuccess(payload);
        this.showToast("The dubbed video is ready");
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

    this.socket.on('cleanup_refreshed', (data) => this.onCleanupRefreshed(data));

    this.socket.on('dialogue_presence_sync', (data) => {
      const pres = parseFloat(data.payload?.presence_db ?? 0.0);
      this.masterDialoguePresence = pres;
      this.renderPresenceUI(pres);
      this.applyScreeningPresence();
    });
  }

  /**
   * Merges a socket message's room state into this.roomState. Local take peaks
   * are kept when the incoming take carries none, and the local line is always
   * kept. Safe to call more than once for the same message.
   * Returns false, and changes nothing, when the state comes from a different
   * DubMate version than this page (a tab left open across an update).
   */
  applyIncomingState(data) {
    if (!data || !data.state) return false;
    const incoming = data.state;
    if (incoming.state_version !== TAKE_STATE_VERSION) {
      this.showStaleTabNotice();
      return false;
    }
    if (!this.roomState) {
      this.roomState = incoming;
    } else {
      // Only the picked take carries peaks; keep the ones this tab already has.
      const knownPeaks = new Map();
      for (const entry of Object.values(this.roomState.takes || {})) {
        for (const take of entry?.takes || []) {
          if (take.peaks && take.peaks.length > 0) knownPeaks.set(take.take_id, take.peaks);
        }
      }
      const mergedTakes = {};
      for (const [lineId, entry] of Object.entries(incoming.takes || {})) {
        mergedTakes[lineId] = {
          ...entry,
          takes: (entry.takes || []).map((take) => ({
            ...take,
            peaks: (take.peaks && take.peaks.length > 0) ? take.peaks : (knownPeaks.get(take.take_id) || []),
          })),
        };
      }

      this.roomState = {
        ...this.roomState,
        ...incoming,
        pack: incoming.pack || this.roomState.pack,
        users: incoming.users || this.roomState.users,
        role_assignments: incoming.role_assignments || this.roomState.role_assignments,
        takes: mergedTakes,
        // Each actor moves through lines at their own pace
        current_line: this.currentLineIndex,
      };
    }
    return true;
  }

  /** A persistent notice for a tab whose code is older or newer than the room's engine. */
  showStaleTabNotice() {
    this.isStaleTab = true;
    const banner = document.getElementById('connection-banner');
    const text = document.getElementById('connection-banner-text');
    if (!banner || !text) return;
    clearTimeout(this._connectionBannerTimer);
    banner.classList.remove('is-recovered');
    banner.style.display = 'flex';
    text.innerText = 'DubMate was updated. Reload this page to keep going.';
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
      this.showToast('Video size reset');
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
        this.showToast('Video size reset');
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
    this.loadEngineMicSync();

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
        await this.selectPack(selectPackParam);
        const url = new URL(window.location.href);
        url.searchParams.delete('select_pack');
        window.history.replaceState(window.history.state, '', url);
      }
    }
  }

  showView(viewName) {
    // The home screen lists the packs of the engine serving this page. On a
    // host's tunnel page that is the host's engine, so go back to our own.
    if (viewName === 'landing' && this.goHome()) return;
    // A browser guest who left stays on the "You left" view (a failed rejoin
    // must not fall back to the host's home screen).
    if (viewName === 'landing' && this.currentView === 'left') viewName = 'left';
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
    if (!confirm('Leave this room?')) return false;
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
    const wasHost = this.isHost();
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

    // A guest who joined from a plain browser link has no DubMate of their own
    // to go back to, and the home screen here would list the host's packs.
    if (!wasHost && !getHomeOrigin()) {
      this.showView('left');
      return;
    }
    this.showView('landing');
    this.showToast('You left the room');
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
  friendlyError(err, fallback = "Something went wrong. Try again.") {
    const raw = String(err?.message ?? err ?? '').trim();
    if (raw) console.warn('[DubMate] Underlying error:', raw);
    if (!raw) return fallback;

    const known = [
      [/still rendering|409/i,
        "The video is still rendering. Try again when it's ready."],
      [/failed to fetch|networkerror|load failed|err_connection/i,
        "Couldn't reach DubMate. Check your connection and try again."],
      [/timed out|timeout|etimedout/i,
        "That took too long. Try again."],
      [/room not found|no active session|session has ended/i,
        "That session has ended. Start a new room to continue."],
      [/not found|404/i,
        "That file is no longer available. Try creating it again."],
      [/no space|disk full|enospc/i,
        "Your disk is full. Free up some space and try again."],
      [/permission|denied|eacces|not allowed/i,
        "DubMate doesn't have permission to do that. Check that the folder or file isn't read-only."],
      [/zip.?slip|path traversal|compression ratio|zip bomb/i,
        "That pack file looks corrupted or unsafe, so it wasn't imported."],
      [/yt-dlp|requirements_builder|pip install/i,
        "Pack Builder isn't installed. Run the DubMate installer again and tick Pack Builder."],
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
    if (this.isStaleTab) return; // the reload notice stays up
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
      text.innerText = `Reconnecting in ${seconds}s. Changes aren't saved until then.`;
    } else if (state === 'connecting') {
      text.innerText = 'Connecting…';
    } else {
      text.innerText = "Disconnected. You're no longer in the room.";
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

  /**
   * Strict by default: only the real host. allowDummy also accepts the legacy
   * 'host' placeholder id that rooms restored from disk can carry.
   */
  isHost({ allowDummy = false } = {}) {
    const hostId = this.roomState?.host_id;
    return this.user.id === hostId || (allowDummy && hostId === 'host');
  }

  /**
   * True when this page is served by an engine on this same computer (the desktop
   * app's loopback origin), so renders already land in this user's export folder.
   * False for anyone reaching the engine through a tunnel or LAN address.
   */
  isEngineLocal() {
    return isLoopbackOrigin(window.location.origin);
  }
}

mixin(DubMateApp, AudioSetupMethods, ExportMethods, ScreeningMethods, BoothMethods, VoiceRackMethods, MicSyncMethods, RoomCheckMethods, PackMethods, LobbyMethods);

// Instantiate on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new DubMateApp();
  });
} else {
  new DubMateApp();
}
