import assert from 'node:assert/strict';
import {test} from 'node:test';
import {analyzeKey,keyName,sampleForKey} from '../src/key-analysis.mjs';
const sr=12000;
function progression(chords,shift=0){const seconds=2,out=new Float32Array(seconds*sr*chords.length);for(let i=0;i<out.length;i++){const ci=Math.floor(i/(seconds*sr)),t=(i%(seconds*sr))/sr,env=Math.min(1,t*15)*Math.min(1,(seconds-t)*15);out[i]=chords[ci].reduce((s,m)=>s+Math.sin(2*Math.PI*(440*2**((m+shift-69)/12))*t),0)/chords[ci].length*env}return out}
const major=[[48,52,55],[53,57,60],[55,59,62],[48,52,55],[48,52,55],[53,57,60],[55,59,62],[48,52,55]];
const minor=[[50,53,57],[55,58,62],[57,61,64],[50,53,57],[50,53,57],[55,58,62],[57,61,64],[50,53,57]];
test('estimates major/minor keys from synthetic chord progressions',()=>{for(const [chords,shift,root,mode] of [[major,0,0,'major'],[minor,0,2,'minor'],[major,6,6,'major'],[minor,8,10,'minor']]){const result=analyzeKey(progression(chords,shift),sr);assert.ok(result);assert.equal(result.root,root);assert.equal(result.mode,mode)}});
test('does not invent a key for silence or a single pitch',()=>{assert.equal(analyzeKey(new Float32Array(sr*5),sr),null);assert.equal(analyzeKey(Float32Array.from({length:sr*5},(_,i)=>Math.sin(2*Math.PI*440*i/sr)),sr),null)});
test('transposition wraps octaves and keeps the mode',()=>{assert.equal(keyName(11,'major',1),'C major');assert.equal(keyName(0,'minor',-1),'B minor');assert.equal(keyName(2,'minor',12),'D minor')});
test('analysis samples stay bounded and never change source audio',()=>{const samples=new Float32Array(sr*120).fill(.25),buffer={sampleRate:sr,duration:120,length:samples.length,numberOfChannels:1,getChannelData:()=>samples};const result=sampleForKey([buffer]);assert.ok(result.samples.length<=sr*36);assert.equal(result.sampleRate,sr);assert.equal(samples[0],.25);assert.equal(result.samples[100],.25)});
