import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const controlPin = process.env.LOCAL_CONTROL_PIN;

if (!controlPin) {
  throw new Error("LOCAL_CONTROL_PIN is required for privileged smoke tests.");
}

const client = new Client({
  name: "local-control-privileged-smoke-test",
  version: "0.1.0",
});

const transport = new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);
console.log(`Connected to ${url}`);

const stamp = new Date().toISOString();
const testPath = ".mcp-artifacts/self-test/privileged-test.txt";

const writeResult = await client.callTool({
  name: "write_file",
  arguments: {
    path: testPath,
    content: `privileged smoke test ${stamp}\n`,
    mode: "overwrite",
    control_pin: controlPin,
  },
});
console.log(`write_file: ${writeResult.isError ? "failed" : "ok"}`);

const commandResult = await client.callTool({
  name: "run_command",
  arguments: {
    command: ["node", "-e", "console.log(process.platform + ':' + process.arch)"],
    cwd: ".",
    control_pin: controlPin,
  },
});
console.log(`run_command: ${commandResult.isError ? "failed" : "ok"}`);
console.log(commandResult.structuredContent?.stdout?.text?.trim() ?? "");

const appleScriptResult = await client.callTool({
  name: "run_applescript",
  arguments: {
    script: "return \"applescript-ok\"",
    control_pin: controlPin,
  },
});
console.log(`run_applescript: ${appleScriptResult.isError ? "failed" : "ok"}`);
console.log(appleScriptResult.structuredContent?.stdout?.text?.trim() ?? "");

const screenshotResult = await client.callTool({
  name: "take_screenshot",
  arguments: {
    control_pin: controlPin,
  },
});
console.log(`take_screenshot: ${screenshotResult.isError ? "failed" : "ok"}`);
if (screenshotResult.isError) {
  console.log(screenshotResult.content?.[0]?.text ?? "unknown screenshot error");
} else {
  console.log(screenshotResult.structuredContent?.path ?? "");
}

await client.close();
