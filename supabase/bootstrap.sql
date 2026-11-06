-- Remote bootstrap, applied through Supabase's migration API.
-- All records are in a non-exposed schema. Only the gated RPC is exposed.
create schema workshop_private;
revoke all on schema workshop_private from public, anon, authenticated;
grant usage on schema workshop_private to authenticated, service_role;

create table workshop_private.settings (singleton boolean primary key default true check(singleton), owner_email text not null);
insert into workshop_private.settings values (true,'chris@leavingzero.com');
create table workshop_private.members (
 id uuid primary key references auth.users(id), email text not null, name text not null,
 status text not null check(status in ('pending','approved','suspended')),
 role text not null check(role in ('owner','member','guest'))
);
create table workshop_private.records (
 id text primary key, kind text not null, author uuid not null references auth.users(id),
 data jsonb not null check(jsonb_typeof(data)='object' and octet_length(data::text)<=60000),
 version integer not null default 1, updated timestamptz not null default now()
);
create index records_kind_updated on workshop_private.records(kind,updated desc);
create index records_author on workshop_private.records(author);
create table workshop_private.files (
 id uuid primary key, song text not null, name text not null, mime text not null,
 size bigint not null check(size between 1 and 41943040),
 author uuid not null references auth.users(id), path text not null unique
);
create index files_song on workshop_private.files(song);
create index files_author on workshop_private.files(author);
create table workshop_private.feeds (
 member_id uuid primary key references auth.users(id), token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 created timestamptz not null default now()
);
alter table workshop_private.settings enable row level security;
alter table workshop_private.members enable row level security;
alter table workshop_private.records enable row level security;
alter table workshop_private.files enable row level security;
alter table workshop_private.feeds enable row level security;
revoke all on all tables in schema workshop_private from public,anon,authenticated;

