// Netlify Function: sync-log
// Pulls Torn activity log + stock transactions (server-side, full key from env)
// and stores parsed travel + item-buy + stock events to Netlify Blobs.
// Scheduled every 6h. Manual runs require the SYNC_SECRET (passed as ?secret=).
import { getStore } from '@netlify/blobs';

const AREA_BY_BIZMIN = {
  18:'Mexico',26:'Canada',25:'Cayman Islands',85:'Hawaii',107:'United Kingdom',
  118:'Switzerland',134:'Argentina',63:'Japan',169:'China',71:'UAE',148:'South Africa'
};
function nearestCountry(mins){
  let best=null,bd=1e9;
  for(const[m,c]of Object.entries(AREA_BY_BIZMIN)){const d=Math.abs(+m-mins);if(d<bd){bd=d;best=c}}
  return bd<=25?best:('Area '+mins+'m');
}

async function doSync(KEY){
  const store = getStore('sumbawamba');
  let hist;
  try{ hist = await store.get('history',{type:'json'}) }catch(e){ hist=null }
  if(!hist) hist = {travel:[],buys:[],stocks:[],lastTs:0,lastStockTs:0,updated:0};
  if(!hist.stocks) hist.stocks=[];
  const seen = new Set(hist.travel.map(t=>t.id).concat(hist.buys.map(b=>b.id)));

  // --- 1. Activity log (travel + abroad buys) ---
  let newTravel=[],newBuys=[],to=null,pages=0,maxPages=10,newestTs=hist.lastTs;
  while(pages<maxPages){
    const url='https://api.torn.com/v2/user/log?key='+encodeURIComponent(KEY)+'&limit=100'+(to?'&to='+to:'');
    const r=await fetch(url,{headers:{'User-Agent':'Sumbawamba/1.0'}});
    const j=await r.json();
    if(j.error) throw new Error('Torn API: '+j.error.error);
    const log=j.log||[];
    if(!log.length) break;
    let hitOld=false;
    for(const e of log){
      if(e.timestamp>newestTs) newestTs=e.timestamp;
      if(e.timestamp<=hist.lastTs){ hitOld=true; continue }
      const t=e.details&&e.details.title, d=e.data||{};
      if(t==='Travel depart'){
        const dur=d.duration||0;
        const country=nearestCountry(Math.round(dur/60));
        if(!seen.has(e.id)){newTravel.push({id:e.id,ts:e.timestamp,country,duration:dur,method:d.travel_method||''});seen.add(e.id)}
      }else if(t==='Item abroad buy'){
        if(!seen.has(e.id)){newBuys.push({id:e.id,ts:e.timestamp,item:d.item,qty:d.quantity,costEach:d.cost_each,area:d.area});seen.add(e.id)}
      }
    }
    to=Math.min(...log.map(e=>e.timestamp))-1;
    pages++;
    if(hitOld) break;
    await new Promise(r=>setTimeout(r,700)); // throttle: stay under Torn rate limit
  }

  // --- 2. Stock transactions (from user/stocks) ---
  let newStocks=[];
  await new Promise(r=>setTimeout(r,700)); // throttle before next endpoint
  try{
    const sr=await fetch('https://api.torn.com/v2/user/stocks?key='+encodeURIComponent(KEY),{headers:{'User-Agent':'Sumbawamba/1.0'}});
    const sj=await sr.json();
    const seenStock=new Set(hist.stocks.map(s=>s.txId));
    let newestStock=hist.lastStockTs||0;
    for(const st of (sj.stocks||[])){
      if(Array.isArray(st.transactions)){
        for(const tx of st.transactions){
          if(tx.timestamp>newestStock)newestStock=tx.timestamp;
          const txId=String(tx.id);
          if(!seenStock.has(txId)){
            newStocks.push({txId,stockId:st.id,shares:tx.shares,price:tx.price,ts:tx.timestamp});
            seenStock.add(txId);
          }
        }
      }
    }
    hist.lastStockTs=newestStock;
  }catch(e){/* stocks optional */}

  hist.travel = newTravel.concat(hist.travel).slice(0,5000);
  hist.buys = newBuys.concat(hist.buys).slice(0,5000);
  hist.stocks = newStocks.concat(hist.stocks).slice(0,5000);
  hist.lastTs = newestTs;
  hist.updated = Math.floor(Date.now()/1000);
  await store.setJSON('history',hist);
  return {added:{travel:newTravel.length,buys:newBuys.length,stocks:newStocks.length},total:{travel:hist.travel.length,buys:hist.buys.length,stocks:hist.stocks.length},updated:hist.updated};
}

export default async (req) => {
  const KEY = process.env.TORN_FULL_KEY;
  if(!KEY) return new Response(JSON.stringify({error:'No TORN_FULL_KEY env var set'}),{status:500,headers:{'Content-Type':'application/json'}});

  // Detect scheduled invocation: Netlify scheduled functions send a JSON body with "next_run".
  let scheduled=false;
  try{
    if(req.body){ const b=await req.clone().json().catch(()=>null); if(b&&b.next_run) scheduled=true; }
  }catch(e){}

  // Manual HTTP calls must supply the correct secret (if one is configured).
  const SECRET = process.env.SYNC_SECRET;
  if(!scheduled && SECRET){
    let provided=null;
    try{ provided=new URL(req.url).searchParams.get('secret') }catch(e){}
    if(provided!==SECRET){
      return new Response(JSON.stringify({error:provided?'Invalid sync secret':'Sync secret required'}),{status:provided?403:401,headers:{'Content-Type':'application/json'}});
    }
  }

  try{
    const result = await doSync(KEY);
    return new Response(JSON.stringify({ok:true,...result}),{headers:{'Content-Type':'application/json'}});
  }catch(e){
    return new Response(JSON.stringify({error:String(e.message||e)}),{status:502,headers:{'Content-Type':'application/json'}});
  }
};

export const config = { schedule: '0 */6 * * *' };
