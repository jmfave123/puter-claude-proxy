// api/chat.js
// Vercel Serverless Function (Node.js, ESM).
// Bridges a plain cURL/JSON request (e.g. from "Natively") to OpenRouter's
// free-tier coding models via their OpenAI-compatible chat completions API.
//
// Why OpenRouter instead of Puter: Puter's free-unlimited AI access assumes
// a browser session where the end user authenticates themselves. Calling it
// server-to-server with a personal token uses your own account's paid quota,
// which returned a 402 subscription_required for premium models. OpenRouter
// is designed for exactly this server-side use case and has genuinely free
// (":free" tagged) models, no credit card required.
//
// NOTE: OpenRouter's free model lineup rotates over time (models get
// delisted or repriced). If OPENROUTER_MODEL below starts failing, check
// https://openrouter.ai/models?max_price=0 for current free options and
// swap the constant below.

export const config = {
  api: {
    bodyParser: false,
  },
};

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

// A small, capable free coding model. If this ever gets delisted, swap
// it for another ":free" model from https://openrouter.ai/models?max_price=0
const OPENROUTER_MODEL = "qwen/qwen3-coder:free";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  console.log(`[chat] invoked: ${req.method} ${req.url}`);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    // --- 1. Validate the auth token env var exists ---
    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log(`[chat] OPENROUTER_API_KEY present: ${Boolean(apiKey)}`);
    if (!apiKey) {
      return res.status(500).json({
        error: "Server misconfigured: OPENROUTER_API_KEY environment variable is not set.",
      });
    }

    // --- 2. Read and parse the raw body ourselves ---
    // (Some clients, like Natively substituting a combined system+context+
    // message string into {{TEXT}}, can send JSON with unescaped quotes or
    // newlines. Reading the raw body ourselves lets us handle that gracefully
    // instead of Vercel's auto-parser crashing before our code even runs.)
    const rawBody = await readRawBody(req);
    console.log(`[chat] rawBody length: ${rawBody?.length ?? 0}`);

    if (!rawBody || !rawBody.trim()) {
      return res.status(400).json({ error: "Missing request body." });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (parseErr) {
      console.log(`[chat] JSON.parse FAILED: ${parseErr.message}`);
      const recovered = tryRecoverContent(rawBody);
      if (recovered) {
        body = { content: recovered };
      } else {
        return res.status(400).json({
          error: "Invalid JSON payload.",
          details: parseErr.message,
          hint: "If this request came from an app substituting a template variable (like {{TEXT}}), the substituted text may contain unescaped quotes or newlines that broke the JSON.",
        });
      }
    }

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Missing or invalid JSON body." });
    }

    const { content } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({
        error: "Missing required field: 'content' (non-empty string).",
      });
    }

    console.log(`[chat] extracted content length: ${content.length}`);

    // --- 3. Call OpenRouter's OpenAI-compatible endpoint ---
    console.log(`[chat] calling OpenRouter (${OPENROUTER_MODEL})...`);
    const orRes = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        // Optional but recommended by OpenRouter for attribution/rate-limit tracking:
        "HTTP-Referer": "https://puter-claude-proxy.vercel.app",
        "X-Title": "Natively Proxy",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: "user", content }],
      }),
    });

    console.log(`[chat] OpenRouter status: ${orRes.status}`);
    const data = await orRes.json();

    if (!orRes.ok) {
      return res.status(502).json({
        error: "OpenRouter API returned an error.",
        details: data,
      });
    }

    // --- 4. Extract the reply text (already OpenAI-shaped from OpenRouter) ---
    const aiText = data?.choices?.[0]?.message?.content;

    if (!aiText || typeof aiText !== "string") {
      return res.status(502).json({
        error: "OpenRouter returned an empty or unrecognized response.",
        raw: data,
      });
    }

    // --- 5. Return in an OpenAI-compatible shape ---
    return res.status(200).json({
      choices: [
        {
          message: {
            role: "assistant",
            content: aiText,
          },
        },
      ],
    });
  } catch (err) {
    console.error("Chat proxy error:", err);
    return res.status(500).json({
      error: "Failed to get a response from OpenRouter.",
      details: err?.message || String(err),
    });
  }
}

function tryRecoverContent(rawBody) {
  const match = rawBody.match(/"content"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!match) return null;
  return match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .trim();
}