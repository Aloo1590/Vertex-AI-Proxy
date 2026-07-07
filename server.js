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

// Region-aware host: "global" uses the bare host, any real region needs
// the region-prefixed host (e.g. us-central1-aiplatform.googleapis.com).
const VERTEX_HOST = REGION === "global"
  ? "aiplatform.googleapis.com"
  : `${REGION}-aiplatform.googleapis.com`;

const VERTEX_URL = `https://${VERTEX_HOST}/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/openapi/chat/completions`;

// Default safety settings: relax Gemini's built-in filters as far as Vertex
// allows. Vertex still hard-blocks a few categories regardless of this, but
// it meaningfully cuts down on false-positive blocks during roleplay/NSFW use.
const DEFAULT_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

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

/* ── Helpers ── */
function buildBlockedChunk() {
  return {
    id: "blocked",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    choices: [{
      index: 0,
      delta: { content: "\n\n*[Response blocked by content filter]*" },
      finish_reason: "content_filter",
    }],
  };
}

function buildBlockedNonStreamResponse(model) {
  return {
    id: "blocked",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "*[Response blocked by content filter]*" },
      finish_reason: "content_filter",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
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

    // Inject permissive safety settings if the client didn't already send some.
    if (!body.safety_settings && !body.extra_body?.safety_settings) {
      body.safety_settings = DEFAULT_SAFETY_SETTINGS;
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

      // Keep socket alive for long streams
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);

      res.writeHead(200, {
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let receivedAnyContent = false;

      req.on("close", () => reader.cancel().catch(() => {}));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded) break;

          const chunk = decoder.decode(value, { stream: true });

          // Track whether we've seen any real content or an explicit finish reason.
          if (
            chunk.includes('"content"') ||
            chunk.includes('"finish_reason"') ||
            chunk.includes('"finishReason"')
          ) {
            receivedAnyContent = true;
          }

          res.write(chunk);
          if (typeof res.flush === "function") res.flush();
        }
      } catch (streamErr) {
        if (streamErr.name !== "AbortError") {
          console.error("Stream error:", streamErr.message);
        }
      } finally {
        if (!res.writableEnded) {
          // If Vertex closed the stream without ever sending content
          // (typically a silent safety block), surface that to the client
          // instead of letting it hang forever waiting for more data.
          if (!receivedAnyContent) {
            res.write(`data: ${JSON.stringify(buildBlockedChunk())}\n\n`);
          }
          // Always send the OpenAI-format terminator so clients relying on
          // it (JanitorAI included) know the response is actually done.
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }

      return;
    }

    /* ── Non-stream ── */
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const hasContent = !!data?.choices?.[0]?.message?.content;
    if (!hasContent) {
      return res.status(200).json(buildBlockedNonStreamResponse(body.model));
    }

    res.status(200).json(data);

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
