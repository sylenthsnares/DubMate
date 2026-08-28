// app.js - High-Performance Studio Controller with Bulletproof Lifecycle, Non-Blocking Screening & Fast DSP
import { AudioEngine } from './audio_engine.js';
import { WaveformRenderer } from './waveform.js';
import { RoomSocket } from './room_socket.js';
import { initAllKnobs } from './knob.js';

class DubMateApp {
  constructor() {
    this.audio = new AudioEngine();
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
    this.currentTakeBlob = null;
    this.currentTakeBuffer = null;
    this.backingBuffer = null;
    this.origBuffer = null;

    // Countdown & Recording Mutex
    this.currentLineIndex = 0;
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

    this.initDOM();
    this.initEvents();
    this.initRouter();
    window.dubMateApp = this;
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
    this.boothCharacterBadge = document.getElementById('booth-character-badge');
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

    // Booth & Import Loading Overlays
    this.boothProcessingOverlay = document.getElementById('booth-processing-overlay');
    this.modalImportLoading = document.getElementById('modal-import-loading');

    // Global Interaction Lock Flags
    this.isRenderingExport = false;
    this.isProcessingTake = false;

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
      btnLeaveRoom.addEventListener('click', () => {
        if (confirm('Leave current dubbing session and return to scenes?')) {
          this.leaveRoom();
        }
      });
    }

