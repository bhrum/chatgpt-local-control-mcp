import { createHash, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const mcpUrl = process.env.MCP_URL ?? "http://localhost:8787/mcp";

function originFromMcpUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

const origin = originFromMcpUrl(mcpUrl);
const verifier = randomBytes(32).toString("base64url");
const challenge = pkceChallenge(verifier);
const redirectUri = "http://127.0.0.1/oauth-smoke-callback";
const state = randomBytes(12).toString("base64url");

const metadata = await readJson(await fetch(`${origin}/.well-known/oauth-authorization-server`));
console.log(`OAuth issuer: ${metadata.issuer}`);

const registration = await readJson(
  await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  })
);

const authorizeUrl = new URL(`${origin}/oauth/authorize`);
authorizeUrl.searchParams.set("client_id", registration.client_id);
authorizeUrl.searchParams.set("redirect_uri", redirectUri);
authorizeUrl.searchParams.set("response_type", "code");
authorizeUrl.searchParams.set("state", state);
authorizeUrl.searchParams.set("scope", "local.control");
authorizeUrl.searchParams.set("code_challenge", challenge);
authorizeUrl.searchParams.set("code_challenge_method", "S256");
authorizeUrl.searchParams.set("approve", "1");

const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
if (authorizeResponse.status !== 302) {
  throw new Error(`Expected OAuth authorize redirect, got ${authorizeResponse.status}: ${await authorizeResponse.text()}`);
}

const location = authorizeResponse.headers.get("location");
if (!location) throw new Error("OAuth authorize response did not include a redirect location.");
const callback = new URL(location);
if (callback.searchParams.get("state") !== state) throw new Error("OAuth state mismatch.");
const code = callback.searchParams.get("code");
if (!code) throw new Error("OAuth callback did not include code.");

const token = await readJson(
  await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
);
console.log(`OAuth token scope: ${token.scope}`);

const client = new Client({
  name: "local-control-oauth-smoke-test",
  version: "0.1.0",
});
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  },
});

await client.connect(transport);
const testPath = ".mcp-artifacts/self-test/oauth-test.txt";
const content = `oauth smoke test ${new Date().toISOString()}\n`;

const writeResult = await client.callTool({
  name: "write_file",
  arguments: {
    path: testPath,
    content,
    mode: "overwrite",
  },
});
console.log(`oauth write_file: ${writeResult.isError ? "failed" : "ok"}`);
if (writeResult.isError) {
  console.log(writeResult.content?.[0]?.text ?? "unknown write error");
}

const readResult = await client.callTool({
  name: "read_file",
  arguments: {
    path: testPath,
    maxBytes: 200,
  },
});
console.log(`oauth read_file: ${readResult.isError ? "failed" : "ok"}`);
console.log(readResult.structuredContent?.content?.trim() ?? "");

await client.close();
