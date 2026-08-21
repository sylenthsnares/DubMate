// knob.js - Vintage Analog Guitar Amp Rotary Dial Controller
// Provides 270-degree tactile rotation, tick rings, vertical drag, wheel scrolling, and keyboard navigation.

export class AnalogKnob {
  constructor(inputElement, options = {}) {
    this.input = inputElement;
    if (!this.input) return;

    this.options = {
      size: options.size || 54, // Diameter in px
      minAngle: -135, // Degrees (leftmost)
      maxAngle: 135,  // Degrees (rightmost)
      sensitivity: options.sensitivity || 0.005, // Delta Y sensitivity
      label: options.label || this.input.getAttribute('aria-label') || '',
      unit: options.unit || '',
      ticks: options.ticks || 7, // Number of tick marks around perimeter
      accentColor: options.accentColor || '#d97706', // Vintage amber
      ...options
    };

    this.min = parseFloat(this.input.min) || 0;
    this.max = parseFloat(this.input.max) || 100;
    this.step = parseFloat(this.input.step) || 1;
    this.defaultValue = parseFloat(this.input.defaultValue !== '' ? this.input.defaultValue : (this.input.value || 0));

    this.isDragging = false;
    this.startY = 0;
    this.startVal = 0;

    this.initDOM();
    this.bindEvents();
    this.updateFromInput();
  }

  initDOM() {
    // Container element replacing default slider visually
    this.container = document.createElement('div');
    this.container.className = 'analog-dial-wrapper';
    this.container.tabIndex = 0;
    this.container.setAttribute('role', 'slider');
    this.container.setAttribute('aria-label', this.options.label);
    this.container.setAttribute('aria-valuemin', this.min);
    this.container.setAttribute('aria-valuemax', this.max);
    this.container.setAttribute('aria-valuenow', this.input.value);

    // Insert wrapper right before input, then move input inside (hidden for screen readers)
    this.input.parentNode.insertBefore(this.container, this.input);
    this.input.classList.add('dial-hidden-input');
    this.container.appendChild(this.input);

    // Build Dial Markup: Tick Ring + Bezel + Body + Pointer Cap
    const size = this.options.size;
    const ticksHtml = this.generateTicksHtml(size);

    const dialBody = document.createElement('div');
    dialBody.className = 'dial-housing';
    dialBody.style.width = `${size}px`;
    dialBody.style.height = `${size}px`;
    dialBody.innerHTML = `
      <div class="dial-tick-ring" aria-hidden="true">${ticksHtml}</div>
      <div class="dial-skirt">
        <div class="dial-knob-body">
          <div class="dial-knob-cap">
            <div class="dial-indicator-notch"></div>
          </div>
        </div>
      </div>
    `;

    this.container.appendChild(dialBody);
    this.knobElement = dialBody.querySelector('.dial-knob-body');
    this.housing = dialBody;
  }

  generateTicksHtml(size) {
    const numTicks = this.options.ticks;
    const minAngle = this.options.minAngle;
    const maxAngle = this.options.maxAngle;
    const angleRange = maxAngle - minAngle;
    const originY = size / 2;
    let html = '';

    for (let i = 0; i < numTicks; i++) {
      const fraction = i / (numTicks - 1);
      const angle = minAngle + fraction * angleRange;
      const isCenter = Math.abs(angle) < 1;
      const isExtreme = i === 0 || i === numTicks - 1;
      const tickClass = isExtreme ? 'dial-tick-major' : (isCenter ? 'dial-tick-center' : 'dial-tick-minor');
      
      html += `<span class="dial-tick ${tickClass}" style="transform: rotate(${angle}deg); transform-origin: 50% ${originY}px;" data-index="${i}"></span>`;
    }
    return html;
  }

