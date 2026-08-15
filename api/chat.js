const PUTER_CHAT_URL = "https://api.puter.com/puterai/openai/v1/chat/completions";
const PUTER_MODEL = "claude-sonnet-5";

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

    const aiText = data?.choices?.[0]?.message?.content;

    if (!aiText || typeof aiText !== "string") {
      return res.status(502).json({
        error: "Puter returned an empty or unrecognized response.",
        raw: data,
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