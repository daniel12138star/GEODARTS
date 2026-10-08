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
  const flightPrice = requiredString(value.flightEstimate?.priceRange, "flightEstimate.priceRange", 100);
  if (!/^£\s*\d[\d,.]*\s*-\s*£\s*\d[\d,.]*$/.test(flightPrice)) {
    throw new Error("Invalid flightEstimate.priceRange.");
  }

  return {
    destination: requiredString(value.destination, "destination", 120),
    destination_zh: typeof value.destination_zh === "string" ? value.destination_zh.trim().slice(0, 120) : "",
    destination_en: typeof value.destination_en === "string" ? value.destination_en.trim().slice(0, 120) : "",
    flightEstimate: {
      airportCode: typeof value.flightEstimate?.airportCode === "string" && /^[A-Za-z]{3}$/.test(value.flightEstimate.airportCode.trim()) ? value.flightEstimate.airportCode.trim().toUpperCase() : "",
      priceRange: flightPrice,
      airline: typeof value.flightEstimate?.airline === "string" ? value.flightEstimate.airline.trim().slice(0, 120) : "",
      tip: typeof value.flightEstimate?.tip === "string" ? value.flightEstimate.tip.trim().slice(0, 180) : ""
    },
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

function todayInUK() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing DEEPSEEK_API_KEY." });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const itinerary = body.requestType === "itinerary";
  const structured = body.mode === "travel_report" || typeof body.location === "string";
  let userMessage;
  let systemMessage;

  if (structured) {
    const location = typeof body.location === "string" ? body.location.trim() : "";
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 500) : "";
    const locationZh = typeof body.locationZh === "string" ? body.locationZh.trim().slice(0, 120) : "";
    const countryCode = typeof body.countryCode === "string" ? body.countryCode.trim().toUpperCase() : "";
    const isUK = countryCode === "GB" || (!countryCode && /United Kingdom|英国/.test(address));
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
      "你是一位资深欧洲旅行专家,负责欧洲地区(包含申根区与英国)的目的地分析。只返回纯 JSON 对象,不要 Markdown 代码块、解释或前后缀。",
      "JSON 必须包含 destination(string), destination_zh(string), destination_en(string), flightEstimate({airportCode,priceRange,airline,tip}), tags(string array), preferenceMatch({level,reason}), alternativeSpots(array of {name,distance,reason}), budget({transport,hotel,food,totalRange}), seasonalBonus({season,bonus,reason}), totalScore(number), summary(string)。",
      "请根据目的地和当前日期,扮演旅行专家,估算从英国伯明翰(BHX)到目的地最近机场的经济舱单程机票价格区间,单位为英镑 £。flightEstimate.airportCode 为该机场的 3 位大写 IATA 代码,例如巴黎 CDG、罗马 FCO。flightEstimate.priceRange 必须填写非空的英镑价格区间,格式如 £35 - £65; airline 写可能运营该航线的航空公司; tip 写简短订票建议。即使没有直飞航班,也要按合理的转机行程给出粗略估算。以上均为经验预估,并非实时航班报价或实际可订航班,不要编造具体班次、起飞时间或预订链接。",
      "destination_zh 是地理位置的标准中文译名,destination_en 是当地或英文原名。必须结合地址确认地名含义; Nice 应译为 尼斯,Bath 应译为 巴斯,不要按普通词义翻译。如果确实没有可靠中文译名,允许 destination_zh 为空字符串。",
      "额外包含 recommendedPlay(string),以便展示主要推荐玩法。preferenceMatch.level 只能是 高、中、低。",
      "如果匹配度低,优先在飞镖落点附近 30-50 公里内寻找符合偏好的隐藏玩法,写入 alternativeSpots,并给出粗略距离; 如果附近确实没有,可以推荐落点本身的特色文化体验,并清楚说明距离为 0 公里。",
      "如果匹配度高,alternativeSpots 可以是空数组。不要编造未经核实的景点或精确距离;不确定时写 距离待核实。",
      "budget 的四个值必须都是字符串,以英镑 £ 为单位,按从英国出发的 3-7 天行程粗估。transport 包含往返和当地交通,hotel 为住宿,food 为餐饮,totalRange 为大致总花费区间。不要声称价格为实时报价。",
      isUK ? "目的地位于英国本土,交通按英国国内火车、大巴或自驾及当地交通估算,不要加入国际航班或虚高的跨国机票费用。" : "目的地位于英国之外,交通应考虑从英国往返的合理交通方式与当地交通。",
      "seasonalBonus 描述所给月份对应的季节及适宜度加成。totalScore 为 1 到 10 的数字,保留一位小数。summary 为一句 30 字以内的浪漫中文评语。",
      "JSON 示例: {\"destination\":\"尼斯\",\"destination_zh\":\"尼斯\",\"destination_en\":\"Nice\",\"flightEstimate\":{\"airportCode\":\"NCE\",\"priceRange\":\"£55 - £120\",\"airline\":\"可能的承运航司\",\"tip\":\"建议提前比较不同日期的票价\"},\"tags\":[\"自然秘境\",\"小众静谧\"],\"preferenceMatch\":{\"level\":\"高\",\"reason\":\"很契合\"},\"alternativeSpots\":[],\"recommendedPlay\":\"慢慢散步\",\"budget\":{\"transport\":\"£100-200\",\"hotel\":\"£200-400\",\"food\":\"£80-150\",\"totalRange\":\"£380-750\"},\"seasonalBonus\":{\"season\":\"秋季\",\"bonus\":\"适合\",\"reason\":\"气温温和\"},\"totalScore\":8.5,\"summary\":\"让风替你写下下一站的情书\"}"
    ].join("\n");
    userMessage = `当地地名: ${location}${locationZh ? `\nNominatim 中文候选名: ${locationZh}` : ""}${address ? `\n当地语言地址: ${address}` : ""}${countryCode ? `\n国家代码: ${countryCode}` : ""}\n旅行偏好: ${preference}\n当前月份: ${currentMonth} 月\n当前日期(英国时间): ${todayInUK()}。请按规定 JSON 字段给出分析。`;
    if (itinerary) {
      systemMessage = [
        "你是一位欧洲地区(包含申根区与英国)的定制旅行规划师。根据目的地、用户偏好和当前月份,用简体中文规划从英国出发的 3 天行程。",
        "只返回纯文本,不要 JSON、Markdown 代码块或表格。严格分为 Day 1、Day 2、Day 3 三段,每段写明上午、下午、晚上。",
        isUK ? "目的地位于英国本土。Day 1 按英国国内火车、大巴或自驾交通安排,不要写国际航班;抵达后再安排景点。" : "Day 1 要考虑从英国前往目的地的交通时间,不要在到达前安排景点。",
        "安排紧凑但不累人,兼顾用餐、休息和本地交通。",
        "结合当季天气与开放可能性给出合理安排。不要编造实时营业时间或未经核实的交通班次。"
      ].join("\n");
      userMessage = `目的地: ${location}${address ? `\n地址: ${address}` : ""}${countryCode ? `\n国家代码: ${countryCode}` : ""}\n旅行偏好: ${preference}\n当前月份: ${currentMonth}\n请按 Day 1、Day 2、Day 3 输出 3 天纯文本行程。`;
    }
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
        ...(structured && !itinerary ? { response_format: { type: "json_object" }, max_tokens: 1800 } : {}),
        ...(itinerary ? { max_tokens: 1100 } : {})
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
    if (itinerary) return res.status(200).json({ itinerary: content.trim() });
    if (!structured) return res.status(200).json({ analysis: content.trim() });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      console.error("DeepSeek returned invalid JSON:", error);
      return res.status(502).json({ error: "DeepSeek returned invalid JSON." });
    }
    try {
      const report = normalizeReport(parsed);
      return res.status(200).json({ report });
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
