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
  const seen = new Set(hist.travel.map(t=>t.id).concat(hist.buys.map(b=>b.id)));

  let newTravel=[],newBuys=[];
  const PAGE_LIMIT = backfill ? 8 : 5; // pages per invocation (throttled ~700ms each, stay under 10s)
  const THROTTLE = 650;
  let pages=0, newestTs=hist.lastTs, oldestReached=false;

  // For backfill we page BACKWARD from the cursor (oldest seen so far).
  // For normal sync we page from newest until we hit lastTs.
  let to = backfill ? (hist.backfillCursor||null) : null;

  while(pages<PAGE_LIMIT){
    const url='https://api.torn.com/v2/user/log?key='+encodeURIComponent(KEY)+'&limit=100'+(to?'&to='+to:'');
    const r=await fetch(url,{headers:{'User-Agent':'Sumbawamba/1.0'}});
    const j=await r.json();
    if(j.error) throw new Error('Torn API: '+j.error.error);
    const log=j.log||[];
    if(!log.length){ oldestReached=true; break; }
    let hitOld=false;
    for(const e of log){
      if(e.timestamp>newestTs) newestTs=e.timestamp;
      // In normal (non-backfill) mode, stop when we reach already-stored entries
      if(!backfill && e.timestamp<=hist.lastTs){ hitOld=true; continue }
      const t=e.details&&e.details.title, d=e.data||{};
      if(t==='Travel depart'){
        const dur=d.duration||0;
        if(!seen.has(e.id)){newTravel.push({id:e.id,ts:e.timestamp,area:d.destination!==1?d.destination:d.origin,duration:dur,method:d.travel_method||''});seen.add(e.id)}
      }else if(t==='Item abroad buy'){
        if(!seen.has(e.id)){newBuys.push({id:e.id,ts:e.timestamp,item:d.item,qty:d.quantity,costEach:d.cost_each,area:d.area});seen.add(e.id)}
      }
    }
    to=Math.min(...log.map(e=>e.timestamp))-1;
    pages++;
    if(!backfill && hitOld){ break }
    if(log.length<100){ oldestReached=true; break } // last page
    await new Promise(r=>setTimeout(r,THROTTLE));
  }

  // Merge
  hist.travel = newTravel.concat(hist.travel).sort((a,b)=>b.ts-a.ts).slice(0,20000);
  hist.buys = newBuys.concat(hist.buys).sort((a,b)=>b.ts-a.ts).slice(0,20000);
  if(newestTs>hist.lastTs) hist.lastTs = newestTs;

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

  hist.updated = Math.floor(Date.now()/1000);
  await store.setJSON('history',hist);
  return {
    added:{travel:newTravel.length,buys:newBuys.length,stocks:newStocks},
    total:{travel:hist.travel.length,buys:hist.buys.length,stocks:hist.stocks.length},
    backfillDone:hist.backfillDone, backfillMore:(backfill && !hist.backfillDone),
    updated:hist.updated
  };
}

export default async (req) => {
  const KEY = process.env.TORN_FULL_KEY;
  if(!KEY) return new Response(JSON.stringify({error:'No TORN_FULL_KEY env var set'}),{status:500,headers:{'Content-Type':'application/json'}});

  let scheduled=false;
  try{ if(req.body){ const b=await req.clone().json().catch(()=>null); if(b&&b.next_run) scheduled=true; } }catch(e){}

  const SECRET = process.env.SYNC_SECRET;
  let params={};
  try{ const u=new URL(req.url); params.reset=u.searchParams.get('reset')==='1'; params.backfill=u.searchParams.get('backfill')==='1'; params.secret=u.searchParams.get('secret'); }catch(e){}

  if(!scheduled && SECRET){
    if(params.secret!==SECRET){
      return new Response(JSON.stringify({error:params.secret?'Invalid sync secret':'Sync secret required'}),{status:params.secret?403:401,headers:{'Content-Type':'application/json'}});
    }
  }

  try{
    const result = await doSync(KEY, {reset:params.reset, backfill:params.backfill});
    return new Response(JSON.stringify({ok:true,reset:!!params.reset,...result}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:String(e.message||e)}),{status:502,headers:{'Content-Type':'application/json'}});
  }
};

export const config = { schedule: '0 */6 * * *' };
