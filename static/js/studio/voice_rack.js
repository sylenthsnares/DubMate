// studio/voice_rack.js - The booth's Voice card: presets, "For" and Level first; All effects turns
// the column's middle into the full rack (documentation/design/effects-rack.md, "What changes for
// the user"; ui-u2-booth.md, "VOICE card"). Every control changes the sound on screen at once and
// asks the engine for the take's render; the take keeps playing the last real render until the
// new one crossfades in. "For" says where an edit goes: the take, its character, or every line.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
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

// "For", narrowest first: choosing a wider one asks; a narrower one copies the sound there.
const SCOPE_WIDTH = { take: 0, character: 1, session: 2 };

/** How many of the chain's effects are on. */
function effectsOn(chain) {
  const nodes = chain?.nodes || {};
  return Object.keys(CLEAN_CHAIN.nodes).filter((name) => ({ ...CLEAN_CHAIN.nodes[name], ...nodes[name] }).on).length;
}

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
    const $ = (id) => document.getElementById(id);
    this.voicePanel = $('card-voice-dsp');
    this.voicePresets = $('voice-presets');
    this.voicePresetCustom = $('voice-preset-custom');
    this.btnVoiceAllEffects = $('btn-voice-all-effects');
    this.btnVoiceBack = $('btn-voice-back');
    this.voiceOnCount = $('voice-on-count');
    this.voicePageSummary = $('voice-page-summary');
    this.voiceRack = $('voice-rack');
    this.voiceToneCurve = $('voice-tone-curve');
    this.voiceScopeSelect = $('voice-scope');
    this.voiceScopeAsk = $('voice-scope-ask');
    this.voiceScopeAskText = $('voice-scope-ask-text');
    this.btnVoiceScopeYes = $('btn-voice-scope-yes');
    this.voiceScopeStatus = $('voice-scope-status');
    this.voiceLevelTake = $('voice-level-take');
    this.voiceLevelNote = $('voice-level-note');
    this.voiceStatusDot = $('voice-status-dot');
    this.voiceEffectsNote = $('voice-effects-note');
    // The sound picked on a line before its first take, by line id; sent with that take's upload.
    this.pendingNextTakeChain = {};
    this.voiceScope = 'take';

    this.voicePresets?.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-preset]');
      if (chip && !chip.disabled) this.pickVoicePreset(chip.dataset.preset);
    });
    this.btnVoiceAllEffects?.addEventListener('click', () => this.toggleAllEffects(true));
    this.btnVoiceBack?.addEventListener('click', () => this.toggleAllEffects(false));
    this.voiceScopeSelect?.addEventListener('change', () => this.chooseVoiceScope(this.voiceScopeSelect.value));
    this.btnVoiceScopeYes?.addEventListener('click', () => this.confirmVoiceScope());
    $('btn-voice-scope-cancel')?.addEventListener('click', () => this.cancelVoiceScope());

    // Each effect: an on/off switch and dials. A dial on an effect that's off leaves it off.
    for (const fx of this.voiceRack?.querySelectorAll('[data-node]') || []) {
      const name = fx.dataset.node;
      const toggle = fx.querySelector('[data-voice-on]');
      toggle?.addEventListener('change', () => {
        this.editVoice(name, { on: toggle.checked });
        this.flushVoiceSave();
      });
      for (const dial of fx.querySelectorAll('[data-voice-param]')) {
        const param = dial.dataset.voiceParam;
        dial.addEventListener('input', () => {
          const raw = parseFloat(dial.value);
          this.editVoice(name, { [param]: param === 'mix' ? raw / 100 : raw });
        });
        dial.addEventListener('change', () => this.flushVoiceSave());
      }
    }
  }

  isAllEffectsOpen() {
    return !!this.voiceRack?.classList.contains('open');
  }

  /** All effects: the column's middle becomes the rack (Takes and Monitor hide, the record
   *  deck goes compact). Closing gives focus back to the All effects button. */
  toggleAllEffects(open = !this.isAllEffectsOpen(), { focus = true } = {}) {
    if (!this.voiceRack || open === this.isAllEffectsOpen()) return;
    if (open && this.voicePanel?.style.display === 'none') return;
    this.voiceRack.classList.toggle('open', open);
    document.getElementById('booth-controls-panel')?.classList.toggle('rack-open', open);
    this.btnVoiceAllEffects.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.btnVoiceAllEffects.hidden = open;
    if (this.btnVoiceBack) this.btnVoiceBack.hidden = !open;
    if (this.voicePageSummary) this.voicePageSummary.hidden = !open;
    const scroller = document.getElementById('booth-column-scroll');
    if (open && scroller) scroller.scrollTop = 0;
    if (focus) (open ? this.btnVoiceBack : this.btnVoiceAllEffects)?.focus();
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
    const pending = take ? null : this.pendingNextTakeChain[line.line_id];
    this.voiceChain = pending ? copyChain(pending) : resolveChain(this.roomState?.voice, line.character, take);
    this.voiceScope = this.voiceSourceScope(line, take);
    this.hideVoiceScopeAsk();
    if (this.voiceScopeStatus) {
      this.voiceScopeStatus.hidden = true;
      this.voiceScopeStatus.textContent = '';
    }
    this.renderVoicePresets();
    this.renderVoiceScope(line, take);
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
    this.pendingNextTakeChain = {};   // line ids repeat from room to room
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
    const on = effectsOn(chain);
    if (this.voiceOnCount) this.voiceOnCount.textContent = `· ${on} on`;
    if (this.voicePageSummary) this.voicePageSummary.textContent = `${presetLabel(chain, presets)} · ${on} on`;

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

  /** The card shows on every line you can record, before its first take too. Effect controls
   *  work once voice effects are installed; Level once there's a take. A dot pulses while the
   *  sound catches up; the note says why effects are off. */
  refreshVoiceControls() {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    const take = line && this.takeForLine(this.currentLineIndex);
    const mine = !!line && this.canRecordLine(line);
    if (this.voicePanel) this.voicePanel.style.display = mine ? '' : 'none';
    if (!mine) this.toggleAllEffects(false, { focus: false });
    if (this.voiceLevelTake) this.voiceLevelTake.hidden = !take;
    if (this.voiceLevelNote) this.voiceLevelNote.hidden = !!take;

    // Locked while this line's take saves; other lines stay usable.
    const saving = !!this.savingTake(line);
    const enabled = mine && !saving && !this.voiceUnavailable;
    const controls = this.voicePanel?.querySelectorAll('[data-preset], [data-voice-on], [data-voice-param], #voice-scope, .voice-scope-ask button') || [];
    for (const el of controls) {
      el.disabled = !enabled;
      (el.closest('.dsp-dial-channel') || el).classList.toggle('ui-interaction-locked', !enabled);
    }
    // Level and the timing don't need voice effects: they lock only while the line saves.
    for (const el of [this.sliderGain, this.btnAutoMatchGain, this.sliderNudge, ...document.querySelectorAll('.btn-nudge')]) {
      if (!el) continue;
      el.disabled = saving;
      (el.closest('.analog-dial-wrapper') || el).classList.toggle('ui-interaction-locked', saving);
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
    this.updateKnobsVisuals();   // a locked dial leaves the tab order
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

  /** The sound on the controls changed: it goes where "For" points. Before the line's first
   *  take, "Your next take" keeps it in memory for that take's upload. */
  setVoice(chain, { saveNow = false } = {}) {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (!line || !this.canRecordLine(line)) return;
    if (this.voiceScope !== 'take') {
      this.setSharedVoice(chain, { saveNow });
    } else if (this.takeForLine(this.currentLineIndex)) {
      this.setTakeVoice(chain, { saveNow });
    } else {
      this.pendingNextTakeChain[line.line_id] = chain;
      this.voiceChain = chain;
      this.showVoiceChain(chain);
    }
  }

  /** The character's sound ("All of NAME's lines") or the room's ("Every line") becomes
   *  `chain`: shown and rendered now, saved once things are quiet. The engine then gives every
   *  line it covers that sound (their own take sounds are cleared). Resolves true once saved. */
  setSharedVoice(chain, { saveNow = false } = {}) {
    const line = this.roomState.pack.lines[this.currentLineIndex];
    const take = this.takeForLine(this.currentLineIndex);
    const voice = this.roomState.voice || (this.roomState.voice = {});
    if (this.voiceScope === 'session') {
      voice.session = chain;
      voice.characters = {};
    } else {
      voice.characters = { ...(voice.characters || {}), [line.character]: chain };
    }
    if (take) delete take.chain;
    this.voiceChain = chain;
    this.showVoiceChain(chain);
    if (this.voiceScheduler && !this.voiceUnavailable) this.voiceScheduler.want(chain, this.voicePlayState());
    clearTimeout(this.voiceSaveTimer);
    this.voiceSavePending = { roomId: this.roomState.room_id, scope: this.voiceScope, character: line.character, chain };
    if (saveNow) return this.flushVoiceSave();
    this.voiceSaveTimer = setTimeout(() => this.flushVoiceSave(), VOICE_SAVE_QUIET_MS);
    return Promise.resolve(true);
  }

  /** One effect changed: the sound becomes Custom. */
  editVoice(name, params) {
    this.setVoice(editChain(this.voiceChain, name, params));
  }

  pickVoicePreset(id) {
    const preset = (this.roomState?.voice?.presets || []).find((p) => p.id === id);
    if (preset) this.setVoice(copyChain(preset.chain), { saveNow: true });
  }

  /** Saves the edited sound now (a dial was let go, or the line is changing): the take's own
   *  (PUT …/chain) or the character's or room's (PUT /voice). Resolves true once saved. */
  flushVoiceSave() {
    clearTimeout(this.voiceSaveTimer);
    this.voiceSaveTimer = null;
    const pending = this.voiceSavePending;
    this.voiceSavePending = null;
    if (!pending) return Promise.resolve(true);
    this.voiceSavesInFlight = (this.voiceSavesInFlight || 0) + 1;
    const shared = !pending.takeId;
    const body = { user_id: this.user.id, chain: pending.chain };
    if (shared) body.scope = pending.scope;
    if (shared && pending.scope === 'character') body.character = pending.character;
    const url = shared ? `/api/rooms/${pending.roomId}/voice`
      : `/api/rooms/${pending.roomId}/lines/${pending.lineId}/takes/${pending.takeId}/chain`;
    return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (res) => {
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.json())?.detail || ''; } catch (e) { }
          throw new Error(detail || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!shared) this.applySavedTakeLevel(pending, data && data.take);
        return true;
      })
      .catch((err) => {
        this.showToast(this.friendlyError(err, shared ? "That sound wasn't applied. Try again." : "Your take's sound wasn't saved. Try again."));
        return false;
      })
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

  // --- "For": where changes to the sound go ---

  /** Where the line's sound comes from (resolveChain's order): the take's own chain (or the
   *  next take's), the character's, or the room's; "take" when none is set. A guest can't
   *  change the room's sound, so for them it starts on the take. */
  voiceSourceScope(line, take) {
    if (take ? take.chain : this.pendingNextTakeChain[line.line_id]) return 'take';
    const voice = this.roomState?.voice || {};
    if (voice.characters?.[line.character]) return 'character';
    if (voice.session && this.isHost({ allowDummy: true })) return 'session';
    return 'take';
  }

  /** The select's words for this line; "Every line" is the host's. */
  renderVoiceScope(line, take) {
    const select = this.voiceScopeSelect;
    if (!select) return;
    const option = (value) => select.querySelector(`option[value="${value}"]`);
    option('take').textContent = take ? 'This take' : 'Your next take';
    option('character').textContent = `All of ${line.character}'s lines`;
    const host = this.isHost({ allowDummy: true });
    option('session').hidden = !host;
    option('session').disabled = !host;
    select.value = this.voiceScope;
  }

  /** "Radio", or "this sound" for a custom one. */
  voiceSoundName() {
    const name = presetLabel(this.voiceChain, this.roomState?.voice?.presets || []);
    return name === 'Custom' ? 'this sound' : name;
  }

  chooseVoiceScope(scope) {
    if (!(scope in SCOPE_WIDTH) || scope === this.voiceScope) {
      this.hideVoiceScopeAsk();
      return;
    }
    if (SCOPE_WIDTH[scope] > SCOPE_WIDTH[this.voiceScope]) {
      this.askVoiceScope(scope);
      return;
    }
    // Narrower: the sound you hear is copied there; nothing else changes, so no question.
    this.hideVoiceScopeAsk();
    this.voiceScope = scope;
    this.setVoice(this.voiceChain, { saveNow: true });
  }

  /** A wider scope changes other lines too, so it asks first, in the card. */
  askVoiceScope(scope) {
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (!line || !this.voiceScopeAsk) return;
    const sound = this.voiceSoundName();
    this.voiceScopeAskText.textContent = scope === 'session'
      ? `Use ${sound} on every line? Lines and characters with their own sound switch too.`
      : `Use ${sound} on all of ${line.character}'s lines? Lines with their own sound switch too.`;
    this.btnVoiceScopeYes.textContent = scope === 'session' ? 'Use on every line' : 'Use on all their lines';
    this.voiceScopeAsking = scope;
    this.voiceScopeAsk.hidden = false;
    if (this.voiceScopeStatus) this.voiceScopeStatus.hidden = true;
    this.btnVoiceScopeYes.focus();
  }

  hideVoiceScopeAsk() {
    this.voiceScopeAsking = null;
    if (this.voiceScopeAsk) this.voiceScopeAsk.hidden = true;
  }

  cancelVoiceScope() {
    this.hideVoiceScopeAsk();
    if (this.voiceScopeSelect) {
      this.voiceScopeSelect.value = this.voiceScope;
      this.voiceScopeSelect.focus();
    }
  }

  /** Yes: this sound becomes the character's or the room's now, and the card says so until
   *  the next line loads. If it can't be saved, "For" goes back. */
  async confirmVoiceScope() {
    const scope = this.voiceScopeAsking;
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    this.hideVoiceScopeAsk();
    if (!scope || !line) return;
    const previous = this.voiceScope;
    const sound = this.voiceSoundName();
    // The take follows the new sound, so an unsaved edit of its own sound is dropped.
    clearTimeout(this.voiceSaveTimer);
    this.voiceSavePending = null;
    this.voiceScope = scope;
    const saved = await this.setSharedVoice(this.voiceChain, { saveNow: true });
    if (line !== this.roomState?.pack?.lines?.[this.currentLineIndex]) return;
    if (!saved) {
      this.voiceScope = previous;
      if (this.voiceScopeSelect) this.voiceScopeSelect.value = previous;
      return;
    }
    if (this.voiceScopeStatus) {
      this.voiceScopeStatus.textContent = scope === 'session'
        ? `✓ Every line uses ${sound}` : `✓ All of ${line.character}'s lines use ${sound}`;
      this.voiceScopeStatus.hidden = false;
    }
  }

  /** The room's sounds changed (voice_updated) or a take's did (take_params_updated): the
   *  line shows whatever now resolves for it, unless you're still editing it or picked a
   *  sound for its next take. */
  onRoomVoiceChanged() {
    if (this.currentView !== 'booth' || this.voiceSavePending || this.voiceSavesInFlight) return;
    const line = this.roomState?.pack?.lines?.[this.currentLineIndex];
    if (!line) return;
    const take = this.takeForLine(this.currentLineIndex);
    if (take ? !this.voiceScheduler : this.pendingNextTakeChain[line.line_id]) return;
    this.renderVoicePresets();
    const chain = resolveChain(this.roomState.voice, line.character, take);
    if (sameChain(chain, this.voiceChain)) return;
    this.voiceChain = chain;
    this.showVoiceChain(chain);
    if (this.voiceScheduler) this.voiceScheduler.want(chain, this.voicePlayState());
  }
}
