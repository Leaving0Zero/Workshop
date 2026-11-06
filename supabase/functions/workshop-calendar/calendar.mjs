export function escapeText(value=''){return String(value).replace(/\\/g,'\\\\').replace(/\r/g,'').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;')}
export function foldLine(line){
 const encoder=new TextEncoder();let current='',bytes=0;const parts=[];
 for(const char of line){const length=encoder.encode(char).length;if(bytes+length>75){parts.push(current);current=' ';bytes=1}current+=char;bytes+=length}
 parts.push(current);return parts.join('\r\n');
}
export function calendar(events){
 const stamp=s=>new Date(s).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Leaving Zero//Workshop//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Leaving Zero Workshop','REFRESH-INTERVAL;VALUE=DURATION:PT1H','X-PUBLISHED-TTL:PT1H'];
 for(const e of events){lines.push('BEGIN:VEVENT','UID:'+e.id+'@leavingzero.com','SEQUENCE:'+e.version,'DTSTAMP:'+stamp(e.updated),'DTSTART:'+stamp(e.data.start),'DTEND:'+stamp(e.data.end),'SUMMARY:'+escapeText(e.data.title),'LOCATION:'+escapeText(e.data.location),'DESCRIPTION:'+escapeText(e.data.notes),'END:VEVENT')}
 lines.push('END:VCALENDAR');return lines.map(foldLine).join('\r\n')+'\r\n';
}
