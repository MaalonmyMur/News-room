export const config = { runtime: "nodejs" };

const BUILD = "headlines v3 — version check";

export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    build: BUILD,
    now: new Date().toISOString()
  });
}
