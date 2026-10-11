// Local runner: the same handlers behind a plain Node HTTP server. node server.js (PORT, default 3888)
import http from "node:http";
import { handleMcp, handleHealth } from "./lib/handler.js";
const port = Number(process.env.PORT || 3888);
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mcp") return handleMcp(req, res);
  if (url.pathname === "/health" || url.pathname === "/") return handleHealth(req, res);
  res.writeHead(404).end();
}).listen(port, () => console.log(JSON.stringify({ t: new Date().toISOString(), listening: port })));
