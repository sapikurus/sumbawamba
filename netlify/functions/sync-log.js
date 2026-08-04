// Netlify Function: sync-log
// Pulls Torn activity log + stock transactions (server-side, full key from env)
// and stores parsed travel + item-buy + stock events to Netlify Blobs.
// Supports resumable deep backfill (chunked) to pull FULL history without hitting
// the 10s function timeout. Scheduled every 6h tops up. Manual requires SYNC_SECRET.
import { getStore } from '@netlify/blobs';

async function doSync(KEY, opts){
  const { reset=false, backfill=false } = opts||{};
  const store = getStore('sumbawamba');
  let hist;
  if(reset){ hist=null }
  else{ try{ hist = await store.get('history',{type:'json'}) }catch(e){ hist=null } }
  if(!hist) hist = {travel:[],buys:[],stocks:[],lastTs:0,lastStockTs:0,updated:0,backfillCursor:null,backfillDone:false};
  if(!hist.stocks) hist.stocks=[];
  if(hist.backfillCursor===undefined) hist.backfillCursor=null;
  if(hist.syncCursor===undefined) hist.syncCursor=null;
  const seen = new Set(hist.travel.map(t=>t.id).concat(hist.buys.map(b=>b.id)));

  let newTravel=[],newBuys=[];
  // Aggressive backfill: many pages per invocation with light throttle.
  // Torn allows ~100 req/min. At 350ms/page = ~170/min sustained, but we only
  // run short bursts per invocation then pause, keeping the average safe.
  // sync-log is a SYNCHRONOUS Netlify function — hard 10s timeout. Exceeding it means the
  // function dies and NOTHING is written. Keep each invocation short and rely on the
  // resumable gap cursor (plus the app's auto-continue) to scan deep across several runs.
  const PAGE_LIMIT = backfill ? 18 : 8;
  const THROTTLE = backfill ? 350 : 300;
  const TIME_BUDGET_MS = backfill ? 13*60*1000 : 6500; // leave headroom under the 10s cap
  const startedAt = Date.now();
  let pages=0, newestTs=hist.lastTs, oldestReached=false, reachedKnown=false;

  // For backfill we page BACKWARD from the cursor (oldest seen so far).
  // For normal sync we start at the newest page (to catch brand-new entries), then, if a
  // previous run ended without connecting to known data, jump to that gap cursor and keep
  // filling backward from there.
  let to = backfill ? (hist.backfillCursor||null) : null;
  const gapCursor = (!backfill && hist.syncCursor) ? hist.syncCursor : null;
  let jumpedToGap=false;

  while(pages<PAGE_LIMIT){
    const url='https://api.torn.com/v2/user/log?key='+encodeURIComponent(KEY)+'&limit=100'+(to?'&to='+to:'');
    const r=await fetch(url,{headers:{'User-Agent':'Sumbawamba/1.0'}});
    const j=await r.json();
    if(j.error) throw new Error('Torn API: '+j.error.error);
    const log=j.log||[];
    if(!log.length){ oldestReached=true; break; }
    // Dedupe by entry ID (authoritative). Timestamps are NOT used to decide what's new —
    // a reset backfill pins lastTs to the rebuild moment, which used to make the sync skip
    // everything after it. Counting new IDs per page makes this self-healing.
    let newOnPage=0;
    for(const e of log){
      if(e.timestamp>newestTs) newestTs=e.timestamp;
      const t=e.details&&e.details.title, d=e.data||{};
      if(t==='Travel depart'){
        if(!seen.has(e.id)){newTravel.push({id:e.id,ts:e.timestamp,area:d.destination,origin:d.origin,duration:d.duration||0,method:d.travel_method||''});seen.add(e.id);newOnPage++}
      }else if(t==='Item abroad buy'){
        if(!seen.has(e.id)){newBuys.push({id:e.id,ts:e.timestamp,item:d.item,qty:d.quantity,costEach:d.cost_each,area:d.area});seen.add(e.id);newOnPage++}
      }
      // Track how far back this page reached relative to what we already have
      if(!backfill && e.timestamp<=hist.lastTs) reachedKnown=true;
    }
    to=Math.min(...log.map(e=>e.timestamp))-1;
    pages++;
    // After the first (newest) page, jump to an unfinished gap if one was recorded.
    if(!backfill && gapCursor && !jumpedToGap){ to=gapCursor; jumpedToGap=true; reachedKnown=false; }
    // Normal sync: stop once we're into already-known territory AND this page added
    // nothing new. Requiring both means a stale lastTs can't cause us to stop early.
    else if(!backfill && reachedKnown && newOnPage===0){ break }
    if(log.length===0){ oldestReached=true; break }
    // Wall-clock guard: bail out cleanly before the platform kills us, so what we've
    // gathered still gets saved and the gap cursor lets the next run continue.
    if(Date.now()-startedAt > TIME_BUDGET_MS) break;
    await new Promise(r=>setTimeout(r,THROTTLE));
  }

  // Merge
  hist.travel = newTravel.concat(hist.travel).sort((a,b)=>b.ts-a.ts).slice(0,20000);
  hist.buys = newBuys.concat(hist.buys).sort((a,b)=>b.ts-a.ts).slice(0,20000);

  // CRITICAL: only advance lastTs if this scan actually connected back to data we already
  // had. Advancing after an incomplete scan leaves the unscanned middle permanently
  // skipped — which is what made same-day trips vanish no matter how often you refreshed.
  if(!backfill){
    if(reachedKnown || oldestReached){
      if(newestTs>hist.lastTs) hist.lastTs = newestTs;
      hist.syncCursor = null;          // gap closed
    }else{
      hist.syncCursor = to;            // resume here next run; leave lastTs untouched
    }
  }

  // Track backfill progress
  if(backfill){
    hist.backfillCursor = to;
    if(oldestReached){ hist.backfillDone=true; hist.backfillCursor=null; }
  }

  // Stock transactions (only on normal sync / first backfill call to save time)
  let newStocks=0;
  if(!backfill || reset){
    await new Promise(r=>setTimeout(r,THROTTLE));
    try{
      const sr=await fetch('https://api.torn.com/v2/user/stocks?key='+encodeURIComponent(KEY),{headers:{'User-Agent':'Sumbawamba/1.0'}});
      const sj=await sr.json();
      const seenStock=new Set(hist.stocks.map(s=>s.txId));
      let newestStock=hist.lastStockTs||0, added=[];
      for(const st of (sj.stocks||[])){
        if(Array.isArray(st.transactions)){
          for(const tx of st.transactions){
            if(tx.timestamp>newestStock)newestStock=tx.timestamp;
            const txId=String(tx.id);
            if(!seenStock.has(txId)){added.push({txId,stockId:st.id,shares:tx.shares,price:tx.price,ts:tx.timestamp});seenStock.add(txId)}
          }
        }
      }
      hist.stocks=added.concat(hist.stocks).sort((a,b)=>b.ts-a.ts).slice(0,10000);
      hist.lastStockTs=newestStock;newStocks=added.length;
    }catch(e){}
  }

  // --- 3. Daily stats snapshot (networth, battle, work) for growth charts ---
  // Only snapshot once per calendar day (GMT) to avoid bloating the series.
  if(!backfill){
    try{
      if(!hist.stats) hist.stats=[];
      const today=new Date();const dayKey=today.getUTCFullYear()+'-'+String(today.getUTCMonth()+1).padStart(2,'0')+'-'+String(today.getUTCDate()).padStart(2,'0');
      const already=hist.stats.length&&hist.stats[hist.stats.length-1].day===dayKey;
      // Travel data is the priority — skip the optional stats snapshot if we're low on time.
      if(!already && Date.now()-startedAt < 7500){
        await new Promise(r=>setTimeout(r,THROTTLE));
        // networth + work stats from personalstats; battle stats from battlestats
        const [psR,bsR]=await Promise.all([
          fetch('https://api.torn.com/v2/user/personalstats?cat=all&key='+encodeURIComponent(KEY),{headers:{'User-Agent':'Sumbawamba/1.0'}}).then(r=>r.json()).catch(()=>null),
          fetch('https://api.torn.com/v2/user/battlestats?key='+encodeURIComponent(KEY),{headers:{'User-Agent':'Sumbawamba/1.0'}}).then(r=>r.json()).catch(()=>null)
        ]);
        const ps=(psR&&psR.personalstats)||{};
        const bs=(bsR&&bsR.battlestats)||bsR||{};
        const nw=ps.networth||{};
        const js=(ps.jobs&&ps.jobs.stats)||{};
        const bv=k=>(bs[k]&&typeof bs[k]==='object'?bs[k].value:bs[k])||0;
        const snap={
          day:dayKey, ts:Math.floor(Date.now()/1000),
          networth: nw.total!=null?nw.total:0,
          nw_bank:nw.bank||0, nw_stocks:nw.stock_market||0, nw_inventory:nw.inventory||0,
          nw_points:nw.points||0, nw_cayman:nw.overseas_bank||0, nw_wallet:nw.wallet||0,
          str:bv('strength'), def:bv('defense'), spd:bv('speed'), dex:bv('dexterity'),
          bat_total:bv('strength')+bv('defense')+bv('speed')+bv('dexterity'),
          work_manual:js.manual||0, work_int:js.intelligence||0, work_end:js.endurance||0
        };
        hist.stats.push(snap);
        if(hist.stats.length>800)hist.stats=hist.stats.slice(-800); // ~2yr of daily
      }
    }catch(e){}
  }

  hist.updated = Math.floor(Date.now()/1000);
  await store.setJSON('history',hist);
  return {
    added:{travel:newTravel.length,buys:newBuys.length,stocks:newStocks},
    total:{travel:hist.travel.length,buys:hist.buys.length,stocks:hist.stocks.length},
    backfillDone:hist.backfillDone, backfillMore:(backfill && !hist.backfillDone),
    gapRemaining:!!hist.syncCursor, pagesScanned:pages,
    updated:hist.updated
  };
}

export default async (req) => {
  // Key from URL param (in-app key, not stored) OR env var (if configured for scheduled runs)
  let paramKey=null;
  try{ paramKey=new URL(req.url).searchParams.get('key') }catch(e){}
  const KEY = paramKey || process.env.TORN_FULL_KEY;
  if(!KEY) return new Response(JSON.stringify({error:'No API key provided'}),{status:500,headers:{'Content-Type':'application/json'}});

  let params={};
  try{ const u=new URL(req.url); params.reset=u.searchParams.get('reset')==='1'; params.backfill=u.searchParams.get('backfill')==='1'; }catch(e){}
  // No secret gate: the Torn API key passed per-request is the credential.

  try{
    const result = await doSync(KEY, {reset:params.reset, backfill:params.backfill});
    return new Response(JSON.stringify({ok:true,reset:!!params.reset,...result}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:String(e.message||e)}),{status:502,headers:{'Content-Type':'application/json'}});
  }
};

// NOTE: deliberately NOT a scheduled function. Netlify blocks direct HTTP invocation of
// scheduled functions with 403, which broke the app's manual "Refresh & Sync". The app
// supplies the API key per-request, so scheduled runs couldn't authenticate anyway.
