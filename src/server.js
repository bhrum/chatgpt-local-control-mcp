import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const STARTED_AT = new Date();
const CWD = process.cwd();
const NO_AUTH_SECURITY_SCHEMES = [{ type: "noauth" }];
const CONTROL_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["local.control"] }];
const OAUTH_SCOPES = ["local.read", "local.control"];
const OAUTH_CODES = new Map();
const OAUTH_TOKENS = new Map();
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

const CONFIG = {
  allowWrites: process.env.ALLOW_WRITES === "1",
  allowShell: process.env.ALLOW_SHELL === "1",
  allowUnsafeShell: process.env.ALLOW_UNSAFE_SHELL === "1",
  allowScreenshot: process.env.ALLOW_SCREENSHOT === "1",
  allowOpen: process.env.ALLOW_OPEN === "1",
  allowAppleScript: process.env.ALLOW_APPLESCRIPT === "1",
  controlPin: process.env.LOCAL_CONTROL_PIN ?? "",
  requireOAuthApprovalPin: process.env.OAUTH_REQUIRE_APPROVAL_PIN === "1",
  oauthTokenTtlSeconds: Number(process.env.OAUTH_TOKEN_TTL_SECONDS ?? 24 * 60 * 60),
  maxCommandOutputChars: Number(process.env.MAX_COMMAND_OUTPUT_CHARS ?? 20_000),
  maxReadBytes: Number(process.env.MAX_READ_BYTES ?? 262_144),
  maxDirectoryEntries: Number(process.env.MAX_DIRECTORY_ENTRIES ?? 300),
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? 15_000),
  safeExecutables: new Set(
    (process.env.SAFE_EXECUTABLES ??
      "pwd,ls,find,cat,head,tail,wc,du,df,ps,whoami,hostname,git,node,npm,python3,rg,sed")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ),
};

const AUDIT_DIR = path.join(CWD, ".mcp-audit");
const ARTIFACT_DIR = path.join(CWD, ".mcp-artifacts");

function expandHome(inputPath) {
  if (!inputPath || inputPath === ".") return CWD;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function parseAllowedRoots() {
  const raw = process.env.LOCAL_CONTROL_ROOTS?.trim();
  const roots = raw ? raw.split(path.delimiter) : [CWD];

  return roots
    .map((root) => path.resolve(expandHome(root.trim())))
    .filter((root) => root && existsSync(root))
    .map((root) => realpathSync(root));
}

const ALLOWED_ROOTS = parseAllowedRoots();

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAllowedRealPath(realCandidate) {
  if (!ALLOWED_ROOTS.some((root) => isPathInside(root, realCandidate))) {
    throw new Error(
      `Path is outside LOCAL_CONTROL_ROOTS. Allowed roots: ${ALLOWED_ROOTS.join(", ")}`
    );
  }
}

async function resolveAllowedPath(inputPath, { forWrite = false } = {}) {
  const absolutePath = path.resolve(CWD, expandHome(inputPath));

  if (!forWrite) {
    const candidate = await realpath(absolutePath);
    assertAllowedRealPath(candidate);
    return candidate;
  }

  let existingAncestor = path.dirname(absolutePath);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("Could not find an existing parent directory.");
    }
    existingAncestor = parent;
  }

  assertAllowedRealPath(await realpath(existingAncestor));
  return absolutePath;
}

function requirePin(controlPin) {
  if (!CONFIG.controlPin || CONFIG.controlPin === "change-me-to-a-long-random-secret") {
    throw new Error("Set LOCAL_CONTROL_PIN to a strong value before using privileged tools.");
  }
  if (controlPin !== CONFIG.controlPin) {
    throw new Error("Invalid or missing control_pin.");
  }
}

function hasConfiguredControlPin() {
  return Boolean(CONFIG.controlPin && CONFIG.controlPin !== "change-me-to-a-long-random-secret");
}

function requireControlAuthorization(controlPin, authContext) {
  if (authContext?.scopes?.includes("local.control")) {
    return;
  }
  requirePin(controlPin);
}

function requireCapability(name, enabled, controlPin, authContext) {
  if (!enabled) {
    throw new Error(`Capability ${name} is disabled. Enable it in .env before using this tool.`);
  }
  requireControlAuthorization(controlPin, authContext);
}

function requireReadAuthorization() {
  return;
}

