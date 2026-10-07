// Dispatch — "Sorties" tab: monthly release calendar + day slider popup.
// Reads releases.json (built daily by scripts/fetch-releases.mjs).
// Exposes a single global: renderReleases(container).
// Likes use isGameLiked(id) / toggleGameLike(game) from index.html, which
// store them in the synced state (dispatch-state.json).
(function(){
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['M','T','W','T','F','S','S'];
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const REFETCH_MS = 60 * 60 * 1000;

  let data = null;          // parsed releases.json
  let byDay = new Map();    // "YYYY-MM-DD" -> [games]
  let byId = new Map();     // IGDB id -> game (fresh data for liked snapshots)
  let view = 'cal';         // 'cal' | 'likes'
  let shown = [];           // games currently in the popup
  let picking = false;      // month picker open
  let loadedAt = 0;
  let loading = null;
  let monthCursor = null;   // Date at the 1st of the displayed month (local)
  let container = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const coverUrl = (id, size) => `https://images.igdb.com/igdb/image/upload/t_${size}/${id}.jpg`;

  function index(json){
    data = json;
    byDay = new Map();
    byId = new Map();
    for (const g of json.games || []){
      byId.set(g.id, g);
      if (!byDay.has(g.date)) byDay.set(g.date, []);
      byDay.get(g.date).push(g);   // already sorted by hypes desc server-side
    }
  }

  function load(){
    if (data && Date.now() - loadedAt < REFETCH_MS) return Promise.resolve();
    if (loading) return loading;
    loading = fetch('./releases.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(json => { index(json); loadedAt = Date.now(); })
      .finally(() => { loading = null; });
    return loading;
  }

  const liked = (id) => typeof isGameLiked === 'function' && isGameLiked(id);
  const shortDate = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  // Games of a day, liked ones first (server order kept otherwise).
  function dayGames(k){
    const games = byDay.get(k) || [];
    return [...games.filter(g => liked(g.id)), ...games.filter(g => !liked(g.id))];
  }
  function likedList(){
    const snaps = (typeof state !== 'undefined' && state.likedGames) || [];
    return snaps.map(s => byId.get(s.id) || s);   // fresh data wins (dates move)
  }
  function segHtml(){
    const n = likedList().length;
    return `<div class="rel-seg">
      <button data-view="cal" class="${view === 'cal' ? 'on' : ''}">📅 Calendar</button>
      <button data-view="likes" class="${view === 'likes' ? 'on' : ''}">♥ My games <span class="count">${n}</span></button>
      <button data-view="top" class="${view === 'top' ? 'on' : ''}">🏆 Top wishlists</button>
    </div>`;
  }
  function draw(){
    if (view === 'likes') return drawLikes();
    if (view === 'top') return drawTop();
    return picking ? drawPicker() : drawMonth();
  }
  const rankBadge = (g) => g.wlRank ? `<span class="rel-rank" title="Position in Steam's most-wishlisted list">#${g.wlRank} wishlists</span>` : '';

  // ---- Month picker: tap the month title to jump anywhere ---------------
  function drawPicker(){
    const b = monthBounds();
    const counts = new Map();
    for (const [k, games] of byDay) counts.set(k.slice(0, 7), (counts.get(k.slice(0, 7)) || 0) + games.length);
    let html = '';
    for (let y = b.min.getFullYear(); y <= b.max.getFullYear(); y++){
      html += `<div class="pick-year">${y}</div><div class="pick-grid">`;
      for (let m = 0; m < 12; m++){
        const d = new Date(y, m, 1);
        const inRange = d >= b.min && d <= b.max;
        const n = counts.get(`${y}-${pad(m + 1)}`) || 0;
        const cur = d.getTime() === monthCursor.getTime();
        html += `<button class="pick-month ${cur ? 'cur' : ''} ${n ? '' : 'none'}" data-ym="${y}-${m}" ${inRange ? '' : 'disabled'}>
          ${MONTHS[m].slice(0, 3)}<span>${inRange ? n : ''}</span></button>`;
      }
      html += '</div>';
    }
    container.innerHTML = segHtml() + `
      <div class="cal-head">
        <span></span>
        <button class="cal-title cal-title-btn" data-pick="close">Pick a month<span class="cal-sub">▲ close</span></button>
        <span></span>
      </div>${html}`;
  }

  function monthBounds(){
    if (!data) return null;
    const [fy, fm] = data.from.split('-').map(Number);
    // Last month = month of the latest game (not the fetch window), so the
    // arrows reach e.g. January 2028 only if a game is dated there.
    const last = (data.games || []).reduce((mx, g) => g.date > mx ? g.date : mx, '');
    const [ty, tm] = (last || data.to).split('-').map(Number);
    const max = new Date(ty, tm - 1, 1);
    const now = new Date(), cur = new Date(now.getFullYear(), now.getMonth(), 1);
    return { min: new Date(fy, fm - 1, 1), max: max < cur ? cur : max };
  }

  function drawMonth(){
    const y = monthCursor.getFullYear(), m = monthCursor.getMonth();
    const b = monthBounds();
    const canPrev = !b || monthCursor > b.min;
    const canNext = !b || monthCursor < b.max;

    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7;           // Monday-first
    const days = new Date(y, m + 1, 0).getDate();
    const now = new Date();
    const todayKey = keyOf(now.getFullYear(), now.getMonth(), now.getDate());

    let monthCount = 0;
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= days; d++){
      const k = keyOf(y, m, d);
      const games = dayGames(k);
      monthCount += games.length;
      const hasLike = games.some(g => liked(g.id));
      const top = games.find(g => g.cover) || games[0];
      const img = top && top.cover
        ? `<img src="${coverUrl(top.cover, 'cover_small')}" alt="" loading="lazy" onerror="this.remove()">`
        : (top ? `<span class="cal-noimg">${esc(top.name.slice(0, 18))}</span>` : '');
      cells += `
        <button class="cal-cell ${games.length ? 'has' : ''} ${k === todayKey ? 'today' : ''}" data-day="${k}" ${games.length ? '' : 'disabled'}>
          <span class="cal-num">${d}</span>
          ${img}
          ${games.length > 1 ? `<span class="cal-more">+${games.length - 1}</span>` : ''}
          ${hasLike ? '<span class="cal-like">♥</span>' : ''}
        </button>`;
    }

    container.innerHTML = segHtml() + `
      <div class="cal-head">
        <button class="cal-nav" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <button class="cal-title cal-title-btn" data-pick="open">${MONTHS[m]} ${y} <span class="cal-caret">▾</span><span class="cal-sub">${monthCount} release${monthCount === 1 ? '' : 's'}</span></button>
        <button class="cal-nav" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      <div class="cal-grid cal-weekdays">${WEEKDAYS.map(w => `<div>${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-foot">IGDB data · updated ${data ? new Date(data.generatedAt).toLocaleDateString('en-GB') : '—'}</div>`;
  }

  // ---- Top wishlists: Steam's most-wishlisted list (wishlists.json) ------
  let top = null, topLoading = null, topQuery = '', topFilter = 'all', topSort = 'rank';
  const fmt = (n) => Number(n).toLocaleString('en-GB');
  // ▲ places gained (green) / ▼ lost (red) / NEW entry, for a period key.
  function deltaBadge(g, key = 'd7'){
    if (g.new7 && key !== 'd1') return '<span class="mo mo-new" title="Entered the top list in the last 7 days">NEW</span>';
    const d = g[key];
    if (d == null || d === 0) return '';
    const span = key === 'd1' ? '24 h' : key === 'd30' ? '30 days' : '7 days';
    return d > 0 ? `<span class="mo mo-up" title="Up ${d} places in ${span}">▲${fmt(d)}</span>`
                 : `<span class="mo mo-down" title="Down ${-d} places in ${span}">▼${fmt(-d)}</span>`;
  }
  function loadTop(){
    if (top) return Promise.resolve();
    if (topLoading) return topLoading;
    topLoading = fetch('./wishlists.json', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(j => { top = j; })
      .finally(() => { topLoading = null; });
    return topLoading;
  }
  const SORTS = {
    rank: { label: 'Rank', key: 'd7' },
    d7:   { label: 'Rising · 7 days', key: 'd7' },
    d1:   { label: 'Rising · 24 h', key: 'd1' },
    d30:  { label: 'Rising · 30 days', key: 'd30' },
    new:  { label: 'New entries', key: 'd7' },
  };
  function topRows(){
    const q = topQuery.trim().toLowerCase();
    let rows = (top.games || []).filter(g =>
      (topFilter === 'all' || (topFilter === 'cal' ? !!g.date : !g.date)) &&
      (!q || g.name.toLowerCase().includes(q)));
    if (topSort === 'new') rows = rows.filter(g => g.new7);
    else if (topSort !== 'rank') rows = rows.filter(g => g[topSort] > 0).sort((a, b) => b[topSort] - a[topSort] || a.rank - b.rank);
    return rows;
  }
  // Why a momentum list is empty: not enough daily history yet.
  function momentumMissing(){
    if (topSort === 'rank') return '';
    const k = topSort === 'new' ? 'd7' : topSort;
    if (top.momentumSince && top.momentumSince[k]) return '';
    const days = { d1: 1, d7: 7, d30: 30 }[k];
    return `<div class="empty">NOT ENOUGH HISTORY YET — this view needs ${days} day${days > 1 ? 's' : ''} of daily Steam snapshots. It fills in automatically.<span class="cursor"></span></div>`;
  }
  function drawTopList(){
    const el = container.querySelector('#topList');
    if (!el) return;
    const missing = momentumMissing();
    const rows = missing ? [] : topRows();
    const key = SORTS[topSort].key;
    el.innerHTML = missing || (rows.length ? rows.map(g => `
      <a class="top-row" href="https://store.steampowered.com/app/${g.appid}" target="_blank" rel="noopener" data-igdb="${g.igdbId ?? ''}">
        <span class="top-rank">#${g.rank}${deltaBadge(g, key)}</span>
        <span class="top-img">${g.img ? `<img src="${esc(g.img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
        <span class="top-body">
          <span class="top-name">${esc(g.name)}${g.igdbId != null && liked(g.igdbId) ? ' <span class="top-liked">♥</span>' : ''}</span>
          <span class="top-when">${g.date ? `<span class="top-cal">📅 ${esc(shortDate(g.date))}</span>` : esc(g.released || 'No date')}</span>
        </span>
      </a>`).join('')
      : '<div class="empty">NO MATCHING GAMES<span class="cursor"></span></div>');
    const n = container.querySelector('#topCount');
    if (n) n.textContent = `${rows.length} of ${(top.games || []).length}`;
  }
  function drawTop(){
    if (!top){
      container.innerHTML = segHtml() + '<div class="empty">LOADING TOP WISHLISTS<span class="cursor"></span></div>';
      loadTop().then(() => { if (view === 'top') drawTop(); })
        .catch(() => { if (view === 'top') container.innerHTML = segHtml() + '<div class="empty">TOP WISHLISTS UNAVAILABLE — run the releases workflow to create wishlists.json<span class="cursor"></span></div>'; });
      return;
    }
    const chip = (id, label) => `<button class="top-chip ${topFilter === id ? 'on' : ''}" data-topfilter="${id}">${label}</button>`;
    container.innerHTML = segHtml() + `
      <div class="top-tools">
        <input type="search" id="topSearch" class="top-search" placeholder="Search a game…" value="${esc(topQuery)}" autocomplete="off">
        <div class="top-chips">${chip('all', 'All')}${chip('cal', 'In calendar')}${chip('undated', 'No exact date')}</div>
        <select id="topSort" class="top-sort" aria-label="Sort">${Object.entries(SORTS).map(([id, s]) => `<option value="${id}" ${id === topSort ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
        <div class="top-meta"><span id="topCount"></span> · Steam ranking, updated ${new Date(top.generatedAt).toLocaleDateString('en-GB')}</div>
      </div>
      <div id="topList" class="top-list"></div>`;
    container.querySelector('#topSearch').addEventListener('input', (e) => { topQuery = e.target.value; drawTopList(); });
    container.querySelector('#topSort').addEventListener('change', (e) => { topSort = e.target.value; drawTopList(); });
    drawTopList();
  }

  // ---- After-launch tracker (tracker.json, hourly) ----------------------
  let tracker = null, trackerLoadedAt = 0, trackerLoading = null;
  function loadTracker(){
    if (tracker && Date.now() - trackerLoadedAt < REFETCH_MS) return Promise.resolve();
    if (trackerLoading) return trackerLoading;
    trackerLoading = fetch('./tracker.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) { tracker = j; trackerLoadedAt = Date.now(); } })
      .catch(() => {})
      .finally(() => { trackerLoading = null; });
    return trackerLoading;
  }
  const appOf = (g) => g.steamAppId || (Number((/store\.steampowered\.com\/app\/(\d+)/.exec(g.steam || '') || [])[1]) || null);
  const statsOf = (g) => { const a = appOf(g); return a && tracker && tracker.games ? tracker.games[a] : null; };

  // Derived numbers: peak over the last 7 days, review %, reviews added in 7 days.
  function summarize(t){
    const days = Object.keys(t.days || {}).sort();
    const last7 = days.slice(-7);
    const peak7 = Math.max(0, ...last7.map(d => t.days[d].peak || 0));
    const pct = t.reviews && t.reviews.total ? Math.round(100 * t.reviews.positive / t.reviews.total) : null;
    // Reviews added since the stored day closest to 7 days ago (span = real gap).
    const withRev = days.filter(d => t.days[d].reviews != null);
    const ref = withRev.length > 1 ? withRev.slice(-8)[0] : null;
    const newRev7 = t.reviews && ref ? t.reviews.total - t.days[ref].reviews : null;
    const span = ref ? Math.round((new Date(withRev[withRev.length - 1]) - new Date(ref)) / 86400000) : 0;
    return { peak7, pct, newRev7, span, days };
  }
  function sparkline(t){
    const days = Object.keys(t.days || {}).sort().slice(-30);
    const vals = days.map(d => t.days[d].peak || 0);
    if (vals.filter(Boolean).length < 2) return '';
    const W = 260, H = 44, max = Math.max(...vals) || 1;
    const x = (i) => (i / (vals.length - 1)) * (W - 4) + 2;
    const y = (v) => H - 3 - (v / max) * (H - 8);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const last = vals.length - 1;
    // data-pts feeds the hover/touch tooltip (date label + exact value).
    const ptsData = esc(JSON.stringify(days.map((d, i) => [dDay(dayTime(d)), vals[i]])));
    return `<div class="spark-wrap"><svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-pts="${ptsData}" aria-label="Daily peak players, last ${vals.length} days">
      <polygon points="2,${H - 3} ${pts} ${x(last).toFixed(1)},${H - 3}" class="spark-area"/>
      <polyline points="${pts}" class="spark-line"/>
      <circle cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="2.6" class="spark-dot"/>
      <line class="spark-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    </svg><div class="perf-tip spark-tip" hidden></div></div>
    <div class="spark-cap">Daily peak players · last ${vals.length} days · max ${fmt(max)}</div>`;
  }
  function statsLine(g){
    const t = statsOf(g);
    if (!t) return '';
    const s = summarize(t);
    const bits = [];
    if (t.now != null) bits.push(`👥 ${fmt(t.now)} now`);
    if (s.peak7) bits.push(`peak ${fmt(s.peak7)}`);
    if (s.pct != null) bits.push(`👍 ${s.pct}%`);
    return bits.length ? `<div class="like-stats">${bits.join(' · ')}</div>` : '';
  }
  function statsBlock(g){
    const today = new Date().toISOString().slice(0, 10);
    if (!(g.date && g.date <= today)) return '';
    const t = statsOf(g);
    if (!t){
      const why = !appOf(g) ? 'No Steam page — player and review data only exist for Steam games.'
        : liked(g.id) ? 'Tracking starts at the next hourly run after you save.' : 'Like this game to track its players and reviews.';
      return `<div class="trk trk-empty">${why}</div>`;
    }
    const s = summarize(t);
    const cell = (v, l) => `<div class="trk-cell"><b>${v}</b><span>${l}</span></div>`;
    return `<div class="trk">
      <div class="trk-grid">
        ${cell(t.now != null ? fmt(t.now) : '—', 'players now')}
        ${cell(s.peak7 ? fmt(s.peak7) : '—', 'peak · 7 days')}
        ${cell(s.pct != null ? s.pct + '%' : '—', esc(t.reviews ? t.reviews.desc || 'reviews' : 'reviews'))}
        ${cell(t.reviews ? fmt(t.reviews.total) : '—', s.newRev7 != null && s.span > 0 ? `reviews · +${fmt(s.newRev7)} in ${s.span} d` : 'reviews')}
      </div>
      ${sparkline(t)}
      <button class="perf-open" data-perf="${appOf(g)}">📈 Performance history</button>
    </div>`;
  }

  // ---- Performance sheet: dated charts + table for one tracked game ------
  // Players: hourly samples (48 h / 14 days) or daily peaks (all days).
  // Reviews: new reviews per day (difference between stored daily totals).
  // One measure per chart, one axis each; crosshair + tooltip on hover/touch.
  let perfEl = null, perfApp = null, perfRange = '14d';
  const DAY_MS = 86400000;
  const fmtCompact = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n));
  const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
  const dDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const dHour = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dayTime = (d) => new Date(d + 'T12:00:00Z').getTime();

  function playerSeries(t, rangeId){
    if (rangeId === 'all'){
      return Object.keys(t.days || {}).sort().filter(d => t.days[d].peak != null)
        .map(d => ({ t: dayTime(d), v: t.days[d].peak, tip: `${dDay(dayTime(d))} · peak ${fmt(t.days[d].peak)} players` }));
    }
    const span = rangeId === '48h' ? 2 * DAY_MS : 14 * DAY_MS;
    const floor = Date.now() - span;
    return (t.hours || []).map(([iso, v]) => ({ t: Date.parse(iso), v }))
      .filter(p => p.t >= floor)
      .map(p => ({ ...p, tip: `${dHour(p.t)} · ${fmt(p.v)} players` }));
  }
  function reviewSeries(t){
    const days = Object.keys(t.days || {}).sort().filter(d => t.days[d].reviews != null);
    const out = [];
    for (let i = 1; i < days.length; i++){
      const d = days[i], prev = days[i - 1];
      const gap = Math.round((dayTime(d) - dayTime(prev)) / DAY_MS);
      const added = Math.max(0, t.days[d].reviews - t.days[prev].reviews);
      const pct = t.days[d].pct != null ? ` · ${t.days[d].pct}% positive` : '';
      out.push({ t: dayTime(d), v: added, tip: `${dDay(dayTime(d))} · +${fmt(added)} review${added === 1 ? '' : 's'}${gap > 1 ? ` (over ${gap} days)` : ''}${pct}` });
    }
    return out;
  }

  // Draws a single-series chart into `host` (line or bars) at its real width.
  function mountChart(host, pts, kind, xFmt){
    host.innerHTML = '';
    if (pts.length < 2){
      host.innerHTML = `<div class="perf-wait">Not enough data yet — this chart fills in as the hourly tracker runs.</div>`;
      return;
    }
    const W = Math.max(260, host.clientWidth), H = 150, L = 38, R = 10, T = 10, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const max = niceMax(Math.max(...pts.map(p => p.v)));
    const bw = kind === 'bar' ? Math.max(2, Math.min(18, pw / pts.length - 2)) : 0;
    const x = (t) => L + bw / 2 + (t1 === t0 ? pw / 2 : ((t - t0) / (t1 - t0)) * (pw - bw));
    const y = (v) => T + ph - (v / max) * ph;
    const ns = 'http://www.w3.org/2000/svg';
    let svg = `<svg class="perf-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (const f of [0, 0.5, 1]){
      const gy = y(max * f);
      svg += `<line x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}" class="perf-grid"/><text x="${L - 6}" y="${gy + 3}" class="perf-ylab">${fmtCompact(max * f)}</text>`;
    }
    const ticks = 4;
    for (let i = 0; i < ticks; i++){
      const tt = t0 + (i / (ticks - 1)) * (t1 - t0);
      svg += `<text x="${x(tt)}" y="${H - 6}" class="perf-xlab" text-anchor="${i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'}">${xFmt(tt)}</text>`;
    }
    if (kind === 'bar'){
      for (const p of pts){
        const h = Math.max(p.v > 0 ? 1.5 : 0, T + ph - y(p.v));
        svg += `<rect x="${x(p.t) - bw / 2}" y="${T + ph - h}" width="${bw}" height="${h}" rx="1.5" class="perf-bar"/>`;
      }
    } else {
      const line = pts.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
      svg += `<polygon points="${x(t0)},${T + ph} ${line} ${x(t1)},${T + ph}" class="perf-area"/><polyline points="${line}" class="perf-line"/>`;
      const last = pts[pts.length - 1];
      svg += `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="3.5" class="perf-end"/>`;
    }
    svg += `<line class="perf-cross" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/><circle class="perf-dot" r="4" visibility="hidden"/>`;
    svg += `<rect x="${L}" y="0" width="${pw}" height="${H}" fill="transparent" class="perf-hit"/></svg>`;
    host.innerHTML = svg + '<div class="perf-tip" hidden></div>';

    const svgEl = host.querySelector('svg'), tip = host.querySelector('.perf-tip');
    const cross = svgEl.querySelector('.perf-cross'), dot = svgEl.querySelector('.perf-dot');
    const show = (ev) => {
      const r = svgEl.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      let best = pts[0], bd = Infinity;
      for (const p of pts){ const d = Math.abs(x(p.t) - mx); if (d < bd){ bd = d; best = p; } }
      const px = x(best.t), py = y(best.v);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', kind === 'bar' ? 'hidden' : 'visible');
      tip.textContent = best.tip; tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(0, px - tw / 2), W - tw) + 'px';
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svgEl.addEventListener('pointermove', show);
    svgEl.addEventListener('pointerdown', show);
    svgEl.addEventListener('pointerleave', hide);
  }

  function perfTable(t){
    const days = Object.keys(t.days || {}).sort();
    const rows = [];
    for (let i = days.length - 1; i >= 0 && rows.length < 30; i--){
      const d = days[i], cur = t.days[d], prev = i > 0 ? t.days[days[i - 1]] : null;
      const added = prev && cur.reviews != null && prev.reviews != null ? `+${fmt(Math.max(0, cur.reviews - prev.reviews))}` : '—';
      rows.push(`<tr><td>${new Date(dayTime(d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${cur.peak != null ? fmt(cur.peak) : '—'}</td><td>${added}</td><td>${cur.pct != null ? cur.pct + '%' : '—'}</td></tr>`);
    }
    return `<div class="perf-table-wrap"><table class="perf-table"><thead><tr><th>Day</th><th>Peak players</th><th>New reviews</th><th>Positive</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function drawPerf(){
    const t = tracker && tracker.games && tracker.games[perfApp];
    if (!t) return;
    const s = summarize(t);
    const chip = (id, label) => `<button class="perf-chip ${perfRange === id ? 'on' : ''}" data-range="${id}">${label}</button>`;
    const since = Object.keys(t.days || {}).sort()[0];
    perfEl.querySelector('.perf-title').textContent = t.name;
    perfEl.querySelector('.perf-body').innerHTML = `
      <div class="trk-grid">
        <div class="trk-cell"><b>${t.now != null ? fmt(t.now) : '—'}</b><span>players now</span></div>
        <div class="trk-cell"><b>${s.peak7 ? fmt(s.peak7) : '—'}</b><span>peak · 7 days</span></div>
        <div class="trk-cell"><b>${s.pct != null ? s.pct + '%' : '—'}</b><span>${esc(t.reviews ? t.reviews.desc || 'reviews' : 'reviews')}</span></div>
        <div class="trk-cell"><b>${t.reviews ? fmt(t.reviews.total) : '—'}</b><span>reviews</span></div>
      </div>
      <div class="perf-meta">Last sample ${t.nowAt ? dHour(Date.parse(t.nowAt)) : '—'}${since ? ` · tracked since ${dDay(dayTime(since))}` : ''}</div>
      <h4 class="perf-h">Players on Steam</h4>
      <div class="perf-chips">${chip('48h', '48 h')}${chip('14d', '14 days')}${chip('all', 'Daily peaks')}</div>
      <div class="perf-chart" id="perfPlayers"></div>
      <div class="perf-cap">${perfRange === 'all' ? 'Highest hourly sample of each day' : 'One sample per hour, shown in your local time'}</div>
      <h4 class="perf-h">New reviews per day</h4>
      <div class="perf-chart" id="perfReviews"></div>
      <div class="perf-cap">Reviews added since the previous day · a common proxy for sales</div>
      <h4 class="perf-h">Day by day</h4>
      ${perfTable(t)}`;
    const xFmt = perfRange === '48h' ? (tt) => new Date(tt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : dDay;
    mountChart(perfEl.querySelector('#perfPlayers'), playerSeries(t, perfRange), 'line', xFmt);
    mountChart(perfEl.querySelector('#perfReviews'), reviewSeries(t), 'bar', dDay);
  }

  function openPerf(app){
    if (!perfEl){
      perfEl = document.createElement('div');
      perfEl.className = 'perf-overlay';
      perfEl.innerHTML = `<div class="perf-box" role="dialog" aria-modal="true">
        <div class="rel-top"><div class="rel-day perf-title"></div><button class="rel-close perf-close" aria-label="Close">✕</button></div>
        <div class="perf-body"></div></div>`;
      document.body.appendChild(perfEl);
      perfEl.addEventListener('click', (e) => {
        if (e.target === perfEl || e.target.closest('.perf-close')){ perfEl.classList.remove('show'); return; }
        const c = e.target.closest('.perf-chip');
        if (c){ perfRange = c.dataset.range; drawPerf(); }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && perfEl.classList.contains('show')){ e.stopImmediatePropagation(); perfEl.classList.remove('show'); } }, true);
      window.addEventListener('resize', () => { if (perfEl.classList.contains('show')) drawPerf(); });
    }
    perfApp = app;
    perfEl.classList.add('show');
    perfEl.querySelector('.perf-box').scrollTop = 0;
    drawPerf();
  }

  // ---- "My games": recap of liked games --------------------------------
  function drawLikes(){
    if (!tracker && !trackerLoading) loadTracker().then(() => { if (view === 'likes' && tracker) drawLikes(); });
    const now = new Date();
    const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
    const list = likedList();
    const upcoming = list.filter(g => g.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = list.filter(g => g.date < today).sort((a, b) => b.date.localeCompare(a.date));

    const row = (g) => `
      <div class="like-row" data-id="${g.id}">
        <div class="like-thumb">${g.cover ? `<img src="${coverUrl(g.cover, 'cover_small')}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="like-body">
          <div class="like-date">${esc(shortDate(g.date))} ${rankBadge(g)}</div>
          <div class="like-name">${esc(g.name)}</div>
          <div class="like-sub">${esc([...(g.developers || []).slice(0, 1), (g.platforms || []).join(' · ')].filter(Boolean).join(' — '))}</div>
          ${statsLine(g)}
        </div>
        <button class="like-heart on" data-like="${g.id}" aria-label="Unlike">♥</button>
      </div>`;

    const groups = (arr) => {
      let html = '', cur = null;
      for (const g of arr){
        const [y, m] = g.date.split('-').map(Number);
        const label = `${MONTHS[m - 1]} ${y}`;
        if (label !== cur){ html += `<div class="like-month">${label}</div>`; cur = label; }
        html += row(g);
      }
      return html;
    };

    container.innerHTML = segHtml() + (list.length
      ? groups(upcoming) + (past.length ? `<div class="like-month past">Already released</div>${past.map(row).join('')}` : '')
      : '<div class="empty">NO LIKED GAMES YET — TAP ♡ ON A GAME CARD<span class="cursor"></span></div>');
  }

  // ---- Day popup: drag slider ------------------------------------------
  // Cards are stacked vertically in .rel-strip, moved with translateY. A
  // vertical drag follows the finger; release past 18% of a card height
  // (or a quick flick) moves to the neighbour. The viewport has
  // touch-action:none so the page never scrolls instead.
  let overlay = null;
  let strip = null, viewport = null;
  let idx = 0, count = 0;

  const GAP = 12;
  function step(){ return strip.firstElementChild ? strip.firstElementChild.offsetHeight + GAP : viewport.clientHeight; }
  function offset(){ return (viewport.clientHeight - (step() - GAP)) / 2; }  // centre the card, neighbours peek

  function goTo(i, animate = true){
    idx = Math.max(0, Math.min(count - 1, i));
    viewport.scrollTop = 0;   // focus/scrollIntoView must never shift the slider
    viewport.parentElement.scrollTop = 0;
    strip.style.transition = animate ? 'transform 0.28s cubic-bezier(.2,.8,.2,1)' : 'none';
    strip.style.transform = `translateY(${offset() - idx * step()}px)`;
    overlay.querySelector('.rel-pos').textContent = count > 1 ? `${idx + 1} / ${count}` : '';
    overlay.querySelectorAll('.rel-dot').forEach((d, k) => d.classList.toggle('on', k === idx));
    [...strip.children].forEach((c, k) => c.classList.toggle('active', k === idx));
  }

  function ensureOverlay(){
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'rel-overlay';
    overlay.innerHTML = `
      <div class="rel-box" role="dialog" aria-modal="true">
        <div class="rel-top">
          <div class="rel-day"></div>
          <div class="rel-pos"></div>
          <button class="rel-close" aria-label="Close">✕</button>
        </div>
        <div class="rel-viewport"><div class="rel-strip"></div></div>
        <div class="rel-dots"></div>
      </div>`;
    document.body.appendChild(overlay);
    viewport = overlay.querySelector('.rel-viewport');
    strip = overlay.querySelector('.rel-strip');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.rel-close')) return closeDay();
      const perfBtn = e.target.closest('.perf-open');
      if (perfBtn){ openPerf(perfBtn.dataset.perf); return; }
      const likeBtn = e.target.closest('.rel-like');
      if (likeBtn){
        const g = shown.find(x => String(x.id) === likeBtn.dataset.like);
        if (g && typeof toggleGameLike === 'function'){
          const on = toggleGameLike(g);
          likeBtn.classList.toggle('on', on);
          likeBtn.textContent = on ? '♥' : '♡';
          draw();   // refresh calendar hearts / recap behind the popup
        }
        return;
      }
      const dot = e.target.closest('.rel-dot');
      if (dot) return goTo(Number(dot.dataset.i));
      // Tapping the peeking neighbour card brings it to the centre.
      const c = e.target.closest('.rel-card');
      if (c && !c.classList.contains('active') && !e.target.closest('a')) goTo([...strip.children].indexOf(c));
    });

    // Green mini-chart on the card: hover (mouse) or touch/slide sideways
    // shows the exact daily peak and its date.
    const sparkShow = (e) => {
      const svg = e.target.closest && e.target.closest('.spark');
      if (!svg) return;
      const pts = JSON.parse(svg.dataset.pts || '[]');
      if (pts.length < 2) return;
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))));
      const vx = (i / (pts.length - 1)) * (260 - 4) + 2;      // same x scale as sparkline()
      const cross = svg.querySelector('.spark-cross');
      cross.setAttribute('x1', vx); cross.setAttribute('x2', vx); cross.setAttribute('visibility', 'visible');
      const tip = svg.parentElement.querySelector('.spark-tip');
      tip.textContent = `${pts[i][0]} · peak ${fmt(pts[i][1])} players`;
      tip.hidden = false;
      const px = (vx / 260) * r.width, tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(0, px - tw / 2), r.width - tw) + 'px';
    };
    const sparkHide = (e) => {
      const svg = e.target.closest && e.target.closest('.spark');
      if (!svg) return;
      svg.querySelector('.spark-cross').setAttribute('visibility', 'hidden');
      svg.parentElement.querySelector('.spark-tip').hidden = true;
    };
    viewport.addEventListener('pointermove', sparkShow);
    viewport.addEventListener('pointerdown', sparkShow);
    viewport.addEventListener('pointerout', sparkHide);

    let sx = 0, sy = 0, st = 0, d = 0, mode = null, pid = null;
    viewport.addEventListener('pointerdown', (e) => {
      if (count < 2) return;
      sx = e.clientX; sy = e.clientY; st = performance.now(); d = 0; mode = null; pid = e.pointerId;
    });
    viewport.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      const mx = e.clientX - sx, my = e.clientY - sy;
      if (!mode){
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        mode = Math.abs(my) > Math.abs(mx) ? 'drag' : 'ignore';
        if (mode === 'drag') viewport.setPointerCapture(pid);
      }
      if (mode !== 'drag') return;
      d = my;
      // rubber-band at both ends
      if ((idx === 0 && d > 0) || (idx === count - 1 && d < 0)) d *= 0.35;
      strip.style.transition = 'none';
      strip.style.transform = `translateY(${offset() - idx * step() + d}px)`;
    });
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (mode !== 'drag') return;
      const fast = Math.abs(d) / Math.max(1, performance.now() - st) > 0.5;
      const far = Math.abs(d) > step() * 0.18;
      goTo(idx + ((far || fast) && Math.abs(d) > 10 ? (d < 0 ? 1 : -1) : 0));
    };
    viewport.addEventListener('pointerup', end);
    viewport.addEventListener('pointercancel', end);
    // A drag must not also count as a tap on a link/card.
    viewport.addEventListener('click', (e) => { if (mode === 'drag' && Math.abs(d) > 10){ e.preventDefault(); e.stopPropagation(); } }, true);

    let wheelLock = 0;
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Date.now() < wheelLock || Math.abs(e.deltaY) < 8) return;
      wheelLock = Date.now() + 350;
      goTo(idx + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
    window.addEventListener('resize', () => { if (overlay.classList.contains('show')) goTo(idx, false); });
    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('show')) return;
      if (e.key === 'Escape') closeDay();
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') goTo(idx + 1);
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') goTo(idx - 1);
    });
    return overlay;
  }

  function card(g){
    const links = [
      g.steam ? `<a class="rel-btn steam" href="${esc(g.steam)}" target="_blank" rel="noopener">Steam</a>` : '',
      g.igdb ? `<a class="rel-btn" href="${esc(g.igdb)}" target="_blank" rel="noopener">IGDB</a>` : '',
    ].join('');
    const on = liked(g.id);
    const companies = [
      (g.developers || []).length ? `<span>Dev <b>${esc(g.developers.join(', '))}</b></span>` : '',
      (g.publishers || []).length ? `<span>Publisher <b>${esc(g.publishers.join(', '))}</b></span>` : '',
    ].filter(Boolean).join('');
    const dates = (g.dates || []).length > 1
      ? `<div class="rel-dates">${g.dates.map(x => `${esc(shortDate(x.date))} <span>(${esc(x.platforms.join(', '))})</span>`).join(' · ')}</div>`
      : '';
    return `
      <article class="rel-card">
        <button class="rel-like ${on ? 'on' : ''}" data-like="${g.id}" aria-label="Like">${on ? '♥' : '♡'}</button>
        <div class="rel-cover">${g.cover ? `<img src="${coverUrl(g.cover, 'cover_big')}" alt="" loading="lazy" onerror="this.remove()">` : '<span>—</span>'}</div>
        <h3>${esc(g.name)}</h3>
        ${companies ? `<div class="rel-companies">${companies}</div>` : ''}
        ${dates}
        <div class="rel-meta">
          ${g.platforms.map(p => `<span class="rel-chip">${esc(p)}</span>`).join('')}
        </div>
        ${g.wlRank ? `<div class="rel-rank-row">${rankBadge(g)}${g.wl7 ? ` <span class="rel-mo">${deltaBadge({ d7: g.wl7 })} in 7 days</span>` : ''}</div>` : ''}
        ${statsBlock(g)}
        ${g.genres.length ? `<div class="rel-genres">${esc(g.genres.join(' · '))}</div>` : ''}
        ${g.summary ? `<p class="rel-summary">${esc(g.summary)}</p>` : ''}
        <div class="rel-links">${links}</div>
      </article>`;
  }

  function openDay(key){
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    openGames(dayGames(key), `${DAY_NAMES[date.getDay()]} ${d} ${MONTHS[m - 1].toLowerCase()}`);
  }

  function openGames(games, title){
    if (!games.length) return;
    if (!tracker) loadTracker().then(() => {
      if (tracker && overlay && overlay.classList.contains('show') && shown === games){
        strip.innerHTML = games.map(card).join(''); goTo(idx, false);
      }
    });
    ensureOverlay();
    shown = games;
    overlay.querySelector('.rel-day').textContent = title;
    count = games.length;
    strip.innerHTML = games.map(card).join('');
    overlay.querySelector('.rel-dots').innerHTML = count > 1 && count <= 20
      ? games.map((_, k) => `<button class="rel-dot" data-i="${k}" aria-label="Game ${k + 1}"></button>`).join('')
      : '';
    overlay.classList.toggle('single', count === 1);
    overlay.classList.add('show');
    document.body.classList.add('rel-lock');
    goTo(0, false);
  }

  function closeDay(){
    if (!overlay) return;
    overlay.classList.remove('show');
    document.body.classList.remove('rel-lock');
  }

  // ---- Entry point ----------------------------------------------------
  window.renderReleases = function(el){
    if (container !== el){
      container = el;
      container.addEventListener('click', (e) => {
        const tf = e.target.closest('[data-topfilter]');
        if (tf){ topFilter = tf.dataset.topfilter; drawTop(); return; }
        const tr = e.target.closest('.top-row');
        if (tr && tr.dataset.igdb){
          const g = byId.get(Number(tr.dataset.igdb));
          if (g){ e.preventDefault(); openGames([g], shortDate(g.date)); return; }
        }
        const seg = e.target.closest('.rel-seg button');
        if (seg){ view = seg.dataset.view; picking = false; draw(); return; }
        const heart = e.target.closest('.like-heart');
        if (heart){
          const g = likedList().find(x => String(x.id) === heart.dataset.like);
          if (g && typeof toggleGameLike === 'function'){ toggleGameLike(g); drawLikes(); }
          return;
        }
        const likeRow = e.target.closest('.like-row');
        if (likeRow){
          const g = likedList().find(x => String(x.id) === likeRow.dataset.id);
          if (g) openGames([g], shortDate(g.date));
          return;
        }
        const pick = e.target.closest('[data-pick]');
        if (pick){ picking = pick.dataset.pick === 'open'; draw(); return; }
        const pm = e.target.closest('.pick-month');
        if (pm && !pm.disabled){
          const [py, pmo] = pm.dataset.ym.split('-').map(Number);
          monthCursor = new Date(py, pmo, 1);
          picking = false; draw(); return;
        }
        const nav = e.target.closest('.cal-nav');
        if (nav && !nav.disabled){
          monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + Number(nav.dataset.step), 1);
          drawMonth();
          return;
        }
        const cell = e.target.closest('.cal-cell.has');
        if (cell) openDay(cell.dataset.day);
      });
    }
    if (!monthCursor){
      const n = new Date();
      monthCursor = new Date(n.getFullYear(), n.getMonth(), 1);
    }
    if (data || view !== 'cal') draw();
    else container.innerHTML = '<div class="empty">LOADING CALENDAR<span class="cursor"></span></div>';

    load()
      .then(() => { if (container.isConnected && !container.hidden) draw(); })
      .catch(() => {
        if (!data && view === 'cal') container.innerHTML = '<div class="empty">CALENDAR UNAVAILABLE — releases.json not found<span class="cursor"></span></div>';
      });
  };

})();
