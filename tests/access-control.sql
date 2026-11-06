begin;
-- Synthetic accounts and test data exist only inside this rolled-back transaction.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
('00000000-0000-4000-8000-000000000101','chris@leavingzero.com',now(),'{"name":"Test owner"}'),
('00000000-0000-4000-8000-000000000102','workshop-member@example.invalid',now(),'{"name":"Test member"}'),
('00000000-0000-4000-8000-000000000103','workshop-other@example.invalid',now(),'{"name":"Test other"}');
do $$
declare r jsonb; song_id text; poll_id text; blocked boolean;
begin
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated"}',true);
 r:=public.workshop_request();
 assert r->'me'->>'owner'='true','Owner not recognized';
 assert r->'me'->>'role'='owner','Owner role not assigned';
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000102","role":"authenticated"}',true);
 r:=public.workshop_request();
 assert r->>'pending'='true','New account was not pending';
 r:=public.workshop_request('{"action":"save","kind":"song","data":{"title":"Should not save"}}');
 assert r->>'pending'='true','Pending account write not blocked';
 assert not exists(select 1 from workshop_private.records where data->>'title'='Should not save');
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated"}',true);
 perform public.workshop_request('{"action":"member","id":"00000000-0000-4000-8000-000000000102","status":"approved","role":"member"}');
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000102","role":"authenticated"}',true);
 blocked:=false;
 begin perform public.workshop_request('{"action":"member","id":"00000000-0000-4000-8000-000000000102","status":"approved","role":"owner"}'); exception when insufficient_privilege then blocked:=true; end;
 assert blocked,'Member administered an account';
 r:=public.workshop_request('{"action":"save","kind":"song","data":{"title":"Test song"}}');song_id:=r->>'id';
 blocked:=false;
 begin perform public.workshop_request(jsonb_build_object('action','save','kind','song','id',song_id,'version',0,'data',jsonb_build_object('title','Stale')));
 exception when serialization_failure then blocked:=true; end;
 assert blocked,'Stale edit accepted';
 perform public.workshop_request(jsonb_build_object('action','save','kind','song','id',song_id,'version',1,'data',jsonb_build_object('title','Updated')));
 r:=public.workshop_request(jsonb_build_object('action','save','kind','poll','data',jsonb_build_object('title','Pick a song','deadline',now()+interval '1 day','options',jsonb_build_array('A','B'))));
 poll_id:=r->>'id';
 perform public.workshop_request(jsonb_build_object('action','save','kind','vote','data',jsonb_build_object('poll',poll_id,'choice','A')));
 perform public.workshop_request(jsonb_build_object('action','save','kind','vote','data',jsonb_build_object('poll',poll_id,'choice','B')));
 assert (select count(*) from workshop_private.records where kind='vote' and data->>'poll'=poll_id)=1,'Duplicate votes accepted';
 assert (select data->>'choice' from workshop_private.records where kind='vote' and data->>'poll'=poll_id)='B','Vote change failed';
 r:=public.workshop_request('{"action":"read"}');
 assert not exists(select 1 from jsonb_array_elements(r->'records') a where a->>'kind'='audit'),'Member read audit records';
 assert not exists(select 1 from jsonb_array_elements(r->'members') a where a ? 'email'),'Member read roster emails';
 perform public.workshop_request(jsonb_build_object('action','feed_rotate','hash',repeat('a',64)));
 assert workshop_private.calendar_feed(repeat('a',64)) is not null,'Feed token failed';
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000103","role":"authenticated"}',true);
 perform public.workshop_request();
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated"}',true);
 perform public.workshop_request('{"action":"member","id":"00000000-0000-4000-8000-000000000103","status":"approved","role":"guest"}');
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000103","role":"authenticated"}',true);
 blocked:=false;
 begin perform public.workshop_request('{"action":"save","kind":"task","data":{"title":"Guest write"}}'); exception when insufficient_privilege then blocked:=true; end;
 assert blocked,'Guest write accepted';
 assert not workshop_private.active(true),'Guest upload allowed';
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated"}',true);
 perform public.workshop_request('{"action":"member","id":"00000000-0000-4000-8000-000000000102","status":"suspended","role":"member"}');
 assert workshop_private.calendar_feed(repeat('a',64)) is null,'Suspended feed still readable';
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000102","role":"authenticated"}',true);
 assert not workshop_private.active(false),'Suspended storage readable';
 r:=public.workshop_request(); assert r->>'pending'='true','Suspended account read data';
end $$;
set local role authenticated;
do $$
declare blocked boolean:=false;
begin
 assert not has_table_privilege('authenticated','workshop_private.records','SELECT'),'Direct table grant';
 assert not has_function_privilege('anon','public.workshop_request(jsonb)','EXECUTE'),'Anonymous RPC access';
 assert not has_function_privilege('authenticated','public.workshop_calendar_feed(text)','EXECUTE'),'Member service-feed access';
 begin perform * from workshop_private.records; exception when insufficient_privilege then blocked:=true; end;
 assert blocked,'Direct table access accepted';
 assert (public.workshop_request()->>'pending')='true','Suspension bypassed through real role';
end $$;
reset role;
rollback;
select 'PASS: owner bootstrap, pending approval, admin isolation, persistence, stale edits, unique votes, audit/email privacy, feed revocation, read-only guests, suspension' as result;
