// Builds releases.json for Dispatch's "Sorties" calendar tab, from IGDB.
//
// Runs inside GitHub Actions (never in the browser: the Twitch client
// secret must stay private). Needs two repository secrets exposed as env:
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
//
// Output shape (one entry per game per release day):
//   { generatedAt, from, to, games: [{ id, name, date:"YYYY-MM-DD",
//     platforms:[...], cover, summary, genres:[...], hypes, steam, igdb }] }
import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

// ---- Tunables ---------------------------------------------------------
// Months covered: from the start of (current month - MONTHS_BACK) to the
// end of (current month + MONTHS_AHEAD).
export const MONTHS_BACK = 1;
export const MONTHS_AHEAD = 6;

// A game is kept if EITHER:
//  • it appears in IGDB's Steam "most wishlisted upcoming" popularity
//    data (Steam's own wishlist counts are private; this is the public
//    ranking IGDB imports), OR
//  • it has at least MIN_HYPES IGDB followers (catches console-only games
//    that Steam data can't see).
// Raise MIN_HYPES to show fewer games per day, lower it to show more.
export const MIN_HYPES = 25;

// Steam data exists for almost every Steam game, so only the WISHLIST_TOP
// best-scored games of the whole period count as "wishlisted".
export const WISHLIST_TOP = 500;

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

// rows: raw release_dates rows (with expanded game). Returns the list of
// { game-day } entries sorted by date, then hypes desc.
// wishlist: Map<gameId, score> from Steam popularity data (may be empty).
export function buildReleases(rows, wishlistAll = new Map()){
  // Keep only the top WISHLIST_TOP Steam scores as a qualifying signal.
  const wishlist = new Map([...wishlistAll].sort((a, b) => b[1] - a[1]).slice(0, WISHLIST_TOP));

  // 1) keep exact-day dates of relevant game types, above the hype bar
  const valid = rows.filter(r =>
    r && r.game && typeof r.date === 'number' &&
    (dateFormatOf(r) === 0 || dateFormatOf(r) === undefined) &&
    (gameTypeOf(r.game) === undefined || KEEP_GAME_TYPES.has(gameTypeOf(r.game))) &&
    // must have a cover and a description (for now)
    r.game.cover && r.game.cover.image_id && r.game.summary && String(r.game.summary).trim() &&
    ((r.game.hypes || 0) >= MIN_HYPES || wishlist.has(r.game.id))
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

    const g = chosen[0].game;
    for (const [day, plats] of byDay){
      out.push({
        id: g.id,
        name: g.name,
        date: day,
        platforms: [...plats].sort(),
        cover: g.cover && g.cover.image_id ? g.cover.image_id : null,
        summary: g.summary ? String(g.summary).slice(0, 600) : '',
        genres: (g.genres || []).map(x => x.name).filter(Boolean),
        hypes: g.hypes || 0,
        wishlist: wishlistAll.get(g.id) || 0,
        steam: steamUrlOf(g),
        igdb: g.url || (g.slug ? `https://www.igdb.com/games/${g.slug}` : null),
      });
    }
  }

  // Within a day: Steam-wishlisted games first (by score), then IGDB hypes.
  out.sort((a, b) => a.date.localeCompare(b.date) || b.wishlist - a.wishlist || b.hypes - a.hypes || a.name.localeCompare(b.name));
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

async function igdb(endpoint, id, token, body){
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': id, 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`IGDB ${endpoint}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// Finds IGDB's Steam wishlist popularity type by name (so we don't depend
// on a hard-coded id), then fetches its values for our games. Any failure
// just returns an empty map: the hype threshold still applies.
async function fetchWishlist(id, token, gameIds){
  const out = new Map();
  try {
    const types = await igdb('popularity_types', id, token, 'fields id,name; limit 100;');
    const wl = types.filter(t => /wishlist/i.test(t.name || ''));
    console.log(`popularity types: ${types.map(t => `${t.id}=${t.name}`).join(', ')}`);
    if (!wl.length){ console.log('No Steam wishlist popularity type found — using hypes only.'); return out; }
    const typeIds = wl.map(t => t.id).join(',');
    const ids = [...gameIds];
    for (let i = 0; i < ids.length; i += 500){
      await sleep(300);
      const chunk = ids.slice(i, i + 500).join(',');
      const rows = await igdb('popularity_primitives', id, token,
        `fields game_id,value; where popularity_type = (${typeIds}) & game_id = (${chunk}); limit 500;`);
      for (const r of rows) out.set(r.game_id, Math.max(out.get(r.game_id) || 0, Number(r.value) || 0));
    }
    console.log(`Steam wishlist data found for ${out.size} games.`);
  } catch (e){
    console.log('Wishlist lookup failed, using hypes only:', e.message);
  }
  return out;
}

async function main(){
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET');

  const { from, to } = computeWindow();
  const token = await getToken(id, secret);
  const rows = await fetchAllRows(id, token, from, to);
  const wishlist = await fetchWishlist(id, token, new Set(rows.map(r => r.game && r.game.id).filter(Boolean)));
  const games = buildReleases(rows, wishlist);

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
  console.log(`Top games: ${games.slice().sort((a, b) => b.wishlist - a.wishlist || b.hypes - a.hypes).slice(0, 10).map(g => `${g.name} (wl ${g.wishlist}, hypes ${g.hypes})`).join(' | ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error(err); process.exit(1); });
}
