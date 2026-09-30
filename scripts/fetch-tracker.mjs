// After-launch tracker for liked games (Dispatch, Releases tab).
//
// Runs hourly in GitHub Actions. For every liked game that is already
// released and has a Steam page, it records:
//   • current players (Steam Web API, public, no key)
//   • Steam review totals and score label (store appreviews endpoint)
// and keeps a per-day history: the day's peak players and the review
// total at the end of the day (new reviews per day ≈ a sales signal).
//
// Liked games come from dispatch-state.json (state.likedGames), so a like
// is tracked after you press Save in the app and the next hourly run.
//
// Output: tracker.json
//   { generatedAt, games: { "<appid>": { name, now, nowAt,
//       reviews: { positive, total, desc }, days: { "YYYY-MM-DD": { peak, reviews } } } } }
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

export const KEEP_DAYS = 120;
const UA = { 'User-Agent': 'Mozilla/5.0 (Dispatch after-launch tracker)' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function appIdOf(game){
  if (game && game.steamAppId) return Number(game.steamAppId);
  const m = /store\.steampowered\.com\/app\/(\d+)/.exec((game && game.steam) || '');
  return m ? Number(m[1]) : null;
}

// Liked games that are out (release day ≤ today) and on Steam.
export function trackedGames(likedGames, today){
  const out = new Map();
  for (const g of likedGames || []){
    const app = appIdOf(g);
    if (app && g.date && g.date <= today) out.set(app, g.name);
  }
  return out;
}

// Merges one sample into a game's record (pure, unit-tested).
export function applySample(rec, sample, today, nowIso){
  const r = { name: sample.name, days: { ...(rec && rec.days) } };
  r.now = sample.players ?? (rec && rec.now) ?? null;
  r.nowAt = sample.players != null ? nowIso : (rec && rec.nowAt) || null;
  r.reviews = sample.reviews || (rec && rec.reviews) || null;
  const day = { ...(r.days[today] || {}) };
  if (sample.players != null) day.peak = Math.max(day.peak || 0, sample.players);
  if (sample.reviews) day.reviews = sample.reviews.total;
  r.days[today] = day;
  const keys = Object.keys(r.days).sort().slice(-KEEP_DAYS);
  r.days = Object.fromEntries(keys.map(k => [k, r.days[k]]));
  return r;
}

async function getJson(url){
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function sampleGame(appid, name){
  const s = { name, players: null, reviews: null };
  try {
    const j = await getJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`);
    if (j.response && j.response.result === 1) s.players = j.response.player_count;
  } catch (e){ console.log(`  players ${appid}: ${e.message}`); }
  try {
    const j = await getJson(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`);
    const q = j.query_summary;
    if (j.success === 1 && q) s.reviews = { positive: q.total_positive, total: q.total_reviews, desc: q.review_score_desc };
  } catch (e){ console.log(`  reviews ${appid}: ${e.message}`); }
  return s;
}

export async function main(){
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  let state = {};
  try { state = JSON.parse(readFileSync('dispatch-state.json', 'utf8')); } catch (e){ console.log('dispatch-state.json not found — nothing to track.'); }
  let tracker = { games: {} };
  try { if (existsSync('tracker.json')) tracker = JSON.parse(readFileSync('tracker.json', 'utf8')); } catch (e){ /* start fresh */ }

  const wanted = trackedGames(state.likedGames, today);
  const games = {};
  for (const [appid, name] of wanted){
    const sample = await sampleGame(appid, name);
    games[appid] = applySample(tracker.games && tracker.games[appid], sample, today, nowIso);
    const rv = sample.reviews ? `${Math.round(100 * sample.reviews.positive / Math.max(1, sample.reviews.total))}% of ${sample.reviews.total}` : 'n/a';
    console.log(`✓ ${name} (${appid}): ${sample.players ?? 'n/a'} players, reviews ${rv}`);
    await sleep(500);
  }
  writeFileSync('tracker.json', JSON.stringify({ generatedAt: nowIso, games }));
  console.log(`tracker.json: ${Object.keys(games).length} released liked game(s) on Steam.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error(err); process.exit(1); });
}
