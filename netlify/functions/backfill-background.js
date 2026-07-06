// Netlify BACKGROUND Function (up to 15 min runtime).
// Runs the ENTIRE historical backfill server-side in one invocation — no browser
// loop needed. Trigger once; it keeps pulling until it reaches the start of your log.
// Filename MUST end in -background.js for Netlify to treat it as a background function.
import { getStore } from '@netlify/blobs';

const AREA_MAP={1:'Torn',2:'Mexico',3:'Cayman Islands',4:'Canada',5:'Hawaii',6:'China',7:'Argentina',8:'Switzerland',9:'Japan',10:'UAE',11:'United Kingdom',12:'South Africa'};

export default async (req) => {
  const KEY = process.env.TORN_FULL_KEY;
  const SECRET = process.env.SYNC_SECRET;
  if(!KEY) return new Response('No TORN_FULL_KEY',{status:500});

  let params={};
  try{ const u=new URL(req.url); params.secret=u.searchParams.get('secret'); params.reset=u.searchParams.get('reset')==='1'; }catch(e){}
  if(SECRET && params.secret!==SECRET) return new Response('bad secret',{status:403});

  const store = getStore('sumbawamba');
  let hist;
  if(params.reset){ hist=null } else { try{ hist=await store.get('history',{type:'json'}) }catch(e){ hist=null } }
  if(!hist) hist={travel:[],buys:[],stocks:[],lastTs:0,lastStockTs:0,updated:0,backfillCursor:null,backfillDone:false,backfillRunning:false};
  if(!hist.stocks) hist.stocks=[];

  // Mark running so the UI can show status
  hist.backfillRunning=true; hist.backfillError=null;
  await store.setJSON('history',hist);

  const seen=new Set(hist.travel.map(t=>t.id).concat(hist.buys.map(b=>b.id)));
  let to = params.reset ? null : (hist.backfillCursor||null);
  const THROTTLE=400, MAX_MS=13*60*1000; // stop before 15min hard limit
  const startedAt=Date.now();
  let totalPages=0, saveEvery=10, sinceSave=0;

  try{
    while(true){
      if(Date.now()-startedAt > MAX_MS){ break } // time budget guard
      const url='https://api.torn.com/v2/user/log?key='+encodeURIComponent(KEY)+'&limit=100'+(to?'&to='+to:'');
      const r=await fetch(url,{headers:{'User-Agent':'Sumbawamba/1.0'}});
      const j=await r.json();
      if(j.error){
        // Rate limited or other — wait and retry a few times
        await new Promise(res=>setTimeout(res,3000));
        continue;
      }
      const log=j.log||[];
      if(log.length===0){ hist.backfillDone=true; hist.backfillCursor=null; break; }
      for(const e of log){
        if(e.timestamp>hist.lastTs) hist.lastTs=e.timestamp;
        const t=e.details&&e.details.title, d=e.data||{};
        if(t==='Travel depart'){
          if(!seen.has(e.id)){hist.travel.push({id:e.id,ts:e.timestamp,area:d.destination!==1?d.destination:d.origin,duration:d.duration||0,method:d.travel_method||''});seen.add(e.id)}
        }else if(t==='Item abroad buy'){
          if(!seen.has(e.id)){hist.buys.push({id:e.id,ts:e.timestamp,item:d.item,qty:d.quantity,costEach:d.cost_each,area:d.area});seen.add(e.id)}
        }
      }
      to=Math.min(...log.map(e=>e.timestamp))-1;
      hist.backfillCursor=to;
      totalPages++; sinceSave++;
      // Periodically persist progress so the UI reflects it and nothing is lost
      if(sinceSave>=saveEvery){
        hist.travel.sort((a,b)=>b.ts-a.ts); hist.buys.sort((a,b)=>b.ts-a.ts);
        hist.updated=Math.floor(Date.now()/1000);
        await store.setJSON('history',hist);
        sinceSave=0;
      }
      await new Promise(res=>setTimeout(res,THROTTLE));
    }
  }catch(e){
    hist.backfillError=String(e.message||e);
  }

  hist.travel.sort((a,b)=>b.ts-a.ts).splice(30000);
  hist.buys.sort((a,b)=>b.ts-a.ts).splice(30000);
  hist.backfillRunning=false;
  hist.updated=Math.floor(Date.now()/1000);
  await store.setJSON('history',hist);
  return new Response(JSON.stringify({ok:true,pages:totalPages,done:hist.backfillDone,travel:hist.travel.length,buys:hist.buys.length}),{headers:{'Content-Type':'application/json'}});
};
