# dsh Codex

[English](README.md) | 中文

DSH 0.2.1-rc.2 配套版本为本地 bundle 0.2.10。模型与工具偏好使用官方 storage domain，首次导入旧 settings 文档，保留原文件；PTC 图片补充上下文由官方工具调度器统一生成，Responses 原生压缩使用 pi-ai 的规范化 transcript。

该版本独立锁定 pi-ai 1.4.0，使用上游目录中的 GPT-6.1 Sol；DSH 自带适配器保留自己的 pi-ai 1.3.0 依赖，插件只通过静态 Provider 的公开接口跨过版本边界。图片发现使用统一模型目录，路由别名同时保留聊天与图片模型的身份。同源认证接口 `GET /plugins/dsh-openai-codex/components` 返回运行中 bundle/依赖版本、静态模型 ID 和持久化设置就绪状态，用于部署核对。设置消费者同时声明存储 hub 和 domain 服务，保证真实 Host 环境中模型、图片与出口偏好能够保存。

本目录移除 `gpt-5.3-codex-spark` 和 `gpt-5.5`；历史仍可读取，但继续请求已退役模型时需选择当前可用模型。插件的 zod 固定为与 DSH storage-domain API 一致的 4.4.3，保留严格 schema 类型检查，避免跨版本类型递归展开。空的 invariant companion 随 DSH 已退役接口一并删除。

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中连接订阅 Provider，无需修改 DSH。bundle 包含 pi-ai 的 OpenAI Codex、xAI，以及来自 `@kelvinwww/dsh-oauth` 的 Google Code Assist OAuth。

`dsh-codex` 是一个独立的 dsh bundle，提供：

- 在 dsh 设置面板或独立 CLI 中完成 ChatGPT OAuth 登录，并自动刷新 token
- 通过 pi-ai 1.4.0 使用 OpenAI Codex OAuth 与模型目录（含 GPT-6.1 Sol 与 GPT-6 Astra）
- 通过同一版 pi-ai 原生 OAuth 使用 SuperGrok/X Premium 与 xAI 模型目录（含 Grok 4.6）
- 通过 `@kelvinwww/dsh-oauth` 使用 Google OAuth 与 Gemini Code Assist
- Codex GPT 模型目录；账号提供视觉模型时自动声明其图片输入能力
- 经标准 LLM 服务运行的流式响应、工具调用、推理回放、提示词缓存与 dsh 压缩
- 通过 dsh 现有 `web_search` 工具使用 Codex 独立联网搜索
- 为 Harness 现有 `read_image` 工具增加可选的 HTTP(S) URL 输入
- Provider 原生 `imagegen`：Codex 使用 `gpt-image-2`，xAI 使用 Grok Imagine 2.0 / Quality
- 复用 dsh Web 输入框的粘贴和拖放图片能力

ChatGPT 订阅认证与按量计费的 OpenAI API 是不同产品。本插件只使用 ChatGPT Codex 后端，不会把订阅转换成通用 OpenAI API 凭据。

## 安装

每个 Provider 子页的“对话模型”可选择聊天框显示哪些模型，并分别设置上下文窗口和最大输出 tokens。留空使用默认值，保存后对后续请求生效；隐藏不影响已有会话。Codex 后端不执行标准的输出长度上限参数。

从 npm 把预构建 bundle 安装到选定的 dsh profile：

```sh
dsh plugin --profile web add dsh-codex
dsh web
```

从 DeepSeek Harness 源码 checkout 运行时，使用 `pnpm dsh plugin --profile web add dsh-codex`。开发插件时仍可用 `link:/absolute/path/to/dsh-codex` 安装本地 checkout。

打开 **设置 → Provider**，选择 OpenAI Codex、xAI 或 Google OAuth，再在各自子页登录。Google 需要配置 `GEMINI_CLIENT_ID` 和 `GEMINI_CLIENT_SECRET`；非免费 Code Assist 还需要 `GOOGLE_CLOUD_PROJECT` 或 `GOOGLE_CLOUD_PROJECT_ID`。Google 使用动态本机回调端口，因此 iPhone 部署应在 iPhone Safari 中完成授权；通过 Mac 的 USB `3081` 页面发起授权时，回调会落到 Mac 而不是手机。

