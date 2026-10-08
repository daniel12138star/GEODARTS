// Vercel Serverless Function: POST /api/deepseek
// Configure DEEPSEEK_API_KEY in Vercel Project Settings -> Environment Variables.

const PREFERENCES = new Set(["人文历史", "自然秘境", "全都要"]);

function normalizeReport(value, challenge) {
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
  let challengeFeedback = null;
  if (challenge) {
    const feedback = value.challengeFeedback;
    if (!feedback || typeof feedback !== "object" || Array.isArray(feedback) || !["轻松完成", "略有难度", "极其困难", "几乎不可能"].includes(feedback.status)) {
      throw new Error("Invalid challengeFeedback.");
    }
    challengeFeedback = { status: feedback.status, comment: requiredString(feedback.comment, "challengeFeedback.comment", 180) };
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
    challengeFeedback,
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

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const generateChallenge = body.requestType === "generate_challenge";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: generateChallenge ? "生成失败" : "Server is missing DEEPSEEK_API_KEY." });
  const itinerary = body.requestType === "itinerary";
  const structured = body.mode === "travel_report" || typeof body.location === "string";
  const challenge = typeof body.challenge === "string" ? body.challenge.trim() : "";
  if (challenge.length > 120 || /[\u0000-\u001f\u007f]/.test(challenge)) return res.status(400).json({ error: "Invalid challenge." });
  let userMessage;
  let systemMessage;

  if (generateChallenge) {
    systemMessage = `你是一位擅长制造快乐和美好回忆的旅行盲盒游戏主持人。请为今天的旅行生成一个简短、有趣、绝对快乐且极具互动感的挑战。

核心目标：让玩家在完成挑战时，能够和当地的人、事、物产生有趣且温暖的互动，感到开心和充实。

硬性要求：
1. 字数严格控制在 15 个字以内。
2. 只返回纯文本挑战内容，不要引号、不要解释、不要 JSON。
3. 快乐底线：绝不包含社死、尴尬、难堪、危险或高难度行为。必须让参与者发自内心地觉得好玩！
4. 互动底线：必须包含某种形式的互动（与当地人、同行者、当地环境、小动物等）。
5. 多元化：每次生成必须与上一次截然不同，不要一直重复“方言”、“陌生人合影”等烂梗。

快乐互动灵感池（请尽情发散，不限于此）：
· 【当地互动】：向当地老板学做一道特色菜、请路过的老奶奶推荐一家她最爱的面包店。
· 【环境互动】：在公园找一片最漂亮的落叶带回家、和当地最著名的雕像摆一个同款姿势。
· 【双人/情侣互动】：互相给对方拍一张拍立得、用抛硬币的方式决定接下来去哪、请对方吃一种没吃过的当地小吃。
· 【小动物互动】：在广场上找到一只鸽子并向它问好、和当地的一只小狗合影。
· 【治愈系挑战】：给未来的自己寄一张明信片、在当地的许愿池许一个愿。

请尽情发挥你的想象力，生成一个充满欢笑、互动感十足且温暖可爱的挑战吧！`;
    userMessage = `今天是 ${todayInUK()}。请现场生成一条新的旅行挑战。`;
  } else if (structured) {
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
      "JSON 必须包含 destination(string), destination_zh(string), destination_en(string), flightEstimate({airportCode,priceRange,airline,tip}), tags(string array), preferenceMatch({level,reason}), alternativeSpots(array of {name,distance,reason}), budget({transport,hotel,food,totalRange}), seasonalBonus({season,bonus,reason}), totalScore(number), summary(string), challengeFeedback(object 或 null)。",
      "请根据目的地和当前日期,扮演旅行专家,估算从英国伯明翰(BHX)到目的地最近机场的经济舱单程机票价格区间,单位为英镑 £。flightEstimate.airportCode 为该机场的 3 位大写 IATA 代码,例如巴黎 CDG、罗马 FCO。flightEstimate.priceRange 必须填写非空的英镑价格区间,格式如 £35 - £65; airline 写可能运营该航线的航空公司; tip 写简短订票建议。即使没有直飞航班,也要按合理的转机行程给出粗略估算。以上均为经验预估,并非实时航班报价或实际可订航班,不要编造具体班次、起飞时间或预订链接。",
      "destination_zh 是地理位置的标准中文译名,destination_en 是当地或英文原名。必须结合地址确认地名含义; Nice 应译为 尼斯,Bath 应译为 巴斯,不要按普通词义翻译。如果确实没有可靠中文译名,允许 destination_zh 为空字符串。",
      "额外包含 recommendedPlay(string),以便展示主要推荐玩法。preferenceMatch.level 只能是 高、中、低。",
      "如果匹配度低,优先在飞镖落点附近 30-50 公里内寻找符合偏好的隐藏玩法,写入 alternativeSpots,并给出粗略距离; 如果附近确实没有,可以推荐落点本身的特色文化体验,并清楚说明距离为 0 公里。",
      "如果匹配度高,alternativeSpots 可以是空数组。不要编造未经核实的景点或精确距离;不确定时写 距离待核实。",
      "budget 的四个值必须都是字符串,以英镑 £ 为单位,按从英国出发的 3-7 天行程粗估。transport 包含往返和当地交通,hotel 为住宿,food 为餐饮,totalRange 为大致总花费区间。不要声称价格为实时报价。",
      isUK ? "目的地位于英国本土,交通按英国国内火车、大巴或自驾及当地交通估算,不要加入国际航班或虚高的跨国机票费用。" : "目的地位于英国之外,交通应考虑从英国往返的合理交通方式与当地交通。",
      "seasonalBonus 描述所给月份对应的季节及适宜度加成。totalScore 为 1 到 10 的数字,保留一位小数。summary 为一句 30 字以内的浪漫中文评语。",
      challenge ? `用户当前抽到的旅行挑战是: ${JSON.stringify(challenge)}。请根据目的地的实际情况(物价、交通、治安、语言等)严肃评估该挑战在这里的难度。challengeFeedback 必须是对象,包含 status 和 comment。status 必须严格是 轻松完成、略有难度、极其困难、几乎不可能 之一。comment 必须是一句机智幽默、结合当地特色的点评。举例: 巴黎遇上 只带 £200 穷游,可以点评预算会迫使游客住市郊、靠面包省钱;挪威遇上 只能徒步和公交,可以点评峡湾徒步考验双腿、公共交通考验钱包。不得让挑战评价覆盖或删去原有的 flightEstimate、totalScore、summary 等字段。` : "用户没有抽取旅行挑战。challengeFeedback 必须返回 null。",
      "JSON 示例: {\"destination\":\"尼斯\",\"destination_zh\":\"尼斯\",\"destination_en\":\"Nice\",\"flightEstimate\":{\"airportCode\":\"NCE\",\"priceRange\":\"£55 - £120\",\"airline\":\"可能的承运航司\",\"tip\":\"建议提前比较不同日期的票价\"},\"tags\":[\"自然秘境\",\"小众静谧\"],\"preferenceMatch\":{\"level\":\"高\",\"reason\":\"很契合\"},\"alternativeSpots\":[],\"recommendedPlay\":\"慢慢散步\",\"budget\":{\"transport\":\"£100-200\",\"hotel\":\"£200-400\",\"food\":\"£80-150\",\"totalRange\":\"£380-750\"},\"seasonalBonus\":{\"season\":\"秋季\",\"bonus\":\"适合\",\"reason\":\"气温温和\"},\"totalScore\":8.5,\"summary\":\"让风替你写下下一站的情书\",\"challengeFeedback\":null}"
    ].join("\n");
    if (challenge) {
      systemMessage = systemMessage.replace('"challengeFeedback":null}', '"challengeFeedback":{"status":"略有难度","comment":"这个挑战值得试试,但请留点余力给惊喜"}}');
    }
    userMessage = `当地地名: ${location}${locationZh ? `\nNominatim 中文候选名: ${locationZh}` : ""}${address ? `\n当地语言地址: ${address}` : ""}${countryCode ? `\n国家代码: ${countryCode}` : ""}\n旅行偏好: ${preference}\n旅行挑战: ${challenge || "无挑战"}\n当前月份: ${currentMonth} 月\n当前日期(英国时间): ${todayInUK()}。请按规定 JSON 字段给出分析。`;
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
        ...(itinerary ? { max_tokens: 1100 } : {}),
        ...(generateChallenge ? { max_tokens: 80, temperature: 1.2 } : {})
      }),
      signal: controller.signal
    });

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      if (generateChallenge) return res.status(502).json({ error: "生成失败" });
      const detail = payload.error?.message || payload.message || `DeepSeek returned HTTP ${upstream.status}`;
      return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({ error: detail });
    }
    if (payload.choices?.[0]?.finish_reason === "length") {
      if (generateChallenge) return res.status(502).json({ error: "生成失败" });
      return res.status(502).json({ error: "DeepSeek response was truncated. Please retry." });
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      if (generateChallenge) return res.status(502).json({ error: "生成失败" });
      return res.status(502).json({ error: "DeepSeek returned an empty response." });
    }
    if (generateChallenge) {
      const generated = content.trim();
      if (Array.from(generated).length > 15 || /[\r\n\u0000-\u001f\u007f]/.test(generated) || /^["'“”{\[]/.test(generated)) {
        return res.status(502).json({ error: "生成失败" });
      }
      return res.status(200).json({ challenge: generated });
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
      const report = normalizeReport(parsed, challenge);
      return res.status(200).json({ report });
    } catch (error) {
      console.error("DeepSeek returned an invalid report:", error);
      return res.status(502).json({ error: "DeepSeek returned an invalid travel report." });
    }
  } catch (error) {
    if (generateChallenge) {
      console.error("Challenge generation failed:", error);
      return res.status(error.name === "AbortError" ? 504 : 502).json({ error: "生成失败" });
    }
    if (error.name === "AbortError") return res.status(504).json({ error: "DeepSeek request timed out." });
    console.error("DeepSeek API request failed:", error);
    return res.status(502).json({ error: "Could not reach the DeepSeek API." });
  } finally {
    clearTimeout(timeout);
  }
};
