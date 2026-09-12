// Local drafts are levels saved in the browser (before publishing, or for
// people who just want to build/play offline without a database).
export const LOCAL_PREFIX = 'leveldevil_draft_';

export function saveLocalDraft(level) {
  const key = level.localKey || `${LOCAL_PREFIX}${Date.now().toString(36)}`;
  level.localKey = key;
  localStorage.setItem(key, JSON.stringify(level));
  return key;
}

export function listLocalDrafts() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LOCAL_PREFIX)) continue;
    try {
      const level = JSON.parse(localStorage.getItem(key));
      out.push({ key, title: level.title || 'Sans titre', entityCount: (level.entities || []).length });
    } catch { /* ignore corrupt entry */ }
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : -1));
}

export function loadLocalDraft(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

export function deleteLocalDraft(key) {
  localStorage.removeItem(key);
}
