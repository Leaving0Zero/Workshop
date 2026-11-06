import {useRef,useState,useEffect} from 'react';
import type {SoundTouchNode} from '@soundtouchjs/audio-worklet';
import {workshopFetch as fetch} from './api';
import {registerPitch,createPitchBus} from './pitch-audio';
import {keyName,sampleForKey,type KeyEstimate} from './key-analysis.mjs';

const bound=(value:number,min:number,max:number)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):min;
const time=(v:number)=>Math.floor(v/60)+':'+String(Math.floor(v%60)).padStart(2,'0');
type Stem={id:string;buffer:AudioBuffer};
type Channel={id:string;source:AudioBufferSourceNode;gain:GainNode;pan:StereoPannerNode};
type Loop={on:boolean;a:number;b:number};

export default function Player({files,song,save,preset}:any){
 const ctx=useRef<AudioContext|null>(null),buffers=useRef<Stem[]>([]),nodes=useRef<Channel[]>([]),master=useRef<SoundTouchNode|null>(null),pitchNode=useRef<typeof SoundTouchNode|null>(null);
 const at=useRef(0),started=useRef(0),rateRef=useRef(1),pitchRef=useRef(0),playing=useRef(false),durationRef=useRef(0),ready=useRef(false),generation=useRef(0),loopRef=useRef<Loop>({on:false,a:0,b:0}),mixRef=useRef<any>({});
 const worker=useRef<Worker|null>(null),analysisTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[duration,setDuration]=useState(0),[pos,setPos]=useState(0),[on,setOn]=useState(false),[rate,setRate]=useState(1),[pitch,setPitch]=useState(0),[mix,setMix]=useState<any>({}),[loop,setLoop]=useState<Loop>({on:false,a:0,b:0});
 const [key,setKey]=useState<KeyEstimate|null>(null),[analyzing,setAnalyzing]=useState(false),[analysisMessage,setAnalysisMessage]=useState('');

 function stopAnalysis(){worker.current?.terminate();worker.current=null;if(analysisTimer.current)clearTimeout(analysisTimer.current);analysisTimer.current=null}
 function halt(){
  nodes.current.forEach(n=>{try{n.source.stop()}catch{}n.source.disconnect();n.gain.disconnect();n.pan.disconnect()});nodes.current=[];
  if(master.current){master.current.onprocessorerror=null;master.current.disconnect();master.current.port.onmessage=null;master.current.port.close();master.current=null}
  playing.current=false;setOn(false);
 }
 function position(){return playing.current?Math.max(0,at.current+Math.max(0,(ctx.current?.currentTime||0)-started.current)*rateRef.current):at.current}
 function apply(m:any){
  mixRef.current=m;setMix(m);const solo=Object.values(m).some((t:any)=>t.solo);
  nodes.current.forEach(n=>{const t=m[n.id]||{};n.gain.gain.value=t.mute||(solo&&!t.solo)?0:bound(t.volume??.7,0,1);n.pan.pan.value=bound(t.pan??0,-1,1)});
 }
 function play(offset=at.current){
  if(!ctx.current||!ready.current||!pitchNode.current)return;
  halt();at.current=bound(offset,0,durationRef.current);
  if(at.current>=durationRef.current){at.current=0;setPos(0)}
  try{
   const bus=createPitchBus(pitchNode.current,ctx.current,pitchRef.current,rateRef.current);master.current=bus;
   bus.onprocessorerror=()=>{at.current=position();halt();setError('Audio processing stopped. Press Play to restart, or reload the song.')};
   bus.connect(ctx.current.destination);
   const when=ctx.current.currentTime+.05;started.current=when;
   const solo=Object.values(mixRef.current).some((t:any)=>t.solo);
   for(const t of buffers.current){
    if(t.buffer.duration<=at.current)continue;
    const source=ctx.current.createBufferSource(),gain=ctx.current.createGain(),pan=ctx.current.createStereoPanner(),m=mixRef.current[t.id]||{};
    source.buffer=t.buffer;source.playbackRate.value=rateRef.current;
    gain.gain.value=m.mute||(solo&&!m.solo)?0:bound(m.volume??.7,0,1);pan.pan.value=bound(m.pan??0,-1,1);
    source.connect(gain).connect(pan).connect(bus);nodes.current.push({id:t.id,source,gain,pan});source.start(when,at.current);
   }
   playing.current=true;setOn(true);setError('');
  }catch(e){halt();setError(e instanceof Error?e.message:'Unable to start audio')}
 }
 useEffect(()=>{const timer=setInterval(()=>{
  if(!playing.current)return;const p=position(),l=loopRef.current;
  if(l.on&&l.b>l.a&&p>=l.b){play(l.a);return}
  if(p>=durationRef.current+rateRef.current*.25){halt();at.current=0;setPos(0)}else setPos(Math.min(p,durationRef.current));
 },40);return()=>clearInterval(timer)},[]);
 useEffect(()=>{
  generation.current++;halt();stopAnalysis();ready.current=false;buffers.current=[];at.current=0;durationRef.current=0;setLoaded(false);setBusy(false);setDuration(0);setPos(0);setKey(null);setAnalyzing(false);setAnalysisMessage('');setError('');
  const data=preset?.data||{};
  pitchRef.current=Math.round(bound(Number(data.pitchSemitones||0),-12,12));setPitch(pitchRef.current);
  rateRef.current=bound(Number(data.speed||1),.5,1.5);setRate(rateRef.current);
  const initialLoop={on:false,a:0,b:0};loopRef.current=initialLoop;setLoop(initialLoop);apply(data.mix||{});
  return()=>{generation.current++;ready.current=false;halt();stopAnalysis();const previous=ctx.current;ctx.current=null;pitchNode.current=null;if(previous)void previous.close().catch(()=>{})};
 },[song]);

 function analyze(stems:Stem[],token:number){
  stopAnalysis();setKey(null);setAnalysisMessage('');setAnalyzing(true);
  try{
   const input=sampleForKey(stems.map(s=>s.buffer));
   const task=new Worker(new URL('./key-worker.ts',import.meta.url),{type:'module'});worker.current=task;
   const finish=(result:KeyEstimate|null,message:string)=>{if(token!==generation.current)return;stopAnalysis();setKey(result);setAnalysisMessage(message);setAnalyzing(false)};
   task.onmessage=event=>finish(event.data.result||null,event.data.error||(!event.data.result?'No reliable key found. Try stems with clear bass, guitar, keys or vocals.':''));
   task.onerror=()=>finish(null,'Key analysis could not finish. Playback is still available.');
   analysisTimer.current=setTimeout(()=>finish(null,'Key analysis timed out. You can retry without reloading the stems.'),20000);
   task.postMessage(input,[input.samples.buffer]);
  }catch{stopAnalysis();setAnalyzing(false);setAnalysisMessage('Key analysis is unavailable in this browser. Playback is still available.')}
 }
 async function load(){
  const token=++generation.current;setBusy(true);setError('');stopAnalysis();halt();ready.current=false;setLoaded(false);setKey(null);setAnalyzing(false);setAnalysisMessage('');
  try{
   const context=ctx.current||new AudioContext();ctx.current=context;await context.resume();
   pitchNode.current=await registerPitch(context);if(token!==generation.current)return;
   let bytes=0,decodedBytes=0;const decoded:Stem[]=[];
   for(const f of files){
    bytes+=f.size;if(bytes>120*1024*1024)throw Error('This song exceeds the 120 MB source limit. Upload compressed rehearsal stems.');
    const r=await fetch('/api/workshop?file='+f.id);if(token!==generation.current)return;if(!r.ok)throw Error('Access to a stem was denied');
    const buffer=await context.decodeAudioData(await r.arrayBuffer());if(token!==generation.current)return;
    decodedBytes+=buffer.length*buffer.numberOfChannels*4;
    if(decodedBytes>384*1024*1024)throw Error('These stems need too much browser memory. Use shorter or mono rehearsal stems, or fewer channels.');
    decoded.push({id:f.id,buffer});
   }
   if(!decoded.length)throw Error('Upload stems for this song first.');
   buffers.current=decoded;const d=Math.max(...decoded.map(t=>t.buffer.duration));durationRef.current=d;setDuration(d);at.current=0;setPos(0);
   const l={on:false,a:0,b:d};setLoop(l);loopRef.current=l;ready.current=true;setLoaded(true);analyze(decoded,token);
  }catch(e){if(token===generation.current){buffers.current=[];ready.current=false;setError(e instanceof Error?e.message:'Unable to load audio')}}
  finally{if(token===generation.current)setBusy(false)}
 }
 function transpose(value:number){const p=Math.round(bound(value,-12,12));pitchRef.current=p;setPitch(p);if(master.current)master.current.pitchSemitones.value=p}
 function changeRate(value:number){const p=position(),wasPlaying=playing.current;rateRef.current=bound(value,.5,1.5);setRate(rateRef.current);at.current=p;if(wasPlaying)play(p)}
 function update(id:string,field:string,value:any){apply({...mixRef.current,[id]:{...mixRef.current[id],[field]:value}})}
 function setL(l:Loop){const next={on:l.on,a:bound(l.a,0,durationRef.current),b:bound(l.b,0,durationRef.current)};setLoop(next);loopRef.current=next}
 async function toggle(){if(playing.current){at.current=position();setPos(at.current);halt()}else{const token=generation.current;try{await ctx.current?.resume();if(token===generation.current)play()}catch{setError('Unable to resume audio. Reload the song and try again.')}}}

 return <section className="mixer">
 <div className="row"><div><span className="eyebrow">REHEARSAL CONSOLE</span><h2>Your sound. Your mix.</h2></div><span className="tag">Synchronized stems</span></div>
 <p className="muted">Stems must share the same start point. Shift pitch without changing tempo, or change speed while keeping the key.</p>
 {!loaded?<button onClick={load} disabled={busy}>{busy?'Loading secure audio…':'Load secure stems'}</button>:<>
 <div className="pitch-panel"><div><span className="eyebrow">PITCH SHIFT</span><div className="pitch-controls"><button className="secondary" aria-label="Lower pitch by one semitone" disabled={pitch<=-12} onClick={()=>transpose(pitch-1)}>−</button><strong aria-live="polite">{pitch>0?'+':''}{pitch} <small>semitones</small></strong><button className="secondary" aria-label="Raise pitch by one semitone" disabled={pitch>=12} onClick={()=>transpose(pitch+1)}>＋</button><button className="textbutton" onClick={()=>transpose(0)}>Original pitch</button></div><input type="range" aria-label="Pitch shift in semitones" min="-12" max="12" step="1" value={pitch} onChange={e=>transpose(+e.target.value)}/></div>
 <div className="key-readout" aria-live="polite"><span className="eyebrow">KEY ANALYSIS</span>{analyzing?<p>Analyzing loaded stems…</p>:key?<><div className="key-pair"><div><small>Estimated original</small><strong>{keyName(key.root,key.mode)}</strong></div><span>→</span><div><small>Playback key</small><strong>{keyName(key.root,key.mode,pitch)}</strong></div></div><p className="muted">{key.match==='uncertain'?'Uncertain match — check by ear.':'Estimated key · '+key.match+' match.'} Another possibility: {keyName(key.alternative.root,key.alternative.mode)}.</p></>:<p className="muted">{analysisMessage||'Load stems to estimate the key.'}</p>}<p className="muted">Analyzed on this device from sampled audio. Relative keys, modes and key changes can be ambiguous. Your catalog key is unchanged.</p><button className="textbutton" disabled={analyzing} onClick={()=>analyze(buffers.current,generation.current)}>Analyze key again</button></div></div>
 <div className="transport"><button onClick={toggle}>{on?'Ⅱ Pause':'▶ Play'}</button><button onClick={()=>{halt();at.current=0;setPos(0)}}>■ Reset</button><strong>{time(pos)} / {time(duration)}</strong><label>Speed <select value={rate} onChange={e=>changeRate(+e.target.value)}>{[.5,.75,1,1.25,1.5].map(x=><option key={x} value={x}>{x}×</option>)}</select></label></div>
 <input aria-label="Seek" type="range" min="0" max={duration} step=".05" value={pos} onChange={e=>{at.current=+e.target.value;setPos(at.current);if(playing.current)play(at.current)}}/>
 <div className="row"><label><input type="checkbox" checked={loop.on} onChange={e=>setL({...loop,on:e.target.checked})}/> Loop</label><label>A <input type="number" min="0" max={duration} value={loop.a} onChange={e=>setL({...loop,a:+e.target.value})}/></label><label>B <input type="number" min="0" max={duration} value={loop.b} onChange={e=>setL({...loop,b:+e.target.value})}/></label></div>{loop.on&&loop.b<=loop.a&&<p className="muted">Set loop B after A to enable looping.</p>}
 </>}
 <div className="channels">{files.map((f:any,i:number)=><div className="channel" key={f.id}><span className="eyebrow">CH {String(i+1).padStart(2,'0')}</span><h3>{f.name}</h3><div className="wave">{Array.from({length:28},(_,j)=><i key={j} style={{height:8+((j*17+i*11)%37)}}/>)}</div><div className="row"><button className={mix[f.id]?.mute?'active':''} onClick={()=>update(f.id,'mute',!mix[f.id]?.mute)}>M</button><button className={mix[f.id]?.solo?'active':''} onClick={()=>update(f.id,'solo',!mix[f.id]?.solo)}>S</button></div><label>Volume <input type="range" min="0" max="1" step=".01" value={mix[f.id]?.volume??.7} onChange={e=>update(f.id,'volume',+e.target.value)}/></label><label>Pan <input type="range" min="-1" max="1" step=".01" value={mix[f.id]?.pan??0} onChange={e=>update(f.id,'pan',+e.target.value)}/></label></div>)}</div>
 <button className="secondary" onClick={()=>save('preset',{song,mix,pitchSemitones:pitch,speed:rate})}>Save my mix</button><p className="muted">Saved mixes include pitch and speed. Larger shifts can create audible artifacts. Pitch processing adds a small delay.</p>
 {error&&<p role="alert">{error}</p>}
 </section>;
}
