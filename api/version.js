export const config = { runtime: "nodejs" };
const BUILD = "headlines v3 — 2025-09-18 14:45 CET"; // change this string on each edit
export default function handler(req, res) {
  res.status(200).json({ ok: true, build: BUILD, now: new Date().toISOString() });
}
