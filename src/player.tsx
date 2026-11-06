import {useRef,useState,useEffect} from 'react';
import {registerPitch} from './pitch-audio';
import {StreamingRehearsal,type StreamFailure} from './streaming-audio';
import {transposeCatalogKey} from './catalog-key.mjs';
import {keyName,type KeyEstimate} from './key-analysis.mjs';

const bound=(value:number,min:number,max:number)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):min;
const time=(v:number)=>Math.floor(v/60)+':'+String(Math.floor(v%60)).padStart(2,'0');
type Loop={on:boolean;a:number;b:number};

export default function Player({files,song,save,preset,catalogKey,onRemove,removalBusy}:any){
 const ctx=useRef<AudioContext|null>(null),engine=useRef<StreamingRehearsal|null>(null),generation=useRef(0),analysisRun=useRef(0),activeSong=useRef<string|null>(null);
 const rateRef=useRef(1),pitchRef=useRef(0),mixRef=useRef<any>({}),worker=useRef<Worker|null>(null),analysisTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[starting,setStarting]=useState(false),[buffering,setBuffering]=useState(false),[buffered,setBuffered]=useState(0),[error,setError]=useState(''),[duration,setDuration]=useState(0),[pos,setPos]=useState(0),[on,setOn]=useState(false),[rate,setRate]=useState(1),[pitch,setPitch]=useState(0),[mix,setMix]=useState<any>({}),[loop,setLoop]=useState<Loop>({on:false,a:0,b:0}),[retry,setRetry]=useState(0);
 const [progress,setProgress]=useState(0),[readyCount,setReadyCount]=useState(0),[failures,setFailures]=useState<StreamFailure[]>([]);
 const [key,setKey]=useState<KeyEstimate|null>(null),[analyzing,setAnalyzing]=useState(false),[analysisMessage,setAnalysisMessage]=useState('');
 const originalKey=String(catalogKey||'').trim(),playbackKey=transposeCatalogKey(originalKey,pitch);
 const fileKey=files.map((f:any)=>f.id+':'+f.path+':'+f.size).join('|');

 function stopAnalysis(){analysisRun.current++;worker.current?.terminate();worker.current=null;if(analysisTimer.current)clearTimeout(analysisTimer.current);analysisTimer.current=null}
 function apply(m:any){mixRef.current=m;setMix(m);engine.current?.setMix(m)}
 async function analyze(){
  const current=engine.current,token=generation.current;if(!current||!current.stems.length)return;
  stopAnalysis();const run=analysisRun.current,valid=()=>generation.current===token&&analysisRun.current===run&&!current.disposed;
  setKey(null);setAnalysisMessage('');setAnalyzing(true);
  const finish=(result:KeyEstimate|null,message:string)=>{if(!valid())return;stopAnalysis();setKey(result);setAnalysisMessage(message);setAnalyzing(false)};
  try{
   const input=await current.keySample(valid);if(!valid())return;
   const task=new Worker(new URL('./key-worker.ts',import.meta.url),{type:'module'});worker.current=task;
   task.onmessage=event=>finish(event.data.result||null,event.data.error||(!event.data.result?'No reliable key found in the sampled stems. Your catalog key remains available.':''));
   task.onerror=()=>finish(null,'Key analysis could not finish. Playback is still available.');
   analysisTimer.current=setTimeout(()=>finish(null,'Key analysis timed out. You can retry without reloading the stems.'),20000);
   task.postMessage({samples:input.samples,sampleRate:input.sampleRate},[input.samples.buffer]);
  }catch{finish(null,'Key analysis is unavailable for these stems in this browser. Playback is still available.')}
 }
 useEffect(()=>{
  const token=++generation.current,sameSong=activeSong.current===song;activeSong.current=song;
  stopAnalysis();setLoaded(false);setBusy(files.length>0);setStarting(false);setDuration(0);setPos(0);setOn(false);setBuffering(false);setKey(null);setAnalyzing(false);setAnalysisMessage('');setError('');setProgress(0);setBuffered(0);setReadyCount(0);setFailures([]);
  if(!sameSong){const data=preset?.data||{};pitchRef.current=Math.round(bound(Number(data.pitchSemitones||0),-12,12));setPitch(pitchRef.current);rateRef.current=bound(Number(data.speed||1),.5,1.5);setRate(rateRef.current);apply(data.mix||{})}
  const initialLoop={on:false,a:0,b:0};setLoop(initialLoop);
  const current=new StreamingRehearsal(files);engine.current=current;
  current.onState=s=>{if(token!==generation.current)return;setOn(s.playing);setBuffering(s.buffering);setBuffered(s.bufferedSeconds);setPos(s.position)};
  current.onError=message=>{if(token===generation.current)setError(message)};
  current.setMix(mixRef.current);current.setPitch(pitchRef.current);current.setSpeed(rateRef.current);
  if(files.length)void current.prepare(done=>{if(token===generation.current)setProgress(done)}).then(()=>{
   if(token!==generation.current)return;
   setDuration(current.duration);setReadyCount(current.stems.length);setFailures(current.failures);setLoop({on:false,a:0,b:current.duration});setLoaded(current.stems.length>0);setBusy(false);
  }).catch(e=>{if(token!==generation.current)return;setBusy(false);setFailures(current.failures);setError(e instanceof Error?e.message:'Unable to prepare the stems')});
  return()=>{generation.current++;stopAnalysis();current.onState=()=>{};current.onError=()=>{};current.dispose();if(engine.current===current)engine.current=null;const previous=ctx.current;ctx.current=null;if(previous)void previous.close().catch(()=>{})};
 },[song,fileKey,retry]);
 function transpose(value:number){const p=Math.round(bound(value,-12,12));pitchRef.current=p;setPitch(p);engine.current?.setPitch(p)}
 function changeRate(value:number){rateRef.current=bound(value,.5,1.5);setRate(rateRef.current);engine.current?.setSpeed(rateRef.current)}
 function update(id:string,field:string,value:any){apply({...mixRef.current,[id]:{...mixRef.current[id],[field]:value}})}
 function setL(l:Loop){const next={on:l.on,a:bound(l.a,0,duration),b:bound(l.b,0,duration)};setLoop(next);engine.current?.setLoop(next)}
 async function toggle(){
  const current=engine.current;if(!current)return;if(current.isPlaying()){current.pause();return}
  stopAnalysis();setAnalyzing(false);const token=generation.current;setStarting(true);setError('');
  try{const context=ctx.current||new AudioContext();ctx.current=context;await context.resume();const Node=await registerPitch(context);if(token!==generation.current)return;void current.play(context,Node)}
  catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'Unable to start audio')}
  finally{if(token===generation.current)setStarting(false)}
 }

 return <section className="mixer">
 <div className="row"><div><span className="eyebrow">REHEARSAL CONSOLE</span><h2>Your sound. Your mix.</h2></div><span className="tag">Streamed, synchronized stems</span></div>
 <p className="muted">Stems must share the same start point. Shift pitch without changing tempo, or change speed while keeping the key.</p>
 <p className="stem-status" role="status">{busy?(progress===files.length?'Building a larger startup buffer…':'Preparing stems automatically… '+progress+' / '+files.length):loaded?(buffering?'Buffering stems together…':readyCount+' of '+files.length+' stems ready · '+Math.floor(buffered)+' seconds buffered ahead'):'No stems ready. Upload audio to this song to start rehearsing.'}</p>
 <div className="key-readout" aria-live="polite"><span className="eyebrow">SONG KEY</span><div className="key-pair"><div><small>Original · song catalog</small><strong>{originalKey||'Key not set'}</strong></div><span>→</span><div><small>Playback · {pitch>0?'+':''}{pitch} semitones</small><strong>{playbackKey||(originalKey?'Check catalog key format':'Key not set')}</strong></div></div>{!originalKey&&<p className="muted">Set the original key in Songs &amp; setlists to show the transposed playback key.</p>}</div>
 {loaded&&<>
 <div className="pitch-panel"><div><span className="eyebrow">PITCH SHIFT</span><div className="pitch-controls"><button className="secondary" aria-label="Lower pitch by one semitone" disabled={pitch<=-12} onClick={()=>transpose(pitch-1)}>−</button><strong aria-live="polite">{pitch>0?'+':''}{pitch} <small>semitones</small></strong><button className="secondary" aria-label="Raise pitch by one semitone" disabled={pitch>=12} onClick={()=>transpose(pitch+1)}>＋</button><button className="textbutton" onClick={()=>transpose(0)}>Original pitch</button></div><input type="range" aria-label="Pitch shift in semitones" min="-12" max="12" step="1" value={pitch} onChange={e=>transpose(+e.target.value)}/></div>
 </div>

 <details><summary>Optional audio key estimate</summary><p className="muted">Catalog key is used above. Audio analysis is approximate and may need extra downloads.</p>{analyzing?<p>Analyzing short excerpts…</p>:key?<p>Estimated audio key: {keyName(key.root,key.mode)} · {key.match} match.</p>:<p className="muted">{analysisMessage}</p>}<button className="textbutton" disabled={analyzing||on} onClick={()=>void analyze()}>Analyze audio key</button></details>
 <div className="transport"><button disabled={starting} onClick={toggle}>{starting?'Starting…':on?'Ⅱ Pause':'▶ Play'}</button><button onClick={()=>engine.current?.reset()}>■ Reset</button><strong>{time(pos)} / {time(duration)}</strong><label>Speed <select value={rate} onChange={e=>changeRate(+e.target.value)}>{[.5,.75,1,1.25,1.5].map(x=><option key={x} value={x}>{x}×</option>)}</select></label></div>
 <input aria-label="Seek" type="range" min="0" max={duration} step=".05" value={pos} onChange={e=>{setPos(+e.target.value);engine.current?.seek(+e.target.value)}}/>
 <div className="row"><label><input type="checkbox" checked={loop.on} onChange={e=>setL({...loop,on:e.target.checked})}/> Loop</label><label>A <input type="number" min="0" max={duration} value={loop.a} onChange={e=>setL({...loop,a:+e.target.value})}/></label><label>B <input type="number" min="0" max={duration} value={loop.b} onChange={e=>setL({...loop,b:+e.target.value})}/></label></div>{loop.on&&loop.b<=loop.a&&<p className="muted">Set loop B after A to enable looping.</p>}
 </>}
 <div className="channels">{files.map((f:any,i:number)=><div className="channel" key={f.id}><span className="eyebrow">CH {String(i+1).padStart(2,'0')}</span><h3>{f.name}</h3>{onRemove&&<button className="textbutton" disabled={removalBusy} onClick={()=>onRemove(f)} aria-label={"Remove stem "+f.name}>Remove stem</button>}{failures.find(problem=>problem.id===f.id)&&<p className="stem-error">Unavailable: {failures.find(problem=>problem.id===f.id)?.error}</p>}<div className="wave">{Array.from({length:28},(_,j)=><i key={j} style={{height:8+((j*17+i*11)%37)}}/>)}</div><div className="row"><button className={mix[f.id]?.mute?'active':''} onClick={()=>update(f.id,'mute',!mix[f.id]?.mute)}>M</button><button className={mix[f.id]?.solo?'active':''} onClick={()=>update(f.id,'solo',!mix[f.id]?.solo)}>S</button></div><label>Volume <input type="range" min="0" max="1" step=".01" value={mix[f.id]?.volume??.7} onChange={e=>update(f.id,'volume',+e.target.value)}/></label><label>Pan <input type="range" min="-1" max="1" step=".01" value={mix[f.id]?.pan??0} onChange={e=>update(f.id,'pan',+e.target.value)}/></label></div>)}</div>
 <button className="secondary" onClick={()=>save('preset',{song,mix,pitchSemitones:pitch,speed:rate})}>Save my mix</button><p className="muted">Saved mixes include pitch and speed. Larger shifts can create audible artifacts. Pitch processing adds a small delay.</p>
 {error&&<p role="alert">{error}</p>}{(error||failures.length>0)&&<button className="secondary" onClick={()=>setRetry(value=>value+1)}>Retry unavailable stems</button>}
 </section>;
}
