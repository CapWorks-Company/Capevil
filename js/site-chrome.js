// Shared topbar nav — the "boutons de sections" that replaced the old single
// mega-homepage: every top-level page (index/adventure/official/community/
// account/profile) mounts the same row of links here instead of duplicating
// this markup+wiring six times. `activeKey` just adds the `.primary` look to
// whichever section the current page belongs to.
import { amIAdmin } from './supabase-client.js';

const SECTIONS = [
  { key: 'adventure', href: 'adventure.html', icon: '🗺️', label: 'Aventure' },
  { key: 'official', href: 'official.html', icon: '🏅', label: 'Officielles' },
  { key: 'community', href: 'community.html', icon: '🌍', label: 'Communauté' },
  { key: 'account', href: 'account.html', icon: '👤', label: 'Mon compte' },
];

export function mountSiteNav(container, activeKey) {
  if (!container) return;
  const sectionsHtml = SECTIONS.map((s) => `<a class="btn small${s.key === activeKey ? ' primary' : ''}" href="${s.href}">${s.icon} ${s.label}</a>`).join('');
  container.innerHTML = `
    <a class="btn small" href="editor.html">+ Créer un niveau</a>
    ${sectionsHtml}
    <a class="btn small hidden" id="admin-link" href="admin.html" title="Espace admin">🛡 Admin</a>
  `;
}

// The 🛡 Admin link is only for admins — everyone else never sees it (see
// home.js's original comment, kept the same now that every page shares this
// logic instead of only index.html having it). Call once per page, after
// mountSiteNav, whenever the session is known/changes.
export async function refreshAdminLink(session) {
  const adminLinkEl = document.getElementById('admin-link');
  if (!adminLinkEl) return;
  if (!session) { adminLinkEl.classList.add('hidden'); return; }
  const admin = await amIAdmin();
  adminLinkEl.classList.toggle('hidden', !admin);
}
