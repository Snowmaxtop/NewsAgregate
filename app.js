// Dispatch — main app script (loaded by index.html after releases.js and archive.js).
/* =========================================================================
   DISPATCH — video game news aggregator (PWA, GitHub Pages)
   =========================================================================

   ARCHITECTURE
   ------------
   ┌─ GitHub Actions (.github/workflows/refresh-articles.yml, cron ~20 min)
   │    runs scripts/fetch-articles.mjs (Node 24, fast-xml-parser)
   │    → fetches the RSS feeds server-side (no CORS issues)
   │    → cleans titles/summaries/images, drops items older than RETENTION_DAYS
   │    → commits articles.json at the repo root
   │
   ├─ GitHub Actions (.github/workflows/refresh-releases.yml, daily)
   │    runs scripts/fetch-releases.mjs (IGDB + Steam wishlist ranking)
   │    → commits releases.json and wishlists.json (see releases.js)
   │
   ├─ GitHub Actions (refresh-tracker.yml, hourly) → tracker.json
   │    (Steam players + reviews of liked games that are out)
   │
   ├─ This page (index.html) reads those JSON files (same origin).
   │
   ├─ Personal state (read/favorites/hidden/liked games/push devices):
   │    dispatch-state.json in the user's GitHub repo, read/written through
   │    the GitHub REST API (fine-grained token "Contents: RW", kept in
   │    localStorage per device). localStorage is a synchronous local cache.
   │    SYNC: GitHub's copy is authoritative; this device's unsaved changes
   │    (counter persisted across restarts) are replayed on top of it with a
   │    three-way merge (mergeStates: base = last synced copy), at boot and
   │    when a save hits a 409 — so two devices' saves combine. Saves are one
   │    PUT with the known sha; polling uses ETag (304 when unchanged).
   │
   └─ PWA: manifest.webmanifest + sw.js (offline cache, icon badge, push).

   STATE
   -----
   state.read       : string[]  — links of read articles
   state.hidden     : string[]  — links of deleted articles
   state.favorites  : object[]  — full SNAPSHOTS {link,title,date,image,
                      sourceId,summary}. INVARIANT: a favorite is never also
                      hidden and never shows in "All".
   state.likedGames : object[]  — snapshots of liked games (Releases tab).
   state.push       : {publicKey, subscriptions[]} | null — push devices.

   LAYOUT
   ------
   Header (brand, "updated" note, refresh / ⋯ menu / settings), search row
   (keyword + source), the active view, and a fixed bottom tab bar
   (All · Favorites · Releases · Archive).

   FILTER PIPELINE (render)
   ------------------------
   favorites ? snapshots : feed − hidden − favorites
   → source (id) → search (titles + summaries). All filters combine (AND).

   AUTOMATIC BEHAVIOUR
   -------------------
   - Read on tap: pointerdown/up with a 10px/500ms threshold (tap ≠ scroll)
   - Two-way swipe (touch only, never mouse):
       → right (≥110px) = DELETE (hideArticle: adds to hidden AND removes
         from favorites), red 🗑 background, slide-out animation.
       → left (≥110px) = TOGGLE FAVORITE, green ★ background, row snaps back.
     Needs a clearly horizontal gesture (dx > dy*1.3). Undo restores hidden
     AND the favorite if there was one.
   - Read on scroll: IntersectionObserver (≥50% seen) + exit through the
     top (rect.bottom <= 0) + rAF safety sweep. Never touches favorites.
   - read/hidden purge on the SERVER after every articles run
     (scripts/purge-state.mjs; favorites, likes and push devices kept).
   - saveStateInstant(): SYNCHRONOUS localStorage write before any
     navigation; saveState(): async GitHub sync with retry on 409.
   - Badge: updateCounts() → updateAppBadge(); refresh every 5 min
     + visibilitychange/focus; periodicSync in the SW when backgrounded.

   SECURITY: index.html sets a Content-Security-Policy (no inline scripts or
   handlers; network only to this site + api.github.com). Every outside
   string goes through escapeHtml()/esc(); every outside URL through
   safeUrl() (http/https) or linkTo() (expected host) before reaching HTML.

   NOTE — "Mark all as read" (⋯ menu) marks ALL articles, whatever filters are on.
   ========================================================================= */
// Display info only: feed URLs live in scripts/fetch-articles.mjs (same ids).
const SOURCES = [
  { id:'ign',       name:'IGN France',        category:'gamer',    home:'https://fr.ign.com/' },
  { id:'gamedev',   name:'Game Developer',    category:'industry', home:'https://www.gamedeveloper.com/' },
  { id:'gibiz',     name:'GamesIndustry.biz', category:'industry', home:'https://www.gamesindustry.biz/' },
  { id:'jv',        name:'Jeuxvideo.com',     category:'gamer',    home:'https://www.jeuxvideo.com/' },
  { id:'gameblog',  name:'Gameblog',          category:'gamer',    home:'https://www.gameblog.fr/' },
  { id:'gamekult',  name:'Gamekult',          category:'gamer',    home:'https://www.gamekult.com/' },
  { id:'kotaku',    name:'Kotaku',            category:'gamer',    home:'https://kotaku.com/' },
  { id:'pcgamer',   name:'PC Gamer',          category:'gamer',    home:'https://www.pcgamer.com/' },
  { id:'polygon',   name:'Polygon',           category:'gamer',    home:'https://www.polygon.com/' },
  { id:'gamefile',  name:'Game File',         category:'industry', home:'https://www.gamefile.news/' },
  { id:'pgbiz',     name:'PocketGamer.biz',   category:'industry', home:'https://www.pocketgamer.biz/' },
  { id:'mgbiz',     name:'MobileGamer.biz',   category:'industry', home:'https://mobilegamer.biz/' },
];

let state = { read: [], favorites: [], hidden: [], likedGames: [], push: null };
let articles = [];
let currentFilter = 'all';
let currentSource = 'all';  // 'all' or a SOURCES[].id — set by the #sourceSelect dropdown
let searchQuery = '';
// Which favorite date-sections are EXPANDED (keys are Date.toDateString()).
// Default empty = all days collapsed, so the favorites tab opens as a tidy
// list of day headers you expand on demand. Session-only.
const expandedDays = new Set();
let githubConnected = false;
let githubSha = null;

const feedEl = document.getElementById('feed');
const settingsBtnEl = document.getElementById('ghSettingsBtn');
let lastSyncError = '';   // last GitHub error message (shown in the menu + connect alert)

// Enforces the cross-list invariants so impossible states (e.g. an article
// both favorited AND in the triage queue) can never persist, no matter how
// two devices' edits merged:
//   • A favorited link is removed from `hidden` (favorite wins over bin).
//   • Dedupe every list.
//   • `read` may overlap anything (read is orthogonal), but we dedupe it.
// Note: "in All" isn't a stored list — it's computed as (not hidden AND
// not favorited). So the only stored conflict to resolve is favorite-vs-
// hidden; once that's clean, an item can't be both a favorite and in All.
function enforceStateConsistency(){
  // Dedupe favorites by link (keep the richest snapshot).
  const favByLink = new Map();
  (state.favorites || []).forEach(f => {
    if (typeof f === 'string') f = { link: f, title: '(expired article)', date: null, image: null, sourceId: null };
    if (!f || !f.link) return;
    const ex = favByLink.get(f.link);
    if (!ex || (ex.title === '(expired article)' && f.title !== '(expired article)')) favByLink.set(f.link, f);
  });
  state.favorites = Array.from(favByLink.values());

  // A favorite is never also hidden.
  state.hidden = Array.from(new Set(state.hidden || [])).filter(link => !favByLink.has(link));
  state.read = Array.from(new Set(state.read || []));

  // Liked games: dedupe by IGDB id (keep the latest snapshot).
  const likedById = new Map();
  (state.likedGames || []).forEach(g => { if (g && g.id != null) likedById.set(g.id, g); });
  state.likedGames = Array.from(likedById.values());
}

