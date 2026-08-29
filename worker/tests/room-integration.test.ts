/**
 * room-integration.test.ts
 * Integration tests for DubMate room creation/joining workflow.
 * Run with: npx vitest run --config vitest.config.ts
 *
 * These tests run inside the actual Cloudflare Workers runtime via
 * @cloudflare/vitest-pool-workers, bound to the ROOMS preview KV namespace
 * defined in wrangler.toml. Rooms are real KV entries pushed to Cloudflare.
 */

import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

// ---- Helper: POST /rooms/create -----------------------------------------

async function createRoom(opts: {
  tunnel_url?: string;
  app_version?: string;
  code?: string;
  secret?: string;
} = {}): Promise<{ code: string; room_token: string; status: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.secret) headers["X-DubMate-Key"] = opts.secret;

  const res = await SELF.fetch("https://dubmate.test/rooms/create", {
    method: "POST",
    headers,
    body: JSON.stringify({
      tunnel_url: opts.tunnel_url ?? "https://integration-test.trycloudflare.com",
      app_version: opts.app_version,
      code: opts.code,
    }),
  });
  const data = await res.json() as Record<string, unknown>;
  return { ...(data as { code: string; room_token: string }), status: res.status };
}

// ---- Helper: GET /rooms/:code/resolve (JSON) ----------------------------

async function resolveRoom(code: string): Promise<{
  code: string;
  tunnel_url: string;
  app_version: string;
  status: number;
}> {
  const res = await SELF.fetch(`https://dubmate.test/rooms/${code}/resolve`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const data = await res.json() as Record<string, unknown>;
  return { ...(data as { code: string; tunnel_url: string; app_version: string }), status: res.status };
}

// ---- Tests ---------------------------------------------------------------

describe("Room creation and KV persistence (preview KV)", () => {
  it("POST /rooms/create returns 201 and a DUB-XXXX room code", async () => {
    const { status, code, room_token } = await createRoom({
      tunnel_url: "https://integration.trycloudflare.com",
      app_version: "1.0.6",
    });

    expect(status).toBe(201);
    expect(code).toMatch(/^DUB-[A-Z2-9]{4}$/);
    expect(room_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("Created room is actually stored in the preview KV namespace", async () => {
    const { code, room_token } = await createRoom({
      tunnel_url: "https://kv-verify.trycloudflare.com",
      app_version: "1.0.6",
    });

    // Read directly from KV binding — proves the data was committed
    const raw = await env.ROOMS.get(code);
    expect(raw).toBeTruthy();

    const entry = JSON.parse(raw!) as {
      tunnel_url: string;
      room_token: string;
      app_version: string;
      created_at: number;
    };
    expect(entry.tunnel_url).toBe("https://kv-verify.trycloudflare.com");
    expect(entry.room_token).toBe(room_token);
    expect(entry.app_version).toBe("1.0.6");
    expect(entry.created_at).toBeGreaterThan(0);
  });

  it("GET /rooms/:code/resolve returns the correct tunnel_url from KV", async () => {
    const { code } = await createRoom({
      tunnel_url: "https://resolve-test.trycloudflare.com",
      app_version: "1.0.6",
    });

    const resolved = await resolveRoom(code);
    expect(resolved.status).toBe(200);
    expect(resolved.code).toBe(code);
    expect(resolved.tunnel_url).toBe("https://resolve-test.trycloudflare.com");
  });
});

describe("Room joining workflow", () => {
  it("GET /join/:code (without DUB- prefix) redirects to tunnel_url", async () => {
    const { code } = await createRoom({
      tunnel_url: "https://join-test.trycloudflare.com",
      app_version: "1.0.6",
    });

    // Strip DUB- prefix for the /join/ alias
    const shortCode = code.replace(/^DUB-/, "");
    const res = await SELF.fetch(`https://dubmate.test/join/${shortCode}`, {
      method: "GET",
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://join-test.trycloudflare.com");
  });

  it("GET /join/:code with full DUB-XXXX code also resolves correctly", async () => {
    const { code } = await createRoom({
      tunnel_url: "https://join-full.trycloudflare.com",
      app_version: "1.0.6",
    });

    const res = await SELF.fetch(`https://dubmate.test/join/${code}`, {
      method: "GET",
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://join-full.trycloudflare.com");
  });

  it("GET /join/:code for a missing room returns 404 HTML", async () => {
    const res = await SELF.fetch("https://dubmate.test/join/DUB-MISS", {
      method: "GET",
    });

    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Room Unavailable");
    expect(html).toContain("DUB-MISS");
  });

  it("GET /rooms/:code/resolve for missing room with JSON Accept returns 404 JSON", async () => {
    const res = await SELF.fetch("https://dubmate.test/rooms/DUB-GONE/resolve", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toContain("not found");
  });
});

describe("Room update workflow", () => {
  it("POST /rooms/:code/update replaces tunnel_url and is reflected in KV", async () => {
    const { code, room_token } = await createRoom({
      tunnel_url: "https://old-tunnel.trycloudflare.com",
      app_version: "1.0.5",
    });

    // Update the tunnel URL
    const updateRes = await SELF.fetch(`https://dubmate.test/rooms/${code}/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${room_token}`,
      },
      body: JSON.stringify({
        tunnel_url: "https://new-tunnel.trycloudflare.com",
        app_version: "1.0.6",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateData = await updateRes.json() as { ok: boolean };
    expect(updateData.ok).toBe(true);

    // Verify the update is reflected in the KV namespace
    const raw = await env.ROOMS.get(code);
    const stored = JSON.parse(raw!) as { tunnel_url: string; app_version: string };
    expect(stored.tunnel_url).toBe("https://new-tunnel.trycloudflare.com");
    expect(stored.app_version).toBe("1.0.6");

    // And the resolve endpoint returns the new URL
    const resolved = await resolveRoom(code);
    expect(resolved.tunnel_url).toBe("https://new-tunnel.trycloudflare.com");
  });
});

describe("Custom room code creation", () => {
  it("POST /rooms/create with a custom code stores under that exact code", async () => {
    const customCode = `INTEG-TEST-${Date.now().toString(36).toUpperCase()}`;
    const { status, code } = await createRoom({
      tunnel_url: "https://custom-code.trycloudflare.com",
      code: customCode,
    });

    expect(status).toBe(201);
    // Worker uppercases and uses it as-is
    expect(code).toBe(customCode.toUpperCase());

    // Confirm it exists in KV
    const raw = await env.ROOMS.get(code);
    expect(raw).toBeTruthy();
  });
});
