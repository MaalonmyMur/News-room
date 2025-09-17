import Parser from "rss-parser";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const config = { runtime: "nodejs" };
const parser = new Parser({ timeout: 15000 });

export default async function handler(req, res) {
  try {
    // Read config from the deployed bundle (bundled via includeFiles)
    const cfgPath = path.join(process.cwd(), "public", "sources.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf-8"));

    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

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
    res.status(200).json({ news: flat, count: flat.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