// --- Local cache, "base" copy and unsaved-changes counter ----------------
// article-state   : this device's full state, written synchronously on every
//                   action (opening an article navigates away, so it must be
//                   committed before that happens).
// dispatch-base   : the state as it was at the last successful sync with
//                   GitHub. Comparing it with the local state tells exactly
//                   what THIS device added or removed since — see mergeStates.
// dispatch-pending: unsaved-changes counter, kept across app restarts so
//                   unsaved work is merged (not overwritten) on next launch.
const LOCAL_KEY = 'article-state';
const BASE_KEY = 'dispatch-base';
const PENDING_KEY = 'dispatch-pending';

const pickState = (s) => ({
  read: (s && s.read) || [], hidden: (s && s.hidden) || [], favorites: (s && s.favorites) || [],
  likedGames: (s && s.likedGames) || [], push: (s && s.push) || null,
});
const readJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };

function saveStateInstant(){
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) { /* storage full / private mode */ }
}
function setBase(s){
  try { localStorage.setItem(BASE_KEY, JSON.stringify(pickState(s))); } catch (e) { /* ignore */ }
}

let pendingChanges = Number(localStorage.getItem(PENDING_KEY)) || 0;
function setPending(n){
  pendingChanges = Math.max(0, n);
  try { localStorage.setItem(PENDING_KEY, String(pendingChanges)); } catch (e) { /* ignore */ }
}

// Three-way merge: start from GitHub's copy (other devices' work), then
// replay what THIS device changed since the last sync (base → local):
// additions are added, removals are removed. So saves from two devices
// combine instead of the last one overwriting the other, and an
// un-favorite / un-hide made offline is not resurrected. Without a base
// (first run after an update), local changes are simply added (union).
function mergeStates(base, local, remote){
  base = pickState(base); local = pickState(local); remote = pickState(remote);
  // remote + (added locally) − (removed locally), items matched by keyOf.
  const merge3 = (b, l, r, keyOf) => {
    const bk = new Set(b.map(keyOf)), lk = new Map(l.map(x => [keyOf(x), x]));
    const out = new Map(r.map(x => [keyOf(x), x]));
    for (const [k, x] of lk) if (!bk.has(k)) out.set(k, x);
    for (const k of bk) if (!lk.has(k)) out.delete(k);
    return [...out.values()];
  };
  const same = (x) => x;
  const favKey = (f) => (typeof f === 'string' ? f : f && f.link);
  const subsOf = (s) => (s.push && s.push.subscriptions) || [];
  const subs = merge3(subsOf(base), subsOf(local), subsOf(remote), (x) => x && x.endpoint);
  const publicKey = (remote.push && remote.push.publicKey) || (local.push && local.push.publicKey) || null;
  return {
    read: merge3(base.read, local.read, remote.read, same),
    hidden: merge3(base.hidden, local.hidden, remote.hidden, same),
    favorites: merge3(base.favorites, local.favorites, remote.favorites, favKey),
    likedGames: merge3(base.likedGames, local.likedGames, remote.likedGames, (g) => g && g.id),
    push: publicKey || subs.length ? { publicKey, subscriptions: subs } : null,
  };
}

// Replace the state with GitHub's copy (nothing unsaved on this device).
function adoptRemote(content){
  Object.assign(state, pickState(content));
  enforceStateConsistency();
  saveStateInstant();
  setBase(state);
}
// Combine GitHub's copy with this device's unsaved changes.
function mergeRemoteIntoState(content){
  Object.assign(state, mergeStates(readJsonKey(BASE_KEY), state, content));
  enforceStateConsistency();
  saveStateInstant();
}

// What the user can actually see (current feed, favorites, likes, devices).
// Used to tell a real change from another device apart from the server's
// routine clean-up of old read/deleted links.
function visibleSig(){
  const live = new Set(articles.map(a => a.link));
  const inFeed = (list) => list.filter(l => live.has(l)).sort().join('\n');
  return [inFeed(state.read), inFeed(state.hidden),
    state.favorites.map(f => f.link).sort().join('\n'),
    state.likedGames.map(g => g.id).sort().join(','),
    ((state.push && state.push.subscriptions) || []).length].join('|');
}

// --- GitHub sync --------------------------------------------------------
// Stores the state as dispatch-state.json in your repo via GitHub's REST
// API (CORS-enabled, token from this device's localStorage).
const GITHUB_CONFIG_KEY = 'dispatch-github-config';
const GITHUB_DATA_PATH = 'dispatch-state.json';

function getGithubConfig(){
  const cfg = readJsonKey(GITHUB_CONFIG_KEY);
  return cfg && cfg.owner && cfg.repo && cfg.token ? cfg : null;
}
function saveGithubConfig(cfg){ localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(cfg)); }
function clearGithubConfig(){ localStorage.removeItem(GITHUB_CONFIG_KEY); }

function utf8ToBase64(str){ return btoa(unescape(encodeURIComponent(str))); }
function base64ToUtf8(b64){ return decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))); }

const githubUrl = (cfg) => `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${GITHUB_DATA_PATH}`;
const httpError = (what, status, detail = '') => Object.assign(new Error(`GitHub ${what} failed: ${status}${detail ? ' ' + detail : ''}`), { status });

// GET the state file. With { conditional: true } it sends the last ETag:
// an unchanged file answers 304 (no body, not counted in the API rate
// limit), which keeps the 30-second polling cheap.
let remoteEtag = null;
let etagSupported = true;
async function githubGetFile(cfg, { conditional = false } = {}){
  const headers = { 'Authorization': `Bearer ${cfg.token}`, 'Accept': 'application/vnd.github+json' };
  const useEtag = conditional && etagSupported && remoteEtag;
  if (useEtag) headers['If-None-Match'] = remoteEtag;
  let res;
  try {
    res = await fetch(githubUrl(cfg), { headers, cache: 'no-store' });
  } catch (e) {
    if (!useEtag) throw e;
    etagSupported = false;                 // header refused by CORS → plain GETs from now on
    return githubGetFile(cfg);
  }
  if (res.status === 304) return { notModified: true };
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw httpError('GET', res.status);
  remoteEtag = res.headers.get('ETag') || null;
  const data = await res.json();
  return { content: JSON.parse(base64ToUtf8(data.content)), sha: data.sha };
}

