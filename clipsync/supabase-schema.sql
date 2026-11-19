-- =====================================================================
-- ClipSync — Supabase schema.  Run once in: Dashboard → SQL Editor → New query
-- =====================================================================

-- ---------- Tables ----------
create table if not exists public.devices (
  id           uuid primary key,                       -- generated once per browser install
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 60),
  type         text not null default 'other' check (type in ('desktop','phone','tablet','other')),
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.clips (
  id          uuid primary key,                        -- client-generated => idempotent retries
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content     text not null default '',
  device_id   uuid,
  device_name text not null default '',                -- snapshot of the origin device's label
  pinned      boolean not null default false,
  favorite    boolean not null default false,
  tags        text[]  not null default '{}',
  created_at  timestamptz not null default now(),      -- client may supply (offline creation time)
  updated_at  timestamptz not null default now(),      -- always set by trigger (server clock)
  deleted_at  timestamptz,                             -- soft delete (tombstone, content is scrubbed)
  constraint clips_content_len check (char_length(content) <= 100000),
  constraint clips_content_required check (deleted_at is not null or char_length(content) >= 1),
  constraint clips_tags_len check (cardinality(tags) <= 20)
);
create index if not exists clips_user_updated_idx on public.clips (user_id, updated_at desc);
create index if not exists clips_user_created_idx on public.clips (user_id, created_at desc);

create table if not exists public.user_settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ---------- Triggers ----------
-- Server-controlled timestamps, immutable ownership, and scrubbing of deleted text.
create or replace function public.clipsync_touch() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id    := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.clipsync_scrub() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    new.content := '';          -- deleted text is erased from the server immediately
  end if;
  return new;
end $$;

drop trigger if exists clips_scrub on public.clips;
create trigger clips_scrub before insert or update on public.clips
  for each row execute function public.clipsync_scrub();
drop trigger if exists clips_touch on public.clips;
create trigger clips_touch before insert or update on public.clips
  for each row execute function public.clipsync_touch();
drop trigger if exists settings_touch on public.user_settings;
create trigger settings_touch before insert or update on public.user_settings
  for each row execute function public.clipsync_touch();

-- ---------- Row Level Security ----------
alter table public.clips         enable row level security;
alter table public.devices       enable row level security;
alter table public.user_settings enable row level security;

-- clips
drop policy if exists clips_select on public.clips;
drop policy if exists clips_insert on public.clips;
drop policy if exists clips_update on public.clips;
drop policy if exists clips_delete on public.clips;
create policy clips_select on public.clips for select to authenticated using (user_id = (select auth.uid()));
create policy clips_insert on public.clips for insert to authenticated with check (user_id = (select auth.uid()));
create policy clips_update on public.clips for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy clips_delete on public.clips for delete to authenticated using (user_id = (select auth.uid()));

-- devices
drop policy if exists devices_select on public.devices;
drop policy if exists devices_insert on public.devices;
drop policy if exists devices_update on public.devices;
drop policy if exists devices_delete on public.devices;
create policy devices_select on public.devices for select to authenticated using (user_id = (select auth.uid()));
create policy devices_insert on public.devices for insert to authenticated with check (user_id = (select auth.uid()));
create policy devices_update on public.devices for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy devices_delete on public.devices for delete to authenticated using (user_id = (select auth.uid()));

-- user_settings
drop policy if exists settings_select on public.user_settings;
drop policy if exists settings_insert on public.user_settings;
drop policy if exists settings_update on public.user_settings;
drop policy if exists settings_delete on public.user_settings;
create policy settings_select on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy settings_insert on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy settings_update on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy settings_delete on public.user_settings for delete to authenticated using (user_id = (select auth.uid()));

-- The "anon" role has no policies => it can read and write nothing.

-- ---------- Realtime: row changes ----------
alter publication supabase_realtime add table public.clips;
alter publication supabase_realtime add table public.devices;

-- ---------- Realtime: private presence channel "clipsync:<user_id>" ----------
drop policy if exists "clipsync presence read"  on realtime.messages;
drop policy if exists "clipsync presence write" on realtime.messages;
create policy "clipsync presence read" on realtime.messages for select to authenticated
  using (realtime.topic() = 'clipsync:' || (select auth.uid())::text);
create policy "clipsync presence write" on realtime.messages for insert to authenticated
  with check (realtime.topic() = 'clipsync:' || (select auth.uid())::text);

-- ---------- Housekeeping ----------
-- Removes tombstones older than 30 days (called by the app at most once a day). RLS still applies.
create or replace function public.purge_old_deleted() returns integer
language plpgsql security invoker as $$
declare n integer;
begin
  delete from public.clips
   where user_id = auth.uid() and deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
