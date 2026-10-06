// studio/voice_rack.js - The booth's Voice panel: presets first, the full rack one click away
// (documentation/design/effects-rack.md, "What changes for the user"). Every control changes
// the take's voice chain on screen at once and asks the engine for its render; the take keeps
// playing the last real render until the new one crossfades in.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { AudioEngine } from '../audio_engine.js';
import { lineTakes } from './takes.js';
import { CLEAN_CHAIN, resolveChain, editChain, presetLabel, eqCurveDb, createRenderScheduler } from './voice.js';

const EFFECTS_MISSING_MESSAGE = "Download and install the latest DubMate to use voice effects.";
// A take's own sound is saved this long after the last change to it (and when a dial is let go).
const VOICE_SAVE_QUIET_MS = 400;

const PRESET_TIPS = {
  clean: 'Your voice, with low rumble removed',
  warm: 'Fuller and smoother, with a little room',
  radio: 'Thin and boxy, like a speaker or a phone',
  monster: 'Lower and bigger',
};

const copyChain = (chain) => JSON.parse(JSON.stringify(chain));

/** The two chains set the same sound (key order and 80 vs 80.0 don't matter). */
function sameChain(a, b) {
  const canon = (value) => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
    }
    return value;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** A dial's readout: "80 Hz", "1.8 kHz", "-4 st", "+2 dB", "3:1", "1.5 s", "20 ms", "35%". */
