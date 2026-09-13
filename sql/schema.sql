-- ============================================================================
-- Level Devil — schéma Supabase
-- À exécuter une fois dans : Supabase Dashboard > SQL Editor > New query
-- (Idempotent : peut être ré-exécuté sans casser une base déjà en place.)
-- ============================================================================

create extension if not exists pgcrypto; -- pour gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Comptes joueurs : Supabase Auth gère email + mot de passe (table
-- auth.users, privée). On garde ici juste un profil public minimal (le nom
-- d'auteur affiché), rempli automatiquement à l'inscription.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 40),
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Colonne ajoutée après la v1 : sans effet si elle existe déjà.
alter table public.profiles add column if not exists is_admin boolean not null default false;

alter table public.profiles enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable"
  on public.profiles for select
  to anon, authenticated
  using (true);

-- Volontairement pas de policy UPDATE ici : une policy `id = auth.uid()`
-- suffirait à corriger le nom d'affichage, mais laisserait aussi n'importe
-- quel joueur s'auto-promouvoir en écrivant `is_admin = true` sur sa propre
-- ligne (RLS s'applique par ligne, pas par colonne). Personne — pas même le
-- propriétaire du profil — ne peut modifier `profiles` depuis le client ;
-- `is_admin` ne se change qu'à la main dans le Dashboard (voir plus haut).

-- Crée automatiquement un profil (nom d'auteur) à l'inscription. Le nom
-- vient de `options.data.display_name` passé à `supabase.auth.signUp(...)`,
-- avec un repli sur la partie avant le "@" de l'email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Admin role. Regular players can self-register (see `handle_new_user`
-- above), so "authenticated" alone can no longer mean "admin" — otherwise
-- any player could approve their own level. The single admin account is
-- promoted by hand, once, by the site owner running:
--   update public.profiles set is_admin = true where id =
--     (select id from auth.users where email = 'admin@example.com');
-- ----------------------------------------------------------------------------
create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Lets the admin UI check "am I an admin?" without tripping an error on a
-- plain player account (unlike calling an admin-only function and catching
-- the exception).
grant execute on function public.is_admin_user() to authenticated;

-- ----------------------------------------------------------------------------
-- Niveaux
-- ----------------------------------------------------------------------------
create table if not exists public.levels (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid references auth.users(id) on delete set null,
  title               text not null check (char_length(title) between 1 and 80),
  author              text check (author is null or char_length(author) <= 40),
  data                jsonb not null,
  plays               integer not null default 0,
  wins                integer not null default 0,
  likes               integer not null default 0,
  approved            boolean not null default false,
  approval_requested  boolean not null default false,
  created_at          timestamptz not null default now()
);

-- Colonnes ajoutées après la v1 : sans effet si elles existent déjà.
alter table public.levels add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.levels add column if not exists likes integer not null default 0;
alter table public.levels add column if not exists approved boolean not null default false;
alter table public.levels add column if not exists approval_requested boolean not null default false;

create index if not exists levels_created_at_idx on public.levels (created_at desc);
create index if not exists levels_title_idx on public.levels using gin (to_tsvector('simple', title));
create index if not exists levels_approved_idx on public.levels (approved) where approved = true;
create index if not exists levels_owner_idx on public.levels (owner_id);

-- Un niveau publié doit toujours avoir : un point de départ, au moins un
-- bloc/plateforme solide pour servir d'appui, et une case "but". On revalide
-- côté serveur (en plus de la validation faite dans l'éditeur) pour ne pas
-- dépendre uniquement du client.
create or replace function public.is_level_data_valid(lvl jsonb)
returns boolean
language sql
immutable
as $$
  select
    jsonb_typeof(lvl) = 'object'
    and lvl ? 'playerStart'
    and jsonb_typeof(lvl->'entities') = 'array'
    and exists (
      select 1 from jsonb_array_elements(lvl->'entities') e
      where e->>'type' = 'goal'
    )
    and exists (
      select 1 from jsonb_array_elements(lvl->'entities') e
      where e->>'type' in ('block', 'platform')
    );
$$;

-- Referenced from the INSERT policy's WITH CHECK below, so it must be
-- callable by the same roles that are allowed to insert/update a level.
grant execute on function public.is_level_data_valid(jsonb) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Row Level Security — levels
-- ----------------------------------------------------------------------------
alter table public.levels enable row level security;

-- Tout le monde peut lire les niveaux publiés (le site est un site public).
drop policy if exists "levels are publicly readable" on public.levels;
create policy "levels are publicly readable"
  on public.levels for select
  to anon, authenticated
  using (true);

-- Publier un niveau nécessite désormais un compte : l'auteur affiché est
-- toujours celui du compte connecté (jamais un texte libre), forcé par le
-- trigger ci-dessous — pas par la policy elle-même.
drop policy if exists "anyone can publish a level" on public.levels;
drop policy if exists "authenticated users can publish a level" on public.levels;
create policy "authenticated users can publish a level"
  on public.levels for insert
  to authenticated
  with check (
    owner_id = auth.uid()
    and pg_column_size(data) < 300000 -- ~300 Ko par niveau, large marge
    and public.is_level_data_valid(data)
  );

-- Volontairement : pas de policy UPDATE / DELETE pour anon/authenticated,
-- même pour le propriétaire. Modifier ou supprimer son propre niveau passe
-- uniquement par les fonctions SECURITY DEFINER `update_own_level` /
-- `delete_own_level` ci-dessous (qui, elles, contournent RLS et ne touchent
-- jamais que les colonnes prévues) — exactement le même principe que pour
-- les compteurs plus haut. Ça évite qu'un appel `.update()` générique côté
-- client ne modifie plays/wins/likes/approved en plus du contenu.

-- Force author = profil du compte connecté et owner_id = auth.uid() à la
-- création, même si le client envoie autre chose (défense en profondeur en
-- plus de la policy INSERT). Ne s'applique volontairement qu'à l'INSERT :
-- les UPDATE viennent uniquement des fonctions SECURITY DEFINER ci-dessous,
-- qui ne touchent chacune que les colonnes qui les concernent — un trigger
-- qui interviendrait aussi sur UPDATE écraserait leurs changements (ex. le
-- compteur de likes) en les remettant à l'ancienne valeur à chaque fois.
create or replace function public.set_level_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.owner_id := auth.uid();
  select display_name into new.author from public.profiles where id = auth.uid();
  if new.author is null then
    raise exception 'no profile for current user';
  end if;
  return new;
end;
$$;

drop trigger if exists set_level_author_on_insert on public.levels;
create trigger set_level_author_on_insert
  before insert on public.levels
  for each row execute function public.set_level_author();

drop trigger if exists set_level_author_on_update on public.levels;

-- ----------------------------------------------------------------------------
-- Compteurs de parties (plays / wins / likes), via une fonction
-- SECURITY DEFINER pour pouvoir incrémenter sans ouvrir un accès UPDATE général.
-- ----------------------------------------------------------------------------
create or replace function public.increment_level_stat(level_id uuid, stat text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if stat = 'plays' then
    update public.levels set plays = plays + 1 where id = level_id;
  elsif stat = 'wins' then
    update public.levels set wins = wins + 1 where id = level_id;
  elsif stat = 'likes' then
    update public.levels set likes = likes + 1 where id = level_id;
  else
    raise exception 'unknown stat %', stat;
  end if;
end;
$$;

grant execute on function public.increment_level_stat(uuid, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Demande d'approbation : n'importe quel joueur connecté peut demander qu'un
-- admin examine un niveau pour l'ajouter aux "Parties officielles".
-- ----------------------------------------------------------------------------
create or replace function public.request_level_approval(level_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.levels
    set approval_requested = true
    where id = level_id and approved = false;
end;
$$;

grant execute on function public.request_level_approval(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Approbation admin : réservée aux comptes avec `profiles.is_admin = true`
-- (voir `is_admin_user()` plus haut) — promu à la main par le propriétaire
-- du site, jamais via l'app elle-même.
-- ----------------------------------------------------------------------------
create or replace function public.set_level_approved(level_id uuid, is_approved boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_user() then
    raise exception 'admin only';
  end if;
  update public.levels
    set approved = is_approved,
        approval_requested = case when is_approved then false else approval_requested end
    where id = level_id;
end;
$$;

grant execute on function public.set_level_approved(uuid, boolean) to authenticated;

create or replace function public.list_pending_approvals()
returns setof public.levels
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_user() then
    raise exception 'admin only';
  end if;
  return query select * from public.levels where approval_requested = true and approved = false order by created_at asc;
end;
$$;

grant execute on function public.list_pending_approvals() to authenticated;

-- ----------------------------------------------------------------------------
-- Modifier / supprimer son propre niveau. Des fonctions dédiées (plutôt que
-- de compter uniquement sur les policies UPDATE/DELETE ci-dessus) permettent
-- de revalider le contenu et de renvoyer une erreur claire.
-- ----------------------------------------------------------------------------
create or replace function public.update_own_level(level_id uuid, new_title text, new_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_level_data_valid(new_data) then
    raise exception 'invalid level data';
  end if;
  update public.levels
    set title = new_title, data = new_data
    where id = level_id and owner_id = auth.uid();
  if not found then
    raise exception 'not found or not owner';
  end if;
end;
$$;

grant execute on function public.update_own_level(uuid, text, jsonb) to authenticated;

create or replace function public.delete_own_level(level_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.levels where id = level_id and owner_id = auth.uid();
  if not found then
    raise exception 'not found or not owner';
  end if;
end;
$$;

grant execute on function public.delete_own_level(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Signalement : volontairement limité aux parties "officielles" (déjà
-- validées par un admin) — ce sont les seules mises en avant à tout le monde,
-- donc les seules qui valent la peine d'être surveillées après coup.
-- ----------------------------------------------------------------------------
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  level_id     uuid not null references public.levels(id) on delete cascade,
  reporter_id  uuid not null references auth.users(id) on delete cascade,
  reason       text not null check (char_length(reason) between 1 and 300),
  created_at   timestamptz not null default now()
);

alter table public.reports enable row level security;
-- Pas de policy SELECT/INSERT publique : tout passe par les fonctions
-- SECURITY DEFINER ci-dessous, qui contrôlent les règles métier.

create or replace function public.report_level(level_id uuid, reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  lvl_approved boolean;
begin
  select approved into lvl_approved from public.levels where id = level_id;
  if lvl_approved is not true then
    raise exception 'only approved (official) levels can be reported';
  end if;
  insert into public.reports (level_id, reporter_id, reason)
  values (level_id, auth.uid(), coalesce(nullif(trim(reason), ''), 'Signalement sans motif précisé'));
end;
$$;

grant execute on function public.report_level(uuid, text) to authenticated;

create or replace function public.list_reports()
returns table (id uuid, level_id uuid, level_title text, reason text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_user() then
    raise exception 'admin only';
  end if;
  return query
    select r.id, r.level_id, l.title, r.reason, r.created_at
    from public.reports r join public.levels l on l.id = r.level_id
    order by r.created_at desc;
end;
$$;

grant execute on function public.list_reports() to authenticated;

create or replace function public.dismiss_report(report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin_user() then
    raise exception 'admin only';
  end if;
  delete from public.reports where id = report_id;
end;
$$;

grant execute on function public.dismiss_report(uuid) to authenticated;
