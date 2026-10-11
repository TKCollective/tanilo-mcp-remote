// One stateless Streamable HTTP handler: a fresh server and transport per request, no sessions,
// no state between calls. Logging is counts only (method, status): request bodies are never logged.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, VERSION } from "./tools.js";

export async function handleMcp(req, res) {
  const started = Date.now();
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless mode: no server-initiated stream and no sessions to end.
    res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this endpoint is stateless; send JSON-RPC over POST" }, id: null }));
    log(req.method, 405, started); return;
  }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); log(req.method, 405, started); return; }
  let body;
  try { body = await readJson(req); } catch { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })); log("POST", 400, started); return; }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); log("POST", res.statusCode, started); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function handleHealth(_req, res) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", service: "tanilo-mcp-remote", tools_from: `tanilo-mcp ${VERSION}`, transport: "streamable-http", endpoint: "/mcp", api_base: process.env.TANILO_API_BASE || "https://api.tanilo.io", auth: "none (free beta)" }));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ""; req.setEncoding("utf8");
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function log(method, status, started) { console.log(JSON.stringify({ t: new Date().toISOString(), method, status, ms: Date.now() - started })); }
