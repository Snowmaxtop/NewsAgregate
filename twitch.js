// Dispatch — Twitch tab: the most-watched categories on Twitch.
// Reads twitch.json (every hour) and twitch-history.json (once a day),
// written by scripts/fetch-twitch.mjs. Exposes a single global:
// renderTwitch(container). Uses isGameLiked() from app.js (♥ on games you
// liked in Releases: Twitch gives each game's IGDB id).
(function(){
  const PERIODS = [
    { id: 'now', label: 'Live now' },
    { id: '1',  label: 'Yesterday', days: 1,  minPrev: 1 },
    { id: '7',  label: '7 days',    days: 7,  minPrev: 5 },
    { id: '30', label: '30 days',   days: 30, minPrev: 21 },
  ];
  const SHOW = 100;            // rows shown
  const RISER_MIN = 1000;      // average viewers needed to appear in Risers
  const RISER_GROWTH = 0.05;   // and at least +5% vs the previous period
  const REFETCH_MS = 15 * 60 * 1000;
  const DAY = 86400000;

  let container = null, cur = null, hist = null, loadedAt = 0, loading = null;
  let period = 'now', scope = 'games', risers = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Math.round(n).toLocaleString('en-GB');
  const compact = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n));
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);

  function load(){
    if (cur && Date.now() - loadedAt < REFETCH_MS) return Promise.resolve();
    if (loading) return loading;
    const get = (f) => fetch(f, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
    loading = Promise.all([get('./twitch.json'), get('./twitch-history.json')])
      .then(([c, h]) => { if (c) { cur = c; loadedAt = Date.now(); } if (h) hist = h; })
      .finally(() => { loading = null; });
    return loading;
  }

  const info = (id) => (cur && cur.games && cur.games[id]) || (hist && hist.games && hist.games[id]) || null;
  const isGame = (id) => { const g = info(id); return !!(g && g.igdb); };

  // Average viewers per category over `days` finished UTC days ending
  // yesterday, shifted `offset` days back for the comparison window.
  function windowStats(days, offset){
    const today = Date.parse(ymd(Date.now()) + 'T00:00:00Z');
    const have = [];
    for (let i = 1; i <= days; i++){ const d = ymd(today - (i + offset) * DAY); if (hist && hist.days && hist.days[d]) have.push(d); }
    if (!have.length) return null;
    const by = new Map();
    let samples = 0;
    for (const d of have){
      samples += hist.days[d].n || 0;
      for (const [id, v] of Object.entries(hist.days[d].g || {})){
        const r = by.get(id) || { id, sum: 0, peak: 0, ch: 0, fr: 0 };
        r.sum += v[0]; r.peak = Math.max(r.peak, v[1]); r.ch += v[2]; r.fr += v[3];
        by.set(id, r);
      }
    }
    const n = have.length;
    return { days: n, samples, rows: [...by.values()].map(r => ({ id: r.id, viewers: r.sum / n, hours: r.sum * 24, channels: r.ch / n, fr: r.sum ? r.fr / r.sum : 0, peak: r.peak })) };
  }

  // Rank within the chosen scope (games only, or every category).
  const ranked = (rows) => rows.filter(r => scope === 'all' || isGame(r.id))
    .sort((a, b) => b.viewers - a.viewers).map((r, i) => ({ ...r, rank: i + 1 }));

  function currentView(){
    if (period === 'now'){
      const rows = ((cur && cur.now) || []).map(([id, viewers, channels, fr, top, topViewers]) => ({ id, viewers, channels, fr: viewers ? fr / viewers : 0, top, topViewers }));
      return { live: true, rows: ranked(rows) };
    }
    const p = PERIODS.find(x => x.id === period);
    const w = windowStats(p.days, 0);
    if (!w) return { p, rows: [] };
    const prevW = windowStats(p.days, p.days);
    const prev = prevW && prevW.days >= p.minPrev ? ranked(prevW.rows) : null;
    const rows = ranked(w.rows);
    if (prev){
      const before = new Map(prev.map(r => [r.id, r]));
      for (const r of rows){
        const b = before.get(r.id);
        r.isNew = !b;
        r.move = b ? b.rank - r.rank : 0;
        r.prevViewers = b ? b.viewers : 0;
        r.growth = b && b.viewers ? r.viewers / b.viewers - 1 : null;
      }
    }
    return { p, w, compared: !!prev, rows };
  }

  function badge(r){
    if (risers) return r.isNew ? '<span class="mo mo-new" title="Not in the previous period\'s list">NEW</span>' : `<span class="mo mo-up">▲${fmt(r.growth * 100)}%</span>`;
    if (r.isNew) return '<span class="mo mo-new" title="Not in the previous period\'s list">NEW</span>';
    if (r.move > 0) return `<span class="mo mo-up" title="Up ${r.move} places">▲${r.move}</span>`;
    if (r.move < 0) return `<span class="mo mo-down" title="Down ${-r.move} places">▼${-r.move}</span>`;
    return '';
  }

  function rowHtml(r, live){
    const g = info(r.id) || {};
    const name = g.name || 'Unknown category';
    const liked = g.igdb && typeof isGameLiked === 'function' && isGameLiked(g.igdb);
    const img = /^https:\/\/static-cdn\.jtvnw\.net\//.test(g.img || '') ? `<img src="${esc(g.img)}" alt="" loading="lazy">` : '';
    const fr = r.fr >= 0.005 ? `FR ${Math.round(r.fr * 100)}%` : '';
    let stats, sub;
    if (live){
      stats = `${fmt(r.viewers)} viewers · ${fmt(r.channels)} channel${r.channels === 1 ? '' : 's'}`;
      sub = [r.top ? `top: ${esc(r.top)} ${compact(r.topViewers)}` : '', fr];
    } else {
      stats = risers && !r.isNew ? `${compact(r.prevViewers)} → ${compact(r.viewers)} avg viewers` : `${compact(r.viewers)} avg viewers · ${compact(r.hours)} h watched`;
      sub = [`${compact(r.channels)} channels`, `peak ${compact(r.peak)}`, fr];
    }
    return `<a class="top-row tw-row" href="https://www.twitch.tv/directory/game/${encodeURIComponent(name)}" target="_blank" rel="noopener">
        <span class="top-rank">#${r.rank}${badge(r)}</span>
        <span class="tw-img">${img}</span>
        <span class="top-body">
          <span class="top-name">${esc(name)}${liked ? ' <span class="top-liked">♥</span>' : ''}</span>
          <span class="tw-stats">${stats}</span>
          <span class="tw-sub">${sub.filter(Boolean).join(' · ')}</span>
        </span>
      </a>`;
  }

  function draw(){
    const seg = `<div class="rel-seg tw-seg">${PERIODS.map(p => `<button data-twp="${p.id}" class="${period === p.id ? 'on' : ''}">${p.label}</button>`).join('')}</div>`;
    if (!cur){
      container.innerHTML = seg + '<div class="empty">Twitch data not found yet. Run “Refresh Dispatch Twitch” in GitHub Actions (it then runs every hour).</div>';
      return;
    }
    const v = currentView();
    const chip = (attr, on, label) => `<button class="top-chip ${on ? 'on' : ''}" ${attr}>${label}</button>`;
    const chips = `<div class="top-chips">${chip('data-tws="games"', scope === 'games', 'Games')}${chip('data-tws="all"', scope === 'all', 'All categories')}${v.live ? '' : `<span class="tw-gap"></span>${chip('data-twr', risers, '▲ Risers')}`}</div>`;

    let meta, rows = v.rows, empty = '';
    if (v.live){
      const c = cur.coverage || {};
      meta = `Live at ${new Date(cur.sampledAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${fmt(c.channels || 0)} biggest channels, ${compact(c.viewers || 0)} viewers`;
    } else if (!v.w){
      meta = '';
      empty = `${v.p.label === 'Yesterday' ? 'Yesterday’s ranking' : `The ${v.p.label} ranking`} appears after the first full day of hourly samples (days end at midnight UTC, 2 am Paris). Live now works already.`;
    } else {
      const span = v.p.days === 1 ? 'day' : `${v.p.days} days`;
      meta = `${v.w.days < v.p.days ? `${v.w.days} of ${v.p.days} days so far` : v.p.label} · ${fmt(v.w.samples)} hourly samples · ${v.compared ? `▲▼ vs the previous ${span}` : 'no comparison yet'}`;
      if (risers){
        if (!v.compared) empty = `Risers compare with the previous ${span}: it needs ${v.p.minPrev} more day${v.p.minPrev > 1 ? 's' : ''} of history first.`;
        rows = rows.filter(r => r.viewers >= RISER_MIN && (r.isNew || r.growth >= RISER_GROWTH))
          .sort((a, b) => (b.isNew - a.isNew) || (b.growth - a.growth));
        if (v.compared && !rows.length) empty = 'Nothing grew this period.';
      }
    }
    container.innerHTML = seg + `<div class="top-tools">${chips}${meta ? `<div class="top-meta">${meta}</div>` : ''}</div>
      <div class="top-list">${empty ? `<div class="empty">${empty}</div>` : rows.slice(0, SHOW).map(r => rowHtml(r, v.live)).join('') || '<div class="empty">Nothing to show.</div>'}</div>
      <div class="tw-foot">Viewers are counted on Twitch’s biggest live channels (up to 10,000); smaller channels are left out. Periods average the hourly samples of each UTC day; avg viewers × 24 = hours watched. FR = share of viewers on French-speaking channels.</div>`;
  }

  window.renderTwitch = function(el){
    if (container !== el){
      container = el;
      container.addEventListener('click', (e) => {
        const p = e.target.closest('[data-twp]');
        if (p){ period = p.dataset.twp; if (period === 'now') risers = false; draw(); return; }
        const s = e.target.closest('[data-tws]');
        if (s){ scope = s.dataset.tws; draw(); return; }
        if (e.target.closest('[data-twr]')){ risers = !risers; draw(); }
      });
    }
    // Background re-renders (sync polling, article refresh) don't redraw:
    // the data is read again each time the tab is (re)opened.
    // app.js resets data-active to '0' whenever another tab is shown.
    if (container.dataset.active === '1') return;
    container.dataset.active = '1';
    if (cur) draw();
    else container.innerHTML = '<div class="empty">Loading Twitch<span class="cursor"></span></div>';
    load().then(() => { if (container.dataset.active === '1') draw(); });
  };
})();
