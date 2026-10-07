// Vercel Serverless Function: POST /api/deepseek
// Configure DEEPSEEK_API_KEY in Vercel Project Settings → Environment Variables.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing DEEPSEEK_API_KEY." });
  }

  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    return res.status(400).json({ error: "A non-empty prompt is required." });
  }
  if (prompt.length > 12000) {
    return res.status(413).json({ error: "Prompt is too long (maximum 12000 characters)." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是 GeoDarts 的旅行灵感助手。根据用户提供的地点和坐标，用简体中文给出附近游玩建议。不要声称拥有实时搜索能力；不确定时提醒用户核实，不要编造营业时间或精确地址。"
          },
          { role: "user", content: prompt }
        ],
        stream: false
      }),
      signal: controller.signal
    });

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = payload.error?.message || payload.message || `DeepSeek returned HTTP ${upstream.status}`;
      return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
        .json({ error: detail });
    }

    const analysis = payload.choices?.[0]?.message?.content;
    if (typeof analysis !== "string" || !analysis.trim()) {
      return res.status(502).json({ error: "DeepSeek returned an empty response." });
    }

    return res.status(200).json({ analysis: analysis.trim() });
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "DeepSeek request timed out." });
    }
    console.error("DeepSeek API request failed:", error);
    return res.status(502).json({ error: "Could not reach the DeepSeek API." });
  } finally {
    clearTimeout(timeout);
  }
};
