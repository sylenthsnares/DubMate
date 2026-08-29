# DubMate Room Registry — Cloudflare Worker

Ephemeral room-code registry backed by Workers KV, served at `dubmate.bkaproductions.com`.
Desktop and web clients register a room code mapped to their Cloudflare tunnel URL; other
clients resolve the code to join.

## Project-local Cloudflare login

Wrangler normally stores its OAuth token machine-wide, so `wrangler login` here would
overwrite (or be overwritten by) whatever account you are logged into globally. Every
Wrangler command in this directory therefore runs through `scripts/wrangler.mjs`, which
points `XDG_CONFIG_HOME` at `worker/.wrangler-profile/` — Wrangler resolves its config
through XDG app paths, so this relocates the entire credential store.

(There is no `WRANGLER_HOME` variable; that is not supported in Wrangler 4.)

```bash
cd worker
npm install
npm run cf:login      # opens a browser; log in as the bkaproductions account
npm run cf:whoami     # confirm which account this directory is bound to
```

Your global login is untouched. To verify the separation:

```bash
npx wrangler whoami      # global account
npm run cf:whoami        # this project's account
```

### Non-interactive alternative

Instead of OAuth, copy `.cloudflare.env.example` to `.cloudflare.env` and set
`CLOUDFLARE_API_TOKEN`. The wrapper loads it automatically and reports which auth
mode is active on every invocation. Token permissions required:

| Scope | Permission |
| --- | --- |
| Account → Workers Scripts | Edit |
| Account → Workers KV Storage | Edit |

**`.wrangler-profile/` and `.cloudflare.env` are git-ignored. Never commit either.**

## Commands

| Command | Purpose |
| --- | --- |
| `npm run cf:login` / `cf:logout` / `cf:whoami` | Manage this directory's Cloudflare session |
| `npm run cf:deploy` | Deploy the worker |
| `npm run cf:secret` | Set `DUBMATE_SECRET_KEY` (prompts for the value) |
| `npm run cf:secret:list` | List configured secrets |
| `npm run cf -- <args>` | Any other Wrangler command, using the local profile |
| `npm test` | Unit suite (`node:test`) |
| `npm run test:integration` | Workers-runtime integration suite (Vitest) |
| `npm run test:all` | Both |

## Rotating `DUBMATE_SECRET_KEY`

This key is checked in `src/index.ts` and sent by clients as the `X-DubMate-Key` header.
It is **optional** — if unset, `POST /rooms/create` accepts unauthenticated requests.

```bash
npm run cf:secret     # paste the new value
```

### Where the new value has to go

Rotating the Worker secret alone is not enough — clients must send the matching key.

| Consumer | How it gets the key |
| --- | --- |
| Desktop builds | GitHub repo secret `DUBMATE_SECRET_KEY` → CI passes it as `DUBMATE_WORKER_KEY` → baked into the Rust binary via `option_env!` → forwarded to the Python engine at launch |
| Source checkouts (web) | `DUBMATE_WORKER_KEY` env var, or a `.dubmate.env` file at the repo root (see `.dubmate.env.example`) |

So a full rotation is: set the Worker secret here, update the **GitHub repo secret**
`DUBMATE_SECRET_KEY` to the same value, then cut a release so the new binary carries it.
Updating only one side breaks public room registration with a 401.

There is no hardcoded fallback anymore. If no key is configured the app logs a notice
and skips public room registration; local and LAN play are unaffected.

Two things to know before rotating:

- The previous value shipped inside published desktop builds and is in git history.
  Treat it as permanently public; rotation stops it working but cannot un-publish it.
- Rotating breaks clients older than the release that carries the new key — they will
  receive 401 on room registration. Either accept that as a forced upgrade, or leave the
  secret unset during a transition window. Overwriting an existing room still requires
  that room's `room_token`, so the ownership check remains in force either way.