终端和无界面环境仍可使用 CLI：

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex login --device-code
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex logout
```

在 `dsh-tui` 中使用时，把 bundle 安装到同一个 profile：

```sh
dsh plugin --profile dsh-tui add dsh-codex
```

重新启动 TUI 后，`/model` 会列出 `provider-codex` 的模型；profile 保留自己的默认模型，直到用户选择新的 Provider 模型。`/codex status|login|logout|usage|config` 用于管理账号与查看配置，四个布尔开关可通过 `/codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>` 修改。浏览器登录完成后，凭据与 Web profile 共用同一份 dsh 凭据文件。

Codex、Claude Code 及其他自动化 agent 应直接遵循 [INSTALL.md](INSTALL.md)。它是一份完整且可重复执行的 runbook，不要求安装者阅读源码或设计文档。

bundle 提供 `provider-codex`、`provider-xai` 和 `provider-google` 订阅路由。模型页的 API Key 路由保持 `openai-codex`、`xai` 等原名；登录对应 Provider 后，其 OAuth 模型才会加入聊天模型选择器。profile 保留原有默认模型，已保存的会话选择仍然优先；Web 搜索使用 `provider-codex`。

## Provider VLESS 分流

在已经安装 `com.xxzzddxzd.dsh-vless` 的 iPhone 构建上，先在 **设置 → VLESS** 配置并测试节点，再进入 **设置 → Provider** 的任一子页选择直连或 VLESS。三个 Provider 独立保存出口；替换节点不会改动这些选择。含凭据的配置以 `0600` 权限保存在 `/var/root/.config/dsh-vless/config.json`，浏览器只能读取脱敏节点名称与健康状态。

分流只匹配当前 Provider 的服务域名：OpenAI／ChatGPT、xAI 与 Google 各自服从自己的选择。DeepSeek、任意 `read_image` URL，以及 Bash／Python 子进程仍保持直连。Google 的 OAuth 换码、token 刷新、模型发现和生成请求共用 Google 子页的出口。

## 图片

图片功能使用 dsh 的持久附件路径：

- 在 Web 输入框中按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴图片，或把图片拖入输入框；
- 在 Windows 上的适配版 dsh-tui 按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 粘贴剪贴板图片，或输入 `@相对/图片.png`；剪贴板图片直接进入附件库，路径图片由当前 workspace 的文件系统读取；
- 让模型调用 `read_image`：工作区图片使用 `file_path`，HTTP(S) 图片使用 `url`；
- 在当前 dsh 附件限制内支持 PNG、JPEG、WebP 与 GIF；
- 只有明确声明支持图片输入的模型才能接收图片。

任何支持视觉输入的当前对话模型都可以使用 `imagegen`。Codex 会话使用 `gpt-image-2`；xAI 会话使用 **设置 → Provider → xAI** 中选择的 Grok Imagine 模型。当前 pi-ai 目录提供 Imagine Image 2.0 与 Imagine Image Quality。xAI 编辑最多支持三张参考图，Codex 最多五张。每个结果都会直接显示、保存为持久附件，并按检测到的 PNG／JPEG／WebP／GIF 扩展名写入当前工作区。

设置页提供独立的 **增强 read_image** 与 **允许其他模型使用生图** 开关，默认均为开启。关闭第一项会撤销插件的 agent-scope 覆盖，恢复 Harness 原本只接受本地路径的 `read_image` Schema。关闭第二项后，Codex 视觉模型仍可使用 `imagegen`，其他模型提供方的调用会在执行入口被拒绝。

`read_image` 在返回实际图片块之前，会先验证图片并把字节持久化为 dsh 附件。本地路径原样委托给 Harness，继续沿用当前文件系统和沙箱行为；URL 扩展会限制重定向次数与下载字节数，也不允许嵌入凭据。

## 搜索

提供方会把 dsh 的 `web_search` 工具连接到 Codex 使用的独立搜索协议。搜索结果是普通 dsh 文本和 HTTP(S) 引用，因此后续轮次与压缩会保留同一份工具历史。

在 profile patch 中配置 `llm-openai-codex`：

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
    searchContextSize: medium
```

