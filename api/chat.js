import { init } from "@heyputer/puter.js/src/init.cjs";

const PUTER_MODEL = "claude-3-5-sonnet";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const authToken = process.env.PUTER_AUTH_TOKEN;
    if (!authToken) {
      return res.status(500).json({
        error: "Server misconfigured: PUTER_AUTH_TOKEN environment variable is not set.",
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "Invalid JSON payload." });
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

    const puter = init(authToken);

    const puterResponse = await puter.ai.chat(content, {
      model: PUTER_MODEL,
    });

    const aiText = extractText(puterResponse);

    if (!aiText) {
      return res.status(502).json({
        error: "Puter returned an empty or unrecognized response.",
        raw: puterResponse,
      });
    }

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

function extractText(puterResponse) {
  const message = puterResponse?.message;
  if (!message) return null;

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  return null;
}