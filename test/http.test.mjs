// Starts server.js on a free port, connects with the SDK's Streamable HTTP client, lists tools, calls
// check-contract-price with the docs example against the live API (free beta route), checks the health
// route, and compares the tool list with the published tanilo-mcp 3.0.0 over stdio (same names,
// descriptions and input schemas). Set REMOTE_URL to test a deployed endpoint instead of a local one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 3889; let child; let BASE = process.env.REMOTE_URL;
before(async () => {
  if (BASE) return;
  child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
});
after(() => { if (child) child.kill(); });

async function connectHttp() {
  const client = new Client({ name: "remote-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  return client;
}
const OFFER = { unit_price: "2.00", currency: "USD", unit: "call", quantity: "1", seller: "seller.example", sku: "api.weather.v1", offered_at: "2026-10-01T12:00:00Z" };
const TERMS = [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }];

test("health route names the package version the tools come from", async () => {
  const h = await (await fetch(BASE + "/health")).json();
  assert.equal(h.status, "ok"); assert.equal(h.tools_from, "tanilo-mcp 3.0.1"); assert.equal(h.transport, "streamable-http"); assert.equal(h.auth, "none (free beta)");
});

test("GET /mcp is refused: the endpoint is stateless", async () => {
  const r = await fetch(BASE + "/mcp"); assert.equal(r.status, 405);
});

test("Streamable HTTP: initialize, list tools, call check-contract-price (docs example: contradicted / halt)", async () => {
  const client = await connectHttp();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check-contract-price", "check-health", "get-manifest"]);
    const res = await client.callTool({ name: "check-contract-price", arguments: { offer: OFFER, terms: TERMS } });
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.state, "contradicted"); assert.equal(out.verdict, "halt"); assert.equal(out.reason, "price_mismatch");
    assert.match(out.canonical_sha256, /^sha256-[0-9a-f]{64}$/); assert.equal(out.kid, "tanilo-2026-10-ed25519-7d885da9");
    assert.ok(out.receipt && typeof out.receipt.payload === "string");
    const py = process.env.TANILO_PYTHON || "python3";
    if (spawnSync(py, ["-c", "import tanilo_receipt_verify"]).status === 0) {
      const jwks = await (await fetch(out.jwks_url)).json();
      const v = spawnSync(py, ["-I", "-c", "import json,sys\nfrom tanilo_receipt_verify import verify\nd=json.load(sys.stdin)\nr=verify(d['receipt'], jwks_by_issuer={d['jwks_url']: d['jwks']}, jwks_is_complete=True)\nprint(json.dumps({'status': r.status, 'canonical_sha256': r.canonical_sha256}))"], { input: JSON.stringify({ receipt: out.receipt, jwks_url: out.jwks_url, jwks }), encoding: "utf8" });
      const verdict = JSON.parse(v.stdout); assert.equal(verdict.status, "valid"); assert.equal(verdict.canonical_sha256, out.canonical_sha256);
      console.log("  signature: valid " + out.canonical_sha256);
    } else console.log("  (signature check skipped: tanilo-receipt-verify not importable)");
    const health = await client.callTool({ name: "check-health", arguments: {} });
    assert.equal(JSON.parse(health.content[0].text).status, "ok");
  } finally { await client.close(); }
});

test("same tools as the published tanilo-mcp 3.0.0 over stdio: names, descriptions and input schemas", async () => {
  const http = await connectHttp();
  const stdio = new Client({ name: "remote-test", version: "0" });
  await stdio.connect(new StdioClientTransport({ command: "npx", args: ["-y", "tanilo-mcp@3.0.1"], stderr: "pipe" }));
  try {
    const a = (await http.listTools()).tools.sort((x, y) => x.name.localeCompare(y.name));
    const b = (await stdio.listTools()).tools.sort((x, y) => x.name.localeCompare(y.name));
    assert.deepEqual(a.map((t) => [t.name, t.description]), b.map((t) => [t.name, t.description]));
    assert.deepEqual(a.map((t) => t.inputSchema), b.map((t) => t.inputSchema));
    const sv = await http.getServerVersion(); const sw = await stdio.getServerVersion();
    assert.equal(sv.name, sw.name); assert.equal(sv.version, sw.version);
  } finally { await http.close(); await stdio.close(); }
});
