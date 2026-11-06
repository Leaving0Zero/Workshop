import type {SoundTouchNode} from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
const registrations=new WeakMap<BaseAudioContext,Promise<typeof SoundTouchNode>>();
export async function registerPitch(context:BaseAudioContext){
 if(!context.audioWorklet||typeof AudioWorkletNode==='undefined')throw Error('Pitch shifting needs AudioWorklet support. Use a current Safari, Chrome, Edge or Firefox browser.');
 let ready=registrations.get(context);
 if(!ready){ready=import('./pitch-node').then(async module=>{await module.SoundTouchNode.register(context,processorUrl);return module.SoundTouchNode});registrations.set(context,ready);ready.catch(()=>registrations.delete(context))}
 return ready;
}
export function createPitchBus(Node:typeof SoundTouchNode,context:BaseAudioContext,semitones:number,rate:number){
 const bus=new Node({context,outputChannelCount:2});
 bus.pitchSemitones.value=semitones;
 bus.playbackRate.value=rate;
 return bus;
}