function truncateText(value, maxChars = CONFIG.maxCommandOutputChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function asTextResult(structuredContent, message = undefined, extraContent = []) {
  const text = message ?? JSON.stringify(structuredContent, null, 2);
  return {
    content: [{ type: "text", text }, ...extraContent],
    structuredContent,
  };
}

function asError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

async function audit(event) {
  await mkdir(AUDIT_DIR, { recursive: true });
  const entry = {
    time: new Date().toISOString(),
    ...event,
  };
  await appendFile(path.join(AUDIT_DIR, "events.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

function bearerTokenFromRequest(req) {
  const auth = req.headers.authorization ?? "";
  if (String(auth).toLowerCase().startsWith("bearer ")) {
    return String(auth).slice("bearer ".length).trim();
  }
  return "";
}

function authContextFromRequest(req) {
  const token = bearerTokenFromRequest(req);
  const entry = token ? OAUTH_TOKENS.get(token) : undefined;
  if (!entry) {
    return { token: "", scopes: [] };
  }

  if (entry.expiresAt <= Date.now()) {
    OAUTH_TOKENS.delete(token);
    return { token: "", scopes: [] };
  }

  return {
    token,
    scopes: entry.scopes,
  };
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char];
  });
}

async function readRequestText(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function publicOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const host = forwardedHost || req.headers.host || `127.0.0.1:${PORT}`;
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const proto = forwardedProto || (isLocalHost ? "http" : "https");
  return `${proto}://${host}`;
}

function oauthMetadata(req) {
  const origin = publicOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: OAUTH_SCOPES,
  };
}

