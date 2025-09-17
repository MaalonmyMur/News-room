import Parser from "rss-parser";
import { DateTime } from "luxon";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export const config = { runtime: "nodejs" };
const parser = new Parser({ timeout: 15000 });

/**
 * Optional fallback: set to your GitHub Raw URL for /public/sources.json
 * e.g. "https://raw.githubusercontent.com/<USER>/<REPO>/<BRANCH>/public/sources.json"
 * Leave as "" to skip this fallback.
 */
const RAW_SOURCES_URL = "";

// ---------- keywords
// Funding & donor triggers (included up to 7 days even without region match)
const FUNDING_WORDS = [
  // generic finance terms
  "funding","funds","budget","budgets","aid","oda","official development assistance",
  "appropriation","appropriations","spending","cut","cuts","reduction","reductions",
  "increase","increases","pledge","pledges","grant","grants","donor","donors",
  "funding cut","budget cut","funding increase","budget increase",

  // donor agencies / acronyms
  "fcdo","uk aid","usaid","state department","sida","norad","giz","kfw","afd",
  "global affairs canada","irish aid","dfat","dfatd","ausaid","nzaid",
  "jica","koica","adb","afdb","african development bank","isdb","islamic development bank",
  "world bank","ibrd","ida","ifc","imf","undp","wfp","unicef","oecd dac","eib","echo","eu humanitarian",
  "development finance","development assistance","official aid"
];

// Donor-country names (to catch donor-side policy/funding headlines)
const DONOR_COUNTRY_TERMS = [
  // Anglosphere
  "united states","usa","u.s.","us ", "canada","united kingdom","uk","britain","british",
  "australia","new zealand","ireland",
  // Europe (major DAC donors)
  "european union","eu","germany","german","france","french","netherlands","dutch",
  "norway","norwegian","sweden","swedish","denmark","danish","finland","finnish",
  "switzerland","swiss","spain","italy","belgium","austria","luxembourg","portugal",
  // Asia & others (DAC)
  "japan","japanese","south korea","korea","korean"
];

// Merge funding keywords + donor countries
const FUNDING_TRIGGERS = [...FUNDING_WORDS, ...DONOR_COUNTRY_TERMS];

// Built-in regional keywords (used only if you don’t set `regions` in sources.json)
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
  // 1) Try bundled file (vercel.json includeFiles -> public/sources.json)
  try {
    const p = path.join(process.cwd(), "public", "sources.json");
    if (fs.existsSync(p)) {
      const txt = await readFile(p, "utf-8");
      return JSON.parse(txt);
    }
  } catch (_) {}

  // 2) Try GitHub Raw fallback (optional)
  if (RAW_SOURCES_URL) {
    try {
      const r = await fetch(RAW_SOURCES_URL, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) {}
  }

  // 3) Try site public URL (can fail on protected previews)
  try {
    const r = await fetch(`${siteBase(req)}/sources.json`, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch (_) {}

  throw new Error("Could not load sources.json from disk, GitHub Raw, or site.");
}

// ---------- handler
export default async function handler(req, res) {
  try {
    const cfg = await loadConfig(req);

    const zone = cfg.timezone || "UTC";
    const maxAgeDays = Number(cfg.maxAgeDays ?? 3);

    // Use your custom regions if present in public/sources.json, otherwise defaults
    const regionWords =
      Array.isArray(cfg.regions) && cfg.regions.length > 0
        ? cfg.regions.map(s => s.toLowerCase())
        : DEFAULT_REGION_WORDS;

    const perSource = Number((cfg.news && cfg.news.perSource) ?? 10);
    const sources = (cfg.news && cfg.news.sources) || [];

    // Pull items from all RSS sources
    const chunks = await Promise.all(
      sources.map(async (entry) => {
        const url = typeof entry === "string" ? entry : entry.url;
        try {
          const feed = await parser.parseURL(url);
          return (feed.items || []).slice(0, perSource).map(it => {
            const published = parseDate(it.isoDate || it.pubDate || it.published || it.updated, zone);
            return {
              title: it.title || "(no title)",
              url: it.link || it.guid || "",
              source: feed.title || new URL(url).host,
              publishedISO: published ? published.toISO() : null,
              _text: `${it.title || ""} ${feed.title || ""}` // for matching
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

    // ----- FILTERING LOGIC -----
    // Funding items: always include up to 7 days old (ignores region).
    // Region items: include if within maxAgeDays AND match region keywords.
    const filtered = flat.filter(it => {
      const text = it._text.toLowerCase();
      const isFunding = matchAny(text, FUNDING_TRIGGERS);
      const hasRegion = matchAny(text, regionWords);

      const dt = it.publishedISO ? DateTime.fromISO(it.publishedISO).setZone(zone) : null;
      const recent = isWithinDays(dt, maxAgeDays, zone);
      const fundingRecent = isWithinDays(dt, 7, zone) || !dt; // if no date, keep funding; change to '&& dt' if you require dates

      return (isFunding && fundingRecent) || (hasRegion && recent);
    });

    // Sort newest first
    filtered.sort((a, b) => (b.publishedISO || "").localeCompare(a.publishedISO || ""));

    // Map to output shape
    const out = filtered.map(({ title, url, source, publishedISO }) => ({
      title, url, source, published: publishedISO
    }));

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=300");
    res.status(200).json({ news: out, count: out.length, timezone: zone });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
