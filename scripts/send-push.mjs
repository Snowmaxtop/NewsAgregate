// Sends a push notification to every subscribed device when the articles
// run brought new articles. Runs right after fetch-articles.mjs.
//
// Needs: the repository secret VAPID_PRIVATE_KEY (shown once in the app's
// ⚙ settings when notifications are first turned on) and, in
// dispatch-state.json, state.push = { publicKey, subscriptions: [...] }.
//
// Rules (tunable below):
//   • the notification shows how many articles are waiting to be reviewed
//   • it's only sent when new articles arrived since the last one
//   • at most one notification per MIN_INTERVAL_MIN
//   • nothing during quiet hours (Paris time); new articles wait and are
//     included in the first notification after
// Remembers what it already announced in push-state.json (committed).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

export const MIN_INTERVAL_MIN = 60;
export const QUIET_START_H = 23;   // 23:00 → 07:00, Europe/Paris
export const QUIET_END_H = 7;
const TZ = 'Europe/Paris';
const MAX_SEEN = 3000;

export function parisHour(date){
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }).format(date)) % 24;
}
export function isQuiet(date){
  const h = parisHour(date);
  return QUIET_START_H > QUIET_END_H ? (h >= QUIET_START_H || h < QUIET_END_H) : (h >= QUIET_START_H && h < QUIET_END_H);
}

// Pure decision (unit-tested): what to send, and the next push-state.
export function decide({ articles, state, pushState, now }){
  const seen = new Set(pushState.seen || []);
  const links = articles.map(a => a.link);
  // First run ever: remember everything, announce nothing (no backlog blast).
  if (!pushState.seen) return { send: null, next: { seen: links.slice(0, MAX_SEEN), lastSentAt: null }, reason: 'first run: baseline saved' };

  const read = new Set(state.read || []), hidden = new Set(state.hidden || []);
  const favs = new Set((state.favorites || []).map(f => f.link));
  const toReview = articles.filter(a => !read.has(a.link) && !hidden.has(a.link) && !favs.has(a.link));
  const fresh = toReview.filter(a => !seen.has(a.link));

  const keep = { ...pushState };
  if (!fresh.length) return { send: null, next: keep, reason: 'nothing new' };
  if (isQuiet(now)) return { send: null, next: keep, reason: 'quiet hours' };
  if (pushState.lastSentAt && now - new Date(pushState.lastSentAt) < MIN_INTERVAL_MIN * 60000)
    return { send: null, next: keep, reason: `last notification under ${MIN_INTERVAL_MIN} min ago` };

  // The message is just a reminder of the whole stack waiting in the app;
  // new arrivals only decide *when* to remind (no repeat if nothing changed).
  const total = toReview.length;
  const send = {
    title: `📰 ${total} article${total > 1 ? 's' : ''} waiting`,
    body: 'Tap to review them in Dispatch.',
    count: total,
    url: './',
  };
  const merged = [...fresh.map(a => a.link), ...(pushState.seen || [])];
  return { send, next: { seen: [...new Set(merged)].slice(0, MAX_SEEN), lastSentAt: now.toISOString() }, reason: `${fresh.length} new, ${total} waiting` };
}

async function main(){
  const now = new Date();
  const read = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch (e) { return d; } };
  const articles = (read('articles.json', {}).articles) || [];
  const state = read('dispatch-state.json', {});
  const pushState = read('push-state.json', {});
  // Only real https push-service addresses are used (the sync file is public).
  const subs = ((state.push && state.push.subscriptions) || []).filter(s => s && /^https:\/\//.test(s.endpoint || '') && s.keys && s.keys.p256dh && s.keys.auth);
  const publicKey = state.push && state.push.publicKey;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!subs.length || !publicKey){ console.log('Push: no device subscribed yet — skipping.'); return; }
  if (!privateKey){ console.log('Push: VAPID_PRIVATE_KEY secret missing — skipping.'); return; }

  const { send, next, reason } = decide({ articles, state, pushState, now });
  console.log(`Push: ${reason}`);
  if (send){
    // The articles were just pushed: give GitHub Pages time to publish
    // them so tapping the notification shows the new list.
    const wait = Number(process.env.PUSH_DELAY_S || 0);
    if (wait) await new Promise(r => setTimeout(r, wait * 1000));
    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails(`https://github.com/${process.env.GITHUB_REPOSITORY || 'dispatch'}`, publicKey, privateKey);
    let ok = 0;
    for (const sub of subs){
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(send), { TTL: 6 * 3600, urgency: 'normal', topic: 'dispatch-new' });
        ok++;
      } catch (e){
        const gone = e.statusCode === 404 || e.statusCode === 410;
        console.log(`  ✗ ${sub.endpoint.slice(0, 60)}…: ${e.statusCode || ''} ${gone ? '(subscription expired — turn notifications on again on that device)' : e.message}`);
      }
    }
    console.log(`Push: sent "${send.title}" to ${ok}/${subs.length} device(s)`);
    if (!ok){ console.log('Push: nothing delivered — will retry next run.'); return; }
  }
  writeFileSync('push-state.json', JSON.stringify(next));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main().catch(err => { console.error('Push failed (articles were still updated):', err.message); });
}