async function githubPutFile(cfg, contentObj, sha){
  const body = { message: 'Update Dispatch state', content: utf8ToBase64(JSON.stringify(contentObj, null, 2)) };
  if (sha) body.sha = sha;
  const res = await fetch(githubUrl(cfg), {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${cfg.token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError('PUT', res.status, (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.content.sha;
}

// Sync status lives on the settings icon (dot: green synced, red error,
// grey not set up) and as the first line of the ⋯ menu.
function updateSyncNote(errorMsg){
  lastSyncError = githubConnected ? '' : (errorMsg || '');
  settingsBtnEl.classList.toggle('connected', githubConnected);
  settingsBtnEl.classList.toggle('error', !githubConnected && !!errorMsg);
  settingsBtnEl.title = githubConnected ? 'Settings · synced with GitHub'
    : errorMsg ? 'Settings · GitHub sync error: ' + errorMsg : 'Settings · GitHub sync not set up';
}

// --- Static articles.json (built by GitHub Actions) --------------------
// The only source of articles: a scheduled Action fetches every feed
// server-side and commits articles.json, read here as a same-origin file.
const articlesNoteEl = document.getElementById('articlesNote');
let articlesGeneratedAt = null;

function formatRelative(dateStr){
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
function updateArticlesNote(){
  if (articlesGeneratedAt) articlesNoteEl.textContent = `updated ${formatRelative(articlesGeneratedAt)}`;
}

function applyJsonData(data){
  const byId = new Map(SOURCES.map(s => [s.id, s]));
  articles = (data.articles || [])
    .map(a => {
      const source = byId.get(a.sourceId);
      if (!source || !a.link) return null;
      return { title: a.title, link: a.link, date: new Date(a.date), source, image: a.image || null, summary: a.summary || '' };
    })
    .filter(Boolean)
    .sort((a, b) => b.date - a.date);
  articlesGeneratedAt = data.generatedAt || null;
  updateArticlesNote();
  render();
}

// Boot: GitHub's copy is authoritative. Unsaved changes from the last
// session (pending counter > 0) are merged on top of it and pushed; with no
// state file yet, this device's local state becomes the first version.
let saveAfterBoot = false;
async function loadState(){
  const local = readJsonKey(LOCAL_KEY);
  const cfg = getGithubConfig();
  if (cfg) {
    try {
      const { content, sha } = await githubGetFile(cfg);
      githubSha = sha;
      githubConnected = true;
      if (!content) {                      // no file in the repo yet
        Object.assign(state, pickState(local));
        enforceStateConsistency();
        saveAfterBoot = true;
        if (!pendingChanges) setPending(1);
      } else if (pendingChanges > 0) {
        Object.assign(state, pickState(local));
        mergeRemoteIntoState(content);
        saveAfterBoot = true;
      } else {
        adoptRemote(content);
      }
      updateSyncNote();
      return;
    } catch (e) {
      console.error('GitHub sync load failed, using this device\'s copy:', e);
      githubConnected = false;
      updateSyncNote(e.message);
    }
  }
  if (local) Object.assign(state, pickState(local));
  enforceStateConsistency();
}

// --- Serialized GitHub save queue --------------------------------------
// GitHub writes are optimistic-concurrency (PUT must name the current
// sha). Saves run one at a time; a save requested while one is in flight
// is coalesced — only the *latest* full state needs pushing.
let saveInFlight = false;
let savePending = false;
let lastSaveOk = true;

async function saveState(){
  saveStateInstant();
  const cfg = getGithubConfig();
  if (!cfg) return true;
  if (saveInFlight) { savePending = true; return lastSaveOk; }

  saveInFlight = true;
  let ok = false;
  try { ok = await pushToGithub(cfg); }
  finally { saveInFlight = false; lastSaveOk = ok; }

  if (savePending) { savePending = false; return await saveState(); }
  return ok;
}

// One PUT with the sha we already know (no extra GET). If GitHub's copy
// changed meanwhile (other device, server clean-up) the PUT answers 409:
// we fetch it, merge this device's changes into it, and PUT once more.
async function pushToGithub(cfg){
  try {
    if (!githubSha) githubSha = (await githubGetFile(cfg)).sha;
    try {
      githubSha = await githubPutFile(cfg, state, githubSha);
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      const before = visibleSig();
      const remote = await githubGetFile(cfg);
      if (remote.content) mergeRemoteIntoState(remote.content);
      githubSha = await githubPutFile(cfg, state, remote.sha);
      if (visibleSig() !== before) render();
    }
    setBase(state);
    githubConnected = true;
    updateSyncNote();
    return true;
  } catch (e) {
    console.error('GitHub sync failed:', e);
    githubConnected = false;
    updateSyncNote(e.message);
    return false;
  }
}

function idFor(item){ return item.link; }

// --- Manual grouped save -----------------------------------------------
// Actions only write locally and bump the pending counter; the floating
// Save button pushes everything at once (one API call instead of one per
// action, which would hammer the token's rate limit).

// Called by every state-changing action. Writes to localStorage right away
// (so nothing is lost) and increments the unsaved-changes counter shown on
// the Save button. Does NOT hit the network.
function markDirty(){
  saveStateInstant();
  setPending(pendingChanges + 1);
  updateSaveButton();
  maybeAutoSaveOnEmpty();
}

// Count of articles still awaiting triage (not hidden, not favorited).
function triageRemaining(){
  const hidden = new Set(state.hidden), fav = new Set(state.favorites.map(f => f.link));
  return articles.filter(a => !hidden.has(a.link) && !fav.has(a.link)).length;
}

// When the triage queue hits zero (you've dealt with every article) and
// there are unsaved changes, push automatically so you don't have to tap
// Save yourself. Guarded so it only fires on the transition to empty.
let triageWasEmpty = false;
function maybeAutoSaveOnEmpty(){
  const remaining = triageRemaining();
  if (remaining === 0 && !triageWasEmpty && pendingChanges > 0 && getGithubConfig() && !manualSaveRunning){
    triageWasEmpty = true;
    manualSave(); // same grouped push + spinner/check feedback as the button
  } else if (remaining > 0){
    triageWasEmpty = false; // re-arm once there's something to triage again
  }
}

function updateSaveButton(){
  const btn = document.getElementById('saveBtn');
  if (!btn) return;
  const countEl = document.getElementById('saveCount');
  if (pendingChanges > 0 && getGithubConfig()){
    countEl.textContent = pendingChanges;
    btn.classList.add('show');
  } else if (!btn.classList.contains('saving') && !btn.classList.contains('saved')) {
    btn.classList.remove('show');
  }
}

// The Save button handler: push once, showing spinner → check / error.
let manualSaveRunning = false;
async function manualSave(){
  const btn = document.getElementById('saveBtn');
  if (!btn || manualSaveRunning || pendingChanges === 0) return;
  const cfg = getGithubConfig();
  if (!cfg){ openGithubModal(); return; } // no config yet → let them set it up

  manualSaveRunning = true;
  const snapshot = pendingChanges;      // remember how many we're flushing
  btn.classList.remove('saved', 'error');
  btn.classList.add('saving');

  const ok = await saveState();         // single grouped push (serialized queue inside)

  btn.classList.remove('saving');
  manualSaveRunning = false;

  if (ok){
    setPending(pendingChanges - snapshot); // keeps changes made mid-save
    btn.classList.add('saved');
    setTimeout(() => {
      btn.classList.remove('saved');
      updateSaveButton(); // hide if nothing pending, or show remaining count
    }, 1600);
  } else {
    btn.classList.add('error');
    setTimeout(() => {
      btn.classList.remove('error');
      updateSaveButton();
    }, 2500);
  }
}

function formatTime(date){
  return date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}

function sameDay(d1, d2){
  return d1.toDateString() === d2.toDateString();
}

function dayLabel(date, absolute){
  // In the Favorites view we pass absolute=true: favorites can be weeks
  // old, so "Today/Yesterday" would be misleading — always show the full
  // date (with year, since favorites can span across years).
  if (absolute) {
    return date.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  }
  const now = new Date();
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d1 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((d0 - d1) / 86400000);
  if(diffDays === 0) return 'Today';
  if(diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'});
}

// Lookup sets for the current state, rebuilt once per render instead of
// scanning arrays for every article (O(n) per lookup → O(1)).
function stateSets(){
  return {
    read: new Set(state.read),
    hidden: new Set(state.hidden),
    fav: new Set(state.favorites.map(f => f.link)),
  };
}

function updateCounts(sets = stateSets()){
  // "All" is the triage queue: not hidden AND not favorited. The tab badge
  // shows how many of those are still unread (empty = badge hidden).
  const unreadAll = articles.filter(a => !sets.hidden.has(a.link) && !sets.fav.has(a.link) && !sets.read.has(a.link)).length;
  document.getElementById('c-all').textContent = unreadAll ? (unreadAll > 999 ? '999+' : unreadAll) : '';
  document.getElementById('c-fav').textContent = state.favorites.length || '';
  updateAppBadge(unreadAll);
}

// --- App icon badge ----------------------------------------------------
// The page sets the badge itself on every count change. It also hands the
// service worker a copy of the read/hidden/favorite lists (debounced: one
// message after a burst of actions) so periodic background sync can
// recompute the same number while the app is closed.
let badgeMsgTimer = null;
function updateAppBadge(count){
  try {
    if ('setAppBadge' in navigator) {
      if (count > 0) navigator.setAppBadge(count);
      else navigator.clearAppBadge();
    }
  } catch (e) { /* badging not available, ignore */ }

  clearTimeout(badgeMsgTimer);
  badgeMsgTimer = setTimeout(() => {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'dispatch-state-update',
          read: state.read,
          hidden: state.hidden,
          favorites: state.favorites.map(f => f.link),
        });
      }
    } catch (e) { /* SW not ready yet */ }
  }, 1500);
}

function isFavorited(id){
  return state.favorites.some(f => f.link === id);
}

function favoritesAsArticles(){
  return state.favorites.map(f => {
    const source = SOURCES.find(s => s.id === f.sourceId) || { id: f.sourceId, name: 'Unknown source', category: 'gamer' };
    return {
      title: f.title || '(expired article)',
      link: f.link,
      date: f.date ? new Date(f.date) : new Date(0),
      source,
      image: f.image || null,
      summary: f.summary || ''
    };
  });
}

// Accent- and case-insensitive text for search ("réseau" finds "reseau").
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function render(){
  const sets = stateSets();
  updateCounts(sets);

  // Releases / Archive tabs replace the article feed. The feed
  // is emptied (not just hidden) so the scroll-read sweep can't see any
  // zero-size rows and mark them read.
  const inReleases = currentFilter === 'releases';
  const inArchive = currentFilter === 'archive';
  document.body.classList.toggle('mode-releases', inReleases);
  document.body.classList.toggle('mode-archive', inArchive);
  document.getElementById('releases').hidden = !inReleases;
  document.getElementById('archive').hidden = !inArchive;
  if (!inArchive) document.getElementById('archive').dataset.active = '0';
  if(inReleases || inArchive){
    feedEl.innerHTML = '';
    observeRowsForScrollRead();
    if (inReleases) renderReleases(document.getElementById('releases'));
    else renderArchive(document.getElementById('archive'));
    return;
  }
  feedEl.classList.toggle('in-favorites', currentFilter === 'favorites');
  document.getElementById('searchInput').placeholder = currentFilter === 'favorites' ? 'Search favorites' : 'Search articles';

  let list;
  if(currentFilter === 'favorites'){
    // Favorites are always shown in full — never removed by the hidden
    // filter. A favorite is an explicit "keep this forever" signal, so
    // even if the same article was also binned, the favorite wins here.
    list = favoritesAsArticles();
  } else {
    // "All" is the triage queue: an article stays here until dealt with.
    // Favorited and hidden articles both leave this list.
    list = articles.filter(a => !sets.hidden.has(a.link) && !sets.fav.has(a.link));
  }
  if(currentSource !== 'all') list = list.filter(a => a.source.id === currentSource);
  // Search: titles + summaries, every word must match, accents/case ignored.
  if(searchQuery){
    const words = fold(searchQuery).split(/\s+/).filter(Boolean);
    // Folded text is cached on each article (computed once, reused per keystroke).
    list = list.filter(a => { const hay = a._hay || (a._hay = fold(a.title + ' ' + (a.summary || ''))); return words.every(w => hay.includes(w)); });
  }
  list.sort((a,b) => b.date - a.date);

  if(list.length === 0){
    const srcName = currentSource !== 'all' ? (SOURCES.find(s => s.id === currentSource) || {}).name : '';
    let msg;
    if (searchQuery) msg = `No matches for “${escapeHtml(searchQuery)}”${srcName ? ` in ${escapeHtml(srcName)}` : ''}.`;
    else if (currentFilter === 'favorites') msg = srcName ? `No favorites from ${escapeHtml(srcName)}.` : 'No favorites yet. Swipe an article left (or tap ☆) to keep it here.';
    else if (!articles.length) msg = 'Loading articles';
    else if (srcName) msg = `Nothing new from ${escapeHtml(srcName)} right now.`;
    else msg = 'You’re all caught up. New articles arrive every 20 minutes.';
    feedEl.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  const rowHtml = (a) => {
    const id = idFor(a);
    const isRead = sets.read.has(id);
    const isFav = sets.fav.has(id);
    const img = safeUrl(a.image);
    const href = safeUrl(a.link) || '#';
    const hasThumb = !!img;
    return `
      <div class="row ${isRead ? 'read' : ''} ${hasThumb ? 'has-thumb' : ''}" data-id="${encodeURIComponent(id)}">
        <div class="dot-col"><span class="u"></span></div>
        <div>
          <a class="headline" href="${href}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
          ${a.summary ? `<div class="summary">${escapeHtml(a.summary)}</div>` : ''}
          <div class="meta"><span>${escapeHtml(a.source.name)}</span>${a.source.category === 'industry' ? '<span class="ind">Industry</span>' : ''}<span>${formatTime(a.date)}</span></div>
        </div>
        ${hasThumb ? `<div class="thumb"><img src="${img}" loading="lazy" alt=""></div>` : ''}
        <div class="row-actions">
          <button class="star ${isFav ? 'on' : ''}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>
          <button class="bin" title="Delete">🗑</button>
        </div>
      </div>
    `;
  };

  if(currentFilter === 'favorites'){
    // Favorites view: group by day into collapsible sections so long
    // archives don't become an endless scroll. Each day header shows the
    // count and toggles its articles open/closed (state in expandedDays;
    // all days start collapsed for easy navigation).
    const groups = [];
    let currentKey = null;
    list.forEach(a => {
      const key = a.date.toDateString();
      if(key !== currentKey){
        groups.push({ key, date: a.date, items: [] });
        currentKey = key;
      }
      groups[groups.length - 1].items.push(a);
    });

    feedEl.innerHTML = groups.map(g => {
      // While searching, every matching day is shown open.
      const collapsed = !searchQuery && !expandedDays.has(g.key);
      const rows = collapsed ? '' : g.items.map(rowHtml).join('');
      return `
        <div class="day-group ${collapsed ? 'collapsed' : ''}">
          <button class="day-header" data-daykey="${encodeURIComponent(g.key)}">
            <span class="day-chevron">▾</span>
            <span class="day-header-label">${dayLabel(g.date, true)}</span>
            <span class="day-header-count">${g.items.length}</span>
          </button>
          <div class="day-items">${rows}</div>
        </div>
      `;
    }).join('');
  } else {
    feedEl.innerHTML = list.map((a, idx) => {
      const showSeparator = idx === 0 || !sameDay(a.date, list[idx - 1].date);
      const separatorHtml = showSeparator ? `<div class="day-sep">${dayLabel(a.date, false)}</div>` : '';
      return separatorHtml + rowHtml(a);
    }).join('');
  }

  observeRowsForScrollRead();
}

// --- Mark-as-read on scroll-past ---------------------------------------
// An article that has actually been on screen (≥50% visible) and then
// scrolls out past the TOP edge is treated as "seen and skipped" → marked
// read. Rendering below the fold or scrolling upward past unseen items
// does not mark anything. Favorites are never auto-read.
const seenRows = new Map();   // id → row element, for rows seen and not yet read
let scrollObserver = null;

function observeRowsForScrollRead(){
  if (scrollObserver) scrollObserver.disconnect();
  seenRows.clear();
  // No explicit root → observes against the viewport (the window scrolls).
  scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const row = entry.target;
      const id = decodeURIComponent(row.dataset.id);
      if (entry.isIntersecting) {
        if (!row.classList.contains('read')) seenRows.set(id, row);
      } else if (seenRows.has(id) && row.getBoundingClientRect().bottom <= 0) {
        // Left the viewport through the top (viewport-relative rect).
        markRowReadFromScroll(id, row);
      }
    });
  }, { threshold: [0, 0.5] });
  feedEl.querySelectorAll('.row').forEach(row => scrollObserver.observe(row));
}

