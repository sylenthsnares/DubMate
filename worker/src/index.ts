import type { RoomEntry, CreateRoomRequest, UpdateRoomRequest, CreateRoomResponse, UpdateRoomResponse } from "./types.ts";

export interface Env {
  ROOMS: KVNamespace;
  DUBMATE_SECRET_KEY?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-DubMate-Key",
};

export function generateRoomCode(): string {
  // Excludes I, O, 0, 1 to avoid character confusion when reading out loud
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "DUB-" + Array.from(bytes).map(b => chars[b % chars.length]).join("");
}

export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorHtml(message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DubMate Studio - Room Error</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #0d0d0d;
      color: #f0f0f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 32px;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px 0;
      color: #ef4444;
    }
    p {
      font-size: 14px;
      color: #a1a1aa;
      line-height: 1.5;
      margin: 0 0 24px 0;
    }
    .badge {
      display: inline-block;
      padding: 6px 14px;
      background: #27272a;
      color: #d4d4d8;
      border-radius: 6px;
      font-size: 12px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Room Unavailable</h1>
    <p>${message}</p>
    <div class="badge">DubMate Studio</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // Trim trailing slashes

    // 0. Health check
    if (path === "" || path === "/health") {
      return jsonResponse({ status: "ok", service: "dubmate-room-registry" });
    }

    // 1. POST /rooms/create
    if (request.method === "POST" && path === "/rooms/create") {
      if (env.DUBMATE_SECRET_KEY) {
        const clientKey = request.headers.get("X-DubMate-Key");
        if (clientKey !== env.DUBMATE_SECRET_KEY) {
          return jsonResponse({ error: "Unauthorized: Invalid or missing X-DubMate-Key" }, 401);
        }
      }

      let body: CreateRoomRequest;
      try {
        body = await request.json() as CreateRoomRequest;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400);
      }

      if (!body.tunnel_url || typeof body.tunnel_url !== "string" || !body.tunnel_url.startsWith("https://")) {
        return jsonResponse({ error: "Missing or invalid tunnel_url (must start with https://)" }, 400);
      }

      // Generate unique room code with collision check
      let code = "";
      let collision = true;
      for (let i = 0; i < 10; i++) {
        const candidate = generateRoomCode();
        const existing = await env.ROOMS.get(candidate);
        if (!existing) {
          code = candidate;
          collision = false;
          break;
        }
      }

      if (collision || !code) {
        return jsonResponse({ error: "Could not allocate unique room code. Please retry." }, 500);
      }

      const roomToken = generateToken();
      const entry: RoomEntry = {
        tunnel_url: body.tunnel_url.trim(),
        room_token: roomToken,
        created_at: Math.floor(Date.now() / 1000),
        app_version: (body.app_version || "1.0.0").trim(),
      };

      // 12 hours TTL = 43200 seconds
      await env.ROOMS.put(code, JSON.stringify(entry), { expirationTtl: 43200 });

      const responsePayload: CreateRoomResponse = {
        code,
        room_token: roomToken,
      };

      return jsonResponse(responsePayload, 201);
    }

    // 2. POST /rooms/:code/update
    const updateMatch = path.match(/^\/rooms\/([A-Za-z0-9-]+)\/update$/);
    if (request.method === "POST" && updateMatch) {
      const code = updateMatch[1].toUpperCase();
      const rawEntry = await env.ROOMS.get(code);
      if (!rawEntry) {
        return jsonResponse({ error: "Room not found or expired" }, 404);
      }

      let entry: RoomEntry;
      try {
        entry = JSON.parse(rawEntry);
      } catch {
        return jsonResponse({ error: "Corrupt room data in registry" }, 500);
      }

      // Validate room token or global admin secret
      const authHeader = request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
      const clientKey = request.headers.get("X-DubMate-Key");

      const isTokenValid = bearerToken && bearerToken === entry.room_token;
      const isMasterKeyValid = env.DUBMATE_SECRET_KEY && clientKey === env.DUBMATE_SECRET_KEY;

      if (!isTokenValid && !isMasterKeyValid) {
        return jsonResponse({ error: "Unauthorized: Invalid room token or authorization header" }, 401);
      }

      let body: UpdateRoomRequest;
      try {
        body = await request.json() as UpdateRoomRequest;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400);
      }

      if (!body.tunnel_url || typeof body.tunnel_url !== "string" || !body.tunnel_url.startsWith("https://")) {
        return jsonResponse({ error: "Missing or invalid tunnel_url (must start with https://)" }, 400);
      }

      entry.tunnel_url = body.tunnel_url.trim();
      if (body.app_version) {
        entry.app_version = body.app_version.trim();
      }

      // Re-save with fresh 12 hours TTL
      await env.ROOMS.put(code, JSON.stringify(entry), { expirationTtl: 43200 });

      const responsePayload: UpdateRoomResponse = {
        ok: true,
        message: "Room tunnel updated successfully",
      };

      return jsonResponse(responsePayload, 200);
    }

    // 3. GET /rooms/:code/resolve OR GET /join/:code
    const resolveMatch = path.match(/^\/(?:rooms\/([A-Za-z0-9-]+)\/resolve|join\/([A-Za-z0-9-]+))$/);
    if (request.method === "GET" && resolveMatch) {
      const rawCode = (resolveMatch[1] || resolveMatch[2]).toUpperCase();
      const code = rawCode.startsWith("DUB-") ? rawCode : `DUB-${rawCode}`;

      const rawEntry = await env.ROOMS.get(code);
      const acceptsJson = (request.headers.get("Accept") || "").includes("application/json");

      if (!rawEntry) {
        if (acceptsJson) {
          return jsonResponse({ error: "Room not found or expired", code }, 404);
        }
        return errorHtml(`Room <strong>${code}</strong> was not found or has expired.<br>Ask your session host to share an active room code.`);
      }

      let entry: RoomEntry;
      try {
        entry = JSON.parse(rawEntry);
      } catch {
        if (acceptsJson) {
          return jsonResponse({ error: "Corrupt room data" }, 500);
        }
        return errorHtml("Corrupt room data encountered. Please try recreating the room.");
      }

      // If client explicitly asks for JSON, return entry metadata
      if (acceptsJson) {
        return jsonResponse({
          code,
          tunnel_url: entry.tunnel_url,
          app_version: entry.app_version,
          created_at: entry.created_at,
        }, 200);
      }

      // Otherwise, redirect client directly to the host's tunnel URL
      return new Response(null, {
        status: 302,
        headers: {
          "Location": entry.tunnel_url,
          ...CORS_HEADERS,
        },
      });
    }

    return jsonResponse({ error: `Not Found: ${request.method} ${path}` }, 404);
  },
};


