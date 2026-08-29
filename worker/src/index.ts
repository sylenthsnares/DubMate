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

// ---------------------------------------------------------------------------
// SECURITY: Allowlist of hostnames/domains permitted for tunnel_url.
// Any host listed here (or a subdomain of it) can receive a 302 redirect from
// this registry, so extend this list carefully and only with trusted domains.
// Matching is exact-host or dot-suffix (e.g. "trycloudflare.com" also allows
// "abcd.trycloudflare.com" but NOT "eviltrycloudflare.com").
// ---------------------------------------------------------------------------
export const ALLOWED_TUNNEL_URL_DOMAINS: readonly string[] = [
  "trycloudflare.com",
  "bkaproductions.com",
];

// Input size limits enforced before any KV write.
const MAX_CODE_LENGTH = 64;
const MAX_TUNNEL_URL_LENGTH = 512;
const MAX_APP_VERSION_LENGTH = 32;

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

// Constant-time string comparison, used for the master X-DubMate-Key and for
// per-room bearer tokens, to avoid leaking secret content via timing.
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length, 1);

  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    const x = i < aBytes.length ? aBytes[i] : 0;
    const y = i < bBytes.length ? bBytes[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

// Validates a tunnel_url is an https:// URL whose hostname is on the
// ALLOWED_TUNNEL_URL_DOMAINS allowlist. Uses URL parsing (not substring
// matching) so query strings/paths cannot be used to spoof a trusted host.
export function isAllowedTunnelUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  return ALLOWED_TUNNEL_URL_DOMAINS.some(
    domain => hostname === domain || hostname.endsWith(`.${domain}`)
  );
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
        const clientKey = request.headers.get("X-DubMate-Key") ?? "";
        if (!timingSafeEqual(clientKey, env.DUBMATE_SECRET_KEY)) {
          return jsonResponse({ error: "Unauthorized: Invalid or missing X-DubMate-Key" }, 401);
        }
      }

      let body: CreateRoomRequest;
      try {
        body = await request.json() as CreateRoomRequest;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400);
      }

      if (!body.tunnel_url || typeof body.tunnel_url !== "string") {
        return jsonResponse({ error: "Missing or invalid tunnel_url (must be a string)" }, 400);
      }
      if (body.tunnel_url.length > MAX_TUNNEL_URL_LENGTH) {
        return jsonResponse({ error: `tunnel_url exceeds maximum length of ${MAX_TUNNEL_URL_LENGTH} characters` }, 400);
      }
      if (!isAllowedTunnelUrl(body.tunnel_url)) {
        return jsonResponse({ error: "Invalid tunnel_url: must be an https:// URL on an allowed domain" }, 400);
      }

      // Validate and normalize the optional explicit room code.
      let explicitCode = "";
      if (body.code) {
        if (typeof body.code !== "string") {
          return jsonResponse({ error: "Invalid code: must be a string" }, 400);
        }
        explicitCode = body.code.trim().toUpperCase();
        if (explicitCode.length > MAX_CODE_LENGTH) {
          return jsonResponse({ error: `code exceeds maximum length of ${MAX_CODE_LENGTH} characters` }, 400);
        }
      }

      // Validate and normalize the optional app_version.
      let appVersion = "1.0.0";
      if (body.app_version) {
        if (typeof body.app_version !== "string") {
          return jsonResponse({ error: "Invalid app_version: must be a string" }, 400);
        }
        appVersion = body.app_version.trim();
        if (appVersion.length > MAX_APP_VERSION_LENGTH) {
          return jsonResponse({ error: `app_version exceeds maximum length of ${MAX_APP_VERSION_LENGTH} characters` }, 400);
        }
      }

      let code = explicitCode;
      let existingEntry: RoomEntry | null = null;
      let statusCode = 201;

      if (code) {
        // Explicit code: if it already exists, only the holder of its
        // room_token (proven via Bearer auth) may overwrite it. This
        // prevents anyone holding just the shared X-DubMate-Key from
        // hijacking a live room by re-registering its code with a
        // different tunnel_url.
        const existingRaw = await env.ROOMS.get(code);
        if (existingRaw) {
          let parsedExisting: RoomEntry;
          try {
            parsedExisting = JSON.parse(existingRaw);
          } catch {
            return jsonResponse({ error: "Corrupt room data in registry" }, 500);
          }

          const authHeader = request.headers.get("Authorization") || "";
          const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
          const tokenValid = bearerToken.length > 0 && timingSafeEqual(bearerToken, parsedExisting.room_token);

          if (!tokenValid) {
            // Deliberately generic: do not reveal whether the token was
            // wrong versus absent.
            return jsonResponse({ error: "Room code already registered" }, 409);
          }

          existingEntry = parsedExisting;
          statusCode = 200;
        }
      } else {
        // No code supplied: auto-generate with collision check (unchanged).
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
      }

      const roomToken = existingEntry ? existingEntry.room_token : generateToken();
      const entry: RoomEntry = {
        tunnel_url: body.tunnel_url.trim(),
        room_token: roomToken,
        created_at: existingEntry ? existingEntry.created_at : Math.floor(Date.now() / 1000),
        app_version: appVersion,
      };

      // 12 hours TTL = 43200 seconds
      await env.ROOMS.put(code, JSON.stringify(entry), { expirationTtl: 43200 });

      const responsePayload: CreateRoomResponse = {
        code,
        room_token: roomToken,
      };

      return jsonResponse(responsePayload, statusCode);
    }

    // 2. POST /rooms/:code/update
    const updateMatch = path.match(/^\/rooms\/([A-Za-z0-9-]+)\/update$/);
    if (request.method === "POST" && updateMatch) {
      const code = updateMatch[1].toUpperCase();
      if (code.length > MAX_CODE_LENGTH) {
        return jsonResponse({ error: `code exceeds maximum length of ${MAX_CODE_LENGTH} characters` }, 400);
      }

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
      const clientKey = request.headers.get("X-DubMate-Key") ?? "";

      const isTokenValid = bearerToken.length > 0 && timingSafeEqual(bearerToken, entry.room_token);
      const isMasterKeyValid = !!env.DUBMATE_SECRET_KEY && timingSafeEqual(clientKey, env.DUBMATE_SECRET_KEY);

      if (!isTokenValid && !isMasterKeyValid) {
        return jsonResponse({ error: "Unauthorized: Invalid room token or authorization header" }, 401);
      }

      let body: UpdateRoomRequest;
      try {
        body = await request.json() as UpdateRoomRequest;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400);
      }

      if (!body.tunnel_url || typeof body.tunnel_url !== "string") {
        return jsonResponse({ error: "Missing or invalid tunnel_url (must be a string)" }, 400);
      }
      if (body.tunnel_url.length > MAX_TUNNEL_URL_LENGTH) {
        return jsonResponse({ error: `tunnel_url exceeds maximum length of ${MAX_TUNNEL_URL_LENGTH} characters` }, 400);
      }
      if (!isAllowedTunnelUrl(body.tunnel_url)) {
        return jsonResponse({ error: "Invalid tunnel_url: must be an https:// URL on an allowed domain" }, 400);
      }

      entry.tunnel_url = body.tunnel_url.trim();
      if (body.app_version) {
        if (typeof body.app_version !== "string") {
          return jsonResponse({ error: "Invalid app_version: must be a string" }, 400);
        }
        const trimmedVersion = body.app_version.trim();
        if (trimmedVersion.length > MAX_APP_VERSION_LENGTH) {
          return jsonResponse({ error: `app_version exceeds maximum length of ${MAX_APP_VERSION_LENGTH} characters` }, 400);
        }
        entry.app_version = trimmedVersion;
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
      let rawEntry = await env.ROOMS.get(rawCode);
      if (!rawEntry && !rawCode.startsWith("DUB-")) {
        rawEntry = await env.ROOMS.get(`DUB-${rawCode}`);
      }
      if (!rawEntry && rawCode.startsWith("DUB-")) {
        rawEntry = await env.ROOMS.get(rawCode.replace(/^DUB-/, ""));
      }
      const acceptsJson = (request.headers.get("Accept") || "").includes("application/json");

      if (!rawEntry) {
        if (acceptsJson) {
          return jsonResponse({ error: "Room not found or expired", code: rawCode }, 404);
        }
        return errorHtml(`Room <strong>${rawCode}</strong> was not found or has expired.<br>Ask your session host to share an active room code.`);
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
          code: rawCode,
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