| 字段 | 默认值 | 可选值 |
|---|---:|---|
| `searchModel` | `gpt-5.6-sol` | Codex 模型 id |
| `searchMode` | `cached` | `cached`、`indexed`、`live` |
| `searchContextSize` | `medium` | `low`、`medium`、`high` |
| `searchMaxOutputTokens` | `10000` | 正整数 |

每个已经解析默认值且不含凭据的辅助请求，都会在发送前记录为专用的 `web/openai-codex-search-llm-request` 会话事件。该事件由本插件拥有并注册，不需要通用搜索事件或 dsh fork。

## Responses API 实验功能

设置页提供两个默认关闭、仅作用于 `openai-codex` 的开关：

- **WebSocket 上下文复用**：保持 `store: false`，并选择 pi-ai 的 Codex WebSocket continuation 传输。同一会话继续复用连接，且下一轮与已有上下文严格衔接时，请求会通过 `previous_response_id` 只发送新增输入；历史改写、压缩、Fork、连接中断或进程重启后会自动发送完整上下文。关闭开关时，普通轮次使用 SSE，每次都发送 Harness 完整上下文。
- **原生 Responses 压缩**：按 Codex 当前的 V2 流程，把现有历史和一个 `compaction_trigger` item 发给 `codex/responses`。近期客户端消息与返回的加密 compaction item 会一起保存在 Harness 检查点中，并在后续 Codex 请求发送前还原；关闭开关不会破坏已经生成的检查点。V2 压缩不可用或请求失败时，同一次调用会自动回退到原来的 Harness 模型摘要。

两个开关互相独立。所有普通 Codex 请求都保持 `store: false`；默认配置使用 SSE 和 `dsh-compaction-basic` 的文本摘要路径。

## 凭据与隐私

dsh 登录与 Codex CLI／Desktop 相互独立：

- 凭据存储于 `$DSH_HOME/.openai-codex-auth.json`，默认位于 `~/.dsh`；
- 文件原子写入，token 刷新会在本地 dsh 进程之间加锁；
- 浏览器状态和诊断不会返回 token 值；
- 绝不复制或修改 `~/.codex/auth.json`。

分离存储可以避免两个客户端竞争同一个会轮换的 refresh token。移除 bundle 不会删除凭据；需要移除本地账号时，请使用账号页面或 `logout` 命令。

## 兼容性说明

- 插件只使用已发布的 dsh 插件表层，不要求修改版 Harness checkout。单独安装时即可生成附件并保存本地输出。
- ChatGPT 套餐资格、模型权限、配额及后端行为由 OpenAI 控制，可能发生变化。
- Codex 端点不执行普通 Responses 的 `max_output_tokens` 字段。压缩可以工作，但该路由无法在服务端落实配置的摘要上限。
- 文件系统、shell、skills、MCP、subagents、权限、附件、压缩和 `web_search` 工具本身仍来自当前 dsh profile。
- bundle 锁定 pi-ai `1.4.0`，OpenAI Codex、xAI 对话与图片设置严格采用该版本目录。
- 独立搜索端点不是公开的 OpenAI Platform API；兼容性取决于固定版本的 Codex／pi-ai 实现。

协议、持久化与生命周期细节见[设计文档](docs/design.zh.md)。

## 开发

```sh
pnpm install
pnpm run check
```

该检查会执行严格的 Host 与浏览器 TypeScript 检查、聚焦测试以及两个运行时 bundle 的构建。

## 许可证

Apache-2.0
