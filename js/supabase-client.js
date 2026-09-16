// Thin wrapper around the Supabase JS client + level publish/browse helpers.
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED } from './config.js';
import { normalizeLevel } from './level-model.js';

let _client = null;
let _loadFailed = false;
// Loading the Supabase SDK itself needs the network (a CDN fetch) — on top
// of the usual "Supabase not configured" case, that fetch can also fail (no
// connectivity, a blocked CDN, an ad/script blocker). Every caller here
// already treats a null client as "backend unavailable", so this must never
// throw: degrade to null instead of taking down whatever awaited it.
async function getClient() {
  if (!IS_CONFIGURED || _loadFailed) return null;
  if (_client) return _client;
  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return _client;
  } catch (err) {
    _loadFailed = true;
    console.error('Capevil: impossible de charger le client Supabase (réseau ?)', err);
    return null;
  }
}

const LEVEL_LIST_COLUMNS = 'id, owner_id, title, author, plays, wins, likes, approved, approval_requested, created_at';

export async function isBackendReady() {
  return IS_CONFIGURED;
}

// Distinct from isBackendReady(): that one only checks the static config
// (URL/key look filled in), this one actually confirms the Supabase SDK
// loaded — the one thing that can still fail even when configured (the CDN
// fetch itself, see getClient() above: no connectivity, a blocked CDN, an
// ad/script blocker). Used to bypass the editor's login gate (see editor.js)
// rather than permanently locking everyone out of building levels the
// moment that one fetch has a bad day.
export async function canSignIn() {
  return !!(await getClient());
}

// ---------------------------------------------------------------- accounts
// There is no separate "admin" role: any signed-in account can approve
// levels (see sql/schema.sql). Regular accounts exist so players can publish
// under their real name and manage (edit/delete) their own levels.
export async function signUp(email, password, displayName) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { data, error } = await client.auth.signUp({
    email, password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
  return data.session; // null if Supabase requires email confirmation first
}

export async function signIn(email, password) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  const client = await getClient();
  if (!client) return;
  await client.auth.signOut();
}

export async function getSession() {
  const client = await getClient();
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session || null;
}

// Fires `cb(session)` immediately and again on every future sign-in/out, so
// UI widgets can stay in sync across tabs/pages without polling.
export async function onAuthChange(cb) {
  const client = await getClient();
  if (!client) { cb(null); return () => {}; }
  const { data: { session } } = await client.auth.getSession();
  cb(session);
  const { data: sub } = client.auth.onAuthStateChange((_event, session) => cb(session));
  return () => sub.subscription.unsubscribe();
}

export async function getMyProfile() {
  const client = await getClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;
  const { data, error } = await client.from('profiles').select('id, display_name').eq('id', session.user.id).single();
  if (error) return null;
  return data;
}

const FULL_PROFILE_COLUMNS = 'id, display_name, is_admin, coins, badges, skin1, skin2, object_skin, unlocked_skins, campaign_unlocked, encouragement_count, created_at';

// The signed-in account's own full economy/cosmetics state — coins, owned
// badges, chosen + unlocked skins. Used by the account page's boutique/skins
// tabs, the editor's badge gating, and engine.js's skin rendering. Null when
// signed out (there's nothing to show — this is all "seulement pour compte").
export async function getMyFullProfile() {
  const client = await getClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;
  const { data, error } = await client.from('profiles').select(FULL_PROFILE_COLUMNS).eq('id', session.user.id).single();
  if (error) return null;
  return data;
}

// A given account's PUBLIC profile (profile.html) — same table, same public
// read policy as everywhere else, but the caller deliberately only asks for
// the columns worth showing to a stranger (no `coins`: a wallet balance
// isn't the kind of thing this site puts on a public page, even though the
// table's own RLS policy would technically allow reading it).
export async function getPublicProfile(userId) {
  const client = await getClient();
  if (!client) return null;
  const { data, error } = await client.from('profiles').select('id, display_name, badges, encouragement_count, created_at').eq('id', userId).single();
  if (error) return null;
  return data;
}

// ---------------------------------------------------------------- économie
// Achète un badge (voir js/catalog.js pour les prix/prérequis affichés côté
// client — la vraie vérification vit dans buy_badge() côté serveur).
export async function buyBadge(badgeId) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { data, error } = await client.rpc('buy_badge', { p_badge: badgeId });
  if (error) return { error: error.message || 'error' };
  return data; // { error, coins, badges } — data.error set means the purchase itself was refused (see buy_badge)
}

export async function setSkin(slot, skinId) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('set_skin', { p_slot: slot, p_skin: skinId });
  return { error };
}

// Coins earned for winning a published (community/official) level — called
// alongside recordWin(), never instead of it (see game.js).
export async function claimWinReward(levelId, deaths) {
  const client = await getClient();
  if (!client) return 0;
  const { data, error } = await client.rpc('claim_win_reward', { level_id: levelId, p_deaths: deaths });
  if (error) return 0;
  return data || 0;
}

