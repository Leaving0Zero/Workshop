import {analyzeKey} from './key-analysis.mjs';
self.onmessage=(event:MessageEvent<{samples:Float32Array;sampleRate:number}>)=>{
 try{self.postMessage({result:analyzeKey(event.data.samples,event.data.sampleRate)})}
 catch{self.postMessage({error:'Key analysis could not finish. Playback is still available.'})}
};