function markRowReadFromScroll(id, row){
  seenRows.delete(id);
  if (state.read.includes(id) || isFavorited(id)) return;
  state.read.push(id);
  row.classList.add('read');
  updateCounts();
  markDirty(); // local only; pushed with the Save button
}

// Safety sweep: on a very fast fling the observer can miss the exact moment
// a row crosses the top edge. On scroll (one check per frame) we look at
// the rows already seen — usually a handful — not the whole list.
let sweepScheduled = false;
function scrollReadSweep(){
  if (sweepScheduled || !seenRows.size) return;
  sweepScheduled = true;
  requestAnimationFrame(() => {
    sweepScheduled = false;
    for (const [id, row] of seenRows) {
      if (row.getBoundingClientRect().bottom <= 0) markRowReadFromScroll(id, row);
    }
  });
}
window.addEventListener('scroll', scrollReadSweep, { passive: true });

// --- Back-to-top button -------------------------------------------------
const backToTopBtn = document.getElementById('backToTop');
function updateBackToTop(){
  if (window.scrollY > 400) backToTopBtn.classList.add('show');
  else backToTopBtn.classList.remove('show');
}
window.addEventListener('scroll', updateBackToTop, { passive: true });
backToTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
updateBackToTop();

// Save button: push all pending changes at once.
document.getElementById('saveBtn').addEventListener('click', manualSave);

// Warn before leaving if there are unsaved local changes. The user chose
// manual saving, so this is a safety net, not automatic syncing.
window.addEventListener('beforeunload', (e) => {
  if (pendingChanges > 0 && getGithubConfig()){
    e.preventDefault();
    e.returnValue = ''; // required for the browser's native confirm dialog
  }
});

