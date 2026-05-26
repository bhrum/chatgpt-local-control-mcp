# ChatGPT Local Control MCP

这个项目提供一个本机 MCP server，让 ChatGPT 通过 HTTPS MCP Connector 连接并控制这台电脑。服务默认是保守模式：读文件、列目录和查看状态不需要授权；写文件、运行命令、截屏、打开应用、GUI 键鼠控制等高权限能力必须在 `.env` 中显式开启，并且需要 ChatGPT 通过 OAuth 获得 `local.control` scope，或在工具参数里提供 fallback `control_pin`。

目前支持：

- macOS：文件、命令、截屏、`open_target`、AppleScript。
- Windows：文件、命令、PowerShell、截屏、`open_target`、鼠标移动/点击、按键、文本输入。

## 工具

- `computer_status`: 查看服务状态、允许目录和能力开关。无须授权。
- `list_directory`: 列出 `LOCAL_CONTROL_ROOTS` 内的文件。无须授权。
- `read_file`: 读取 `LOCAL_CONTROL_ROOTS` 内的文件，默认最大 256KB。无须授权。
- `write_file`: 写入文件。需要 `ALLOW_WRITES=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_command`: 运行本机命令。需要 `ALLOW_SHELL=1`，以及 OAuth `local.control` 或 fallback `control_pin`。默认只允许 `SAFE_EXECUTABLES` 中的可执行文件。
- `run_powershell`: 在 Windows 运行 PowerShell 脚本。需要 `ALLOW_SHELL=1`、`ALLOW_UNSAFE_SHELL=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `take_screenshot`: 截屏并把图片返回给 MCP 客户端。需要 `ALLOW_SCREENSHOT=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `open_target`: 打开 URL、文件、目录或应用。需要 `ALLOW_OPEN=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_applescript`: 在 macOS 运行 AppleScript 做 GUI 自动化。需要 `ALLOW_APPLESCRIPT=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `get_cursor_position`: Windows 下读取当前鼠标坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `move_mouse`: Windows 下移动鼠标到屏幕坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `mouse_click`: Windows 下点击屏幕坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `press_keys`: Windows 下按键，例如 `["CTRL","L"]`、`["ALT","TAB"]`、`["WIN","R"]`。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `type_text`: Windows 下把文本粘贴到当前活动应用。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。

## 本地启动

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
npm start
```

健康检查：

```bash
curl http://localhost:8787/
npm run smoke
npm run smoke:oauth
```

## Windows 完整控制配置示例

只在你信任当前 ChatGPT 会话时临时使用这种配置。`ALLOW_UNSAFE_SHELL=1` 和 `ALLOW_GUI=1` 代表 ChatGPT 可以通过 PowerShell、键盘和鼠标对电脑做真实操作。

```env
PORT=8787
MCP_PATH=/mcp
LOCAL_CONTROL_ROOTS=C:\Users\你的用户名
LOCAL_CONTROL_PIN=换成一段很长的随机字符串

OAUTH_TOKEN_TTL_SECONDS=86400
OAUTH_REQUIRE_APPROVAL_PIN=0

ALLOW_WRITES=1
ALLOW_SHELL=1
ALLOW_UNSAFE_SHELL=1
ALLOW_SCREENSHOT=1
ALLOW_OPEN=1
ALLOW_GUI=1
ALLOW_APPLESCRIPT=0
```

如果需要多个允许目录，Windows 用分号分隔：

```env
LOCAL_CONTROL_ROOTS=C:\Users\你;D:\Projects
```

## HTTPS tunnel

ChatGPT Connector 需要能访问 HTTPS 的 `/mcp` 地址。本地开发可以用 Cloudflare Tunnel、ngrok 或其他 HTTPS 隧道。

如果已经安装 `cloudflared`：

```bash
npm run tunnel
```

脚本会把最新地址写入：

- `.mcp-artifacts/tunnel-origin.txt`
- `.mcp-artifacts/tunnel-url.txt`

`tunnel-url.txt` 里的值就是 ChatGPT Connector URL，例如：

```text
https://example.trycloudflare.com/mcp
```

Cloudflare quick tunnel 不保证域名永久固定。如果电脑重启或 tunnel 重新创建，需要在 ChatGPT 应用设置里更新 Connector URL。长期使用请配置 Cloudflare named tunnel 或自己的固定域名。

## 连接 ChatGPT

在 ChatGPT 中进入 `Settings -> Connectors -> Create`，填写：

- Connector name: `Local Computer Control`
- Description: `Controls my local computer through a guarded MCP server. Use only when I explicitly ask.`
- Connector URL: `https://你的隧道域名/mcp`
- Authentication: `OAuth`

ChatGPT 会打开本服务的 OAuth 授权页。点击 `Authorize` 后，ChatGPT 会获得 `local.control` access token。之后写文件、运行命令、截屏、打开应用和 GUI 控制工具不需要在聊天里再次发送 PIN。

## macOS 常驻运行

仓库仍保留 launchd 脚本：

```bash
npm run service:install
npm run service:status
npm run service:uninstall
```

这会创建用户级 LaunchAgent，分别运行本机 MCP 服务和 Cloudflare tunnel。

macOS 第一次运行 AppleScript GUI 控制时，可能需要到 `System Settings -> Privacy & Security -> Accessibility` 给 Terminal、Codex 或 Node 授权。

## 安全建议

- `LOCAL_CONTROL_ROOTS` 越窄越好。只开放确实需要 ChatGPT 读写的目录。
- 不要把 `ALLOW_UNSAFE_SHELL=1` 当成长期常驻配置。
- 不要把公开 tunnel 暴露给不可信用户。
- 如需 OAuth 授权页也要求 fallback PIN，可设置 `OAUTH_REQUIRE_APPROVAL_PIN=1`。
- 当前 OAuth token 存在内存里，服务重启后需要在 ChatGPT 里重新授权。
- 所有高权限工具调用都会写入 `.mcp-audit/events.jsonl`，方便追踪。
