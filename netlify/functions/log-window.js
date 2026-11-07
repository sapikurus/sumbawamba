// Netlify Function: log-window
// READ-ONLY diagnostic. Pages the Torn user log from newest backwards and returns every
// entry whose timestamp falls in [from, to], with its raw title/data/text. Writes nothing
// to the store, so it cannot disturb the stored history.
// Usage: /.netlify/functions/log-window?key=APIKEY&from=UNIX&to=UNIX&pages=12
// If the key param is omitted, falls back to TORN_FULL_KEY.

export default async (req) => {
  const json = (obj, status=200) => new Response(JSON.stringify(obj, null, 2), {status, headers:{'Content-Type':'application/json'}});
  let u;
  try { u = new URL(req.url); } catch(e) { return json({error:'bad url'}, 400); }
  const KEY = u.searchParams.get('key') || process.env.TORN_FULL_KEY;
  if(!KEY) return json({error:'No API key provided'}, 500);

  const from = Number(u.searchParams.get('from') || 0);
  const to = Number(u.searchParams.get('to') || Math.floor(Date.now()/1000));
  const maxPages = Math.min(Number(u.searchParams.get('pages') || 12), 18);
  const startedAt = Date.now();

  const found = [];
  const titles = {};
  let cursor = null;     // page backwards using the oldest timestamp seen so far
  let pages = 0, reachedFrom = false, lastErr = null;

  try {
    while (pages < maxPages && Date.now() - startedAt < 8000) {
      const url = 'https://api.torn.com/v2/user/log?key=' + encodeURIComponent(KEY) + '&limit=100' + (cursor ? '&to=' + cursor : '');
      const r = await fetch(url, {headers:{'User-Agent':'Sumbawamba/1.0'}});
      const j = await r.json();
      if (j.error) { lastErr = j.error.error; break; }
      const log = j.log || [];
      pages++;
      if (!log.length) { reachedFrom = true; break; }
      let oldest = Infinity;
      for (const e of log) {
        const t = e.details && e.details.title;
        titles[t] = (titles[t] || 0) + 1;
        if (e.timestamp >= from && e.timestamp <= to) {
          found.push({id:e.id, ts:e.timestamp, title:t, data:e.data||{}, text:e.text||null});
        }
        if (e.timestamp < oldest) oldest = e.timestamp;
      }
      if (oldest <= from) { reachedFrom = true; break; }
      if (oldest === Infinity || (cursor && oldest >= cursor)) break; // no progress guard
      cursor = oldest;
      await new Promise(res => setTimeout(res, 350));
    }
  } catch(e) { lastErr = String(e.message || e); }

  found.sort((a,b) => b.ts - a.ts);
  const seenIds = new Set();
  const unique = found.filter(x => (seenIds.has(x.id) ? false : (seenIds.add(x.id), true)));

  return json({
    ok: !lastErr,
    error: lastErr,
    window: {from, to},
    pagesScanned: pages,
    reachedFrom,
    oldestScanned: cursor,
    entriesInWindow: unique.length,
    titlesSeen: titles,
    entries: unique
  });
};
