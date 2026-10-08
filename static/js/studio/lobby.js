// studio/lobby.js - Rooms: invite/share status, creating and joining a room, casting,
// the cast activity HUD and ready states. Also the member's home-origin helpers.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { escapeHtml, plural, setFieldError } from '../ui_common.js';
import { takeCount } from './takes.js';
import { MIC_SYNC_KEY, deviceLabel, validEntry } from './mic_sync.js';
import { avatarHtml } from './presence.js';
import { IDENTITY_COLORS, normalizeColor, cleanName, renderColorPicker } from '../identity.js';

// Public room registry (Cloudflare worker) used to resolve rooms hosted elsewhere.
const REGISTRY_BASE = 'https://dubmate.bkaproductions.com';

// Set once a room has been started or joined on this origin: the landing's hero is for first runs.
export const FIRST_ROOM_KEY = 'dubmate_first_room_done';

const ROOM_CODE_RE = /^[A-Za-z0-9-]{3,16}$/;

/**
 * What a "Room code or invite link" field holds: { code } for a code, a registry
 * /join/CODE link or a ?room=CODE link to this page; { code, url } for a ?room= link to
 * another page (a host's tunnel or LAN address), which is opened directly. null otherwise.
 */
export function parseRoomInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (ROOM_CODE_RE.test(raw)) return { code: raw.toUpperCase() };
  let url = null;
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      url = new URL(candidate);
      break;
    } catch (e) { }
  }
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const join = url.pathname.match(/^\/join\/([^/]+)\/?$/);
  if (join && ROOM_CODE_RE.test(join[1])) return { code: join[1].toUpperCase() };
  const room = url.searchParams.get('room') || '';
  if (!ROOM_CODE_RE.test(room)) return null;
  const code = room.toUpperCase();
  return url.origin === window.location.origin ? { code } : { code, url: `${url.origin}${url.pathname}` };
}

// Joining a room hosted elsewhere moves the whole page onto the host's tunnel,
// so every relative URL (/api/packs, "/", "/builder.html") then reaches the
// host's engine. The member's own engine (the desktop app's loopback origin)
// travels along as ?home= and is kept here, per origin, so leaving the room
// can navigate back to it.
const HOME_ORIGIN_KEY = 'dubmate_home_origin';

/** True only for a bare loopback http origin such as http://127.0.0.1:8123. */
export function isLoopbackOrigin(value) {
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
export function getHomeOrigin() {
  if (isLoopbackOrigin(window.location.origin)) return window.location.origin;
  let saved = null;
  try { saved = sessionStorage.getItem(HOME_ORIGIN_KEY); } catch (e) { }
  return isLoopbackOrigin(saved) ? saved : null;
}

/** Remembers ?home= (when valid) and drops it from the address bar. */
export function captureHomeOriginParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('home')) return;
  const home = url.searchParams.get('home');
  if (isLoopbackOrigin(home)) {
    try { sessionStorage.setItem(HOME_ORIGIN_KEY, home); } catch (e) { }
  }
  url.searchParams.delete('home');
  window.history.replaceState(window.history.state, '', url);
}

// Join handoff: a member's name and audio setup travel from their own DubMate to
// the host's tunnel page in the URL fragment (#dm=), which never reaches a server.
// Each field is checked on its own on arrival. Anyone can write such a link, so it
// only carries preferences the guest can see and change, never the user id.
const HANDOFF_PREFIX = '#dm=';
const HANDOFF_MAX_MIC_SYNC = 20;
const MAX_LABEL_CHARS = 200;

