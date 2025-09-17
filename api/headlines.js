import Parser from "rss-parser";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export const config = { runtime: "nodejs" };
const parser = new Parser({ timeout: 15000 });

const RAW_SOURCES_URL =
  "https://raw.githubusercontent.com/MaalonmyMur/News-room/refs/heads/main/public/sources.json"; 

function siteBase(req) {
  const host = process.env.VERCEL_URL || req.headers.host;
  return `https://${host}`;
}

async function loadConfig(req) {
  try {
    const cfgPath = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(cfgPath)) {
      const txt = await readFile(cfgPath, "utf-8");
      return JSON.parse(txt);
    }
  } catch (_) {}

  if (RAW_SOURCES_URL && RAW_SOURCES_URL.startsWith("http")) {
    try {
      const r = await fetch(RAW_SOURCES_URL, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) {}
  }

  try {
    const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch (_) {}

  throw new Error("Could not load sources.json from disk, GitHub Raw, or site.");
}

export default async function handler(req, res) {
  try {
    const cfg = await loadConfig(req);

    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

    const chunks = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const feed = await parser.parseURL(url);
          return (feed.items || []).slice(0, perSource).map((it) => ({
            title: it.title || "(no title)",
            url: it.link || it.guid || "",
            source: feed.title || new URL(url).host,
            published: it.isoDate || it.pubDate || it.published || null,
          }));
        } catch {
          return [
            {
              title: `Failed to fetch: ${url}`,
              url: "",
              source: "error",
              published: null,
            },
          ];
        }
      })
    );

    const flat = chunks.flat();
    res.status(200).json({ news: flat, count: flat.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
