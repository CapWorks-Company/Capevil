// Thin wrapper around the Supabase JS client + level publish/browse helpers.
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED } from './config.js';
import { normalizeLevel } from './level-model.js';

let _client = null;
async function getClient() {
  if (!IS_CONFIGURED) return null;
  if (_client) return _client;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

export async function isBackendReady() {
  return IS_CONFIGURED;
}

export async function publishLevel(level) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const payload = {
    title: level.title,
    author: level.author || null,
    data: level,
  };
  const { data, error } = await client.from('levels').insert(payload).select('id, created_at').single();
  if (error) throw error;
  return data; // { id, created_at }
}

export async function listLevels({ search = '', limit = 30, offset = 0 } = {}) {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  let query = client
    .from('levels')
    .select('id, title, author, plays, wins, created_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (search && search.trim()) query = query.ilike('title', `%${search.trim()}%`);
  const { data, error } = await query;
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

export async function getLevel(id) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { data, error } = await client.from('levels').select('id, title, author, data, plays, wins').eq('id', id).single();
  if (error) throw error;
  const level = normalizeLevel({ ...data.data, id: data.id, title: data.title, author: data.author });
  return { level, plays: data.plays, wins: data.wins };
}

export async function recordPlay(id) {
  const client = await getClient();
  if (!client) return;
  await client.rpc('increment_level_stat', { level_id: id, stat: 'plays' });
}

export async function recordWin(id) {
  const client = await getClient();
  if (!client) return;
  await client.rpc('increment_level_stat', { level_id: id, stat: 'wins' });
}
