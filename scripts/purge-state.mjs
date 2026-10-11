// Trims dispatch-state.json: read[] and hidden[] only store links and would
// grow forever, so they're cut down to the links still in articles.json.
// Favorites, liked games and push devices are never touched.
//
// Runs as its own step of the articles workflow, on a fresh copy of the
// repo, and is committed separately: if the app saves the file at the same
// moment, only this clean-up is skipped (it retries on the next run) —
// the articles update is never blocked.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';

// Pure (unit-tested): returns the trimmed state and how much was removed.
export function purgeState(state, liveLinks) {
  const live = new Set(liveLinks);
  const read = (state.read || []).filter((l) => live.has(l));
  const hidden = (state.hidden || []).filter((l) => live.has(l));
  const removed = (state.read || []).length - read.length + (state.hidden || []).length - hidden.length;
  return { state: { ...state, read, hidden }, removed };
}

function main() {
  if (!existsSync('dispatch-state.json') || !existsSync('articles.json')) {
    console.log('State purge: dispatch-state.json or articles.json missing — skipped.');
    return;
  }
  const state = JSON.parse(readFileSync('dispatch-state.json', 'utf8'));
  const links = (JSON.parse(readFileSync('articles.json', 'utf8')).articles || []).map((a) => a.link);
  const { state: next, removed } = purgeState(state, links);
  if (!removed) { console.log('State purge: nothing to remove.'); return; }
  writeFileSync('dispatch-state.json', JSON.stringify(next, null, 2));
  console.log(`State purge: removed ${removed} old link(s) (read ${next.read.length}, hidden ${next.hidden.length}, favorites kept: ${(next.favorites || []).length})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error('State purge skipped:', e.message); }
}
