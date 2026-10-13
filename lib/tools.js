// Tool definitions, mirrored from tanilo-mcp 3.1.0 (src/index.ts): same names, same descriptions
// (quoted from tanilo.io), same input shapes, same calls to https://api.tanilo.io. test/same-tools.test.mjs
// compares this server's tool list with the published npm package over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";

export const VERSION = "3.1.0";   // the tanilo-mcp version whose tools this endpoint exposes
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
  const capPeriodSchema = z.object({ from: z.string().describe("Period start, RFC 3339 UTC, inclusive"), to: z.string().describe("Period end, RFC 3339 UTC, exclusive") }).passthrough();
  const capSchema = z
    .object({
      cap_id: z.string().optional().describe("Your identifier for this cap"),
      amount: decimalString.describe("The cap, as a decimal string, e.g. \"100.00\""),
      currency: z.string().describe("ISO 4217 code, e.g. \"USD\""),
      scope: z.enum(["per_purchase", "per_period"]).describe("per_purchase: the cap applies to this offer alone. per_period: the cap applies to a period, and already_spent counts what it has already consumed."),
      already_spent: decimalString.optional().describe("per_period only: what the period has already consumed, as a decimal string (defaults to \"0\")"),
      period: capPeriodSchema.optional().describe("per_period only: the period bounds"),
    })
    .passthrough();
  const spendOfferSchema = z
    .object({
      unit_price: decimalString.describe("Offered price per unit, as a decimal string, e.g. \"12.50\""),
      currency: z.string().describe("ISO 4217 code, e.g. \"USD\""),
      quantity: decimalString.optional().describe("Quantity offered, as a decimal string. Without it the result is indeterminate (quantity_missing)."),
      offered_at: z.string().optional().describe("When the offer was made, RFC 3339 UTC; needed for a per_period cap"),
      seller: z.string().optional(),
      sku: z.string().optional(),
    })
    .passthrough();

  server.tool(
    "check-spend-cap",
    // Wording from the spend cap docs draft after review round 2 (2026-10-11).
    "Does this offer fit within the cap you supplied? Before an agent commits to a purchase, spend_cap multiplies the offer's unit price by its quantity, exactly, and compares the total with the remaining cap you supply. It signs the result when signing succeeds. " +
      "You supply the cap and already_spent. This check does not retrieve budget balances, maintain a running balance or reserve funds. " +
      "Three results: verified, contradicted, or indeterminate with a reason. A verified result says the offer's total is within the remaining cap. Whether to pay is your policy's decision. " +
      "Verify the receipt's signature against a key set you have authenticated as Tanilo's. A valid signature establishes that the signed content verifies under the selected key and has not been altered. It does not establish that the supplied cap is authentic, approved or current, or that the purchase is authorized.",
    {
      offer: spendOfferSchema.describe("The offer to check"),
      cap: capSchema.describe("The cap you supply (caller-supplied). This check does not establish that the cap is authentic, approved or applicable to this purchase, or that already_spent is complete or current."),
      claim_hash: z.string().regex(/^sha256-[0-9a-f]{64}$/).optional().describe("Optional subject.claim_hash; by default the SHA-256 of the canonical JSON of the input object is used."),
      agent_id: z.string().optional().describe("Optional agent identifier recorded in the receipt; otherwise the receipt carries the placeholder urn:tanilo:verify-facts:anonymous"),
    },
    async ({ offer, cap, claim_hash, agent_id }) => {
      const input = { offer, cap };
      const body = {
        subject: { claim_hash: claim_hash ?? (await sha256Canonical(input)) },
        checks: [{ check_type: "spend_cap", input }],
      };
      if (agent_id) body.agent_id = agent_id;
      let response;
      try {
        response = await fetch(VERIFY_FACTS_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "user-agent": USER_AGENT }, body: JSON.stringify(body) });
      } catch (error) {
        return errorResult(`Spend cap check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return errorResult(`Spend cap check failed (HTTP ${response.status}): ${JSON.stringify(data)}`);
      const result = Array.isArray(data.check_results) ? data.check_results[0] : undefined;
      return textResult({
        verdict: data.verdict,
        state: result?.state,
        outcome: result?.outcome,
        reason: result?.failure_reason ?? result?.indeterminate_reason ?? null,
        recommendation: result?.recommendation,
        offer_total: result?.evidence?.offer_total ?? null,
        remaining: result?.evidence?.remaining ?? null,
        excess: result?.evidence?.excess ?? null,
        cap_already_exhausted: result?.evidence?.cap_already_exhausted ?? null,
        evidence: result?.evidence,
        check_mode: data.check_mode,
        canonical_sha256: data.canonical_sha256,
        kid: data.kid,
        jwks_url: data.jwks_url,
        receipt: data.jws,
        note:
          "Verify the receipt's signature against a key set you have authenticated as Tanilo's (published at https://tanilo.io/.well-known/jwks.json), for example offline with tanilo-receipt-verify. A valid signature establishes that the signed content verifies under the selected key and has not been altered. It does not establish that the supplied cap is authentic, approved or current, or that the purchase is authorized.",
      });
    }
  );
  server.tool("check-health", "Returns the Tanilo API's status document (GET https://api.tanilo.io/health): service status, the live routes and their prices, the retired routes, and rate limits.", {}, async () => getJson(HEALTH_ENDPOINT, "Health check"));
  server.tool("get-manifest", "Returns the Tanilo API's discovery document (GET https://api.tanilo.io/.well-known/x402-manifest.json). It lists no payable resources: the paid research routes were retired on 2026-10-04.", {}, async () => getJson(MANIFEST_ENDPOINT, "Manifest fetch"));
  return server;
}
