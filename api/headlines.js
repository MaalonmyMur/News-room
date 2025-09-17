import Parser from "rss-parser";

export const config = { runtime: "nodejs" };
const parser = new Parser({ timeout: 15000 });

function baseUrl(req) {
  const host = process.env.VERCEL_URL || req.headers.host;      // works locally & on Vercel
  return `https://${host}`;
}

export default async function handler(req, res) {
  try {
    // 1) Load config from PUBLIC file to avoid bundling/path issues
    const cfgUrl = `${baseUrl(req)}/sources.json`;
    const cfgRes = await fetch(cfgUrl, { cache: "no-store" });
    if (!cfgRes.ok) throw new Error(`Failed to load ${cfgUrl}: HTTP ${cfgRes.status}`);
    const cfg = await cfgRes.json();

    // 2) Read sources
    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

    // 3) Fetch all RSS feeds (no filters)
    const chunks = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const feed = await parser.parseURL(url);
          return (feed.items || []).slice(0, perSource).map(it => ({
            title: it.title || "(no title)",
            url: it.link || it.guid || "",
            source: feed.title || new URL(url).host,
            published: it.isoDate || it.pubDate || it.published || null
          }));
        } catch (e) {
          return [{ title: `Failed to fetch: ${url}`, url: "", source: "error", published: null }];
        }
      })
    );

    const flat = chunks.flat();

    // 4) Return as-is
    res.status(200).json({ news: flat, count: flat.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
