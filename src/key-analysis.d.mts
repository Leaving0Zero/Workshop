export type KeyEstimate={root:number;mode:string;score:number;match:string;alternative:{root:number;mode:string};frames:number};
export function keyName(root:number,mode:string,semitones?:number):string;
export function analyzeKey(samples:Float32Array,sampleRate:number):KeyEstimate|null;
export function sampleForKey(buffers:AudioBuffer[]):{samples:Float32Array;sampleRate:number};
