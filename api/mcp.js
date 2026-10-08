// GeoDarts MCP route and server-side Google Flights bridge.
// Install dependencies from package.json before deploying to Vercel.

const { spawn } = require("node:child_process");
const { createMcpHandler } = require("mcp-handler");
const { z } = require("zod");
// Keep the CLI entry in Vercel's dependency trace even though npx starts it.
const FLIGHTS_MCP_ENTRY = require.resolve("google-flights-mcp/dist/index.js");

const AIRPORT = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateSearch({ origin, destination, date }) {
  const from = String(origin || "").trim().toUpperCase();
  const to = String(destination || "").trim().toUpperCase();
  const day = String(date || "").trim();
  if (!AIRPORT.test(from) || !AIRPORT.test(to)) throw new Error("Airport codes must be 3 letters.");
  if (!DATE.test(day) || Number.isNaN(Date.parse(day + "T12:00:00Z"))) throw new Error("Date must be YYYY-MM-DD.");
  if (from === to) throw new Error("Origin and destination airports are the same.");
  return { origin: from, destination: to, date: day };
}

function textFromTool(result) {
  if (result?.isError) throw new Error(result.content?.map(item => item.text || "").join(" ") || "Flight tool failed.");
  return (result?.content || []).filter(item => item.type === "text").map(item => item.text || "").join("\n");
}

function parseCheapest(text, origin, date) {
  const blocks = String(text).split(/(?=Flight\s+\d+:)/i).slice(1);
  const choices = blocks.map(block => {
    const fare = block.match(/^Flight\s+\d+:\s*(GBP|USD|EUR|£|\$|€)\s*([\d,.]+)/i);
    if (!fare) return null;
    const amount = Number(fare[2].replaceAll(",", ""));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const departure = block.match(new RegExp("\\b" + origin + "\\s+" + date + "\\s+(\\d{1,2}:\\d{2})"));
    const currency = { GBP: "£", USD: "$", EUR: "€" }[fare[1].toUpperCase()] || fare[1];
    return { amount, price: currency + amount.toLocaleString("en-GB"), currency, departureTime: departure?.[1] || null };
  }).filter(Boolean);
  choices.sort((a, b) => a.amount - b.amount);
  return choices[0] || null;
}

function bookingUrlFromTool(text) {
  const match = String(text).match(/https:\/\/(?:www\.)?google\.com\/travel\/flights[^\s<>"']*/i);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[),.;]+$/, ""));
    return url.protocol === "https:" && ["google.com", "www.google.com"].includes(url.hostname) ? url.href : null;
  } catch (_) {
    return null;
  }
}

async function searchFlights(input) {
  const { origin, destination, date } = validateSearch(input);
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["-y", "google-flights-mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
    env: { ...process.env, GEODARTS_FLIGHTS_MCP_ENTRY: FLIGHTS_MCP_ENTRY }
  });
  const pending = new Map();
  let nextId = 1;
  let output = "";
  let diagnostic = "";
  let closed = false;
  const failPending = error => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.length > 1024 * 1024) { child.kill(); failPending(new Error("Flight MCP output was too large.")); return; }
    let end;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end).trim();
      output = output.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "Flight MCP error."));
      else entry.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  child.on("error", error => failPending(error));
  child.on("exit", code => failPending(new Error("Flight MCP exited with code " + code + (diagnostic ? ": " + diagnostic : ""))));
  const call = (method, params) => new Promise((resolve, reject) => {
    if (closed || child.stdin.destroyed) { reject(new Error("Flight MCP is unavailable.")); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const timer = setTimeout(() => {
    failPending(new Error("Flight MCP timed out."));
    child.kill();
  }, 25000);
  try {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "geodarts", version: "1.0.0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const search = await call("tools/call", {
      name: "search_flights",
      arguments: { origin, destination, departureDate: date, sortBy: "price", maxResults: 10 }
    });
    const cheapest = parseCheapest(textFromTool(search), origin, date);
    if (!cheapest) return { available: false, origin, destination, date };
    let bookingUrl = null;
    try {
      const link = await call("tools/call", { name: "get_flight_url", arguments: { origin, destination, departureDate: date } });
      bookingUrl = bookingUrlFromTool(textFromTool(link));
    } catch (error) {
      console.error("Flight booking link failed:", error);
    }
    return { available: true, origin, destination, date, price: cheapest.price, departureTime: cheapest.departureTime, bookingUrl };
  } finally {
    clearTimeout(timer);
    if (!child.stdin.destroyed) child.stdin.end();
    child.kill();
  }
}

const mcpHandler = createMcpHandler(server => {
  server.registerTool("search_flights", {
    title: "Search flights",
    description: "Find today's lowest listed fare and Google Flights route link.",
    inputSchema: z.object({
      origin: z.string().regex(AIRPORT),
      destination: z.string().regex(AIRPORT),
      date: z.string().regex(DATE)
    })
  }, async input => {
    const result = await searchFlights(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
});

async function handler(req, res) {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url || "/api/mcp", "https://" + (req.headers.host || "localhost"));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    let body;
    if (method !== "GET" && method !== "HEAD") {
      if (req.body !== undefined) body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      else { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks); }
      headers.delete("content-length");
    }
    const response = await mcpHandler(new Request(url, { method, headers, body, ...(body ? { duplex: "half" } : {}) }));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("MCP route failed:", error);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Flight MCP route failed." }));
  }
}

module.exports = handler;
module.exports.searchFlights = searchFlights;
