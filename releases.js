// Dispatch — "Sorties" tab: monthly release calendar + day slider popup.
// Reads releases.json (built daily by scripts/fetch-releases.mjs).
// Exposes a single global: renderReleases(container).
(function(){
  const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const WEEKDAYS = ['L','M','M','J','V','S','D'];
  const DAY_NAMES = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const REFETCH_MS = 60 * 60 * 1000;

  let data = null;          // parsed releases.json
  let byDay = new Map();    // "YYYY-MM-DD" -> [games]
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
    for (const g of json.games || []){
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

  function monthBounds(){
    if (!data) return null;
    const [fy, fm] = data.from.split('-').map(Number);
    const [ty, tm] = data.to.split('-').map(Number);
    return { min: new Date(fy, fm - 1, 1), max: new Date(ty, tm - 1, 1) };
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
      const games = byDay.get(k) || [];
      monthCount += games.length;
      const top = games.find(g => g.cover) || games[0];
      const img = top && top.cover
        ? `<img src="${coverUrl(top.cover, 'cover_small')}" alt="" loading="lazy" onerror="this.remove()">`
        : (top ? `<span class="cal-noimg">${esc(top.name.slice(0, 18))}</span>` : '');
      cells += `
        <button class="cal-cell ${games.length ? 'has' : ''} ${k === todayKey ? 'today' : ''}" data-day="${k}" ${games.length ? '' : 'disabled'}>
          <span class="cal-num">${d}</span>
          ${img}
          ${games.length > 1 ? `<span class="cal-more">+${games.length - 1}</span>` : ''}
        </button>`;
    }

    container.innerHTML = `
      <div class="cal-head">
        <button class="cal-nav" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Mois précédent">‹</button>
        <div class="cal-title">${MONTHS[m]} ${y}<span class="cal-sub">${monthCount} sortie${monthCount > 1 ? 's' : ''}</span></div>
        <button class="cal-nav" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Mois suivant">›</button>
      </div>
      <div class="cal-grid cal-weekdays">${WEEKDAYS.map(w => `<div>${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-foot">Données IGDB · MAJ ${data ? new Date(data.generatedAt).toLocaleDateString('fr-FR') : '—'}</div>`;
  }

  // ---- Day popup -------------------------------------------------------
  let overlay = null;
  function ensureOverlay(){
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'rel-overlay';
    overlay.innerHTML = `
      <div class="rel-box" role="dialog" aria-modal="true">
        <div class="rel-top">
          <div class="rel-day"></div>
          <div class="rel-pos"></div>
          <button class="rel-close" aria-label="Fermer">✕</button>
        </div>
        <div class="rel-track"></div>
        <div class="rel-arrows">
          <button class="rel-arrow" data-dir="-1" aria-label="Précédent">‹</button>
          <button class="rel-arrow" data-dir="1" aria-label="Suivant">›</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const track = overlay.querySelector('.rel-track');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.rel-close')) closeDay();
      const arrow = e.target.closest('.rel-arrow');
      if (arrow) track.scrollBy({ left: track.clientWidth * Number(arrow.dataset.dir), behavior: 'smooth' });
    });
    track.addEventListener('scroll', () => updatePos(), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('show')) return;
      if (e.key === 'Escape') closeDay();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft')
        track.scrollBy({ left: track.clientWidth * (e.key === 'ArrowRight' ? 1 : -1), behavior: 'smooth' });
    });
    return overlay;
  }

  function updatePos(){
    const track = overlay.querySelector('.rel-track');
    const n = track.children.length;
    const i = Math.min(n, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) + 1);
    overlay.querySelector('.rel-pos').textContent = n > 1 ? `${i} / ${n}` : '';
  }

  function card(g){
    const links = [
      g.steam ? `<a class="rel-btn steam" href="${esc(g.steam)}" target="_blank" rel="noopener">Steam</a>` : '',
      g.igdb ? `<a class="rel-btn" href="${esc(g.igdb)}" target="_blank" rel="noopener">IGDB</a>` : '',
    ].join('');
    return `
      <article class="rel-card">
        <div class="rel-cover">${g.cover ? `<img src="${coverUrl(g.cover, 'cover_big')}" alt="" loading="lazy" onerror="this.remove()">` : '<span>—</span>'}</div>
        <h3>${esc(g.name)}</h3>
        <div class="rel-meta">
          ${g.platforms.map(p => `<span class="rel-chip">${esc(p)}</span>`).join('')}
        </div>
        ${g.genres.length ? `<div class="rel-genres">${esc(g.genres.join(' · '))}</div>` : ''}
        ${g.summary ? `<p class="rel-summary">${esc(g.summary)}</p>` : ''}
        <div class="rel-links">${links}</div>
      </article>`;
  }

  function openDay(key){
    const games = byDay.get(key) || [];
    if (!games.length) return;
    ensureOverlay();
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    overlay.querySelector('.rel-day').textContent = `${DAY_NAMES[date.getDay()]} ${d} ${MONTHS[m - 1].toLowerCase()}`;
    const track = overlay.querySelector('.rel-track');
    track.innerHTML = games.map(card).join('');
    track.scrollLeft = 0;
    overlay.querySelector('.rel-arrows').style.display = games.length > 1 ? '' : 'none';
    overlay.classList.add('show');
    document.body.classList.add('rel-lock');
    updatePos();
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
    if (data) drawMonth();
    else container.innerHTML = '<div class="empty">CHARGEMENT DU CALENDRIER<span class="cursor"></span></div>';

    load()
      .then(() => { if (container.isConnected && !container.hidden) drawMonth(); })
      .catch(() => {
        if (!data) container.innerHTML = '<div class="empty">CALENDRIER INDISPONIBLE — releases.json introuvable<span class="cursor"></span></div>';
      });
  };

})();
