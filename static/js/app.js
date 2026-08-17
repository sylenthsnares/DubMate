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

    this.initDOM();
    this.initEvents();
    this.initRouter();
    window.dubMateApp = this;
  }

  loadUser() {
    const saved = localStorage.getItem('dubmate_user');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
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
    this.btnRescanPacks = document.getElementById('btn-rescan-packs');
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
    this.screeningSyncRafId = null;

    // Export Step Indicators
    this.stepDsp = document.getElementById('step-dsp');
    this.stepMux = document.getElementById('step-mux');
    this.stepReady = document.getElementById('step-ready');

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

  initEvents() {
    // Back to Home / Leave Room
    const btnHome = document.getElementById('btn-home');
    if (btnHome) {
      btnHome.addEventListener('click', () => {
        if (this.roomState) {
          if (confirm('Leave current dubbing session and return to scenes?')) {
            this.leaveRoom();
          }
        } else {
          this.showView('landing');
        }
      });
    }

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
    });

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
      this.syncTakeParams();
    });

    // Advanced Vocal Rack
    this.btnToggleAdvancedRack.addEventListener('click', () => {
      const isOpen = this.advancedVocalRack.classList.contains('open');
      if (isOpen) {
        this.advancedVocalRack.classList.remove('open');
        this.btnToggleAdvancedRack.setAttribute('aria-expanded', 'false');
        this.btnToggleAdvancedRack.innerText = 'Advanced Rack ▾';
      } else {
        this.advancedVocalRack.classList.add('open');
        this.btnToggleAdvancedRack.setAttribute('aria-expanded', 'true');
        this.btnToggleAdvancedRack.innerText = 'Advanced Rack ▴';
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

    // Studio & Screening Keyboard Shortcuts
    // Booth: Space (Record), [ / ] (Micro-Nudge ±25ms/±100ms)
    // Screening: Space (Play/Pause), KeyR (Replay / Seek to 0:00)
    window.addEventListener('keydown', (e) => {
      // Ignore shortcut triggers when user is focused in text/input fields
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

    // Screening Master Stem Balance Slider
    if (this.sliderScreeningBalance) {
      this.sliderScreeningBalance.addEventListener('input', (e) => {
        this.setScreeningBalance(parseInt(e.target.value, 10));
      });
    }

    // Screening Controls (Host Sync)
    this.btnScreeningPlayPause.addEventListener('click', () => this.handleScreeningPlayPause());
    this.btnScreeningReplay.addEventListener('click', () => this.handleScreeningReplay());
    this.btnExportVideo.addEventListener('click', () => this.exportFinalVideo());

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
        this.roomState = data.state;
        this.renderLobbyState();
        this.renderTimelineChips();
        this.renderCastActivityHUD();
        this.updateScreeningControls();
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
        } catch (e) {}
      }

      if (lineIdx === this.currentLineIndex) {
        this.loadBoothLine(lineIdx);
      }
      this.renderTimelineChips();
      this.renderCastActivityHUD();

      const userName = data.payload?.user_name || 'Cast member';
      this.showToast(`🎙️ ${userName} updated Line ${(lineIdx !== undefined ? lineIdx + 1 : '')}!`);
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

    this.socket.on('export_ready', (data) => {
      const payload = data.payload || data;
      if (payload && (payload.download_url || payload.export_video_url || payload.download_url_16_9)) {
        this.isUsingExportedVideo = true;
        if (this.roomState) {
          this.roomState.has_export = true;
          this.roomState.export_video_url = payload.export_video_url;
          this.roomState.download_url = payload.download_url || payload.download_url_16_9;
        }
        this.exportProgressBox.style.display = 'block';
        if (this.exportProgressFill) {
          this.exportProgressFill.style.transform = 'scaleX(1)';
        }
        if (this.stepDsp) { this.stepDsp.className = 'step-item completed'; }
        if (this.stepMux) { this.stepMux.className = 'step-item completed'; }
        if (this.stepReady) { this.stepReady.className = 'step-item active'; }

        this.exportStatusText.innerText = "✅ Master Dubbed Video Rendered Successfully!";
        if (this.btnDownloadLink) {
          this.btnDownloadLink.href = payload.download_url_16_9 || payload.download_url || '#';
        }
        if (this.btnDownloadLink916) {
          this.btnDownloadLink916.href = payload.download_url_9_16 || `${payload.download_url || ''}&aspect_ratio=9:16`;
        }
        if (this.exportDownloadContainer) {
          this.exportDownloadContainer.style.display = 'flex';
        }
        this.applyExportedVideoToTheater(payload.export_video_url);
        this.showToast("🎬 Master Dubbed Video is ready for the Cast!");
      }
    });
  }


  async initRouter() {
    await this.fetchPacks();

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      this.joinRoom(roomParam);
    } else {
      this.showView('landing');
    }
  }

  showView(viewName) {
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
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      toast.style.transition = 'opacity 160ms var(--ease-out), transform 160ms var(--ease-out)';
      setTimeout(() => toast.remove(), 180);
    }, 3000);
  }

  copyRoomLink() {
    const url = window.location.origin + window.location.pathname + '?room=' + this.roomState.room_id;
    navigator.clipboard.writeText(url);
    this.showToast("Room invite link copied! 📋");
  }

  // --- Packs & Landing Logic ---

  async fetchPacks() {
    try {
      const res = await fetch('/api/packs?t=' + Date.now());
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.packs = await res.json();
      console.log(`[DubMate] Successfully loaded ${this.packs.length} scene packs:`, this.packs.map(p => p.name || p.title));
      this.renderPacks();
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

  async rescanPacksDirectory() {
    if (this.isRescanningPacks) return;
    this.isRescanningPacks = true;

    const icon = this.btnRescanPacks?.querySelector('svg');
    if (icon) icon.classList.add('spinning');
    if (this.btnRescanPacks) {
      this.btnRescanPacks.disabled = true;
      const textSpan = this.btnRescanPacks.querySelector('span');
      if (textSpan) textSpan.innerText = 'Scanning...';
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
      this.showToast(`✨ Rescan complete: ${count} scene pack${count === 1 ? '' : 's'} indexed!`);
    } catch (err) {
      console.error("Error during pack rescan:", err);
      this.showToast(`⚠️ Rescan failed: ${err.message}`);
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

  renderPacks() {
    if (!this.packGrid) return;
    this.packGrid.innerHTML = '';
    if (this.packCountBadge) {
      this.packCountBadge.innerText = `${(this.packs || []).length} Packs`;
    }

    if (!this.packs || !this.packs.length) {
      this.selectedPackId = null;
      this.packGrid.innerHTML = `
        <div class="empty-packs-guide glass-card" style="grid-column: 1 / -1; padding: 32px 24px; text-align: center; border: 1px dashed var(--border-wood); border-radius: var(--radius-md); background: rgba(26, 23, 20, 0.6);">
          <div style="font-size: 36px; margin-bottom: 12px;">📦</div>
          <h3 style="font-size: 16px; font-weight: 700; margin-bottom: 8px; color: var(--foreground);">No Scene Packs Loaded</h3>
          <p style="font-size: 13px; color: var(--foreground-muted); max-width: 480px; margin: 0 auto 16px; line-height: 1.6;">
            Download dub packs from <a href="https://gamebanana.com/mods/cats/44064" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; font-weight: 600;">GameBanana Choicer Voicer</a>, convert them with <code>CVConvert</code>, and place the extracted folders into <code>Packs/</code>.
          </p>
          <button class="btn btn-secondary btn-sm" onclick="window.dubMateApp.rescanPacksDirectory()">↺ Rescan Packs Directory</button>
        </div>
      `;
      return;
    }

    this.packs.forEach((pack, idx) => {
      const card = document.createElement('div');
      const isSelected = (!this.selectedPackId && idx === 0) || (this.selectedPackId === pack.id);
      card.className = `pack-card ${isSelected ? 'selected' : ''}`;
      if (isSelected) this.selectedPackId = pack.id;

      const title = pack.title || pack.name || pack.id;
      const duration = Math.round(pack.duration || (pack.lines && pack.lines.length ? pack.lines[pack.lines.length - 1].end : 0));
      const lineCount = pack.line_count || (pack.lines ? pack.lines.length : 0);
      const characters = pack.characters || [];

      card.innerHTML = `
        <div class="pack-card-header">
          <div class="pack-card-title">${title}</div>
          <span class="pack-card-duration">⏱️ ${duration}s</span>
        </div>
        <div class="pack-card-desc">
          <span>📜 ${lineCount} dialogue lines</span>
        </div>
        <div class="pack-card-characters">
          ${characters.map(c => `<span class="char-tag">${c}</span>`).join('')}
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

  joinRoomFromInput() {
    const code = this.inputRoomCode.value.trim().toUpperCase();
    if (!code) {
      this.showToast("Please enter a room code!");
      return;
    }
    this.joinRoom(code);
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

      if (this.roomState.pack.backing_url) {
        this.audio.loadAudioBuffer(this.roomState.pack.backing_url).then((buf) => {
          this.backingBuffer = buf;
        });
      }

      this.showView('lobby');
      this.renderLobbyState();
      this.renderCastActivityHUD();
      this.broadcastMyStatus('lobby');
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
      this.labelReadyState.innerText = "✅ Ready for Premiere!";
      this.btnToggleReady.className = "btn btn-success btn-sm";
      this.showToast("You are marked READY for the Premiere! 🍿");
    } else {
      this.labelReadyState.innerText = "⬜ Mark Ready for Premiere";
      this.btnToggleReady.className = "btn btn-secondary btn-sm";
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
      this.showToast("Only the Room Host can launch the Group Premiere!");
      return;
    }
    this.showToast("🎬 Mastering Dubbed Video & Launching Premiere for the Cast...");
    this.socket.send('launch_premiere', {});
  }

  toggleFilterLines() {
    this.filterMyLinesOnly = !this.filterMyLinesOnly;
    this.labelFilterLines.innerText = this.filterMyLinesOnly ? "🎭 My Lines Only" : "🌐 All Scene Lines";
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

      const charText = assignedChars.length ? assignedChars.join(', ') : 'Unassigned';
      const loc = u.location === 'screening' ? '🍿 In Screening' : (u.location === 'lobby' ? '🏠 In Lobby' : `🎙️ Line ${(u.current_line || 0) + 1}`);

      chip.innerHTML = `
        <div class="actor-hud-avatar" style="background: ${u.color};">${u.name.charAt(0).toUpperCase()}</div>
        <span style="font-weight: 700;">${u.name} ${u.id === this.user.id ? '(You)' : ''}</span>
        <span class="actor-hud-char">${charText}</span>
        <span class="actor-hud-progress">${completedTakes}/${totalAssigned} (${pct}%)</span>
        <span class="actor-hud-status-badge ${u.is_ready ? 'badge-ready' : (u.location === 'screening' ? 'badge-screening' : 'badge-recording')}">
          ${u.is_ready ? '✓ READY' : loc}
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
        this.btnLaunchPremiere.innerHTML = `<span>🎬 Launch Premiere (${readyCount}/${users.length} Ready) ›</span>`;
      } else {
        this.btnLaunchPremiere.style.display = 'none';
      }
    }
  }

  // --- Room & Lobby Logic ---

  renderLobbyState() {
    if (!this.roomState) return;

    this.lobbyPackTitle.innerText = this.roomState.pack.name;
    this.lobbyLineCount.innerText = `${this.roomState.pack.line_count} Lines`;

    const users = Object.values(this.roomState.users || {});
    this.castOnlineCount.innerText = `${users.filter(u => u.is_online).length} Online`;
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

    this.castingTbody.innerHTML = '';
    const charCounts = {};
    this.roomState.pack.lines.forEach(l => {
      charCounts[l.character] = (charCounts[l.character] || 0) + 1;
    });

    this.roomState.pack.characters.forEach((char) => {
      const assignedIds = this.roomState.role_assignments[char] || [];
      const assignedUser = users.find(u => assignedIds.includes(u.id));
      const isAssignedToMe = assignedIds.includes(this.user.id);
      const safeCharId = char.replace(/\s+/g, '-').toLowerCase();

      const tr = document.createElement('tr');
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

  async loadBoothLine(index) {
    if (!this.roomState || !this.roomState.pack.lines[index]) return;
    this.cancelCurrentCountdown();
    this.currentLineIndex = index;
    const line = this.roomState.pack.lines[index];

    this.broadcastMyStatus('booth');

    if (this.stageVideo.src !== window.location.origin + this.roomState.pack.video_url) {
      this.stageVideo.src = this.roomState.pack.video_url;
    }
    this.stageVideo.currentTime = Math.max(0, line.start);

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
    this.stageCaptionText.innerText = line.caption ? `“${line.caption}”` : `(${line.character} vocal line)`;

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
    } else {
      this.sliderNudge.value = 0;
      this.nudgeDisplay.innerText = '0 ms';
      this.sliderPitch.value = 0;
      this.valPitch.innerText = '0 st';
      this.sliderReverb.value = 0;
      this.valReverb.innerText = '0%';
      this.sliderGain.value = 0;
      this.valGain.innerText = '0 dB';
    }

    this.updateKnobsVisuals();

    this.recordState = 'idle';
    this.updateRecordButtonUI(take);
    this.setABMode('A');

    // Load original reference buffer
    this.origBuffer = await this.audio.loadAudioBuffer(line.audio_url);
    const origPeaks = WaveformRenderer.extractPeaksFromBuffer(this.origBuffer, 100);

    let takePeaks = [];
    if (take && take.url) {
      // Force fresh buffer bypass for current take
      this.currentTakeBuffer = await this.audio.loadAudioBuffer(take.url, true);
      takePeaks = take.peaks || WaveformRenderer.extractPeaksFromBuffer(this.currentTakeBuffer, 100);
    } else {
      this.currentTakeBuffer = null;
    }

    this.waveform.setData({
      origPeaks,
      takePeaks,
      offsetMs: take ? take.offset_ms : 0,
      totalDuration: line.duration + 0.8,
    });

    this.renderTimelineChips();

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
        this.btnNextLine.innerHTML = '<span>✨ I\'m Finished ✓</span>';
        this.btnNextLine.className = 'btn btn-success btn-sm btn-finished-pulse';
        this.btnNextLine.setAttribute('title', "All lines reviewed! Mark yourself ready for Premiere");
      } else {
        this.btnNextLine.innerHTML = '<span>Next Line ›</span>';
        this.btnNextLine.className = 'btn btn-primary btn-sm';
        this.btnNextLine.setAttribute('title', "Go to next dialogue line");
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
      this.recordIcon.innerText = '🔒';
      const assignedIds = (this.roomState?.role_assignments?.[line?.character] || []);
      const assignedNames = assignedIds.map(uid => this.roomState?.users?.[uid]?.name).filter(Boolean);
      const actorText = assignedNames.length > 0 ? assignedNames.join(', ') : 'Another actor';
      this.recordStatusLabel.innerText = `🔒 Assigned to ${line?.character} (${actorText}) — Read Only`;
      return;
    }

    if (this.recordState === 'recording') {
      this.btnRecordMain.className = 'btn-big-record recording';
      this.recordIcon.innerText = '⏹';
      this.recordStatusLabel.innerText = "● Recording Live... Click or Space to Stop";
    } else if (this.recordState === 'countdown') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerText = '✕';
      this.recordStatusLabel.innerText = "Counting in... Click to Cancel";
    } else if (this.recordState === 'processing') {
      this.btnRecordMain.className = 'btn-big-record';
      this.recordIcon.innerText = '⏳';
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
    if (!this.roomState) return;
    this.timelineChips.innerHTML = '';
    const myAssignedChars = this.getMyAssignedCharacters();

    this.roomState.pack.lines.forEach((l, idx) => {
      const isMyLine = myAssignedChars.includes(l.character);
      if (this.filterMyLinesOnly && !isMyLine && myAssignedChars.length > 0) {
        return; // Filter out other characters' lines when in "My Lines Only" mode
      }

      const chip = document.createElement('div');
      const hasTake = !!this.roomState.takes[idx];
      const isActive = idx === this.currentLineIndex;

      chip.className = `chip-item ${isActive ? 'active' : ''} ${hasTake ? 'done' : ''} ${isMyLine ? 'my-line' : ''}`;
      chip.title = `Line ${idx + 1}: ${l.character} (${l.start}s) ${hasTake ? '✓ Done' : ''}`;
      chip.innerText = String(idx + 1);

      chip.addEventListener('click', () => {
        this.loadBoothLine(idx);
      });

      this.timelineChips.appendChild(chip);
    });
  }

  // Play Original Reference Clip with Animated Playhead
  async playOriginalReference() {
    this.cancelCurrentCountdown();
    const line = this.roomState.pack.lines[this.currentLineIndex];
    this.audio.stopAllPlayback();

    this.stageVideo.currentTime = Math.max(0, line.start);
    this.stageVideo.play();

    let isPlaying = true;
    const startAudioTime = performance.now();
    const durationSec = Math.max(line.duration || 3.0, (this.origBuffer?.duration || 3.0)) + 0.2;

    const animPlayhead = () => {
      if (!isPlaying) return;
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
        isPlaying = false;
        this.waveform.setPlayhead(-1);
        this.stageVideo.pause();
      },
    });
  }

  // Preview Take (Bi-directional Sync & Live Waveform Animation)
  async previewCurrentTake() {
    this.cancelCurrentCountdown();
    const line = this.roomState.pack.lines[this.currentLineIndex];
    const take = this.roomState?.takes?.[this.currentLineIndex];

    if (!take || !take.url) {
      this.showToast("No take recorded yet for this line!");
      return;
    }

    // Always fetch fresh buffer to prevent stale audio playback
    this.currentTakeBuffer = await this.audio.loadAudioBuffer(take.url, true);

    this.audio.stopAllPlayback();
    const offsetMs = parseInt(this.sliderNudge.value, 10);
    const offsetSec = offsetMs / 1000.0;
    const previewStartSec = Math.max(0, line.start + Math.min(0, offsetSec));
    this.stageVideo.currentTime = previewStartSec;
    this.stageVideo.play();

    const pitch = parseFloat(this.sliderPitch.value);
    const reverb = parseFloat(this.sliderReverb.value) / 100.0;
    const gain = parseFloat(this.sliderGain.value);
    const lowcut = this.checkLowcut.checked;
    const comp = this.checkCompressor.checked;

    let isPlaying = true;
    const startAudioTime = performance.now();
    const previewDurationSec = Math.max(line.duration || 3.0, (this.currentTakeBuffer?.duration || 3.0) + Math.max(0, offsetSec)) + 0.3;

    const animPlayhead = () => {
      if (!isPlaying) return;
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
        isPlaying = false;
        this.waveform.setPlayhead(-1);
        this.stageVideo.pause();
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
    this.nudgeDisplay.innerText = `${clamped} ms`;
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
    this.stageVideo.play();

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

  async finishRecording() {
    this.waveform.setPlayhead(-1);
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }
    this.recordState = 'processing';
    this.updateRecordButtonUI();
    this.stageVideo.pause();

    const res = await this.audio.stopRecording();
    this.audio.stopAllPlayback();

    if (!res || !res.blob) {
      this.recordState = 'idle';
      this.updateRecordButtonUI();
      this.showToast("No audio recorded.");
      return;
    }

    this.currentTakeBlob = res.blob;
    await this.uploadTake(this.currentLineIndex, this.currentTakeBlob);
  }

  async uploadTake(lineIndex, blob) {
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

    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/takes/${lineIndex}`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data = await res.json();
      this.audio.evictTakeCache(lineIndex);
      this.showToast("Take recorded & saved! 🎙️");
      await this.loadBoothLine(lineIndex);
    } catch (err) {
      this.recordState = 'idle';
      this.updateRecordButtonUI();
      this.showToast("Failed to upload take: " + err.message);
    }
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

  handleUserFinishedAllLines() {
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

    if (this.roomState.has_export && (this.roomState.export_video_url || this.roomState.download_url)) {
      this.applyExportedVideoToTheater();
    } else {
      this.applyLiveMixToTheater();
    }

    this.screeningVideo.currentTime = 0;
    this.updateScreeningControls();

    // Preload all audio buffers in background for live mix mode
    this.preloadScreeningAudio();
  }

  applyExportedVideoToTheater() {
    if (!this.roomState) return;
    this.isUsingExportedVideo = true;
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    const videoUrl = this.roomState.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
    if (this.screeningVideo.src !== window.location.origin + videoUrl && this.screeningVideo.getAttribute('src') !== videoUrl) {
      this.screeningVideo.src = videoUrl;
      this.screeningVideo.currentTime = 0;
    }
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
    if (!this.roomState) return;
    this.isUsingExportedVideo = false;
    this.audio.stopAllPlayback();
    this.stopScreeningSyncMonitor();

    const packVideoUrl = this.roomState.pack.video_url;
    if (this.screeningVideo.src !== window.location.origin + packVideoUrl && this.screeningVideo.getAttribute('src') !== packVideoUrl) {
      this.screeningVideo.src = packVideoUrl;
      this.screeningVideo.currentTime = 0;
    }
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
      if (take && take.url && !this.screeningBuffers.has(take.url)) {
        return false;
      } else if (!take && line.audio_url && !this.screeningBuffers.has(line.audio_url)) {
        return false;
      }
    }
    return true;
  }

  async preloadScreeningAudio() {
    if (!this.roomState || this.isPreloadingScreening) return;
    this.isPreloadingScreening = true;

    try {
      if (this.roomState.pack.backing_url && !this.screeningBuffers.has(this.roomState.pack.backing_url)) {
        const b = await this.audio.loadAudioBuffer(this.roomState.pack.backing_url);
        this.screeningBuffers.set(this.roomState.pack.backing_url, b);
      }

      for (const line of this.roomState.pack.lines) {
        const take = this.roomState.takes[line.index];
        if (take && take.url) {
          const b = await this.audio.loadAudioBuffer(take.url, true);
          this.screeningBuffers.set(take.url, b);
        } else if (line.audio_url) {
          if (!this.screeningBuffers.has(line.audio_url)) {
            const b = await this.audio.loadAudioBuffer(line.audio_url);
            this.screeningBuffers.set(line.audio_url, b);
          }
        }
      }
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
      if (now - lastCheckTime >= 150) {
        lastCheckTime = now;
        const elapsedAudio = this.audio.ctx.currentTime - audioCtxStart;
        if (elapsedAudio > 0) {
          const expectedVideoTime = startTime + elapsedAudio;
          const currentVideoTime = this.screeningVideo.currentTime;
          const drift = currentVideoTime - expectedVideoTime;

          // If drift exceeds 40ms, softly align video to audio clock
          if (Math.abs(drift) > 0.040 && !this.screeningVideo.seeking) {
            this.screeningVideo.currentTime = expectedVideoTime;
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

  async exportFinalVideo() {
    if (!this.roomState) return;
    this.exportProgressBox.style.display = 'block';
    this.exportDownloadContainer.style.display = 'none';

    // Step 1: DSP Mastering
    if (this.stepDsp) { this.stepDsp.className = 'step-item active'; }
    if (this.stepMux) { this.stepMux.className = 'step-item'; }
    if (this.stepReady) { this.stepReady.className = 'step-item'; }
    this.exportStatusText.innerText = "Applying vocal EQ, studio compression & acoustic room reverb...";
    if (this.exportProgressFill) {
      this.exportProgressFill.style.transform = 'scaleX(0.25)';
    }

    // Step 2 and Step 3 UI progress cadence
    const progressTimer1 = setTimeout(() => {
      if (this.stepDsp) { this.stepDsp.className = 'step-item completed'; }
      if (this.stepMux) { this.stepMux.className = 'step-item active'; }
      this.exportStatusText.innerText = "Multiplexing master audio with 1080p cinema video...";
      if (this.exportProgressFill) {
        this.exportProgressFill.style.transform = 'scaleX(0.65)';
      }
    }, 700);

    const progressTimer2 = setTimeout(() => {
      this.exportStatusText.innerText = "Encoding high-fidelity MP4 container...";
      if (this.exportProgressFill) {
        this.exportProgressFill.style.transform = 'scaleX(0.88)';
      }
    }, 1500);

    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/export?aspect_ratio=${this.selectedAspectRatio}`, {
        method: 'POST',
      });
      clearTimeout(progressTimer1);
      clearTimeout(progressTimer2);

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();

      if (this.stepDsp) { this.stepDsp.className = 'step-item completed'; }
      if (this.stepMux) { this.stepMux.className = 'step-item completed'; }
      if (this.stepReady) { this.stepReady.className = 'step-item active'; }

      if (this.exportProgressFill) {
        this.exportProgressFill.style.transform = 'scaleX(1)';
      }
      this.exportStatusText.innerText = "✅ Master Dubbed Video Rendered Successfully!";
      this.btnDownloadLink.href = data.download_url_16_9 || data.download_url;
      if (this.btnDownloadLink916) {
        this.btnDownloadLink916.href = data.download_url_9_16 || `/api/rooms/${this.roomState.room_id}/export/download?aspect_ratio=9:16`;
      }
      this.exportDownloadContainer.style.display = 'flex';

      const sizeText = data.file_size_mb ? `${data.file_size_mb} MB` : '';
      const durationText = data.duration ? `${data.duration}s` : (this.roomState?.pack?.duration ? `${Math.round(this.roomState.pack.duration)}s` : '');
      const metaBadge = (sizeText || durationText) ? ` (${[sizeText, durationText].filter(Boolean).join(' • ')})` : '';

      this.btnDownloadLink.innerHTML = `<span>⬇️ Download Master Video${metaBadge}</span>`;
      this.exportDownloadContainer.style.display = 'block';

      // Instantly load the rendered master video into theater preview player
      if (this.roomState) {
        this.roomState.has_export = true;
        this.roomState.export_video_url = data.export_video_url || `/api/rooms/${this.roomState.room_id}/export/video?v=${Date.now()}`;
        this.roomState.download_url = data.download_url;
      }
      this.applyExportedVideoToTheater();

      this.showToast("🎬 Master Dubbed Video is ready in Theater & for download!");
    } catch (err) {
      clearTimeout(progressTimer1);
      clearTimeout(progressTimer2);
      if (this.exportProgressFill) {
        this.exportProgressFill.style.transform = 'scaleX(0)';
      }
      this.exportStatusText.innerText = "❌ Export failed: " + err.message;
      this.showToast("Export failed: " + err.message);
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
