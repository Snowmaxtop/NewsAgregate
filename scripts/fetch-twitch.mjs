// Twitch most-watched (Dispatch, Twitch tab).
//
// Runs hourly in GitHub Actions (refresh-twitch.yml) with the secrets
// already used for IGDB: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.
//
// Each run reads Twitch's biggest live channels (Helix "Get Streams",
// sorted by viewers, MAX_CHANNELS at most) and adds up their viewers per
// category. The many very small channels are left out, so totals sit a
// little below Twitch's own. Over a day, "most watched" is the average of
// the hourly samples (× 24 = hours watched).
//
// twitch.json — rewritten every hour (small):
//   { sampledAt, coverage: { channels, viewers, smallest },
//     now: [[id, viewers, channels, frViewers, topChannel, topViewers], …]   top NOW_TOP
//     today: { date, n, g: { id: [viewerSum, peak, channelSum, frSum] } }          running sums
//     games: { id: { name, img, igdb } } }                       categories used above
// twitch-history.json — rewritten once a day, when a UTC day is over:
//   { days: { "YYYY-MM-DD": { n, g: { id: [avgViewers, peak, avgChannels, avgFr] } } },
//     games: { id: { name, img, igdb } } }                       categories used above
// igdb = IGDB game id (null for non-game categories such as Just Chatting).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { getToken } from './fetch-releases.mjs';

export const MAX_CHANNELS = 10000;   // 100 pages of 100 live channels
export const NOW_TOP = 100;          // categories kept for "Live now"
export const SAMPLE_TOP = 150;       // categories added to the day's sums per sample
export const DAY_KEEP = 120;         // categories kept per finished day
export const KEEP_DAYS = 62;         // the 30-day view and the 30 days before it

const HELIX = 'https://api.twitch.tv/helix';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Box art from Twitch's image CDN only, at 72×96 (shown at 36×48).
export function boxArt(url){
  const u = String(url || '');
  return /^https:\/\/static-cdn\.jtvnw\.net\/ttv-boxart\/[\w.%-]+-\{width\}x\{height\}\.(jpg|png)$/.test(u)
    ? u.replace('{width}x{height}', '72x96') : null;
}

// Live channels → viewers per category, biggest first (pure, unit-tested).
export function aggregate(streams){
  const seen = new Set(), by = new Map();
  let viewers = 0, channels = 0, smallest = null;
  for (const s of streams || []){
    if (!s || seen.has(s.id)) continue;   // pages shift while reading: count a channel once
    seen.add(s.id);
    const v = Math.max(0, Number(s.viewer_count) || 0);
    channels++; viewers += v;
    smallest = smallest == null ? v : Math.min(smallest, v);
    const id = /^\d+$/.test(String(s.game_id || '')) ? String(s.game_id) : null;
    if (!id) continue;                    // no category set
    let g = by.get(id);
    if (!g) by.set(id, g = { id, name: String(s.game_name || ''), viewers: 0, channels: 0, fr: 0, top: '', topViewers: -1 });
    g.viewers += v; g.channels++;
    if (s.language === 'fr') g.fr += v;
    if (v > g.topViewers){ g.top = String(s.user_name || '').slice(0, 40); g.topViewers = v; }
  }
  return { list: [...by.values()].sort((a, b) => b.viewers - a.viewers), coverage: { channels, viewers, smallest } };
}

// Adds one sample to the day's running sums. A new UTC day starts fresh
// and hands back the finished one (pure, unit-tested).
export function addSample(today, list, date){
  const finished = today && today.date && today.date !== date ? today : null;
  const t = today && today.date === date ? { date, n: today.n, g: { ...today.g } } : { date, n: 0, g: {} };
  t.n += 1;
  for (const x of list.slice(0, SAMPLE_TOP)){
    const [sum, peak, ch, fr] = t.g[x.id] || [0, 0, 0, 0];
    t.g[x.id] = [sum + x.viewers, Math.max(peak, x.viewers), ch + x.channels, fr + x.fr];
  }
  return { today: t, finished };
}

// A finished day: averages over its samples, biggest DAY_KEEP categories.
export function closeDay(day){
  const n = Math.max(1, day.n);
  const rows = Object.entries(day.g).sort((a, b) => b[1][0] - a[1][0]).slice(0, DAY_KEEP);
  return { n: day.n, g: Object.fromEntries(rows.map(([id, [sum, peak, ch, fr]]) => [id, [Math.round(sum / n), peak, Math.round(ch / n), Math.round(fr / n)]])) };
}

