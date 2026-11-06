import {createClient} from '@supabase/supabase-js';
import {projectUrl,publishableKey} from './config';
export const supabase=createClient(projectUrl,publishableKey);
export async function request(body:any={}){
 const {data,error}=await supabase.rpc('workshop_request',{b:body});
 if(error)throw Error(error.message);
 if(body.action&&body.action!=='read'&&data?.pending)throw Error('Owner approval required');
 return data;
}
export async function downloadBlob(id:string){
 const state=await request();
 if(state.pending)throw Error('Owner approval required');
 const file=state.files.find((f:any)=>f.id===id);
 if(!file)throw Error('File not found');
 const {data,error}=await supabase.storage.from('workshop-files').download(file.path);
 if(error)throw Error(error.message);
 return data;
}
export async function downloadFile(id:string,name:string){
 try{const blob=await downloadBlob(id);const url=URL.createObjectURL(blob);
 const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
 }catch(e){window.alert(String(e))}
}
export async function workshopFetch(url:string,init?:RequestInit):Promise<Response>{
 try{
 if(url.includes('?file='))return new Response(await downloadBlob(new URL(url,'https://app.invalid').searchParams.get('file')!));
 if(init?.body instanceof FormData){
 const f=init.body.get('file');if(!(f instanceof File)||f.size>40*1024*1024||f.size===0)throw Error('Select a file up to 40 MB');
 const {data:{user},error}=await supabase.auth.getUser();if(error||!user)throw Error('Sign in required');
 const id=crypto.randomUUID(),path=user.id+'/'+id;
 const up=await supabase.storage.from('workshop-files').upload(path,f,{contentType:f.type,cacheControl:'0',upsert:false});
 if(up.error)throw Error(up.error.message);
 await request({action:'file',id,song:String(init.body.get('song')||'show-files'),name:f.name});
 return Response.json({id});
 }
 if(init?.method==='POST'){const body=JSON.parse(String(init.body));return Response.json(await request({...body,action:body.action||'save'}));}
 return Response.json(await request());
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to connect to the workshop'},{status:400})}
}

/** Authenticated byte-range reads: credentials remain in headers; no public/signed audio URLs. */
export async function fetchPrivateStem(file:{path:string},init?:RequestInit):Promise<Response>{
 const {data:{session},error}=await supabase.auth.getSession();
 if(error||!session)throw Error('Sign in again to stream rehearsal audio.');
 const headers=new Headers(init?.headers);
 headers.set('apikey',publishableKey);headers.set('Authorization','Bearer '+session.access_token);
 const path=file.path.split('/').map(encodeURIComponent).join('/');
 const response=await globalThis.fetch(projectUrl+'/storage/v1/object/authenticated/workshop-files/'+path,{...init,headers,cache:'no-store'});
 if(response.status===401||response.status===403){void response.body?.cancel();throw Error('Access to this stem was denied. Check your membership or sign in again.')}
 return response;
}
