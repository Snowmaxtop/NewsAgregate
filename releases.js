// Dispatch — "Sorties" tab: monthly release calendar + day slider popup.
// Reads releases.json (built daily by scripts/fetch-releases.mjs).
// Exposes a single global: renderReleases(container).
// Likes use isGameLiked(id) / toggleGameLike(game) from index.html, which
// store them in the synced state (dispatch-state.json).
(function(){
  const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  const WEEKDAYS = ['L','M','M','J','V','S','D'];
  const DAY_NAMES = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const REFETCH_MS = 60 * 60 * 1000;

  let data = null;          // parsed releases.json
  let byDay = new Map();    // "YYYY-MM-DD" -> [games]
  let byId = new Map();     // IGDB id -> game (fresh data for liked snapshots)
  let view = 'cal';         // 'cal' | 'likes'
  let shown = [];           // games currently in the popup
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
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
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
      <button data-view="cal" class="${view === 'cal' ? 'on' : ''}">📅 Calendrier</button>
      <button data-view="likes" class="${view === 'likes' ? 'on' : ''}">♥ Mes jeux <span class="count">${n}</span></button>
    </div>`;
  }
  function draw(){ view === 'likes' ? drawLikes() : drawMonth(); }

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
        <button class="cal-nav" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Mois précédent">‹</button>
        <div class="cal-title">${MONTHS[m]} ${y}<span class="cal-sub">${monthCount} sortie${monthCount > 1 ? 's' : ''}</span></div>
        <button class="cal-nav" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Mois suivant">›</button>
      </div>
      <div class="cal-grid cal-weekdays">${WEEKDAYS.map(w => `<div>${w}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-foot">Données IGDB · MAJ ${data ? new Date(data.generatedAt).toLocaleDateString('fr-FR') : '—'}</div>`;
  }

  // ---- "Mes jeux": recap of liked games --------------------------------
  function drawLikes(){
    const now = new Date();
    const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
    const list = likedList();
    const upcoming = list.filter(g => g.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = list.filter(g => g.date < today).sort((a, b) => b.date.localeCompare(a.date));

    const row = (g) => `
      <div class="like-row" data-id="${g.id}">
        <div class="like-thumb">${g.cover ? `<img src="${coverUrl(g.cover, 'cover_small')}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="like-body">
          <div class="like-date">${esc(shortDate(g.date))}</div>
          <div class="like-name">${esc(g.name)}</div>
          <div class="like-sub">${esc([...(g.developers || []).slice(0, 1), (g.platforms || []).join(' · ')].filter(Boolean).join(' — '))}</div>
        </div>
        <button class="like-heart on" data-like="${g.id}" aria-label="Retirer des likes">♥</button>
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
      ? groups(upcoming) + (past.length ? `<div class="like-month past">Déjà sortis</div>${past.map(row).join('')}` : '')
      : '<div class="empty">AUCUN JEU LIKÉ — touche ♡ dans le détail d\'un jour<span class="cursor"></span></div>');
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
          <button class="rel-close" aria-label="Fermer">✕</button>
        </div>
        <div class="rel-viewport"><div class="rel-strip"></div></div>
        <div class="rel-dots"></div>
      </div>`;
    document.body.appendChild(overlay);
    viewport = overlay.querySelector('.rel-viewport');
    strip = overlay.querySelector('.rel-strip');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.rel-close')) return closeDay();
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
      (g.developers || []).length ? `<span>Dév. <b>${esc(g.developers.join(', '))}</b></span>` : '',
      (g.publishers || []).length ? `<span>Éd. <b>${esc(g.publishers.join(', '))}</b></span>` : '',
    ].filter(Boolean).join('');
    const dates = (g.dates || []).length > 1
      ? `<div class="rel-dates">${g.dates.map(x => `${esc(shortDate(x.date))} <span>(${esc(x.platforms.join(', '))})</span>`).join(' · ')}</div>`
      : '';
    return `
      <article class="rel-card">
        <button class="rel-like ${on ? 'on' : ''}" data-like="${g.id}" aria-label="Liker">${on ? '♥' : '♡'}</button>
        <div class="rel-cover">${g.cover ? `<img src="${coverUrl(g.cover, 'cover_big')}" alt="" loading="lazy" onerror="this.remove()">` : '<span>—</span>'}</div>
        <h3>${esc(g.name)}</h3>
        ${companies ? `<div class="rel-companies">${companies}</div>` : ''}
        ${dates}
        <div class="rel-meta">
          ${g.platforms.map(p => `<span class="rel-chip">${esc(p)}</span>`).join('')}
        </div>
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
    ensureOverlay();
    shown = games;
    overlay.querySelector('.rel-day').textContent = title;
    count = games.length;
    strip.innerHTML = games.map(card).join('');
    overlay.querySelector('.rel-dots').innerHTML = count > 1 && count <= 20
      ? games.map((_, k) => `<button class="rel-dot" data-i="${k}" aria-label="Jeu ${k + 1}"></button>`).join('')
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
        const seg = e.target.closest('.rel-seg button');
        if (seg){ view = seg.dataset.view; draw(); return; }
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
    if (data || view === 'likes') draw();
    else container.innerHTML = '<div class="empty">CHARGEMENT DU CALENDRIER<span class="cursor"></span></div>';

    load()
      .then(() => { if (container.isConnected && !container.hidden) draw(); })
      .catch(() => {
        if (!data && view === 'cal') container.innerHTML = '<div class="empty">CALENDRIER INDISPONIBLE — releases.json introuvable<span class="cursor"></span></div>';
      });
  };

})();
