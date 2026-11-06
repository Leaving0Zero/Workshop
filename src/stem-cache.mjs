// Session-only compressed audio cache. Nothing is written to browser storage.
export class StemCache {
 constructor(fetcher,maxBytes=128*1024*1024,blockSize=512*1024){this.fetcher=fetcher;this.maxBytes=maxBytes;this.blockSize=blockSize;this.entries=new Map();this.pending=new Map();this.bytes=0;this.disposed=false;this.controller=new AbortController()}
 async block(file,index){
  if(this.disposed)throw Error('Audio session closed');
  const key=file.id+':'+index,hit=this.entries.get(key);if(hit){this.entries.delete(key);this.entries.set(key,hit);return hit}
  if(this.pending.has(key))return this.pending.get(key);
  const task=(async()=>{const start=index*this.blockSize,end=Math.min(file.size,start+this.blockSize),response=await this.fetcher(file,{headers:{Range:'bytes='+start+'-'+(end-1)},signal:this.controller.signal,cache:'no-store'});
   if(response.status!==206){void response.body?.cancel();throw Error('Storage could not stream this audio range ('+response.status+'). Try again.')}
   const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==end-start)throw Error('Incomplete audio range received. Try again.');
   if(this.disposed)throw Error('Audio session closed');
   while(this.bytes+bytes.length>this.maxBytes&&this.entries.size){const oldest=this.entries.keys().next().value;this.bytes-=this.entries.get(oldest).length;this.entries.delete(oldest)}
   this.entries.set(key,bytes);this.bytes+=bytes.length;return bytes;
  })();this.pending.set(key,task);try{return await task}finally{this.pending.delete(key)}
 }
 async read(file,start,end){
  const first=Math.floor(start/this.blockSize),last=Math.floor((end-1)/this.blockSize),out=new Uint8Array(end-start);
  // Finished blocks can make room for background downloads of later audio.
  for(const [key,value] of this.entries)if(key.startsWith(file.id+':')&&Number(key.slice(file.id.length+1))<first){this.entries.delete(key);this.bytes-=value.length}
  for(let i=first;i<=last;i++){const bytes=await this.block(file,i),lo=Math.max(start,i*this.blockSize),hi=Math.min(end,i*this.blockSize+bytes.length);out.set(bytes.subarray(lo-i*this.blockSize,hi-i*this.blockSize),lo-start)}return out;
 }
 async prefetch(files){
  const cursors=new Map(files.map(f=>[f.id,0]));
  while(!this.disposed){let remaining=false;
   for(const file of files){let index=cursors.get(file.id);if(index*this.blockSize>=file.size)continue;remaining=true;
    if(this.bytes+this.blockSize>this.maxBytes){await new Promise(r=>setTimeout(r,150));break}
    try{await this.block(file,index)}catch{if(this.disposed)return;await new Promise(r=>setTimeout(r,1000));continue}cursors.set(file.id,index+1);
   }if(!remaining)return;
  }
 }
 dispose(){this.disposed=true;this.controller.abort();this.entries.clear();this.bytes=0}
}
