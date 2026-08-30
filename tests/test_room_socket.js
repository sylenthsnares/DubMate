/**
 * test_room_socket.js
 * Delivery guarantees for RoomSocket.send().
 *
 * The regression this guards: joinRoom() calls connect() and then broadcasts the
 * user's status in the same tick, while the socket is still CONNECTING. That
 * message was silently dropped for as long as the code has existed. When send()
 * started reporting undeliverable messages, the same race began firing
 * "You're offline. That change wasn't saved to the room." at every single room
 * creation -- a false alarm on a connection that was about to succeed.
 *
 * Messages raised while opening are now queued and flushed on open. A send while
 * genuinely disconnected must still report failure, because that one is lost.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "static", "js", "room_socket.js");

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`         PASS: ${label}`);
    passed += 1;
  } else {
    console.log(`         FAIL: ${label}${detail !== undefined ? ` -- ${detail}` : ""}`);
    failed += 1;
  }
}

// --- A WebSocket stand-in we can hold in CONNECTING for as long as we like ----
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.last = this;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = FakeWebSocket.CLOSED; }

  /** Completes the handshake the way a real server would. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
}

function loadRoomSocket() {
  // The module is an ES module; strip the export keyword so it can run in a
  // plain VM context without a bundler.
  const source = fs.readFileSync(SRC, "utf8").replace(/^export\s+class/m, "class");
  const sandbox = {
    WebSocket: FakeWebSocket,
    window: { location: { protocol: "http:", host: "127.0.0.1:8000" }, __dubmate_app_version: "1.1.0" },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    JSON,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(source + "\nthis.__RoomSocket = RoomSocket;", sandbox);
  return sandbox.__RoomSocket;
}

const RoomSocket = loadRoomSocket();

console.log("\n  [+] RoomSocket: message delivery while opening");

// --- The exact joinRoom() sequence -------------------------------------------
{
  const socket = new RoomSocket();
  const failures = [];
  socket.on("send_failed", (e) => failures.push(e.payload.messageType));

  // This is what joinRoom does: connect, then broadcast status in the same tick.
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  const returned = socket.send("set_user_status", { location: "lobby" });

  check("a send during the handshake is not reported as a failure",
    failures.length === 0, `got ${JSON.stringify(failures)}`);
  check("send() reports success for a queued message", returned === true);
  check("nothing reached the wire yet", FakeWebSocket.last.sent.length === 0);

  // Server completes the handshake.
  FakeWebSocket.last.open();

  const types = FakeWebSocket.last.sent.map((m) => m.type);
  check("the queued status broadcast is delivered on open",
    types.includes("set_user_status"), JSON.stringify(types));
  check("join is still sent first", types[0] === "join", JSON.stringify(types));
  check("the queue is drained", socket.pendingMessages.length === 0);
}

// --- Genuine disconnection must still be reported ----------------------------
{
  const socket = new RoomSocket();
  const failures = [];
  socket.on("send_failed", (e) => failures.push(e.payload.messageType));

  // Never connected: no socket at all, and not reconnecting.
  const returned = socket.send("take_recorded", { line: 1 });

  check("a send with no connection reports failure", returned === false);
  check("and raises send_failed so the UI can say so",
    failures.length === 1 && failures[0] === "take_recorded", JSON.stringify(failures));
}

// --- Reconnect window: hold, do not drop -------------------------------------
{
  const socket = new RoomSocket();
  const failures = [];
  socket.on("send_failed", (e) => failures.push(e.payload.messageType));

  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  socket.connectionState = "reconnecting";
  FakeWebSocket.last.readyState = FakeWebSocket.CLOSED;

  socket.send("set_user_status", { location: "booth" });
  check("a send during a reconnect is held, not reported as lost",
    failures.length === 0 && socket.pendingMessages.length === 1,
    `failures=${failures.length} queued=${socket.pendingMessages.length}`);
}

// --- The queue is bounded ----------------------------------------------------
{
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  for (let i = 0; i < RoomSocket.MAX_PENDING_MESSAGES + 25; i++) {
    socket.send("set_user_status", { seq: i });
  }
  check("the queue is capped during a long outage",
    socket.pendingMessages.length === RoomSocket.MAX_PENDING_MESSAGES,
    socket.pendingMessages.length);
  check("the newest messages are the ones kept",
    socket.pendingMessages[socket.pendingMessages.length - 1].payload.seq
      === RoomSocket.MAX_PENDING_MESSAGES + 24);
}

// --- Leaving a room must not replay into the next one ------------------------
{
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  socket.send("set_user_status", { location: "lobby" });
  check("messages are queued before leaving", socket.pendingMessages.length === 1);

  socket.disconnect();
  check("an explicit disconnect discards the queue", socket.pendingMessages.length === 0);
}

console.log(`\n  RoomSocket: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
