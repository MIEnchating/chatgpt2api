# 画布 Codex 与 MCP 本地服务

此目录为独立的 Node.js 本地服务，无 npm 依赖。画布页面通过本机 HTTP 连接服务，再使用 Codex 官方 app-server 的 stdio 协议。当前实现按 Codex CLI 0.154.0 的 schema 校验；动态工具接口属于官方 experimental API，升级 CLI 后应先执行下面的验证。

## 运行

需要 Node.js 22 或更高版本，以及已安装并登录的 Codex CLI：

```bash
codex --version
codex login
node canvas-agent/server.mjs --origin http://127.0.0.1:8002
```

`--origin` 必须与实际画布网页的地址一致，包括协议、主机和端口。可以重复提供多个明确的 Origin。线上网页可填写其 HTTPS Origin；浏览器可能要求允许访问本地网络。

默认只监听 `127.0.0.1:3210`。启动前请先检查该端口和已有进程；已有同用途服务应直接复用。端口被其他服务使用时，明确为本地画布桥选择一个空闲端口，例如：

```bash
node canvas-agent/server.mjs --origin http://127.0.0.1:8002 --port 3211
```

若 Codex 可执行文件不在 PATH，使用 `--codex-bin` 指定实际可执行文件。Windows 下应指向官方 `codex.exe`，不使用 `.cmd` 脚本：

```powershell
node canvas-agent/server.mjs --origin http://127.0.0.1:8002 --codex-bin "C:\Tools\codex.exe"
```

打开画布的 Agent 面板，将引擎切换为 Codex，填写本地服务地址和终端显示的连接密钥。连接后选择 Codex 模型及思考强度，即可使用现有画布工具、Skill、素材引用和媒体生成开关。当前登录画布账号的权限与密钥继续由 Go 后端处理；本地服务不接收网页 Cookie。

连接密钥仅保留在页面内存中，刷新后需要重新连接。同一个本地服务运行期间，原对话会恢复已有 Codex 任务；服务重新启动后会以当前画布、创作状态和记忆摘要开启新任务。Codex 自身负责其任务历史和压缩。切换引擎时，两种引擎各自保留协议历史，不会自动转换另一引擎的全部消息。

关闭页面、退出账号或断开连接会停止对应的 Codex 子进程及待确认工具；已提交的媒体生成任务仍由现有后端处理。结束使用后在运行服务的终端按 Ctrl+C。

## 外部 MCP 连接

连接后点击“复制 MCP 连接 ID”。将以下服务添加到支持 stdio MCP 的客户端，路径须替换为此仓库的绝对路径，环境变量值须替换为当前本地服务及画布连接的信息：

```json
{
  "mcpServers": {
    "chatgpt2api-canvas": {
      "command": "node",
      "args": ["/absolute/path/chatgpt2api/canvas-agent/mcp.mjs"],
      "env": {
        "CANVAS_AGENT_URL": "http://127.0.0.1:3210",
        "CANVAS_AGENT_TOKEN": "<terminal-connection-token>",
        "CANVAS_AGENT_SESSION_ID": "<canvas-connection-id>"
      }
    }
  }
}
```

Codex 的 TOML 配置示例：

```toml
[mcp_servers.chatgpt2api_canvas]
command = "node"
args = ["/absolute/path/chatgpt2api/canvas-agent/mcp.mjs"]

[mcp_servers.chatgpt2api_canvas.env]
CANVAS_AGENT_URL = "http://127.0.0.1:3210"
CANVAS_AGENT_TOKEN = "<terminal-connection-token>"
CANVAS_AGENT_SESSION_ID = "<canvas-connection-id>"
```

此 MCP 采用 `2025-06-18` 协议版本。读取操作直接交给已登录页面，创建、编辑、删除、生成等操作必须在该页面确认。面板 Agent 正在运行时不接受外部 MCP 操作；确认后仍遵守当前画布的自动生成开关；关闭时只创建媒体节点，不提交生成任务；开启时在后端确认提交后立即返回节点和任务标识，可再调用状态工具查询进度。已提交的生成任务由节点独立管理，停止 Codex 不会删除这些任务。Skill 附件和 Agent 内部状态工具仅用于面板内的当前 Codex 运行，不提供给外部 MCP。

网页必须保持打开；重新连接后需要更新连接 ID。本地连接密钥不可提交到仓库、分享或写入公共配置。此服务没有公网监听、自动启动或浏览器 Cookie 转发能力。

## Codex 插件封装

本目录也可作为本地 Codex 插件：`.codex-plugin/plugin.json` 声明连接 Skill 和 `.mcp.json`，MCP 从插件根目录启动同一个 `mcp.mjs`。插件和上面的手动 MCP 配置选择一种，避免重复注册。

将整个 `canvas-agent` 目录加入自己的本地插件市场后安装 `canvas-agent@<市场名>`，再新建 Codex 任务。插件不会修改账号配置或自动安装全局服务。个人市场的一种配置是将此目录复制到 `~/plugins/canvas-agent`，并在 `~/.agents/plugins/marketplace.json` 的 `plugins` 数组加入下面的条目；Windows 对应用户目录。若文件尚不存在，外层使用 `{"name":"personal","plugins":[下面的条目]}`；已有文件应保留原市场名称和其他条目。

```json
{
  "name": "canvas-agent",
  "source": { "source": "local", "path": "./plugins/canvas-agent" },
  "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
  "category": "Productivity"
}
```

个人市场名为 `personal` 时执行 `codex plugin add canvas-agent@personal`。安装前在启动 Codex 的本机环境设置 `CANVAS_AGENT_URL`、`CANVAS_AGENT_TOKEN`、`CANVAS_AGENT_SESSION_ID`；它们由 MCP 的 `env_vars` 显式传入，不写在插件中。没有这些值时按上文先连接网页，设置后重启 MCP 客户端。

说“连接我的云棉画布”会使用 `connect-canvas` Skill，复用或打开目标页面并验证连接。网页登录和浏览器本地网络授权沿用正常流程。当前交付插件源码，未安装到用户的全局市场，也未发布到公共市场。格式和安装步骤见 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。

## 验证

```bash
node --test canvas-agent/test/*.test.mjs
cd web
bun test tests/canvas-codex.test.mjs
npm run build
npm run lint
```

Node 测试只启动可追踪的随机本机端口，使用模拟 Codex 客户端，结束后关闭。单元测试不调用付费模型；实际模型请求需在已登录的画布中手工验证。

官方协议参考：[Codex app-server](https://developers.openai.com/codex/app-server/)。
