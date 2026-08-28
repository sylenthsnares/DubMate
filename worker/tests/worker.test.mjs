import test from "node:test";
import assert from "node:assert/strict";
import worker, { generateRoomCode, generateToken } from "../src/index.ts";

class MockKV {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async put(key, value, options = {}) {
    let expiresAt = null;
    if (options.expirationTtl) {
      expiresAt = Date.now() + options.expirationTtl * 1000;
    }
    this.store.set(key, { value, expiresAt });
  }

  async delete(key) {
    this.store.delete(key);
  }
}

test("generateRoomCode produces DUB-XXXX format excluding confusing chars", () => {
  for (let i = 0; i < 50; i++) {
    const code = generateRoomCode();
    assert.match(code, /^DUB-[A-Z2-9]{4}$/);
    assert.ok(!code.includes("0") && !code.includes("O") && !code.includes("1") && !code.includes("I"));
  }
});

test("generateToken produces 32-char hex string", () => {
  for (let i = 0; i < 50; i++) {
    const token = generateToken();
    assert.match(token, /^[0-9a-f]{32}$/);
  }
});

test("Worker handles OPTIONS CORS preflight", async () => {
  const kv = new MockKV();
  const req = new Request("http://localhost:8787/rooms/create", { method: "OPTIONS" });
  const res = await worker.fetch(req, { ROOMS: kv });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("Worker /health endpoint returns ok", async () => {
  const kv = new MockKV();
  const req = new Request("http://localhost:8787/health", { method: "GET" });
  const res = await worker.fetch(req, { ROOMS: kv });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
});

test("POST /rooms/create requires auth if DUBMATE_SECRET_KEY is configured", async () => {
  const kv = new MockKV();
  const env = { ROOMS: kv, DUBMATE_SECRET_KEY: "secret_123" };

  // Without header
  const req1 = new Request("http://localhost:8787/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tunnel_url: "https://test.trycloudflare.com" }),
  });
  const res1 = await worker.fetch(req1, env);
  assert.equal(res1.status, 401);

  // With wrong header
  const req2 = new Request("http://localhost:8787/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DubMate-Key": "wrong_key" },
    body: JSON.stringify({ tunnel_url: "https://test.trycloudflare.com" }),
  });
  const res2 = await worker.fetch(req2, env);
  assert.equal(res2.status, 401);

  // With valid header
  const req3 = new Request("http://localhost:8787/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DubMate-Key": "secret_123" },
    body: JSON.stringify({ tunnel_url: "https://test.trycloudflare.com", app_version: "1.2.0" }),
  });
  const res3 = await worker.fetch(req3, env);
  assert.equal(res3.status, 201);
  const data = await res3.json();
  assert.match(data.code, /^DUB-[A-Z2-9]{4}$/);
  assert.match(data.room_token, /^[0-9a-f]{32}$/);

  // Verify KV content
  const storedRaw = await kv.get(data.code);
  assert.ok(storedRaw);
  const stored = JSON.parse(storedRaw);
  assert.equal(stored.tunnel_url, "https://test.trycloudflare.com");
  assert.equal(stored.room_token, data.room_token);
  assert.equal(stored.app_version, "1.2.0");
});

test("POST /rooms/:code/update validates auth token and updates tunnel_url", async () => {
  const kv = new MockKV();
  const env = { ROOMS: kv, DUBMATE_SECRET_KEY: "secret_123" };

  // Create room first
  const createReq = new Request("http://localhost:8787/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DubMate-Key": "secret_123" },
    body: JSON.stringify({ tunnel_url: "https://host1.trycloudflare.com", app_version: "1.0.0" }),
  });
  const createRes = await worker.fetch(createReq, env);
  const { code, room_token } = await createRes.json();

  // Try updating with invalid token
  const updateReqFail = new Request(`http://localhost:8787/rooms/${code}/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer bad_token_123",
    },
    body: JSON.stringify({ tunnel_url: "https://host2.trycloudflare.com" }),
  });
  const updateResFail = await worker.fetch(updateReqFail, env);
  assert.equal(updateResFail.status, 401);

  // Update with valid Bearer token
  const updateReqSuccess = new Request(`http://localhost:8787/rooms/${code}/update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${room_token}`,
    },
    body: JSON.stringify({ tunnel_url: "https://host2.trycloudflare.com", app_version: "1.1.0" }),
  });
  const updateResSuccess = await worker.fetch(updateReqSuccess, env);
  assert.equal(updateResSuccess.status, 200);
  const updateData = await updateResSuccess.json();
  assert.equal(updateData.ok, true);

  // Check that KV has updated tunnel URL
  const stored = JSON.parse(await kv.get(code));
  assert.equal(stored.tunnel_url, "https://host2.trycloudflare.com");
  assert.equal(stored.app_version, "1.1.0");
});

test("GET /rooms/:code/resolve redirects to tunnel URL or returns JSON", async () => {
  const kv = new MockKV();
  const env = { ROOMS: kv, DUBMATE_SECRET_KEY: "secret_123" };

  // Create room
  const createReq = new Request("http://localhost:8787/rooms/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DubMate-Key": "secret_123" },
    body: JSON.stringify({ tunnel_url: "https://stream.trycloudflare.com", app_version: "1.0.0" }),
  });
  const createRes = await worker.fetch(createReq, env);
  const { code } = await createRes.json();

  // Test 302 Redirect resolution
  const resolveReq = new Request(`http://localhost:8787/rooms/${code}/resolve`, { method: "GET" });
  const resolveRes = await worker.fetch(resolveReq, env);
  assert.equal(resolveRes.status, 302);
  assert.equal(resolveRes.headers.get("Location"), "https://stream.trycloudflare.com");

  // Test /join/:code alias
  const joinReq = new Request(`http://localhost:8787/join/${code.replace("DUB-", "")}`, { method: "GET" });
  const joinRes = await worker.fetch(joinReq, env);
  assert.equal(joinRes.status, 302);
  assert.equal(joinRes.headers.get("Location"), "https://stream.trycloudflare.com");

  // Test JSON resolution
  const jsonReq = new Request(`http://localhost:8787/rooms/${code}/resolve`, {
    method: "GET",
    headers: { "Accept": "application/json" },
  });
  const jsonRes = await worker.fetch(jsonReq, env);
  assert.equal(jsonRes.status, 200);
  const jsonData = await jsonRes.json();
  assert.equal(jsonData.tunnel_url, "https://stream.trycloudflare.com");
  assert.equal(jsonData.code, code);

  // Test 404 for missing room
  const missingReq = new Request("http://localhost:8787/rooms/DUB-9999/resolve", { method: "GET" });
  const missingRes = await worker.fetch(missingReq, env);
  assert.equal(missingRes.status, 404);
  const html = await missingRes.text();
  assert.ok(html.includes("Room Unavailable") && html.includes("DUB-9999"));
});
