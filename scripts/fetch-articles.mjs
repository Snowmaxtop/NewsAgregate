// Fetches all Dispatch RSS feeds server-side (inside GitHub Actions) and
// writes the combined, deduplicated result to articles.json in the repo
// root. Because this runs on GitHub's servers rather than in a browser,
// there is no CORS restriction to work around — this is the same kind of
// request curl or a backend server would make.
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const SOURCES = [
  { id: 'ign',       feed: 'https://fr.ign.com/feed.xml' },
  { id: 'rps',       feed: 'https://www.rockpapershotgun.com/feed/' },
  { id: 'gamedev',   feed: 'https://www.gamedeveloper.com/rss.xml' },
  { id: 'gibiz',     feed: 'https://www.gamesindustry.biz/rss/gamesindustry_news_feed.rss' },
  { id: 'jv',        feed: 'https://www.jeuxvideo.com/rss/rss.xml' },
  { id: 'gameblog',  feed: 'https://www.gameblog.fr/rssmap/rss_all.xml' },
  { id: 'gamekult',  feed: 'https://www.gamekult.com/feed.xml' },
  { id: 'kotaku',    feed: 'https://kotaku.com/feed' },
  { id: 'pcgamer',   feed: 'https://www.pcgamer.com/feeds.xml' },
  { id: 'eurogamer', feed: 'https://www.eurogamer.net/?format=rss' },
  { id: 'polygon',   feed: 'https://www.polygon.com/rss/index.xml' },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function extractImage(item) {
  const thumb = item['media:thumbnail'];
  if (thumb) {
    const t = Array.isArray(thumb) ? thumb[0] : thumb;
    if (t && t['@_url']) return t['@_url'];
  }

  const content = item['media:content'];
  if (content) {
    const list = Array.isArray(content) ? content : [content];
    for (const c of list) {
      const medium = c['@_medium'] || '';
      const type = c['@_type'] || '';
      if (c['@_url'] && (medium === 'image' || type.startsWith('image'))) return c['@_url'];
    }
  }

  const enclosure = item.enclosure;
  if (enclosure) {
    const e = Array.isArray(enclosure) ? enclosure[0] : enclosure;
    const type = e['@_type'] || '';
    if (e['@_url'] && (type.startsWith('image') || !type)) return e['@_url'];
  }

  const html = item['content:encoded'] || item.description || item.summary || '';
  const text = typeof html === 'string' ? html : '';
  const match = text.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function textOf(val) {
  if (val == null) return '';
  if (typeof val === 'object') return String(val['#text'] ?? '');
  return String(val);
}

// --- Fine-grained content tags -----------------------------------------
// Heuristic keyword tagging, computed server-side so the app can filter on
// it. This is deliberately conservative: a title matches a tag only if it
// contains one of the tag's keywords. Bilingual (FR/EN) keyword lists.
// Known limitation: keyword matching catches maybe ~60-70% of cases and
// will miss articles phrased unusually — good enough for coarse filtering,
// not surgical. More tags can be added later by extending TAG_RULES.
const TAG_RULES = [
  {
    tag: 'patch',
    keywords: [
      'patch', 'hotfix', 'mise à jour', 'mise a jour', 'màj',
      'correctif', 'nerf', 'buff', 'rééquilibrage', 'équilibrage',
      'patch notes', 'notes de version', 'season pass', 'battle pass',
      'new season', 'nouvelle saison',
    ],
  },
  {
    tag: 'sortie',
    keywords: [
      'date de sortie', 'release date', 'now available', 'out now',
      'available now', 'est disponible', 'sort le', 'arrive le',
      'day one', 'launches on', 'released on', 'disponible sur',
      'lancement du jeu', 'release window', 'sortie de',
    ],
  },
];

function detectTags(title, summary) {
  const haystack = `${title} ${summary || ''}`.toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw))) {
      tags.push(rule.tag);
    }
  }
  return tags;
}

