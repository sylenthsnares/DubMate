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

  /** The server (or the network) drops the socket. */
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  /** A message from the server. */
  receive(data) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  /** Completes the handshake the way a real server would. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
}

// Timers the tests can see and fire by hand.
const timers = new Map();
let nextTimerId = 1;
function fireTimers() {
  const due = [...timers.values()];
  timers.clear();
  due.forEach((fn) => fn());
}

// A guest's page on someone else's engine by default; loopback is the host's own page.
function loadRoomSocket(hostname = "room.example.com") {
  // The module is an ES module; strip the export keyword so it can run in a
  // plain VM context without a bundler.
  const source = fs.readFileSync(SRC, "utf8").replace(/^export\s+class/m, "class");
  const sandbox = {
    WebSocket: FakeWebSocket,
    window: { location: { protocol: "http:", host: `${hostname}:8000`, hostname }, __dubmate_app_version: "1.1.0" },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => { const id = nextTimerId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
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

// --- Take edits are addressed by line and take ID ----------------------------
{
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  socket.updateTakeParams("t44048", "9f3c1a2b", { offset_ms: 40 });
  const sent = FakeWebSocket.last.sent.find((m) => m.type === "update_take_params");
  check("update_take_params names the line and the take",
    sent && sent.payload.line_id === "t44048" && sent.payload.take_id === "9f3c1a2b"
      && sent.payload.offset_ms === 40 && !("line_index" in sent.payload), JSON.stringify(sent));
  check("there is no socket message for deleting a take", typeof socket.clearTake === "undefined");
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

console.log("\n  [+] RoomSocket: giving up, retrying, and the overflowing queue");

// --- After 5 failed retries it stops and says so ------------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  const states = [];
  socket.on("connection_state", (e) => states.push(e.payload));
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.drop();
  check("a drop starts reconnecting", socket.connectionState === "reconnecting" && timers.size === 1,
    `${socket.connectionState} timers=${timers.size}`);
  const reconnecting = states.find((s) => s.state === "reconnecting");
  check("the state payload keeps its shape",
    reconnecting && typeof reconnecting.retryInMs === "number" && reconnecting.attempt === 1,
    JSON.stringify(reconnecting));
  for (let i = 0; i < 5; i++) {
    fireTimers();              // the retry connects
    FakeWebSocket.last.drop(); // and fails
  }
  check("after 5 failed retries the state is 'failed'", socket.connectionState === "failed", socket.connectionState);
  check("and no retry is scheduled", timers.size === 0 && socket.reconnectTimeout === null, timers.size);
  const last = states[states.length - 1];
  check("the failed payload carries the attempt count",
    last.state === "failed" && last.attempt === 5, JSON.stringify(last));

  const failures = [];
  socket.on("send_failed", (e) => failures.push(e.payload.messageType));
  const returned = socket.send("set_user_status", { is_ready: true });
  check("a send once it has given up is reported as lost",
    returned === false && failures.length === 1 && socket.pendingMessages.length === 0,
    `returned=${returned} failures=${failures.length} queued=${socket.pendingMessages.length}`);
}

// --- The host's own page keeps trying: its engine comes back after a restart ----
for (const hostname of ["127.0.0.1", "localhost"]) {
  timers.clear();
  const OwnRoomSocket = loadRoomSocket(hostname);
  const socket = new OwnRoomSocket();
  const failures = [];
  socket.on("send_failed", (e) => failures.push(e.payload.messageType));
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.drop();
  for (let i = 0; i < 20; i++) { fireTimers(); FakeWebSocket.last.drop(); }
  check(`on ${hostname} it is still reconnecting after 20 failed retries`,
    socket.connectionState === "reconnecting" && timers.size === 1, `${socket.connectionState} timers=${timers.size}`);
  const delay = socket._nextReconnectDelay();
  check(`on ${hostname} the wait stays within the 30 second cap`, delay >= 15000 && delay <= 30000, delay);
  socket.send("set_user_status", { is_ready: true });
  check(`on ${hostname} changes keep waiting in the queue`, failures.length === 0 && socket.pendingMessages.length === 1,
    `failures=${failures.length} queued=${socket.pendingMessages.length}`);
  fireTimers();
  FakeWebSocket.last.open();
  check(`on ${hostname} the engine coming back sends what waited`,
    socket.connectionState === "open" && FakeWebSocket.last.sent.some((m) => m.type === "set_user_status"), socket.connectionState);

  // "Room not found" still ends it: the engine is back, but the room is not.
  timers.clear();
  const gone = new OwnRoomSocket();
  gone.connect("GONE01", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.receive({ type: "error", message: "Room not found" });
  FakeWebSocket.last.drop();
  check(`on ${hostname} a room that is gone still gives up`, gone.connectionState === "failed" && timers.size === 0, gone.connectionState);
}

// --- "Room not found" gives up at once ----------------------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  const errors = [];
  socket.on("error", (e) => errors.push(e));
  socket.connect("GONE01", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.receive({ type: "error", message: "Room not found" });
  FakeWebSocket.last.drop();
  check("a payload-less error then a close goes straight to 'failed'",
    socket.connectionState === "failed" && timers.size === 0, `${socket.connectionState} timers=${timers.size}`);
  check("the error is still passed on", errors.length === 1);

  // A refused change carries a payload and must not end the retries.
  timers.clear();
  const other = new RoomSocket();
  other.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.receive({ type: "error", payload: { message: "Only the host can do that." } });
  FakeWebSocket.last.drop();
  check("an error with a payload does not end the retries",
    other.connectionState === "reconnecting" && timers.size === 1, other.connectionState);
}

// --- Retry now reconnects and sends what was kept -----------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.drop();
  socket.send("assign_role", { character: "Deku", user_ids: ["user1"] });
  check("a change made while reconnecting is queued", socket.pendingMessages.length === 1);
  for (let i = 0; i < 5; i++) { fireTimers(); FakeWebSocket.last.drop(); }
  check("the queue is kept once it has given up",
    socket.connectionState === "failed" && socket.pendingMessages.length === 1, socket.pendingMessages.length);

  const before = FakeWebSocket.last;
  socket.retryNow();
  check("retryNow opens a new connection at once",
    FakeWebSocket.last !== before && socket.connectionState === "connecting", socket.connectionState);
  check("with a fresh set of attempts", socket.reconnectAttempts === 0 && socket.roomGone === false);
  FakeWebSocket.last.open();
  const types = FakeWebSocket.last.sent.map((m) => m.type);
  check("the kept change is sent once it is back",
    types[0] === "join" && types.includes("assign_role") && socket.pendingMessages.length === 0, JSON.stringify(types));
}

// --- Cast evenly is one message -------------------------------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#f08a6c");
  FakeWebSocket.last.open();
  socket.castEvenly();
  const last = FakeWebSocket.last.sent[FakeWebSocket.last.sent.length - 1];
  check("castEvenly sends cast_evenly", last && last.type === "cast_evenly", JSON.stringify(last));
  socket.disconnect();
}

// --- Retry now while a retry is waiting replaces it -----------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.drop();
  check("a retry is waiting", timers.size === 1);
  socket.retryNow();
  check("retryNow cancels it and connects now", timers.size === 0 && socket.connectionState === "connecting",
    `timers=${timers.size} ${socket.connectionState}`);
}

// --- Retry now after the room was gone tries again ----------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  socket.connect("GONE01", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.receive({ type: "error", message: "Room not found" });
  FakeWebSocket.last.drop();
  socket.retryNow();
  FakeWebSocket.last.drop();
  check("after retryNow a plain drop retries again instead of giving up",
    socket.connectionState === "reconnecting" && timers.size === 1, socket.connectionState);
}

// --- The overflowing queue is reported once per outage ------------------------
{
  timers.clear();
  const socket = new RoomSocket();
  const overflows = [];
  socket.on("queue_overflow", (e) => overflows.push(e.payload));
  socket.connect("ABC123", "user1", "Tani", "#7c5cff");
  FakeWebSocket.last.open();
  FakeWebSocket.last.drop();
  for (let i = 0; i < RoomSocket.MAX_PENDING_MESSAGES + 10; i++) socket.send("set_user_status", { seq: i });
  check("queue_overflow fires once however many are dropped",
    overflows.length === 1 && !overflows[0].recovered, JSON.stringify(overflows));

  fireTimers();
  FakeWebSocket.last.open();
  check("on reconnect it fires again, marked recovered",
    overflows.length === 2 && overflows[1].recovered === true, JSON.stringify(overflows));

  FakeWebSocket.last.drop();
  for (let i = 0; i < RoomSocket.MAX_PENDING_MESSAGES + 1; i++) socket.send("set_user_status", { seq: i });
  check("a later outage reports its own overflow", overflows.length === 3 && !overflows[2].recovered, overflows.length);

  socket.disconnect();
  check("disconnect still clears the queue", socket.pendingMessages.length === 0);
  check("and leaves no retry behind", timers.size === 0 && socket.connectionState === "disconnected");
}

console.log(`\n  RoomSocket: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
