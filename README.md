# tanilo-mcp-remote

A hosted Streamable HTTP endpoint that exposes the tools of the published `tanilo-mcp` package (3.1.0): `check-contract-price`, `check-spend-cap`, `check-health`, `get-manifest`. It forwards to `https://api.tanilo.io`, which is free in beta, rate-limited and keyless; the endpoint itself holds no secrets and requires no sign-in.

- Endpoint: `POST /mcp` (MCP Streamable HTTP, JSON-RPC; stateless: one server per request, no sessions, `GET /mcp` answers 405).
- Health: `GET /health` (version of the package the tools come from, API base, transport, auth).
- Logging: one line per request with method, status and duration. Request bodies are never logged.
- Hosting: Vercel functions (`api/mcp.js`, `api/health.js`); `vercel.json` rewrites `/mcp` and `/health`. Local: `node server.js`.
- Tests: `npm test` starts the local server, calls the live API once, verifies the returned receipt's signature with `tanilo-receipt-verify` when a Python with it is on `TANILO_PYTHON`, and compares the tool list with `npx tanilo-mcp@3.1.0` over stdio (names, descriptions, input schemas, server name and version). `REMOTE_URL=https://… npm test` runs the same against a deployment.

Status: preview deployments only. No custom domain and no registry entry until Joe approves.

MIT licensed. TK Collective LLC.
