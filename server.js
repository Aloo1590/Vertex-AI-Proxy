import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT       = process.env.PORT;
const PROXY_KEY  = process.env.PROXY_KEY;
const VERTEX_KEY = process.env.VERTEX_API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const REGION     = process.env.REGION || "global";

const VERTEX_URL = `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/openapi/chat/completions`;

function requireAuth(req, res, next) {
  if (!PROXY_KEY) return next();
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "";
  if (token !== PROXY_KEY) {
    return res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error" } });
  }
  next();
}

app.get("/", (_req, res) => res.json({ status: "ok" }));

app.get("/v1/models", requireAuth, (_req, res) => {
  res.json({ object: "list", data: [] });
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  if (!VERTEX_KEY) return res.status(500).json({ error: { message: "VERTEX_API_KEY not set" } });
  if (!PROJECT_ID) return res.status(500).json({ error: { message: "PROJECT_ID not set" } });

  const stream = req.body.stream ?? false;
  console.log(`[proxy] stream=${stream} model=${req.body.model} messages=${req.body.messages?.length}`);

  let vertexRes;
  try {
    vertexRes = await fetch(VERTEX_URL, {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-goog-api-key": VERTEX_KEY,
      },
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    console.error("[proxy] fetch error:", err.message);
    return res.status(502).json({ error: { message: `Upstream fetch failed: ${err.message}` } });
  }

  if (!vertexRes.ok) {
    const errText = await vertexRes.text();
    console.error(`[proxy] vertex error ${vertexRes.status}:`, errText);
    return res.status(vertexRes.status).json({
      error: { message: errText, type: "upstream_error", code: vertexRes.status },
    });
  }

  if (stream) {
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    vertexRes.body.pipe(res);
    vertexRes.body.on("error", (err) => { console.error("[proxy] stream error:", err.message); res.end(); });
    req.on("close", () => vertexRes.body.destroy());
    return;
  }

  const json = await vertexRes.json();
  res.json(json);
});

app.listen(PORT || 3000, () => console.log(`Proxy live on port ${PORT || 3000}`));
