import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "4mb" }));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const PROXY_KEY   = process.env.PROXY_KEY;          // Secret you set in Render — Janitor AI will send this
const VERTEX_KEY  = process.env.VERTEX_API_KEY;     // Your Vertex AI API key
const PROJECT_ID  = process.env.PROJECT_ID  || "gen-lang-client-0201233194";
const REGION      = process.env.REGION      || "global";
const MODEL       = process.env.MODEL       || "zai-org/glm-5-maas";

const VERTEX_URL  = `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/openapi/chat/completions`;

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!PROXY_KEY) return next(); // No key set → open (not recommended for prod)

  const auth   = req.headers["authorization"] || "";
  const apiKey = req.headers["x-api-key"]     || "";
  const token  = auth.startsWith("Bearer ") ? auth.slice(7) : apiKey;

  if (token !== PROXY_KEY) {
    return res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error" } });
  }
  next();
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", model: MODEL }));

// ── Models list (Janitor AI probes this) ─────────────────────────────────────
app.get("/v1/models", requireAuth, (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: MODEL,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "vertex-ai",
      },
    ],
  });
});

// ── Main proxy ────────────────────────────────────────────────────────────────
app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  if (!VERTEX_KEY) {
    return res.status(500).json({ error: { message: "VERTEX_API_KEY not configured on server" } });
  }

  // Pass everything Janitor AI sends through untouched, just force the model
  const payload = {
    ...req.body,
    model: MODEL,
  };

  const stream = req.body.stream ?? false;
  console.log(`[proxy] → Vertex AI | stream=${stream} | messages=${req.body.messages?.length}`);

  let vertexRes;
  try {
    vertexRes = await fetch(VERTEX_URL, {
      method:  "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-goog-api-key": VERTEX_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[proxy] Fetch error:", err.message);
    return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}` } });
  }

  if (!vertexRes.ok) {
    const errText = await vertexRes.text();
    console.error(`[proxy] Vertex error ${vertexRes.status}:`, errText);
    return res.status(vertexRes.status).json({
      error: { message: errText, type: "upstream_error", code: vertexRes.status },
    });
  }

  // ── Streaming ─────────────────────────────────────────────────────────────
  if (stream) {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering on Render

    vertexRes.body.pipe(res);

    vertexRes.body.on("error", (err) => {
      console.error("[proxy] Stream error:", err.message);
      res.end();
    });

    req.on("close", () => vertexRes.body.destroy());
    return;
  }

  // ── Non-streaming ─────────────────────────────────────────────────────────
  const json = await vertexRes.json();
  res.json(json);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GLM-5 proxy listening on port ${PORT}`);
  console.log(`Vertex endpoint: ${VERTEX_URL}`);
  console.log(`Auth guard: ${PROXY_KEY ? "ON" : "OFF (set PROXY_KEY to enable)"}`);
});
