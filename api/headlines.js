// api/headlines.js
import Parser from "rss-parser";
import { DateTime } from "luxon";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export const config = { runtime: "nodejs" };

const parser = new Parser({ timeout: 15000 });

const UA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  accept:
    "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7, */*;q=0.6",
  "accept-encoding": "gzip,deflate,br",
  "accept-language": "en",
};

// ----- keywords (your rules)
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

// ----- helpers
const matchAny = (text, list) => {
  const t = (text || "").toLowerCase();
  return list.some(k => t.includes(k));
};

const parseDate = (s, zone) => {
  if (!s) return null;
  const a = DateTime.fromISO(s, { zone }); if (a.isValid) return a;
  const b = DateTime.fromRFC2822(s, { zone }); if (b.isValid) return b;
  const c = DateTime.fromJSDate(new Date(s), { zone }); return c.isValid ? c : null;
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
  // 1) bundled file (via vercel.json includeFiles)
  try {
    const p = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(p)) return JSON.parse(await readFile(p, "utf-8"));
  } catch {}
  // 2) site public URL (works if previews are public)
  const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
  if (r.ok) return await r.json();
  throw new Error("Could not load sources.json.");
}

// ----- Source-specific fetchers

// ReliefWeb: use official API (much more reliable than RSS)
async function fetchReliefWeb(perSource, zone) {
  // “updates” = all content; you can add filters later
  const url = "https://api.reliefweb.int/v1/reports?appname=news-dashboard&profile=simple&sort[]=date:desc&limit=" + perSource;
  const resp = await fetch(url, { headers: { "accept": "application/json" }, cache: "no-store" });
  if (!resp.ok) throw new Error(`ReliefWeb API HTTP ${resp.status}`);
  const json = await resp.json();
  const items = (json.data || []).map(d => {
    const t = d?.fields?.title || "(no title)";
    const href = d?.fields?.url || "";
    const published = d?.fields?.date?.created || d?.fields?.date?.original || null;
    const dt = parseDate(published, zone);
    return {
      title: t,
      url: href,
      source: "ReliefWeb Updates",
      publishedISO: dt ? dt.toISO() : null,
      _text: `${t} ReliefWeb`
    };
  });
  return items;
}

// DonorTracker: scrape Policy Updates listing page
async function fetchDonorTracker(perSource, zone) {
  const candidates = [
    "https://donortracker.org/policy_updates",
    "https://donortracker.org/policy-updates"
  ];
  for (const u of candidates) {
    try {
      const htmlRes = await fetch(u, { headers: UA_HEADERS, cache: "no-store" });
      if (!htmlRes.ok) continue;
      const html = await htmlRes.text();

      // Light regex-based extraction (avoids bringing in cheerio):
      const itemRegex = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]{0,200}?(?:<time[^>]+datetime="([^"]+)")?/gi;
      const out = [];
      let m;
      while ((m = itemRegex.exec(html)) && out.length < perSource) {
        const href = m[1].startsWith("http") ? m[1] : `https://donortracker.org${m[1]}`;
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        const rawDate = m[3] || null;
        const dt = parseDate(rawDate, zone);
        if (title && href) {
          out.push({
            title,
            url: href,
            source: "Donor Tracker — Policy Updates",
            publishedISO: dt ? dt.toISO() : null,
            _text: `${title} DonorTracker`
          });
        }
      }
      if (out.length) return out;
    } catch {}
  }
  throw new Error("DonorTracker scrape failed");
}

// Generic RSS (TNH + Guardian + anything else)
async function fetchRSS(url, perSource, zone) {
  // Try a few TNH variants automatically
  const candidates = [url];
  try {
    const u = new URL(url);
    if (u.hostname.includes("thenewhumanitarian.org")) {
      candidates.push("https://www.thenewhumanitarian.org/rss.xml");
      candidates.push("https://www.thenewhumanitarian.org/feeds/all.rss");
    }
  } catch {}

  for (const c of candidates) {
    try {
      const resp = await fetch(c, { headers: UA_HEADERS, cache: "no-store" });
      if (!resp.ok) continue;
      const text = await resp.text();
      const feed = await parser.parseString(text);
      const title = feed.title || new URL(c).host;
      return (feed.items || []).slice(0, perSource).map(it => {
        const published = parseDate(it.isoDate || it.pubDate || it.published || it.updated, zone);
        return {
          title: it.title || "(no title)",
          url: it.link || it.guid || "",
          source: title,
          publishedISO: published ? published.toISO() : null,
          _text: `${it.title || ""} ${title}`
        };
      });
    } catch {}
  }
  // Last resort
  const f = await parser.parseURL(url);
  const title = f.title || new URL(url).host;
  return (f.items || []).slice(0, perSource).map(it => {
    const published = parseDate(it.isoDate || it.pubDate || it.published || it.updated, zone);
    return {
      title: it.title || "(no title)",
      url: it.link || it.guid || "",
      source: title,
      publishedISO: published ? published.toISO() : null,
      _text: `${it.title || ""} ${title}`
    };
  });
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

    // Route per source
    const results = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const host = new URL(url).hostname;
          if (host.includes("reliefweb.int")) return await fetchReliefWeb(perSource, zone);
          if (host.includes("donortracker.org")) return await fetchDonorTracker(perSource, zone);
          // Guardian + TNH + others via RSS:
          return await fetchRSS(url, perSource, zone);
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

    const flat = results.flat();

    // ---- filtering logic (your Option B with 7-day funding window)
    const filtered = flat.filter(it => {
      const text = it._text?.toLowerCase() || "";
      const isFunding = matchAny(text, FUNDING_TRIGGERS);
      const hasRegion = matchAny(text, regionWords);

      const dt = it.publishedISO ? DateTime.fromISO(it.publishedISO).setZone(zone) : null;

      const recent = isWithinDays(dt, maxAgeDays, zone);     // region window (e.g., 3 days)
      const fundingRecent = isWithinDays(dt, 7, zone) || !dt; // funding window (7 days; undated allowed)

      return (isFunding && fundingRecent) || (hasRegion && recent);
    });

    filtered.sort((a, b) => (b.publishedISO || "").localeCompare(a.publishedISO || ""));

    const out = filtered.map(({ title, url, source, publishedISO }) => ({
      title, url, source, published: publishedISO
    }));

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    res.status(200).json({ news: out, count: out.length, timezone: zone });
  } catch (err) {
    // Return 200 + message so your page doesn't look broken
    res.status(200).json({ news: [], count: 0, error: String(err) });
  }
}