function formatParam(param, value) {
  const v = Number(value) || 0;
  if (param === 'mix') return `${Math.round(v * 100)}%`;
  if (param === 'semitones') return `${v > 0 ? '+' : ''}${v} st`;
  if (param === 'ratio') return `${+v.toFixed(1)}:1`;
  if (param === 'decay_s') return `${v.toFixed(1)} s`;
  if (param.endsWith('_ms')) return `${Math.round(v)} ms`;
  if (param === 'hz' || param.endsWith('_hz')) return v >= 1000 ? `${+(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (param.endsWith('_db')) return `${v > 0 ? '+' : ''}${+v.toFixed(1)} dB`;
  return String(v);
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class VoiceRackMethods {
  initVoiceRackEvents() {
    this.voicePanel = document.getElementById('card-voice-dsp');
    this.voicePresets = document.getElementById('voice-presets');
    this.voicePresetCustom = document.getElementById('voice-preset-custom');
    this.btnVoiceAllEffects = document.getElementById('btn-voice-all-effects');
    this.voiceRack = document.getElementById('voice-rack');
    this.voiceToneCurve = document.getElementById('voice-tone-curve');
    this.voiceMeterFill = document.getElementById('voice-meter-fill');
    this.btnVoiceUseCharacter = document.getElementById('btn-voice-use-character');
    this.btnVoiceUseSession = document.getElementById('btn-voice-use-session');
    this.voiceStatusDot = document.getElementById('voice-status-dot');
    this.voiceEffectsNote = document.getElementById('voice-effects-note');

    this.voicePresets?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-preset]');
      if (chip && !chip.disabled) this.pickVoicePreset(chip.dataset.preset);
    });
    this.btnVoiceAllEffects?.addEventListener('click', () => this.toggleAllEffects());

    // Each effect: an on/off switch and dials. A dial turned on an effect that's off turns it on.
    for (const fx of this.voiceRack?.querySelectorAll('[data-node]') || []) {
      const name = fx.dataset.node;
      const toggle = fx.querySelector('[data-voice-on]');
      toggle?.addEventListener('change', () => {
        this.editTakeVoice(name, { on: toggle.checked });
        this.flushVoiceSave();
      });
      for (const dial of fx.querySelectorAll('[data-voice-param]')) {
        const param = dial.dataset.voiceParam;
        dial.addEventListener('input', () => {
          const raw = parseFloat(dial.value);
          this.editTakeVoice(name, { on: true, [param]: param === 'mix' ? raw / 100 : raw });
        });
        dial.addEventListener('change', () => this.flushVoiceSave());
      }
    }

    this.btnVoiceUseCharacter?.addEventListener('click', () => this.useVoiceOn('character'));
    this.btnVoiceUseSession?.addEventListener('click', () => this.useVoiceOn('session'));
  }

  toggleAllEffects() {
    if (!this.voiceRack) return;
    const open = !this.voiceRack.classList.contains('open');
    this.voiceRack.classList.toggle('open', open);
    document.getElementById('booth-controls-panel')?.classList.toggle('fx-expanded', open);
    this.btnVoiceAllEffects.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.btnVoiceAllEffects.innerText = open ? 'All effects ▴' : 'All effects ▾';
  }

  // --- The take's sound: rendered by the engine, the same render the export uses ---

  /** This tab's id on render requests: the engine drops a tab's still-queued render of a
   *  take when the tab asks for a newer one. */
  renderClientId() {
    if (!this.voiceClientId) {
      const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : null;
      this.voiceClientId = uuid || `tab-${Math.random().toString(36).slice(2, 12)}`;
    }
    return this.voiceClientId;
  }

  /** Asks the engine to render a take through `chain`. Resolves { status: 200, url, buffer, ... },
   *  { status: 409 } (a newer request replaced it) or { status: 503, message } (no voice effects). */
  async requestTakeRender(roomId, lineId, takeId, chain, { untilS = null, clientId = this.renderClientId() } = {}) {
    const body = { chain, client_id: clientId };
    if (untilS != null) body.until_s = untilS;
    const res = await fetch(`/api/rooms/${roomId}/lines/${lineId}/takes/${takeId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 409 || res.status === 503) {
      let data = {};
      try { data = (await res.json()) || {}; } catch (e) { }
      if (res.status === 503) this.voiceEffectsMessage = data.message || EFFECTS_MISSING_MESSAGE;
      return { ...data, status: res.status };
    }
    if (!res.ok) {
      console.warn(`[App] Rendering the take's sound failed: HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    // Not kept in the buffer cache: a dragged dial makes many renders, and the engine keeps them.
    const buffer = data && data.url ? await this.audio.loadAudioBuffer(data.url, true) : null;
    if (!buffer) throw new Error("The take's sound didn't load");
    return { ...data, status: 200, buffer };
  }

  /** On line load: the take's chain on the controls, and its render asked for. */
  startTakeVoice(line, take) {
    if (this.voiceScheduler) this.voiceScheduler.dispose();
    this.voiceScheduler = null;
    this.voiceRender = null;
    this.releaseVoiceWaiters();
    this.voiceChain = resolveChain(this.roomState?.voice, line.character, take);
    this.renderVoicePresets();
    this.showVoiceChain(this.voiceChain);
    if (take && take.url) {
      const roomId = this.roomState.room_id;
      const scheduler = createRenderScheduler({
        request: (chain, { untilS }) => this.requestTakeRender(roomId, line.line_id, take.take_id, chain, { untilS }),
        onReady: (render) => this.onTakeRender(render),
        onState: (state) => this.onTakeVoiceState(state),
      });
      this.voiceScheduler = scheduler;
      scheduler.want(this.voiceChain, this.voicePlayState());
    }
    this.refreshVoiceControls();
  }

  /** Saves any pending edit and stops asking for renders (leaving the room). */
  stopTakeVoice() {
    this.flushVoiceSave();
    if (this.voiceScheduler) this.voiceScheduler.dispose();
    this.voiceScheduler = null;
    this.voiceRender = null;
    this.voiceUnavailable = false;   // the next room may be on an engine that has them
    this.releaseVoiceWaiters();
  }

  voicePlayState() {
    const take = this.roomState && this.takeForLine(this.currentLineIndex);
    return {
      playing: this.isPlayingCurrentTake(),
      playheadS: this.audio.takePositionS() || 0,
      takeDuration: this.currentTakeBuffer?.duration || Number(take?.duration) || 0,
    };
  }

  onTakeRender(render) {
    if (!render.partial) {
      this.voiceRender = render;
      this.voiceUnavailable = false;
    }
    if (this.isPlayingCurrentTake()) this.audio.crossfadeTo(render.buffer, { prefix: render.partial });
  }

  onTakeVoiceState(state) {
    if (state === 'unavailable') this.voiceUnavailable = true;
    this.refreshVoiceControls();
    if (state === 'current' || state === 'unavailable') this.releaseVoiceWaiters();
  }

  /** Resolves once the take's render is ready, or can't be made. */
  waitForTakeVoice() {
    const scheduler = this.voiceScheduler;
    if (!scheduler || scheduler.state === 'current' || scheduler.state === 'unavailable') return Promise.resolve();
    return new Promise((resolve) => {
      if (!this.voiceWaiters) this.voiceWaiters = [];
      this.voiceWaiters.push(resolve);
    });
  }

  releaseVoiceWaiters() {
    const waiters = this.voiceWaiters || [];
    this.voiceWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  // --- The panel ---

  /** One chip per preset the engine offers (Clean, Warm, Radio, Monster). */
  renderVoicePresets() {
    if (!this.voicePresets) return;
    const presets = this.roomState?.voice?.presets || [];
    const ids = presets.map((p) => p.id).join(',');
    if (this.voicePresets.dataset.ids === ids) return;
    this.voicePresets.dataset.ids = ids;
    this.voicePresets.querySelectorAll('[data-preset]').forEach((chip) => chip.remove());
    for (const preset of presets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'voice-chip';
      chip.dataset.preset = preset.id;
      chip.textContent = preset.name;
      if (PRESET_TIPS[preset.id]) chip.dataset.tip = PRESET_TIPS[preset.id];
      chip.setAttribute('aria-pressed', 'false');
      this.voicePresets.insertBefore(chip, this.voicePresetCustom || null);
    }
  }

  /** Chips, switches, dials, readouts and the Tone curve show a chain. */
  showVoiceChain(chain) {
    const nodes = { ...CLEAN_CHAIN.nodes, ...(chain?.nodes || {}) };
    const presets = this.roomState?.voice?.presets || [];
    const custom = presetLabel(chain, presets) === 'Custom';
    for (const chip of this.voicePresets?.querySelectorAll('[data-preset]') || []) {
      const active = !custom && chip.dataset.preset === chain?.preset;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (this.voicePresetCustom) this.voicePresetCustom.style.display = custom ? '' : 'none';

    for (const fx of this.voiceRack?.querySelectorAll('[data-node]') || []) {
      const node = { ...CLEAN_CHAIN.nodes[fx.dataset.node], ...nodes[fx.dataset.node] };
      const toggle = fx.querySelector('[data-voice-on]');
      if (toggle) toggle.checked = !!node.on;
      fx.classList.toggle('is-off', !node.on);
      for (const dial of fx.querySelectorAll('[data-voice-param]')) {
        const param = dial.dataset.voiceParam;
        const value = Number(node[param]) || 0;
        dial.value = param === 'mix' ? Math.round(value * 100) : value;
        const text = formatParam(param, value);
        dial.setAttribute('aria-valuetext', text);
        dial.closest('.analog-dial-wrapper')?.setAttribute('aria-valuetext', text);
        const readout = dial.closest('.dsp-dial-channel')?.querySelector('[data-readout]');
        if (readout) readout.textContent = text;
      }
    }
    this.drawToneCurve(nodes.eq);
    this.updateKnobsVisuals();
  }

  /** Tone's curve, 20 Hz to 20 kHz, ±12 dB. */
  drawToneCurve(eq) {
    const canvas = this.voiceToneCurve;
    const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const freqs = Array.from({ length: w }, (_, i) => 20 * Math.pow(1000, i / (w - 1)));
    const curve = eqCurveDb(eq, freqs);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(204, 164, 88, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = eq?.on ? '#cca458' : 'rgba(204, 164, 88, 0.45)';
    ctx.beginPath();
    curve.forEach((db, x) => {
      const y = h / 2 - (Math.max(-12, Math.min(12, db)) / 12) * (h / 2 - 3);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /** The panel shows on a line you can record that has a take. Effect controls work once
   *  voice effects are installed. A dot pulses while the sound catches up; the note says
   *  why effects are off. */
  refreshVoiceControls() {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const take = line && this.takeForLine(this.currentLineIndex);
    const mine = !!take && this.canRecordLine(line);
    if (this.voicePanel) this.voicePanel.style.display = mine ? '' : 'none';

    const enabled = mine && !this.isProcessingTake && !this.voiceUnavailable;
    const controls = this.voicePanel?.querySelectorAll('[data-preset], [data-voice-on], [data-voice-param], .voice-apply-row button') || [];
    for (const el of controls) {
      el.disabled = !enabled;
      (el.closest('.dsp-dial-channel') || el).classList.toggle('ui-interaction-locked', !enabled);
    }

    if (this.btnVoiceUseCharacter) {
      this.btnVoiceUseCharacter.style.display = mine ? '' : 'none';
      if (line) this.btnVoiceUseCharacter.textContent = `Use on all of ${line.character}'s lines`;
    }
    if (this.btnVoiceUseSession) {
      this.btnVoiceUseSession.style.display = mine && this.isHost({ allowDummy: true }) ? '' : 'none';
    }

    const state = this.voiceScheduler?.state;
    if (this.voiceStatusDot) {
      this.voiceStatusDot.style.display = (state === 'waiting' || state === 'rendering') ? '' : 'none';
      this.voiceStatusDot.classList.toggle('is-still', prefersReducedMotion());
    }
    if (this.voiceEffectsNote) {
      this.voiceEffectsNote.textContent = this.voiceUnavailable ? (this.voiceEffectsMessage || EFFECTS_MISSING_MESSAGE) : '';
      this.voiceEffectsNote.style.display = this.voiceUnavailable ? '' : 'none';
    }
  }

  /** The take's output level on the small meter while it plays. */
  startVoiceMeter() {
    if (this.voiceMeterRaf || !this.voiceMeterFill) return;
    const step = () => {
      const db = this.audio.takeOutputDb();
      this.voiceMeterFill.style.width = `${db === null ? 0 : AudioEngine.dbToMeterPercent(db)}%`;
      this.voiceMeterRaf = db === null ? null : requestAnimationFrame(step);
    };
    this.voiceMeterRaf = requestAnimationFrame(step);
  }

  // --- Changing the sound ---

  /** The take's own sound becomes `chain` now: the controls show it, the engine renders it
   *  (the take keeps playing the last render until then), and it's saved once things are quiet. */
  setTakeVoice(chain, { saveNow = false } = {}) {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const take = line && this.takeForLine(this.currentLineIndex);
    if (!take || !this.voiceScheduler || !this.canRecordLine(line) || this.voiceUnavailable) return;
    this.voiceChain = chain;
    take.chain = chain;
    this.showVoiceChain(chain);
    this.voiceScheduler.want(chain, this.voicePlayState());
    clearTimeout(this.voiceSaveTimer);
    this.voiceSavePending = { roomId: this.roomState.room_id, lineId: line.line_id, takeId: take.take_id, chain };
    if (saveNow) this.flushVoiceSave();
    else this.voiceSaveTimer = setTimeout(() => this.flushVoiceSave(), VOICE_SAVE_QUIET_MS);
  }

  /** One effect changed: the sound becomes Custom. */
  editTakeVoice(name, params) {
    this.setTakeVoice(editChain(this.voiceChain, name, params));
  }

  pickVoicePreset(id) {
    const preset = (this.roomState?.voice?.presets || []).find((p) => p.id === id);
    if (preset) this.setTakeVoice(copyChain(preset.chain), { saveNow: true });
  }

  /** Saves the take's edited sound now (a dial was let go, or the line is changing). */
  flushVoiceSave() {
    clearTimeout(this.voiceSaveTimer);
    this.voiceSaveTimer = null;
    const pending = this.voiceSavePending;
    this.voiceSavePending = null;
    if (!pending) return Promise.resolve();
    this.voiceSavesInFlight = (this.voiceSavesInFlight || 0) + 1;
    return fetch(`/api/rooms/${pending.roomId}/lines/${pending.lineId}/takes/${pending.takeId}/chain`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: this.user.id, chain: pending.chain }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => this.applySavedTakeLevel(pending, data && data.take))
      .catch((err) => this.showToast(this.friendlyError(err, "Your take's sound wasn't saved. Try again.")))
      .finally(() => { this.voiceSavesInFlight -= 1; });
  }

  /** The engine matched the take's level on its new sound; a take at its matched level moved with it. */
  applySavedTakeLevel(pending, saved) {
    if (!saved || this.roomState?.room_id !== pending.roomId) return;
    const line = this.roomState.pack.lines.find((l) => l.line_id === pending.lineId);
    const take = lineTakes(this.roomState.takes, line).find((t) => t.take_id === pending.takeId);
    if (!take) return;
    for (const key of ['gain_db', 'auto_gain_db', 'loudness_lufs', 'target_lufs']) {
      if (key in saved) take[key] = saved[key];
    }
    if (line.index === this.currentLineIndex && take === this.takeForLine(this.currentLineIndex)) this.showTakeLevel(take);
  }

  /** "Use on all of NAME's lines" (scope "character") or "Use on every line" (scope "session"):
   *  asks first, then makes this sound the character's or the room's. */
  async useVoiceOn(scope) {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (!line || !this.voiceChain) return;
    const question = scope === 'session'
      ? 'Use this sound on every line? Lines and characters with their own sound will switch too.'
      : `Use this sound on all of ${line.character}'s lines? Lines you changed by hand will switch too.`;
    if (!confirm(question)) return;
    // The take follows the new sound, so an unsaved edit of its own sound is dropped.
    clearTimeout(this.voiceSaveTimer);
    this.voiceSavePending = null;
    const body = { user_id: this.user.id, scope, chain: this.voiceChain };
    if (scope === 'character') body.character = line.character;
    try {
      const res = await fetch(`/api/rooms/${this.roomState.room_id}/voice`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.detail || ''; } catch (e) { }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      this.showToast(scope === 'session' ? 'Every line uses this sound' : `All of ${line.character}'s lines use this sound`);
    } catch (err) {
      this.showToast(this.friendlyError(err, "That sound wasn't applied. Try again."));
    }
  }

  /** The room's sounds changed (voice_updated) or a take's did (take_params_updated): the
   *  current take plays whatever now resolves for it, unless you're still editing it. */
  onRoomVoiceChanged() {
    if (this.currentView !== 'booth' || !this.voiceScheduler || this.voiceSavePending || this.voiceSavesInFlight) return;
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const take = line && this.takeForLine(this.currentLineIndex);
    if (!take) return;
    this.renderVoicePresets();
    const chain = resolveChain(this.roomState.voice, line.character, take);
    if (sameChain(chain, this.voiceChain)) return;
    this.voiceChain = chain;
    this.showVoiceChain(chain);
    this.voiceScheduler.want(chain, this.voicePlayState());
  }
}
