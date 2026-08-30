// pack_builder.js - High-Performance Pack Authoring Studio Controller
// Handles Video Ingestion, Demucs/Whisper Progress SSE, Interactive Timeline & Cue Editor, and Pack Assembly

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export class PackBuilderApp {
  constructor() {
    this.sessionId = null;
    this.videoFile = null;
    this.coverFile = null;
    this.subFile = null;
    this.duration = 0.0;
    this.segments = [];
    this.characterColors = new Map();
    this.currentStep = 'upload';
    this.currentIngestTab = 'file'; // 'file' | 'url'

    // Waveform & Timeline Engine State
    this.waveformPeaks = [];
    this.pixelsPerSecond = 80; // Zoom factor
    this.selectedSegmentIndex = null;
    this.activeAudioTrack = 'vocals'; // 'vocals' | 'full'

    // Drag & Pan States
    this.isDragging = false;
    this.dragType = null; // 'move' | 'start' | 'end'
    this.dragSegmentIndex = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragOrigStart = 0;
    this.dragOrigEnd = 0;
    this.hasMovedPastThreshold = false;

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
    this.detectHardware();
  }

  async detectHardware() {
    try {
      const res = await fetch('/api/system/encoder');
      if (res.ok) {
        const data = await res.json();
        if (this.deviceLabel) {
          const isHw = data.is_hardware;
          const vendor = data.vendor || 'GPU';
          const enc = (data.encoder || '').replace('h264_', '').toUpperCase();
          this.deviceLabel.innerText = isHw ? `⚡ ${vendor} ${enc}` : `💻 ${data.encoder}`;
        }
        if (this.devicePill) {
          this.devicePill.title = `Encoding Engine: ${data.description}`;
          if (data.is_hardware) {
            this.devicePill.style.borderColor = 'rgba(22, 163, 74, 0.4)';
          }
        }
      }
    } catch (e) {
      console.warn('[PackBuilder] Could not detect hardware acceleration engine:', e);
    }
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

    this.videoDropzone = document.getElementById('video-dropzone');
    this.inputVideoFile = document.getElementById('input-video-file');
    this.videoSelectedCard = document.getElementById('video-selected-card');
    this.selectedVideoName = document.getElementById('selected-video-name');
    this.selectedVideoStats = document.getElementById('selected-video-stats');
    this.videoThumbContainer = document.getElementById('video-thumb-container');
    this.btnChangeVideo = document.getElementById('btn-change-video');
    this.inputPackTitle = document.getElementById('input-pack-title');
    this.selectTranscribeLang = document.getElementById('select-transcribe-lang');
    this.subDropzone = document.getElementById('sub-dropzone');
    this.inputSubFile = document.getElementById('input-sub-file');
    this.subFilenameLabel = document.getElementById('sub-filename-label');
    this.coverDropzone = document.getElementById('cover-dropzone');
    this.inputCoverFile = document.getElementById('input-cover-file');
    this.coverFilenameLabel = document.getElementById('cover-filename-label');
    this.btnStartProcess = document.getElementById('btn-start-process');

    // Step 2: Processing progress elements
    this.processHeadline = document.getElementById('process-headline');
    this.processSubtext = document.getElementById('process-subtext');
    this.builderProgressFill = document.getElementById('builder-progress-fill');
    this.processStageText = document.getElementById('process-stage-text');
    this.processPercentText = document.getElementById('process-percent-text');
    this.stageExtract = document.getElementById('stage-extract');
    this.stageStems = document.getElementById('stage-stems');
    this.stageWhisper = document.getElementById('stage-whisper');

    // Step 3: Editor elements
    this.editorVideo = document.getElementById('editor-video');
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
    this.dawChannelStrips = document.getElementById('daw-channel-strips');
    this.labelDawChannelCount = document.getElementById('label-daw-channel-count');
    this.timelineChannelGuides = document.getElementById('timeline-channel-guides');
    this.timelineSplitterHandle = document.getElementById('timeline-splitter-handle');
    this.editorBottomTimelinePanel = document.querySelector('.editor-bottom-timeline-panel');
    this.btnAddAudioTrack = document.getElementById('btn-add-audio-track');
    this.tracks = ['Audio Track 1'];

    // Sidebar & Cues
    this.labelCueCount = document.getElementById('label-cue-count');
    this.characterChipsList = document.getElementById('character-chips-list');
    this.btnAddCharacter = document.getElementById('btn-add-character');
    this.segmentsListContainer = document.getElementById('segments-list-container');
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
    });

    // 2. Subtitle file selection
    this.subDropzone.addEventListener('click', () => this.inputSubFile.click());
    this.inputSubFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.subFile = e.target.files[0];
        this.subFilenameLabel.innerText = `✓ ${this.subFile.name}`;
      }
    });

    // 3. Cover art selection
    this.coverDropzone.addEventListener('click', () => this.inputCoverFile.click());
    this.inputCoverFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        this.coverFile = e.target.files[0];
        this.coverFilenameLabel.innerText = `✓ ${this.coverFile.name}`;
      }
    });

    // 4. Start AI processing button
    this.btnStartProcess.addEventListener('click', () => this.startProcessingPipeline());

    // 5. Video player controls
    this.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    this.editorVideo.addEventListener('play', () => this.onVideoPlayState(true));
    this.editorVideo.addEventListener('pause', () => this.onVideoPlayState(false));
    this.editorVideo.addEventListener('ended', () => this.onVideoPlayState(false));
    this.btnStepBackward.addEventListener('click', () => this.seekRelative(-1.0));
    this.btnStepForward.addEventListener('click', () => this.seekRelative(1.0));

    // 6. Audio track switch (vocals only vs full audio)
    this.btnToggleAudioTrack.addEventListener('click', async () => {
      this.activeAudioTrack = this.activeAudioTrack === 'vocals' ? 'full' : 'vocals';
      this.labelActiveTrack.innerText = this.activeAudioTrack === 'vocals' ? 'Vocals Only' : 'Full Audio';
      await this.fetchWaveformPeaks(this.activeAudioTrack);
      this.renderWaveformCanvas();
      this.showToast(`Switched playback to ${this.labelActiveTrack.innerText}`);
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
        // Horizontal pan
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        this.timelineScrollWrap.scrollLeft += delta;
      }
    }, { passive: false });

    // 10. Timeline Canvas Pan (Grab to Pan & Click to Seek)
    this.timelineScrollWrap.addEventListener('mousedown', (e) => {
      // Don't initiate pan if clicked on a segment handle, block, delete button, or interactive element
      if (e.target.closest('.builder-segment-handle') || e.target.closest('.builder-segment-block') || e.target.closest('.segment-inline-delete-btn') || e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panScrollLeft = this.timelineScrollWrap.scrollLeft;
      this.hasMovedPastThreshold = false;
      this.timelineScrollWrap.classList.add('panning');
      document.body.style.userSelect = 'none';
    });

    // 11. Drag handlers for segment blocks, handles, and panning
    window.addEventListener('mousemove', (e) => this.handleGlobalMouseMove(e));
    window.addEventListener('mouseup', (e) => this.handleGlobalMouseUp(e));

    // 12. Character management
    this.btnAddCharacter.addEventListener('click', () => this.promptAddCharacter());

    // 13. Proceed to compile
    this.btnProceedToCompile.addEventListener('click', () => this.goToCompileStep());
    this.btnExecuteCompile.addEventListener('click', () => this.executePackCompilation());

    // 14. Add Audio Track button
    if (this.btnAddAudioTrack) {
      this.btnAddAudioTrack.addEventListener('click', () => this.addAudioTrack());
    }

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

    this.timelineSplitterHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startResize(e.clientY);
    });

    this.timelineSplitterHandle.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length > 0) {
        startResize(e.touches[0].clientY);
      }
    }, { passive: true });

    // Double-click to reset to default height (240px)
    this.timelineSplitterHandle.addEventListener('dblclick', () => {
      const defaultH = 240;
      this.editorBottomTimelinePanel.style.setProperty('--timeline-panel-height', `${defaultH}px`);
      this.editorBottomTimelinePanel.style.height = `${defaultH}px`;
      localStorage.removeItem('dubmate_pack_builder_timeline_h');
      this.renderWaveformCanvas();
      this.renderTimelineSegments();
      this.showToast('Reset timeline height to default (240px)');
    });
  }

  initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
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
    this.selectedVideoStats.innerText = `${mbSize} MB • Processing source ready`;

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

  async handleUrlImport() {
    const url = (this.inputYoutubeUrl.value || '').trim();
    if (!url) {
      this.showToast('Please paste a YouTube or web video URL.');
      if (this.inputYoutubeUrl) this.inputYoutubeUrl.focus();
      return;
    }

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
        timeDesc.innerText = `Downloading video, up to 1080p... (${elapsed}s)`;
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
        const err = await res.json();
        throw new Error(err.detail || 'Failed to import video from URL.');
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

      if (data.device_info) {
        const dev = data.device_info;
        if (dev.cuda_available) {
          this.deviceLabel.innerText = `CUDA GPU: ${dev.device.toUpperCase()}`;
          this.devicePill.style.borderColor = 'rgba(22, 163, 74, 0.4)';
        } else {
          this.deviceLabel.innerText = 'Multi-Core CPU Pipeline';
        }
      }

      // Brief delay so user sees all green checkmarks
      await new Promise(r => setTimeout(r, 450));

      // Update selected card
      this.selectedVideoName.innerText = data.title || data.filename;
      this.selectedVideoStats.innerText = `${this.formatTime(data.duration)} • YouTube Source Ready`;

      if (this.ingestPanelFile) this.ingestPanelFile.style.display = 'none';
      if (this.ingestPanelUrl) this.ingestPanelUrl.style.display = 'none';
      this.videoSelectedCard.style.display = 'flex';
      this.btnStartProcess.disabled = false;

      if (data.has_subtitles) {
        this.showToast(`Imported video + ${data.subtitles_count} subtitles from YouTube!`);
      } else {
        this.showToast(`YouTube video downloaded & ready!`);
      }
    } catch (e) {
      clearInterval(timerInterval);
      this.showToast(`Import Error: ${e.message}`);
    } finally {
      this.btnFetchUrl.disabled = false;
      this.urlFetchLoading.style.display = 'none';
    }
  }

  // --- STEP 2: Upload & AI Pipeline ---

  async startProcessingPipeline() {
    if (!this.videoFile && !this.sessionId) return;

    this.setStep('process');
    this.processHeadline.innerText = 'Preparing Video & Audio...';
    this.processSubtext.innerText = 'Initializing stems separation pipeline...';
    this.builderProgressFill.style.width = '10%';
    this.processPercentText.innerText = '10%';

    try {
      // If local file was selected and session hasn't been created yet
      if (this.videoFile && !this.sessionId) {
        this.processHeadline.innerText = 'Uploading Scene Video...';
        this.processSubtext.innerText = 'Uploading video file to studio processing engine...';

        const formData = new FormData();
        formData.append('file', this.videoFile);

        const uploadRes = await fetch('/api/builder/upload', {
          method: 'POST',
          body: formData,
        });

        if (!uploadRes.ok) {
          const err = await uploadRes.json();
          throw new Error(err.detail || 'Upload failed');
        }

        const uploadData = await uploadRes.json();
        this.sessionId = uploadData.session_id;
        this.duration = uploadData.duration;

        if (uploadData.device_info) {
          const dev = uploadData.device_info;
          if (dev.cuda_available) {
            this.deviceLabel.innerText = `CUDA GPU: ${dev.device.toUpperCase()}`;
            this.devicePill.style.borderColor = 'rgba(22, 163, 74, 0.4)';
          } else {
            this.deviceLabel.innerText = 'Multi-Core CPU Pipeline';
          }
        }
      }

      if (this.coverFile) {
        const coverData = new FormData();
        coverData.append('file', this.coverFile);
        await fetch(`/api/builder/${this.sessionId}/cover`, {
          method: 'POST',
          body: coverData,
        });
      }

      if (this.subFile) {
        const subData = new FormData();
        subData.append('file', this.subFile);
        const subRes = await fetch(`/api/builder/${this.sessionId}/import_subtitles`, {
          method: 'POST',
          body: subData,
        });
        if (subRes.ok) {
          const subJson = await subRes.json();
          if (subJson.segments && subJson.segments.length > 0) {
            this.segments = subJson.segments;
          }
        }
      }

      const lang = this.selectTranscribeLang.value;
      await fetch(`/api/builder/${this.sessionId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang, whisper_model: 'base' }),
      });

      this.listenToProgressSSE();

    } catch (ex) {
      this.processHeadline.innerText = 'Processing Error';
      this.processSubtext.innerText = ex.message;
      this.showToast(`Error: ${ex.message}`);
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
        this.processStageText.innerText = data.message || 'Processing...';

        const status = data.status;
        this.stageExtract.classList.toggle('active', status === 'extracting_audio');
        this.stageStems.classList.toggle('active', status === 'separating_stems');
        this.stageWhisper.classList.toggle('active', status === 'transcribing');

        if (status === 'transcribed') {
          sse.close();
          this.segments = data.segments || this.segments;
          setTimeout(() => {
            this.setStep('editor');
          }, 600);
        } else if (status === 'error') {
          sse.close();
          this.processHeadline.innerText = 'Processing Failed';
          this.processSubtext.innerText = data.error || 'Unknown error occurred.';
          this.showToast(`Pipeline Error: ${data.error}`);
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
        if (!res.ok) return;
        const data = await res.json();
        const pct = Math.round((data.progress || 0.0) * 100);
        this.builderProgressFill.style.width = `${pct}%`;
        this.processPercentText.innerText = `${pct}%`;
        this.processStageText.innerText = data.message || 'Processing...';

        if (data.status === 'transcribed') {
          clearInterval(interval);
          this.segments = data.segments || this.segments;
          this.setStep('editor');
        } else if (data.status === 'error') {
          clearInterval(interval);
          this.processHeadline.innerText = 'Processing Failed';
          this.processSubtext.innerText = data.error || 'Error during processing.';
        }
      } catch (e) {
        clearInterval(interval);
      }
    }, 1000);
  }

  // --- STEP 3: Timeline & Cue Editor ---

  async setupEditorView() {
    this.editorVideo.src = `/api/builder/${this.sessionId}/video`;
    this.editorVideo.load();
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
    await this.fetchWaveformPeaks(this.activeAudioTrack || 'vocals');

    const containerWidth = this.timelineScrollWrap.clientWidth || 800;
    this.pixelsPerSecond = Math.max(40, Math.min(180, (containerWidth * 1.5) / Math.max(1, this.duration)));
    this.updateZoomLabel();

    this.renderWaveformCanvas();
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.startPlaybackLoop();
  }

  async fetchWaveformPeaks(track = 'vocals') {
    if (!this.sessionId) return;
    try {
      const res = await fetch(`/api/builder/${this.sessionId}/waveform?columns=1200&track=${track}`);
      if (res.ok) {
        const data = await res.json();
        this.waveformPeaks = data.peaks || [];
        if (data.duration > 0) {
          this.duration = data.duration;
        }
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

  updateTrackButtonsState() {
    if (this.btnAddAudioTrack) {
      const isMax = this.tracks.length >= 5;
      this.btnAddAudioTrack.disabled = isMax;
      this.btnAddAudioTrack.title = isMax ? 'Maximum 5 audio tracks reached' : 'Add another audio track lane (up to 5)';
    }
  }

  getLaneDimensions() {
    const numLanes = Math.max(1, Math.min(5, this.tracks.length));
    const containerHeight = Math.max(160, this.timelineScrollWrap?.clientHeight || 200);
    const TOTAL_HEIGHT = Math.max(140, containerHeight - 24);

    // Keep individual tracks sleek and compact:
    // When 1 track: ~68px (well-proportioned, not a giant full-height block)
    // When 2-5 tracks: scales dynamically (~38px - 64px) to fit up to 5 tracks inside the panel
    let laneHeight;
    if (numLanes === 1) {
      laneHeight = Math.min(70, Math.max(50, Math.floor(TOTAL_HEIGHT * 0.45)));
    } else {
      laneHeight = Math.max(38, Math.min(64, Math.floor(TOTAL_HEIGHT / numLanes)));
    }
    const totalHeight = laneHeight * numLanes;
    return { numLanes, laneHeight, totalHeight, TOTAL_HEIGHT };
  }

  renderChannelStrips(activeLanes = []) {
    if (!this.dawChannelStrips) return;
    this.dawChannelStrips.innerHTML = '';
    if (this.timelineChannelGuides) this.timelineChannelGuides.innerHTML = '';
    if (this.labelDawChannelCount) {
      this.labelDawChannelCount.innerText = `${this.tracks.length} Audio Track${this.tracks.length === 1 ? '' : 's'}`;
    }
    this.updateTrackButtonsState();

    const { numLanes, laneHeight } = this.getLaneDimensions();

    this.tracks.forEach((trackName, idx) => {
      const header = document.createElement('div');
      header.className = 'daw-channel-header';
      header.style.height = `${laneHeight}px`;
      header.dataset.channel = idx;

      const isActive = activeLanes.includes(idx);
      const canDelete = this.tracks.length > 1;

      header.innerHTML = `
        <div class="channel-id-badge">A${idx + 1}</div>
        <div class="channel-info">
          <input type="text" class="channel-title-input" value="${escapeHtml(trackName)}" data-channel="${idx}" title="Click to rename Track ${idx + 1}" aria-label="Track ${idx + 1} Name" maxlength="24">
        </div>
        <div class="channel-header-actions">
          <div class="channel-indicator ${isActive ? 'active' : ''}" title="${isActive ? 'Active dialogue take' : 'Idle'}"></div>
          ${canDelete ? `
            <button type="button" class="btn-del-track" data-channel="${idx}" title="Delete Track A${idx + 1}">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" style="pointer-events: none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          ` : ''}
        </div>
      `;

      const input = header.querySelector('.channel-title-input');
      input.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        this.tracks[idx] = val || `Audio Track ${idx + 1}`;
        e.target.value = this.tracks[idx];
        this.showToast(`Renamed Track ${idx + 1} to "${this.tracks[idx]}"`);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });

      const delBtn = header.querySelector('.btn-del-track');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteAudioTrack(idx);
        });
      }

      this.dawChannelStrips.appendChild(header);

      if (this.timelineChannelGuides) {
        const guide = document.createElement('div');
        guide.className = 'channel-lane-guide';
        guide.style.height = `${laneHeight}px`;
        this.timelineChannelGuides.appendChild(guide);
      }
    });
  }

  addAudioTrack() {
    if (this.tracks.length >= 5) {
      this.showToast('Maximum 5 audio tracks reached.');
      return;
    }
    const nextNum = this.tracks.length + 1;
    this.tracks.push(`Audio Track ${nextNum}`);
    this.renderWaveformCanvas();
    this.renderTimelineSegments();
    this.updateTrackButtonsState();
    this.showToast(`Added Audio Track ${nextNum}`);
  }

  deleteAudioTrack(idx) {
    if (this.tracks.length <= 1) {
      this.showToast('At least 1 audio track is required.');
      return;
    }
    const removedName = this.tracks[idx];
    this.tracks.splice(idx, 1);
    this.renderWaveformCanvas();
    this.renderTimelineSegments();
    this.updateTrackButtonsState();
    this.showToast(`Deleted ${removedName}. Remaining tracks expanded to fit.`);
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

  renderTimelineSegments() {
    const overlay = this.timelineSegmentsOverlay;
    overlay.innerHTML = '';

    const { numLanes, laneHeight, totalHeight } = this.getLaneDimensions();

    // Compute collision lanes for overlapping segments constrained to numLanes
    const laneEndTimes = new Array(numLanes).fill(0);
    const segmentLanes = [];

    this.segments.forEach((seg, idx) => {
      let placedLane = -1;
      for (let l = 0; l < numLanes; l++) {
        if (laneEndTimes[l] <= seg.start + 0.05) {
          placedLane = l;
          laneEndTimes[l] = seg.end;
          break;
        }
      }
      if (placedLane === -1) {
        placedLane = 0;
        let minEnd = laneEndTimes[0];
        for (let l = 1; l < numLanes; l++) {
          if (laneEndTimes[l] < minEnd) {
            minEnd = laneEndTimes[l];
            placedLane = l;
          }
        }
        laneEndTimes[placedLane] = seg.end;
      }
      segmentLanes[idx] = placedLane;
    });

    const activeLanes = Array.from(new Set(segmentLanes));
    this.renderChannelStrips(activeLanes);

    this.timelineViewport.style.height = `${totalHeight}px`;

    this.segments.forEach((seg, idx) => {
      const left = seg.start * this.pixelsPerSecond;
      const width = Math.max(18, (seg.end - seg.start) * this.pixelsPerSecond);
      const color = this.getCharacterColor(seg.character);
      const isSelected = idx === this.selectedSegmentIndex;
      const lane = Math.min(numLanes - 1, segmentLanes[idx] || 0);

      const blockHeight = Math.max(24, laneHeight - 8);
      const topPos = lane * laneHeight + 4;

      const block = document.createElement('div');
      block.className = `builder-segment-block ${isSelected ? 'selected' : ''}`;
      block.style.left = `${left}px`;
      block.style.width = `${width}px`;
      block.style.top = `${topPos}px`;
      block.style.height = `${blockHeight}px`;
      block.style.borderColor = color;
      block.style.background = `${color}28`;

      // Left resize handle
      const handleL = document.createElement('div');
      handleL.className = 'builder-segment-handle handle-left';
      handleL.style.background = color;
      handleL.dataset.idx = idx;
      handleL.dataset.type = 'start';
      handleL.title = 'Drag to trim start';

      // Right resize handle
      const handleR = document.createElement('div');
      handleR.className = 'builder-segment-handle handle-right';
      handleR.style.background = color;
      handleR.dataset.idx = idx;
      handleR.dataset.type = 'end';
      handleR.title = 'Drag to trim end';

      // Inner content wrap
      const contentWrap = document.createElement('div');
      contentWrap.className = 'segment-block-content';

      const label = document.createElement('div');
      label.className = 'segment-block-label';
      label.innerText = `[${seg.character}] ${seg.text || '...'}`;

      // Inline Delete Action Button right on the block
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'segment-inline-delete-btn';
      deleteBtn.type = 'button';
      deleteBtn.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" style="pointer-events: none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      deleteBtn.title = 'Delete this dialogue line';

      // Prevent mousedown / mouseup from triggering segment block drag or deselect
      deleteBtn.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      deleteBtn.addEventListener('mouseup', (e) => {
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

      // Mouse drag handlers on segment block
      block.addEventListener('mousedown', (e) => {
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
        e.stopPropagation();
      });

      overlay.appendChild(block);
    });
  }

  renderSegmentsList() {
    const container = this.segmentsListContainer;
    container.innerHTML = '';
    this.labelCueCount.innerText = `${this.segments.length} Lines`;

    const allCast = Array.from(new Set([
      ...this.characterColors.keys(),
      ...this.segments.map(s => s.character).filter(Boolean)
    ]));
    if (allCast.length === 0) allCast.push('Lead');

    this.segments.forEach((seg, idx) => {
      const isSelected = idx === this.selectedSegmentIndex;
      const color = this.getCharacterColor(seg.character);

      const card = document.createElement('div');
      card.className = `builder-cue-card ${isSelected ? 'selected' : ''}`;
      card.id = `cue-card-${idx}`;

      // Build options for character dropdown
      const charOptionsHtml = allCast.map(c =>
        `<option value="${escapeHtml(c)}" ${c === seg.character ? 'selected' : ''}>${escapeHtml(c)}</option>`
      ).join('') + '<option value="__ADD_NEW__">+ New Character...</option>';

      card.innerHTML = `
        <div class="cue-card-header">
          <div class="cue-index-wrap">
            <span class="cue-dot" style="background: ${color};"></span>
            <span class="cue-number">#${idx + 1}</span>
          </div>
          <div class="cue-timecode-badge">${this.formatTime(seg.start)} → ${this.formatTime(seg.end)}</div>
          <div style="display: flex; gap: 4px; align-items: center;">
            <button class="btn btn-secondary btn-xs btn-whisper-cue" data-idx="${idx}" title="Transcribe this line with Whisper AI">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
              <span>Whisper</span>
            </button>
            <button class="btn btn-secondary btn-xs btn-romaji-cue" data-idx="${idx}" title="Convert Japanese Kanji/Kana to Romaji">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span>Romaji</span>
            </button>
            <button class="btn-delete-cue" title="Delete Cue" data-idx="${idx}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              <span>Delete</span>
            </button>
          </div>
        </div>
        <div class="cue-card-body">
          <div class="cue-field-row">
            <div class="cue-char-select-wrap">
              <select class="form-input cue-char-select" data-idx="${idx}" title="Change character role">
                ${charOptionsHtml}
              </select>
            </div>
            <button class="btn btn-secondary btn-xs btn-preview-cue" data-idx="${idx}" title="Preview audio for this line">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>Play Take</span>
            </button>
          </div>
          <textarea class="form-input cue-text-input" rows="2" placeholder="Dialogue subtitle text..." data-idx="${idx}">${escapeHtml(seg.text || '')}</textarea>
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
          const newName = prompt('Enter new character name:');
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
      textInput.addEventListener('input', (e) => {
        this.segments[idx].text = e.target.value;
      });
      textInput.addEventListener('change', () => {
        this.renderTimelineSegments();
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
      btnWhisper.addEventListener('click', (e) => {
        e.stopPropagation();
        this.transcribeSingleSegment(idx, btnWhisper, textInput);
      });

      const btnRomaji = card.querySelector('.btn-romaji-cue');
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
        <span class="chip-name" title="Click to rename role">${escapeHtml(char)}</span>
        <span class="chip-count-badge" title="${count} line(s) assigned">(${count})</span>
        <button class="chip-del-btn" title="Delete character role" data-char="${escapeHtml(char)}">
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
  }

  deleteCharacter(charName) {
    const segmentsWithChar = this.segments.filter(s => s.character === charName);
    const remainingChars = Array.from(this.characterColors.keys()).filter(c => c !== charName);
    const fallbackChar = remainingChars.length > 0 ? remainingChars[0] : 'Lead';

    if (segmentsWithChar.length > 0) {
      if (!confirm(`Delete character "${charName}"? Its ${segmentsWithChar.length} line(s) will be reassigned to "${fallbackChar}".`)) {
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
    this.showToast(`Deleted character role "${charName}"`);
  }

  promptRenameCharacter(oldName) {
    const newName = prompt(`Rename character role "${oldName}" across all lines to:`, oldName);
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
      this.showToast(`Renamed role "${oldName}" to "${cleanNew}"`);
    }
  }

  selectSegment(idx) {
    this.selectedSegmentIndex = idx;
    this.renderTimelineSegments();

    const allCards = this.segmentsListContainer.querySelectorAll('.builder-cue-card');
    allCards.forEach((c, i) => c.classList.toggle('selected', i === idx));
    const targetCard = document.getElementById(`cue-card-${idx}`);
    if (targetCard) {
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
    this.hasMovedPastThreshold = false;
    document.body.style.userSelect = 'none';
  }

  handleGlobalMouseMove(e) {
    // 0. Handle Timeline Vertical Resizing
    if (this.isResizingTimeline) {
      const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : null);
      if (clientY !== null && this.editorBottomTimelinePanel) {
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

    // 1. Handle Canvas Grab Panning
    if (this.isPanning) {
      const deltaX = e.clientX - this.panStartX;
      if (Math.abs(deltaX) > 4) {
        this.hasMovedPastThreshold = true;
      }
      this.timelineScrollWrap.scrollLeft = this.panScrollLeft - deltaX;
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

    this.renderTimelineSegments();
    this.updateCardTimecode(this.dragSegmentIndex);
  }

  handleGlobalMouseUp(e) {
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
      if (!this.hasMovedPastThreshold && e && e.target) {
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
      this.isDragging = false;
      this.dragSegmentIndex = null;
      this.dragType = null;
      document.body.style.userSelect = '';

      if (hadMovement) {
        this.segments.sort((a, b) => a.start - b.start);
        this.renderTimelineSegments();
        this.renderSegmentsList();
        this.syncSegmentsToServer();
      } else if (modifiedIdx !== null && this.segments[modifiedIdx]) {
        this.selectSegment(modifiedIdx);
        this.seekTo(this.segments[modifiedIdx].start);
      }
    }
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
      this.editorVideo.play();
    } else {
      this.editorVideo.pause();
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
    const clamped = Math.max(0, Math.min(this.duration, seconds));
    this.editorVideo.currentTime = clamped;
    this.updatePlayheadPosition();
  }

  seekRelative(deltaSeconds) {
    this.seekTo(this.editorVideo.currentTime + deltaSeconds);
  }

  startPlaybackLoop() {
    const loop = () => {
      this.updatePlayheadPosition();
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
    this.showToast('Added dialogue line at playhead');
  }

  deleteSegment(idx) {
    if (idx < 0 || idx >= this.segments.length) return;
    this.isDragging = false;
    this.dragSegmentIndex = null;
    this.dragType = null;
    this.segments.splice(idx, 1);
    this.selectedSegmentIndex = null;
    this.renderTimelineSegments();
    this.renderSegmentsList();
    this.renderCharacterChips();
    this.syncSegmentsToServer();
    this.showToast('Deleted dialogue line');
  }

  promptAddCharacter() {
    const name = prompt('Enter new character name:');
    if (name && name.trim()) {
      const clean = name.trim();
      this.getCharacterColor(clean);
      this.renderCharacterChips();
      this.renderSegmentsList();
      this.showToast(`Added character role "${clean}"`);
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
      this.showToast(`Marked In [ at ${this.formatTime(t)}`);
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
        this.showToast(`Marked Out ] at ${this.formatTime(t)}`);
      }
    }
  }

  previewSegmentAudio(idx) {
    const seg = this.segments[idx];
    if (!seg) return;
    this.seekTo(seg.start);
    this.editorVideo.play();
    const playDuration = (seg.end - seg.start) * 1000;
    setTimeout(() => {
      if (!this.editorVideo.paused && this.editorVideo.currentTime >= seg.end - 0.1) {
        this.editorVideo.pause();
      }
    }, playDuration);
  }

  async syncSegmentsToServer() {
    if (!this.sessionId) return;
    try {
      await fetch(`/api/builder/${this.sessionId}/segments`, {
        method: 'POST',
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
      btnEl.innerHTML = '<svg class="spinning" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><span>Transcribing...</span>';
      btnEl.disabled = true;
    }
    this.showToast(`Transcribing cue #${idx + 1} with Whisper AI...`);

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
          this.renderTimelineSegments();
          this.syncSegmentsToServer();
          this.showToast(`Whisper recognized: "${seg.text}"`);
        } else {
          this.showToast(`Whisper did not detect clear dialogue in this section.`);
        }
      } else {
        this.showToast(`Whisper transcription failed.`);
      }
    } catch (e) {
      console.warn('Transcription error:', e);
      this.showToast(`Error: ${e.message}`);
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
      this.showToast('Dialogue text is empty.');
      return;
    }

    const origText = btnEl ? btnEl.innerHTML : '';
    if (btnEl) {
      btnEl.innerHTML = '<svg class="spinning" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg><span>Converting...</span>';
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
          this.renderTimelineSegments();
          this.syncSegmentsToServer();
          this.showToast(`Romanized: "${seg.text}"`);
        }
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
    if (this.selectedSegmentIndex === null) {
      this.showToast('Please select a dialogue line on the timeline first.');
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
      this.showToast('Please add at least 1 dialogue line before building.');
      return;
    }

    this.setStep('compile');
    this.editorVideo.pause();

    const savedUser = localStorage.getItem('dubmate_user_name') || '';
    this.compilePackName.value = this.inputPackTitle.value || this.selectedVideoName.innerText.replace(/\.[^/.]+$/, '');
    this.compileAuthor.value = savedUser || 'Creator';
    this.compileSubtitle.value = `${this.segments.length} dialogue lines • ${this.characterColors.size} characters`;

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
    this.compileStatusMsg.innerText = 'Slicing audio lines with micro-fades and compiling pack...';

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
        const err = await res.json();
        throw new Error(err.detail || 'Pack compilation failed.');
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
      this.showToast(`🎉 Pack '${packName}' successfully compiled!`);

    } catch (ex) {
      this.compileProgressBox.style.display = 'none';
      this.btnExecuteCompile.style.display = 'block';
      this.showToast(`Compilation Error: ${ex.message}`);
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

  initModeDropdown() {
    const container = document.getElementById('logo-dropdown-container');
    const btnDropdown = document.getElementById('btn-mode-dropdown');
    const menu = document.getElementById('mode-dropdown-menu');
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

  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = message;
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-6px)';
    toast.style.transition = 'opacity 160ms ease-out, transform 160ms ease-out';
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
}

// Instantiate Pack Builder Studio
document.addEventListener('DOMContentLoaded', () => {
  window.packBuilderApp = new PackBuilderApp();
});
