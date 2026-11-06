import {createRoot} from 'react-dom/client';
import Player from '../../src/player';
import {StreamingRehearsal} from '../../src/streaming-audio';
import {registerPitch} from '../../src/pitch-audio';
import {supabase} from '../../src/api';
import '../../src/styles.css';
const rate=48000,seconds=240,frames=rate*seconds,size=44+frames*2,files=Array.from({length:64},(_,i)=>({id:'virtual-'+i,name:'Guitar stem '+(i+1)+'.wav',path:'virtual/'+i,size,mime:'audio/wav'}));
let served=0,requests=0,fetching=0,maxFetching=0;
function header(){const bytes=new Uint8Array(44),v=new DataView(bytes.buffer),text=(p:number,t:string)=>{for(let i=0;i<t.length;i++)bytes[p+i]=t.charCodeAt(i)};text(0,'RIFF');v.setUint32(4,size-8,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,frames*2,true);return bytes}
const wavHeader=header();
function bytes(start:number,end:number,index:number){const out=new Uint8Array(end-start);for(let p=start;p<Math.min(end,44);p++)out[p-start]=wavHeader[p];const first=Math.max(44,start-(start%2));const notes=[48,52,55,53,57,60,55,59,62],midi=notes[Math.floor(((start-44)/2/rate)/2)%notes.length]||48,hz=440*2**((midi-69)/12);for(let p=first;p<end;p+=2){const sample=Math.round(Math.sin(2*Math.PI*hz*((p-44)/2)/rate)*3000),lo=sample&255,hi=(sample>>8)&255;if(p>=start)out[p-start]=lo;if(p+1<end&&p+1>=start)out[p+1-start]=hi}return out}
function fakeFetch(index:number):typeof fetch{return async(_url,init)=>{
 requests++;fetching++;maxFetching=Math.max(maxFetching,fetching);await Promise.resolve();fetching--;
 const range=new Headers(init?.headers).get('Range'),match=range?.match(/bytes=(\d+)-(\d*)/),start=match?+match[1]:0,end=match&&match[2]?Math.min(size,+match[2]+1):size;
 const body=new ReadableStream<Uint8Array>({pull(controller){if(position>=end){controller.close();return}const next=Math.min(position+32768,end),data=bytes(position,next,index);served+=data.length;position=next;controller.enqueue(data)}});
 let position=start;
 return new Response(body,{status:match?206:200,headers:{'Content-Type':'audio/wav','Content-Length':String(end-start),'Accept-Ranges':'bytes',...(match?{'Content-Range':'bytes '+start+'-'+(end-1)+'/'+size}:{})}});
}}
// Local test-only session and storage transport; no real credentials or private audio are used.
const nativeFetch=globalThis.fetch.bind(globalThis);
(supabase.auth as any).getSession=async()=>({data:{session:{access_token:'local-fixture-token'}},error:null});
globalThis.fetch=(async(input:any,init:any)=>String(input).includes('/storage/v1/object/authenticated/workshop-files/virtual/')?fakeFetch(0)(input,init):nativeFetch(input,init)) as typeof fetch;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1100,margin:'20px auto',padding:16}}><Player files={files} song="stream-fixture" save={async()=>true}/></main>);
document.getElementById('run')!.onclick=async()=>{
 const result=document.getElementById('result')!,context=new AudioContext();await context.resume();result.textContent='Preparing 64 virtual four-minute stems…';
 const engine=new StreamingRehearsal(files,file=>fakeFetch(+file.id.split('-')[1]));
 try{
 const Node=await registerPitch(context);await engine.prepare();
 if(engine.stems.length!==64)throw Error('Not all stems prepared');
 if(served>=size*64/4)throw Error('Too much audio fetched during preparation');
 const lines=['PASS: 64 full-length virtual stems prepared without whole-file PCM decoding.'];
 const starts:number[]=[];const create=context.createBufferSource.bind(context);context.createBufferSource=()=>{const source=create(),start=source.start.bind(source);source.start=((...args:any[])=>{starts.push(args[0]);return start(...args as [number,number,number])}) as typeof source.start;return source};
 engine.setMix(Object.fromEntries(files.map(f=>[f.id,{mute:true}])));
 let stalled=false,bufferEvents=0,maxPCM=0;const read=engine.stems[0].read.bind(engine.stems[0]);engine.stems[0].read=async(start,end,valid)=>{if(start>=engine.segmentSeconds&&!stalled){stalled=true;await new Promise(r=>setTimeout(r,3000))}return read(start,end,valid)};
 engine.onState=s=>{if(s.buffering)bufferEvents++;maxPCM=Math.max(maxPCM,engine.scheduledDecodedBytes())};
 void engine.play(context,Node);
 await new Promise(r=>setTimeout(r,2200));
 const frozen=context.state==='suspended',position=engine.position();
 await new Promise(r=>setTimeout(r,350));
 if(!frozen||Math.abs(engine.position()-position)>.03)throw Error('Clock did not pause for buffering');
 lines.push('PASS: slow-stem fetch pauses the shared clock; tracks cannot drift apart.');
 await new Promise(r=>setTimeout(r,2300));
 if(context.state!=='running'||!engine.isPlaying())throw Error('Playback did not resume after buffering');
 const earliest=Math.min(...starts),sameStart=starts.filter(s=>Math.abs(s-earliest)<1e-7).length;
 if(sameStart<64)throw Error('Stems were not scheduled together');
 if(maxPCM>130*1024*1024)throw Error('Scheduled PCM grew beyond the rolling budget: '+maxPCM);
 lines.push('PASS: '+sameStart+' stems scheduled on the exact same audio-clock start.');
 lines.push('PASS: peak scheduled decoded audio '+(maxPCM/1024/1024).toFixed(1)+' MB for '+(size*64/1024/1024).toFixed(0)+' MB of source audio.');
 engine.pause();engine.seek(120);if(Math.abs(engine.position()-120)>.001)throw Error('Seek failed');
 lines.push('PASS: seek uses the shared song timeline.');
 engine.dispose();await context.close();
 result.textContent=lines.join('\n')+'\nALL STREAMING CHECKS PASSED';
 }catch(e){engine.dispose();await context.close();result.textContent='FAIL: '+String(e)+'\nrequests='+requests+' served='+served+' maxFetching='+maxFetching}
};

