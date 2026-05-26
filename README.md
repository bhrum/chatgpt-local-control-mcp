# ChatGPT Local Control MCP

这个项目提供一个本机 MCP server，让 ChatGPT 通过 MCP 连接这台 Mac，执行受限制的本机查看和控制操作。

默认是保守模式：读文件、列目录和查看状态不需要授权；写文件、运行命令、截图、打开 App、AppleScript GUI 自动化都必须在 `.env` 里显式开启，并且需要 ChatGPT 通过 OAuth 授权获得 `local.control` scope。`control_pin` 只保留为本地脚本 fallback，OAuth 授权页默认直接点击 Authorize 即可。

## 工具

- `computer_status`: 查看 MCP 服务状态、允许目录和能力开关。无需授权。
- `list_directory`: 列出 `LOCAL_CONTROL_ROOTS` 内的文件。无需授权。
- `read_file`: 读取 `LOCAL_CONTROL_ROOTS` 内的文件，默认最多 256KB。无需授权。
- `write_file`: 写入文件。需要 `ALLOW_WRITES=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_command`: 运行本机命令。需要 `ALLOW_SHELL=1`，以及 OAuth `local.control` 或 fallback `control_pin`。默认只允许 `SAFE_EXECUTABLES` 中的命令。
- `take_screenshot`: 截屏并把图片返回给 MCP 客户端。需要 `ALLOW_SCREENSHOT=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `open_target`: 用 macOS `open` 打开 URL、文件、目录或 App。需要 `ALLOW_OPEN=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_applescript`: 运行 AppleScript 做 GUI 自动化。需要 `ALLOW_APPLESCRIPT=1`、OAuth `local.control` 或 fallback `control_pin`，以及 macOS 辅助功能权限。

## 本地启动

```bash
npm install
cp .env.example .env
npm start
```

健康检查：

```bash
curl http://localhost:8787/
```

MCP smoke test：

```bash
npm run smoke
npm run smoke:oauth
```

## 连接 ChatGPT

OpenAI 官方文档要求 ChatGPT 能访问一个 HTTPS 的 `/mcp` 端点。本地开发可以用 Secure MCP Tunnel、ngrok 或 Cloudflare Tunnel。

一种常见开发流程：

```bash
npm start
ngrok http 8787
```

然后在 ChatGPT 中进入 `Settings -> Connectors -> Create`，填写：

- Connector name: `Local Mac Control`
- Description: `Controls my Mac through a guarded local MCP server. Use only when I explicitly ask.`
- Connector URL: `https://你的隧道域名/mcp`
- Authentication: `OAuth`

ChatGPT 会打开本服务的 OAuth 授权页。点击 Authorize 后，ChatGPT 会获得 `local.control` access token。之后写文件、命令、截图、打开 App、AppleScript 等工具不需要在聊天里再发送 PIN。

读工具声明为 `noauth`，所以 `computer_status`、`list_directory`、`read_file` 不需要授权。不要把这个 MCP 暴露给不可信用户。

## 安全建议

- `LOCAL_CONTROL_ROOTS` 越窄越好。默认只给当前项目目录。
- 不要长期打开 ngrok/Cloudflare Tunnel。
- 不要把 `ALLOW_UNSAFE_SHELL=1` 当成常驻配置。
- 如需让 OAuth 授权页也要求 fallback PIN，可设置 `OAUTH_REQUIRE_APPROVAL_PIN=1`。
- 当前 OAuth token 存在内存里，服务重启后需要在 ChatGPT 里重新授权。
- 所有特权工具调用会写入 `.mcp-audit/events.jsonl` 方便追踪。

## 常用配置

只允许 ChatGPT 读当前项目：

```env
ALLOW_WRITES=0
ALLOW_SHELL=0
ALLOW_SCREENSHOT=0
ALLOW_OPEN=0
ALLOW_APPLESCRIPT=0
```

允许在项目目录内写文件：

```env
ALLOW_WRITES=1
LOCAL_CONTROL_PIN=一段很长的随机字符串
```

允许有限命令执行：

```env
ALLOW_SHELL=1
SAFE_EXECUTABLES=pwd,ls,find,cat,head,tail,wc,git,node,npm,python3,rg
LOCAL_CONTROL_PIN=一段很长的随机字符串
```

允许 GUI 自动化：

```env
ALLOW_SCREENSHOT=1
ALLOW_OPEN=1
ALLOW_APPLESCRIPT=1
LOCAL_CONTROL_PIN=一段很长的随机字符串
```

macOS 第一次运行 AppleScript GUI 控制时，可能需要到 `System Settings -> Privacy & Security -> Accessibility` 给 Terminal、Codex 或 Node 授权。
