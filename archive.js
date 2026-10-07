// Dispatch — "Archive" tab: search every article ever fetched.
// Data: archive/index.json ({ days: { "YYYY-MM-DD": count } }) and one
// archive/YYYY-MM-DD.json per day, written by scripts/fetch-articles.mjs.
// Day files are downloaded only for the selected period and kept in memory
// for the session; the service worker caches past days.
// Exposes a single global: renderArchive(container).
// Uses from index.html: SOURCES, state, safeUrl, escapeHtml, toggleFavoriteSnapshot.
(function(){
  const PAGE = 100;            // results shown per "Show more"
  const RANGES = [
    { id: '7',   label: 'Last 7 days',   days: 7 },
    { id: '30',  label: 'Last 30 days',  days: 30 },
    { id: '90',  label: 'Last 90 days',  days: 90 },
    { id: 'all', label: 'Everything',    days: Infinity },
  ];

  let container = null;
  let index = null;            // archive/index.json
  const dayCache = new Map();  // day -> articles[]
  let query = '', range = '30', source = 'all', shown = PAGE;
  let loadToken = 0, debounce = null;

  // Accent- and case-insensitive matching ("réseau" finds "reseau").
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const srcOf = (id) => (typeof SOURCES !== 'undefined' && SOURCES.find(s => s.id === id)) || { name: id, category: '', color: '' };
  const isFavLink = (link) => typeof state !== 'undefined' && (state.favorites || []).some(f => f.link === link);

  function daysInRange(){
    const all = Object.keys((index && index.days) || {}).sort().reverse();
    const r = RANGES.find(x => x.id === range);
    if (!isFinite(r.days)) return all;
    const floor = new Date(Date.now() - r.days * 86400000).toISOString().slice(0, 10);
    return all.filter(d => d >= floor);
  }

  async function fetchJson(url){
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loadIndex(){
    index = await fetchJson('./archive/index.json');
  }

  // Downloads missing day files for the range, 6 at a time.
  async function loadDays(days, onProgress){
    const todo = days.filter(d => !dayCache.has(d));
    let done = days.length - todo.length;
    const worker = async () => {
      while (todo.length){
        const d = todo.shift();
        try { dayCache.set(d, await fetchJson(`./archive/${d}.json`)); }
        catch (e){ dayCache.set(d, []); }
        done++; onProgress(done, days.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  function results(){
    const words = norm(query).split(/\s+/).filter(Boolean);
    const out = [];
    for (const d of daysInRange()){
      for (const a of dayCache.get(d) || []){
        if (source !== 'all' && a.sourceId !== source) continue;
        if (words.length){
          const hay = norm(a.title + ' ' + a.summary);
          if (!words.every(w => hay.includes(w))) continue;
        }
        out.push(a);
      }
    }
    return out.sort((x, y) => (x.date < y.date ? 1 : -1));
  }

  // Highlights the searched words inside already-escaped text.
  function mark(text){
    const safe = escapeHtml(text);
    const words = query.trim().split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return safe;
    return safe.replace(new RegExp(`(${words.join('|')})`, 'gi'), '<mark>$1</mark>');
  }

  const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  function drawResults(){
    const el = container.querySelector('#arcResults');
    const meta = container.querySelector('#arcMeta');
    if (!el) return;
    const list = results();
    const total = daysInRange().reduce((n, d) => n + ((dayCache.get(d) || []).length), 0);
    meta.textContent = query.trim() || source !== 'all'
      ? `${list.length.toLocaleString('en-GB')} result${list.length === 1 ? '' : 's'} in ${total.toLocaleString('en-GB')} articles`
      : `${total.toLocaleString('en-GB')} articles in this period`;

    if (!list.length){
      el.innerHTML = `<div class="empty">${query.trim() ? `NO RESULTS FOR "${escapeHtml(query)}"` : 'NO ARTICLES IN THIS PERIOD'}<span class="cursor"></span></div>`;
      return;
    }
    let html = '', cur = null;
    for (const a of list.slice(0, shown)){
      const day = a.date.slice(0, 10);
      if (day !== cur){ html += `<div class="day-sep"><span>${dayLabel(a.date)}</span></div>`; cur = day; }
      const s = srcOf(a.sourceId);
      const fav = isFavLink(a.link);
      html += `
        <div class="arc-row">
          <div class="arc-time">${timeLabel(a.date)}</div>
          <div class="arc-body">
            <span class="tag ${s.color}">${escapeHtml(s.category)}</span>
            <a class="headline" href="${safeUrl(a.link) || '#'}" target="_blank" rel="noopener">${mark(a.title)}</a>
            ${a.summary ? `<div class="summary">${mark(a.summary)}</div>` : ''}
            <div class="source-name">${escapeHtml(s.name)}</div>
          </div>
          <button class="star arc-star ${fav ? 'on' : ''}" data-link="${safeUrl(a.link)}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>
        </div>`;
    }
    if (list.length > shown) html += `<button class="arc-more" id="arcMore">Show ${Math.min(PAGE, list.length - shown)} more (${(list.length - shown).toLocaleString('en-GB')} left)</button>`;
    el.innerHTML = html;
  }

  async function refreshData(){
    const token = ++loadToken;
    const el = container.querySelector('#arcResults');
    try {
      if (!index) await loadIndex();
    } catch (e){
      el.innerHTML = '<div class="empty">ARCHIVE NOT FOUND — it is created by the next "Refresh Dispatch articles" run<span class="cursor"></span></div>';
      return;
    }
    const days = daysInRange();
    const missing = days.filter(d => !dayCache.has(d)).length;
    if (missing){
      el.innerHTML = `<div class="empty">LOADING ${missing} DAY${missing > 1 ? 'S' : ''} OF ARCHIVE…<span class="cursor"></span></div>`;
      await loadDays(days, (done, n) => {
        if (token !== loadToken) return;
        const meta = container.querySelector('#arcMeta');
        if (meta) meta.textContent = `Loading ${done} / ${n} days…`;
      });
    }
    if (token === loadToken) drawResults();
  }

  function drawShell(){
    const sources = typeof SOURCES !== 'undefined' ? SOURCES : [];
    const first = index ? Object.keys(index.days).sort()[0] : null;
    container.innerHTML = `
      <div class="arc-tools">
        <div class="search-row arc-search-row">
          <span class="search-icon">🔍</span>
          <input type="search" id="arcQuery" class="search-bar" placeholder="Search titles and summaries…" value="${escapeHtml(query)}" autocomplete="off">
        </div>
        <div class="arc-filters">
          <select id="arcRange" class="source-select" aria-label="Period">${RANGES.map(r => `<option value="${r.id}" ${r.id === range ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
          <select id="arcSource" class="source-select" aria-label="Source"><option value="all">All sources</option>${sources.map(s => `<option value="${s.id}" ${s.id === source ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
        </div>
        <div class="arc-meta"><span id="arcMeta"></span>${first ? ` · archive since ${new Date(first).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</div>
      </div>
      <div id="arcResults"></div>`;

    container.querySelector('#arcQuery').addEventListener('input', (e) => {
      query = e.target.value; shown = PAGE;
      clearTimeout(debounce); debounce = setTimeout(drawResults, 180);
    });
    container.querySelector('#arcRange').addEventListener('change', (e) => { range = e.target.value; shown = PAGE; refreshData(); });
    container.querySelector('#arcSource').addEventListener('change', (e) => { source = e.target.value; shown = PAGE; drawResults(); });
  }

  window.renderArchive = function(el){
    if (container !== el){
      container = el;
      container.addEventListener('click', (e) => {
        const more = e.target.closest('#arcMore');
        if (more){ shown += PAGE; drawResults(); return; }
        const star = e.target.closest('.arc-star');
        if (star && typeof toggleFavoriteSnapshot === 'function'){
          let a = null;
          for (const list of dayCache.values()){ a = list.find(x => safeUrl(x.link) === star.dataset.link); if (a) break; }
          if (!a) return;
          const on = toggleFavoriteSnapshot(a);
          star.classList.toggle('on', on);
          star.textContent = on ? '★' : '☆';
          star.title = on ? 'Remove from favorites' : 'Add to favorites';
        }
      });
    }
    // Background re-renders (article refresh, sync polling) must not wipe
    // what you're typing: only reload when the tab is (re)opened.
    // index.html resets data-active to '0' whenever another tab is shown.
    if (container.dataset.active === '1') return;
    container.dataset.active = '1';
    // Keeps the typed query, period and source; the index is re-read each
    // time the tab opens so today's new articles show up.
    if (!container.querySelector('#arcQuery')) drawShell();
    index = null;
    const today = new Date().toISOString().slice(0, 10);
    dayCache.delete(today);   // today's file keeps growing
    loadIndex().then(drawShell).catch(() => {}).finally(refreshData);
  };
})();
