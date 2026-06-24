# Sats Arena — Backend (Lightning + LiveKit)

A small Express service that:
1. Fronts a hosted LNbits wallet for Lightning payments
2. Issues LiveKit JWTs for co-op presence/voice (key/secret never leave this server)

This folder is **isolated** from the game: it has its own `package.json`, so the
GitHub Pages build (Vite, at the repo root) never installs or bundles it.

## Endpoints
- `GET  /health` → `{ ok: true }`
- `POST /token { room, identity }` → `{ token }` — LiveKit JWT (publish + subscribe)
- `POST /session` → `{ code }` — create a 4-char Lightning session
- `GET  /session/:code` → `{ exists, paidCount }` — poll Lightning status
- `POST /session/:code/invoice` → `{ payment_hash, payment_request }` — new 21-sat invoice

## Env vars
See `.env.example`.

Required for co-op: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
Required for payments: `LNBITS_URL`, `LNBITS_INVOICE_KEY`.
Optional: `LIVEKIT_URL`, `INVOICE_AMOUNT` (default 21), `ALLOWED_ORIGIN`, `PORT`.

## Run locally
```bash
cd server
cp .env.example .env      # fill in real values
npm install
node --env-file=.env server.js
```

Test the token endpoint:
```bash
curl -s -X POST http://localhost:8080/token \
  -H 'Content-Type: application/json' \
  -d '{"room":"1234","identity":"Player1"}' | jq .
```

## Deploy
Deployed on Railway with **root directory = `server`**. Env vars are set in the
Railway dashboard (Variables tab), not committed.
