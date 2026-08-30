// room_socket.js - Real-time WebSocket connection to room session

// Heartbeat: server round-trip and liveness tuning.
// The backend's /ws handler replies to {type:'ping'} with {type:'pong'},
// but liveness is tracked from *any* inbound message (pong included) so a
// stalled ping/pong pair alone can't mask other traffic still flowing.
const PING_INTERVAL_MS = 20000;
const PING_TIMEOUT_MS = PING_INTERVAL_MS * 2.5; // 50s of total silence => assume half-open socket

// Reconnect: exponential backoff with jitter to avoid thundering-herd
// reconnect storms against the server during an outage.
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;

export class RoomSocket {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.roomId = null;
    this.userId = null;
    this.userName = null;
    this.userColor = null;
    this.pingInterval = null;
    this.reconnectTimeout = null;

    // Heartbeat liveness tracking
    this.lastMessageAt = null;

    // Reconnect backoff state
    this.reconnectAttempts = 0;

    // Publicly readable connection state so the UI layer (app.js) can
    // surface a persistent-disconnect condition if it chooses to.
    // One of: 'disconnected' | 'connecting' | 'open' | 'reconnecting'
    this.connectionState = 'disconnected';
  }

  connect(roomId, userId, userName, userColor) {
    this.roomId = roomId;
    this.userId = userId;
    this.userName = userName;
    this.userColor = userColor;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      try {
        this.ws.onclose = null; // Detach before closing to prevent duplicate reconnect cascades
        this.ws.onerror = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    this._setConnectionState('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomId}/${userId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[Socket] Connected to room ${roomId} as ${userName}`);
      this._setConnectionState('open');
      this.reconnectAttempts = 0; // Reset backoff on a successful connection
      this.lastMessageAt = Date.now();
      const appVersion = window.__dubmate_app_version || "1.0.0";
      this.send('join', { name: userName, color: userColor, app_version: appVersion });
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      // Any inbound traffic counts as liveness, not just an explicit pong,
      // since that's the only signal guaranteed to exist against this backend.
      this.lastMessageAt = Date.now();
      try {
        const data = JSON.parse(event.data);
        this.emit(data.type, data);
        this.emit('*', data);
      } catch (err) {
        console.error("[Socket] Message parse error:", err);
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      if (this.roomId && this.userId) {
        const delay = this._nextReconnectDelay();
        this._setConnectionState('reconnecting', { retryInMs: delay, attempt: this.reconnectAttempts });
        console.warn(`[Socket] Connection closed unexpectedly. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimeout = setTimeout(() => {
          this.reconnectTimeout = null;
          if (this.roomId && this.userId) {
            this.connect(this.roomId, this.userId, this.userName, this.userColor);
          }
        }, delay);
      } else {
        this._setConnectionState('disconnected');
        console.log("[Socket] Disconnected from room.");
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Socket] Error:", err);
    };
  }

  // Computes the next exponential-backoff delay (with jitter) and advances
  // the attempt counter. Delay grows 2s, 4s, 8s, ... capped at 30s, and is
  // "equal jittered" (delay in [cap/2, cap]) so many clients reconnecting
  // after an outage don't all retry at the exact same instant.
  _nextReconnectDelay() {
    const cap = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts));
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2));
    this.reconnectAttempts += 1;
    return delay;
  }

  disconnect() {
    this.roomId = null;
    this.userId = null;
    this.stopPing();
    this.reconnectAttempts = 0;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try {
        this.ws.onclose = null; // Prevent reconnect on explicit exit
        this.ws.onerror = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.connectionState = 'disconnected';
    console.log("[Socket] Session cleanly closed.");
  }

  startPing() {
    this.stopPing();
    this.lastMessageAt = Date.now();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > PING_TIMEOUT_MS) {
        // Half-open connection: readyState is still OPEN but nothing has
        // arrived (no pong, no other message) within the liveness window.
        // Force-close so the existing onclose -> reconnect path takes over.
        console.warn(`[Socket] No inbound traffic for ${silentFor}ms; assuming dead connection. Forcing reconnect.`);
        try { this.ws.close(); } catch (e) {}
        return;
      }

      this.ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Publishes a connection-state change so the UI can show it.
   *
   * The state was tracked but never emitted, so a dropped connection looked
   * completely normal on screen: the room sat there frozen while recordings and
   * role changes silently evaporated.
   */
  _setConnectionState(state, detail = {}) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.emit('connection_state', { type: 'connection_state', payload: { state, ...detail } });
  }

  /**
   * Returns false when the message could not be sent.
   *
   * This used to no-op silently while offline, so a take, a role assignment or a
   * take-clear would just never happen with nothing shown to the user.
   */
  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    console.warn(`[Socket] Dropped '${type}' -- connection is ${this.connectionState}.`);
    this.emit('send_failed', { type: 'send_failed', payload: { messageType: type } });
    return false;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const list = this.listeners.get(event) || [];
    for (const cb of list) {
      try { cb(data); } catch (e) { console.error(e); }
    }
  }

  assignRole(character, userIds) {
    this.send('assign_role', { character, user_ids: userIds });
  }

  setMode(mode) {
    this.send('set_mode', { mode });
  }

  setStatus(status) {
    this.send('set_status', { status });
  }

  setLine(lineIndex) {
    this.send('set_line', { line_index: lineIndex });
  }

  updateTakeParams(lineIndex, params) {
    this.send('update_take_params', { line_index: lineIndex, ...params });
  }

  clearTake(lineIndex) {
    this.send('clear_take', { line_index: lineIndex });
  }

  initiateTransfer(targetUserId) {
    this.send('initiate_transfer', { target_user_id: targetUserId });
  }

  completeTransfer(newTunnelUrl, newRoomId) {
    this.send('complete_transfer', { new_tunnel_url: newTunnelUrl, new_room_id: newRoomId });
  }
}
