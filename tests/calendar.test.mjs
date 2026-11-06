import assert from 'node:assert/strict';
import {test} from 'node:test';
import {escapeText,foldLine,calendar} from '../supabase/functions/workshop-calendar/calendar.mjs';
test('calendar text cannot inject properties or events',()=>{assert.equal(escapeText('hello\r\nBEGIN:VEVENT,a;b\\c'),'hello\\nBEGIN:VEVENT\\,a\\;b\\\\c')});
test('folding respects UTF-8 octets and round trips',()=>{const input='SUMMARY:'+('🎸Zero '.repeat(40));const folded=foldLine(input);for(const line of folded.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);assert.equal(folded.replace(/\r\n /g,''),input)});
test('calendar uses stable IDs, revision sequence and UTC',()=>{const c=calendar([{id:'abc',version:3,updated:'2026-11-06T12:00:00Z',data:{title:'Rehearsal',start:'2026-11-07T18:00:00-06:00',end:'2026-11-07T20:00:00-06:00'}}]);assert.ok(c.includes('UID:abc@leavingzero.com\r\nSEQUENCE:3'));assert.ok(c.includes('DTSTART:20261108T000000Z'));assert.ok(c.endsWith('END:VCALENDAR\r\n'))});
