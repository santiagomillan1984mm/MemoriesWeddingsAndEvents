-- Memories Weddings & Events · estructura de la base de datos (Fase 1)
-- Pegar completo en Supabase → SQL Editor → Run. Se puede correr más de una vez.

create extension if not exists pgcrypto;

-- Bodas
create table if not exists public.weddings (
  id uuid primary key default gen_random_uuid(),
  planner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  couple text default '',
  date date,
  guests int default 0,
  place text default '',
  loc jsonb default '{}'::jsonb,
  style text default '',
  currency text default 'MXN',
  couple_emails text[] default '{}',
  itinerary jsonb default '{}'::jsonb,
  budget jsonb default '{}'::jsonb,
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Notas privadas de la planner (la pareja nunca las ve)
create table if not exists public.wedding_private (
  wedding_id uuid primary key references public.weddings(id) on delete cascade,
  data jsonb default '{}'::jsonb
);

-- Documentos
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  name text not null,
  path text not null,
  mime text,
  size bigint,
  kind text default 'otro',
  visible boolean default true,
  created_at timestamptz default now()
);

-- Ajustes de la planner (plantilla de itinerario, etc.). Tener fila aquí = ser planner.
create table if not exists public.planner_settings (
  planner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb default '{}'::jsonb
);

alter table public.weddings enable row level security;
alter table public.wedding_private enable row level security;
alter table public.documents enable row level security;
alter table public.planner_settings enable row level security;

-- Correo del usuario que inició sesión, en minúsculas
create or replace function public.my_email() returns text language sql stable as
$$ select lower(coalesce(auth.jwt() ->> 'email','')) $$;

-- Bodas: la planner hace todo con las suyas; la pareja solo lee la suya
drop policy if exists "planner bodas" on public.weddings;
create policy "planner bodas" on public.weddings for all to authenticated
  using (planner_id = auth.uid()) with check (planner_id = auth.uid());
drop policy if exists "pareja lee su boda" on public.weddings;
create policy "pareja lee su boda" on public.weddings for select to authenticated
  using (public.my_email() = any (couple_emails));

drop policy if exists "planner privado" on public.wedding_private;
create policy "planner privado" on public.wedding_private for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()));

drop policy if exists "planner documentos" on public.documents;
create policy "planner documentos" on public.documents for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()));
drop policy if exists "pareja lee documentos visibles" on public.documents;
create policy "pareja lee documentos visibles" on public.documents for select to authenticated
  using (visible and exists (select 1 from public.weddings w where w.id = wedding_id and public.my_email() = any (w.couple_emails)));

drop policy if exists "planner ajustes" on public.planner_settings;
create policy "planner ajustes" on public.planner_settings for all to authenticated
  using (planner_id = auth.uid()) with check (planner_id = auth.uid());

-- Archivos (bucket privado "docs", carpetas por boda)
insert into storage.buckets (id, name, public) values ('docs','docs',false) on conflict (id) do nothing;

drop policy if exists "planner archivos" on storage.objects;
create policy "planner archivos" on storage.objects for all to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.weddings w where w.id::text = (storage.foldername(name))[1] and w.planner_id = auth.uid()))
  with check (bucket_id = 'docs' and exists (select 1 from public.weddings w where w.id::text = (storage.foldername(name))[1] and w.planner_id = auth.uid()));
drop policy if exists "pareja lee archivos visibles" on storage.objects;
create policy "pareja lee archivos visibles" on storage.objects for select to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.documents d join public.weddings w on w.id = d.wedding_id
         where d.path = name and d.visible and public.my_email() = any (w.couple_emails)));

-- Cambios en tiempo real (la pareja ve las actualizaciones al momento)
do $$ begin
  begin alter publication supabase_realtime add table public.weddings; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end;
end $$;

grant select, insert, update, delete on public.weddings, public.wedding_private, public.documents, public.planner_settings to authenticated;

-- ===== Fase 2: cotizaciones =====
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  doc_id uuid references public.documents(id) on delete set null,
  status text default 'revisar',
  vendor text default '',
  category text default 'Otros',
  currency text default 'MXN',
  total numeric default 0,
  data jsonb default '{}'::jsonb,
  budget_item_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.quotes enable row level security;
drop policy if exists "planner cotizaciones" on public.quotes;
create policy "planner cotizaciones" on public.quotes for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and w.planner_id = auth.uid()));
grant select, insert, update, delete on public.quotes to authenticated;
do $$ begin
  begin alter publication supabase_realtime add table public.quotes; exception when duplicate_object then null; end;
end $$;
