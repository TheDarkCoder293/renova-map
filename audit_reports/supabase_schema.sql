create extension if not exists pgcrypto;

create table if not exists reviewers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  processed_count integer not null default 0,
  edit_count integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists clinic_reviews (
  id uuid primary key default gen_random_uuid(),
  clinic_id integer not null,
  reviewer_name text not null,
  decision text not null check (decision in ('keep', 'remove', 'research')),
  label text,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (clinic_id, reviewer_name)
);

create table if not exists merge_reviews (
  id uuid primary key default gen_random_uuid(),
  group_key text not null,
  reviewer_name text not null,
  keep_clinic_id integer not null,
  field_sources jsonb not null default '{}'::jsonb,
  merged_values jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (group_key, reviewer_name)
);

alter table reviewers enable row level security;
alter table clinic_reviews enable row level security;
alter table merge_reviews enable row level security;

create policy if not exists "reviewers public read"
on reviewers for select to anon using (true);

create policy if not exists "reviewers public write"
on reviewers for all to anon using (true) with check (true);

create policy if not exists "clinic_reviews public read"
on clinic_reviews for select to anon using (true);

create policy if not exists "clinic_reviews public write"
on clinic_reviews for all to anon using (true) with check (true);

create policy if not exists "merge_reviews public read"
on merge_reviews for select to anon using (true);

create policy if not exists "merge_reviews public write"
on merge_reviews for all to anon using (true) with check (true);
