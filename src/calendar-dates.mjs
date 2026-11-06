export const dateKey=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
export function monthDays(month){const first=new Date(month.getFullYear(),month.getMonth(),1-month.getDay());return Array.from({length:42},(_,i)=>new Date(first.getFullYear(),first.getMonth(),first.getDate()+i))}
export function dayEvents(events,day){const end=new Date(day.getFullYear(),day.getMonth(),day.getDate()+1);return events.filter(e=>new Date(e.data.start)<end&&new Date(e.data.end)>day)}
