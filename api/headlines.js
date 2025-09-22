// api/headlines.js
import Parser from "rss-parser";
import { DateTime } from "luxon";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";

export const config = { runtime: "nodejs" };

const parser = new Parser({ timeout: 20000 });

// Browser-like headers to reduce bot-blocking
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
  try {
    const p = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(p)) return JSON.parse(await readFile(p, "utf-8"));
  } catch {}
  const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
  if (r.ok) return await r.json();
  throw new Error("Could not load sources.json.");
}

// ----- fetchers return {items, meta}
async function fetchReliefWeb(perSource, zone) {
  const meta = { source: "ReliefWeb Updates", errors: [] };
  const url = `https://api.reliefweb.int/v1/reports?appname=news-dashboard&profile=simple&sort[]=date:desc&limit=${perSource}`;
  const resp = await fetch(url, { headers: { ...UA_HEADERS, accept: "application/json" }, cache: "no-store" });
  if (!resp.ok) {
    meta.errors.push(`HTTP ${resp.status}`);
    return { items: [], meta };
  }
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
  return { items, meta };
}

async function fetchDonorTracker(perSource, zone) {
  const meta = { source: "Donor Tracker — Policy Updates", errors: [] };
  const candidates = [
    "https://donortracker.org/policy_updates",
    "https://donortracker.org/policy-updates"
  ];
  for (const u of candidates) {
    try {
      const htmlRes = await fetch(u, { headers: UA_HEADERS, cache: "no-store" });
      if (!htmlRes.ok) { meta.errors.push(`${u} → HTTP ${htmlRes.status}`); continue; }
      const html = await htmlRes.text();
      const $ = cheerio.load(html);

      const items = [];
      $(".views-row, article, .card").each((_, el) => {
        if (items.length >= perSource) return;
        const $el = $(el);

        // internal DT page
        let internalHref =
          $el.find('a[href^="/policy-"], a[href*="/policy-"]').first().attr("href") || "";
        if (internalHref && !internalHref.startsWith("http")) {
          internalHref = "https://donortracker.org" + internalHref;
        }

        // external/original link
        let extHref = "";
        $el.find("a[href]").each((__, a) => {
          const href = $(a).attr("href") || "";
          const absolute = href.startsWith("http")
            ? href
            : href.startsWith("/")
              ? "https://donortracker.org" + href
              : "";
          if (!absolute) return;
          if (!absolute.includes("donortracker.org")) { extHref = absolute; return false; }
        });

        let title =
          $el.find('a[href^="/policy-"], a[href*="/policy-"]').first().text().trim() ||
          $el.find("a[href]").first().text().trim() || "";
        title = title.replace(/\s+/g, " ").trim();

        const rawDate = $el.find("time[datetime]").first().attr("datetime") || "";
        const dt = parseDate(rawDate, zone);

        const url = internalHref || extHref;
        if (!title || !url) return;

        items.push({
          title,
          url,
          originalUrl: internalHref && extHref ? extHref : null,
          source: "Donor Tracker — Policy Updates",
          publishedISO: dt ? dt.toISO() : null,
          _text: `${title} DonorTracker`
        });
      });

      if (items.length) return { items, meta };
      meta.errors.push(`${u} → no items matched selectors`);
    } catch (e) {
      meta.errors.push(`${u} → ${e.message || e}`);
    }
  }
  return { items: [], meta };
}

async function fetchRSS(url, perSource, zone) {
  const meta = { source: url, errors: [] };
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
      if (!resp.ok) { meta.errors.push(`${c} → HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      const feed = await parser.parseString(text);
      const title = feed.title || new URL(c).host;
      const items = (feed.items || []).slice(0, perSource).map(it => {
        const published = parseDate(it.isoDate || it.pubDate || it.published || it.updated, zone);
        return {
          title: it.title || "(no title)",
          url: it.link || it.guid || "",
          source: title,
          publishedISO: published ? published.toISO() : null,
          _text: `${it.title || ""} ${title}`
        };
      });
      return { items, meta };
    } catch (e) {
      meta.errors.push(`${c} → ${e.message || e}`);
    }
  }
  return { items: [], meta };
}

export default async function handler(req, res) {
  try {
    const cfg = await loadConfig(req);

    const zone = cfg.timezone || "Europe/Amsterdam";
    const maxAgeDays = Number(cfg.maxAgeDays ?? 3);

    const regionWords =
      Array.isArray(cfg.regions) && cfg.regions.length > 0
        ? cfg.regions.map(s => s.toLowerCase())
        : DEFAULT_REGION_WORDS;

    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

    // Fetch per source
    const perSourceResults = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const host = new URL(url).hostname;
          if (host.includes("reliefweb.int")) return await fetchReliefWeb(perSource, zone);
          if (host.includes("donortracker.org")) return await fetchDonorTracker(perSource, zone);
          return await fetchRSS(url, perSource, zone); // Guardian, TNH, etc.
        } catch (e) {
          return { items: [], meta: { source: url, errors: [String(e)] } };
        }
      })
    );

    // Special modes for diagnosis
    const urlObj = new URL(req.url, "https://dummy");
    const mode = urlObj.searchParams.get("mode"); // "raw" | "debug" | null

    if (mode === "raw") {
      // No filters; show items grouped by source with errors/counters
      const payload = perSourceResults.map(r => ({
        source: r.meta?.source || "",
        count: r.items.length,
        errors: r.meta?.errors || [],
        items: r.items.map(({ title, url, source, publishedISO, originalUrl }) => ({
          title, url, source, published: publishedISO, originalUrl: originalUrl || undefined
        }))
      }));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ mode: "raw", fetchedAt: new Date().toISOString(), sources: payload });
    }

    // Flatten for filtering
    const flat = perSourceResults.flatMap(r => r.items);

    // ---- filtering logic (Option B with 7-day funding window)
    const filtered = flat.filter(it => {
      const text = it._text?.toLowerCase() || "";
      const isFunding = matchAny(text, FUNDING_TRIGGERS);
      const hasRegion = matchAny(text, regionWords);
      const dt = it.publishedISO ? DateTime.fromISO(it.publishedISO).setZone(zone) : null;
      const recent = isWithinDays(dt, maxAgeDays, zone);
      const fundingRecent = isWithinDays(dt, 7, zone) || !dt;
      return (isFunding && fundingRecent) || (hasRegion && recent);
    });

    // Sort newest first
    filtered.sort((a, b) => (b.publishedISO || "").localeCompare(a.publishedISO || ""));

    // Output
    const out = filtered.map(({ title, url, source, publishedISO, originalUrl }) => ({
      title, url, source, published: publishedISO, originalUrl: originalUrl || undefined
    }));

    if (mode === "debug") {
      const diag = perSourceResults.map(r => ({
        source: r.meta?.source || "",
        fetched: r.items.length,
        errors: r.meta?.errors || []
      }));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        mode: "debug",
        fetchedAt: new Date().toISOString(),
        timezone: zone,
        perSource: diag,
        news: out,
        count: out.length
      });
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    res.status(200).json({ news: out, count: out.length, timezone: zone });
  } catch (err) {
    res.status(200).json({ news: [], count: 0, error: String(err) });
  }
}
