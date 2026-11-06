// Local spectral-chroma analysis with Krumhansl–Kessler major/minor profile matching.
// This estimates one overall tonal center; relative keys, modes and modulations can be ambiguous.
const profiles={major:[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],minor:[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]};
const names=['C','C♯ / D♭','D','D♯ / E♭','E','F','F♯ / G♭','G','G♯ / A♭','A','A♯ / B♭','B'];
export const keyName=(root,mode,semitones=0)=>names[((root+semitones)%12+12)%12]+' '+mode;
function fft(real,imag){
 const n=real.length;
 for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];[imag[i],imag[j]]=[imag[j],imag[i]]}}
 for(let len=2;len<=n;len<<=1){const angle=-2*Math.PI/len,wr=Math.cos(angle),wi=Math.sin(angle);
 for(let i=0;i<n;i+=len){let ar=1,ai=0;for(let j=0;j<len/2;j++){const a=i+j,b=a+len/2,tr=real[b]*ar-imag[b]*ai,ti=real[b]*ai+imag[b]*ar;real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;const next=ar*wr-ai*wi;ai=ar*wi+ai*wr;ar=next}}}
}
function correlation(a,b){const am=a.reduce((s,v)=>s+v,0)/12,bm=b.reduce((s,v)=>s+v,0)/12;let top=0,aa=0,bb=0;for(let i=0;i<12;i++){const x=a[i]-am,y=b[i]-bm;top+=x*y;aa+=x*x;bb+=y*y}return aa&&bb?top/Math.sqrt(aa*bb):0}
export function analyzeKey(samples,sampleRate){
 const n=8192,hop=4096,real=new Float64Array(n),imag=new Float64Array(n),magnitude=new Float64Array(n/2),window=Float64Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(n-1))),chroma=new Float64Array(12);let frames=0;
 for(let offset=0;offset+n<=samples.length;offset+=hop){let power=0;
 for(let i=0;i<n;i++){const s=Number.isFinite(samples[offset+i])?samples[offset+i]:0;power+=s*s;real[i]=s*window[i];imag[i]=0}if(power/n<1e-9)continue;
 fft(real,imag);let peak=0;
 for(let i=1;i<n/2;i++){magnitude[i]=Math.hypot(real[i],imag[i]);peak=Math.max(peak,magnitude[i])}
 const frame=new Float64Array(12);
 for(let i=Math.max(2,Math.ceil(55*n/sampleRate));i<Math.min(n/2-1,Math.floor(3500*n/sampleRate));i++){
 const value=magnitude[i];if(value<peak*.015||value<magnitude[i-1]||value<=magnitude[i+1])continue;
 const left=Math.log(magnitude[i-1]+1e-20),center=Math.log(value+1e-20),right=Math.log(magnitude[i+1]+1e-20),den=left-2*center+right;
 const correction=den?Math.max(-.5,Math.min(.5,.5*(left-right)/den)):0;
 const freq=(i+correction)*sampleRate/n,midi=69+12*Math.log2(freq/440),nearest=Math.round(midi),distance=Math.abs(midi-nearest);
 if(distance>.45)continue;
 frame[((nearest%12)+12)%12]+=Math.sqrt(value)*Math.cos(distance*Math.PI/2)/Math.sqrt(freq/110);
 }
 const sum=frame.reduce((s,v)=>s+v,0);if(sum){for(let k=0;k<12;k++)chroma[k]+=frame[k]/sum;frames++}
 }
 const sum=chroma.reduce((s,v)=>s+v,0);if(frames<3||!sum)return null;
 const normalized=Array.from(chroma,v=>v/sum),max=Math.max(...normalized),variety=normalized.filter(v=>v>max*.16).length;
 const entropy=-normalized.reduce((s,v)=>s+(v>0?v*Math.log(v):0),0)/Math.log(12);
 if(variety<3||entropy>.98)return null;
 const ranked=[];
 for(const [mode,profile] of Object.entries(profiles))for(let root=0;root<12;root++){const rotated=Array.from({length:12},(_,i)=>profile[(i-root+12)%12]);ranked.push({root,mode,score:correlation(normalized,rotated)})}
 ranked.sort((a,b)=>b.score-a.score);const best=ranked[0],gap=best.score-ranked[1].score;
 if(best.score<.5)return null;
 return {...best,match:best.score>.8&&gap>.12?'strong':best.score>.65&&gap>.05?'moderate':'uncertain',alternative:{root:ranked[1].root,mode:ranked[1].mode},frames};
}
export function sampleForKey(buffers){
 if(!buffers.length)throw Error('No audio loaded');
 const sourceRate=buffers[0].sampleRate,step=Math.max(1,Math.floor(sourceRate/12000)),sampleRate=sourceRate/step,duration=Math.max(...buffers.map(b=>b.duration));
 const segmentSeconds=Math.min(3,duration),segments=Math.min(12,Math.max(1,Math.floor(duration/segmentSeconds))),segmentFrames=Math.floor(segmentSeconds*sampleRate);
 const samples=new Float32Array(segments*segmentFrames);
 for(const buffer of buffers){const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
 for(let segment=0;segment<segments;segment++){const start=segments===1?0:(duration-segmentSeconds)*segment/(segments-1),base=Math.floor(start*sourceRate);
 for(let i=0;i<segmentFrames;i++){const input=base+i*step;if(input>=buffer.length)break;let value=0;
 for(const channel of channels)for(let j=0;j<step&&input+j<channel.length;j++)value+=channel[input+j];
 samples[segment*segmentFrames+i]+=value/(channels.length*step*buffers.length);
 }}}
 return {samples,sampleRate};
}
