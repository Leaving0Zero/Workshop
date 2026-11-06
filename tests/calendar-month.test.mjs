import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dateKey,monthDays,dayEvents} from '../src/calendar-dates.mjs';
process.env.TZ='America/Chicago';
const event=(start,end)=>({data:{start,end}});
test('month grid includes leap day, six complete weeks and Sunday start',()=>{const days=monthDays(new Date(2028,1,1));assert.equal(days.length,42);assert.equal(days[0].getDay(),0);assert.ok(days.some(d=>dateKey(d)==='2028-02-29'));assert.equal(new Set(days.map(dateKey)).size,42)});
test('January grid carries dates across the year boundary',()=>{const days=monthDays(new Date(2027,0,1));assert.equal(dateKey(days[0]),'2026-12-27');assert.equal(dateKey(days.at(-1)),'2027-02-06')});
test('multi-day events appear on every occupied date, excluding the midnight end',()=>{const events=[event('2026-11-05T20:00:00-06:00','2026-11-07T00:00:00-06:00')];assert.equal(dayEvents(events,new Date(2026,10,5)).length,1);assert.equal(dayEvents(events,new Date(2026,10,6)).length,1);assert.equal(dayEvents(events,new Date(2026,10,7)).length,0)});
test('local day boundaries handle daylight saving changes',()=>{const day=new Date(2026,10,1);const events=[event('2026-11-01T23:30:00-06:00','2026-11-02T00:00:00-06:00')];assert.equal(dayEvents(events,day).length,1);assert.equal(dayEvents(events,new Date(2026,10,2)).length,0)});
