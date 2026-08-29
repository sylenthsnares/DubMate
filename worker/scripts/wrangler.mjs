#!/usr/bin/env node
/**
 * Project-local Wrangler wrapper.
 *
 * Runs Wrangler against a credential store inside this repo instead of the
 * machine-wide one, so the bkaproductions Cloudflare account can be used here
 * without touching (or being touched by) whatever `wrangler login` is active
 * globally.
 *
 * Wrangler resolves its config directory through XDG app paths, so pointing
 * XDG_CONFIG_HOME at a local folder relocates the whole OAuth store. (There is
 * no WRANGLER_HOME variable -- that is not a thing in Wrangler 4.)
 *
 * Two auth styles are supported:
 *   1. OAuth   -- `npm run cf:login` writes tokens into .wrangler-profile/
 *   2. API token -- put CLOUDFLARE_API_TOKEN=... in worker/.cloudflare.env
 *
 * Both paths are git-ignored. Usage:  node scripts/wrangler.mjs <args...>
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(HERE, "..");
const PROFILE_DIR = path.join(WORKER_DIR, ".wrangler-profile");
const ENV_FILE = path.join(WORKER_DIR, ".cloudflare.env");

const WRANGLER_BIN = path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
if (!fs.existsSync(WRANGLER_BIN)) {
  console.error(`[cf] Wrangler not installed. Run 'npm install' in ${WORKER_DIR} first.`);
  process.exit(1);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });

const env = { ...process.env, XDG_CONFIG_HOME: PROFILE_DIR };

// Optional non-interactive auth. Simple KEY=VALUE lines; # starts a comment.
let usingToken = false;
if (fs.existsSync(ENV_FILE)) {
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      env[key] = value;
      if (key === "CLOUDFLARE_API_TOKEN") usingToken = true;
    }
  }
}

const args = process.argv.slice(2);
console.error(
  `[cf] profile: ${PROFILE_DIR}\n` +
  `[cf] auth:    ${usingToken ? "CLOUDFLARE_API_TOKEN from .cloudflare.env" : "OAuth (run 'npm run cf:login' if not authenticated)"}`
);

const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
  stdio: "inherit",
  env,
  cwd: WORKER_DIR,
});

child.on("error", (err) => {
  console.error("[cf] Failed to launch wrangler:", err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
