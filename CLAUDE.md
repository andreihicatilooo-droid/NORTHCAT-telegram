# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

CRB GA — a Telegram Mini App escrow ("гарант") service. A buyer's payment is held by
the service and released to the seller only after the buyer confirms delivery; either
party can open a dispute that an arbiter (admin) resolves. Payment rails: xRocket,
Bitpapa, PGon, NicePay, RuKassa. All UI strings, comments, and commit-facing docs are
in Russian — match that when editing user-facing text.

There is no build step anywhere in this repo. The frontend is plain HTML/CSS/JS served
as static files; the backend is a single-file Node/Express app.

## Commands

Backend (from `backend/`):
```bash
npm install          # only real dependency is express
cp .env.example .env # fill in BOT_TOKEN, ADMIN_IDS, gateway keys, etc.
node server.js        # starts Express + Telegram long-polling bot on PORT (default 3000)
```

There are no lint or test scripts in this repo (no test framework, no `test`/`lint`
entries in either `package.json`). Don't invent commands that aren't there.

Full local launch (installs deps, frees the port, starts backend in background, opens
the interactive CLI dashboard):
```bash
./start.sh
```

Interactive ops console (status, live logs, deal list, restart, Cloudflare tunnel):
```bash
./cli.js
```

Frontend has no dev server requirement — `index.html` can be opened directly or served
by the backend itself (see "Static serving" below). Local admin/config screen:
```
http://127.0.0.1:3000/?admin=1
```

## Architecture

### Repo layout
- `index.html`, `css/`, `js/` — the Mini App frontend (no bundler; `js/config.js` is a
  plain global `window.NORTHCAT_CONFIG` object, hand-edited or overridden via the admin
  panel's localStorage overrides).
- `backend/server.js` — the entire backend: HTTP API, Telegram bot, payment gateway
  integrations, all in one ~2300-line file. There is no router/service/model split;
  navigate it by the section comments and the grep landmarks below.
- `settings.html` — standalone admin page for editing runtime bot/server config from a
  browser (distinct from the Mini App's own `?admin=1` tab).
- `cli.js` / `start.sh` — terminal ops dashboard and launch script (process management,
  log tailing, Cloudflare tunnel creation), not part of the request-handling app.
- `launcher.js` / `launcher.html` — a separate lightweight Express app (port 8000) that
  serves a browser-based control panel for the same start/stop/tunnel operations `cli.js`
  exposes in the terminal.

### Frontend: demo mode vs API mode
`js/app.js` decides at load time whether to talk to a real backend or run standalone:
- `API_URL: ""` forces demo mode: deals are kept in `localStorage`, payment is simulated,
  and "Демо: …" buttons exist to walk through the whole deal flow without a backend.
- `API_URL: "auto"` probes `/api/health` on the current origin; if unreachable it falls
  back to demo mode. On localhost specifically, it also tries port `3001` (so a newer
  backend running alongside an old one on `3000` is preferred automatically).
- Otherwise `API_URL` is used as a literal backend origin.

Auth to the backend is via Telegram `initData` (inside Telegram) or a Telegram Login
Widget flow (in a plain browser) that exchanges widget data for a bearer session token
stored in `localStorage`.

### Backend: environment and storage
- `loadEnvFiles` reads `backend/.env` first, then falls back to the repo-root `.env` —
  and treats obvious placeholder values (`replace-me`, the BotFather example token
  pattern) as unset, so a copied-but-unedited `.env.example` behaves like no config.
- Persistence is flat JSON files in `backend/`, not a database: `deals.json` (all deals),
  `runtime_settings.json` (bot token + bot profile set via the admin API, intentionally
  separate from `.env` so it can be edited at runtime), `admin_group.json` (bound admin
  notification group), `user_chats.json` (chat_id per Telegram user, populated on first
  bot contact, used to DM both parties on status changes).
- `runtime_settings.json` bot token takes precedence over `BOT_TOKEN` in `.env` — the
  admin panel writes here, `getBotToken()`/`getBotProfile()` read from here first.

### Auth model
Three ways a request gets a `req.tgUser` (see `auth()` around server.js:432):
1. `X-Telegram-Init-Data` header (or `initData`/`initDataB64`/`auth` query params) —
   validated by `validateInitData` against the Telegram WebApp HMAC scheme.
2. `X-Auth-Token` header (or `token` query param) — a session token minted by
   `issueToken()` after a successful `validateWidgetAuth` (Telegram Login Widget), HMAC
   signed with the bot token, 30-day expiry.
Admin-only routes additionally require the caller's id/username to be in `ADMIN_IDS`
(`isAdminCheck`/`adminOnly`). A few admin-runtime endpoints instead trust `isLocalRequest`
(loopback) so the local `?admin=1` screen works without a token.

### Deal state machine
Status transitions are whitelisted in the `TRANSITIONS` map (server.js:883): `new` →
`cancelled`; `paid` → `fulfilled`/`dispute`; `fulfilled` → `completed`/`dispute`. Note
`paid` is intentionally unreachable from client-submitted status changes — it is only
ever set by a payment webhook or an admin's manual `mark-paid`, since the server never
trusts the client for money-moving transitions. Amount, fee, and total are always
recomputed server-side on deal creation; never trust client-submitted amounts.

### Payment gateways
Each gateway has a `create*Invoice(deal)` function and (except Bitpapa) a webhook
handler: xRocket (`createXRocketInvoice` + raw-body signature-verified
`/webhook/xrocket`), PGon/NicePay/RuKassa (`create{Pgon,Nicepay,Rukassa}Invoice`, all
funneled through the shared `gatewayWebhook(provider)` factory mounted at
`/webhook/pgon|nicepay|rukassa`, gated by a `?secret=WEBHOOK_SECRET` query param and
amount reconciliation). Bitpapa has no webhook/API auto-verification wired up by
default — the buyer submits a claim (`/api/deals/:id/bitpapa-claim`) and an admin
confirms manually via `/api/deals/:id/mark-paid` (or `verifyBitpapaTransfer` if a
`BITPAPA_API_TOKEN` is configured). Seller payout on `completed` goes through
`payoutSeller(deal)`.

### Telegram bot
Runs long-polling (`botLoop`, no public URL required) in the same Node process as the
HTTP API — there's no separate bot process to manage. Handles commands (`/start`,
`/app`, `/post`, `/deal`, `/support`, `/admin`, `/group`), inline queries (deal template
sharing via `@bot <query>`), and callback queries (template-based deal creation buttons).
`/group` binds the current Telegram group as the admin notification target
(`registerAdminGroup`), used for dispute/support/manual-payment alerts.

### Static serving
`server.js` also serves the repo root as static files (`app.use(express.static(...))`
near the bottom of the file), so the same Express process can host both the API and the
Mini App frontend — this is what "auto" `API_URL` on the same origin relies on.