function protectedResourceMetadata(req) {
  const origin = publicOrigin(req);
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    resource_documentation: "https://github.com/bhrum/chatgpt-local-control-mcp",
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function toolMeta(invoking, invoked, securitySchemes = NO_AUTH_SECURITY_SCHEMES) {
  return {
    securitySchemes,
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

async function listDirectoryRecursive(rootPath, depth, includeHidden, entries, basePath = rootPath) {
  if (entries.length >= CONFIG.maxDirectoryEntries) return;

  const dirEntries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (entries.length >= CONFIG.maxDirectoryEntries) break;
    if (!includeHidden && entry.name.startsWith(".")) continue;

    const fullPath = path.join(rootPath, entry.name);
    const itemStat = await stat(fullPath);
    const item = {
      path: path.relative(basePath, fullPath) || ".",
      absolutePath: fullPath,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: itemStat.size,
      modifiedAt: itemStat.mtime.toISOString(),
    };
    entries.push(item);

    if (entry.isDirectory() && depth > 1) {
      await listDirectoryRecursive(fullPath, depth - 1, includeHidden, entries, basePath);
    }
  }
}

async function runCommand(argv, cwd, timeoutMs) {
  const executable = argv[0];
  if (!executable) throw new Error("command must include at least one executable name.");

  if (!CONFIG.allowUnsafeShell && !CONFIG.safeExecutables.has(path.basename(executable))) {
    throw new Error(
      `Executable "${executable}" is not in SAFE_EXECUTABLES. Temporarily set ALLOW_UNSAFE_SHELL=1 only if you trust this session.`
    );
  }

  const resolvedCwd = cwd ? await resolveAllowedPath(cwd) : CWD;
  const boundedTimeout = Math.min(Math.max(timeoutMs ?? CONFIG.commandTimeoutMs, 1_000), 120_000);

  const result = await execFileAsync(executable, argv.slice(1), {
    cwd: resolvedCwd,
    timeout: boundedTimeout,
    maxBuffer: Math.max(CONFIG.maxCommandOutputChars * 4, 1024 * 1024),
    env: {
      ...process.env,
      LOCAL_CONTROL_PIN: "",
    },
  });

  return {
    cwd: resolvedCwd,
    exitCode: 0,
    stdout: truncateText(result.stdout ?? ""),
    stderr: truncateText(result.stderr ?? ""),
  };
}

async function runCommandCapturingFailures(argv, cwd, timeoutMs) {
  try {
    return await runCommand(argv, cwd, timeoutMs);
  } catch (error) {
    if (typeof error === "object" && error && "stdout" in error && "stderr" in error) {
      return {
        cwd: cwd ?? CWD,
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: truncateText(error.stdout ?? ""),
        stderr: truncateText(error.stderr ?? error.message ?? ""),
      };
    }
    throw error;
  }
}

async function runAppleScript(script, timeoutMs = CONFIG.commandTimeoutMs) {
  const lines = script.split("\n").flatMap((line) => ["-e", line]);
  const result = await execFileAsync("osascript", lines, {
    timeout: Math.min(Math.max(timeoutMs, 1_000), 60_000),
    maxBuffer: Math.max(CONFIG.maxCommandOutputChars * 4, 1024 * 1024),
  });
  return {
    exitCode: 0,
    stdout: truncateText(result.stdout ?? ""),
    stderr: truncateText(result.stderr ?? ""),
  };
}

const TOOL_DESCRIPTORS = [
  {
    name: "computer_status",
    title: "Computer status",
    description: "Return basic status for this Mac MCP server, including allowed file roots and enabled capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    _meta: toolMeta("Checking Mac control status", "Mac control status ready"),
  },
  {
    name: "list_directory",
    title: "List directory",
    description: "List files and folders under LOCAL_CONTROL_ROOTS. Does not read file contents or modify anything.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Relative paths resolve from server cwd." },
        depth: { type: "integer", minimum: 1, maximum: 3, description: "Recursive depth, from 1 to 3." },
        includeHidden: { type: "boolean", description: "Include dotfiles and dotfolders." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    _meta: toolMeta("Listing local directory", "Local directory listing ready"),
  },
  {
    name: "read_file",
    title: "Read file",
    description: "Read a UTF-8 or base64 file from LOCAL_CONTROL_ROOTS, bounded by MAX_READ_BYTES.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        maxBytes: { type: "integer", minimum: 1, maximum: 1048576 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    securitySchemes: NO_AUTH_SECURITY_SCHEMES,
    _meta: toolMeta("Reading local file", "Local file read"),
  },
  {
    name: "write_file",
    title: "Write file",
    description: "Create, overwrite, or append to a file under LOCAL_CONTROL_ROOTS. Requires OAuth scope local.control or the fallback control_pin.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "overwrite", "append"] },
        control_pin: { type: "string", description: "Fallback local PIN. Not needed when the app is OAuth-authorized." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
    securitySchemes: CONTROL_SECURITY_SCHEMES,
    _meta: toolMeta("Writing local file", "Local file write finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "run_command",
    title: "Run command",
    description: "Run a local command without a shell. Requires OAuth scope local.control or the fallback control_pin.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Executable and arguments, for example ['git', 'status', '--short'].",
        },
        cwd: { type: "string", description: "Working directory. Must be inside LOCAL_CONTROL_ROOTS." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        control_pin: { type: "string", description: "Fallback local PIN. Not needed when the app is OAuth-authorized." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    securitySchemes: CONTROL_SECURITY_SCHEMES,
    _meta: toolMeta("Running local command", "Local command finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "take_screenshot",
    title: "Take screenshot",
    description: "Capture the Mac screen and return it as an MCP image. Requires OAuth scope local.control or the fallback control_pin.",
    inputSchema: {
      type: "object",
      properties: {
        control_pin: { type: "string", description: "Fallback local PIN. Not needed when the app is OAuth-authorized." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    securitySchemes: CONTROL_SECURITY_SCHEMES,
    _meta: toolMeta("Taking screenshot", "Screenshot ready", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "open_target",
    title: "Open target",
    description: "Open a URL, file, folder, or app with macOS open. Requires OAuth scope local.control or the fallback control_pin.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1, description: "A URL, file path, folder path, or app name/path." },
        control_pin: { type: "string", description: "Fallback local PIN. Not needed when the app is OAuth-authorized." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    },
    securitySchemes: CONTROL_SECURITY_SCHEMES,
    _meta: toolMeta("Opening local target", "Local target opened", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "run_applescript",
    title: "Run AppleScript",
    description: "Run AppleScript for GUI automation. Requires OAuth scope local.control or the fallback control_pin.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
        control_pin: { type: "string", description: "Fallback local PIN. Not needed when the app is OAuth-authorized." },
      },
      required: ["script"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    securitySchemes: CONTROL_SECURITY_SCHEMES,
    _meta: toolMeta("Running AppleScript", "AppleScript finished", CONTROL_SECURITY_SCHEMES),
  },
];

function createLocalControlServer(authContext = { scopes: [] }) {
  const server = new McpServer({
    name: "chatgpt-local-control",
    version: "0.1.0",
    instructions:
      "Use these tools to inspect and control the user's Mac only when the user explicitly asks. Read-only tools do not require auth. Privileged tools require OAuth scope local.control or the fallback control_pin.",
  });

  server.registerTool(
    "computer_status",
    {
      title: "Computer status",
      description:
        "Return basic status for this Mac MCP server, including allowed file roots and enabled capabilities.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        hostname: z.string(),
        platform: z.string(),
        arch: z.string(),
        cwd: z.string(),
        allowedRoots: z.array(z.string()),
        capabilities: z.record(z.boolean()),
        uptimeSeconds: z.number(),
        startedAt: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Checking Mac control status", "Mac control status ready"),
    },
    async () => {
      try {
        requireReadAuthorization();
        return asTextResult({
        ok: true,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cwd: CWD,
        allowedRoots: ALLOWED_ROOTS,
        capabilities: {
          writes: CONFIG.allowWrites,
          shell: CONFIG.allowShell,
          unsafeShell: CONFIG.allowUnsafeShell,
          screenshot: CONFIG.allowScreenshot,
          open: CONFIG.allowOpen,
          appleScript: CONFIG.allowAppleScript,
          readToolsRequireAuth: false,
          oauth: true,
          oauthApprovalPinRequired: CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin(),
          pinFallbackForControl: hasConfiguredControlPin(),
        },
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List files and folders under LOCAL_CONTROL_ROOTS. Does not read file contents or modify anything.",
      inputSchema: {
        path: z.string().optional().describe("Directory to list. Relative paths resolve from server cwd."),
        depth: z.number().int().min(1).max(3).optional().describe("Recursive depth, from 1 to 3."),
        includeHidden: z.boolean().optional().describe("Include dotfiles and dotfolders."),
      },
      outputSchema: {
        root: z.string(),
        entries: z.array(
          z.object({
            path: z.string(),
            absolutePath: z.string(),
            type: z.string(),
            size: z.number(),
            modifiedAt: z.string(),
          })
        ),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Listing local directory", "Local directory listing ready"),
    },
    async ({ path: requestedPath = ".", depth = 1, includeHidden = false }) => {
      try {
        requireReadAuthorization();
        const root = await resolveAllowedPath(requestedPath);
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) throw new Error("path must be a directory.");

        const entries = [];
        await listDirectoryRecursive(root, depth, includeHidden, entries);
        return asTextResult({
          root,
          entries,
          truncated: entries.length >= CONFIG.maxDirectoryEntries,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 or base64 file from LOCAL_CONTROL_ROOTS, bounded by MAX_READ_BYTES.",
      inputSchema: {
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z.number().int().min(1).max(1_048_576).optional(),
      },
      outputSchema: {
        path: z.string(),
        encoding: z.string(),
        size: z.number(),
        bytesRead: z.number(),
        truncated: z.boolean(),
        content: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Reading local file", "Local file read"),
    },
    async ({ path: requestedPath, encoding = "utf8", maxBytes }) => {
      try {
        requireReadAuthorization();
        const filePath = await resolveAllowedPath(requestedPath);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error("path must be a file.");

        const limit = Math.min(maxBytes ?? CONFIG.maxReadBytes, CONFIG.maxReadBytes);
        const buffer = await readFile(filePath);
        const slice = buffer.subarray(0, limit);
        const content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");

        await audit({
          tool: "read_file",
          path: filePath,
          bytesRead: slice.length,
          truncated: fileStat.size > slice.length,
        });
        return asTextResult({
          path: filePath,
          encoding,
          size: fileStat.size,
          bytesRead: slice.length,
          truncated: fileStat.size > slice.length,
          content,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create, overwrite, or append to a file under LOCAL_CONTROL_ROOTS. Requires ALLOW_WRITES=1 and OAuth scope local.control or the fallback control_pin.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append"]).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        path: z.string(),
        mode: z.string(),
        bytesWritten: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Writing local file", "Local file write finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ path: requestedPath, content, mode = "create", control_pin }) => {
      try {
        requireCapability("writes", CONFIG.allowWrites, control_pin, authContext);
        const filePath = await resolveAllowedPath(requestedPath, { forWrite: true });

        if (mode === "create" && existsSync(filePath)) {
          throw new Error("Refusing to create because file already exists. Use mode=overwrite or append.");
        }

        await mkdir(path.dirname(filePath), { recursive: true });
        if (mode === "append") {
          await appendFile(filePath, content, "utf8");
        } else {
          await writeFile(filePath, content, { encoding: "utf8", flag: mode === "create" ? "wx" : "w" });
        }

        await audit({ tool: "write_file", path: filePath, mode, bytesWritten: Buffer.byteLength(content) });
        return asTextResult({
          path: filePath,
          mode,
          bytesWritten: Buffer.byteLength(content),
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run a local command without a shell. Requires ALLOW_SHELL=1 and OAuth scope local.control or the fallback control_pin. Uses SAFE_EXECUTABLES unless ALLOW_UNSAFE_SHELL=1.",
      inputSchema: {
        command: z.array(z.string()).min(1).describe("Executable and arguments, for example ['git', 'status', '--short']."),
        cwd: z.string().optional().describe("Working directory. Must be inside LOCAL_CONTROL_ROOTS."),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        cwd: z.string(),
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Running local command", "Local command finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ command, cwd, timeoutMs, control_pin }) => {
      try {
        requireCapability("shell", CONFIG.allowShell, control_pin, authContext);
        const result = await runCommandCapturingFailures(command, cwd, timeoutMs);
        await audit({ tool: "run_command", command, cwd: result.cwd, exitCode: result.exitCode });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "take_screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture the Mac screen and return it as an MCP image. Requires ALLOW_SCREENSHOT=1 and OAuth scope local.control or the fallback control_pin.",
      inputSchema: {
        control_pin: z.string().optional(),
      },
      outputSchema: {
        path: z.string(),
        mimeType: z.string(),
        size: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Taking screenshot", "Screenshot ready", CONTROL_SECURITY_SCHEMES),
    },
    async ({ control_pin }) => {
      try {
        requireCapability("screenshot", CONFIG.allowScreenshot, control_pin, authContext);
        await mkdir(path.join(ARTIFACT_DIR, "screenshots"), { recursive: true });
        const screenshotPath = path.join(
          ARTIFACT_DIR,
          "screenshots",
          `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
        );
        await execFileAsync("screencapture", ["-x", screenshotPath], { timeout: 15_000 });
        const image = await readFile(screenshotPath);
        const structured = {
          path: screenshotPath,
          mimeType: "image/png",
          size: image.length,
        };
        await audit({ tool: "take_screenshot", path: screenshotPath, size: image.length });
        return asTextResult(structured, `Screenshot captured: ${screenshotPath}`, [
          { type: "image", data: image.toString("base64"), mimeType: "image/png" },
        ]);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "open_target",
    {
      title: "Open target",
      description:
        "Open a URL, file, folder, or app with macOS open. Requires ALLOW_OPEN=1 and OAuth scope local.control or the fallback control_pin.",
      inputSchema: {
        target: z.string().min(1).describe("A URL, file path, folder path, or app name/path."),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        target: z.string(),
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Opening local target", "Local target opened", CONTROL_SECURITY_SCHEMES),
    },
    async ({ target, control_pin }) => {
      try {
        requireCapability("open", CONFIG.allowOpen, control_pin, authContext);
        const result = await execFileAsync("open", [expandHome(target)], { timeout: 15_000 });
        await audit({ tool: "open_target", target });
        return asTextResult({
          target,
          exitCode: 0,
          stdout: truncateText(result.stdout ?? ""),
          stderr: truncateText(result.stderr ?? ""),
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_applescript",
    {
      title: "Run AppleScript",
      description:
        "Run AppleScript for GUI automation. Requires ALLOW_APPLESCRIPT=1 and OAuth scope local.control or the fallback control_pin.",
      inputSchema: {
        script: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Running AppleScript", "AppleScript finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ script, timeoutMs, control_pin }) => {
      try {
        requireCapability("appleScript", CONFIG.allowAppleScript, control_pin, authContext);
        const result = await runAppleScript(script, timeoutMs);
        await audit({ tool: "run_applescript", scriptPreview: script.slice(0, 500), exitCode: result.exitCode });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  return server;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders(), ...headers });
  res.end(JSON.stringify(body, null, 2));
}

async function handleOAuthRegister(req, res) {
  let body = {};
  try {
    const text = await readRequestText(req);
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  sendJson(res, 201, {
    client_id: body.client_id || `chatgpt-${randomToken(12)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris || [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

function renderAuthorizePage(res, params, error = "") {
  const hidden = Object.entries(params)
    .filter(([key]) => key !== "approve" && key !== "approval_pin")
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join("\n");
  const pinField = CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin()
    ? `<label style="display:block;margin:16px 0 8px;">Authorization PIN</label>
      <input name="approval_pin" type="password" autocomplete="current-password" required style="font:inherit;width:100%;box-sizing:border-box;padding:10px 12px;">`
    : "";
  const errorMarkup = error ? `<p style="color:#b00020;">${htmlEscape(error)}</p>` : "";

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...corsHeaders() });
  res.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Local Mac Control</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 620px; margin: 48px auto; line-height: 1.5;">
    <h1>Authorize Local Mac Control</h1>
    <p>This grants ChatGPT permission to use local control tools such as writing files, running commands, taking screenshots, opening targets, and AppleScript automation. Read-only file tools do not require authorization.</p>
    ${errorMarkup}
    <form method="get" action="/oauth/authorize">
      ${hidden}
      <input type="hidden" name="approve" value="1">
      ${pinField}
      <button style="font: inherit; margin-top: 16px; padding: 10px 16px;">Authorize</button>
    </form>
  </body>
</html>`);
}

function handleOAuthAuthorize(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const required = ["client_id", "redirect_uri", "response_type", "state"];
  const missing = required.filter((name) => !params[name]);
  if (missing.length || params.response_type !== "code") {
    sendJson(res, 400, { error: "invalid_request", error_description: `Missing or invalid: ${missing.join(", ")}` });
    return;
  }

  if (url.searchParams.get("approve") !== "1") {
    renderAuthorizePage(res, params);
    return;
  }

  if (CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin()) {
    try {
      requirePin(url.searchParams.get("approval_pin") || "");
    } catch {
      renderAuthorizePage(res, params, "Invalid authorization PIN.");
      return;
    }
  }

  const requestedScopes = (params.scope || OAUTH_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const scopes = requestedScopes.filter((scope) => OAUTH_SCOPES.includes(scope));
  const code = randomToken(24);
  OAUTH_CODES.set(code, {
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    scopes: scopes.length ? scopes : OAUTH_SCOPES,
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS,
  });

  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", params.state);
  res.writeHead(302, { location: redirectUrl.href, ...corsHeaders() });
  res.end();
}

async function handleOAuthToken(req, res) {
  const text = await readRequestText(req);
  const params = new URLSearchParams(text);
  const grantType = params.get("grant_type");

  if (grantType !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const code = params.get("code") || "";
  const entry = OAUTH_CODES.get(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    OAUTH_CODES.delete(code);
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }

  if (params.get("redirect_uri") !== entry.redirectUri) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch." });
    return;
  }

  const verifier = params.get("code_verifier") || "";
  if (entry.codeChallengeMethod === "S256" && entry.codeChallenge && pkceChallenge(verifier) !== entry.codeChallenge) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
    return;
  }

  OAUTH_CODES.delete(code);
  const accessToken = randomToken(32);
  OAUTH_TOKENS.set(accessToken, {
    scopes: Array.from(new Set(entry.scopes)),
    expiresAt: Date.now() + CONFIG.oauthTokenTtlSeconds * 1000,
  });

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: CONFIG.oauthTokenTtlSeconds,
    scope: entry.scopes.join(" "),
  });
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  if (
    req.method === "OPTIONS" &&
    (url.pathname.startsWith(MCP_PATH) || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))
  ) {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      name: "chatgpt-local-control-mcp",
      ok: true,
      mcp: MCP_PATH,
      allowedRoots: ALLOWED_ROOTS,
      capabilities: {
        writes: CONFIG.allowWrites,
        shell: CONFIG.allowShell,
        screenshot: CONFIG.allowScreenshot,
        open: CONFIG.allowOpen,
        appleScript: CONFIG.allowAppleScript,
        readToolsRequireAuth: false,
        oauth: true,
        pinFallbackForControl: hasConfiguredControlPin(),
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      name: "chatgpt-local-control-mcp",
      mcpPath: MCP_PATH,
      allowedRoots: ALLOWED_ROOTS,
      oauth: true,
    });
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`)
  ) {
    sendJson(res, 200, protectedResourceMetadata(req));
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    sendJson(res, 200, oauthMetadata(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    await handleOAuthRegister(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    handleOAuthAuthorize(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await handleOAuthToken(req, res);
    return;
  }

  const allowedMcpMethods = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && allowedMcpMethods.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createLocalControlServer(authContextFromRequest(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`Local control MCP listening on http://localhost:${PORT}${MCP_PATH}`);
  console.log(`Allowed roots: ${ALLOWED_ROOTS.join(", ") || "(none)"}`);
  console.log("Use an HTTPS tunnel for ChatGPT connector setup.");
});