// Decodes HTML entities (&#8217; &rsquo; &amp; …) into real characters by
// letting the browser parse them as text. RSS feeds often double-encode
// punctuation (curly quotes, dashes), which otherwise shows up literally
// as "&#8217;" in titles/summaries. One reused <textarea>: its content is
// parsed as plain text (no tags, no scripts, no image loads).
const entityDecoder = document.createElement('textarea');
function decodeEntities(str){
  if (!str) return '';
  str = String(str);
  if (str.indexOf('&') === -1) return str;   // nothing to decode (most titles)
  entityDecoder.innerHTML = str;
  let out = entityDecoder.value;
  // Some feeds double-encode (&amp;#8217;) — run one more pass to catch it.
  if (/&#?\w+;/.test(out)) {
    entityDecoder.innerHTML = out;
    out = entityDecoder.value;
  }
  return out;
}

// Safe for insertion into HTML text AND attributes: decode what the feed
// sent, then escape & < > " ' so the text can't inject markup. This page
// holds a GitHub token in localStorage, so every string that comes from a
// feed, IGDB or Steam goes through here (or esc() in releases.js).
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str){
  return decodeEntities(str).replace(/[&<>"']/g, c => HTML_ESC[c]);
}

// URLs that go into href/src: only http(s), escaped for attributes.
function safeUrl(url){
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  return u.replace(/[&<>"']/g, c => HTML_ESC[c]);
}

// Broken images (dead thumbnails, missing covers) are removed instead of
// showing a broken icon. One capturing listener replaces inline onerror=
// attributes, which the Content-Security-Policy forbids.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const thumb = img.closest('.thumb');
  if (thumb) { const row = thumb.closest('.row'); if (row) row.classList.remove('has-thumb'); thumb.remove(); }
  else img.remove();
}, true);

let lastHiddenId = null;
let lastHiddenWasFav = false;
let undoTimeout = null;

function addFavorite(id){
  if(isFavorited(id)) return;
  const article = articles.find(a => idFor(a) === id) || favoritesAsArticles().find(a => idFor(a) === id);
  if(!article) return;
  state.favorites.push({
    link: article.link,
    title: article.title,
    date: article.date.toISOString(),
    image: article.image || null,
    sourceId: article.source.id,
    summary: article.summary || ''
  });
  // Invariant: a favorite is never also hidden.
  const h = state.hidden.indexOf(id);
  if(h !== -1) state.hidden.splice(h, 1);
}

function removeFavorite(id){
  const idx = state.favorites.findIndex(f => f.link === id);
  if(idx !== -1) state.favorites.splice(idx, 1);
}

// --- Liked games (Releases tab) -----------------------------------------
// Stored as snapshots in state.likedGames so the "My games" recap still
// works after a game leaves releases.json. Synced with the rest of the
// state through the Save button (markDirty), like favorites.
function isGameLiked(id){ return (state.likedGames || []).some(g => g.id === id); }
function toggleGameLike(game){
  if (!state.likedGames) state.likedGames = [];
  const i = state.likedGames.findIndex(g => g.id === game.id);
  if (i !== -1) state.likedGames.splice(i, 1);
  else state.likedGames.push({
    id: game.id, name: game.name, date: game.date, cover: game.cover || null,
    platforms: game.platforms || [], developers: game.developers || [],
    publishers: game.publishers || [], genres: game.genres || [],
    summary: game.summary || '', steam: game.steam || null, igdb: game.igdb || null,
    steamAppId: game.steamAppId || null,
    dates: game.dates,
  });
  markDirty();
  return i === -1;
}

// Favorite an article from a snapshot (Archive tab: the article may no
// longer be in articles.json). Same invariant: a favorite is never hidden.
function toggleFavoriteSnapshot(a){
  const i = state.favorites.findIndex(f => f.link === a.link);
  if (i !== -1) state.favorites.splice(i, 1);
  else {
    state.favorites.push({ link: a.link, title: a.title, date: a.date, image: a.image || null, sourceId: a.sourceId, summary: a.summary || '' });
    const h = state.hidden.indexOf(a.link);
    if (h !== -1) state.hidden.splice(h, 1);
  }
  markDirty();
  updateCounts();
  return i === -1;
}

function toggleFavorite(id){
  if(isFavorited(id)) removeFavorite(id);
  else addFavorite(id);
}

function hideArticle(id){
  if(!state.hidden.includes(id)) state.hidden.push(id);
  // Swipe-right / bin means "get this out of my way" — if it was a
  // favorite, drop it from favorites too so it doesn't linger in ★.
  lastHiddenWasFav = isFavorited(id);
  removeFavorite(id);
  lastHiddenId = id;
  markDirty();
  render();
  showUndoToast();
}

function showUndoToast(){
  clearTimeout(undoTimeout);
  let toast = document.getElementById('undoToast');
  if(!toast){
    toast = document.createElement('div');
    toast.id = 'undoToast';
    toast.className = 'undo-toast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `Deleted <button id="undoBtn" type="button">Undo</button>`;
  toast.classList.add('show');
  document.getElementById('undoBtn').onclick = () => {
    if(lastHiddenId){
      const idx = state.hidden.indexOf(lastHiddenId);
      if(idx !== -1) state.hidden.splice(idx, 1);
      if(lastHiddenWasFav) addFavorite(lastHiddenId); // restore the favorite too
      markDirty();
      render();
    }
    toast.classList.remove('show');
  };
  undoTimeout = setTimeout(() => toast.classList.remove('show'), 4000);
}

feedEl.addEventListener('click', (e) => {
  // Day-section header (favorites view): toggle expand/collapse
  const header = e.target.closest('.day-header');
  if(header){
    const key = decodeURIComponent(header.dataset.daykey);
    if(expandedDays.has(key)) expandedDays.delete(key);
    else expandedDays.add(key);
    render();
    return;
  }

  const row = e.target.closest('.row');
  if(!row) return;
  const id = decodeURIComponent(row.dataset.id);

  // Desktop action buttons. Mirror the swipe semantics:
  //   • bin  → delete everywhere (hideArticle also drops from favorites)
  //   • star → in Favorites tab, remove from favorites (article returns to
  //            All); elsewhere, add to favorites (leaves the triage queue)
  if(e.target.classList.contains('bin')){
    e.preventDefault();
    hideArticle(id);
    return;
  }
  if(e.target.classList.contains('star')){
    e.preventDefault();
    if(currentFilter === 'favorites') removeFavorite(id);
    else if(isFavorited(id)) removeFavorite(id);
    else addFavorite(id);
    markDirty();
    render();
    return;
  }

  if(e.target.classList.contains('headline')){
    // Read-marking is handled by the pointerup tap-detection below, so the
    // link's default navigation is all that needs to happen here.
    return;
  }
});

// Mark-as-read must survive the tab switch that opening an article causes.
// We commit synchronously to localStorage first (inside markDirty), then
// schedule a debounced online push so the read state (red dot removed)
// syncs to your other devices — batched so opening several articles in a
// row only triggers one save.
function markAsRead(id, row){
  if(!state.read.includes(id)){
    state.read.push(id);
    markDirty();             // local write + pending counter
    scheduleReadSync();      // debounced online push (see below)
  }
  if(row) row.classList.add('read');
  updateCounts();
}

// Pushes read/state to GitHub a few seconds after the last article was
// opened. Debounced so a burst of reads = a single API round-trip.
let readSyncTimer = null;
function scheduleReadSync(){
  if (!getGithubConfig()) return;
  clearTimeout(readSyncTimer);
  readSyncTimer = setTimeout(() => {
    if (pendingChanges > 0 && !manualSaveRunning) manualSave();
  }, 4000); // 4s after you stop opening articles
}

// Tap-vs-scroll detection: on mobile, pressing a headline to start a
// scroll must NOT count as opening it. We record where the finger lands
// on pointerdown, then on pointerup only mark the article read if the
// finger lifted close to where it started (a real tap) and quickly enough.
// A drag beyond the threshold is a scroll and is ignored.
// --- Unified pointer handling: tap-to-read + swipe-right-to-delete ------
// A single gesture tracker so tap, vertical scroll, and horizontal swipe
// never fight each other. Decision logic:
//   • Movement stays small           → it's a TAP (mark read, if on title)
//   • Movement is mostly VERTICAL     → let the browser scroll, do nothing
//   • Movement is clearly HORIZONTAL  → it's a SWIPE; follow the finger,
//     and if released past SWIPE_TRIGGER to the right, delete with an
//     animation. Swipe is pointer/touch only (mouse drags are ignored so
//     desktop keeps using the buttons).
const TAP_MOVE_THRESHOLD = 10;    // px — below this, it's a tap
const TAP_TIME_THRESHOLD = 500;   // ms
const SWIPE_DIR_RATIO = 1.3;      // horizontal must exceed vertical by this factor to count as a swipe
const SWIPE_TRIGGER = 110;        // px — how far right you must swipe to delete (deliberately long)
const SWIPE_MAX_VISUAL = 160;     // caps how far the row visually follows the finger

let gesture = null;

function currentPointIsInteractive(target){
  // taps on the action buttons/links keep their own click handlers
  return target.closest('.star, .bin, .mc-check');
}

feedEl.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.row');
  if(!row){ gesture = null; return; }
  gesture = {
    row,
    id: decodeURIComponent(row.dataset.id),
    x: e.clientX, y: e.clientY, t: Date.now(),
    onHeadline: !!e.target.closest('.headline'),
    onInteractive: !!currentPointIsInteractive(e.target),
    mode: null,            // null | 'tap' | 'scroll' | 'swipe'
    pointerType: e.pointerType,
  };
});

feedEl.addEventListener('pointermove', (e) => {
  if(!gesture) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;

  // Lock the gesture mode once movement is meaningful
  if(gesture.mode === null){
    if(Math.abs(dx) < TAP_MOVE_THRESHOLD && Math.abs(dy) < TAP_MOVE_THRESHOLD) return;
    // Swipe only for touch/pen and clearly-horizontal motion (either way).
    const horizontal = Math.abs(dx) > Math.abs(dy) * SWIPE_DIR_RATIO;
    if(gesture.pointerType !== 'mouse' && horizontal && !gesture.onInteractive){
      gesture.mode = 'swipe';
      gesture.row.classList.add('swiping');
    } else {
      gesture.mode = 'scroll'; // vertical or mouse → let the page handle it
    }
  }

  if(gesture.mode === 'swipe'){
    e.preventDefault(); // stop the page from scrolling while swiping a row
    const dir = dx >= 0 ? 'right' : 'left';
    gesture.row.classList.toggle('swipe-right', dir === 'right');
    gesture.row.classList.toggle('swipe-left', dir === 'left');
    const travel = Math.max(-SWIPE_MAX_VISUAL, Math.min(dx, SWIPE_MAX_VISUAL));
    gesture.row.style.transform = `translateX(${travel}px)`;
    const progress = Math.min(1, Math.abs(dx) / SWIPE_TRIGGER);
    gesture.row.style.setProperty('--swipe-progress', progress.toFixed(2));
    gesture.row.classList.toggle('swipe-armed', Math.abs(dx) >= SWIPE_TRIGGER);
  }
}, { passive: false });

feedEl.addEventListener('pointerup', (e) => {
  if(!gesture) return;
  const g = gesture;
  gesture = null;

  if(g.mode === 'swipe'){
    const dx = e.clientX - g.x;
    g.row.classList.remove('swiping', 'swipe-armed', 'swipe-right', 'swipe-left');
    if(dx >= SWIPE_TRIGGER){
      // Right → delete everywhere (hideArticle also drops it from favorites)
      animateSwipeDelete(g.row, g.id);
    } else if(dx <= -SWIPE_TRIGGER){
      // Left → snap back, then act depending on the current tab:
      //  • Favorites tab: remove from favorites (article returns to "All")
      //  • Any other tab: add to favorites (leaves the triage queue)
      g.row.style.transform = '';
      g.row.style.removeProperty('--swipe-progress');
      if(currentFilter === 'favorites'){
        removeFavorite(g.id);
      } else {
        addFavorite(g.id);
      }
      markDirty();
      render();
    } else {
      // Not far enough either way → snap back
      g.row.style.transform = '';
      g.row.style.removeProperty('--swipe-progress');
    }
    return;
  }

  // Otherwise, treat as a possible tap-to-read (same rules as before)
  if(g.onHeadline && !g.onInteractive){
    const movedX = Math.abs(e.clientX - g.x);
    const movedY = Math.abs(e.clientY - g.y);
    const elapsed = Date.now() - g.t;
    if(movedX <= TAP_MOVE_THRESHOLD && movedY <= TAP_MOVE_THRESHOLD && elapsed <= TAP_TIME_THRESHOLD){
      markAsRead(g.id, g.row);
    }
  }
});

feedEl.addEventListener('pointercancel', () => {
  if(gesture && gesture.mode === 'swipe'){
    gesture.row.classList.remove('swiping', 'swipe-armed', 'swipe-right', 'swipe-left');
    gesture.row.style.transform = '';
    gesture.row.style.removeProperty('--swipe-progress');
  }
  gesture = null;
});

// Slide the row fully off to the right, then delete.
function animateSwipeDelete(row, id){
  row.classList.add('swipe-deleting');
  row.style.transform = 'translateX(110%)';
  row.addEventListener('transitionend', function done(ev){
    if(ev.propertyName !== 'transform') return;
    row.removeEventListener('transitionend', done);
    hideArticle(id); // adds to hidden (+ removes favorite), saves, re-renders, Undo
  }, { once: true });
}

const searchInputEl = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');

// Re-render 120 ms after the last keystroke, not on every key.
let searchTimer = null;
searchInputEl.addEventListener('input', () => {
  searchQuery = searchInputEl.value.trim().toLowerCase();
  clearSearchBtn.style.display = searchQuery ? 'block' : 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 120);
});