  bindEvents() {
    // Mouse / Touch Drag
    const onMouseDown = (e) => {
      e.preventDefault();
      this.isDragging = true;
      this.startY = e.clientY || (e.touches && e.touches[0].clientY);
      this.startVal = parseFloat(this.input.value);
      this.container.classList.add('dial-active');
      this.container.focus();

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
    };

    const onMouseMove = (e) => {
      if (!this.isDragging) return;
      const currentY = e.clientY;
      const deltaY = this.startY - currentY; // Upward drag increases value
      const range = this.max - this.min;
      const stepVal = this.step || 1;
      
      // Calculate dynamic sensitivity based on range
      const pixelSpan = 160; // 160px drag for full sweep
      const deltaVal = (deltaY / pixelSpan) * range;
      let newVal = this.startVal + deltaVal;

      // Snap to step and bounds
      newVal = Math.round(newVal / stepVal) * stepVal;
      newVal = Math.max(this.min, Math.min(this.max, newVal));

      this.setValue(newVal, true);
    };

    const onMouseUp = () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.container.classList.remove('dial-active');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        
        // Dispatch final change event
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    const onTouchMove = (e) => {
      if (!this.isDragging) return;
      if (e.cancelable) e.preventDefault();
      const currentY = e.touches[0].clientY;
      onMouseMove({ clientY: currentY });
    };

    const onTouchEnd = () => onMouseUp();

    this.container.addEventListener('mousedown', onMouseDown);
    this.container.addEventListener('touchstart', onMouseDown, { passive: false });

    // Mouse Wheel
    this.container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const direction = e.deltaY < 0 ? 1 : -1;
      const step = this.step || 1;
      let newVal = parseFloat(this.input.value) + (direction * step);
      newVal = Math.max(this.min, Math.min(this.max, newVal));
      this.setValue(newVal, true);
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });

    // Keyboard navigation
    this.container.addEventListener('keydown', (e) => {
      let handled = false;
      const step = this.step || 1;
      let current = parseFloat(this.input.value);

      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        current = Math.min(this.max, current + step);
        handled = true;
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        current = Math.max(this.min, current - step);
        handled = true;
      } else if (e.key === 'Home') {
        current = this.min;
        handled = true;
      } else if (e.key === 'End') {
        current = this.max;
        handled = true;
      }

      if (handled) {
        e.preventDefault();
        this.setValue(current, true);
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Double click to reset
    this.container.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.setValue(this.defaultValue, true);
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Listen to native input changes (if set via code or standard events)
    this.input.addEventListener('input', () => {
      this.updateVisuals();
    });
  }

  setValue(val, triggerEvents = false) {
    const clamped = Math.max(this.min, Math.min(this.max, val));
    // Fix JS precision issues with step
    const decimals = (this.step.toString().split('.')[1] || '').length;
    const formattedVal = parseFloat(clamped.toFixed(decimals));

    if (this.input.value !== formattedVal.toString()) {
      this.input.value = formattedVal;
      this.container.setAttribute('aria-valuenow', formattedVal);
      this.updateVisuals();

      if (triggerEvents) {
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  updateFromInput() {
    this.updateVisuals();
  }

  updateVisuals() {
    const val = parseFloat(this.input.value);
    const range = this.max - this.min;
    const fraction = range === 0 ? 0 : (val - this.min) / range;
    const angleRange = this.options.maxAngle - this.options.minAngle;
    const angle = this.options.minAngle + fraction * angleRange;

    if (this.knobElement) {
      this.knobElement.style.transform = `rotate(${angle.toFixed(1)}deg)`;
    }

    // Active state highlighting on tick marks
    const ticks = this.housing.querySelectorAll('.dial-tick');
    const activeIndex = Math.round(fraction * (ticks.length - 1));
    ticks.forEach((tick, idx) => {
      tick.classList.toggle('dial-tick-active', idx <= activeIndex);
    });
  }
}

// Global helper to initialize all dials with standard configuration
export function initAllKnobs() {
  const dials = [];
  
  const dialConfigs = [
    { id: 'slider-backing-vol', size: 44, ticks: 11, unit: '%' },
    { id: 'slider-pitch', size: 40, ticks: 9, unit: 'st' },
    { id: 'slider-reverb', size: 40, ticks: 7, unit: '%' },
    { id: 'slider-gain', size: 40, ticks: 11, unit: 'dB' },
    { id: 'slider-decay', size: 36, ticks: 7, unit: 's' },
    { id: 'slider-predelay', size: 36, ticks: 7, unit: 'ms' },
  ];

  dialConfigs.forEach(cfg => {
    const input = document.getElementById(cfg.id);
    if (input && !input.dataset.knobInitialized) {
      input.dataset.knobInitialized = 'true';
      const knob = new AnalogKnob(input, cfg);
      dials.push({ id: cfg.id, knob });
    }
  });

  return dials;
}
