// api/chat.js
// Vercel Serverless Function (Node.js, ESM).
// Bridges a plain cURL/JSON request (e.g. from "Natively") to Puter's
// OpenAI-compatible REST API, which routes to Claude Sonnet 5, and returns
// an OpenAI-shaped response.
//
// IMPORTANT: We disable Vercel's automatic JSON body parsing below.
// Some clients (like Natively, which substitutes a combined
// system+context+message string into {{TEXT}}) can send JSON with
// unescaped quotes/newlines. Vercel's built-in parser throws on malformed
// JSON *before* our handler code runs, which crashes the function with no
// logs and no chance for our try/catch to respond gracefully. Reading and
// parsing the raw body ourselves lets us catch that and return a clean
// 400 instead of an opaque 502.

export const config = {
  api: {
    bodyParser: false,
  },
};

const PUTER_CHAT_URL = "https://api.puter.com/puterai/openai/v1/chat/completions";
const PUTER_MODEL = "claude-sonnet-5";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    // --- 1. Validate the auth token env var exists ---
    const authToken = process.env.PUTER_AUTH_TOKEN;
    if (!authToken) {
      return res.status(500).json({
        error: "Server misconfigured: PUTER_AUTH_TOKEN environment variable is not set.",
      });
    }

    // --- 2. Read and parse the raw body ourselves ---
    const rawBody = await readRawBody(req);

    if (!rawBody || !rawBody.trim()) {
      return res.status(400).json({ error: "Missing request body." });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (parseErr) {
      // Malformed JSON, most likely from unescaped quotes/newlines in the
      // substituted {{TEXT}} value. Try a best-effort recovery: extract
      // whatever is between "content": "..." even if it has stray quotes.
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

    // --- 3. Call Puter's OpenAI-compatible endpoint (routes to Claude Sonnet 5) ---
    const puterRes = await fetch(PUTER_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        model: PUTER_MODEL,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await puterRes.json();

    if (!puterRes.ok) {
      return res.status(502).json({
        error: "Puter API returned an error.",
        details: data,
      });
    }

    // --- 4. Extract the reply text (already OpenAI-shaped from Puter) ---
    const aiText = data?.choices?.[0]?.message?.content;

    if (!aiText || typeof aiText !== "string") {
      return res.status(502).json({
        error: "Puter returned an empty or unrecognized response.",
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
    console.error("Puter chat proxy error:", err);
    return res.status(500).json({
      error: "Failed to get a response from Puter/Claude.",
      details: err?.message || String(err),
    });
  }
}

// Best-effort fallback: if strict JSON.parse fails, try to pull out the
// value of "content" even if it contains unescaped inner quotes/newlines.
// Works for the common shape: {"content": "....anything....."}
function tryRecoverContent(rawBody) {
  const match = rawBody.match(/"content"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
  if (!match) return null;
  // Un-escape the outer-most JSON string escapes we can safely assume
  // (\n, \t, \\) without over-processing inner stray quotes.
  return match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .trim();
}