clearSearchBtn.addEventListener('click', () => {
  clearTimeout(searchTimer);
  searchInputEl.value = '';
  searchQuery = '';
  clearSearchBtn.style.display = 'none';
  searchInputEl.focus();
  render();
});

// --- Bottom tab bar ------------------------------------------------------
// Switching tab shows the new view from the top; tapping the active tab
// again scrolls back to the top.
document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if(!btn) return;
  const same = btn.dataset.filter === currentFilter;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t === btn);
    if (t === btn) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  currentFilter = btn.dataset.filter;
  if (!same) render();
  window.scrollTo({ top: 0, behavior: same ? 'smooth' : 'auto' });
});

// Source filter: a native <select> (most reliable control on mobile),
// built from SOURCES. Green outline while a source is selected.
const sourceSelectEl = document.getElementById('sourceSelect');
SOURCES.forEach(s => {
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = s.name;
  sourceSelectEl.appendChild(opt);
});
sourceSelectEl.addEventListener('change', () => {
  currentSource = sourceSelectEl.value;
  sourceSelectEl.classList.toggle('filtered', currentSource !== 'all');
  render();
});

// --- Small status toast (re-sync, mark all read, remote updates) ---------
function showToast(text, ms = 2200){
  let t = document.getElementById('infoToast');
  if (!t){
    t = document.createElement('div');
    t.id = 'infoToast';
    t.className = 'undo-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

// --- ⋯ menu: sync status, occasional actions, links to every source -----
const menuBtn = document.getElementById('menuBtn');
const menuEl = document.getElementById('menu');
function renderMenu(){
  const [cls, label] = githubConnected ? ['connected', 'Synced with GitHub']
    : lastSyncError ? ['error', 'GitHub sync error'] : ['', 'Set up GitHub sync'];
  menuEl.innerHTML = `
    <button class="menu-item status ${cls}" data-act="settings" title="${escapeHtml(lastSyncError)}"><span class="mi-ico">●</span>${label}</button>
    <div class="menu-sep"></div>
    <button class="menu-item" data-act="markall"><span class="mi-ico">✓</span>Mark all as read</button>
    <button class="menu-item" data-act="resync"><span class="mi-ico">⇅</span>Re-sync with GitHub</button>
    <div class="menu-sep"></div>
    <div class="menu-head">Open a site</div>
    ${SOURCES.map(s => `<a class="menu-item" href="${safeUrl(s.home)}" target="_blank" rel="noopener">${escapeHtml(s.name)}<span class="mi-ext">↗</span></a>`).join('')}
    <a class="menu-item" href="https://www.metacritic.com/game/" target="_blank" rel="noopener">New on Metacritic<span class="mi-ext">↗</span></a>`;
}
function closeMenu(){
  menuEl.classList.remove('show');
  menuBtn.classList.remove('active');
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (menuEl.classList.contains('show')) return closeMenu();
  renderMenu();
  menuEl.classList.add('show');
  menuBtn.classList.add('active');
  menuBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => {
  if (!menuEl.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
menuEl.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  closeMenu();
  if (item.dataset.act === 'settings') openGithubModal();
  else if (item.dataset.act === 'markall') markAllRead();
  else if (item.dataset.act === 'resync') resyncWithGithub();
});

function markAllRead(){
  let n = 0;
  articles.forEach(a => {
    const id = idFor(a);
    if(!state.read.includes(id)){ state.read.push(id); n++; }
  });
  if (!n){ showToast('Everything is already read'); return; }
  markDirty();
  render();
  showToast(`${n} article${n > 1 ? 's' : ''} marked as read`);
}

// Refresh: re-read articles.json and pick up other devices' saves. Never
// overwrites unsaved local changes (checkRemoteStateUpdate skips then).
const refreshBtnEl = document.getElementById('refreshBtn');
refreshBtnEl.addEventListener('click', async () => {
  if (refreshBtnEl.classList.contains('spinning')) return;
  refreshBtnEl.classList.add('spinning');
  await Promise.all([refreshArticlesQuietly(), checkRemoteStateUpdate()]);
  setTimeout(() => refreshBtnEl.classList.remove('spinning'), 400);
});

// Re-sync (⋯ menu): the manual recovery tool for cross-device drift.
// Pulls GitHub's copy, keeps this device's unsaved changes (merge), fixes
// impossible states (favorite wins over deleted), re-renders, and pushes
// back only if something actually needs saving.
let resyncRunning = false;
async function resyncWithGithub(){
  const cfg = getGithubConfig();
  if (!cfg){ openGithubModal(); return; }
  if (resyncRunning) return;
  resyncRunning = true;
  showToast('Re-syncing…', 10000);
  try {
    const { content, sha } = await githubGetFile(cfg);
    githubSha = sha;
    githubConnected = true;
    if (!content) enforceStateConsistency();          // no file yet: this device's copy becomes it
    else if (pendingChanges > 0) mergeRemoteIntoState(content);
    else adoptRemote(content);
    updateSyncNote();
    render();
    const needsSave = !content || pendingChanges > 0 || JSON.stringify(pickState(state)) !== JSON.stringify(pickState(content));
    let ok = true;
    if (needsSave) {
      if (!pendingChanges) setPending(1);
      await manualSave();
      ok = lastSaveOk;
    }
    showToast(ok ? 'Re-synced with GitHub' : 'Re-sync failed: check ⚙ settings');
  } catch (e) {
    console.error('Re-sync failed:', e);
    githubConnected = false;
    updateSyncNote(e.message);
    showToast('Re-sync failed: check ⚙ settings');
  } finally {
    resyncRunning = false;
  }
}

// articles.json is re-validated, not re-downloaded: 'no-cache' sends the
// ETag to GitHub Pages, which answers 304 (no body) when nothing changed.
const fetchArticlesJson = () => fetch('./articles.json', { cache: 'no-cache' })
  .then(res => res.ok ? res.json() : null)
  .then(data => (data && Array.isArray(data.articles) && data.articles.length ? data : null));

// First load. Returns false when there is nothing to show (message kept).
async function loadFeeds(){
  feedEl.innerHTML = `<div class="empty">Loading articles<span class="cursor"></span></div>`;
  try {
    const data = await fetchArticlesJson();
    if (data) { applyJsonData(data); return true; }
    feedEl.innerHTML = `<div class="empty">No articles found. Run “Refresh Dispatch articles” in GitHub Actions, then refresh.</div>`;
  } catch (e) {
    console.warn('articles.json unavailable:', e.message);
    feedEl.innerHTML = `<div class="empty">You’re offline and there’s no saved copy of the articles yet.</div>`;
  }
  return false;
}

// --- GitHub settings modal ---------------------------------------------
const ghModal = document.getElementById('githubModal');

// Strips ALL whitespace including invisible/unicode variants (non-breaking
// spaces, zero-width chars) that mobile keyboards and copy-paste sometimes
// inject — a plain .trim() misses these and they silently break the token.
function cleanField(v){
  return (v || '').replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '');
}

function openGithubModal(){
  const cfg = getGithubConfig();
  document.getElementById('ghOwner').value = cfg?.owner || '';
  document.getElementById('ghRepo').value = cfg?.repo || '';
  document.getElementById('ghToken').value = cfg?.token || '';
  ghModal.classList.add('show');
  refreshPushUI();
}

// --- Push notifications ------------------------------------------------
// The VAPID key pair is generated here with WebCrypto (no tools needed):
// the PUBLIC key goes into the synced state (state.push.publicKey), the
// PRIVATE key is shown once (kept in this device's localStorage) for the
// user to store as the GitHub secret VAPID_PRIVATE_KEY. Each device that
// turns notifications on adds its subscription to state.push.subscriptions;
// scripts/send-push.mjs (articles workflow) sends to all of them.
const PUSH_PRIV_KEY = 'dispatch-vapid-private';
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };

async function generateVapidKeys(){
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('raw', kp.publicKey);       // 65 bytes, uncompressed
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);      // d = 32-byte private scalar
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

async function currentPushSubscription(){
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushUI(){
  const status = document.getElementById('pushStatus');
  const onBtn = document.getElementById('pushOnBtn'), offBtn = document.getElementById('pushOffBtn');
  const keyBox = document.getElementById('pushKeyBox');
  let priv = null; try { priv = localStorage.getItem(PUSH_PRIV_KEY); } catch (e) {}
  keyBox.hidden = !priv;
  if (priv) document.getElementById('pushPrivKey').value = priv;
  if (!('PushManager' in window) || !('Notification' in window)){
    status.textContent = 'This browser does not support push notifications. On Android, use Chrome with Dispatch installed on the home screen.';
    onBtn.hidden = true; offBtn.hidden = true; return;
  }
  const sub = await currentPushSubscription().catch(() => null);
  const known = sub && ((state.push && state.push.subscriptions) || []).some(s => s.endpoint === sub.endpoint);
  if (sub && known){
    status.textContent = `Notifications are on for this device ✓ (${(state.push.subscriptions || []).length} device${state.push.subscriptions.length > 1 ? 's' : ''} in total).`;
    onBtn.hidden = true; offBtn.hidden = false;
  } else {
    status.textContent = Notification.permission === 'denied'
      ? 'Notifications are blocked for Dispatch in your phone settings. Allow them there, then come back here.'
      : 'Get a notification on this device when new articles arrive (at most once an hour, never between 23:00 and 07:00).';
    onBtn.hidden = false; offBtn.hidden = true;
  }
}

async function enablePush(){
  const status = document.getElementById('pushStatus');
  if (!getGithubConfig()){ status.textContent = 'Connect GitHub sync first: the subscription is stored in your sync file so the server can reach this device.'; return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted'){ status.textContent = 'Permission not granted, so notifications stay off.'; return; }
    if (!state.push || !state.push.publicKey){
      const keys = await generateVapidKeys();
      state.push = { publicKey: keys.publicKey, subscriptions: [] };
      try { localStorage.setItem(PUSH_PRIV_KEY, keys.privateKey); } catch (e) {}
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another key can't be reused.
    if (sub && sub.options && sub.options.applicationServerKey && b64url(sub.options.applicationServerKey) !== state.push.publicKey){ await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(state.push.publicKey) });
    const json = sub.toJSON();
    const subs = (state.push.subscriptions || []).filter(s => s.endpoint !== json.endpoint);
    subs.push({ endpoint: json.endpoint, keys: json.keys, device: navigator.userAgent.slice(0, 80), added: new Date().toISOString() });
    state.push.subscriptions = subs;
    saveStateInstant();
    await saveState();
    status.textContent = 'Saved. Notifications start with the next articles run that finds something new.';
  } catch (e) {
    status.textContent = 'Could not turn notifications on: ' + e.message;
  }
  refreshPushUI();
}

async function disablePush(){
  try {
    const sub = await currentPushSubscription();
    if (sub){
      if (state.push) state.push.subscriptions = (state.push.subscriptions || []).filter(s => s.endpoint !== sub.endpoint);
      await sub.unsubscribe();
      saveStateInstant();
      await saveState();
    }
  } catch (e) { /* ignore */ }
  refreshPushUI();
}

// Tapping the notification while the app is open: show the feed, refreshed.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'dispatch-open-feed') {
      const all = document.querySelector('.tab[data-filter="all"]');
      if (all) all.click();
      refreshArticlesQuietly();
    }
  });
}