function toBase64Url(text) {
  const binary = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return decodeURIComponent(Array.from(binary, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}

function readJson(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (e) {
    return null;
  }
}

function measuredAt(entry) {
  return Number.isFinite(entry?.measured_at) ? entry.measured_at : 0;
}

// Only the known fields of a valid entry, or null.
function cleanMicSyncEntry(entry) {
  if (!validEntry(entry)) return null;
  const clean = { latency_ms: entry.latency_ms, measured_at: measuredAt(entry) };
  if (typeof entry.method === 'string' && entry.method.length <= 20) clean.method = entry.method;
  return clean;
}

// Adds each valid entry of `incoming` to `map` unless `map` already has a newer one.
function mergeMicSync(map, incoming) {
  let changed = false;
  for (const [key, entry] of Object.entries(incoming || {})) {
    const clean = key.length <= MAX_LABEL_CHARS ? cleanMicSyncEntry(entry) : null;
    if (!clean) continue;
    if (validEntry(map[key]) && measuredAt(map[key]) >= clean.measured_at) continue;
    map[key] = clean;
    changed = true;
  }
  return changed;
}

/** base64url(JSON) of this member's name, colour and audio setup, for a host's page. */
export function buildJoinHandoff(app) {
  const user = app.user || {};
  const setup = app.audioSetup || {};
  const devices = setup.devices || {};
  const label = (list, id) => (devices.labelled ? deviceLabel(list, id) : '');
  const synced = {};
  mergeMicSync(synced, readJson(MIC_SYNC_KEY));
  mergeMicSync(synced, app.engineMicSync);
  const newest = Object.entries(synced)
    .sort((a, b) => b[1].measured_at - a[1].measured_at)
    .slice(0, HANDOFF_MAX_MIC_SYNC);
  return toBase64Url(JSON.stringify({
    v: 1,
    user: { name: user.name || '', color: user.color || '' },
    audio: {
      setup_done: !!setup.setupComplete,
      input_label: label(devices.inputs, setup.inputId),
      output_label: label(devices.outputs, setup.outputId),
    },
    mic_sync: Object.fromEntries(newest),
    noise_reduction: localStorage.getItem('dubmate_noise_reduction') !== 'false',
  }));
}

/**
 * Applies a join handoff (#dm=) on a host's page reached from the member's own
 * DubMate, and always removes the fragment. True when anything was applied.
 */
export function captureJoinHandoff() {
  const url = new URL(window.location.href);
  if (!url.hash.startsWith(HANDOFF_PREFIX)) return false;
  const encoded = url.hash.slice(HANDOFF_PREFIX.length);
  url.hash = '';
  window.history.replaceState(window.history.state, '', url);
  if (!url.searchParams.get('room') || !isLoopbackOrigin(url.searchParams.get('home'))) return false;

  let data = null;
  try {
    data = JSON.parse(fromBase64Url(encoded));
  } catch (e) {
    return false;
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return false;
  let applied = false;
  const store = (key, value) => { localStorage.setItem(key, value); applied = true; };
  try {
    const incoming = data.user && typeof data.user === 'object' ? data.user : {};
    const user = readJson('dubmate_user') || {};
    // Older members could save up to 40 characters; rooms show 24.
    const raw = typeof incoming.name === 'string' ? incoming.name.trim() : '';
    const name = raw.length <= 40 ? cleanName(raw) : '';
    const color = normalizeColor(incoming.color);
    const nameOk = !!name;
    if (nameOk) user.name = name;
    if (color) user.color = color;
    // The id stays the one this origin already has (loadUser() adds one when missing).
    if (nameOk || color) store('dubmate_user', JSON.stringify(user));

    const audio = data.audio && typeof data.audio === 'object' ? data.audio : {};
    if (audio.setup_done === true) store('dubmate_audio_setup_done', '1');
    const labelOf = (v) => (typeof v === 'string' && v.length <= MAX_LABEL_CHARS ? v : '');
    const devices = { input_label: labelOf(audio.input_label), output_label: labelOf(audio.output_label) };
    if (devices.input_label || devices.output_label) store('dubmate_audio_handoff', JSON.stringify(devices));

    if (data.mic_sync && typeof data.mic_sync === 'object' && !Array.isArray(data.mic_sync)) {
      const map = readJson(MIC_SYNC_KEY) || {};
      if (mergeMicSync(map, data.mic_sync)) store(MIC_SYNC_KEY, JSON.stringify(map));
    }

    if (typeof data.noise_reduction === 'boolean') store('dubmate_noise_reduction', String(data.noise_reduction));
  } catch (e) {
    console.warn('[DubMate] Could not apply the join handoff:', e);
  }
  return applied;
}

/** [major, minor] of a version string such as "1.1.3", or null when unreadable. */
function parseMajorMinor(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The version an engine reports on /health, or null when it can't be read. */
async function fetchEngineVersion(origin) {
  try {
    const res = await fetch(`${origin}/health`, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.version === 'string') ? data.version : null;
  } catch (e) {
    return null;
  }
}

// In the desktop app, lets the microphone work on this room's page without a second
// prompt (mic_permission.rs). Only this exact tunnel; no-op in a browser.
async function allowRoomMic(origin) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    await invoke('allow_room_origin', { url: origin });
  } catch (e) {
    // An older desktop app without the command: WebView2 asks for the mic instead.
  }
}

export class LobbyMethods {
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
    this.headerRoomBadge.dataset.tip = share.code_is_live
      ? 'Click to copy the room code'
      : `${share.message || "Your room code isn't ready yet."} Click to copy an invite link.`;
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
            this.showToast(share.message || "Couldn't go online. Only people on your network can join.");
          } else if (share.state === 'not_published' && share.message) {
            // A continued session: its code was published by an earlier run.
            this.showToast(share.message);
          } else {
            this.showToast(share.direct_url
              ? "Your room code isn't ready yet. Use Copy invite to share a direct link."
              : 'Your room code only works on your network for now.');
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
    let message = `Room code ${code} copied`;
    if (share && !share.code_is_live) {
      if (share.direct_url) {
        text = share.direct_url;
        message = share.state === 'not_published'
          ? 'Invite link copied.'
          : "Room code isn't ready yet, so the invite link was copied instead.";
      } else {
        message = `Room code ${code} copied. It only works on your network for now.`;
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

  async createRoom() {
    if (!this.requireName()) return;
    const pack = (this.packs || []).find((p) => p.id === this.selectedPackId);
    if (!pack) {
      this.btnCreateRoom?.focus();
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
      this.showToast(this.friendlyError(err, "Couldn't create the room. Try again."));
    }
  }

  // On a host's page reached from the member's own DubMate (?home=), compare the
  // two engines' versions and say in a toast which side should update. Never blocks
  // joining. Browser-only guests have no home engine to compare.
  async warnOnVersionMismatch() {
    const home = getHomeOrigin();
    if (!home || home === window.location.origin) return;
    const [hostVersion, myVersion] = await Promise.all([
      fetchEngineVersion(''),
      fetchEngineVersion(home),
    ]);
    const host = parseMajorMinor(hostVersion);
    const mine = parseMajorMinor(myVersion);
    if (!host || !mine) return;
    const diff = (mine[0] - host[0]) || (mine[1] - host[1]);
    if (diff === 0) return;
    const versions = `The host has DubMate ${hostVersion} and you have ${myVersion}.`;
    this.showToast(diff < 0
      ? `${versions} Update yours to avoid problems in this room.`
      : `${versions} Ask the host to update to avoid problems in this room.`);
  }

  /**
   * Looks a room code up: on this engine first, then in the public registry. Returns
   * { room } for a room here, { navigated: true } when it moved the page to the host's,
   * or {} when nobody has the code.
   */
  async findRoom(code) {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    if (res.ok) return { room: await res.json() };
    // If room is not hosted on this local instance, resolve via dubmate.bkaproductions.com
    try {
      const resolveResp = await fetch(`${REGISTRY_BASE}/rooms/${encodeURIComponent(code)}/resolve`, {
        headers: { 'Accept': 'application/json' }
      });
      if (resolveResp.ok) {
        const data = await resolveResp.json();
        const target = data && data.tunnel_url ? new URL(data.tunnel_url) : null;
        // A registry entry pointing back at this page means the host no longer
        // has the room; jumping would reload this page forever.
        if (target && target.origin !== window.location.origin) {
          await this.goToRoomPage(target, code);
          return { navigated: true };
        }
      }
    } catch (resolveErr) {
      console.warn('[Registry] Public resolve check:', resolveErr);
    }
    return {};
  }

  /**
   * Moves the page onto the host's room page, carrying the member's own engine along
   * (?home=) so leaving can come back to it, and their name and setup (#dm=) so they
   * join straight in. A browser guest goes without either.
   */
  async goToRoomPage(target, code) {
    target.searchParams.set('room', code);
    const home = getHomeOrigin();
    if (home) {
      target.searchParams.set('home', home);
      // Device names are only readable once listed with the mic allowed.
      await this.updateAudioDeviceList();
      target.hash = 'dm=' + buildJoinHandoff(this);
    }
    this.showToast(`Connecting to room ${code}…`);
    await allowRoomMic(target.origin);
    this.navigateTo(target.toString());
  }

  /**
   * Joins a room by code with the saved name and colour. When nobody has the code,
   * onMissing(code) says so where the person asked (a form); without it, a toast and
   * the home screen.
   */
  async joinRoom(roomId, { onMissing } = {}) {
    this.resetRoomSession();
    const cleanCode = (roomId || '').trim().toUpperCase();
    try {
      const found = await this.findRoom(cleanCode);
      if (found.navigated) return;
      if (!found.room) {
        if (onMissing) {
          onMissing(cleanCode);
          return;
        }
        // Strip stale room parameter so user is returned cleanly to scene explorer
        this.clearRoomQueryParam();
        this.showToast(`Room ${cleanCode} wasn't found. Check the code or ask the host for a new one.`);
        this.showView('landing');
        return;
      }
      this.enterRoom(found.room);
    } catch (err) {
      this.clearRoomQueryParam();
      this.showToast(this.friendlyError(err, "Couldn't join that room. Try again."));
      this.showView('landing');
    }
  }

  /** Connects to a room this engine has (its state already fetched) and shows where it is. */
  enterRoom(room) {
    this.roomState = room;
    try { localStorage.setItem(FIRST_ROOM_KEY, '1'); } catch (e) { }

    const url = new URL(window.location);
    url.searchParams.set('room', this.roomState.room_id);
    url.searchParams.delete('left');
    window.history.pushState({}, '', url);

    // Read before connecting: the socket join resets this user's saved status.
    const savedLine = this.savedLineIndex();
    this.socket.connect(this.roomState.room_id, this.user.id, this.user.name, this.user.color);

    this.headerRoomBadge.style.display = 'inline-flex';
    this.headerRoomCode.innerText = this.roomState.room_id;
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
      this.loadBoothLine(savedLine ?? this.findFirstAssignedLine());
      this.broadcastMyStatus('booth');
    } else {
      this.showView('lobby');
      this.renderLobbyState();
      this.renderCastActivityHUD();
      this.broadcastMyStatus('lobby');
    }
  }

  // --- Code-or-link forms (the landing, the join card's missing state, You left) ---

  /** Wires a code-or-link <form>: Enter or Join looks it up; typing clears the error. */
  initCodeForm(form) {
    if (!form) return;
    const input = form.querySelector('input');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.joinRoomFromInput(form);
    });
    input?.addEventListener('input', () => setFieldError(input, ''));
  }

  /**
   * Joins the room a code-or-link form names. "Finding room…" while it looks; a wrong
   * code shows under the field, keeping the text, with no toast and no view change. A
   * direct link to a host's page goes straight there. On the landing the name comes
   * first; elsewhere someone with no name yet gets the join card for a room found here.
   */
  async joinRoomFromInput(form) {
    const input = form.querySelector('input');
    const button = form.querySelector('button[type="submit"]');
    setFieldError(input, '');
    if (form.closest('#view-landing') && !this.requireName()) return;
    const raw = (input.value || '').trim();
    const parsed = parseRoomInput(raw);
    if (!parsed) {
      setFieldError(input, raw ? "That isn't a room code or invite link." : 'Type a room code or paste an invite link.');
      input.focus();
      return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Finding room…';
    const done = () => {
      button.disabled = false;
      button.textContent = label;
    };
    try {
      if (parsed.url) {
        await this.goToRoomPage(new URL(parsed.url), parsed.code);
        return;
      }
      const found = await this.findRoom(parsed.code);
      if (found.navigated) return;
      done();
      if (!found.room) {
        setFieldError(input, `No room ${parsed.code}. Check the code, or ask the host for a new link.`);
        input.focus();
        return;
      }
      this.resetRoomSession();
      if (!cleanName(this.user.name) && !found.room.users?.[this.user.id]) {
        this.showJoinCard(parsed.code, found.room);
        return;
      }
      this.enterRoom(found.room);
    } catch (err) {
      done();
      setFieldError(input, this.friendlyError(err, "Couldn't reach DubMate. Try again."));
    }
  }

  // --- The join card (a friend who opened an invite link in a plain browser) ---

  /** Shows the join card for ?room=CODE: "Finding room…" until the code is checked. */
  async openJoinCard(code) {
    const cleanCode = (code || '').trim().toUpperCase();
    this.joinCardCode = cleanCode;
    document.getElementById('join-finding').hidden = false;
    document.getElementById('join-form').hidden = true;
    document.getElementById('join-missing').hidden = true;
    document.getElementById('join-poster').replaceChildren();
    this.showView('join');
    this.warnOnVersionMismatch();
    let found = {};
    try {
      found = await this.findRoom(cleanCode);
    } catch (err) {
      console.warn('[DubMate] Room lookup failed:', err);
    }
    if (found.navigated) return;
    if (!found.room) {
      this.showJoinMissing(cleanCode);
      return;
    }
    // Someone the room already knows (a reload) goes straight back in.
    if (found.room.users?.[this.user.id] && cleanName(this.user.name)) {
      this.enterRoom(found.room);
      return;
    }
    this.showJoinCard(cleanCode, found.room);
  }

  showJoinMissing(code) {
    this.showView('join');
    document.getElementById('join-finding').hidden = true;
    document.getElementById('join-form').hidden = true;
    document.getElementById('join-missing').hidden = false;
    document.getElementById('join-missing-title').textContent = `Room ${code} isn't open.`;
    document.getElementById('join-poster').replaceChildren();
    const input = document.getElementById('input-join-code');
    input.focus();
  }

  /** Fills the join card in from the room's state: host, scene, who's here, name and colour. */
  showJoinCard(code, room) {
    this.joinCardCode = code;
    this.joinCardRoom = room;
    this.showView('join');
    const pack = room.pack || {};
    const users = Object.values(room.users || {});
    const host = room.users?.[room.host_id];
    document.getElementById('join-title').textContent = host?.name ? `Join ${host.name}'s room` : 'Join the room';
    const lines = (pack.lines || []).length;
    document.getElementById('join-meta').textContent =
      `${pack.name || pack.id || 'Scene'} · ${plural(lines, 'line')} · ${plural((pack.characters || []).length, 'character')}`;

    const poster = document.getElementById('join-poster');
    if (pack.has_icon && pack.icon_url) {
      const img = document.createElement('img');
      img.src = pack.icon_url;
      img.alt = '';
      poster.replaceChildren(img);
    } else if (pack.video_url) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const start = Number((pack.lines || [])[0]?.start) || 0;
      video.setAttribute('src', `${pack.video_url}#t=${start}`);
      poster.replaceChildren(video);
    } else {
      poster.replaceChildren();
    }

    const online = users.filter((u) => u && u.is_online);
    document.getElementById('join-here').innerHTML = online.length
      ? `<span class="join-here-label">Here now</span>${online.map((u) => `<span class="join-here-who">${avatarHtml(u, 20)}<span class="join-here-name">${escapeHtml(u.name)}</span></span>`).join('')}`
      : '';

    // Hues other people hold are taken. With all 8 held, offline people don't count,
    // and with 8 online the server shares the least-used hue (the initial tells them apart).
    const others = users.filter((u) => u && u.id !== this.user.id);
    let taken = new Map(others.map((u) => [u.color, u]));
    if (IDENTITY_COLORS.every((c) => taken.has(c.hex))) taken = new Map(others.filter((u) => u.is_online).map((u) => [u.color, u]));
    if (IDENTITY_COLORS.every((c) => taken.has(c.hex))) taken = new Map();
    this.joinCardTaken = taken;
    this.joinCardColor = taken.has(this.user.color)
      ? (IDENTITY_COLORS.find((c) => !taken.has(c.hex))?.hex || this.user.color)
      : this.user.color;

    const name = document.getElementById('input-join-name');
    name.value = this.user.name || '';
    setFieldError(name, '');
    document.getElementById('join-finding').hidden = true;
    document.getElementById('join-missing').hidden = true;
    document.getElementById('join-form').hidden = false;
    this.renderJoinCardIdentity();
    name.focus();
  }

  /** The join card's picker and button follow the name typed so far. */
  renderJoinCardIdentity() {
    const name = cleanName(document.getElementById('input-join-name')?.value || '');
    const button = document.getElementById('btn-join-card');
    button.disabled = !name;
    button.textContent = name ? `Join as ${name} ›` : 'Join ›';
    const palette = document.getElementById('join-color-palette');
    if (palette.contains(document.activeElement)) return;
    renderColorPicker(palette, {
      selected: this.joinCardColor,
      taken: this.joinCardTaken || new Map(),
      label: 'Your colour',
      name,
      onChange: (hex) => { this.joinCardColor = hex; },
    });
  }

  /** Join as <name>: saves the name and colour on this origin, then joins. */
  async submitJoinCard() {
    const input = document.getElementById('input-join-name');
    const name = cleanName(input.value);
    if (!name) {
      setFieldError(input, 'Type your name first');
      input.focus();
      return;
    }
    this.user.name = name;
    this.user.color = this.joinCardColor || this.user.color;
    this.saveUser();
    this.updateUserUI();
    const button = document.getElementById('btn-join-card');
    button.disabled = true;
    button.textContent = 'Joining…';
    await this.joinRoom(this.joinCardCode, { onMissing: (code) => this.showJoinMissing(code) });
    this.renderJoinCardIdentity();
  }

  // --- You left (browser guests with no DubMate of their own) ---

  /**
   * "You left <scene>", with Rejoin and a field prefilled with the code. `scene` is
   * the scene's name when known (just left); after a reload the room is looked up,
   * and a room that has closed says so instead of offering Rejoin.
   */
  async showLeftView(code, scene = '') {
    this.leftRoomCode = code;
    const title = document.getElementById('left-title');
    const text = document.getElementById('left-text');
    const rejoin = document.getElementById('btn-rejoin-room');
    const field = document.getElementById('input-left-room-code');
    const url = new URL(window.location.href);
    url.search = `?left=${encodeURIComponent(code)}`;
    url.hash = '';
    window.history.replaceState({}, '', url);
    setFieldError(rejoin, '');
    setFieldError(field, '');
    field.value = code;
    rejoin.textContent = `Rejoin ${code}`;
    rejoin.disabled = false;
    this.showView('left');
    let open = !!scene;
    if (!scene) {
      title.textContent = 'You left the room';
      text.textContent = '';
      rejoin.hidden = true;
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
        if (res.ok) {
          const room = await res.json();
          scene = room?.pack?.name || room?.pack?.id || '';
          open = true;
        }
      } catch (e) { }
    }
    if (this.currentView !== 'left' || this.leftRoomCode !== code) return;
    title.textContent = scene ? `You left ${scene}` : 'You left the room';
    // Leaving only marks you offline; the room and every take in it stay on the host's engine.
    text.textContent = open ? 'The room is still open. Your takes stay in it.' : 'The room has closed.';
    rejoin.hidden = !open;
    (open ? rejoin : field).focus();
  }

  /** Rejoin: the saved name and colour, no card. A room that closed meanwhile says so here. */
  async rejoinRoom() {
    const button = document.getElementById('btn-rejoin-room');
    const code = this.leftRoomCode;
    if (!code) return;
    setFieldError(button, '');
    button.disabled = true;
    button.textContent = 'Finding room…';
    await this.joinRoom(code, {
      onMissing: () => setFieldError(button, `Room ${code} isn't open any more. Ask the host for a new link.`),
    });
    button.disabled = false;
    button.textContent = `Rejoin ${code}`;
  }

  /** Downloads the room's scene so a member can add it with Import pack at home. */
  getThisScene() {
    const pack = this.roomState?.pack;
    if (!pack) return Promise.resolve(false);
    const title = pack.name || pack.id || 'Scene';
    const safeName = (pack.name || pack.id || 'pack').replace(/[^a-zA-Z0-9_-]/g, '_');
    return this.saveRemoteFile(pack.export_url || `/api/packs/${encodeURIComponent(pack.id)}/export`, `${safeName}.zip`, {
      control: this.btnGetScene,
      doneMessage: `Downloaded "${title}". Add it with Import pack in your DubMate.`,
      errorText: "Couldn't download that pack. Try again.",
    });
  }

  /** The line this user was on when they last left this room, or null. Line 0 counts
   * only if they were in the booth (it is also the default for someone who never was).
   * A line they can't record (someone else's character) is not reopened. */
  savedLineIndex() {
    const me = this.roomState?.users?.[this.user.id];
    const lines = this.roomState?.pack?.lines;
    if (!me || !Array.isArray(lines)) return null;
    const line = me.current_line;
    if (!Number.isInteger(line) || line < 0 || line >= lines.length) return null;
    if (line === 0 && me.location !== 'booth') return null;
    return this.canRecordLine(lines[line]) ? line : null;
  }

  // --- Live Cast Activity HUD & Premiere Gate ---

  broadcastMyStatus(location = 'booth') {
    if (!this.socket || !this.roomState) return;
    // Given up on the room: not lost, just late. app.js says it again once it is back.
    if (this.socket.connectionState === 'failed') return;
    this.socket.send('set_user_status', {
      current_line: this.currentLineIndex,
      location: location,
      is_ready: this.isReadyForScreening,
    });
  }

  toggleMyReadiness({ quiet = false } = {}) {
    this.isReadyForScreening = !this.isReadyForScreening;
    if (this.isReadyForScreening && !quiet) this.showToast("You're marked ready");
    if (this.roomState && this.roomState.users && this.roomState.users[this.user.id]) {
      this.roomState.users[this.user.id].is_ready = this.isReadyForScreening;
      this.renderCastActivityHUD();
    }
    this.renderBoothToolbar();
    this.broadcastMyStatus('booth');
  }

  launchGroupPremiere() {
    if (!this.roomState) return;
    const isHost = this.isHost();
    if (!isHost) {
      this.showToast("Only the host can start the premiere");
      return;
    }
    this.showToast("Starting the premiere…");
    this.socket.send('launch_premiere', {});
  }

  renderCastActivityHUD() {
    if (!this.roomState) return;
    this.renderBoothToolbar();
    if (!this.castActivityList) return;
    const users = Object.values(this.roomState.users || {}).filter(u => u.is_online);
    // The lobby is for casting: who is here and their roles, without progress or ready counts.
    const inLobby = this.currentView === 'lobby';

    let readyCount = 0;
    const chips = users.map((u) => {
      // Find assigned characters
      const assignedChars = Object.keys(this.roomState.role_assignments || {}).filter((char) => {
        return (this.roomState.role_assignments[char] || []).includes(u.id);
      });

      // Calculate lines completed
      const assignedLineObjs = this.roomState.pack.lines.filter(l => assignedChars.includes(l.character));
      const totalAssigned = assignedLineObjs.length;
      const completedTakes = assignedLineObjs.filter(l => takeCount(this.roomState.takes, l) > 0).length;
      const pct = totalAssigned > 0 ? Math.round((completedTakes / totalAssigned) * 100) : 0;

      if (u.is_ready) readyCount++;

      // One role shows its name; several show "2 roles", with the names in a tooltip
      // that also opens on keyboard focus.
      const charText = assignedChars.length === 0 ? 'Unassigned'
        : (assignedChars.length === 1 ? assignedChars[0] : plural(assignedChars.length, 'role'));
      const charTip = assignedChars.length > 1
        ? `tabindex="0" data-tip="${escapeHtml(assignedChars.join(', '))}"`
        : `title="${escapeHtml(charText)}"`;

      const loc = u.location === 'screening' ? 'Premiere' : (u.location === 'lobby' ? 'Lobby' : `Line ${(u.current_line || 0) + 1}`);

      return `<div class="actor-hud-chip ${u.is_ready ? 'ready' : ''}">
        <div class="actor-hud-avatar" style="background: ${escapeHtml(u.color)};">${escapeHtml(u.name.charAt(0).toUpperCase())}</div>
        <span class="actor-hud-name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}${u.id === this.user.id ? ' (You)' : ''}</span>
        <span class="actor-hud-char" ${charTip}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>${escapeHtml(charText)}</span>
        ${inLobby ? '' : `<span class="actor-hud-progress">${completedTakes}/${totalAssigned} (${pct}%)</span>`}
        <span class="actor-hud-status-badge ${u.is_ready ? 'badge-ready' : (u.location === 'screening' ? 'badge-screening' : 'badge-recording')}">
          ${u.is_ready ? '✓ Ready' : loc}
        </span>
      </div>`;
    }).join('');
    // Redraw only on a real change, so a focused roles tooltip survives other updates.
    if (chips !== this._lastCastHudHtml) {
      this._lastCastHudHtml = chips;
      this.castActivityList.innerHTML = chips;
    }

    if (this.premiereStatusSummary) {
      this.premiereStatusSummary.textContent = `${readyCount}/${users.length} ready`;
      this.premiereStatusSummary.hidden = inLobby;
    }
  }

  // --- Room & Lobby Logic ---

  renderLobbyState() {
    if (!this.roomState) return;

    if (this.lobbyPackTitle) this.lobbyPackTitle.innerText = this.roomState.pack.name;
    if (this.lobbyLineCount) this.lobbyLineCount.textContent = plural(this.roomState.pack.line_count, 'line');
    if (this.btnGetScene) {
      // Members who came from their own DubMate can take the scene home with them.
      const home = getHomeOrigin();
      this.btnGetScene.hidden = !(home && home !== window.location.origin && !this.isHost());
    }

    // Only the host starts recording and casts. Guests wait for the host, or go back
    // to the booth if recording has already started, or to the premiere once it's on.
    const runsRoom = this.isHost({ allowDummy: true });
    const recording = this.roomState.status === 'recording';
    const screening = this.roomState.status === 'screening';
    if (this.btnStartSession) this.btnStartSession.hidden = !runsRoom;
    if (this.btnBackToBooth) this.btnBackToBooth.hidden = runsRoom || !recording;
    if (this.btnBackToPremiere) this.btnBackToPremiere.hidden = runsRoom || !screening;
    if (this.lobbyWaiting) {
      const waiting = !runsRoom && this.roomState.status === 'lobby';
      this.lobbyWaiting.hidden = !waiting;
      const hostName = this.roomState.users?.[this.roomState.host_id]?.name || 'the host';
      this.lobbyWaiting.textContent = waiting ? `Waiting for ${hostName} to start recording` : '';
    }

    const users = Object.values(this.roomState.users || {});
    if (this.castOnlineCount) this.castOnlineCount.innerText = `${users.filter(u => u.is_online).length} online`;

    // Only update lobby cast list if user list changed
    const userSummary = users.map(u => `${u.id}:${u.name}:${u.is_online}:${u.color}`).join('|');
    if (this._lastUserSummary !== userSummary) {
      this._lastUserSummary = userSummary;
      if (this.lobbyCastList) {
        this.lobbyCastList.innerHTML = users.map(u => `
          <div class="user-pill lobby-user-item">
            <div class="lobby-user-who">
              <div class="user-avatar" style="background: ${escapeHtml(u.color)};">${escapeHtml(u.name.charAt(0).toUpperCase())}</div>
              <span class="lobby-user-name">${escapeHtml(u.name)}</span>
              ${u.id === this.user.id ? '<span class="user-you-tag">You</span>' : ''}
              ${u.id === this.roomState.host_id ? '<span class="tag-host">Host</span>' : ''}
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
    const characters = [...this.roomState.pack.characters]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const actorName = (u) => (u ? `${u.name}${u.id === this.user.id ? ' (You)' : ''}` : 'Original voice');

    // Rebuild when the users change, or when this person gains or loses the selects.
    const optionsSummary = `${runsRoom}|${userSummary}`;
    const usersChanged = (this._lastUserOptionsSummary !== optionsSummary);
    this._lastUserOptionsSummary = optionsSummary;

    // Check if table rows already exist for all characters
    const existingRows = Array.from(this.castingTbody.querySelectorAll('tr[data-character]'));
    if (existingRows.length === characters.length && !usersChanged) {
      // IN-PLACE UPDATE: Do not recreate DOM elements to avoid closing active <select> dropdowns
      characters.forEach((char) => {
        const tr = existingRows.find(row => row.dataset.character === char);
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
            span.textContent = 'Your role';
            badgeCell.appendChild(span);
          }
        } else if (!isAssignedToMe && roleBadge) {
          roleBadge.remove();
        }

        const dot = tr.querySelector('.actor-color-dot');
        if (dot) {
          dot.className = `actor-color-dot ${assignedUser ? 'active' : 'unassigned'}`;
          dot.style.backgroundColor = assignedUser ? assignedUser.color : 'transparent';
          dot.title = actorName(assignedUser);
        }

        const name = tr.querySelector('.cast-actor-name');
        if (name) {
          name.textContent = actorName(assignedUser);
          name.classList.toggle('unassigned', !assignedUser);
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
    characters.forEach((char) => {
      const assignedIds = this.roomState.role_assignments[char] || [];
      const assignedUser = users.find(u => assignedIds.includes(u.id));
      const isAssignedToMe = assignedIds.includes(this.user.id);
      const safeCharId = char.replace(/\s+/g, '-').toLowerCase();

      const tr = document.createElement('tr');
      tr.setAttribute('data-character', char);
      if (isAssignedToMe) {
        tr.classList.add('assigned-to-me');
      }

      const actor = runsRoom
        ? `<select class="cast-select"
                    id="cast-select-${escapeHtml(safeCharId)}"
                    data-char="${escapeHtml(char)}"
                    aria-label="Assign actor for ${escapeHtml(char)}">
              <option value="">Original voice</option>
              ${users.map(u => `
                <option value="${escapeHtml(u.id)}" ${assignedIds.includes(u.id) ? 'selected' : ''}>
                  ${escapeHtml(actorName(u))}
                </option>
              `).join('')}
            </select>`
        : `<span class="cast-actor-name${assignedUser ? '' : ' unassigned'}">${escapeHtml(actorName(assignedUser))}</span>`;

      tr.innerHTML = `
        <td>
          <div class="char-badge-cell">
            <span class="char-badge">${escapeHtml(char)}</span>
            ${isAssignedToMe ? '<span class="your-role-badge">Your role</span>' : ''}
          </div>
        </td>
        <td><span class="char-line-count">${plural(charCounts[char] || 0, 'line')}</span></td>
        <td>
          <div class="cast-assign-cell">
            <span class="actor-color-dot ${assignedUser ? 'active' : 'unassigned'}"
                  style="background-color: ${assignedUser ? escapeHtml(assignedUser.color) : 'transparent'};"
                  title="${escapeHtml(actorName(assignedUser))}"
                  aria-hidden="true"></span>
            ${actor}
          </div>
        </td>
      `;

      // Only the host casts, and only the host draws the change before the room answers.
      // A refusal comes back as an error and the room's real state is reloaded.
      const select = tr.querySelector('.cast-select');
      if (select) {
        select.addEventListener('change', (e) => {
          const val = e.target.value;
          const newIds = val ? [val] : [];
          if (this.roomState && this.roomState.role_assignments) {
            this.roomState.role_assignments[char] = newIds;
            this.renderCastActivityHUD();
          }
          this.socket.assignRole(char, newIds);
        });
      }

      this.castingTbody.appendChild(tr);
    });
  }
}
