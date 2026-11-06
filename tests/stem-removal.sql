begin;
-- Synthetic accounts and object metadata only; no real files/accounts are changed.
create temp table stem_test as select gen_random_uuid() owner_id,gen_random_uuid() member_id,gen_random_uuid() guest_id,gen_random_uuid() suspended_id,gen_random_uuid() stem_id,gen_random_uuid() show_id;
grant select on stem_test to authenticated,anon;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select owner_id,'stem-owner@example.invalid',now(),'{}'::jsonb from stem_test union all
select member_id,'stem-member@example.invalid',now(),'{}'::jsonb from stem_test union all
select guest_id,'stem-guest@example.invalid',now(),'{}'::jsonb from stem_test union all
select suspended_id,'stem-suspended@example.invalid',now(),'{}'::jsonb from stem_test;
update workshop_private.settings set owner_email='stem-owner@example.invalid' where singleton;
insert into workshop_private.members(id,email,name,status,role)
select owner_id,'stem-owner@example.invalid','Test owner','approved','owner' from stem_test union all
select member_id,'stem-member@example.invalid','Test member','approved','member' from stem_test union all
select guest_id,'stem-guest@example.invalid','Test guest','approved','guest' from stem_test union all
select suspended_id,'stem-suspended@example.invalid','Test suspended','suspended','member' from stem_test;
insert into storage.objects(bucket_id,name,owner_id,metadata)
select 'workshop-files',member_id::text||'/'||stem_id,member_id::text,'{"mimetype":"audio/mpeg","size":100}'::jsonb from stem_test union all
select 'workshop-files',member_id::text||'/'||show_id,member_id::text,'{"mimetype":"audio/mpeg","size":100}'::jsonb from stem_test;
insert into workshop_private.files(id,song,name,mime,size,author,path)
select stem_id,'test-song','Accidental stem.mp3','audio/mpeg',100,member_id,member_id::text||'/'||stem_id from stem_test union all
select show_id,'show-files','Show reference.mp3','audio/mpeg',100,member_id,member_id::text||'/'||show_id from stem_test;
set local role authenticated;
do $$
declare t record; r jsonb; denied boolean; actor uuid;
begin
 select * into t from stem_test;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',t.member_id,'role','authenticated')::text,true);
 assert exists(select 1 from storage.objects where bucket_id='workshop-files' and name=t.member_id::text||'/'||t.stem_id),'Active stem not readable';
 foreach actor in array array[t.member_id,t.guest_id] loop
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 denied:=false;begin perform public.workshop_request(jsonb_build_object('action','stem_remove','id',t.stem_id));exception when insufficient_privilege then denied:=true;end;
 assert denied,'Non-owner removed a stem';
 end loop;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',t.owner_id,'role','authenticated')::text,true);
 perform public.workshop_request(jsonb_build_object('action','stem_remove','id',t.stem_id));
 perform public.workshop_request(jsonb_build_object('action','stem_remove','id',t.stem_id));
 r:=public.workshop_request();
 assert not exists(select 1 from jsonb_array_elements(r->'files') f where f->>'id'=t.stem_id::text),'Removed stem still listed';
 assert exists(select 1 from jsonb_array_elements(r->'removed_stems') f where f->>'id'=t.stem_id::text),'Owner recovery list missing stem';
 assert (select count(*) from jsonb_array_elements(r->'records') a where a->>'kind'='audit' and a->'data'->>'file'=t.stem_id::text)=1,'Duplicate removal audits';
 assert not exists(select 1 from storage.objects where bucket_id='workshop-files' and name=t.member_id::text||'/'||t.stem_id),'Removed stem still readable';
 denied:=false;begin perform public.workshop_request(jsonb_build_object('action','stem_remove','id',t.show_id));exception when raise_exception then denied:=true;end;
 assert denied,'Show file removed through rehearsal operation';
 foreach actor in array array[t.member_id,t.guest_id] loop
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 r:=public.workshop_request();assert r->'removed_stems'='[]'::jsonb,'Recovery metadata leaked to non-owner';
 assert not exists(select 1 from storage.objects where bucket_id='workshop-files' and name=t.member_id::text||'/'||t.stem_id),'Member fetched removed storage object';
 denied:=false;begin perform public.workshop_request(jsonb_build_object('action','stem_restore','id',t.stem_id));exception when insufficient_privilege then denied:=true;end;
 assert denied,'Non-owner restored stem';
 end loop;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',t.suspended_id,'role','authenticated')::text,true);
 r:=public.workshop_request(jsonb_build_object('action','stem_remove','id',t.stem_id));assert r->>'pending'='true','Suspended request not blocked';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',t.owner_id,'role','authenticated')::text,true);
 perform public.workshop_request(jsonb_build_object('action','stem_restore','id',t.stem_id));
 perform public.workshop_request(jsonb_build_object('action','stem_restore','id',t.stem_id));
 r:=public.workshop_request();assert exists(select 1 from jsonb_array_elements(r->'files') f where f->>'id'=t.stem_id::text),'Restored stem missing';
 assert not exists(select 1 from jsonb_array_elements(r->'removed_stems') f where f->>'id'=t.stem_id::text),'Restored stem still archived';
 assert (select count(*) from jsonb_array_elements(r->'records') a where a->>'kind'='audit' and a->'data'->>'file'=t.stem_id::text)=2,'Restore audit not idempotent';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',t.member_id,'role','authenticated')::text,true);
 assert exists(select 1 from storage.objects where bucket_id='workshop-files' and name=t.member_id::text||'/'||t.stem_id),'Restored storage access missing';
end $$;
set local role anon;
do $$ declare denied boolean:=false;begin
 begin perform public.workshop_request('{"action":"stem_remove","id":"00000000-0000-4000-8000-000000000001"}');exception when insufficient_privilege then denied:=true;end;
 assert denied,'Anonymous removal allowed';
end $$;
reset role;
rollback;