document.getElementById('pushOnBtn').addEventListener('click', enablePush);
document.getElementById('pushOffBtn').addEventListener('click', disablePush);
// The private key only needs to live in the GitHub secret: once it's there,
// remove this device's copy so nothing on the phone can leak it.
document.getElementById('pushForgetBtn').addEventListener('click', () => {
  if (!confirm('Remove the private key from this device? Do this only after saving it as the VAPID_PRIVATE_KEY secret on GitHub.')) return;
  try { localStorage.removeItem(PUSH_PRIV_KEY); } catch (e) {}
  refreshPushUI();
});
document.getElementById('pushCopyBtn').addEventListener('click', async (e) => {
  const input = document.getElementById('pushPrivKey');
  try { await navigator.clipboard.writeText(input.value); e.target.textContent = 'Copied ✓'; }
  catch (err) { input.select(); e.target.textContent = 'Select & copy'; }
  setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
});
function closeGithubModal(){ ghModal.classList.remove('show'); }

document.getElementById('ghSettingsBtn').addEventListener('click', openGithubModal);
document.getElementById('ghCancelBtn').addEventListener('click', closeGithubModal);
ghModal.addEventListener('click', (e) => { if (e.target === ghModal) closeGithubModal(); });

// Reveal/hide the token so it can be visually verified on mobile
document.getElementById('ghTokenReveal').addEventListener('click', () => {
  const input = document.getElementById('ghToken');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('ghSaveBtn').addEventListener('click', async () => {
  const owner = cleanField(document.getElementById('ghOwner').value);
  const repo = cleanField(document.getElementById('ghRepo').value);
  const token = cleanField(document.getElementById('ghToken').value);
  if (!owner || !repo || !token) {
    alert('Please fill in all three fields.');
    return;
  }
  // GitHub names only use letters, digits, - (owner) and . _ - (repo).
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    alert('The username or repository name has characters GitHub doesn\'t allow. Check for typos.');
    return;
  }
  const prev = getGithubConfig();
  if (!prev || prev.owner !== owner || prev.repo !== repo) {
    // Another repo: forget the last-synced copy and cached sha/ETag of the old one.
    try { localStorage.removeItem(BASE_KEY); } catch (e) {}
    githubSha = null; remoteEtag = null;
  }
  saveGithubConfig({ owner, repo, token });

  const saveBtn = document.getElementById('ghSaveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Connecting…';

  await loadState();                        // pulls the file (merging unsaved local changes)
  if (githubConnected && saveAfterBoot) {    // no file yet, or local changes to push
    saveAfterBoot = false;
    await manualSave();
  }

  saveBtn.disabled = false;
  saveBtn.textContent = 'Save & connect';

  if (!githubConnected) {
    const rawErr = lastSyncError || 'Unknown error';
    let hint = '';
    if (rawErr.includes('404')) {
      hint = '\n\nA 404 almost always means one of these:\n' +
        '• the token has no access to THIS repo (Repository access → Only select repositories → this repo), or is not "Contents: Read and write"\n' +
        '• the token has expired\n' +
        '• a typo or wrong capitalisation in the username or repo name\n\n' +
        `URL tested: api.github.com/repos/${owner}/${repo}/contents/dispatch-state.json\n\n` +
        'Tip: tap 👁 to reveal the token and check it has no stray space.';
    } else if (rawErr.includes('403')) {
      hint = '\n\nA 403 means missing permissions: the token needs "Contents: Read and write".';
    } else if (rawErr.includes('401')) {
      hint = '\n\nA 401 means the token was not recognised (invalid or expired). Generate a new one.';
    }
    alert('Could not connect to GitHub.\n\nError: ' + rawErr + hint);
    return; // keep the modal open so the fields can be fixed
  }

  closeGithubModal();
  render();
});

document.getElementById('ghDisconnectBtn').addEventListener('click', () => {
  clearGithubConfig();
  githubConnected = false;
  closeGithubModal();
  updateSyncNote();
});

(async function init(){
  await loadState();
  if (!(await loadFeeds())) updateCounts();   // keep the "no articles" message visible
  updateSaveButton();                         // unsaved changes from last session
  if (saveAfterBoot) { saveAfterBoot = false; manualSave(); }
})();

// Keep articles (and therefore the unread badge) fresh while the app is
// open or backgrounded: re-pull articles.json regularly, and also whenever
// the app regains focus. This is how the badge count climbs through the
// day as the GitHub Action commits new articles.
const ARTICLES_REFRESH_MS = 5 * 60 * 1000; // 5 min while the app is alive
const STATE_POLL_MS = 30 * 1000;           // 30s: check if another device saved

async function refreshArticlesQuietly(){
  try {
    const data = await fetchArticlesJson();
    if (!data) return;
    // Same build as the one on screen: just refresh "updated N min ago" (no
    // re-render, so scroll-read and the list stay as they are).
    if (data.generatedAt && data.generatedAt === articlesGeneratedAt) updateArticlesNote();
    else applyJsonData(data);
  } catch (e) { /* offline or not deployed yet; keep current data */ }
}

// --- Auto-refresh when another device saved ----------------------------
// GitHub Pages can't push to us, so we poll dispatch-state.json (ETag:
// usually a free 304). If its sha changed and this device has nothing
// unsaved, adopt it. A toast appears only when something you can see
// changed — not for the server's routine clean-up of old read links.
let checkingRemote = false;
const busySaving = () => pendingChanges > 0 || manualSaveRunning || saveInFlight;
async function checkRemoteStateUpdate(){
  const cfg = getGithubConfig();
  if (!cfg || checkingRemote || busySaving()) return;
  checkingRemote = true;
  try {
    const r = await githubGetFile(cfg, { conditional: true });
    if (r.notModified || !r.sha || r.sha === githubSha) return;
    if (busySaving()) return;          // you acted while we were fetching: keep your changes
    const before = visibleSig();
    githubSha = r.sha;
    adoptRemote(r.content);
    githubConnected = true;
    updateSyncNote();
    if (visibleSig() !== before) { render(); flashSyncedFromRemote(); }
  } catch (e) {
    // transient (offline, rate limit) — just try again next tick
  } finally {
    checkingRemote = false;
  }
}

// Small, non-intrusive toast so you know the view updated itself.
function flashSyncedFromRemote(){ showToast('Updated from another device'); }

setInterval(refreshArticlesQuietly, ARTICLES_REFRESH_MS);
setInterval(() => {
  // Only poll while the app is on screen — saves API calls and battery.
  if (document.visibilityState === 'visible') checkRemoteStateUpdate();
}, STATE_POLL_MS);
// Coming back to the app fires both 'visibilitychange' and 'focus': one refresh.
let lastResume = 0;
function onResume(){
  if (Date.now() - lastResume < 2000) return;
  lastResume = Date.now();
  refreshArticlesQuietly();
  checkRemoteStateUpdate();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onResume(); });
window.addEventListener('focus', onResume);

// Register the service worker: offline support, installability, AND
// periodic background sync so the badge can update while the app is merely
// backgrounded (not actively rendering).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');

      // Ask for Periodic Background Sync if available (Chrome/Android).
      // This lets the service worker wake up roughly every so often to
      // recount unread articles and refresh the badge on its own.
      if ('periodicSync' in reg) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'granted') {
            await reg.periodicSync.register('dispatch-badge-refresh', {
              minInterval: 60 * 60 * 1000, // ~1h; the browser decides the real cadence
            });
          }
        } catch (e) { /* periodic sync not available or not permitted */ }
      }
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
}
