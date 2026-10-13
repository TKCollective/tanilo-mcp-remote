// Tool definitions, mirrored from tanilo-mcp 3.0.1 (src/index.ts): same names, same descriptions
// (quoted from tanilo.io), same input shapes, same calls to https://api.tanilo.io. test/same-tools.test.mjs
// compares this server's tool list with the published npm package over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";

export const VERSION = "3.0.1";   // the tanilo-mcp version whose tools this endpoint exposes
const API_BASE = process.env.TANILO_API_BASE || "https://api.tanilo.io";
const VERIFY_FACTS_ENDPOINT = `${API_BASE}/v1/verify-facts`;
const HEALTH_ENDPOINT = `${API_BASE}/health`;
const MANIFEST_ENDPOINT = `${API_BASE}/.well-known/x402-manifest.json`;
const USER_AGENT = `tanilo-mcp-remote/${VERSION}`;

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "a decimal string such as \"2.00\"");
const offerSchema = z.object({
  unit_price: decimalString.describe("Offered price per unit, as a decimal string, e.g. \"2.00\""),
  currency: z.string().describe("ISO 4217 code, e.g. \"USD\""),
  unit: z.string().describe("Unit the price applies to, e.g. \"call\""),
  quantity: decimalString.optional().describe("Quantity offered, as a decimal string, e.g. \"1\""),
  seller: z.string().optional().describe("Seller identifier, e.g. \"seller.example\""),
  sku: z.string().optional().describe("Product or resource identifier, e.g. \"api.weather.v1\""),
  offered_at: z.string().optional().describe("When the offer was made, RFC 3339 UTC, e.g. \"2026-10-01T12:00:00Z\""),
}).passthrough();
const tierSchema = z.object({ min_quantity: decimalString, max_quantity: decimalString.optional(), price_per_unit: decimalString }).passthrough();
const termSchema = z.object({
  agreement_id: z.string(), version: z.string(), seller: z.string().optional(),
  product_scope: z.object({ skus: z.array(z.string()) }).passthrough().optional(),
  currency: z.string(), unit: z.string(),
  price_per_unit: decimalString.optional().describe("Flat price per unit; omit when tiers are given"),
  tiers: z.array(tierSchema).optional().describe("Quantity tiers; each runs from min_quantity up to, but not including, max_quantity"),
  effective_from: z.string().optional(), effective_to: z.string().optional(),
  supersedes: z.string().optional().describe("Version this term replaces"),
}).passthrough();

function textResult(data, isError = false) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) }; }
function errorResult(message) { return { content: [{ type: "text", text: message }], isError: true }; }
async function getJson(url, label) {
  try {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return errorResult(`${label} failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
    return textResult(data);
  } catch (error) { return errorResult(`${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
}
function sha256Canonical(value) {
  const canonical = (v) => { if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]"; return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"; };
  return "sha256-" + createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function createServer() {
  const server = new McpServer({ name: "Tanilo", version: VERSION });
  server.tool(
    "check-contract-price",
    "Does this offer match the terms you supplied? Before an agent accepts an offer, contract_price_match compares the offer's unit price with the applicable term among the terms you supply, and signs the result when signing succeeds. " +
      "No model is involved: the result is arithmetic and exact comparison, and anyone holding the same input can recompute it. You supply the terms; Tanilo does not hold or look up your contracts. " +
      "Three results: verified, contradicted, or indeterminate with a reason. A verified result says the price matches the supplied term. Whether to pay is your policy's decision. " +
      "A valid signature shows which key signed these bytes and that they have not changed since. It does not show that the supplied terms were genuine. " +
      "POST /v1/verify-facts is live in free beta, rate-limited, no key needed.",
    {
      offer: offerSchema.describe("The offer to check"),
      terms: z.array(termSchema).describe("The terms you supply (caller-supplied, not verified as genuine). May be empty: the result is then indeterminate with reason no_applicable_term."),
      claim_hash: z.string().regex(/^sha256-[0-9a-f]{64}$/).optional().describe("Optional subject.claim_hash. Any hash that identifies the purchase for you; by default the SHA-256 of the canonical JSON of the input object is used."),
      agent_id: z.string().optional().describe("Optional agent identifier recorded in the receipt; otherwise the receipt carries the placeholder urn:tanilo:verify-facts:anonymous"),
    },
    async ({ offer, terms, claim_hash, agent_id }) => {
      const input = { offer, terms };
      const body = { subject: { claim_hash: claim_hash ?? sha256Canonical(input) }, checks: [{ check_type: "contract_price_match", input }] };
      if (agent_id) body.agent_id = agent_id;
      let response;
      try { response = await fetch(VERIFY_FACTS_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "user-agent": USER_AGENT }, body: JSON.stringify(body) }); }
      catch (error) { return errorResult(`Contract price check failed: ${error instanceof Error ? error.message : String(error)}`); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return errorResult(`Contract price check failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
      const result = Array.isArray(data.check_results) ? data.check_results[0] : undefined;
      return textResult({
        verdict: data.verdict, state: result?.state, outcome: result?.outcome,
        reason: result?.failure_reason ?? result?.indeterminate_reason ?? null,
        recommendation: result?.recommendation, evidence: result?.evidence, check_mode: data.check_mode,
        canonical_sha256: data.canonical_sha256, kid: data.kid, jwks_url: data.jwks_url, receipt: data.jws,
        note: "A valid signature shows which key signed these bytes and that they have not changed since. It does not show that the supplied terms were genuine. Check the signature offline with tanilo-receipt-verify against the published key set.",
      });
    }
  );
  server.tool("check-health", "Returns the Tanilo API's status document (GET https://api.tanilo.io/health): service status, the live routes and their prices, the retired routes, and rate limits.", {}, async () => getJson(HEALTH_ENDPOINT, "Health check"));
  server.tool("get-manifest", "Returns the Tanilo API's discovery document (GET https://api.tanilo.io/.well-known/x402-manifest.json). It lists no payable resources: the paid research routes were retired on 2026-10-04.", {}, async () => getJson(MANIFEST_ENDPOINT, "Manifest fetch"));
  return server;
}
