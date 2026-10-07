-- Run once in Supabase > SQL Editor
create table if not exists cbs_rest_tenants (
  id         text primary key,
  name       text not null,
  key_hash   text not null,
  key_plain  text,
  active     boolean not null default true,
  data       jsonb not null,
  ts         bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table cbs_rest_tenants enable row level security;
