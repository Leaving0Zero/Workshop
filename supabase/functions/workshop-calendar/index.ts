import {calendar} from './calendar.mjs';
Deno.serve(async(req:Request)=>{
 const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
 if(!['GET','HEAD'].includes(req.method))return new Response('Method not allowed',{status:405,headers:{...headers,Allow:'GET, HEAD'}});
 const token=new URL(req.url).searchParams.get('token')||'';
 if(!/^[0-9a-f]{64}$/.test(token))return new Response('Feed not found',{status:404,headers});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
 try{
 const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!serviceKey)throw Error('Missing server configuration');
 const r=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/rpc/workshop_calendar_feed',{method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify({h:hash})});
 if(!r.ok)throw Error('Database unavailable');
 const result=await r.json();
 if(!result)return new Response('Feed not found',{status:404,headers});
 return new Response(req.method==='HEAD'?null:calendar(result.events),{headers:{...headers,'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'inline; filename="leaving-zero.ics"'}});
 }catch{return new Response('Calendar temporarily unavailable',{status:503,headers})}
});
