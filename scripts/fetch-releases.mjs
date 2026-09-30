// Builds releases.json for Dispatch's "Sorties" calendar tab, from IGDB.
//
// Runs inside GitHub Actions (never in the browser: the Twitch client
// secret must stay private). Needs two repository secrets exposed as env:
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
//
// Output shape (one entry per game per release day):
//   { generatedAt, from, to, games: [{ id, name, date:"YYYY-MM-DD",
//     platforms:[...], developers, publishers, cover, summary, genres:[...],
//     hypes, wlRank (Steam most-wishlisted position), steam, igdb }] }
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

// ---- Tunables ---------------------------------------------------------
// Months covered: from the start of (current month - MONTHS_BACK) to the
// end of (current month + MONTHS_AHEAD).
export const MONTHS_BACK = 1;
// Far-future games rarely have an exact day, so a wide window stays cheap.
// The calendar only extends as far as the latest game actually found.
export const MONTHS_AHEAD = 36;

// A game is kept if EITHER:
//  • it is in the top WISHLIST_TOP of Steam's "most wishlisted" ranking
//    (read from the Steam store search, sorted by wishlists — the same
//    ranking SteamDB shows), OR
//  • it has at least MIN_HYPES IGDB followers (catches console-only games
//    that aren't on Steam).
export const MIN_HYPES = 25;
export const WISHLIST_TOP = 1500;

// IGDB game_type ids we keep. Everything else (DLC 1, bundle 3, mod 5,
// episode 6, season 7, fork 12, pack 13, update 14) is dropped.
// 0 main game · 4 standalone expansion · 8 remake · 9 remaster
// 10 expanded game · 11 port
export const KEEP_GAME_TYPES = new Set([0, 4, 8, 9, 10, 11]);

// Region preference when a game has different dates per region.
// IGDB release_region ids: 1 Europe, 8 Worldwide.
const REGION_PREFERENCE = [1, 8];

const IGDB_URL = 'https://api.igdb.com/v4/release_dates';
const PAGE_SIZE = 500;

// ---- Pure helpers (unit-tested) ---------------------------------------

export function computeWindow(now = new Date()){
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const from = new Date(Date.UTC(y, m - MONTHS_BACK, 1));
  const to = new Date(Date.UTC(y, m + MONTHS_AHEAD + 1, 1)); // exclusive
  return { from, to };
}

