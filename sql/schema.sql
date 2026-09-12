-- ============================================================================
-- Level Devil — schéma Supabase
-- À exécuter une fois dans : Supabase Dashboard > SQL Editor > New query
-- ============================================================================

create extension if not exists pgcrypto; -- pour gen_random_uuid()

create table if not exists public.levels (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 80),
  author      text check (author is null or char_length(author) <= 40),
  data        jsonb not null,
  plays       integer not null default 0,
  wins        integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists levels_created_at_idx on public.levels (created_at desc);
create index if not exists levels_title_idx on public.levels using gin (to_tsvector('simple', title));

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.levels enable row level security;

-- Tout le monde peut lire les niveaux publiés (le site est un site public).
create policy "levels are publicly readable"
  on public.levels for select
  to anon, authenticated
  using (true);

-- Tout le monde peut publier un niveau (pas de compte requis pour ce MVP).
-- On borne la taille des données pour éviter les abus grossiers.
create policy "anyone can publish a level"
  on public.levels for insert
  to anon, authenticated
  with check (
    jsonb_typeof(data) = 'object'
    and pg_column_size(data) < 300000 -- ~300 Ko par niveau, large marge
  );

-- Volontairement : pas de policy UPDATE / DELETE pour anon/authenticated.
-- Une fois publié, un niveau est immuable via l'API publique (on incrémente
-- les statistiques via la fonction sécurisée ci-dessous). Cela évite qu'un
-- joueur modifie ou supprime le niveau de quelqu'un d'autre.

-- ----------------------------------------------------------------------------
-- Compteurs de parties (plays / wins), via une fonction SECURITY DEFINER
-- pour pouvoir incrémenter sans ouvrir un accès UPDATE général.
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
  else
    raise exception 'unknown stat %', stat;
  end if;
end;
$$;

grant execute on function public.increment_level_stat(uuid, text) to anon, authenticated;
