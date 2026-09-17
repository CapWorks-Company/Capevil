// index.html is now just the hub: 4 big section buttons (see the .hub-grid
// in index.html) linking out to adventure.html / official.html /
// community.html / account.html, each of which owns its own list-loading
// logic in its own JS file. This file only wires the shared topbar (nav +
// account bar + backend warning) — see js/site-chrome.js.
import { isBackendReady } from './supabase-client.js';
import { mountAccountBar } from './auth-ui.js';
import { mountSiteNav, refreshAdminLink, refreshNotifBadge } from './site-chrome.js';

const backendWarning = document.getElementById('backend-warning');
const accountBar = document.getElementById('account-bar');
const siteNav = document.getElementById('site-nav');

mountSiteNav(siteNav, null);
mountAccountBar(accountBar, { onChange: (session) => { refreshAdminLink(session); refreshNotifBadge(session); } });

isBackendReady().then((ready) => { if (!ready) backendWarning.classList.remove('hidden'); });