export function ymd(unixSeconds){
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// IGDB renamed several enum fields; accept old and new names.
const numOf = (v) => (v && typeof v === 'object') ? v.id : v;
const regionOf = (r) => numOf(r.release_region ?? r.region);
const dateFormatOf = (r) => numOf(r.date_format ?? r.category);
const gameTypeOf = (g) => numOf(g.game_type ?? g.category);

export function steamAppIdOf(game){
  for (const e of game.external_games || []){
    const src = numOf(e.external_game_source ?? e.category);
    if (src === 1 && e.uid && /^\d+$/.test(String(e.uid))) return Number(e.uid);
  }
  for (const w of game.websites || []){
    const m = /store\.steampowered\.com\/app\/(\d+)/.exec(w.url || '');
    if (m) return Number(m[1]);
  }
  return null;
}

function steamUrlOf(game){
  for (const w of game.websites || []){
    const t = numOf(w.type ?? w.category);
    if (t === 13 || /store\.steampowered\.com\/app\//.test(w.url || '')) return w.url;
  }
  for (const e of game.external_games || []){
    const src = numOf(e.external_game_source ?? e.category);
    if (src === 1 && e.uid) return `https://store.steampowered.com/app/${e.uid}`;
  }
  return null;
}

// rows: raw release_dates rows (with expanded game).
// steamRank: Map<steamAppId, position in Steam's most-wishlisted list>.
export function buildReleases(rows, steamRank = new Map()){
  const rankOf = (g) => {
    const app = steamAppIdOf(g);
    const r = app != null ? steamRank.get(app) : undefined;
    return r != null && r <= WISHLIST_TOP ? r : undefined;
  };

  // 1) keep exact-day dates of relevant game types, above the hype bar
  const valid = rows.filter(r =>
    r && r.game && typeof r.date === 'number' &&
    (dateFormatOf(r) === 0 || dateFormatOf(r) === undefined) &&
    (gameTypeOf(r.game) === undefined || KEEP_GAME_TYPES.has(gameTypeOf(r.game))) &&
    // must have a cover and a description (for now)
    r.game.cover && r.game.cover.image_id && r.game.summary && String(r.game.summary).trim() &&
    ((r.game.hypes || 0) >= MIN_HYPES || rankOf(r.game) !== undefined)
  );

  // 2) per game, keep the preferred region's rows only
  const byGame = new Map();
  for (const r of valid){
    if (!byGame.has(r.game.id)) byGame.set(r.game.id, []);
    byGame.get(r.game.id).push(r);
  }

  const out = [];
  for (const list of byGame.values()){
    let chosen = null;
    for (const reg of REGION_PREFERENCE){
      const hit = list.filter(r => regionOf(r) === reg);
      if (hit.length){ chosen = hit; break; }
    }
    if (!chosen) chosen = list;

    // 3) merge platforms that share the same day
    const byDay = new Map();
    for (const r of chosen){
      const day = ymd(r.date);
      if (!byDay.has(day)) byDay.set(day, new Set());
      const p = r.platform && (r.platform.abbreviation || r.platform.name);
      if (p) byDay.get(day).add(p);
    }

    // 4) ONE entry per game, on its earliest day. Later days (other
    //    platforms, standard vs early-access editions…) are listed in
    //    `dates` so the popup can show them without duplicating the game.
    const days = [...byDay.keys()].sort();
    const allPlats = new Set();
    for (const set of byDay.values()) for (const p of set) allPlats.add(p);
    const g = chosen[0].game;
    const companies = (role) => [...new Set((g.involved_companies || [])
      .filter(c => c && c[role] && c.company && c.company.name)
      .map(c => c.company.name))];
    {
      out.push({
        id: g.id,
        name: g.name,
        date: days[0],
        dates: days.length > 1 ? days.map(d => ({ date: d, platforms: [...byDay.get(d)].sort() })) : undefined,
        platforms: [...allPlats].sort(),
        developers: companies('developer'),
        publishers: companies('publisher'),
        cover: g.cover && g.cover.image_id ? g.cover.image_id : null,
        summary: g.summary ? String(g.summary).slice(0, 600) : '',
        genres: (g.genres || []).map(x => x.name).filter(Boolean),
        hypes: g.hypes || 0,
        wlRank: rankOf(g),
        steam: steamUrlOf(g),
        steamAppId: steamAppIdOf(g) ?? undefined,
        igdb: g.url || (g.slug ? `https://www.igdb.com/games/${g.slug}` : null),
      });
    }
  }

  // Within a day: best Steam wishlist rank first, then IGDB hypes.
  const r = (g) => g.wlRank ?? Infinity;
  out.sort((a, b) => a.date.localeCompare(b.date) || r(a) - r(b) || b.hypes - a.hypes || a.name.localeCompare(b.name));
  return out;
}

// ---- Network ----------------------------------------------------------

async function getToken(id, secret){
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`Twitch token: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllRows(id, token, from, to){
  const fields = [
    'date', 'date_format', 'release_region', 'platform.name', 'platform.abbreviation',
    'game.id', 'game.name', 'game.slug', 'game.url', 'game.summary', 'game.hypes',
    'game.game_type', 'game.cover.image_id', 'game.genres.name',
    'game.involved_companies.company.name', 'game.involved_companies.developer', 'game.involved_companies.publisher',
    'game.websites.url', 'game.websites.type',
    'game.external_games.uid', 'game.external_games.external_game_source',
  ].join(',');
  const fromS = Math.floor(from / 1000), toS = Math.floor(to / 1000);
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE){
    const body = `fields ${fields}; where date >= ${fromS} & date < ${toS}; sort date asc; limit ${PAGE_SIZE}; offset ${offset};`;
    const res = await fetch(IGDB_URL, {
      method: 'POST',
      headers: { 'Client-ID': id, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`IGDB: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    await sleep(300); // IGDB allows 4 requests/second
  }
  return rows;
}

// Steam store search sorted by wishlists ("filter=popularwishlist"): the
// public ranking SteamDB also displays. One entry per single app, in order.
const decode = (t) => String(t || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();

export function parseSteamSearch(html){
  const out = [];
  const chunks = html.split(/(?=<a[^>]*search_result_row)/);
  for (const chunk of chunks){
    const tag = (chunk.match(/^<a[^>]*search_result_row[^>]*>/) || [])[0];
    if (!tag) continue;
    const id = /data-ds-appid="(\d+)"/.exec(tag);   // single apps only (bundles list several ids)
    if (!id) continue;
    const title = /<span class="title">([\s\S]*?)<\/span>/.exec(chunk);
    const released = /class="[^"]*search_released[^"]*">([\s\S]*?)<\/div>/.exec(chunk);
    const img = /<img[^>]*\ssrc="(https:\/\/[^"]+)"/.exec(chunk);
    out.push({
      appid: Number(id[1]),
      name: title ? decode(title[1]) : '',
      released: released ? decode(released[1]) : '',
      img: img ? img[1].replace(/&amp;/g, '&') : null,
    });
  }
  return out;
}

