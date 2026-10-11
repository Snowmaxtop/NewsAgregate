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
//
// push-state.json (committed, public) remembers what was announced and
// carries a `status` the app shows in ⚙ → Notifications, so a setup problem
// (no device, missing secret, wrong key, refused send) is visible on the
// phone, not only in the Actions log. It is only rewritten when something
// changed, to avoid a commit every run.
//
// `node scripts/send-push.mjs --test` (workflow "Test Dispatch notification")
// sends a test notification to every device now, whatever the rules.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createECDH } from 'crypto';
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

// Does the secret private key belong to the public key in the sync file?
// (A second key pair created by mistake makes every send fail.)
export function keysMatch(publicKey, privateKey){
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(String(privateKey).trim(), 'base64url'));
    return ecdh.getPublicKey().toString('base64url') === publicKey;
  } catch (e) { return false; }
}

// Only real https push-service addresses with their keys (the file is public).
export const validSubs = (state) => ((state.push && state.push.subscriptions) || [])
  .filter(s => s && /^https:\/\//.test(s.endpoint || '') && s.keys && s.keys.p256dh && s.keys.auth);

// Pure decision (unit-tested): what to send, and the next push-state.
export function decide({ articles, state, pushState, now }){
  const seen = new Set(pushState.seen || []);
  const links = articles.map(a => a.link);
  // First run ever: remember everything, announce nothing (no backlog blast).
  if (!pushState.seen) return { send: null, next: { ...pushState, seen: links.slice(0, MAX_SEEN), lastSentAt: null }, reason: 'first run: baseline saved' };

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
  return { send, next: { ...pushState, seen: [...new Set(merged)].slice(0, MAX_SEEN), lastSentAt: now.toISOString() }, reason: `${fresh.length} new, ${total} waiting` };
}

// Setup check before any send (pure, unit-tested). null = ready.
export function setupProblem({ subs, publicKey, privateKey }){
  if (!publicKey || !subs.length) return { code: 'no-device', text: 'No device registered on the server yet. Turn notifications on in ⚙ and check it says "saved to GitHub".' };
  if (!privateKey) return { code: 'no-secret', text: 'The VAPID_PRIVATE_KEY secret is missing in GitHub (Settings → Secrets and variables → Actions).' };
  if (!keysMatch(publicKey, privateKey)) return { code: 'key-mismatch', text: 'The VAPID_PRIVATE_KEY secret does not match the key in your sync file. Use "Reset notification keys" in ⚙, then save the new key as the secret.' };
  return null;
}

// Why a push service refused a device, in plain words.
export function failureText(code){
  if (code === 404 || code === 410) return 'subscription expired: turn notifications off and on again on that device';
  if (code === 401 || code === 403) return 'refused: that device subscribed with another key; turn notifications off and on again on it';
  return `error ${code || 'network'}`;
}

async function deliver(subs, payload, publicKey, privateKey){
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(`https://github.com/${process.env.GITHUB_REPOSITORY || 'dispatch'}`, publicKey, privateKey);
  const results = [];
  for (const sub of subs){
    const device = String(sub.device || 'device').slice(0, 40);
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal', topic: 'dispatch-new' });
      results.push({ device, ok: true });
      console.log(`  ✓ ${device}`);
    } catch (e){
      results.push({ device, ok: false, code: e.statusCode || null });
      console.log(`  ✗ ${device}: ${failureText(e.statusCode)} (${e.statusCode || e.message})`);
    }
  }
  return results;
}

const statusFromResults = (results, what) => {
  const ok = results.filter(r => r.ok).length, devices = results.length;
  if (ok === devices) return { code: 'ok', devices, text: `${what} delivered to ${ok} device${ok > 1 ? 's' : ''}.` };
  const bad = results.filter(r => !r.ok).map(r => `${r.device}: ${failureText(r.code)}`).join(' · ');
  return { code: ok ? 'partial' : 'failed', devices, text: `${what} delivered to ${ok}/${devices} device(s). ${bad}` };
};

export async function main({ test = false, now = new Date() } = {}){
  const read = (f, d) => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d; } catch (e) { return d; } };
  const articles = (read('articles.json', {}).articles) || [];
  const state = read('dispatch-state.json', {});
  const pushState = read('push-state.json', {});
  const subs = validSubs(state);
  const publicKey = state.push && state.push.publicKey;
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  console.log(`Push: ${subs.length} device(s) in dispatch-state.json, secret ${privateKey ? 'present' : 'MISSING'}`);

  let next = pushState, status;
  const problem = setupProblem({ subs, publicKey, privateKey });
  if (problem) {
    status = problem;
    console.log(`Push: ${problem.text}`);
  } else if (test) {
    const results = await deliver(subs, { title: 'Dispatch test notification', body: 'Notifications work on this device.', count: 0, url: './' }, publicKey, privateKey);
    status = statusFromResults(results, `Test at ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    next = { ...pushState, lastTestAt: now.toISOString() };
  } else {
    const d = decide({ articles, state, pushState, now });
    console.log(`Push: ${d.reason}`);
    if (d.send) {
      // The articles were just pushed: give GitHub Pages time to publish
      // them so tapping the notification shows the new list.
      const wait = Number(process.env.PUSH_DELAY_S || 0);
      if (wait) await new Promise(r => setTimeout(r, wait * 1000));
      const results = await deliver(subs, d.send, publicKey, privateKey);
      status = statusFromResults(results, 'Last reminder');
      console.log(`Push: ${status.text}`);
      // Nothing delivered: keep the old state so the next run tries again.
      next = results.some(r => r.ok) ? d.next : pushState;
    } else {
      next = d.next;
      // The last send result (good or bad) stays until the next send, as
      // long as the same devices are registered; otherwise "ready".
      const prev = pushState.status || {};
      const keep = ['ok', 'failed', 'partial'].includes(prev.code) && prev.devices === subs.length;
      status = keep ? prev : { code: 'ok', devices: subs.length, text: `Ready: ${subs.length} device${subs.length > 1 ? 's' : ''} registered.` };
    }
  }

  // Write only when something changed (seen list, last send, status).
  const prev = pushState.status || {};
  const changed = prev.code !== status.code || prev.text !== status.text;
  const out = { ...next, status: { ...status, since: changed ? now.toISOString() : prev.since || now.toISOString() } };
  if (JSON.stringify(out) !== JSON.stringify(pushState)) {
    writeFileSync('push-state.json', JSON.stringify(out));
    console.log('Push: push-state.json updated');
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  main({ test: process.argv.includes('--test') })
    .catch(err => { console.error('Push failed (articles were still updated):', err.message); });
}
