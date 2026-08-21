// waveform.js - High-DPI Interactive Dual-Stacked Waveform Comparison & ADR Track Sync Engine

export class WaveformRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.origPeaks = [];
    this.takePeaks = [];
    this.offsetMs = 0;
    this.playheadProgress = null;
    this.totalDuration = 3.0;
    this._rafId = null;

    // Callbacks
    this.onOffsetChange = options.onOffsetChange || null;
    this.onOffsetCommit = options.onOffsetCommit || null;

    // Interaction State
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartOffset = 0;
    this.isHovering = false;
    this.hoverX = null;

    if (this.canvas) {
      this.initInteractions();

      const targetObserved = this.canvas.parentElement || this.canvas;
      try {
        this.resizeObserver = new ResizeObserver(() => {
          this.requestRender();
        });
        this.resizeObserver.observe(targetObserved);
      } catch (e) {
        window.addEventListener('resize', () => this.requestRender());
      }
    }
  }

  requestRender() {
    if (this._rafId) return;
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame) 
      ? window.requestAnimationFrame.bind(window)
      : (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : ((cb) => setTimeout(cb, 16)));
    this._rafId = raf(() => {
      this._rafId = null;
      this.render();
    });
  }

  initInteractions() {
    const canvas = this.canvas;

    const getCanvasX = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
      return clientX - rect.left;
    };

    const startDrag = (e) => {
      if (!this.takePeaks || this.takePeaks.length === 0) return;
      this.isDragging = true;
      this.dragStartX = getCanvasX(e);
      this.dragStartOffset = this.offsetMs;
      canvas.style.cursor = 'grabbing';
      this.requestRender();
    };

    const onDrag = (e) => {
      const currentX = getCanvasX(e);
      this.hoverX = currentX;

      if (!this.isDragging) {
        if (this.isHovering) this.requestRender();
        return;
      }

      if (e.cancelable && e.type.startsWith('touch')) {
        e.preventDefault();
      }
      const rect = canvas.getBoundingClientRect();
      const deltaPx = currentX - this.dragStartX;
      const msPerPx = (this.totalDuration * 1000.0) / Math.max(1, rect.width);
      const deltaMs = deltaPx * msPerPx;

      const newOffset = Math.round(Math.max(-800, Math.min(800, this.dragStartOffset + deltaMs)));
      if (newOffset !== this.offsetMs) {
        this.offsetMs = newOffset;
        if (this.onOffsetChange) {
          this.onOffsetChange(this.offsetMs);
        }
        this.requestRender();
      }
    };

    const stopDrag = () => {
      if (this.isDragging) {
        this.isDragging = false;
        canvas.style.cursor = this.takePeaks && this.takePeaks.length > 0 ? 'grab' : 'default';
        if (this.onOffsetCommit) {
          this.onOffsetCommit(this.offsetMs);
        }
        this.requestRender();
      }
    };

    canvas.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', stopDrag);

    canvas.addEventListener('touchstart', startDrag, { passive: true });
    window.addEventListener('touchmove', onDrag, { passive: false });
    window.addEventListener('touchend', stopDrag);

    canvas.addEventListener('mouseenter', (e) => {
      this.isHovering = true;
      this.hoverX = getCanvasX(e);
      if (!this.isDragging && this.takePeaks && this.takePeaks.length > 0) {
        canvas.style.cursor = 'grab';
      }
      this.requestRender();
    });

    canvas.addEventListener('mouseleave', () => {
      this.isHovering = false;
      this.hoverX = null;
      if (!this.isDragging) {
        canvas.style.cursor = 'default';
      }
      this.requestRender();
    });
  }

  setData({ origPeaks = [], takePeaks = [], offsetMs = 0, totalDuration = 3.0 }) {
    this.origPeaks = origPeaks || [];
    this.takePeaks = takePeaks || [];
    this.offsetMs = offsetMs || 0;
    this.totalDuration = Math.max(0.5, totalDuration);
    if (this.canvas) {
      this.canvas.style.cursor = this.takePeaks && this.takePeaks.length > 0 ? 'grab' : 'default';
    }
    this.requestRender();
  }

  setPlayhead(progress) {
    if (progress === null || progress === undefined || progress < 0) {
      this.playheadProgress = null;
    } else {
      this.playheadProgress = Math.max(0, Math.min(1.0, progress));
    }
    this.requestRender();
  }

  static extractPeaksFromBuffer(buffer, columns = 120) {
    if (!buffer || typeof buffer.getChannelData !== 'function') return [];
    try {
      const channelData = buffer.getChannelData(0);
      if (!channelData || channelData.length === 0) return [];
      const step = channelData.length / columns;
      const peaks = [];

      for (let i = 0; i < columns; i++) {
        const start = Math.floor(i * step);
        const end = Math.max(start + 1, Math.floor((i + 1) * step));
        let min = 0;
        let max = 0;
        for (let j = start; j < Math.min(channelData.length, end); j++) {
          const val = channelData[j];
          if (val < min) min = val;
          if (val > max) max = val;
        }
        peaks.push([min, max]);
      }
      return peaks;
    } catch (e) {
      console.warn("[WaveformRenderer] Error extracting peaks from buffer:", e);
      return [];
    }
  }

  render() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) return;

    const displayWidth = Math.round(rect.width);
    const displayHeight = Math.round(rect.height);
    const targetWidth = Math.round(displayWidth * dpr);
    const targetHeight = Math.round(displayHeight * dpr);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const w = displayWidth;
    const h = displayHeight;

    // -------------------------------------------------------------
    // 1. Dual-Track Dimensions
    // -------------------------------------------------------------
    const rulerHeight = 16;
    const tracksTotalHeight = h - rulerHeight;
    const trackHeight = Math.floor(tracksTotalHeight / 2);
    
    // Lane 1: Original Reference Track (Top Half)
    const lane1Top = 0;
    const lane1Bottom = trackHeight;
    const lane1MidY = trackHeight / 2;
    const lane1Amp = Math.max(8, lane1MidY - 3);

    // Lane 2: User Take Track (Bottom Half)
    const lane2Top = trackHeight + 1;
    const lane2Bottom = tracksTotalHeight;
    const lane2MidY = lane2Top + trackHeight / 2;
    const lane2Amp = Math.max(8, (lane2Bottom - lane2Top) / 2 - 3);

    // -------------------------------------------------------------
    // 2. Background Studio Console Gradient
    // -------------------------------------------------------------
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#15120f');
    bgGrad.addColorStop(0.5, '#12100e');
    bgGrad.addColorStop(1, '#0e0c0a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Lane 1 & Lane 2 subtle alternating background tints
    ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
    ctx.fillRect(0, lane1Top, w, lane1Bottom - lane1Top);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(0, lane2Top, w, lane2Bottom - lane2Top);

    // -------------------------------------------------------------
    // 3. Time Grid Lines & Ruler Ticks
    // -------------------------------------------------------------
    ctx.strokeStyle = 'rgba(244, 237, 228, 0.05)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(168, 159, 149, 0.6)';
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';

    const tickInterval = this.totalDuration > 6.0 ? 1.0 : (this.totalDuration > 3.0 ? 0.5 : 0.25);
    for (let t = 0; t <= this.totalDuration; t += tickInterval) {
      const x = Math.round((t / this.totalDuration) * w);
      
      // Vertical grid line through both tracks
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, tracksTotalHeight);
      ctx.stroke();

      // Bottom ruler ticks & timestamp
      ctx.strokeStyle = 'rgba(244, 237, 228, 0.15)';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, tracksTotalHeight);
      ctx.lineTo(x + 0.5, tracksTotalHeight + 4);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(244, 237, 228, 0.05)';

      if (x > 22 && x < w - 22) {
        ctx.fillText(`${t.toFixed(t % 1 === 0 ? 0 : 1)}s`, x, h - 3);
      }
    }

    // Ruler Divider Bar
    ctx.strokeStyle = 'rgba(244, 237, 228, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, tracksTotalHeight + 0.5);
    ctx.lineTo(w, tracksTotalHeight + 0.5);
    ctx.stroke();

    // -------------------------------------------------------------
    // 4. Center Baselines for Both Tracks
    // -------------------------------------------------------------
    // Lane 1 Baseline
    ctx.strokeStyle = 'rgba(204, 164, 88, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, lane1MidY + 0.5);
    ctx.lineTo(w, lane1MidY + 0.5);
    ctx.stroke();

    // Lane Divider Bar
    ctx.strokeStyle = 'rgba(244, 237, 228, 0.15)';
    ctx.beginPath();
    ctx.moveTo(0, lane1Bottom + 0.5);
    ctx.lineTo(w, lane1Bottom + 0.5);
    ctx.stroke();

    // Lane 2 Baseline
    ctx.strokeStyle = 'rgba(217, 119, 6, 0.2)';
    ctx.beginPath();
    ctx.moveTo(0, lane2MidY + 0.5);
    ctx.lineTo(w, lane2MidY + 0.5);
    ctx.stroke();

    // -------------------------------------------------------------
    // 5. Render Track 1: Original Reference Voice (Top Lane)
    // -------------------------------------------------------------
    if (this.origPeaks && this.origPeaks.length > 0) {
      const gradOrig = ctx.createLinearGradient(0, lane1Top, 0, lane1Bottom);
      gradOrig.addColorStop(0, '#cca458');
      gradOrig.addColorStop(0.5, '#b38d42');
      gradOrig.addColorStop(1, '#8c6e33');
      ctx.fillStyle = gradOrig;

      ctx.beginPath();
      const n = this.origPeaks.length;
      const step = w / n;

      // Top boundary
      for (let i = 0; i < n; i++) {
        const [min, max] = this.origPeaks[i];
        const x = i * step;
        const top = lane1MidY - max * lane1Amp;
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      // Bottom boundary
      for (let i = n - 1; i >= 0; i--) {
        const [min, max] = this.origPeaks[i];
        const x = i * step;
        const bot = lane1MidY - min * lane1Amp;
        ctx.lineTo(x, bot);
      }
      ctx.closePath();
      ctx.fill();

      // Subtle waveform center ridge
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i * step;
        const max = this.origPeaks[i][1];
        const top = lane1MidY - max * lane1Amp;
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(168, 159, 149, 0.4)';
      ctx.font = '500 10.5px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Original reference audio loading...', 110, lane1MidY + 3);
    }

    // -------------------------------------------------------------
    // 6. Render Track 2: User Recorded Take (Bottom Lane)
    // -------------------------------------------------------------
    const hasTake = this.takePeaks && this.takePeaks.length > 0;
    if (hasTake) {
      const offsetFraction = (this.offsetMs / 1000.0) / this.totalDuration;
      const pixelOffset = offsetFraction * w;

      const gradTake = ctx.createLinearGradient(0, lane2Top, 0, lane2Bottom);
      gradTake.addColorStop(0, '#f59e0b');
      gradTake.addColorStop(0.5, '#d97706');
      gradTake.addColorStop(1, '#b45309');
      ctx.fillStyle = gradTake;

      ctx.beginPath();
      const n = this.takePeaks.length;
      const step = w / n;

      // Top boundary
      for (let i = 0; i < n; i++) {
        const [min, max] = this.takePeaks[i];
        const x = pixelOffset + i * step;
        const top = lane2MidY - max * lane2Amp;
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      // Bottom boundary
      for (let i = n - 1; i >= 0; i--) {
        const [min, max] = this.takePeaks[i];
        const x = pixelOffset + i * step;
        const bot = lane2MidY - min * lane2Amp;
        ctx.lineTo(x, bot);
      }
      ctx.closePath();
      ctx.fill();

      // Ridge highlight
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = pixelOffset + i * step;
        const max = this.takePeaks[i][1];
        const top = lane2MidY - max * lane2Amp;
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      ctx.stroke();

      // Zero-Offset Origin Guide Line
      if (Math.abs(this.offsetMs) > 2) {
        ctx.strokeStyle = 'rgba(244, 237, 228, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(0.5, lane2Top);
        ctx.lineTo(0.5, lane2Bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Syllable Shift Anchor Line across Lane 2
      ctx.strokeStyle = this.isDragging ? '#f59e0b' : '#d97706';
      ctx.lineWidth = this.isDragging ? 2 : 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(pixelOffset + 0.5, lane2Top);
      ctx.lineTo(pixelOffset + 0.5, lane2Bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Empty Take Placeholder in Lane 2
      ctx.fillStyle = 'rgba(168, 159, 149, 0.5)';
      ctx.font = '500 11px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('🎙️ No take recorded yet — punch in above or press Space to record your take', 110, lane2MidY + 3);
    }

    // -------------------------------------------------------------
    // 7. Track Identification Badges (Permanent Left Labels)
    // -------------------------------------------------------------
    // Track 1 Badge: ORIGINAL REF
    ctx.fillStyle = 'rgba(20, 17, 14, 0.88)';
    ctx.strokeStyle = 'rgba(204, 164, 88, 0.35)';
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(6, lane1Top + 4, 88, 18, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(6, lane1Top + 4, 88, 18);
      ctx.strokeRect(6, lane1Top + 4, 88, 18);
    }
    ctx.fillStyle = '#cca458';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ORIGINAL REF', 50, lane1Top + 13);

    // Track 2 Badge: YOUR TAKE
    ctx.fillStyle = hasTake ? 'rgba(30, 20, 10, 0.92)' : 'rgba(20, 17, 14, 0.88)';
    ctx.strokeStyle = hasTake ? 'rgba(217, 119, 6, 0.5)' : 'rgba(168, 159, 149, 0.2)';
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(6, lane2Top + 4, 88, 18, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(6, lane2Top + 4, 88, 18);
      ctx.strokeRect(6, lane2Top + 4, 88, 18);
    }
    ctx.fillStyle = hasTake ? '#f59e0b' : 'rgba(168, 159, 149, 0.6)';
    ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('YOUR TAKE', 50, lane2Top + 13);

    // -------------------------------------------------------------
    // 8. Cross-Track Syllable Alignment Crosshair (On Drag / Hover)
    // -------------------------------------------------------------
    if (this.isDragging || (this.isHovering && this.hoverX !== null)) {
      const guideX = this.hoverX;
      if (guideX >= 0 && guideX <= w) {
        ctx.strokeStyle = this.isDragging ? 'rgba(245, 158, 11, 0.75)' : 'rgba(244, 237, 228, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(guideX + 0.5, 0);
        ctx.lineTo(guideX + 0.5, tracksTotalHeight);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // -------------------------------------------------------------
    // 9. Dragging Delta HUD Overlay Badge
    // -------------------------------------------------------------
    if (this.isDragging || Math.abs(this.offsetMs) > 1) {
      const offsetFraction = (this.offsetMs / 1000.0) / this.totalDuration;
      const pixelOffset = offsetFraction * w;
      const badgeX = Math.max(90, Math.min(w - 90, pixelOffset + w / 2));
      const badgeY = lane2Top + 13;
      const sign = this.offsetMs > 0 ? '+' : '';
      const text = `OFFSET: ${sign}${this.offsetMs} ms (${(this.offsetMs / 1000).toFixed(2)}s)`;

      ctx.fillStyle = this.isDragging ? 'rgba(217, 119, 6, 0.95)' : 'rgba(35, 28, 22, 0.92)';
      ctx.strokeStyle = this.isDragging ? '#f59e0b' : 'rgba(217, 119, 6, 0.4)';
      ctx.lineWidth = 1;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 8;
      
      const badgeW = 148;
      const badgeH = 22;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(badgeX - badgeW / 2, badgeY - badgeH / 2, badgeW, badgeH, 5);
      } else {
        ctx.rect(badgeX - badgeW / 2, badgeY - badgeH / 2, badgeW, badgeH);
      }
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, badgeX, badgeY);
    }

    // -------------------------------------------------------------
    // 10. Drag-to-Sync Hint (Top Right)
    // -------------------------------------------------------------
    if (hasTake && !this.isDragging) {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.85)';
      ctx.font = '600 9.5px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('✋ Click & drag waveform or use [ ] keys to sync', w - 10, lane2Top + 13);
    }

    // -------------------------------------------------------------
    // 11. Animated Playhead Marker (Sweeps Both Tracks)
    // -------------------------------------------------------------
    if (this.playheadProgress !== null && this.playheadProgress !== undefined && this.playheadProgress >= 0) {
      const headX = Math.max(0, Math.min(w, Math.round(this.playheadProgress * w)));

      // Playhead vertical needle
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(245, 158, 11, 0.85)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(headX, 0);
      ctx.lineTo(headX, h);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Playhead top needle cap
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(headX - 5, 0);
      ctx.lineTo(headX + 5, 0);
      ctx.lineTo(headX, 7);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }
}
