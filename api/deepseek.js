// Vercel Serverless Function: POST /api/deepseek
// Configure DEEPSEEK_API_KEY in Vercel Project Settings -> Environment Variables.

const PREFERENCES = new Set(["人文历史", "自然秘境", "全都要"]);

function normalizeReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid report object.");
  }
  const requiredString = (item, name, limit = 500) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`Missing ${name}.`);
    return item.trim().slice(0, limit);
  };
  const tags = Array.isArray(value.tags)
    ? value.tags.map(item => requiredString(item, "tags", 40)).slice(0, 4)
    : [requiredString(value.tags, "tags", 120)];
  if (!tags.length) throw new Error("Missing tags.");

  const match = value.preferenceMatch;
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    throw new Error("Missing preferenceMatch.");
  }
  const level = requiredString(match.level, "preferenceMatch.level", 10);
  if (!["高", "中", "低"].includes(level)) throw new Error("Invalid match level.");

  if (!Array.isArray(value.alternativeSpots)) throw new Error("Invalid alternativeSpots.");
  const alternativeSpots = value.alternativeSpots.slice(0, 3).map(spot => {
    if (!spot || typeof spot !== "object" || Array.isArray(spot)) {
      throw new Error("Invalid alternative spot.");
    }
    return {
      name: requiredString(spot.name, "alternativeSpots.name", 120),
      distance: requiredString(spot.distance, "alternativeSpots.distance", 80),
      reason: requiredString(spot.reason, "alternativeSpots.reason", 250)
    };
  });
  if (level === "低" && alternativeSpots.length === 0) {
    throw new Error("Low match requires an alternative spot or local experience.");
  }

  const budget = value.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error("Missing budget.");
  }
  const seasonal = value.seasonalBonus;
  if (!seasonal || typeof seasonal !== "object" || Array.isArray(seasonal)) {
    throw new Error("Missing seasonalBonus.");
  }
  const rawScore = Number(value.totalScore);
  if (!Number.isFinite(rawScore)) throw new Error("Invalid totalScore.");

  return {
    destination: requiredString(value.destination, "destination", 120),
    tags,
    preferenceMatch: {
      level,
      reason: requiredString(match.reason, "preferenceMatch.reason", 300)
    },
    alternativeSpots,
    recommendedPlay: typeof value.recommendedPlay === "string" ? value.recommendedPlay.trim().slice(0, 300) : "",
    budget: {
      transport: requiredString(budget.transport, "budget.transport", 120),
      hotel: requiredString(budget.hotel, "budget.hotel", 120),
      food: requiredString(budget.food, "budget.food", 120),
      totalRange: requiredString(budget.totalRange, "budget.totalRange", 120)
    },
    seasonalBonus: {
      season: requiredString(seasonal.season, "seasonalBonus.season", 80),
      bonus: requiredString(seasonal.bonus, "seasonalBonus.bonus", 100),
      reason: requiredString(seasonal.reason, "seasonalBonus.reason", 250)
    },
    totalScore: Math.round(Math.min(10, Math.max(1, rawScore)) * 10) / 10,
    summary: requiredString(value.summary, "summary", 30)
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing DEEPSEEK_API_KEY." });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const structured = body.mode === "travel_report" || typeof body.location === "string";
  let userMessage;
  let systemMessage;

  if (structured) {
    const location = typeof body.location === "string" ? body.location.trim() : "";
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 500) : "";
    const preference = body.preference;
    const currentMonth = Number(body.currentMonth);
    if (!location || location.length > 300) {
      return res.status(400).json({ error: "A location of 1-300 characters is required." });
    }
    if (!PREFERENCES.has(preference)) {
      return res.status(400).json({ error: "Preference must be 人文历史, 自然秘境, or 全都要." });
    }
    if (!Number.isInteger(currentMonth) || currentMonth < 1 || currentMonth > 12) {
      return res.status(400).json({ error: "currentMonth must be an integer from 1 to 12." });
    }

    systemMessage = [
      "你是一位资深欧洲旅行专家。只返回纯 JSON 对象,不要 Markdown 代码块、解释或前后缀。",
      "JSON 必须包含 destination(string), tags(string array), preferenceMatch({level,reason}), alternativeSpots(array of {name,distance,reason}), budget({transport,hotel,food,totalRange}), seasonalBonus({season,bonus,reason}), totalScore(number), summary(string)。",
      "额外包含 recommendedPlay(string),以便展示主要推荐玩法。preferenceMatch.level 只能是 高、中、低。",
      "如果匹配度低,优先在飞镖落点附近 30-50 公里内寻找符合偏好的隐藏玩法,写入 alternativeSpots,并给出粗略距离; 如果附近确实没有,可以推荐落点本身的特色文化体验,并清楚说明距离为 0 公里。",
      "如果匹配度高,alternativeSpots 可以是空数组。不要编造未经核实的景点或精确距离;不确定时写 距离待核实。",
      "budget 的四个值必须都是字符串,以英镑 £ 为单位,按从英国出发的 3-7 天行程粗估。transport 包含英国往返交通与当地交通,hotel 为住宿,food 为餐饮,totalRange 为大致总花费区间。不要声称价格为实时报价。",
      "seasonalBonus 描述所给月份对应的季节及适宜度加成。totalScore 为 1 到 10 的数字,保留一位小数。summary 为一句 30 字以内的浪漫中文评语。",
      "JSON 示例: {\"destination\":\"目的地\",\"tags\":[\"自然秘境\",\"小众静谧\"],\"preferenceMatch\":{\"level\":\"高\",\"reason\":\"很契合\"},\"alternativeSpots\":[],\"recommendedPlay\":\"慢慢散步\",\"budget\":{\"transport\":\"£100-200\",\"hotel\":\"£200-400\",\"food\":\"£80-150\",\"totalRange\":\"£380-750\"},\"seasonalBonus\":{\"season\":\"秋季\",\"bonus\":\"适合\",\"reason\":\"气温温和\"},\"totalScore\":8.5,\"summary\":\"让风替你写下下一站的情书\"}"
    ].join("\n");
    userMessage = `地名: ${location}${address ? `\n地址提示: ${address}` : ""}\n旅行偏好: ${preference}\n当前月份: ${currentMonth} 月。请按规定 JSON 字段给出分析。`;
  } else {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ error: "A non-empty prompt is required." });
    if (prompt.length > 12000) return res.status(413).json({ error: "Prompt is too long (maximum 12000 characters)." });
    systemMessage = "你是 GeoDarts 的旅行灵感助手。根据用户提供的地点和坐标,用简体中文给出附近游玩建议。不要声称拥有实时搜索能力;不确定时提醒用户核实,不要编造营业时间或精确地址。";
    userMessage = prompt;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage }
        ],
        stream: false,
        ...(structured ? { response_format: { type: "json_object" }, max_tokens: 1800 } : {})
      }),
      signal: controller.signal
    });

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = payload.error?.message || payload.message || `DeepSeek returned HTTP ${upstream.status}`;
      return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({ error: detail });
    }
    if (payload.choices?.[0]?.finish_reason === "length") {
      return res.status(502).json({ error: "DeepSeek response was truncated. Please retry." });
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return res.status(502).json({ error: "DeepSeek returned an empty response." });
    }
    if (!structured) return res.status(200).json({ analysis: content.trim() });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.error("DeepSeek returned invalid JSON:", error);
      return res.status(502).json({ error: "DeepSeek returned invalid JSON." });
    }
    try {
      return res.status(200).json({ report: normalizeReport(parsed) });
    } catch (error) {
      console.error("DeepSeek returned an invalid report:", error);
      return res.status(502).json({ error: "DeepSeek returned an invalid travel report." });
    }
  } catch (error) {
    if (error.name === "AbortError") return res.status(504).json({ error: "DeepSeek request timed out." });
    console.error("DeepSeek API request failed:", error);
    return res.status(502).json({ error: "Could not reach the DeepSeek API." });
  } finally {
    clearTimeout(timeout);
  }
};
