const roots={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
export function transposeCatalogKey(value,semitones=0){
 const original=String(value||'').trim(),match=original.match(/^([A-G])([#b♯♭]?)(?=$|\s|\/|(?:m|min|minor|maj|major)$)(.*)$/i);
 if(!match)return null;
 if(!semitones)return original;
 const names=/[b♭]/.test(match[2])?['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']:['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
 const shift=(note,accidental)=>names[((roots[note.toUpperCase()]+(/[♯#]/.test(accidental)?1:/[b♭]/.test(accidental)?-1:0)+Math.round(semitones))%12+12)%12];
 return shift(match[1],match[2])+match[3].replace(/\/([A-G])([#b♯♭]?)(?=$|\s)/gi,(_,n,a)=>'/'+shift(n,a));
}
