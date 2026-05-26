import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const client = new Client({
  name: "local-control-smoke-test",
  version: "0.1.0",
});

const transport = new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);

const tools = await client.listTools();
console.log(`Connected to ${url}`);
console.log(`Tools: ${tools.tools.map((tool) => tool.name).join(", ")}`);

const status = await client.callTool({
  name: "computer_status",
  arguments: {},
});
console.log(JSON.stringify(status.structuredContent, null, 2));

const listing = await client.callTool({
  name: "list_directory",
  arguments: { path: ".", depth: 1 },
});
console.log(`Directory entries: ${listing.structuredContent.entries.length}`);

const readme = await client.callTool({
  name: "read_file",
  arguments: { path: "README.md", maxBytes: 200 },
});
console.log(`README bytes read: ${readme.structuredContent.bytesRead}`);

await client.close();
