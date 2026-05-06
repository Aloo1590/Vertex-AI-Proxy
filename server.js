const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const VERTEX_API_KEY = process.env.VERTEX_API_KEY;
const PROJECT_ID     = process.env.PROJECT_ID;
const REGION         = process.env.REGION || "global";
const PROXY_KEY      = process.env.PROXY_KEY;

const VERTEX_URL = `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/openapi/chat/completions`;

if (!VERTEX_API_KEY) console.warn("⚠️  VERTEX_API_KEY not set");
if (!PROJECT_ID)     console.warn("⚠️  PROJECT_ID not set");

/* ── Process-level safety net ── */
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException",  (err)    => console.error("Uncaught exception:", err));

/* ── Auth ── */
function requireAuth(req, res, next) {
  if (!PROXY_KEY) return next();
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "";
  if (token !== PROXY_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/* ── Routes ── */
app.get("/health",    (_, res) => res.json({ ok: true }));
app.get("/",          (_, res) => res.json({ ok: true }));
app.get("/v1/models", requireAuth, (_, res) => res.json({ object: "list", data: [] }));

/* ── Main ── */
app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  try {
    if (!VERTEX_API_KEY) return res.status(401).json({ error: "Missing VERTEX_API_KEY" });
    if (!PROJECT_ID)     return res.status(401).json({ error: "Missing PROJECT_ID" });

    const body = req.body;
    if (!body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: "messages required" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    const response = await fetch(VERTEX_URL, {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-goog-api-key": VERTEX_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    /* ── Stream ── */
    if (body.stream) {
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.status(response.status).json(err);
      }

      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }

      res.end();
      return;
    }

    /* ── Non-stream ── */
    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "timeout" });
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/* ── Fallback ── */
app.all("*", (_, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, "0.0.0.0", () => console.log(`Proxy running on ${PORT}`));
