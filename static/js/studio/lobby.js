// studio/lobby.js - Rooms: invite/share status, creating and joining a room, casting,
// the cast activity HUD and ready states. Also the member's home-origin helpers.
// These methods are mixed into DubMateApp via mixin(); no getters, fields or super.
import { escapeHtml, plural } from '../ui_common.js';
import { takeCount } from './takes.js';

// Public room registry (Cloudflare worker) used to resolve rooms hosted elsewhere.
const REGISTRY_BASE = 'https://dubmate.bkaproductions.com';

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
    if (!this.selectedPackId) {
      this.showToast("Choose a scene first.");
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
      this.showToast("Enter a room code.");
      return;
    }
    this.pendingJoinRoomId = cleanCode;
    this.warnOnVersionMismatch();

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

  // On a host's page reached from the member's own DubMate (?home=), compare the
  // two engines' versions and note in the join prompt which side should update.
  // Never blocks joining. Browser-only guests have no home engine to compare.
  async warnOnVersionMismatch() {
    const note = document.getElementById('join-modal-version-note');
    if (!note) return;
    note.hidden = true;
    note.textContent = '';
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
    note.textContent = diff < 0
      ? `${versions} Update yours to avoid problems in this room.`
      : `${versions} Ask the host to update to avoid problems in this room.`;
    note.hidden = false;
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
    if (new URL(window.location.href).searchParams.has('room')) {
      this.clearRoomQueryParam();
      // Declined a host's room: don't stay behind on the host's home screen.
      this.goHome();
    }
  }

  joinRoomFromInput(input = this.inputRoomCode) {
    const code = (input?.value || '').trim().toUpperCase();
    if (!code) {
      this.showToast("Enter a room code.");
      return;
    }
    this.promptJoinRoom(code);
  }

  async joinRoom(roomId) {
    this.resetRoomSession();
    const cleanCode = (roomId || '').trim().toUpperCase();
    try {
      let res = await fetch(`/api/rooms/${cleanCode}`);
      if (!res.ok) {
        // If room is not hosted on this local instance, resolve via dubmate.bkaproductions.com
        try {
          const resolveResp = await fetch(`${REGISTRY_BASE}/rooms/${encodeURIComponent(cleanCode)}/resolve`, {
            headers: { 'Accept': 'application/json' }
          });
          if (resolveResp.ok) {
            const data = await resolveResp.json();
            if (data && data.tunnel_url) {
              // Navigate to host's tunnel room session, carrying the member's own
              // engine along so leaving the room can come back to it.
              const target = new URL(data.tunnel_url);
              target.searchParams.set('room', cleanCode);
              const home = getHomeOrigin();
              if (home) target.searchParams.set('home', home);
              this.showToast(`Connecting to room ${cleanCode}…`);
              this.navigateTo(target.toString());
              return;
            }
          }
        } catch (resolveErr) {
          console.warn('[Registry] Public resolve check:', resolveErr);
        }

        // Strip stale room parameter so user is returned cleanly to scene explorer
        this.clearRoomQueryParam();

        this.showToast(`Room ${cleanCode} wasn't found. Check the code or ask the host for a new one.`);
        this.showView('landing');
        return;
      }
      this.roomState = await res.json();

      const url = new URL(window.location);
      url.searchParams.set('room', this.roomState.room_id);
      window.history.pushState({}, '', url);

      // Read before connecting: the socket join resets this user's saved status.
      const savedLine = this.savedLineIndex();
      this.socket.connect(this.roomState.room_id, this.user.id, this.user.name, this.user.color);

      this.headerRoomBadge.style.display = 'inline-flex';
      this.headerRoomCode.innerText = this.roomState.room_id;
      this.headerUserPill.style.display = 'inline-flex';
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
    } catch (err) {
      this.clearRoomQueryParam();
      this.showToast(this.friendlyError(err, "Couldn't join that room. Try again."));
      this.showView('landing');
    }
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

  toggleMyReadiness() {
    this.isReadyForScreening = !this.isReadyForScreening;
    if (this.isReadyForScreening) {
      if (this.labelReadyState) this.labelReadyState.innerText = "Ready";
      this.btnToggleReady.className = "btn btn-success btn-sm btn-ready-toggle ready";
      this.showToast("You're marked ready");
    } else {
      if (this.labelReadyState) this.labelReadyState.innerText = "Mark ready";
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
    const isHost = this.isHost();
    if (!isHost) {
      this.showToast("Only the host can start the premiere");
      return;
    }
    this.showToast("Starting the premiere…");
    this.socket.send('launch_premiere', {});
  }

  renderCastActivityHUD() {
    if (!this.roomState || !this.castActivityList) return;
    const users = Object.values(this.roomState.users || {}).filter(u => u.is_online);
    const isHost = this.isHost();
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

    // Host Premiere Button Visibility
    if (this.btnLaunchPremiere) {
      if (isHost) {
        this.btnLaunchPremiere.style.display = 'inline-flex';
        this.btnLaunchPremiere.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start premiere (${readyCount}/${users.length} ready) ›</span>`;
      } else {
        this.btnLaunchPremiere.style.display = 'none';
      }
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
    // to the booth if recording has already started.
    const runsRoom = this.isHost({ allowDummy: true });
    const recording = this.roomState.status === 'recording';
    if (this.btnStartSession) this.btnStartSession.hidden = !runsRoom;
    if (this.btnBackToBooth) this.btnBackToBooth.hidden = runsRoom || !recording;
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