// Coins + campaign-progress + skin unlocks for winning an 🗺️ Aventure level.
// Returns null when signed out — the caller falls back to the pre-existing
// localStorage-only progress tracking in that case (see js/campaign.js).
export async function claimCampaignReward(campaignIndex, deaths) {
  const client = await getClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;
  const { data, error } = await client.rpc('claim_campaign_reward', { p_index: campaignIndex, p_deaths: deaths });
  if (error) return null;
  return data; // { coins_awarded, total_coins, campaign_unlocked, new_skins }
}

export async function getServerCampaignUnlocked() {
  const client = await getClient();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return null;
  const { data, error } = await client.rpc('get_campaign_unlocked');
  if (error) return null;
  return data;
}

export async function bumpServerCampaignUnlocked(value) {
  const client = await getClient();
  if (!client) return;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return;
  await client.rpc('bump_campaign_unlocked', { p_value: value });
}

// ------------------------------------------------------------ encouragements
// "Suivre" un autre compte (jamais le sien) — voir sql/schema.sql. Plus un
// compte reçoit d'encouragements, plus il monte dans le classement Top Joueur.
export async function encourage(userId) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('encourage', { p_user_id: userId });
  return { error };
}

export async function unencourage(userId) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('unencourage', { p_user_id: userId });
  return { error };
}

export async function hasEncouraged(userId) {
  const client = await getClient();
  if (!client) return false;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return false;
  const { data, error } = await client.rpc('has_encouraged', { p_user_id: userId });
  if (error) return false;
  return !!data;
}

export async function listTopPlayers(limit = 50) {
  const client = await getClient();
  if (!client) return [];
  const { data, error } = await client.rpc('list_top_players', { p_limit: limit });
  if (error) return [];
  return data || [];
}

// ---------------------------------------------------------------- commentaires
// Lecture publique directe (comme les niveaux) ; poster passe par
// post_comment() côté serveur, qui vérifie le badge VIP — voir game.js.
// Two queries rather than a PostgREST embed: `comments.author_id` references
// auth.users (not public.profiles directly — see sql/schema.sql), so the
// `profiles!comments_author_id_fkey(...)` embed shorthand has no matching
// foreign key to hang off and would fail. A second lookup for just the
// distinct author ids involved is simple and doesn't depend on constraint
// naming staying exactly in sync between the DB and this query.
export async function listComments(levelId) {
  const client = await getClient();
  if (!client) return { comments: [], error: 'not_configured' };
  const { data, error } = await client
    .from('comments')
    .select('id, author_id, body, created_at')
    .eq('level_id', levelId)
    .order('created_at', { ascending: false });
  if (error) return { comments: [], error };
  const authorIds = [...new Set(data.map((c) => c.author_id))];
  let names = {};
  if (authorIds.length) {
    const { data: profs } = await client.from('profiles').select('id, display_name').in('id', authorIds);
    names = Object.fromEntries((profs || []).map((p) => [p.id, p.display_name]));
  }
  return { comments: data.map((c) => ({ ...c, author_name: names[c.author_id] || '—' })), error: null };
}

export async function postComment(levelId, body) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { data, error } = await client.rpc('post_comment', { p_level_id: levelId, p_body: body });
  if (error) return { error: error.message || 'error' };
  return { error: null, id: data };
}

export async function deleteOwnComment(commentId) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('delete_own_comment', { p_comment_id: commentId });
  return { error };
}

// ---------------------------------------------------------------- admin (économie)
export async function adminListProfiles(search = '') {
  const client = await getClient();
  if (!client) return { profiles: [], error: 'not_configured' };
  const { data, error } = await client.rpc('admin_list_profiles', { p_search: search });
  if (error) return { profiles: [], error };
  return { profiles: data, error: null };
}

export async function adminSetProfile(userId, coins, badges) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('admin_set_profile', { p_user_id: userId, p_coins: coins, p_badges: badges });
  return { error };
}

// (deprecated names kept as aliases in case other pages import them)
export const adminSignIn = signIn;
export const adminSignOut = signOut;
export const getAdminSession = getSession;

// ---------------------------------------------------------------- levels
export async function publishLevel(level) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Connecte-toi (ou crée un compte) pour publier un niveau.');
  const payload = {
    title: level.title,
    data: level, // owner_id + author are forced server-side by a trigger
  };
  const { data, error } = await client.from('levels').insert(payload).select('id, created_at').single();
  if (error) throw error;
  return data; // { id, created_at }
}

export async function updateOwnLevel(id, level) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { error } = await client.rpc('update_own_level', { level_id: id, new_title: level.title, new_data: level });
  if (error) throw error;
}

export async function deleteOwnLevel(id) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { error } = await client.rpc('delete_own_level', { level_id: id });
  if (error) throw error;
}

