// ---------------------------------------------------------------------------
// Configuration Supabase.
//
// La clé "anon" de Supabase est faite pour être publique (elle est visible
// dans le navigateur de tous les joueurs) : la sécurité vient des règles
// Row Level Security (RLS) définies dans sql/schema.sql, pas du secret de
// cette clé. Ne mets JAMAIS ta clé "service_role" ici.
//
// Remplace les deux valeurs ci-dessous par celles de ton projet Supabase
// (Project Settings > API).
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://jvxabltswaxmveaziasj.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2eGFibHRzd2F4bXZlYXppYXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDUyMzAsImV4cCI6MjEwNDc4MTIzMH0.pcgTy_HdQR5utRsC2kukAxYRnNnnEfdBNXpCGjik7wU';

export const IS_CONFIGURED =
  !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.includes('YOUR-ANON-PUBLIC-KEY');
