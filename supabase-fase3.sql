-- Memories · Fase 3: equipo, foto de los novios, inspiración, idioma
-- Pegar completo en Supabase → SQL Editor → Run. Se puede correr más de una vez.

-- Columnas nuevas
alter table public.weddings  add column if not exists extra jsonb default '{}'::jsonb;
alter table public.documents add column if not exists section text;
alter table public.documents add column if not exists meta jsonb default '{}'::jsonb;
alter table public.documents add column if not exists uploaded_by uuid default auth.uid();

-- Equipo: todas las cuentas de planner de Memories ven y editan las mismas bodas
create table if not exists public.equipo (email text primary key, created_at timestamptz default now());
alter table public.equipo enable row level security;
-- Las cuentas de planner que ya existen entran al equipo
insert into public.equipo(email)
  select lower(u.email) from auth.users u join public.planner_settings p on p.planner_id = u.id
  where u.email is not null on conflict do nothing;

create or replace function public.en_equipo() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.equipo where email = public.my_email()) $$;

create or replace function public.puede(pid uuid) returns boolean language sql stable security definer set search_path = public, auth as
$$ select pid = auth.uid() or (public.en_equipo() and exists (
     select 1 from auth.users u join public.equipo e on e.email = lower(u.email) where u.id = pid)) $$;

create or replace function public.es_pareja(wid text) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.weddings w where w.id::text = wid and public.my_email() = any (w.couple_emails)) $$;

drop policy if exists "equipo lee" on public.equipo;
create policy "equipo lee" on public.equipo for select to authenticated using (public.en_equipo());
drop policy if exists "equipo agrega" on public.equipo;
create policy "equipo agrega" on public.equipo for insert to authenticated with check (public.en_equipo());
drop policy if exists "equipo quita" on public.equipo;
create policy "equipo quita" on public.equipo for delete to authenticated using (public.en_equipo());
grant select, insert, delete on public.equipo to authenticated;

-- Bodas y todo lo que cuelga de ellas: la dueña o cualquiera del equipo
drop policy if exists "planner bodas" on public.weddings;
create policy "planner bodas" on public.weddings for all to authenticated
  using (public.puede(planner_id)) with check (public.puede(planner_id));

drop policy if exists "planner privado" on public.wedding_private;
create policy "planner privado" on public.wedding_private for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)));

drop policy if exists "planner documentos" on public.documents;
create policy "planner documentos" on public.documents for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)));

drop policy if exists "planner cotizaciones" on public.quotes;
create policy "planner cotizaciones" on public.quotes for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)));

drop policy if exists "planner archivos" on storage.objects;
create policy "planner archivos" on storage.objects for all to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.weddings w where w.id::text = (storage.foldername(name))[1] and public.puede(w.planner_id)))
  with check (bucket_id = 'docs' and exists (select 1 from public.weddings w where w.id::text = (storage.foldername(name))[1] and public.puede(w.planner_id)));

-- La pareja puede subir su foto de perfil y fotos de inspiración, y borrar las suyas
drop policy if exists "pareja sube fotos" on public.documents;
create policy "pareja sube fotos" on public.documents for insert to authenticated
  with check (kind in ('perfil', 'inspiracion') and public.es_pareja(wedding_id::text));
drop policy if exists "pareja borra sus fotos" on public.documents;
create policy "pareja borra sus fotos" on public.documents for delete to authenticated
  using (uploaded_by = auth.uid() and kind in ('perfil', 'inspiracion') and public.es_pareja(wedding_id::text));

drop policy if exists "pareja sube archivos" on storage.objects;
create policy "pareja sube archivos" on storage.objects for insert to authenticated
  with check (bucket_id = 'docs' and public.es_pareja((storage.foldername(name))[1]));
drop policy if exists "pareja borra sus archivos" on storage.objects;
create policy "pareja borra sus archivos" on storage.objects for delete to authenticated
  using (bucket_id = 'docs' and owner = auth.uid() and public.es_pareja((storage.foldername(name))[1]));

-- Corrige: la pareja no podía abrir los documentos compartidos (la columna "name" era ambigua)
drop policy if exists "pareja lee archivos visibles" on storage.objects;
create policy "pareja lee archivos visibles" on storage.objects for select to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.documents d join public.weddings w on w.id = d.wedding_id
         where d.path = storage.objects.name and d.visible and public.my_email() = any (w.couple_emails)));

-- ===== Proveedores con acceso de solo lectura a la inspiración =====
create table if not exists public.wedding_vendors (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid not null references public.weddings(id) on delete cascade,
  email text not null,
  nombre text default '',
  created_at timestamptz default now(),
  unique (wedding_id, email)
);
alter table public.wedding_vendors enable row level security;
drop policy if exists "planner da acceso a proveedores" on public.wedding_vendors;
create policy "planner da acceso a proveedores" on public.wedding_vendors for all to authenticated
  using (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)))
  with check (exists (select 1 from public.weddings w where w.id = wedding_id and public.puede(w.planner_id)));
drop policy if exists "proveedor ve su acceso" on public.wedding_vendors;
create policy "proveedor ve su acceso" on public.wedding_vendors for select to authenticated using (email = public.my_email());
grant select, insert, update, delete on public.wedding_vendors to authenticated;

create or replace function public.es_proveedor(wid text) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.wedding_vendors v where v.wedding_id::text = wid and v.email = public.my_email()) $$;

-- Lo único que ve el proveedor de cada boda: nombres, fecha, lugar y la inspiración (nada de presupuesto ni itinerario)
create or replace function public.bodas_proveedor() returns table (id uuid, couple text, date date, place text, loc jsonb, insp jsonb, lang text)
  language sql stable security definer set search_path = public as
$$ select w.id, w.couple, w.date, w.place, w.loc, w.extra -> 'insp', w.extra ->> 'lang'
   from public.weddings w join public.wedding_vendors v on v.wedding_id = w.id
   where v.email = public.my_email() order by w.date $$;
grant execute on function public.bodas_proveedor() to authenticated;

drop policy if exists "proveedor ve inspiracion" on public.documents;
create policy "proveedor ve inspiracion" on public.documents for select to authenticated
  using (kind = 'inspiracion' and public.es_proveedor(wedding_id::text));
drop policy if exists "proveedor ve fotos de inspiracion" on storage.objects;
create policy "proveedor ve fotos de inspiracion" on storage.objects for select to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.documents d
         where d.path = storage.objects.name and d.kind = 'inspiracion' and public.es_proveedor(d.wedding_id::text)));

-- ===== Itinerarios en PDF compartidos con proveedores elegidos =====
drop policy if exists "proveedor ve itinerario compartido" on public.documents;
create policy "proveedor ve itinerario compartido" on public.documents for select to authenticated
  using (kind = 'itinerario' and public.es_proveedor(wedding_id::text) and coalesce(meta -> 'para', '[]'::jsonb) ? public.my_email());
drop policy if exists "proveedor abre itinerario compartido" on storage.objects;
create policy "proveedor abre itinerario compartido" on storage.objects for select to authenticated
  using (bucket_id = 'docs' and exists (select 1 from public.documents d
         where d.path = storage.objects.name and d.kind = 'itinerario' and public.es_proveedor(d.wedding_id::text)
           and coalesce(d.meta -> 'para', '[]'::jsonb) ? public.my_email()));
