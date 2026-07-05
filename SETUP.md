# Sumbawamba — Netlify Setup

## Repo structure
```
index.html                          ← the app (rename from sumbawamba_torn_helper.html)
netlify.toml
package.json
netlify/functions/sync-log.js
netlify/functions/get-history.js
```
Drop this whole folder into your Netlify project (drag to Netlify, or push to your connected repo).

## One-time setup (Netlify dashboard → Site settings → Environment variables)

Add TWO environment variables:

1. **`TORN_FULL_KEY`** = your full-access Torn API key.
   - This is the ONLY place your full key lives. It never appears in the HTML and is never sent to the browser.

2. **`SYNC_SECRET`** = any password you make up (e.g. `mytornsync99`).
   - Protects the manual "Sync Log Now" button so random visitors can't trigger your Torn API calls.
   - You'll enter this once in the app (per device); it's stored locally in your browser after that.

Then deploy. Netlify auto-installs `@netlify/blobs` and enables Blobs storage.

## How it works
- **sync-log.js** — runs automatically every 6 hours (scheduled). Pulls your Torn log + stock transactions ONCE server-side, stores parsed travel/buys/stocks to Netlify Blobs. Manual runs (the button) require SYNC_SECRET.
- **get-history.js** — the app reads stored history from here. NO Torn API call → refreshing the app never hits Torn's rate limit.

## Rotating your full key later
Change `TORN_FULL_KEY` in the Netlify dashboard → redeploy (or wait for next scheduled run). **Never edit the HTML.**  
(There is no in-app field for the full key by design — an in-browser field would expose it publicly.)

## Sharing with a friend
Share the FILES (this folder), not your site. Your friend deploys his own Netlify copy with HIS OWN `TORN_FULL_KEY` and `SYNC_SECRET`. Each person runs a private instance — no key sharing, no mixed data.

## The two keys
| Key | Where | Used for |
|-----|-------|----------|
| Limited key | app input box (browser) | live stocks/bounties/travel/prices |
| Full key | Netlify env var only | scheduled/manual log sync (server-side) |
| Sync secret | Netlify env var + entered once in-app | authorises the manual sync button |
