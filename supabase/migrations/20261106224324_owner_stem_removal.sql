-- Recoverable owner-only removal. The private object is retained for restoration.
alter table workshop_private.files add column removed_at timestamptz, add column removed_by uuid;

create or replace function workshop_private.request(b jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 uid uuid := auth.uid();
 u auth.users%rowtype;
 m workshop_private.members%rowtype;
 target workshop_private.members%rowtype;
 stem workshop_private.files%rowtype;
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
 'files',coalesce((select jsonb_agg(to_jsonb(f)) from workshop_private.files f where f.removed_at is null),'[]'::jsonb),
 'removed_stems',case when is_owner then coalesce((select jsonb_agg(to_jsonb(f) order by removed_at desc) from workshop_private.files f where f.removed_at is not null and f.mime like 'audio/%' and f.song<>'show-files'),'[]'::jsonb) else '[]'::jsonb end,
 'members',coalesce((select jsonb_agg(case when is_owner then to_jsonb(a) else to_jsonb(a)-'email' end)
 from workshop_private.members a where is_owner or a.status='approved'),'[]'::jsonb),
 'feed_enabled',exists(select 1 from workshop_private.feeds where member_id=uid));
 end if;
 if op in ('stem_remove','stem_restore') then
 if is_owner is distinct from true then raise exception 'Only the band owner can remove or restore stems' using errcode='42501'; end if;
 select * into stem from workshop_private.files where id=(b->>'id')::uuid and mime like 'audio/%' and song<>'show-files' for update;
 if not found then raise exception 'Rehearsal stem not found'; end if;
 if (op='stem_remove' and stem.removed_at is not null) or (op='stem_restore' and stem.removed_at is null) then return '{"ok":true}'; end if;
 update workshop_private.files set removed_at=case when op='stem_remove' then now() else null end,removed_by=case when op='stem_remove' then uid else null end where id=stem.id;
 insert into workshop_private.records(id,kind,author,data) values(gen_random_uuid()::text,'audit',uid,jsonb_build_object('action',case when op='stem_remove' then 'Stem removed: ' else 'Stem restored: ' end||stem.name,'file',stem.id,'song',stem.song));
 return '{"ok":true}';
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
 if k='finance' and (d->>'amount' is null or (d->>'amount')::numeric not between -1000000 and 1000000) then raise exception 'Invalid amount'; end if;
 if k in ('comment','note') and length(trim(coalesce(d->>'text',''))) not between 1 and 5000 then raise exception 'Add a note (5000 characters maximum)'; end if;
 if k='comment' and not exists(select 1 from workshop_private.records where id=d->>'parent' and kind='suggestion') then raise exception 'Suggestion not found'; end if;
 if k in ('note','preset') and not exists(select 1 from workshop_private.records where id=d->>'song' and kind='song') then raise exception 'Song not found'; end if;
 if k='preset' and jsonb_typeof(d->'mix') is distinct from 'object' then raise exception 'Invalid mix'; end if;
 if k='vote' then
 select * into p from workshop_private.records where id=d->>'poll' and kind='poll' for share;
 if not found or (p.data->>'deadline')::timestamptz<=now() or not (p.data->'options' ? coalesce(d->>'choice','')) then raise exception 'Poll closed or invalid vote'; end if;
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

create function workshop_private.file_visible(object_path text) returns boolean
language sql stable security definer set search_path='' as $$
 select workshop_private.active(false) and exists(select 1 from workshop_private.files f where f.path=object_path and f.removed_at is null);
$$;
revoke all on function workshop_private.file_visible(text) from public,anon;
grant execute on function workshop_private.file_visible(text) to authenticated;
alter policy workshop_file_read on storage.objects to authenticated using (bucket_id='workshop-files' and workshop_private.file_visible(name));