// Builds a clean ~2-line plain-text summary from the feed's description or
// summary field. Feeds embed HTML, images, "read more" links, and encoded
// entities in there, so we strip all of it and truncate on a word
// boundary. Quality varies by source (that's the known trade-off of the
// free approach), so if nothing usable remains we return an empty string
// and the site simply shows no summary for that item.
const SUMMARY_MAX = 180;

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&#039;|&#39;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&#8230;|&hellip;/g, '…')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function extractSummary(item) {
  let raw = textOf(item.description) || textOf(item.summary) || '';
  if (!raw && item['content:encoded']) raw = textOf(item['content:encoded']);
  if (!raw) return '';

  let text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');        // strip all remaining tags
  text = decodeEntities(text);
  text = text.replace(/\s+/g, ' ').trim();

  // Drop common trailing boilerplate like "Read more", "Lire la suite", "[…]"
  text = text.replace(/(read more|lire la suite|continue reading|the post .* appeared first.*)$/i, '').trim();

  if (!text) return '';

  if (text.length > SUMMARY_MAX) {
    text = text.slice(0, SUMMARY_MAX);
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace > 60) text = text.slice(0, lastSpace);
    text = text.replace(/[\s.,;:–—-]+$/, '') + '…';
  }
  return text;
}

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DispatchBot/1.0; +https://github.com/)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const data = parser.parse(xml);

  let items = [];
  if (data.rss?.channel?.item) {
    items = Array.isArray(data.rss.channel.item) ? data.rss.channel.item : [data.rss.channel.item];
  } else if (data.feed?.entry) {
    items = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
  }

  return items
    .map((item) => {
      const title = textOf(item.title).trim();
      let link = item.link;
      if (typeof link === 'object') link = link['@_href'] || link['#text'] || '';
      link = String(link || '').trim();
      const dateStr = item.pubDate || item.updated || item.published || '';
      const date = dateStr ? new Date(dateStr) : new Date();
      const summary = extractSummary(item);
      return {
        title,
        link,
        date: isNaN(date) ? new Date().toISOString() : date.toISOString(),
        sourceId: source.id,
        image: extractImage(item),
        summary,
        tags: detectTags(title, summary),
      };
    })
    .filter((a) => a.title && a.link);
}

async function main() {
  const sourceStatus = {};
  let allArticles = [];

  for (const source of SOURCES) {
    try {
      const items = await fetchFeed(source);
      allArticles.push(...items);
      sourceStatus[source.id] = 'ok';
      console.log(`✓ ${source.id}: ${items.length} articles`);
    } catch (e) {
      sourceStatus[source.id] = 'fail';
      console.error(`✗ ${source.id}: ${e.message}`);
    }
  }

  // 1 day: the user's reading model is "if I didn't read it today, it no
  // longer interests me". Favorites are unaffected — they live as full
  // snapshots in dispatch-state.json, independent of this file.
  const RETENTION_DAYS = 1;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const seen = new Set();
  const beforeCount = allArticles.length;
  allArticles = allArticles
    .filter((a) => (seen.has(a.link) ? false : (seen.add(a.link), true)))
    .filter((a) => new Date(a.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 1000); // safety cap in case a feed misbehaves; retention above is the real limit

  console.log(`Pruned to last ${RETENTION_DAYS} days: ${beforeCount} → ${allArticles.length} articles`);

  const output = {
    generatedAt: new Date().toISOString(),
    sourceStatus,
    articles: allArticles,
  };

  writeFileSync('articles.json', JSON.stringify(output, null, 2));
  console.log(`\nWrote ${allArticles.length} articles to articles.json`);

  // --- Server-side purge of dispatch-state.json -------------------------
  // read[] and hidden[] only store links and grow forever. Here we trim
  // them to just the links still present in the freshly-built feed, so the
  // state file stays small even if the app is never opened. Favorites are
  // NEVER touched (independent snapshots). We only rewrite the file if it
  // exists and something actually changed, to avoid empty commits.
  try {
    if (existsSync('dispatch-state.json')) {
      const state = JSON.parse(readFileSync('dispatch-state.json', 'utf8'));
      const liveLinks = new Set(allArticles.map((a) => a.link));

      const beforeRead = Array.isArray(state.read) ? state.read.length : 0;
      const beforeHidden = Array.isArray(state.hidden) ? state.hidden.length : 0;

      state.read = (state.read || []).filter((link) => liveLinks.has(link));
      state.hidden = (state.hidden || []).filter((link) => liveLinks.has(link));
      // state.favorites intentionally left as-is

      const changed = state.read.length !== beforeRead || state.hidden.length !== beforeHidden;
      if (changed) {
        writeFileSync('dispatch-state.json', JSON.stringify(state, null, 2));
        console.log(`State purge: read ${beforeRead}→${state.read.length}, hidden ${beforeHidden}→${state.hidden.length} (favorites kept: ${(state.favorites || []).length})`);
      } else {
        console.log('State purge: nothing to remove.');
      }
    } else {
      console.log('dispatch-state.json not found — skipping state purge.');
    }
  } catch (e) {
    // Never let a state-purge problem fail the whole run; articles.json is
    // the critical output and it's already written.
    console.error('State purge skipped due to error:', e.message);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
