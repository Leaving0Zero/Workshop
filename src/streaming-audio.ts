import {Input,CustomSource,AudioBufferSink,WAVE,MP3,MP4,OGG,FLAC,ADTS} from 'mediabunny';
import type {SoundTouchNode} from '@soundtouchjs/audio-worklet';
import {fetchPrivateStem} from './api';
import {StemCache} from './stem-cache.mjs';
import {createPitchBus} from './pitch-audio';

export type StemFile={id:string;name:string;path:string;size:number;mime:string};
type Piece={buffer:AudioBuffer;timestamp:number;duration:number};
type Segment={start:number;end:number;pieces:{stem:StreamingStem;audio:Piece[]}[]};
type Mix=Record<string,{mute?:boolean;solo?:boolean;volume?:number;pan?:number}>;
export type StreamingState={playing:boolean;buffering:boolean;position:number;bufferedSeconds:number};
export type StreamFailure={id:string;name:string;error:string};
const clamp=(v:number,min:number,max:number)=>Number.isFinite(v)?Math.min(max,Math.max(min,v)):min;
class Cancelled extends Error{}
class Pool{
 active=0;queue:(()=>void)[]=[];
 constructor(readonly limit:number){}
 async run<T>(task:()=>Promise<T>):Promise<T>{if(this.active>=this.limit)await new Promise<void>(r=>this.queue.push(r));else this.active++;try{return await task()}finally{const next=this.queue.shift();if(next)next();else this.active--}}
}
export class StreamingStem{
 input:Input;sink:AudioBufferSink|null=null;duration=0;sampleRate=48000;channels=2;origin=0;
 constructor(readonly file:StemFile,fetchFn:typeof globalThis.fetch=(_url,init)=>fetchPrivateStem(file,init),cache?:StemCache){
  const controller=new AbortController();
  const source=new CustomSource({
   getSize:()=>file.size,maxCacheSize:256*1024,prefetchProfile:'fileSystem',
   read:async(start,end)=>{
    if(cache)return cache.read(file,start,end);
    const response=await fetchFn('https://private-stem.invalid/'+encodeURIComponent(file.id),{headers:{Range:'bytes='+start+'-'+(end-1)},signal:controller.signal,cache:'no-store'});
    if(response.status!==206){void response.body?.cancel();throw Error(response.status===401||response.status===403?'Access to this stem was denied.':'Storage could not stream this audio range ('+response.status+'). Try again.')}
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength!==end-start)throw Error('An incomplete audio range was received. Try again.');
    return new Uint8Array(bytes);
   },
   dispose:()=>controller.abort(),
   handleUnhandledError:()=>{/* Explicit decode requests surface network errors in the player. */},
  });
  this.input=new Input({source,formats:[WAVE,MP3,MP4,OGG,FLAC,ADTS]});
 }
 async open(){
  const track=await this.input.getPrimaryAudioTrack();if(!track)throw Error('No audio track found');
  if(!await track.canDecode())throw Error('This browser cannot stream this audio format. Try a current Chrome, Edge, Safari or Firefox, or use WAV stems.');
  this.origin=Math.max(0,await track.getFirstTimestamp());
  this.duration=(await track.getDurationFromMetadata()??await track.computeDuration())-this.origin;
  if(!Number.isFinite(this.duration)||this.duration<=0)throw Error('Unable to read the audio duration');
  this.sampleRate=await track.getSampleRate();this.channels=await track.getNumberOfChannels();this.sink=new AudioBufferSink(track);
 }
 async read(start:number,end:number,valid=()=>true):Promise<Piece[]>{
  if(!valid())throw new Cancelled();if(!this.sink||start>=this.duration)return [];
  const result:Piece[]=[];
  for await(const wrapped of this.sink.buffers(this.origin+start,this.origin+Math.min(end,this.duration))){
   if(!valid())throw new Cancelled();
   result.push({buffer:wrapped.buffer,timestamp:wrapped.timestamp-this.origin,duration:wrapped.duration});
  }
  return result;
 }
 dispose(){this.input.dispose()}
}
export class StreamingRehearsal{
 stems:StreamingStem[]=[];failures:StreamFailure[]=[];duration=0;segmentSeconds=4;initialSeconds=12;disposed=false;
 private cache:StemCache;private inputs=new Set<StreamingStem>();private pool=new Pool(4);private version=0;private mix:Mix={};private offset=0;private anchor=0;private scheduledEnd=0;private scheduledMediaEnd=0;private wanted=false;private anchored=false;private buffering=false;private timer:ReturnType<typeof setInterval>|null=null;
 private context:AudioContext|null=null;private Node:typeof SoundTouchNode|null=null;private bus:SoundTouchNode|null=null;
 private channels=new Map<string,{gain:GainNode;pan:StereoPannerNode}>();private sources=new Set<AudioBufferSourceNode>();private first:Segment|null=null;private rate=1;private semitones=0;private loop={on:false,a:0,b:0};
 onState:(s:StreamingState)=>void=()=>{};onError:(message:string)=>void=()=>{};
 constructor(readonly files:StemFile[],readonly fetcher?:(file:StemFile)=>typeof globalThis.fetch){this.cache=new StemCache((file,init)=>fetcher?fetcher(file)('https://private-stem.invalid/'+file.id,init):fetchPrivateStem(file,init))}
 async prepare(progress:(finished:number,total:number)=>void=()=>{}){
  let finished=0;
  await Promise.all(this.files.map(file=>this.pool.run(async()=>{
   if(this.disposed)return;
   const stem=new StreamingStem(file,this.fetcher?.(file),this.cache);this.inputs.add(stem);
   try{await stem.open();if(this.disposed){stem.dispose();return}this.stems.push(stem)}
   catch(e){stem.dispose();this.inputs.delete(stem);if(!this.disposed)this.failures.push({id:file.id,name:file.name,error:e instanceof Error?e.message:String(e)})}
   finally{if(!this.disposed)progress(++finished,this.files.length)}
  })));
  if(this.disposed)return;
  this.stems.sort((a,b)=>this.files.findIndex(f=>f.id===a.file.id)-this.files.findIndex(f=>f.id===b.file.id));
  if(!this.stems.length)throw Error(this.failures[0]?.error||'Upload stems for this song to start rehearsing.');
  this.duration=Math.max(...this.stems.map(s=>s.duration));
  // Reserve a substantial startup cushion; retain a bounded rolling PCM window.
  const bytesPerSecond=this.stems.reduce((n,s)=>n+s.sampleRate*s.channels*4,0);
  this.initialSeconds=Math.max(.5,Math.min(12,160*1024*1024/Math.max(1,bytesPerSecond*1.5)));
  this.segmentSeconds=Math.min(4,this.initialSeconds/2);
  this.loop={on:false,a:0,b:this.duration};
  this.first=await this.segment(0,Math.min(this.duration,this.initialSeconds),()=>!this.disposed);
  void this.cache.prefetch(this.stems.map(s=>s.file));
  this.emit();
 }
 private async segment(start:number,end:number,valid:()=>boolean):Promise<Segment>{
  const pieces=await Promise.all(this.stems.map(stem=>this.pool.run(async()=>({stem,audio:this.combine(await stem.read(start,end,valid),start,Math.min(end,stem.duration),stem)}))));
  if(!valid())throw new Cancelled();return {start,end,pieces};
 }
 private combine(pieces:Piece[],start:number,end:number,stem:StreamingStem):Piece[]{
  if(!pieces.length||end<=start)return [];
  const result:Piece[]=[];
  // Keep startup audio in short pieces too, so played portions are released while refilling.
  for(let at=start;at<end;at+=this.segmentSeconds){const until=Math.min(end,at+this.segmentSeconds),buffer=new AudioBuffer({length:Math.ceil((until-at)*stem.sampleRate),sampleRate:stem.sampleRate,numberOfChannels:stem.channels});
   for(const piece of pieces){const offset=Math.round((piece.timestamp-at)*stem.sampleRate),from=Math.max(0,-offset),to=Math.max(0,offset),length=Math.min(piece.buffer.length-from,buffer.length-to);if(length<=0)continue;for(let c=0;c<stem.channels;c++)buffer.getChannelData(c).set(piece.buffer.getChannelData(c).subarray(from,from+length),to)}
   result.push({buffer,timestamp:at,duration:until-at});
  }return result;
 }
 setMix(mix:Mix){this.mix=mix;const solo=Object.values(mix).some(v=>v.solo);for(const [id,node] of this.channels){const m=mix[id]||{};node.gain.gain.value=m.mute||(solo&&!m.solo)?0:clamp(m.volume??.7,0,1);node.pan.pan.value=clamp(m.pan??0,-1,1)}}
 setPitch(pitch:number){this.semitones=pitch;if(this.bus)this.bus.pitchSemitones.value=pitch}
 setLoop(loop:{on:boolean;a:number;b:number}){this.loop=loop}
 isPlaying(){return this.wanted}
 position(){return this.wanted&&this.anchored&&this.context?clamp(this.offset+Math.max(0,this.context.currentTime-this.anchor)*this.rate,0,this.duration):this.offset}
 private emit(){this.onState({playing:this.wanted,buffering:this.buffering,position:this.position(),bufferedSeconds:this.wanted&&this.context?Math.max(0,this.scheduledEnd-this.context.currentTime):this.first?this.first.end-this.first.start:0})}
 private disconnect(){
  if(this.timer)clearInterval(this.timer);this.timer=null;
  for(const source of this.sources){source.onended=null;try{source.stop()}catch{}source.disconnect();source.buffer=null}this.sources.clear();
  for(const node of this.channels.values()){node.gain.disconnect();node.pan.disconnect()}this.channels.clear();
  if(this.bus){this.bus.onprocessorerror=null;this.bus.disconnect();this.bus.port.onmessage=null;this.bus.port.close();this.bus=null}
 }
 pause(){const p=this.position();this.version++;this.wanted=false;this.anchored=false;this.offset=p;this.buffering=false;this.disconnect();this.emit()}
 reset(){this.pause();this.offset=0;this.emit()}
 seek(position:number){const next=clamp(position,0,this.duration);if(this.wanted&&this.context&&this.Node)void this.play(this.context,this.Node,next);else{this.offset=next;this.emit()}}
 setSpeed(rate:number){const p=this.position(),restart=this.wanted;this.pause();this.rate=rate;if(restart&&this.context&&this.Node)void this.play(this.context,this.Node,p)}
 async play(context:AudioContext,Node:typeof SoundTouchNode,position=this.offset){
  this.pause();this.context=context;this.Node=Node;this.offset=position>=this.duration?0:position;
  const version=++this.version,valid=()=>!this.disposed&&this.version===version&&this.wanted;
  this.wanted=true;this.buffering=true;this.anchor=context.currentTime;this.emit();
  try{
   const first=this.first&&Math.abs(this.first.start-this.offset)<.00001?this.first:await this.segment(this.offset,Math.min(this.duration,this.offset+this.initialSeconds),valid);
   this.first=null;if(!valid())return;
   this.bus=createPitchBus(Node,context,this.semitones,this.rate);this.bus.connect(context.destination);
   this.bus.onprocessorerror=()=>this.fail('Audio processing stopped. Press Play to resume.');
   for(const stem of this.stems){const gain=context.createGain(),pan=context.createStereoPanner();gain.connect(pan).connect(this.bus);this.channels.set(stem.file.id,{gain,pan})}this.setMix(this.mix);
   await context.resume();if(!valid())return;
   this.anchor=context.currentTime+.15;this.scheduledEnd=this.anchor;this.schedule(first);this.anchored=true;this.buffering=false;this.emit();
   this.timer=setInterval(()=>{
    if(!valid())return;
    const p=this.position(),loop=this.loop;
    if(loop.on&&loop.b>loop.a&&p>=loop.b){void this.play(context,Node,loop.a);return}
    if(this.scheduledMediaEnd>=this.duration&&context.currentTime>=this.scheduledEnd+.25){this.reset();return}
    // Stop the shared audio clock before any stem runs out, so a slow fetch cannot cause stems to drift.
    if(this.scheduledMediaEnd<this.duration&&this.scheduledEnd-context.currentTime<.2&&!this.buffering){this.buffering=true;this.emit();void context.suspend().catch(()=>{})}
    this.emit();
   },30);
   let next=first.end;
   while(valid()&&next<this.duration){
    // Bound scheduling to a few seconds, regardless of song duration or number of stems.
    while(valid()&&this.scheduledEnd-context.currentTime>this.initialSeconds/this.rate)await new Promise(r=>setTimeout(r,30));
    if(!valid())return;
    const chunk=await this.segment(next,Math.min(this.duration,next+this.segmentSeconds),valid);if(!valid())return;
    if(context.currentTime>this.scheduledEnd-.01){this.first=chunk;void this.play(context,Node,this.scheduledMediaEnd);return}
    this.schedule(chunk);next=chunk.end;
    if(this.buffering&&(next>=this.duration||this.scheduledEnd-context.currentTime>=this.initialSeconds/this.rate)){await context.resume();if(!valid())return;this.buffering=false;this.emit()}
   }
  }catch(e){if(valid()&&!(e instanceof Cancelled))this.fail(e instanceof Error?e.message:'Unable to stream the stems')}
 }
 private schedule(segment:Segment){
  const context=this.context!;const when=this.scheduledEnd;
  for(const {stem,audio} of segment.pieces){const channel=this.channels.get(stem.file.id)!;
   for(const piece of audio){const lo=Math.max(segment.start,piece.timestamp),hi=Math.min(segment.end,piece.timestamp+piece.duration);
    if(hi<=lo)continue;
    const source=context.createBufferSource();source.buffer=piece.buffer;source.playbackRate.value=this.rate;source.connect(channel.gain);this.sources.add(source);
    source.onended=()=>{this.sources.delete(source);source.disconnect();source.buffer=null};
    source.start(when+(lo-segment.start)/this.rate,Math.max(0,lo-piece.timestamp),hi-lo);
   }
  }
  this.scheduledEnd=when+(segment.end-segment.start)/this.rate;this.scheduledMediaEnd=segment.end;
 }
 private fail(message:string){this.pause();this.onError(message)}
 // Key estimation reads small excerpts, never decodes complete files.
 async keySample(valid=()=>!this.disposed){
  const tonal=this.stems.filter(s=>!/(drum|kick|snare|cymbal|tom\b|hi.?hat|click|percussion)/i.test(s.file.name));
  const chosen=(tonal.length?tonal:this.stems).slice(0,3),sampleRate=12000,seconds=Math.min(2,this.duration),count=Math.min(8,Math.max(1,Math.floor(this.duration/seconds))),frames=Math.ceil(seconds*sampleRate),samples=new Float32Array(frames*count);
  for(const stem of chosen)for(let n=0;n<count;n++){
   if(!valid())throw new Cancelled();
   // Playback always gets priority over analysis when the shared stream is buffering.
   while(valid()&&this.wanted&&this.buffering)await new Promise(r=>setTimeout(r,100));
   const start=count===1?0:(this.duration-seconds)*n/(count-1);
   const pieces=await this.pool.run(()=>stem.read(start,Math.min(stem.duration,start+seconds),valid));
   for(const piece of pieces){const channels=Array.from({length:piece.buffer.numberOfChannels},(_,c)=>piece.buffer.getChannelData(c));
    const lo=Math.max(start,piece.timestamp),hi=Math.min(start+seconds,piece.timestamp+piece.duration);
    for(let t=lo;t<hi;t+=1/sampleRate){const index=n*frames+Math.floor((t-start)*sampleRate),p=Math.min(piece.buffer.length-1,Math.max(0,Math.floor((t-piece.timestamp)*piece.buffer.sampleRate)));if(index>=samples.length)break;let v=0;for(const channel of channels)v+=channel[p];samples[index]+=v/(channels.length*chosen.length)}
   }
   await new Promise(r=>setTimeout(r,0));
  }
  return {samples,sampleRate,stems:chosen.length};
 }
 dispose(){this.disposed=true;this.pause();this.first=null;this.cache.dispose();for(const stem of this.inputs)stem.dispose();this.inputs.clear();this.stems=[]}
 // Used for diagnostics: this is a short scheduling window, not the entire song.
 scheduledSourceCount(){return this.sources.size}
 scheduledDecodedBytes(){let bytes=0;const unique=new Set<AudioBuffer>();for(const source of this.sources)if(source.buffer&&!unique.has(source.buffer)){unique.add(source.buffer);bytes+=source.buffer.length*source.buffer.numberOfChannels*4}return bytes}
}