export async function listMyLevels() {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  const { data: { session } } = await client.auth.getSession();
  if (!session) return { levels: [], error: 'not_signed_in' };
  const { data, error } = await client
    .from('levels')
    .select(LEVEL_LIST_COLUMNS)
    .eq('owner_id', session.user.id)
    .order('created_at', { ascending: false });
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

export async function listLevels({ search = '', limit = 30, offset = 0, officialOnly = false } = {}) {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  let query = client
    .from('levels')
    .select(LEVEL_LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (officialOnly) query = query.eq('approved', true);
  if (search && search.trim()) query = query.ilike('title', `%${search.trim()}%`);
  const { data, error } = await query;
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

// A given account's published levels — used by the public profile page
// (profile.html) so anyone can browse what someone else has built, same
// data `levels are publicly readable` already exposes to everyone.
export async function listLevelsByOwner(ownerId) {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  const { data, error } = await client
    .from('levels')
    .select(LEVEL_LIST_COLUMNS)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

// "Populaires" : les niveaux les plus likés, pour donner de la visibilité
// aux parties que la communauté apprécie (indépendamment du statut officiel).
export async function listTopLiked({ limit = 10 } = {}) {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  const { data, error } = await client
    .from('levels')
    .select(LEVEL_LIST_COLUMNS)
    .order('likes', { ascending: false })
    .limit(limit);
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

export async function getLevel(id) {
  const client = await getClient();
  if (!client) throw new Error('Supabase non configuré (voir js/config.js)');
  const { data, error } = await client.from('levels').select('id, title, author, data, plays, wins, likes, approved').eq('id', id).single();
  if (error) throw error;
  const level = normalizeLevel({ ...data.data, id: data.id, title: data.title, author: data.author });
  return { level, plays: data.plays, wins: data.wins, likes: data.likes, approved: data.approved };
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

// ---------------------------------------------------------------- likes
// A like is capped at one per account (enforced server-side by the
// level_likes join table's primary key — see sql/schema.sql). `like_level`
// returns { liked: true } the first time and { liked: false } on every
// repeat call for the same account+level (already liked, nothing changed).
export async function likeLevel(id) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { data: { session } } = await client.auth.getSession();
  if (!session) return { error: 'not_signed_in' };
  const { data, error } = await client.rpc('like_level', { p_level_id: id });
  return { error, liked: !!data };
}

// Whether the signed-in account has already liked this level. Always false
// when signed out (no account to have liked anything with).
export async function hasLikedLevel(id) {
  const client = await getClient();
  if (!client) return false;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return false;
  const { data, error } = await client.rpc('has_liked_level', { p_level_id: id });
  if (error) return false;
  return !!data;
}

// Bulk version for list views: which of these level ids has the signed-in
// account already liked. Returns an empty Set when signed out.
export async function getMyLikedLevelIds(ids) {
  const client = await getClient();
  if (!client || !ids || !ids.length) return new Set();
  const { data: { session } } = await client.auth.getSession();
  if (!session) return new Set();
  const { data, error } = await client
    .from('level_likes')
    .select('level_id')
    .eq('user_id', session.user.id)
    .in('level_id', ids);
  if (error) return new Set();
  return new Set(data.map((r) => r.level_id));
}

// ---------------------------------------------------------- approval flow
// Anyone signed in can ask an admin to feature a level in "Parties officielles".
export async function requestApproval(id) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('request_level_approval', { level_id: id });
  return { error };
}

export async function amIAdmin() {
  const client = await getClient();
  if (!client) return false;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return false;
  const { data, error } = await client.rpc('is_admin_user');
  if (error) return false;
  return !!data;
}

export async function listPendingApprovals() {
  const client = await getClient();
  if (!client) return { levels: [], error: 'not_configured' };
  const { data, error } = await client.rpc('list_pending_approvals');
  if (error) return { levels: [], error };
  return { levels: data, error: null };
}

export async function setLevelApproved(id, approved) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('set_level_approved', { level_id: id, is_approved: approved });
  return { error };
}

// ---------------------------------------------------------------- reports
// Only approved (official) levels can be reported — see sql/schema.sql. Open
// to any signed-in account, not just the level's own creator (same logic as
// likes) — but capped at one report per account per level, enforced by the
// database's unique constraint; report_level() ignores a repeat call rather
// than erroring, and returns whether this call actually registered a new
// report (false means "you'd already reported this one").
export async function reportLevel(id, reason) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { data, error } = await client.rpc('report_level', { level_id: id, reason: reason || '' });
  return { error, reported: !!data };
}

// Whether the signed-in account has already reported this level. Always
// false when signed out (no account to have reported with).
export async function hasReportedLevel(id) {
  const client = await getClient();
  if (!client) return false;
  const { data: { session } } = await client.auth.getSession();
  if (!session) return false;
  const { data, error } = await client.rpc('has_reported_level', { p_level_id: id });
  if (error) return false;
  return !!data;
}

export async function listReports() {
  const client = await getClient();
  if (!client) return { reports: [], error: 'not_configured' };
  const { data, error } = await client.rpc('list_reports');
  if (error) return { reports: [], error };
  return { reports: data, error: null };
}

export async function dismissReport(id) {
  const client = await getClient();
  if (!client) return { error: 'not_configured' };
  const { error } = await client.rpc('dismiss_report', { report_id: id });
  return { error };
}