export function addDay(days, date, closed){
  const all = { ...days, [date]: closed };
  return Object.fromEntries(Object.keys(all).sort().slice(-KEEP_DAYS).map(k => [k, all[k]]));
}

const pick = (games, ids) => Object.fromEntries([...ids].filter(id => games[id]).map(id => [id, games[id]]));
const readJson = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch (e){ return d; } };

async function helix(path, headers){
  for (let attempt = 0; ; attempt++){
    const res = await fetch(HELIX + path, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && attempt < 2){ await sleep(10000); continue; }   // rate limit: wait, retry
    if (!res.ok) throw new Error(`Twitch ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }
}

// Live channels, most watched first. A failure after a good part was read
// keeps what was read (coverage shows how much).
async function fetchStreams(headers){
  const out = [];
  let after = '';
  try {
    for (let page = 0; page < MAX_CHANNELS / 100; page++){
      const j = await helix(`/streams?first=100&type=live${after ? `&after=${encodeURIComponent(after)}` : ''}`, headers);
      out.push(...(j.data || []));
      after = j.pagination && j.pagination.cursor;
      if (!after || !(j.data || []).length) break;
    }
  } catch (e){
    if (out.length < 2000) throw e;
    console.log(`Streams: stopped after ${out.length} channels (${e.message}).`);
  }
  return out;
}

// Name, box art and IGDB id of categories, 100 per request.
async function fetchGames(headers, ids){
  const out = {};
  for (let i = 0; i < ids.length; i += 100){
    try {
      const j = await helix('/games?' + ids.slice(i, i + 100).map(id => 'id=' + id).join('&'), headers);
      for (const g of j.data || []){
        if (!/^\d+$/.test(String(g.id))) continue;
        out[g.id] = { name: String(g.name || ''), img: boxArt(g.box_art_url), igdb: /^\d+$/.test(String(g.igdb_id || '')) ? Number(g.igdb_id) : null };
      }
    } catch (e){ console.log(`Categories: ${e.message} (retried next run).`); }
  }
  return out;
}

export async function main({ now = new Date() } = {}){
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing (repository secrets).');
  const headers = { 'Client-Id': id, Authorization: `Bearer ${await getToken(id, secret)}` };

  const streams = await fetchStreams(headers);
  if (!streams.length) throw new Error('Twitch returned no live channels.');
  const { list, coverage } = aggregate(streams);
  const date = now.toISOString().slice(0, 10);

  const cur = readJson('twitch.json', {});
  const hist = readJson('twitch-history.json', { days: {}, games: {} });
  const { today, finished } = addSample(cur.today, list, date);

  // Category details: only for categories not seen before.
  const known = { ...(hist.games || {}), ...(cur.games || {}) };
  const needed = new Set([...list.slice(0, NOW_TOP).map(x => x.id), ...Object.keys(today.g), ...Object.keys((finished && finished.g) || {})]);
  Object.assign(known, await fetchGames(headers, [...needed].filter(k => !known[k])));
  for (const x of list) if (!known[x.id]) known[x.id] = { name: x.name, img: null, igdb: null };

  if (finished){
    const days = addDay(hist.days || {}, finished.date, closeDay(finished));
    const ids = new Set(Object.values(days).flatMap(d => Object.keys(d.g)));
    writeFileSync('twitch-history.json', JSON.stringify({ days, games: pick(known, ids) }));
    console.log(`Day ${finished.date} closed (${finished.n} samples); history: ${Object.keys(days).length} days.`);
  }
  const nowRows = list.slice(0, NOW_TOP).map(x => [x.id, x.viewers, x.channels, x.fr, x.top, x.topViewers]);
  const ids = new Set([...nowRows.map(r => r[0]), ...Object.keys(today.g)]);
  writeFileSync('twitch.json', JSON.stringify({ sampledAt: now.toISOString(), coverage, now: nowRows, today, games: pick(known, ids) }));
  console.log(`Twitch: ${coverage.channels} channels, ${coverage.viewers} viewers (smallest channel read: ${coverage.smallest}).`);
  console.log('Top 10 now: ' + list.slice(0, 10).map((x, i) => `#${i + 1} ${known[x.id].name} ${x.viewers}`).join(' | '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error(err.message); process.exit(1); });
}
