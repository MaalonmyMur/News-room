import Parser from "rss-parser";
import { DateTime } from "luxon";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export const config = { runtime: "nodejs" };

// Use a single Parser instance
const parser = new Parser({ timeout: 15000 });

// Browser-like headers to avoid basic bot blocks
const UA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
  "accept-encoding": "gzip,deflate,br",
  "accept-language": "en"
};

// ---------- keywords (same as before)
const FUNDING_WORDS = [
  "funding","funds","budget","budgets","aid","oda","official development assistance",
  "appropriation","appropriations","spending","cut","cuts","reduction","reductions",
  "increase","increases","pledge","pledges","grant","grants","donor","donors",
  "funding cut","budget cut","funding increase","budget increase",
  "fcdo","uk aid","usaid","state department","sida","norad","giz","kfw","afd",
  "global affairs canada","irish aid","dfat","dfatd","ausaid","nzaid",
  "jica","koica","adb","afdb","african development bank","isdb","islamic development bank",
  "world bank","ibrd","ida","ifc","imf","undp","wfp","unicef","oecd dac","eib","echo","eu humanitarian",
  "development finance","development assistance","official aid"
];

const DONOR_COUNTRY_TERMS = [
  "united states","usa","u.s.","us ","canada","united kingdom","uk","britain","british",
  "australia","new zealand","ireland",
  "european union","eu","germany","german","france","french","netherlands","dutch",
  "norway","norwegian","sweden","swedish","denmark","danish","finland","finnish",
  "switzerland","swiss","spain","italy","belgium","austria","luxembourg","portugal",
  "japan","japanese","south korea","korea","korean"
];

const FUNDING_TRIGGERS = [...FUNDING_WORDS, ...DONOR_COUNTRY_TERMS];

const DEFAULT_REGION_WORDS = [
  "africa","sub-saharan","sahel","horn of africa","east africa","west africa","central africa","southern africa",
  "south asia","southeast asia","asean",
  "ethiopia","zambia","rwanda","uganda","tanzania","kenya","burundi",
  "democratic republic of congo","drc","nigeria","benin","togo","senegal",
  "ivory coast","cote d'ivoire","mali","niger","south sudan",
  "bangladesh","indonesia","philippines","tibet","vietnam","sahel"
];

// ---------- helpers
const matchAny = (text, list) => {
  const t = (text || "").toLowerCase();
  return list.some(k => t.includes(k));
};

const parseDate = (s, zone) => {
  if (!s) return null;
  const a = DateTime.fromISO(s, { zone });           if (a.isValid) return a;
  const b = DateTime.fromRFC2822(s, { zone });       if (b.isValid) return b;
  const c = DateTime.fromJSDate(new Date(s), { zone }); return c.isValid ? c : null;
  return null;
};

const isWithinDays = (dt, days, zone) => {
  if (!dt) return false;
  const cutoff = DateTime.now().setZone(zone).minus({ days });
  return dt >= cutoff;
};

function siteBase(req) {
  const host = process.env.VERCEL_URL || req.headers.host;
  return `https://${host}`;
}

async function loadConfig(req) {
  // 1) bundled file (via includeFiles)
  try {
    const p = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(p)) {
      const txt = await readFile(p, "utf-8");
      return JSON.parse(txt);
    }
  } catch (_) {}
  // 2) site public URL (works if previews are public)
  try {
    const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch (_) {}
  throw new Error("Could not load sources.json.");
}

// ---- hardened feed fetch with fallbacks
async function fetchFeedWithFallbacks(url) {
  // Known alternate paths for tricky sources
  const candidates = [url];

  try {
    const u = new URL(url);
    if (u.hostname.includes("donortracker.org")) {
      // some deployments use hyphen instead of underscore or different path
      candidates.push("https://donortracker.org/policy-updates/rss.xml");
      candidates.push("https://donortracker.org/policy-updates.xml");
    }
    if (u.hostname.includes("thenewhumanitarian.org")) {
      // TNH variants we've seen in the wild
      candidates.push("https://www.thenewhumanitarian.org/feeds/all.rss");
      candidates.push("https://www.thenewhumanitarian.org/rss.xml");
    }
  } catch {
    // ignore URL parse errors; we’ll still try the original
  }

  // Try each candidate with a real UA, then parseString
  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate, { headers: UA_HEADERS, cache: "no-store" });
      if (!resp.ok) continue;
      const text = await resp.text();
      const feed = await parser.parseString(text);
      // attach a title fallback if missing
      feed.title = feed.title || new URL(candidate).host;
      return feed;
    } catch {
      // try next candidate
    }
  }
  // final attempt: rss-parser direct (some servers like this better)
  try {
    return await parser.parseURL(url);
  } catch {
    throw new Error(`Failed to fetch: ${url}`);
  }
}

export default async function handler(req, res) {
  try {
    const cfg = await loadConfig(req);

    const zone = cfg.timezone || "UTC";
    const maxAgeDays = Number(cfg.maxAgeDays ?? 3);

    const regionWords =
      Array.isArray(cfg.regions) && cfg.regions.length > 0
        ? cfg.regions.map(s => s.toLowerCase())
        : DEFAULT_REGION_WORDS;

    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

    const chunks = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const feed = await fetchFeedWithFallbacks(url);
          return (feed.items || []).slice(0, perSource).map(it => {
            const published = parseDate(it.isoDate || it.pubDate || it.published || it.updated, zone);
            return {
              title: it.title || "(no title)",
              url: it.link || it.guid || "",
              source: feed.title || new URL(url).host,
              publishedISO: published ? published.toISO() : null,
              _text: `${it.title || ""} ${feed.title || ""}`
            };
          });
        } catch {
          return [{
            title: `Failed to fetch: ${url}`,
            url: "",
            source: "error",
            publishedISO: null,
            _text: "error"
          }];
        }
      })
    );

    const flat = chunks.flat();

    // ---- filtering logic (Option B with 7-day funding window)
    const filtered = flat.filter(it => {
      const text = it._text.toLowerCase();
      const isFunding = matchAny(text, FUNDING_TRIGGERS);
      const hasRegion = matchAny(text, regionWords);

      const dt = it.publishedISO ? DateTime.fromISO(it.publishedISO).setZone(zone) : null;

      const recent = isWithinDays(dt, maxAgeDays, zone); // region window (e.g., 3 days)
      const fundingRecent = isWithinDays(dt, 7, zone) || !dt; // funding window (7 days, allow no date)

      return (isFunding && fundingRecent) || (hasRegion && recent);
    });

    filtered.sort((a, b) => (b.publishedISO || "").localeCompare(a.publishedISO || ""));

    const out = filtered.map(({ title, url, source, publishedISO }) => ({
      title, url, source, published: publishedISO
    }));

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    res.status(200).json({ news: out, count: out.length, timezone: zone });
  } catch (err) {
    res.status(200).json({ news: [], count: 0, error: String(err) }); // return 200 with error so page doesn't look "broken"
  }
}
