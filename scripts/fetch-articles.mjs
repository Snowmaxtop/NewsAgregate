// Fetches all Dispatch RSS feeds server-side (inside GitHub Actions) and
// writes the combined, deduplicated result to articles.json in the repo
// root. Because this runs on GitHub's servers rather than in a browser,
// there is no CORS restriction to work around — this is the same kind of
// request curl or a backend server would make.
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync } from 'fs';

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
      return {
        title,
        link,
        date: isNaN(date) ? new Date().toISOString() : date.toISOString(),
        sourceId: source.id,
        image: extractImage(item),
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

  const RETENTION_DAYS = 7;
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
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
