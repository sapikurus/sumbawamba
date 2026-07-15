# 🎰 Sumbawamba — Torn City Helper

A single-page personal helper app for [Torn City](https://www.torn.com). Tracks your stats growth, scores stock signals from backtested indicators, analyses travel/trading profit, and finds museum set opportunities.

**Your API key never leaves your own browser + your own Netlify deployment.** Nothing is hardcoded, nothing is shared with anyone else.

---

## ✨ What's inside

| Tab | What it does |
|-----|--------------|
| **📊 Dashboard** | Your real historical growth charts — net worth, battle stats (all 4 overlaid), work stats. Pulled from Torn's own historical data, with hover tooltips and axis labels. |
| **📈 Stock Trader** | Backtested 0–100 signal score (STRONG BUY / BUY / WATCH / HOLD) with target & stop levels, benefit/dividend progress, and a clustered portfolio with per-transaction detail. |
| **✈️ Travel** | Calendar-period browser (day/week/month/year, GMT) with destinations, most-bought items, profit breakdown, and an expandable flight log with per-trip item profit (auto-detects NPC vs market sell). |
| **🎯 Bounty Scout** | Bounty targets filtered by Fair Fight rating (needs an FFScouter key). |
| **🏛️ Museum** | Which point-earning sets you can complete from your inventory, with point value vs market value vs buy cost, and a profitability %. |
| **⚡ Energy Calc** | Optimal energy drink combinations, cooldown-aware. |

### About the stock signals

The scoring engine was **backtested on ~33,000 trades** (1000 days × 35 stocks). Score maps to real historical 7-day-hold win rates:

| Label | Score | Historical win rate |
|-------|-------|--------------------|
| STRONG BUY | 75+ | ~64% |
| BUY | 55–74 | ~62% |
| WATCH | 40–54 | ~57% |
| HOLD | <40 | ~45% (avoid) |

*Past performance ≠ future results. This is a personal tool, not financial advice — and it's a browser game.*

---

## 🚀 Deploy your own copy

**You must deploy your own instance.** Don't use someone else's URL — the travel history is stored in a single Netlify Blob per deployment, so multiple people on one deployment would overwrite each other's data.

### 1. Get the code

Fork this repo on GitHub, or clone and push to your own repo:

```bash
git clone https://github.com/YOUR_USERNAME/sumbawamba.git
cd sumbawamba
```

### 2. Deploy to Netlify

1. Sign up at [netlify.com](https://netlify.com) (free tier is plenty)
2. **Add new site** → **Import an existing project** → **GitHub** → pick your `sumbawamba` repo
3. Leave the build settings as-is — `netlify.toml` handles it
4. Deploy

That's it. No environment variables needed.

### 3. Enter your keys in the app

Open your deployed site. In the header there are two input boxes:

- **First box** → your **Torn API key** (create one at [torn.com/preferences.php#tab=api](https://www.torn.com/preferences.php#tab=api))
- **Second box** → your **FFScouter key** (optional — only used by Bounty Scout)

Keys are saved to your browser's localStorage. They stay on your device.

### 4. Build your travel history (one-time)

Travel → **⚙ Advanced** → **🗑 Reset & Rebuild Full History**

This runs a background function on *your* Netlify that walks your entire Torn activity log and stores your trips + purchases. It runs server-side, so you can close the tab. If it pauses at the 15-minute function limit, just tap **▶ Resume Backfill** to continue.

---

## 🔑 API key requirements

Use a **Full Access** key. The app reads:

- `user/battlestats`, `user/personalstats` — dashboard stats & history
- `user/stocks`, `torn/stocks` — portfolio & signals
- `user/log` — travel history (⚠️ **requires Full Access**)
- `user/inventory`, `torn/items`, `market/pointsmarket` — museum
- `user/bars`, `user/cooldowns` — energy calc

If you only want the stock/dashboard features, a Limited key covers most of it — but the Travel tab needs Full Access for the activity log.

---

## 🔒 Privacy & security

- **No key is hardcoded anywhere** in this repo — verified.
- Your key lives in **your browser's localStorage** only.
- When the Travel tab syncs, your key is passed to **your own** Netlify function over HTTPS (your deployment, your server) and is **never stored** there.
- The travel history Blob lives in **your** Netlify account.
- There is no analytics, no tracking, no third-party data sharing.

**⚠️ If you fork this and make it public, check your own git history for accidentally committed keys before publishing.**

---

## 🏗️ Architecture

```
index.html                          # The entire app (single file)
netlify/
  functions/
    sync-log.js                     # Incremental log sync (+ scheduled every 6h)
    get-history.js                  # Reads stored history from Blobs (no Torn call)
    backfill-background.js          # Full-history deep pull (15-min background function)
netlify.toml                        # Netlify config
package.json                        # @netlify/blobs dependency
```

**Data flow:** Most tabs call the Torn API directly from your browser with your key. The Travel tab is different — because Torn's activity log is long and rate-limited, a Netlify function pulls it server-side and stores the parsed result in a Netlify Blob. Opening the Travel tab then reads that Blob instantly with zero Torn calls.

### Optional: automatic background sync

By default everything is triggered by you. If you'd like the travel history and stats to refresh automatically every 6 hours (even when you're not using the app), add an environment variable in Netlify:

**Site configuration → Environment variables → Add:**
- `TORN_FULL_KEY` = your full API key

Then redeploy. The scheduled sync in `sync-log.js` will use it. Leave it unset if you prefer zero background activity — the app works fine either way.

---

## 🐛 Notes & known limitations

- **Drug purchases abroad** (Xanax etc.) may show the wrong country — Torn's API reports a single default vendor country for multi-country items. Flowers, plushies, and single-source contraband are always correct.
- **Dashboard history** takes ~90 seconds to build on first load each day (it fetches one API call per stat per date, throttled to respect rate limits), then it's cached for 24 hours and instant.
- **Museum buy cost** shows N/A when any item in a set has no fixed shop price (arrowheads, fossils, meteorites) rather than showing a misleading partial total.
- Torn's rate limit is ~100 requests/minute. All bulk operations are throttled to stay under it.

---

## 📄 License

Personal project, use it however you like. Not affiliated with Torn or Chedburn Enterprises.
