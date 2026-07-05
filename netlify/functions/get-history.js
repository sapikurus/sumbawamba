// Netlify Function: get-history
// Returns the stored travel/buy history JSON to the app. No Torn API call.
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const store = getStore('sumbawamba');
  let hist;
  try{ hist = await store.get('history',{type:'json'}) }catch(e){ hist=null }
  if(!hist) hist = {travel:[],buys:[],lastTs:0,updated:0};
  return new Response(JSON.stringify(hist),{headers:{'Content-Type':'application/json','Cache-Control':'no-cache'}});
};