    const btnLeaveRoomLobby = document.getElementById('btn-leave-room-lobby');
    if (btnLeaveRoomLobby) {
      btnLeaveRoomLobby.addEventListener('click', () => {
        if (confirm('Leave current dubbing session and return to scenes?')) {
          this.leaveRoom();
        }
      });
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
      if (this.badgeGainMatch) {
        const take = this.roomState?.takes?.[this.currentLineIndex];
        if (take && take.auto_gain_db !== undefined) {
          const isMatched = Math.abs(val - parseFloat(take.auto_gain_db)) < 0.1;
          this.badgeGainMatch.innerText = isMatched ? `✓ ${take.auto_gain_db >= 0 ? '+' : ''}${take.auto_gain_db} dB (Matched)` : `${take.auto_gain_db >= 0 ? '+' : ''}${take.auto_gain_db} dB (Scene Target)`;
          this.badgeGainMatch.className = isMatched ? 'badge-calibrated calibrated' : 'badge-calibrated uncalibrated';
        }
      }
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
          if (this.badgeGainMatch) {
            this.badgeGainMatch.innerText = `✓ ${targetGain >= 0 ? '+' : ''}${targetGain} dB (Matched)`;
            this.badgeGainMatch.className = 'badge-calibrated calibrated';
          }
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

    if (this.checkNoiseReduction) {
      this.checkNoiseReduction.addEventListener('change', (e) => {
        const tag = document.getElementById('tag-noise-cleaner');
        if (tag) tag.innerText = e.target.checked ? 'DFN3' : 'OFF';
        this.syncTakeParams();
      });
    }

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
      this.checkNoiseReduction.addEventListener('change', onNoiseToggleChange);
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

    // Studio & Screening Keyboard Shortcuts
    // Booth: Space (Record), [ / ] (Micro-Nudge ±25ms/±100ms)
    // Screening: Space (Play/Pause), KeyR (Replay / Seek to 0:00)
    window.addEventListener('keydown', (e) => {
      // Escape key closes modals if they are open and not actively rendering
      if (e.key === 'Escape') {
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

    // Master Export Modal Actions
    if (this.btnModalCloseView) {
      this.btnModalCloseView.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.btnModalDismiss) {
      this.btnModalDismiss.addEventListener('click', () => {
        this.closeExportModal();
      });
    }
    if (this.modalExportRendering) {
      this.modalExportRendering.addEventListener('click', (e) => {
        // If clicking on the backdrop and not actively rendering, dismiss modal
        if (e.target === this.modalExportRendering && !this.isRenderingExport) {
          this.closeExportModal();
        }
      });
    }

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
    this.btnExportVideo.addEventListener('click', () => this.exportFinalVideo());

    if (this.btnDownloadProjectZip) {
      this.btnDownloadProjectZip.addEventListener('click', () => this.downloadFullProjectZip());
    }
    if (this.btnToolbarProjectZip) {
      this.btnToolbarProjectZip.addEventListener('click', () => this.downloadFullProjectZip());
    }

    // Screening Video State Listeners
    if (this.btnAspect169 && this.btnAspect916) {
      this.btnAspect169.addEventListener('click', () => {
        this.selectedAspectRatio = '16:9';
        this.btnAspect169.classList.add('active');
        this.btnAspect169.setAttribute('aria-checked', 'true');
        this.btnAspect916.classList.remove('active');
        this.btnAspect916.setAttribute('aria-checked', 'false');
        document.querySelector('.theater-player')?.classList.remove('shorts-mode');
        this.showToast("Aspect ratio set to 🖥️ 16:9 Cinema");
      });

      this.btnAspect916.addEventListener('click', () => {
        this.selectedAspectRatio = '9:16';
        this.btnAspect916.classList.add('active');
        this.btnAspect916.setAttribute('aria-checked', 'true');
        this.btnAspect169.classList.remove('active');
        this.btnAspect169.setAttribute('aria-checked', 'false');
        document.querySelector('.theater-player')?.classList.add('shorts-mode');
        this.showToast("Aspect ratio set to 📱 9:16 Shorts (Vertical Letterboxed)");
      });
    }

    if (this.screeningVideo) {
      this.screeningVideo.addEventListener('ended', () => {
        this.pauseScreeningPlayback();
        this.screeningVideo.currentTime = 0;
      });
      this.screeningVideo.addEventListener('pause', () => {
        if (this.screeningPlayIcon) {
          this.screeningPlayIcon.innerText = '▶ Play Dub';
        }
        if (!this.isUsingExportedVideo) {
          this.audio.stopAllPlayback();
          this.stopScreeningSyncMonitor();
        }
      });
    }

    // Socket events
    this.socket.on('*', (data) => {
      if (data.state) {
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
      if (this.roomState && data.payload?.user) {
        this.roomState.users[data.payload.user_id] = data.payload.user;
        this.renderCastActivityHUD();
      }
    });

    this.socket.on('take_recorded', async (data) => {
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
      const lineIdx = data.payload?.line_index;
      this.audio.evictTakeCache(lineIdx);
      if (lineIdx === this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
      this.renderTimelineChips();
      this.renderCastActivityHUD();
    });

    this.socket.on('status_changed', (data) => {
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

    this.socket.on('warp_to_screening', () => {
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
      if (this.views.screening.classList.contains('active')) {
        this.openExportModal();
        this.updateExportModalStep(1, 30, "Applying vocal EQ, studio compression & acoustic room reverb...");
      }
    });

    this.socket.on('export_ready', (data) => {
      const payload = data.payload || data;
      if (payload && (payload.download_url || payload.export_video_url || payload.download_url_16_9)) {
        this.handleExportSuccess(payload);
        this.showToast("🎬 Master Dubbed Video is ready for the Cast!");
      }
    });

    this.socket.on('dialogue_presence_sync', (data) => {
      const pres = parseFloat(data.payload?.presence_db ?? 0.0);
      this.masterDialoguePresence = pres;
      if (this.sliderDialoguePresence) this.sliderDialoguePresence.value = pres;
      if (this.valDialoguePresence) {
        this.valDialoguePresence.innerText = (pres === 0) ? '0.0 dB (Scene Default)' : ((pres > 0 ? '+' : '') + pres.toFixed(1) + ' dB');
      }
      document.querySelectorAll('.btn-presence-preset').forEach((btn) => {
        const btnVal = parseFloat(btn.dataset.presence || '0');
        btn.classList.toggle('active', Math.abs(btnVal - pres) < 0.1);
      });
      if (this.screeningVocalGainNode && this.audio?.ctx) {
        const { vocalGain } = this.getScreeningStemGains();
        this.screeningVocalGainNode.gain.setValueAtTime(vocalGain, this.audio.ctx.currentTime);
      }
    });
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
    await this.fetchPacks();

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

  leaveRoom() {
    document.body.classList.remove('resizing');
    this.cancelCurrentCountdown();
    this.stopScreeningSyncMonitor();
    this.audio.stopAllPlayback();
    if (this.socket) {
      this.socket.disconnect();
    }
    this.roomState = null;
    this.selectedPackId = null;
    this.currentTakeBlob = null;
    this.currentTakeBuffer = null;
    if (this.screeningBuffers) {
      this.screeningBuffers.clear();
    }

    // Clean URL query parameters (?room=...)
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.pushState({}, '', url.pathname);

    // Reset Header & HUD
    if (this.headerRoomBadge) this.headerRoomBadge.style.display = 'none';
    if (this.headerUserPill) this.headerUserPill.style.display = 'none';
    if (this.btnLeaveRoom) this.btnLeaveRoom.style.display = 'none';
    if (this.studioBreadcrumbs) this.studioBreadcrumbs.style.display = 'none';
    if (this.castActivityBar) this.castActivityBar.style.display = 'none';

    this.showView('landing');
    this.showToast('Left studio session room.');
  }

  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    toast.style.transition = 'opacity 160ms var(--ease-out), transform 160ms var(--ease-out)';
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(() => toast.remove(), 180);
    }, 3200);
  }

  copyRoomLink() {
    const url = window.location.origin + window.location.pathname + '?room=' + this.roomState.room_id;
    navigator.clipboard.writeText(url);
    this.showToast("Room invite link copied! 📋");
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
          <div style="color: var(--foreground-muted); padding: 24px; text-align: center; grid-column: 1 / -1;">
            <p style="margin-bottom: 10px;">⚠️ Could not load scene packs from backend.</p>
            <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.rescanPacksDirectory()">↺ Retry / Rescan Packs</button>
          </div>
        `;
      }
    }
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
      let dataPacks = [];
      const res = await fetch('/api/packs/rescan?t=' + Date.now(), { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        dataPacks = data.packs || [];
      } else {
        const resGet = await fetch('/api/packs?rescan=true&t=' + Date.now());
        if (!resGet.ok) throw new Error(`HTTP ${resGet.status}`);
        dataPacks = await resGet.json();
      }

      this.packs = dataPacks;
      console.log(`[DubMate] Rescan complete. Loaded ${this.packs.length} packs.`);
      this.renderPacks();
      const count = (this.packs || []).length;
      if (!silent) {
        this.showToast(`✨ Rescan complete: ${count} scene pack${count === 1 ? '' : 's'} indexed!`);
      }
    } catch (err) {
      console.error("Error during pack rescan:", err);
      if (!silent) {
        this.showToast(`⚠️ Rescan failed: ${err.message}`);
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
        statusText.innerText = "🛡️ Scanning file signatures, verifying malware security, and indexing audio stems...";
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
      this.showToast(`⚠️ ${err.message}`);
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
    if (!text || !query) return text || '';
    const safeText = String(text);
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        <div class="empty-packs-guide glass-card" style="grid-column: 1 / -1; padding: 32px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <div style="font-size: 36px; margin-bottom: 12px;">📦</div>
          <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 8px; color: var(--foreground);">No Scene Packs Loaded</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 480px; margin: 0 auto 16px; line-height: 1.6;">
            Download dub packs from <a href="https://gamebanana.com/mods/cats/44064" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; font-weight: 600;">GameBanana Choicer Voicer</a> or drop any .zip pack directly here.
          </p>
          <div style="display: flex; justify-content: center; gap: 10px;">
            <button class="btn btn-primary btn-sm" onclick="document.getElementById('input-pack-zip').click()">📁 Import .ZIP Pack</button>
            <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.rescanPacksDirectory()">↺ Rescan Directory</button>
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
      const safeQuery = query.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      const displayTitle = query ? this.highlightMatch(rawTitle, query) : rawTitle;
      const duration = Math.round(pack.duration || (pack.lines && pack.lines.length ? pack.lines[pack.lines.length - 1].end : 0));
      const lineCount = pack.line_count || (pack.lines ? pack.lines.length : 0);
      const characters = pack.characters || [];

      const subtitleHtml = pack.subtitle ? `
        <div class="pack-card-subtitle" title="${pack.subtitle}">
          ${query ? this.highlightMatch(pack.subtitle, query) : pack.subtitle}
        </div>
      ` : '';

      const authorsHtml = (pack.authors && pack.authors.length) ? `
        <span class="badge-author" title="Author: ${pack.authors.join(', ')}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${pack.authors.map(a => query ? this.highlightMatch(a, query) : a).join(', ')}
        </span>
      ` : '';

      const isCV = (pack.pack_type === 'choicer_voicer');
      const formatBadge = isCV
        ? `<span class="badge-format cv" title="Choicer Voicer Native Format">CV Pack</span>`
        : `<span class="badge-format dubmate" title="DubMate Standard Format">DubMate</span>`;

      const thumbImg = (pack.has_icon && pack.icon_url)
        ? `<div class="pack-card-thumb"><img src="${pack.icon_url}" alt="${rawTitle} cover" loading="lazy"></div>`
        : `<div class="pack-card-thumb placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/></svg></div>`;

      // Check if a dialogue line matched query
      let matchedLineSnippet = '';
      if (query && pack.lines) {
        const foundLine = pack.lines.find(l => ((l.caption || '') + ' ' + (l.raw_caption || '') + ' ' + (l.text || '')).toLowerCase().includes(query));
        if (foundLine) {
          const charPrefix = foundLine.character ? `<strong>${foundLine.character}:</strong> ` : '';
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
              <a href="${pack.export_url || `/api/packs/${encodeURIComponent(pack.id)}/export`}" class="btn-pack-download-icon" title="Download ${rawTitle} (.zip)" download onclick="event.stopPropagation()">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>ZIP</span>
              </a>
            </div>
          </div>
        </div>
        ${matchedLineSnippet}
        <div class="pack-card-characters">
          ${characters.map(c => `<span class="char-tag">${query ? this.highlightMatch(c, query) : c}</span>`).join('')}
        </div>
      `;

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
      this.joinRoom(data.room_id);
    } catch (err) {
      this.showToast("Error creating room: " + err.message);
    }
  }

  initModeDropdown() {
    const container = document.getElementById('logo-dropdown-container');
    const btnDropdown = document.getElementById('btn-mode-dropdown');
    const menu = document.getElementById('mode-dropdown-menu');
    const optStudio = document.getElementById('mode-opt-studio');
    if (!container || !btnDropdown || !menu) return;

    const toggleMenu = (show) => {
      const isCurrentlyOpen = container.classList.contains('open');
      const target = (typeof show === 'boolean') ? show : !isCurrentlyOpen;
      if (target) {
        container.classList.add('open');
        menu.style.display = 'flex';
        btnDropdown.setAttribute('aria-expanded', 'true');
      } else {
        container.classList.remove('open');
        menu.style.display = 'none';
        btnDropdown.setAttribute('aria-expanded', 'false');
      }
    };

    btnDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    btnDropdown.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        toggleMenu(true);
      }
    });

    if (optStudio) {
      optStudio.addEventListener('click', (e) => {
        if (this.roomState) {
          e.preventDefault();
          if (confirm('Leave current dubbing session and return to scenes?')) {
            this.leaveRoom();
            toggleMenu(false);
          }
        } else {
          toggleMenu(false);
        }
      });
    }

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        toggleMenu(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && container.classList.contains('open')) {
        toggleMenu(false);
        btnDropdown.focus();
      }
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
    const url = new URL(window.location.href);
    if (url.searchParams.has('room')) {
      url.searchParams.delete('room');
      window.history.pushState({}, '', url.pathname);
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
    try {
      const res = await fetch(`/api/rooms/${roomId}`);
      if (!res.ok) {
        // Strip stale room parameter so user is returned cleanly to scene explorer
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.pushState({}, '', url.pathname);

        this.showToast("Room not found or expired.");
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
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.pushState({}, '', url.pathname);
      this.showToast("Error joining room: " + err.message);
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
    const isHost = (this.user.id === this.roomState.host_id);
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
    const isHost = (this.user.id === this.roomState.host_id);

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
        <div class="actor-hud-avatar" style="background: ${u.color};">${u.name.charAt(0).toUpperCase()}</div>
        <span class="actor-hud-name" title="${u.name}">${u.name}${u.id === this.user.id ? ' (You)' : ''}</span>
        <span class="actor-hud-char" title="${charFullTooltip}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${charDisplayText}</span>
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
              <div class="user-avatar" style="background: ${u.color};">${u.name.charAt(0).toUpperCase()}</div>
              <span class="lobby-user-name">${u.name} ${u.id === this.user.id ? '<span class="user-you-tag">(You)</span>' : ''}</span>
            </div>
            <span class="cast-status-pill ${u.is_online ? 'online' : 'offline'}">
              <span class="status-dot ${u.is_online ? 'dot-online' : 'dot-offline'}" aria-hidden="true"></span>
              <span>${u.is_online ? 'Online' : 'Offline'}</span>
            </span>
          </div>
        `).join('');
      }
    }

    if (!this.castingTbody) return;

    const charCounts = {};
    this.roomState.pack.lines.forEach(l => {
      charCounts[l.character] = (charCounts[l.character] || 0) + 1;
    });

    const userOptionsHtml = `<option value="">-- Unassigned (Original Voice) --</option>` +
      users.map(u => `<option value="${u.id}">${u.name} ${u.id === this.user.id ? '(You)' : ''}</option>`).join('');

    const usersChanged = (this._lastUserOptionsSummary !== userSummary);
    this._lastUserOptionsSummary = userSummary;

    // Check if table rows already exist for all characters
    const existingRows = this.castingTbody.querySelectorAll('tr[data-character]');
    if (existingRows.length === this.roomState.pack.characters.length && !usersChanged) {
      // IN-PLACE UPDATE: Do not recreate DOM elements to avoid closing active <select> dropdowns
      this.roomState.pack.characters.forEach((char) => {
        const safeCharId = char.replace(/\s+/g, '-').toLowerCase();
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
            <span class="char-badge">🎭 ${char}</span>
            ${isAssignedToMe ? '<span class="your-role-badge">YOUR ROLE</span>' : ''}
          </div>
        </td>
        <td><span class="char-line-count">${charCounts[char] || 0} lines</span></td>
        <td>
          <div class="cast-assign-cell">
            <span class="actor-color-dot ${assignedUser ? 'active' : 'unassigned'}" 
                  style="background-color: ${assignedUser ? assignedUser.color : 'transparent'};" 
                  title="${assignedUser ? assignedUser.name : 'Unassigned'}" 
                  aria-hidden="true"></span>
            <select class="cast-select" 
                    id="cast-select-${safeCharId}" 
                    data-char="${char}" 
                    aria-label="Assign actor for ${char}">
              <option value="">-- Unassigned (Original Voice) --</option>
              ${users.map(u => `
                <option value="${u.id}" ${assignedIds.includes(u.id) ? 'selected' : ''}>
                  ${u.name} ${u.id === this.user.id ? '(You)' : ''}
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

  async ensureBackingBuffer() {
    if (this.backingBuffer) return this.backingBuffer;
    if (!this.roomState?.pack?.backing_url) return null;
    try {
      this.backingBuffer = await this.audio.loadAudioBuffer(this.roomState.pack.backing_url);
    } catch (e) { }
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
    const isHost = (this.user.id === this.roomState.host_id) || (this.roomState.host_id === 'host');
    const isMyLine = myAssignedChars.includes(line.character) || (myAssignedChars.length === 0 && isHost);
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
          const matchVal = parseFloat(take.auto_gain_db);
          const currentGain = parseFloat(this.sliderGain.value) || 0;
          const isMatched = Math.abs(currentGain - matchVal) < 0.1;
          this.badgeGainMatch.innerText = isMatched ? `✓ ${matchVal >= 0 ? '+' : ''}${matchVal} dB (Matched)` : `${matchVal >= 0 ? '+' : ''}${matchVal} dB (Scene Target)`;
          this.badgeGainMatch.className = isMatched ? 'badge-calibrated calibrated' : 'badge-calibrated uncalibrated';
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

    this.waveform.setData({
      origPeaks,
      takePeaks,
      offsetMs: take ? (take.offset_ms || 0) : 0,
      totalDuration: (line.duration || 3.0) + 0.8,
    });

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
          this.waveform.setData({
            origPeaks,
            takePeaks,
            offsetMs: take ? (take.offset_ms || 0) : 0,
            totalDuration: (line.duration || 3.0) + 0.8,
          });
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
            this.waveform.setData({
              origPeaks,
              takePeaks,
              offsetMs: take.offset_ms || 0,
              totalDuration: (line.duration || 3.0) + 0.8,
            });
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

    const myAssignedChars = this.getMyAssignedCharacters();
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const isHost = (this.user.id === this.roomState?.host_id) || (this.roomState?.host_id === 'host');
    const isMyLine = !line || myAssignedChars.includes(line.character) || (myAssignedChars.length === 0 && isHost);

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
      this.labelABState.innerHTML = `<span style="color: var(--primary); font-weight: 700;">[ A: Your Dub ]</span> <span style="color: var(--text-dim);">⇄ B: Orig</span>`;
    } else {
      this.labelABState.innerHTML = `<span style="color: var(--text-dim);">A: Dub ⇄</span> <span style="color: var(--accent-brass); font-weight: 700;">[ B: Original ]</span>`;
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
        this.showToast(`⚠️ Mic calibration failed: ${err.message}`);
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

        this.waveform.setData({
          origPeaks,
          takePeaks,
          offsetMs: take ? (take.offset_ms || 0) : 0,
          totalDuration: (line.duration || 3.0) + 0.8,
        });

        if (take && take.url) {
          const newBuf = await this.audio.loadAudioBuffer(take.url, true);
          this.currentTakeBuffer = newBuf;
          if (newBuf && (!takePeaks || takePeaks.length === 0)) {
            takePeaks = WaveformRenderer.extractPeaksFromBuffer(newBuf, 100);
            this.waveform.setData({
              origPeaks,
              takePeaks,
              offsetMs: take.offset_ms || 0,
              totalDuration: (line.duration || 3.0) + 0.8,
            });
          }
        }
      }

      this.showToast(enable ? "✨ Studio Noise Reduction applied to take!" : "Raw original take restored (Noise Reduction OFF)");
    } catch (err) {
      console.warn("[App] Error toggling take noise reduction:", err);
      this.showToast(`⚠️ Could not toggle noise reduction: ${err.message}`);
    }
  }

  async toggleRecording() {
    if (!this.roomState) return;
    const myAssignedChars = this.getMyAssignedCharacters();
    const line = this.roomState.pack.lines[this.currentLineIndex];
    const isHost = (this.user.id === this.roomState.host_id) || (this.roomState.host_id === 'host');
    const isMyLine = !line || myAssignedChars.includes(line.character) || (myAssignedChars.length === 0 && isHost);
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

    this.currentTakeBlob = res.blob;
    await this.uploadTake(this.currentLineIndex, this.currentTakeBlob, res.audioBuffer);
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
      this.showToast("Failed to upload take: " + err.message);
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

    const isHost = (this.user.id === this.roomState?.host_id) || (this.roomState?.host_id === 'host');
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

  // --- Finale Screening & Host Sync Logic ---

  async setupScreeningView() {
    if (!this.roomState) return;

    const presenceVal = parseFloat(this.roomState.master_dialogue_presence_db ?? 0.0);
    this.masterDialoguePresence = presenceVal;
    if (this.sliderDialoguePresence) this.sliderDialoguePresence.value = presenceVal;
    if (this.valDialoguePresence) {
      this.valDialoguePresence.innerText = (presenceVal === 0) ? '0.0 dB (Scene Default)' : ((presenceVal > 0 ? '+' : '') + presenceVal.toFixed(1) + ' dB');
    }
    document.querySelectorAll('.btn-presence-preset').forEach((btn) => {
      const btnVal = parseFloat(btn.dataset.presence || '0');
      btn.classList.toggle('active', Math.abs(btnVal - presenceVal) < 0.1);
    });

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
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    const videoUrl = directUrl || this.roomState.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
    if (!this.screeningVideo.src.endsWith(videoUrl) && this.screeningVideo.getAttribute('src') !== videoUrl) {
      this.screeningVideo.src = videoUrl;
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

    this.screeningVideo.muted = false;
    this.screeningVideo.volume = 1.0;

    if (this.screeningMasterBadge) {
      this.screeningMasterBadge.style.display = 'inline-flex';
    }
    if (this.screeningPlayIcon) {
      this.screeningPlayIcon.innerText = this.screeningVideo.paused ? '▶ Play Dub' : '⏸ Pause Dub';
    }
  }

  applyLiveMixToTheater() {
    if (!this.roomState || !this.screeningVideo) return;
    this.isUsingExportedVideo = false;
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    const packVideoUrl = this.roomState.pack.video_url;
    if (!this.screeningVideo.src.endsWith(packVideoUrl) && this.screeningVideo.getAttribute('src') !== packVideoUrl) {
      this.screeningVideo.src = packVideoUrl;
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

    this.screeningVideo.muted = true;
    this.screeningVideo.volume = 0;

    if (this.screeningMasterBadge) {
      this.screeningMasterBadge.style.display = 'none';
    }
    if (this.screeningPlayIcon) {
      this.screeningPlayIcon.innerText = this.screeningVideo.paused ? '▶ Play Dub' : '⏸ Pause Dub';
    }
  }

  isScreeningBuffersReady() {
    if (!this.roomState) return true;
    if (this.roomState.pack.backing_url && !this.screeningBuffers.has(this.roomState.pack.backing_url)) {
      return false;
    }
    for (const line of this.roomState.pack.lines) {
      const take = this.roomState.takes[line.index];
      const targetUrl = (take && take.url) ? take.url : line.audio_url;
      if (targetUrl && !this.screeningBuffers.has(targetUrl)) {
        return false;
      }
    }
    return true;
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

      // 2. Dialogue lines & takes in parallel
      for (const line of this.roomState.pack.lines) {
        const take = this.roomState.takes[line.index];
        if (take && take.url) {
          if (!this.screeningBuffers.has(take.url)) {
            loadTasks.push(
              this.audio.loadAudioBuffer(take.url)
                .then(b => {
                  if (b) {
                    this.screeningBuffers.set(take.url, b);
                    // Pre-cache pitch-shifted buffer in background for 0ms instant playback
                    if (Math.abs(take.pitch_semitones || 0) > 0.05) {
                      try { this.audio.pitchShiftBuffer(b, take.pitch_semitones); } catch (e) { }
                    }
                  }
                })
                .catch(() => { })
            );
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
        this.valScreeningBalance.innerText = 'Balanced (50/50)';
      } else if (this.screeningBalance < 50) {
        const musicBoost = (50 - this.screeningBalance) * 2;
        this.valScreeningBalance.innerText = `Music Heavy (+${musicBoost}%)`;
      } else {
        const vocalBoost = (this.screeningBalance - 50) * 2;
        this.valScreeningBalance.innerText = `Vocals Heavy (+${vocalBoost}%)`;
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

  setMasterDialoguePresence(val) {
    this.masterDialoguePresence = Math.max(-12.0, Math.min(12.0, val));
    if (this.valDialoguePresence) {
      this.valDialoguePresence.innerText = (this.masterDialoguePresence === 0)
        ? '0.0 dB (Scene Default)'
        : ((this.masterDialoguePresence > 0 ? '+' : '') + this.masterDialoguePresence.toFixed(1) + ' dB');
    }
    document.querySelectorAll('.btn-presence-preset').forEach((btn) => {
      const btnVal = parseFloat(btn.dataset.presence || '0');
      btn.classList.toggle('active', Math.abs(btnVal - this.masterDialoguePresence) < 0.1);
    });

    if (this.screeningVocalGainNode && this.audio?.ctx) {
      const { vocalGain } = this.getScreeningStemGains();
      this.screeningVocalGainNode.gain.setValueAtTime(vocalGain, this.audio.ctx.currentTime);
    }

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

    const presenceMult = Math.pow(10.0, (this.masterDialoguePresence || 0.0) / 20.0);
    vocalGain *= presenceMult;

    return { backingGain, vocalGain };
  }

  updateScreeningControls() {
    if (!this.roomState) return;
    const isHost = (this.user.id === this.roomState.host_id) || (this.roomState.host_id === 'host');
    this.screeningHostBadge.style.display = isHost ? 'inline-block' : 'none';
    this.screeningStatusDesc.innerText = isHost
      ? "You are the Host. Control playback to sync everyone in the room."
      : "Watching Live. Host controls playback (or use Space/Replay for local preview).";
  }

  async handleScreeningPlayPause() {
    if (!this.roomState) return;
    const isHost = (this.user.id === this.roomState.host_id) || (this.roomState.host_id === 'host');
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
    const isHost = (this.user.id === this.roomState.host_id) || (this.roomState.host_id === 'host');
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

    this.screeningPlayIcon.innerText = '⏸ Pause Dub';

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
    this.screeningPlayIcon.innerText = '▶ Play Dub';
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

    // 2. Shared Master Vocal Mix Bus
    const masterVocalGain = this.audio.ctx.createGain();
    masterVocalGain.gain.value = vocalGain;
    masterVocalGain.connect(this.audio.ctx.destination);
    this.screeningVocalGainNode = masterVocalGain;

    // 3. Schedule dialogue takes & unassigned original character clips
    for (const line of this.roomState.pack.lines) {
      const take = this.roomState.takes[line.index];

      if (take && take.url && this.screeningBuffers.has(take.url)) {
        const offsetSec = (take.offset_ms || 0) / 1000.0;
        const linePlayTime = line.start + offsetSec;
        const rawBuf = this.screeningBuffers.get(take.url);
        const takeDuration = rawBuf.duration || 3.0;

        // Line is audible if its sound ends after startTime
        if (linePlayTime + takeDuration > startTime) {
          const shifted = (Math.abs(take.pitch_semitones || 0) > 0.05)
            ? this.audio.pitchShiftBuffer(rawBuf, take.pitch_semitones)
            : rawBuf;

          const source = this.audio.ctx.createBufferSource();
          source.buffer = shifted;

          const dsp = this.audio.buildVocalDSPChain({
            pitchSemitones: take.pitch_semitones || 0,
            reverbWet: take.reverb_wet || 0,
            gainDb: take.gain_db || 0,
            enableLowCut: true,
            enableCompressor: true,
          });

          source.connect(dsp.input);
          dsp.output.connect(masterVocalGain);

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
          source.connect(masterVocalGain);

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

  openExportModal() {
    this.isRenderingExport = true;
    if (this.modalExportRendering) {
      this.modalExportRendering.style.display = 'flex';
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.style.display = 'none';
    }
    if (this.exportModalBadge) {
      this.exportModalBadge.className = 'badge-render-live';
      this.exportModalBadge.innerText = 'PROCESSING';
    }
    if (this.exportModalTitle) {
      this.exportModalTitle.innerText = 'Master Dub Rendering';
    }
    if (this.exportModalReassurance) {
      this.exportModalReassurance.style.display = 'flex';
    }
    if (this.exportModalActions) {
      this.exportModalActions.style.display = 'none';
    }
    this.updateExportModalStep(1, 25, "Applying vocal EQ, studio compression & acoustic room reverb...");
    this.pauseScreeningPlayback();
    this.lockScreeningUI(true);
  }

  updateExportModalStep(step, percent, statusText) {
    if (this.exportModalStatusText) {
      this.exportModalStatusText.innerText = statusText;
    }
    if (this.exportModalProgressBar) {
      this.exportModalProgressBar.style.width = `${percent}%`;
    }
    if (this.modalStepDsp && this.modalStepMux && this.modalStepReady) {
      this.modalStepDsp.className = 'modal-step-item' + (step > 1 ? ' completed' : (step === 1 ? ' active' : ''));
      this.modalStepMux.className = 'modal-step-item' + (step > 2 ? ' completed' : (step === 2 ? ' active' : ''));
      this.modalStepReady.className = 'modal-step-item' + (step >= 3 ? ' active' : '');
    }
    if (this.connectorDspMux) {
      this.connectorDspMux.className = 'step-connector' + (step > 1 ? ' completed' : '');
    }
    if (this.connectorMuxReady) {
      this.connectorMuxReady.className = 'step-connector' + (step > 2 ? ' completed' : '');
    }
  }

  handleExportSuccess(data) {
    this.isUsingExportedVideo = true;
    this.isRenderingExport = false;
    if (this.roomState) {
      this.roomState.has_export = true;
      this.roomState.export_video_url = data.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
      this.roomState.download_url = data.download_url || data.download_url_16_9;
    }

    this.updateExportModalStep(3, 100, "✅ Master Dubbed Video Rendered Successfully!");

    if (this.modalStepReady) {
      this.modalStepReady.className = 'modal-step-item completed';
    }
    if (this.connectorMuxReady) {
      this.connectorMuxReady.className = 'step-connector completed';
    }
    if (this.exportModalBadge) {
      this.exportModalBadge.className = 'badge-render-live ready';
      this.exportModalBadge.innerText = 'READY';
    }
    if (this.exportModalTitle) {
      this.exportModalTitle.innerText = 'Master Dub Video Ready!';
    }
    if (this.exportModalReassurance) {
      this.exportModalReassurance.style.display = 'none';
    }
    if (this.btnModalCloseX) {
      this.btnModalCloseX.style.display = 'flex';
    }

    const download169 = data.download_url_16_9 || data.download_url || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=16:9`;
    const download916 = data.download_url_9_16 || `/api/rooms/${this.roomState?.room_id}/export/download?aspect_ratio=9:16`;

    if (this.btnModalDownload169) {
      this.btnModalDownload169.href = download169;
    }
    if (this.btnModalDownload916) {
      this.btnModalDownload916.href = download916;
    }
    if (this.exportModalActions) {
      this.exportModalActions.style.display = 'flex';
    }

    // Also update legacy inline panel if displayed
    if (this.exportProgressBox) {
      this.exportProgressBox.style.display = 'block';
    }
    if (this.exportProgressFill) {
      this.exportProgressFill.style.transform = 'scaleX(1)';
    }
    if (this.stepDsp) { this.stepDsp.className = 'step-item completed'; }
    if (this.stepMux) { this.stepMux.className = 'step-item completed'; }
    if (this.stepReady) { this.stepReady.className = 'step-item active'; }
    if (this.exportStatusText) {
      this.exportStatusText.innerText = "✅ Master Dubbed Video Rendered Successfully!";
    }
    if (this.btnDownloadLink) {
      this.btnDownloadLink.href = download169;
    }
    if (this.btnDownloadLink916) {
      this.btnDownloadLink916.href = download916;
    }
    if (this.exportDownloadContainer) {
      this.exportDownloadContainer.style.display = 'flex';
    }

    this.applyExportedVideoToTheater(data.export_video_url);
    this.lockScreeningUI(false);
  }

  closeExportModal() {
    if (this.modalExportRendering) {
      this.modalExportRendering.style.display = 'none';
    }
    this.isRenderingExport = false;
    this.lockScreeningUI(false);
  }

  lockScreeningUI(isLocked) {
    const controls = [
      this.btnScreeningPlayPause,
      this.btnScreeningReplay,
      this.btnAspect169,
      this.btnAspect916,
      this.btnExportVideo,
      this.btnToolbarProjectZip,
      this.btnBackBooth,
      this.sliderScreeningBalance,
      this.btnLeaveRoom,
      this.navStepLobby,
      this.navStepBooth
    ];
    controls.forEach((el) => {
      if (el) {
        el.disabled = isLocked;
        el.classList.toggle('ui-interaction-locked', isLocked);
      }
    });
  }

  async exportFinalVideo() {
    if (!this.roomState) return;
    this.openExportModal();

    try {
      const presenceParam = encodeURIComponent(this.masterDialoguePresence || 0.0);
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/export?aspect_ratio=${this.selectedAspectRatio}&presence=${presenceParam}`, {
        method: 'POST',
      });

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();

      if (data.status === 'ok' || data.status === 'ready') {
        this.handleExportSuccess(data);
        return;
      }

      // If background rendering in progress, update step 2 and poll until ready
      this.updateExportModalStep(2, 65, "Encoding multi-track audio & video stems in frame-accurate sync...");

      const pollUrl = `/api/rooms/${this.roomState.room_id}/export/status?aspect_ratio=${this.selectedAspectRatio}`;
      let attempts = 0;
      const maxAttempts = 90; // up to 3 minutes

      const pollInterval = setInterval(async () => {
        attempts++;
        try {
          const pollRes = await fetch(pollUrl);
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            if (pollData.status === 'ready' || pollData.status === 'ok') {
              clearInterval(pollInterval);
              this.handleExportSuccess(pollData);
              return;
            }
            if (String(pollData.status).startsWith('failed')) {
              clearInterval(pollInterval);
              throw new Error(pollData.status);
            }
          }
        } catch (e) {
          console.warn("[ExportPoll] Polling update:", e);
        }

        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          this.isRenderingExport = false;
          this.updateExportModalStep(2, 85, "⚠️ Rendering is taking longer than expected. Please check back shortly.");
          if (this.btnModalCloseX) {
            this.btnModalCloseX.style.display = 'flex';
          }
          if (this.exportModalActions) {
            this.exportModalActions.style.display = 'flex';
          }
          this.lockScreeningUI(false);
        }
      }, 2000);

    } catch (err) {
      this.isRenderingExport = false;
      this.updateExportModalStep(1, 0, "❌ Export failed: " + err.message);
      if (this.exportModalBadge) {
        this.exportModalBadge.innerText = 'FAILED';
      }
      if (this.btnModalCloseX) {
        this.btnModalCloseX.style.display = 'flex';
      }
      if (this.exportModalActions) {
        this.exportModalActions.style.display = 'flex';
      }
      this.lockScreeningUI(false);
      this.showToast("Export failed: " + err.message);
    }
  }

  async downloadFullProjectZip() {
    if (!this.roomState?.room_id) {
      this.showToast("No active session to export.");
      return;
    }
    const roomId = this.roomState.room_id;
    const packName = (this.roomState.pack?.name || 'Dub').replace(/[^a-zA-Z0-9_-]/g, '_');
    const zipUrl = `/api/rooms/${roomId}/export/project_zip?v=${Date.now()}`;

    this.showToast("📦 Packaging Full Project ZIP (MP3 Stems, Takes & Video)... Download starting!");

    const labelToolbar = document.getElementById('label-toolbar-project-zip');
    const labelContainer = document.getElementById('label-download-project-zip');
    if (labelToolbar) labelToolbar.innerText = "⏳ Generating ZIP...";
    if (labelContainer) labelContainer.innerText = "⏳ Generating ZIP...";

    try {
      // Primary trigger: direct window navigation (browser preserves current tab and downloads attachment)
      window.location.assign(zipUrl);
    } catch (err) {
      console.error("Project ZIP download error:", err);
      // Fallback trigger via temporary link
      try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = zipUrl;
        a.setAttribute('download', `DubMate_Project_${packName}_${roomId}.zip`);
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (a.parentNode) {
            a.parentNode.removeChild(a);
          }
        }, 1500);
      } catch (fallbackErr) {
        this.showToast("❌ Download failed: " + fallbackErr.message);
      }
    } finally {
      setTimeout(() => {
        if (labelToolbar) labelToolbar.innerText = "📦 Download Full Project (.zip)";
        if (labelContainer) labelContainer.innerText = "📦 Download Full Project (.zip)";
      }, 3000);
    }
  }
}

// Instantiate on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.app = new DubMateApp();
  });
} else {
  window.app = new DubMateApp();
}
