const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;

const VERTEX_API_KEY = process.env.VERTEX_API_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const REGION = process.env.REGION || "global";
const PROXY_KEY = process.env.PROXY_KEY;

const VERTEX_URL =
  `https://aiplatform.googleapis.com/v1beta1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/openapi/chat/completions`;

if (!VERTEX_API_KEY) {
  console.warn("Missing VERTEX_API_KEY");
}

if (!PROJECT_ID) {
  console.warn("Missing PROJECT_ID");
}

/* -------------------------------------------------- */
/* Express                                            */
/* -------------------------------------------------- */

app.use(cors());

app.use(express.json({
  limit: "20mb"
}));

app.set("trust proxy", true);

/* -------------------------------------------------- */
/* Process safety                                     */
/* -------------------------------------------------- */

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

/* -------------------------------------------------- */
/* Auth                                               */
/* -------------------------------------------------- */

function requireAuth(req, res, next) {
  if (!PROXY_KEY) {
    return next();
  }

  const auth = req.headers.authorization || "";

  let token = "";

  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7);
  } else if (req.headers["x-api-key"]) {
    token = req.headers["x-api-key"];
  }

  if (token !== PROXY_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* -------------------------------------------------- */
/* Routes                                             */
/* -------------------------------------------------- */

app.get("/", (_, res) => {
  res.json({
    ok: true
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true
  });
});

app.get("/v1/models", requireAuth, (_, res) => {
  res.json({
    object: "list",
    data: []
  });
});

/* -------------------------------------------------- */
/* Helpers                                            */
/* -------------------------------------------------- */

function createTimeout(ms) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, ms);

  return {
    controller,
    clear: () => clearTimeout(timeout)
  };
}

/* -------------------------------------------------- */
/* Main                                               */
/* -------------------------------------------------- */

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  let upstreamResponse = null;
  let reader = null;

  try {
    if (!VERTEX_API_KEY) {
      return res.status(500).json({
        error: "Missing VERTEX_API_KEY"
      });
    }

    if (!PROJECT_ID) {
      return res.status(500).json({
        error: "Missing PROJECT_ID"
      });
    }

    const body = req.body;

    if (!body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: "messages array required"
      });
    }

    const { controller, clear } = createTimeout(180000);

    upstreamResponse = await fetch(VERTEX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": VERTEX_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clear();

    /* -------------------------------------------------- */
    /* Error handling                                     */
    /* -------------------------------------------------- */

    if (!upstreamResponse.ok) {
      const text = await upstreamResponse.text();

      return res.status(upstreamResponse.status).send(text);
    }

    /* -------------------------------------------------- */
    /* Non-stream                                         */
    /* -------------------------------------------------- */

    if (!body.stream) {
      const data = await upstreamResponse.json();

      return res.status(200).json(data);
    }

    /* -------------------------------------------------- */
    /* Stream setup                                       */
    /* -------------------------------------------------- */

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });

    if (res.flushHeaders) {
      res.flushHeaders();
    }

    reader = upstreamResponse.body.getReader();

    const decoder = new TextDecoder();

    let closed = false;

    /* -------------------------------------------------- */
    /* Heartbeat                                          */
    /* -------------------------------------------------- */

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": ping\n\n");
      }
    }, 15000);

    /* -------------------------------------------------- */
    /* Stall watchdog                                     */
    /* -------------------------------------------------- */

    let watchdog = null;

    function resetWatchdog() {
      clearTimeout(watchdog);

      watchdog = setTimeout(async () => {
        console.error("Stream stalled");

        closed = true;

        try {
          await reader.cancel();
        } catch {}

        if (!res.writableEnded) {
          res.write(`data: {"error":"stream timeout"}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
        }
      }, 45000);
    }

    resetWatchdog();

    /* -------------------------------------------------- */
    /* Client disconnect                                  */
    /* -------------------------------------------------- */

    req.on("close", async () => {
      closed = true;

      clearInterval(heartbeat);
      clearTimeout(watchdog);

      try {
        await reader.cancel();
      } catch {}
    });

    /* -------------------------------------------------- */
    /* Stream loop                                        */
    /* -------------------------------------------------- */

    try {
      while (!closed) {
        const { done, value } = await reader.read();

        resetWatchdog();

        if (done) {
          break;
        }

        if (!value) {
          continue;
        }

        const chunk = decoder.decode(value, {
          stream: true
        });

        if (!chunk) {
          continue;
        }

        res.write(chunk);
      }
    } catch (err) {
      console.error("Streaming error:", err);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(watchdog);

      try {
        await reader.cancel();
      } catch {}

      if (!res.writableEnded) {
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    }

  } catch (err) {
    console.error(err);

    if (err.name === "AbortError") {
      return res.status(504).json({
        error: "Upstream timeout"
      });
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: err.message || "Internal server error"
      });
    }

    try {
      res.end();
    } catch {}
  }
});

/* -------------------------------------------------- */
/* 404                                                */
/* -------------------------------------------------- */

app.all("*", (_, res) => {
  res.status(404).json({
    error: "Not found"
  });
});

/* -------------------------------------------------- */
/* Server                                             */
/* -------------------------------------------------- */

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