async function fetchSteamRanking(limit){
  const list = [];
  const seen = new Set();
  const PAGE = 50;
  try {
    for (let start = 0; start < limit; start += PAGE){
      const url = `https://store.steampowered.com/search/results/?filter=popularwishlist&infinite=1&json=1&cc=us&l=english&start=${start}&count=${PAGE}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Dispatch release calendar)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseSteamSearch((await res.json()).results_html || '');
      if (!rows.length) break;
      for (const r of rows) if (!seen.has(r.appid) && list.length < limit){ seen.add(r.appid); list.push({ rank: list.length + 1, ...r }); }
      await sleep(1000); // be gentle with the Steam store
    }
    console.log(`Steam wishlist ranking: ${list.length} games read.`);
  } catch (e){
    console.log(`Steam wishlist ranking failed after ${list.length} games (${e.message}) — hypes still apply.`);
  }
  return list;
}

// ---- Wishlist momentum ------------------------------------------------
// wishlist-history.json keeps one snapshot per day: the Steam top list as
// an array of app ids in rank order (position + 1 = rank). ~12 KB a day.
export const HISTORY_DAYS = 40;

export function addDays(ymdStr, n){
  const d = new Date(ymdStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function updateHistory(hist, day, appids){
  const days = { ...(hist && hist.days) , [day]: appids };
  const keys = Object.keys(days).sort().slice(-HISTORY_DAYS);
  return { days: Object.fromEntries(keys.map(k => [k, days[k]])) };
}

// Snapshot from k days before `day` (tolerating up to 2 missing days).
// Returns { date, rank: Map<appid, rank> } or null if there's none yet.
export function snapshotBefore(hist, day, k){
  const target = addDays(day, -k), floor = addDays(target, -2);
  const key = Object.keys(hist.days || {}).filter(d => d <= target && d >= floor).sort().pop();
  if (!key) return null;
  return { date: key, rank: new Map(hist.days[key].map((id, i) => [id, i + 1])) };
}

// For each ranked app: dN = places gained over N days (positive = climbing),
// null when it wasn't in the list back then; new7 = entered in the last 7 days.
export function computeMomentum(hist, day, list){
  const snaps = { d1: snapshotBefore(hist, day, 1), d7: snapshotBefore(hist, day, 7), d30: snapshotBefore(hist, day, 30) };
  const out = new Map();
  for (const r of list){
    const m = {};
    for (const [k, snap] of Object.entries(snaps)){
      if (!snap) continue;
      const prev = snap.rank.get(r.appid);
      m[k] = prev ? prev - r.rank : null;
    }
    if (snaps.d7) m.new7 = !snaps.d7.rank.has(r.appid);
    out.set(r.appid, m);
  }
  return { byApp: out, since: Object.fromEntries(Object.entries(snaps).map(([k, v]) => [k, v ? v.date : null])) };
}

async function main(){
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET');

  const { from, to } = computeWindow();
  const token = await getToken(id, secret);
  const rows = await fetchAllRows(id, token, from, to);
  const steamList = await fetchSteamRanking(WISHLIST_TOP);
  const steamRank = new Map(steamList.map(r => [r.appid, r.rank]));
  const games = buildReleases(rows, steamRank);

  // Daily rank history → momentum (only when Steam answered today).
  const today = new Date().toISOString().slice(0, 10);
  let momentum = { byApp: new Map(), since: {} };
  if (steamList.length){
    let hist = { days: {} };
    try { if (existsSync('wishlist-history.json')) hist = JSON.parse(readFileSync('wishlist-history.json', 'utf8')); } catch (e) { console.log('wishlist-history.json unreadable, starting fresh'); }
    momentum = computeMomentum(hist, today, steamList);
    hist = updateHistory(hist, today, steamList.map(r => r.appid));
    writeFileSync('wishlist-history.json', JSON.stringify(hist));
    console.log(`Wishlist history: ${Object.keys(hist.days).length} day(s) stored; comparing with ${JSON.stringify(momentum.since)}`);
    for (const g of games){
      const m = g.steamAppId != null && momentum.byApp.get(g.steamAppId);
      if (m && g.wlRank){ g.wl1 = m.d1; g.wl7 = m.d7; }
    }
  }

  // wishlists.json: the full Steam top list, linked to calendar games when
  // we have them (so the app can open the game card or its calendar day).
  const byApp = new Map();
  for (const r of rows){ const a = r.game && steamAppIdOf(r.game); if (a != null && !byApp.has(a)) byApp.set(a, r.game.id); }
  const inCal = new Map(games.map(g => [g.id, g.date]));
  if (steamList.length){
    writeFileSync('wishlists.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      momentumSince: momentum.since,
      games: steamList.map(r => {
        const igdbId = byApp.get(r.appid);
        return { ...r, ...momentum.byApp.get(r.appid), igdbId: inCal.has(igdbId) ? igdbId : undefined, date: inCal.get(igdbId) };
      }),
    }));
    console.log(`wishlists.json: ${steamList.length} games (${steamList.filter(r => inCal.has(byApp.get(r.appid))).length} in the calendar)`);
  } else {
    console.log('wishlists.json not rewritten (Steam unavailable) — keeping the previous file.');
  }

  const out = {
    generatedAt: new Date().toISOString(),
    from: from.toISOString().slice(0, 10),
    to: new Date(to - 86400000).toISOString().slice(0, 10),
    games,
  };
  writeFileSync('releases.json', JSON.stringify(out));
  console.log(`releases.json: ${rows.length} IGDB rows → ${games.length} entries (${out.from} → ${out.to})`);
  const counts = {};
  for (const g of games) counts[g.date] = (counts[g.date] || 0) + 1;
  const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`Busiest days: ${busiest.map(([d, n]) => `${d}=${n}`).join(', ')}`);
  const risers = steamList.map(r => ({ ...r, ...momentum.byApp.get(r.appid) })).filter(r => r.d7 > 0).sort((a, b) => b.d7 - a.d7).slice(0, 10);
  if (risers.length) console.log(`Biggest 7-day risers: ${risers.map(r => `${r.name} ▲${r.d7} → #${r.rank}`).join(' | ')}`);
  console.log(`Top wishlisted: ${games.filter(g => g.wlRank).sort((a, b) => a.wlRank - b.wlRank).slice(0, 10).map(g => `#${g.wlRank} ${g.name}`).join(' | ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error(err); process.exit(1); });
}
