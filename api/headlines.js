// api/headlines.js
import Parser from "rss-parser";
import { DateTime } from "luxon";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

export const config = { runtime: "nodejs" };

const parser = new Parser({ timeout: 20000 });

// Browser-like headers to avoid bot blocking
const UA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "upgrade-insecure-requests": "1"
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

// ---------- helpers
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
  // 1) read bundled file (vercel includeFiles)
  try {
    const p = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(p)) return JSON.parse(await readFile(p, "utf-8"));
  } catch {}
  // 2) fall back to public URL
  const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
  if (r.ok) return await r.json();
  throw new Error("Could not load sources.json.");
}

// ----- ReliefWeb via official API
async function fetchReliefWeb(perSource, zone) {
  const url = `https://api.reliefweb.int/v1/reports?appname=news-dashboard&profile=simple&sort[]=date:desc&limit=${perSource}`;
  const resp = await fetch(url, { headers: { ...UA_HEADERS, accept: "application/json" }, cache: "no-store" });
  if (!resp.ok) throw new Error(`ReliefWeb API HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.data || []).map(d => {
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
}

// ----- DonorTracker (Cheerio) — returns originalUrl when available
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
      const $ = cheerio.load(html);

      const out = [];
      $(".views-row, article, .card").each((_, el) => {
        if (out.length >= perSource) return;
        const $el = $(el);

        // DT internal page
        let internalHref =
          $el.find('a[href^="/policy-"], a[href*="/policy-"]').first().attr("href") || "";
        if (internalHref && !internalHref.startsWith("http")) {
          internalHref = "https://donortracker.org" + internalHref;
        }

        // External/original link (first non-DT link inside the card)
        let extHref = "";
        $el.find("a[href]").each((__, a) => {
          const href = $(a).attr("href") || "";
          const absolute = href.startsWith("http")
            ? href
            : href.startsWith("/")
              ? "https://donortracker.org" + href
              : "";
          if (!absolute) return;
          if (!absolute.includes("donortracker.org")) {
            extHref = absolute;
            return false; // break
          }
        });

        // Title from internal link, else first link
        let title =
          $el.find('a[href^="/policy-"], a[href*="/policy-"]').first().text().trim() ||
          $el.find("a[href]").first().text().trim() || "";
        title = title.replace(/\s+/g, " ").trim();

        const rawDate = $el.find("time[datetime]").first().attr("datetime") || "";
        const dt = parseDate(rawDate, zone);

        const url = internalHref || extHref;
        if (!title || !url) return;

        out.push({
          title,
          url,                                           // main link → DT summary if available
          originalUrl: internalHref && extHref ? extHref : null, // optional secondary link
          source: "Donor Tracker — Policy Updates",
          publishedISO: dt ? dt.toISO() : null,
          _text: `${title} DonorTracker`
        });
      });

      if (out.length) return out;
    } catch {}
  }
  throw new Error("DonorTracker scrape failed");
}

// ----- Generic RSS (Guardian, TNH, etc.)
async function fetchRSS(url, perSource, zone) {
  const candidates = [url];
  try {
    const u = new URL(url);
    if (u.hostname.includes("thenewhumanitarian.org")) {
      candidates.push("https://www.thenewhumanitarian.org/rss.xml");
      candidates.push("https://www.thenewhumanitarian.org/feeds/all.rss");
      candidates.push("https://thenewhumanitarian.org/rss.xml");
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
  throw new Error(`RSS failed for ${url}`);
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

    const results = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const host = new URL(url).hostname;
          if (host.includes("reliefweb.int")) return await fetchReliefWeb(perSource, zone);
          if (host.includes("donortracker.org")) return await fetchDonorTracker(perSource, zone);
          return await fetchRSS(url, perSource, zone);
        } catch (e) {
          return [{
            title: `Failed to fetch: ${url} (${e.message})`,
            url: "",
            source: "error",
            publishedISO: null,
            _text: "error"
          }];
        }
      })
    );

    const flat = results.flat();

    // ---- filtering logic (Option B with 7-day funding window)
    const filtered = flat.filter(it => {
      const text = it._text?.toLowerCase() || "";
      const isFunding = matchAny(text, FUNDING_TRIGGERS);
      const hasRegion = matchAny(text, regionWords);

      const dt = it.publishedISO ? DateTime.fromISO(it.publishedISO).setZone(zone) : null;

      const recent = isWithinDays(dt, maxAgeDays, zone);      // region window
      const fundingRecent = isWithinDays(dt, 7, zone) || !dt; // funding window (7 days; allow undated)

      return (isFunding && fundingRecent) || (hasRegion && recent);
    });

    filtered.sort((a, b) => (b.publishedISO || "").localeCompare(a.publishedISO || ""));

    const out = filtered.map(({ title, url, source, publishedISO, originalUrl }) => ({
      title, url, source, published: publishedISO, originalUrl: originalUrl || undefined
    }));

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    res.status(200).json({ news: out, count: out.length, timezone: zone });
  } catch (err) {
    res.status(200).json({ news: [], count: 0, error: String(err) });
  }
}
