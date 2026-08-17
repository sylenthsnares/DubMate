// waveform.js - High-DPI Interactive Dual Waveform Comparison & Track Sync Engine

export class WaveformRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.origPeaks = [];
    this.takePeaks = [];
    this.offsetMs = 0;
    this.playheadSec = null;
    this.totalDuration = 3.0;

    // Callbacks
    this.onOffsetChange = options.onOffsetChange || null;
    this.onOffsetCommit = options.onOffsetCommit || null;

    // Drag State
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartOffset = 0;
    this.isHovering = false;

    this.initInteractions();

    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.canvas);
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
      this.render();
    };

    const onDrag = (e) => {
      if (!this.isDragging) return;
      if (e.cancelable && e.type.startsWith('touch')) {
        e.preventDefault();
      }
      const rect = canvas.getBoundingClientRect();
      const currentX = getCanvasX(e);
      const deltaPx = currentX - this.dragStartX;
      const msPerPx = (this.totalDuration * 1000.0) / Math.max(1, rect.width);
      const deltaMs = deltaPx * msPerPx;

      const newOffset = Math.round(Math.max(-800, Math.min(800, this.dragStartOffset + deltaMs)));
      if (newOffset !== this.offsetMs) {
        this.offsetMs = newOffset;
        if (this.onOffsetChange) {
          this.onOffsetChange(this.offsetMs);
        }
        this.render();
      }
    };

    const stopDrag = () => {
      if (this.isDragging) {
        this.isDragging = false;
        canvas.style.cursor = this.takePeaks && this.takePeaks.length > 0 ? 'grab' : 'default';
        if (this.onOffsetCommit) {
          this.onOffsetCommit(this.offsetMs);
        }
        this.render();
      }
    };

    canvas.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', stopDrag);

    canvas.addEventListener('touchstart', startDrag, { passive: true });
    window.addEventListener('touchmove', onDrag, { passive: false });
    window.addEventListener('touchend', stopDrag);

    canvas.addEventListener('mouseenter', () => {
      this.isHovering = true;
      if (!this.isDragging && this.takePeaks && this.takePeaks.length > 0) {
        canvas.style.cursor = 'grab';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      this.isHovering = false;
      if (!this.isDragging) {
        canvas.style.cursor = 'default';
      }
    });
  }

  setData({ origPeaks = [], takePeaks = [], offsetMs = 0, totalDuration = 3.0 }) {
    this.origPeaks = origPeaks || [];
    this.takePeaks = takePeaks || [];
    this.offsetMs = offsetMs || 0;
    this.totalDuration = Math.max(0.5, totalDuration);
    this.canvas.style.cursor = this.takePeaks && this.takePeaks.length > 0 ? 'grab' : 'default';
    this.render();
  }

  setPlayhead(progress) {
    if (progress === null || progress === undefined || progress < 0) {
      this.playheadProgress = null;
    } else {
      this.playheadProgress = Math.max(0, Math.min(1.0, progress));
    }
    this.render();
  }

  static extractPeaksFromBuffer(buffer, columns = 100) {
    if (!buffer) return [];
    const channelData = buffer.getChannelData(0);
    const step = channelData.length / columns;
    const peaks = [];

    for (let i = 0; i < columns; i++) {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      let min = 0;
      let max = 0;
      for (let j = start; j < end; j++) {
        const val = channelData[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      peaks.push([min, max]);
    }
    return peaks;
  }

  render() {
    const canvas = this.canvas;
    const ctx = this.ctx;
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
    const midY = h / 2;

    // 1. Dark Studio Console Gradient Background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#161311');
    bgGrad.addColorStop(1, '#100e0c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // 2. Subtle Time Grid Ticks
    ctx.strokeStyle = 'rgba(244, 237, 228, 0.06)';
    ctx.fillStyle = 'rgba(180, 165, 150, 0.55)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 1;

    const tickInterval = this.totalDuration > 5.0 ? 1.0 : 0.5;
    for (let t = 0; t <= this.totalDuration; t += tickInterval) {
      const x = Math.round((t / this.totalDuration) * w);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h - 14);
      ctx.stroke();

      if (x > 18 && x < w - 18) {
        ctx.fillText(`${t.toFixed(1)}s`, x, h - 4);
      }
    }

    // 3. Center Baseline
    ctx.strokeStyle = 'rgba(244, 237, 228, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY + 0.5);
    ctx.lineTo(w, midY + 0.5);
    ctx.stroke();

    // 4. Draw Original Reference Silhouette (Channel B - Muted Studio Bronze)
    if (this.origPeaks && this.origPeaks.length > 0) {
      const gradOrig = ctx.createLinearGradient(0, 0, 0, midY);
      gradOrig.addColorStop(0, 'rgba(150, 130, 105, 0.70)');
      gradOrig.addColorStop(1, 'rgba(90, 75, 60, 0.35)');
      ctx.fillStyle = gradOrig;

      ctx.beginPath();
      const n = this.origPeaks.length;
      const step = w / n;

      for (let i = 0; i < n; i++) {
        const [min, max] = this.origPeaks[i];
        const x = i * step;
        const top = midY - max * (midY - 14);
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      for (let i = n - 1; i >= 0; i--) {
        const [min, max] = this.origPeaks[i];
        const x = i * step;
        const bot = midY - min * (midY - 14);
        ctx.lineTo(x, bot);
      }
      ctx.closePath();
      ctx.fill();
    }

    // 5. Draw Recorded Take (Channel A - Warm Amber / Tube Gold with Live Drag Offset)
    if (this.takePeaks && this.takePeaks.length > 0) {
      const offsetFraction = (this.offsetMs / 1000.0) / this.totalDuration;
      const pixelOffset = offsetFraction * w;

      const gradTake = ctx.createLinearGradient(0, midY, 0, h);
      gradTake.addColorStop(0, 'rgba(217, 119, 6, 0.90)');
      gradTake.addColorStop(1, 'rgba(180, 83, 9, 0.45)');
      ctx.fillStyle = gradTake;

      ctx.beginPath();
      const n = this.takePeaks.length;
      const step = w / n;

      for (let i = 0; i < n; i++) {
        const [min, max] = this.takePeaks[i];
        const x = pixelOffset + i * step;
        const top = midY - max * (midY - 14);
        if (i === 0) ctx.moveTo(x, top);
        else ctx.lineTo(x, top);
      }
      for (let i = n - 1; i >= 0; i--) {
        const [min, max] = this.takePeaks[i];
        const x = pixelOffset + i * step;
        const bot = midY - min * (midY - 14);
        ctx.lineTo(x, bot);
      }
      ctx.closePath();
      ctx.fill();

      // Zero-reference guide (where take originally aligned)
      ctx.strokeStyle = 'rgba(244, 237, 228, 0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0.5, 4);
      ctx.lineTo(0.5, h - 4);
      ctx.stroke();
      ctx.setLineDash([]);

      // Shift Anchor Line & Syllable Alignment Guide
      if (Math.abs(this.offsetMs) > 1) {
        ctx.strokeStyle = this.isDragging ? '#f59e0b' : '#d97706';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pixelOffset + 0.5, 4);
        ctx.lineTo(pixelOffset + 0.5, h - 16);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Dragging Delta HUD Badge
      if (this.isDragging || Math.abs(this.offsetMs) > 1) {
        const badgeX = Math.max(68, Math.min(w - 68, pixelOffset + 50));
        const badgeY = 20;
        const sign = this.offsetMs > 0 ? '+' : '';
        const text = `${sign}${this.offsetMs} ms (${(this.offsetMs / 1000).toFixed(2)}s)`;

        ctx.fillStyle = this.isDragging ? 'rgba(217, 119, 6, 0.95)' : 'rgba(180, 83, 9, 0.92)';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(badgeX - 58, badgeY - 11, 116, 22, 6);
        } else {
          ctx.rect(badgeX - 58, badgeY - 11, 116, 22);
        }
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, badgeX, badgeY);
      }
    } else {
      // Empty state hint
      ctx.fillStyle = 'rgba(180, 165, 150, 0.55)';
      ctx.font = '12px "Plus Jakarta Sans", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎙️ Record a take or press Space to see & sync waveforms', w / 2, midY + 22);
    }

    // 6. Interactive Drag Hint (top right)
    if (this.takePeaks && this.takePeaks.length > 0 && !this.isDragging) {
      ctx.fillStyle = 'rgba(217, 119, 6, 0.85)';
      ctx.font = '10px "Plus Jakarta Sans", -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('✋ Click & drag waveform to sync', w - 10, 8);
    }

    // 7. Animated Playhead Marker
    if (this.playheadProgress !== null && this.playheadProgress !== undefined && this.playheadProgress >= 0) {
      const headX = Math.max(0, Math.min(w, Math.round(this.playheadProgress * w)));

      // Playhead vertical line
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(245, 158, 11, 0.8)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(headX, 0);
      ctx.lineTo(headX, h);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Playhead top triangle
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(headX - 6, 0);
      ctx.lineTo(headX + 6, 0);
      ctx.lineTo(headX, 8);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }
}