-- Helpers intentionally run as definer for internal membership checks; caller identity is mandatory.
create function workshop_private.active(can_write boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(
 select 1 from workshop_private.members m where m.id=auth.uid() and m.status='approved'
 and (not can_write or m.role in ('owner','member')));
$$;
revoke all on function workshop_private.active(boolean) from public,anon;
grant execute on function workshop_private.active(boolean) to authenticated;

-- Each call validates the verified auth.users identity, then membership and operation-specific authorization.
create function workshop_private.request(b jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 u auth.users%rowtype;
 m workshop_private.members%rowtype;
 target workshop_private.members%rowtype;
 old workshop_private.records%rowtype;
 p workshop_private.records%rowtype;
 is_owner boolean;
 op text := coalesce(b->>'action','read');
 k text := b->>'kind';
 d jsonb := b->'data';
 rid text := b->>'id';
 result jsonb;
 item record;
 start_at timestamptz;
 end_at timestamptz;
begin
 if uid is null then raise exception 'Sign in required' using errcode='42501'; end if;
 select * into u from auth.users where id=uid and email_confirmed_at is not null;
 if not found then raise exception 'Confirm your email before entering the workshop' using errcode='42501'; end if;
 select lower(u.email)=lower(owner_email) into is_owner from workshop_private.settings where singleton;
 insert into workshop_private.members(id,email,name,status,role)
 values(uid,u.email,coalesce(nullif(left(u.raw_user_meta_data->>'name',120),''),split_part(u.email,'@',1)),
 case when is_owner then 'approved' else 'pending' end,case when is_owner then 'owner' else 'member' end)
 on conflict(id) do nothing;
 select * into m from workshop_private.members where id=uid;
 -- Owner identity is bound to its confirmed email, never editable metadata.
 if is_owner and m.role<>'owner' then
 update workshop_private.members set role='owner',status='approved' where id=uid;
 select * into m from workshop_private.members where id=uid;
 end if;
 if m.status<>'approved' then return jsonb_build_object('me',to_jsonb(m)||jsonb_build_object('owner',false),'pending',true); end if;
 if op='read' then
 return jsonb_build_object(
 'me',to_jsonb(m)||jsonb_build_object('owner',is_owner),
 'records',coalesce((select jsonb_agg(to_jsonb(r) order by updated desc) from workshop_private.records r
 where (r.kind<>'audit' or is_owner) and (r.kind<>'preset' or r.author=uid)),'[]'::jsonb),
 'files',coalesce((select jsonb_agg(to_jsonb(f)) from workshop_private.files f),'[]'::jsonb),
 'members',coalesce((select jsonb_agg(case when is_owner then to_jsonb(a) else to_jsonb(a)-'email' end)
 from workshop_private.members a where is_owner or a.status='approved'),'[]'::jsonb),
 'feed_enabled',exists(select 1 from workshop_private.feeds where member_id=uid));
 end if;
 if op='member' then
 if not is_owner then raise exception 'Owner only' using errcode='42501'; end if;
 select * into target from workshop_private.members where id=(b->>'id')::uuid for update;
 if not found or target.role='owner' then raise exception 'Owner account is protected'; end if;
 if coalesce(b->>'status','') not in ('pending','approved','suspended') or coalesce(b->>'role','') not in ('member','guest') then raise exception 'Invalid membership'; end if;
 update workshop_private.members set status=b->>'status',role=b->>'role' where id=target.id;
 insert into workshop_private.records(id,kind,author,data) values(gen_random_uuid()::text,'audit',uid,jsonb_build_object('action','Membership changed: '||target.email||' → '||(b->>'status')||' / '||(b->>'role')));
 return '{"ok":true}';
 end if;
 -- Read-only guests may manage their own subscription credentials, but cannot modify shared data.
 if op='feed_rotate' then
 if coalesce(b->>'hash','') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid feed credential'; end if;
 insert into workshop_private.feeds(member_id,token_hash) values(uid,b->>'hash')
 on conflict(member_id) do update set token_hash=excluded.token_hash,created=now();
 return '{"ok":true}';
 end if;
 if op='feed_revoke' then delete from workshop_private.feeds where member_id=uid; return '{"ok":true}'; end if;
 if m.role='guest' then raise exception 'Guest accounts are read only' using errcode='42501'; end if;
 if op='file' then
 if coalesce(b->>'name','')='' or length(b->>'name')>250 then raise exception 'Invalid filename'; end if;
 if not exists(select 1 from storage.objects where bucket_id='workshop-files' and name=uid::text||'/'||(b->>'id')
 and owner_id=uid::text) then raise exception 'Upload was not found'; end if;
 -- Metadata comes from the uploaded object rather than the browser's size/type claims.
 select metadata into result from storage.objects where bucket_id='workshop-files' and name=uid::text||'/'||(b->>'id');
 insert into workshop_private.files(id,song,name,mime,size,author,path)
 values((b->>'id')::uuid,coalesce(b->>'song','show-files'),b->>'name',result->>'mimetype',(result->>'size')::bigint,uid,uid::text||'/'||(b->>'id'));
 insert into workshop_private.records(id,kind,author,data) values(gen_random_uuid()::text,'audit',uid,jsonb_build_object('action','File uploaded: '||(b->>'name')));
 return '{"ok":true}';
 end if;
 if op<>'save' then raise exception 'Unsupported operation'; end if;
 if k is null or k not in ('event','song','setlist','suggestion','comment','poll','vote','rsvp','task','gear','finance','note','preset') then raise exception 'Invalid record type'; end if;
 if d is null or jsonb_typeof(d)<>'object' or octet_length(d::text)>50000 then raise exception 'Invalid record'; end if;
 for item in select key,value from jsonb_each(d) loop
 if item.key not in ('songs','options','mix') and jsonb_typeof(item.value) not in ('string','number','boolean','null') then raise exception 'Invalid field'; end if;
 end loop;
 if k in ('event','song','setlist','suggestion','poll','task','gear','finance') and (jsonb_typeof(d->'title') is distinct from 'string' or length(trim(d->>'title')) not between 1 and 300) then raise exception 'A title is required (300 characters maximum)'; end if;
 if k='event' then
 start_at:=(d->>'start')::timestamptz; end_at:=(d->>'end')::timestamptz;
 if start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at) or end_at<=start_at or coalesce(d->>'type','') not in ('rehearsal','gig','unavailable') then raise exception 'Invalid event dates or type'; end if;
 end if;
 if k='poll' then
 end_at:=(d->>'deadline')::timestamptz;
 if end_at is null or not isfinite(end_at) or jsonb_typeof(d->'options') is distinct from 'array' then raise exception 'Poll needs a deadline and options'; end if;
 if jsonb_array_length(d->'options') not between 2 and 20 or exists(select 1 from jsonb_array_elements(d->'options') o where jsonb_typeof(o)<>'string' or length(o#>>'{}') not between 1 and 300)
 or (select count(distinct o) from jsonb_array_elements(d->'options') o)<>jsonb_array_length(d->'options') then raise exception 'Use 2–20 unique text options'; end if;
 end if;
 if k='setlist' then
 if jsonb_typeof(d->'songs') is distinct from 'array' then raise exception 'Select songs in order'; end if;
 if jsonb_array_length(d->'songs')>100 or exists(select 1 from jsonb_array_elements_text(d->'songs') s where not exists(select 1 from workshop_private.records where id=s and kind='song')) then raise exception 'Unknown song'; end if;
 end if;
 if k='finance' and (d->>'amount')::numeric not between -1000000 and 1000000 then raise exception 'Invalid amount'; end if;
 if k in ('comment','note') and length(trim(coalesce(d->>'text',''))) not between 1 and 5000 then raise exception 'Add a note (5000 characters maximum)'; end if;
 if k='comment' and not exists(select 1 from workshop_private.records where id=d->>'parent' and kind='suggestion') then raise exception 'Suggestion not found'; end if;
 if k in ('note','preset') and not exists(select 1 from workshop_private.records where id=d->>'song' and kind='song') then raise exception 'Song not found'; end if;
 if k='preset' and jsonb_typeof(d->'mix') is distinct from 'object' then raise exception 'Invalid mix'; end if;
 if k='vote' then
 select * into p from workshop_private.records where id=d->>'poll' and kind='poll' for share;
 if not found or (p.data->>'deadline')::timestamptz<=now() or not (p.data->'options' ? (d->>'choice')) then raise exception 'Poll closed or invalid vote'; end if;
 rid:='vote:'||(d->>'poll')||':'||uid::text;
 end if;
 if k='rsvp' then
 if coalesce(d->>'response','') not in ('yes','no','maybe') or not exists(select 1 from workshop_private.records where id=d->>'event' and kind='event') then raise exception 'Invalid event response'; end if;
 rid:='rsvp:'||(d->>'event')||':'||uid::text;
 end if;
 if k='preset' then rid:='preset:'||(d->>'song')||':'||uid::text; end if;
 if rid is not null and length(rid)>250 then raise exception 'Invalid ID'; end if;
 if rid is null then rid:=gen_random_uuid()::text;
 elsif k not in ('vote','preset','rsvp') and not exists(select 1 from workshop_private.records where id=rid) then raise exception 'Record not found'; end if;
 -- Serialize per ID, including first writes, to make unique votes/presets and optimistic versions race-safe.
 perform pg_advisory_xact_lock(hashtextextended(rid,0));
 select * into old from workshop_private.records where id=rid for update;
 if found then
 if old.kind<>k or (old.author<>uid and not is_owner) then raise exception 'Only the author or owner can edit' using errcode='42501'; end if;
 if k not in ('vote','preset','rsvp') and (b->>'version')::integer is distinct from old.version then raise exception 'Changed by another member. Refresh before editing.' using errcode='40001'; end if;
 if k='setlist' then insert into workshop_private.records(id,kind,author,data)
 values(gen_random_uuid()::text,'setlist-history',uid,old.data||jsonb_build_object('setlist',old.id,'version',old.version)); end if;
 update workshop_private.records set data=d,version=version+1,updated=now() where id=rid;
 else insert into workshop_private.records(id,kind,author,data) values(rid,k,uid,d);
 end if;
 insert into workshop_private.records(id,kind,author,data) values(gen_random_uuid()::text,'audit',uid,jsonb_build_object('action',k||' saved: '||rid));
 return jsonb_build_object('ok',true,'id',rid);
end $$;
revoke all on function workshop_private.request(jsonb) from public,anon;
grant execute on function workshop_private.request(jsonb) to authenticated;
create function public.workshop_request(b jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select workshop_private.request(b); $$;
revoke all on function public.workshop_request(jsonb) from public,anon;
grant execute on function public.workshop_request(jsonb) to authenticated;

-- Calendar gateway uses a service-only RPC and a random 256-bit per-user feed token hash.
-- No user identity is implied by service access: this function separately validates feed ownership/membership.
create function workshop_private.calendar_feed(h text) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from workshop_private.feeds f join workshop_private.members m on m.id=f.member_id
 where f.token_hash=h and m.status='approved') then
 jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(r) order by updated) from workshop_private.records r where kind='event'),'[]'::jsonb))
 else null end;
$$;
revoke all on function workshop_private.calendar_feed(text) from public,anon,authenticated;
grant execute on function workshop_private.calendar_feed(text) to service_role;
create function public.workshop_calendar_feed(h text) returns jsonb
language sql security invoker set search_path='' as $$ select workshop_private.calendar_feed(h); $$;
revoke all on function public.workshop_calendar_feed(text) from public,anon,authenticated;
grant execute on function public.workshop_calendar_feed(text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('workshop-files','workshop-files',false,41943040,
array['audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/flac','audio/ogg','application/pdf','text/plain','image/png','image/jpeg']);
create policy workshop_file_read on storage.objects for select to authenticated
using(bucket_id='workshop-files' and (select workshop_private.active(false)));
create policy workshop_file_insert on storage.objects for insert to authenticated
with check(bucket_id='workshop-files' and (select workshop_private.active(true)) and (storage.foldername(name))[1]=(select auth.uid())::text);
-- No UPDATE/DELETE policies: uploads cannot replace existing files or alter their ownership.
