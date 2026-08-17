// room_socket.js - Real-time WebSocket connection to room session

export class RoomSocket {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.roomId = null;
    this.userId = null;
    this.userName = null;
    this.userColor = null;
    this.pingInterval = null;
  }

  connect(roomId, userId, userName, userColor) {
    this.roomId = roomId;
    this.userId = userId;
    this.userName = userName;
    this.userColor = userColor;

    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomId}/${userId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log(`[Socket] Connected to room ${roomId} as ${userName}`);
      this.send('join', { name: userName, color: userColor });
      this.startPing();
    };

    this.ws.onmessage = (event) => {
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
      if (this.roomId && this.userId) {
        console.warn("[Socket] Connection closed unexpectedly. Reconnecting in 2s...");
        setTimeout(() => {
          if (this.roomId && this.userId) {
            this.connect(this.roomId, this.userId, this.userName, this.userColor);
          }
        }, 2000);
      } else {
        console.log("[Socket] Disconnected from room.");
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Socket] Error:", err);
    };
  }

  disconnect() {
    this.roomId = null;
    this.userId = null;
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.onclose = null; // Prevent reconnect on explicit exit
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    console.log("[Socket] Session cleanly closed.");
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
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
}
