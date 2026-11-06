export function dateKey(d:Date):string;
export function monthDays(month:Date):Date[];
export function dayEvents<T extends {data:{start:string;end:string}}>(events:T[],day:Date):T[];
