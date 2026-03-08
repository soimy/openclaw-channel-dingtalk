# DingTalk Channel for OpenClaw

钉钉企业内部机器人 Channel 插件，使用 Stream 模式（无需公网 IP）。

> [!IMPORTANT]
> **重要声明（上游消息丢失问题进展更新）**
>
> 根据 issue [#104](https://github.com/soimy/openclaw-channel-dingtalk/issues/104) 今日最新反馈，钉钉侧服务扩容后，`dingtalk-stream` 模式下的消息丢失情况已有明显改善。
> 当前我们将继续保持观测与验证：若你在生产或测试环境使用本插件，欢迎重点关注“消息到达率、延迟、缺失 ID 对账”等指标，并在 #104 持续回报测试结果与样本日志，帮助社区共同确认改善效果是否稳定收敛。
>
> 相关信息：
> - issue 讨论：[#104](https://github.com/soimy/openclaw-channel-dingtalk/issues/104)
> - 最小可复现说明（SDK 侧）：<https://github.com/soimy/dingtalk-stream-sdk-nodejs/blob/main/docs/inbound-msg-missing-repro.zh-CN.md>
> - 插件侧测试分支：[`test/inbound-msg-missing`](https://github.com/soimy/openclaw-channel-dingtalk/tree/test/inbound-msg-missing)
>
> 在问题完全确认收敛前，关键业务场景仍建议保持重试与可观测性（trace 前缀、计数日志、缺失 ID 对账）。

## 功能特性

- ✅ **Stream 模式** — WebSocket 长连接，无需公网 IP 或 Webhook
- ✅ **私聊支持** — 直接与机器人对话
- ✅ **群聊支持** — 在群里 @机器人
- ✅ **多种消息类型** — 文本、图片、语音（自带识别）、视频、文件
- ✅ **引用消息支持** — 支持恢复大多数引用场景（文字/图片/文件/视频/语音/AI 卡片），部分依赖本地缓存或时间匹配，失败时降级为提示文本
- ✅ **Markdown 回复** — 支持富文本格式回复
- ✅ **互动卡片** — 支持流式更新，适用于 AI 实时输出
- ✅ **完整 AI 对话** — 接入 Clawdbot 消息处理管道

### 进程级（memory-only）运行态说明

以下命名空间/状态刻意保持为**仅进程内内存态**，不会进行磁盘持久化：

- `dedup.processed-message`（消息去重窗口）
- `session.lock`（同 session 串行锁）
- `channel.inflight`（gateway in-flight 防重锁）

这样设计是为了保证并发控制语义简单且可预期，避免跨进程/重启后引入锁状态不一致问题。

## 安装

### 方法 A：通过 npm 包安装 (推荐)

手动通过 npm 包名安装：

```bash
openclaw plugins install @soimy/dingtalk
```

### 方法 B：通过本地源码安装

如果你想对插件进行二次开发，可以先克隆仓库：

```bash
# 1. 克隆仓库
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk

# 2. 安装依赖 (必需)
npm install

# 3. 以链接模式安装 (方便修改代码后实时生效)
openclaw plugins install -l .
```

### 方法 C：手动安装

1. 将本目录下载或复制到 `~/.openclaw/extensions/dingtalk`。
2. 确保包含 `index.ts`, `openclaw.plugin.json` 和 `package.json`。
3. 运行 `openclaw plugins list` 确认 `dingtalk` 已显示在列表中。

### 方法 D：国内网络环境安装（npm 镜像源）

如果你在国内网络环境下执行 `openclaw plugins install @soimy/dingtalk` 时卡在 `Installing plugin dependencies...` 或出现 `npm install failed`，可临时为该次安装指定镜像源：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins install @soimy/dingtalk
```

如果插件已处于半安装状态（例如扩展目录存在但依赖未装全），可进入插件目录手动补装依赖：

```bash
cd ~/.openclaw/extensions/dingtalk
rm -rf node_modules package-lock.json
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com npm install
```

如果希望长期生效，可设置 npm 默认镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

或写入 `~/.npmrc`：

```ini
registry=https://registry.npmmirror.com
```

> 说明：
> - 临时环境变量方式仅对当前命令生效，不会污染全局配置。
> - 若 OpenClaw 运行在 systemd / Docker 等服务环境，请在对应服务环境变量中配置 `NPM_CONFIG_REGISTRY`。
> - 相关背景可参考 issue [#216](https://github.com/soimy/openclaw-channel-dingtalk/issues/216)。

### 安装后必做：配置插件信任白名单（`plugins.allow`）

从 OpenClaw 新版本开始，如果发现了非内置插件且 `plugins.allow` 为空，会提示：

```text
[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load ...
```

这是一条安全告警（不是安装失败），建议显式写入你信任的插件 id。

#### 步骤 1：确认插件 id

本插件 id 固定为：`dingtalk`（定义于 `openclaw.plugin.json`）。

也可用下面命令查看已发现插件：

```bash
openclaw plugins list
```

#### 步骤 2：在 `~/.openclaw/openclaw.json` 添加 `plugins.allow`

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  }
}
```

如果你还有其他已安装且需要启用的插件，请一并加入，例如：

```json5
{
  "plugins": {
    "allow": ["dingtalk", "telegram", "voice-call"]
  }
}
```

#### 步骤 3：重启 Gateway

```bash
openclaw gateway restart
```

> 注意：如果你之前已经配置过 `plugins.allow`，但没有 `dingtalk`，那么插件不会被加载。请把 `dingtalk` 加入该列表。

## 更新

`openclaw plugins update` 使用插件 id（不是 npm 包名），并且仅适用于 npm 安装来源。

如果你是通过 npm 安装本插件：

```bash
openclaw plugins update dingtalk
```

国内网络环境可临时指定镜像源后再更新：

```bash
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com openclaw plugins update dingtalk
```

如果插件已处于半安装状态（例如扩展目录存在但依赖未装全），可进入插件目录手动补装依赖：

```bash
cd ~/.openclaw/extensions/dingtalk
rm -rf node_modules package-lock.json
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com npm install
```

如果你是本地源码/链接安装（`openclaw plugins install -l .`），请在插件目录更新代码后重启 Gateway：

```bash
git pull
openclaw gateway restart
```

## 配置

OpenClaw 支持**交互式配置**和**手动配置文件**两种方式。

### 方法 1：交互式配置（推荐）

使用 OpenClaw 命令行向导式配置插件参数：

```bash
# 方式 A：使用 onboard 命令
openclaw onboard

# 方式 B：直接配置 channels 部分
openclaw configure --section channels
```

交互式配置流程：

1. **选择插件** — 在插件列表中选择 `dingtalk` 或 `DingTalk (钉钉)`
2. **Client ID** — 输入钉钉应用的 AppKey
3. **Client Secret** — 输入钉钉应用的 AppSecret
4. **完整配置** — 可选配置 Robot Code、Corp ID、Agent ID（推荐）
5. **卡片模式** — 可选启用 AI 互动卡片模式
   - 如启用，需输入 Card Template ID 和 Card Template Key
6. **私聊策略** — 选择 `open`（开放）或 `allowlist`（白名单）
7. **群聊策略** — 选择 `open`（开放）或 `allowlist`（白名单）

> 所有的参数参考下文中的钉钉开发者平台配置指南

配置完成后会自动保存并重启 Gateway。

---

#### 钉钉开发者平台配置指南

##### 1. 创建钉钉应用

1. 访问 [钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 创建企业内部应用
3. 添加「机器人」能力
4. 配置消息接收模式为 **Stream 模式**
5. 发布应用

##### 2. 配置权限管理

在应用的权限管理页面，需要开启以下权限：

- ✅ **Card.Instance.Write** — 创建和投放卡片实例
- ✅ **Card.Streaming.Write** — 对卡片进行流式更新
- ✅ **机器人消息发送相关权限** — 允许机器人向单聊/群聊发送消息
- ✅ **媒体文件上传相关权限** — 允许调用媒体上传接口发送图片、语音、视频、文件

以下权限仅在需要**引用消息中的群文件下载**时开通（群聊中引用文件/视频/语音）：

- ✅ **ConvFile.Space.Read** — 群文件空间读权限
- ✅ **Storage.File.Read** — 企业存储文件读权限
- ✅ **Storage.DownloadInfo.Read** — 企业存储文件下载信息读权限
- ✅ **Contact.User.Read** — 通讯录用户信息读权限（senderStaffId → unionId 转换）

**步骤：**

1. 进入应用 → 权限管理
2. 搜索「Card」相关权限
3. 勾选上述两个权限
4. 保存权限配置

##### 3. 建立卡片模板(可选)

**步骤：**

1. 访问 [钉钉卡片平台](https://open-dev.dingtalk.com/fe/card)
2. 进入「我的模板」
3. 点击「创建模板」
4. 卡片模板场景选择 **「AI 卡片」**
5. 按需设计卡片排版,点击保存并发布
6. 记下模板中定义的内容字段名称
7. 复制模板 ID（格式如：`xxxxx-xxxxx-xxxxx.schema`）
8. 将 templateId 配置到 `openclaw.json` 的 `cardTemplateId` 字段
9. 或在OpenClaw控制台的Channel标签->Dingtalk配置面板-> Card Template Id填入
10. 将记下的内容字段变量名配置到 `openclaw.json` 的 `cardTemplateKey` 字段
11. 或在OpenClaw控制台的Channel标签->Dingtalk配置面板-> Card Template Key填入

**说明：**

- 使用 DingTalk 官方 AI 卡片模板时，`cardTemplateKey` 默认为 `'content'`，无需修改
- 如果您创建自定义卡片模板，需要确保模板中包含相应的内容字段，并将 `cardTemplateKey` 配置为该字段名称

##### 4. 获取凭证

从开发者后台获取：

- **Client ID** (AppKey)
- **Client Secret** (AppSecret)
- **Robot Code** (与 Client ID 相同)
- **Corp ID** (企业 ID)
- **Agent ID** (应用 ID)

### 方法 2：手动配置文件

在 `~/.openclaw/openclaw.json` 中添加（仅作参考，交互式配置会自动生成）：

> 至少包含 `plugins.allow` 和 `channels.dingtalk` 两部分，内容参考上文钉钉开发者配置指南

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  },

  ...
  "channels": {
    "telegram": { ... },

    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "robotCode": "dingxxxxxx",
      "corpId": "dingxxxxxx",
      "agentId": "123456789",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "showThinking": true, // 仅 markdown 模式生效
      "thinkingMessage": "🤔 思考中，请稍候...", // 仅 markdown 模式生效
      "debug": false,
      "messageType": "markdown", // 或 "card"
      // "mediaMaxMb": 20,  // 可选：接收文件大小上限（MB），默认 5 MB
      // 仅card需要配置
      "cardTemplateId": "你复制的模板ID",
      "cardTemplateKey": "你模板的内容变量"
    }
  },
  ...
}
```

最后重启 Gateway

> 使用交互式配置时，Gateway 会自动重启。使用手动配置时需要手动执行：

```bash
openclaw gateway restart
```

## 配置选项

| 选项                    | 类型     | 默认值       | 说明                                        |
| ----------------------- | -------- | ------------ | ------------------------------------------- |
| `enabled`               | boolean  | `true`       | 是否启用                                    |
| `clientId`              | string   | 必填         | 应用的 AppKey                               |
| `clientSecret`          | string   | 必填         | 应用的 AppSecret                            |
| `robotCode`             | string   | -            | 机器人代码（用于下载媒体和发送卡片）        |
| `corpId`                | string   | -            | 企业 ID                                     |
| `agentId`               | string   | -            | 应用 ID                                     |
| `dmPolicy`              | string   | `"open"`     | 私聊策略：open/pairing/allowlist            |
| `groupPolicy`           | string   | `"open"`     | 群聊策略：open/allowlist                    |
| `allowFrom`             | string[] | `[]`         | 允许的发送者 ID 列表                        |
| `mediaUrlAllowlist`     | string[] | `[]`         | 允许通过 `mediaUrl` 下载的主机/IP/CIDR 白名单 |
| `showThinking`          | boolean  | `true`       | 是否发送“思考中”提示消息（仅 markdown 模式生效） |
| `thinkingMessage`       | string   | `"🤔 思考中，请稍候..."` | 自定义“思考中”提示文案（showThinking 开启时生效，仅 markdown 模式） |
| `messageType`           | string   | `"markdown"` | 消息类型：markdown/card                     |
| `cardTemplateId`        | string   |              | AI 互动卡片模板 ID（仅当 messageType=card） |
| `cardTemplateKey`       | string   | `"content"`  | 卡片模板内容字段键（仅当 messageType=card） |
| `debug`                 | boolean  | `false`      | 是否开启调试日志                            |
| `mediaMaxMb`            | number   | -            | 接收文件大小上限（MB），不设则使用 runtime 默认值（5 MB） |
| `maxConnectionAttempts` | number   | `10`         | 最大连接尝试次数                            |
| `initialReconnectDelay` | number   | `1000`       | 初始重连延迟（毫秒）                        |
| `maxReconnectDelay`     | number   | `60000`      | 最大重连延迟（毫秒）                        |
| `reconnectJitter`       | number   | `0.3`        | 重连延迟抖动因子（0-1）                     |

### 连接鲁棒性配置

为提高连接稳定性，插件支持以下高级配置：

- **maxConnectionAttempts**: 连接失败后的最大重试次数，超过后将停止尝试并报警。
- **initialReconnectDelay**: 第一次重连的初始延迟（毫秒），后续重连会按指数增长。
- **maxReconnectDelay**: 重连延迟的上限（毫秒），防止等待时间过长。
- **reconnectJitter**: 延迟抖动因子，在延迟基础上增加随机变化（±30%），避免多个客户端同时重连。

重连延迟计算公式：`delay = min(initialDelay × 2^attempt, maxDelay) × (1 ± jitter)`

示例延迟序列（默认配置）：~1s, ~2s, ~4s, ~8s, ~16s, ~32s, ~60s（达到上限）

更多详情请参阅 [CONNECTION_ROBUSTNESS.md](./CONNECTION_ROBUSTNESS.md)。

## 安全策略

### 私聊策略 (dmPolicy)

- `open` — 任何人都可以私聊机器人
- `pairing` — 新用户需要通过配对码验证
- `allowlist` — 只有 allowFrom 列表中的用户可以使用

### 群聊策略 (groupPolicy)

- `open` — 任何群都可以 @机器人
- `allowlist` — 只有配置的群可以使用

## 消息类型支持

### 接收

| 类型         | 支持 | 说明                                                                     |
| ------------ | ---- | ------------------------------------------------------------------------ |
| 文本         | ✅   | 完整支持                                                                 |
| 富文本       | ✅   | 提取文本内容                                                             |
| 图片         | ✅   | 下载并传递给 AI                                                          |
| 语音         | ✅   | 使用钉钉语音识别结果                                                     |
| 视频         | ✅   | 下载并传递给 AI                                                          |
| 文件         | ✅   | 下载并传递给 AI                                                          |
| 引用文字     | ✅   | 提取被引用文本作为上下文前缀                                             |
| 引用图片     | ✅   | 下载被引用图片并传递给 AI                                                |
| 引用文件/视频/语音 | ✅ | 优先通过本地缓存精确匹配下载；群聊缓存未命中时通过群文件 API 时间匹配兜底 |
| 引用 AI 卡片 | ✅   | 从内存缓存中提取机器人原始回复内容作为上下文（重启后降级为占位提示）     |

> **引用消息实现说明**
>
> 不同场景的引用消息采用不同的实现方式：
>
> | 场景 | 实现方式 | 是否依赖时间匹配 |
> |------|----------|------------------|
> | 引用文字 | 直接从 `repliedMsg.content.text` 提取 | 否 |
> | 引用图片 | 从 `repliedMsg.content.downloadCode` 下载 | 否 |
> | 单聊引用文件/视频/语音 | 本地缓存 `msgId → {downloadCode, spaceId, fileId}`，按 msgId 精确匹配 | 否 |
> | 群聊引用文件/视频/语音 | 优先查本地缓存按 msgId 精确匹配；缓存未命中时通过群文件存储 API 链路下载，按时间窗口匹配（±5 秒）兜底 | 兜底时**是** |
> | 引用 AI 卡片（单聊+群聊） | 内存缓存 `card.createdAt → finalContent`，按 `createdAt ≈ repliedMsg.createdAt` 时间窗口匹配（±2 秒） | **是** |
> | 仅 `originalMsgId`（无 `repliedMsg`） | 本地 Quote Journal 持久化记录按 `msgId` 回溯文本，按 `accountId + conversationId` 分桶查询 | 否 |
>
> 其中**群聊引用文件**和**引用 AI 卡片**依赖服务器本地时间戳（`Date.now()`）与钉钉服务端时间戳匹配。如果服务器系统时间与实际时间偏差较大，会导致匹配失败。**请确保服务器已开启 NTP 时间同步。**
>
> ```bash
> # 检查系统时间
> date
>
> # 开启 NTP 同步（systemd 环境）
> timedatectl set-ntp true
> ```
>
> 另外，单聊引用文件和引用 AI 卡片的缓存均为内存缓存，机器人重启后缓存清空，此时会降级为占位提示文本。
>
> `originalMsgId` 的文本回溯依赖本地 Quote Journal 持久化存储。当前默认行为为：
> - 通过 persistence store 落盘到插件状态目录中
> - 按 `accountId + conversationId` 分桶
> - 默认保留最近 7 天内的记录用于回溯

### 发送

| 类型         | 支持 | 说明                                                     |
| ------------ | ---- | -------------------------------------------------------- |
| 文本         | ✅   | 完整支持                                                 |
| Markdown     | ✅   | 自动检测或手动指定                                       |
| 互动卡片     | ✅   | 支持流式更新，适用于 AI 实时输出                         |
| 图片         | ✅   | 先上传媒体再发送，支持本地路径和 HTTP(S) URL             |
| 语音         | ✅   | 先上传媒体再发送                                         |
| 视频         | ✅   | 先上传媒体再发送                                         |
| 文件         | ✅   | 先上传媒体再发送                                         |
| 原生语音消息 | ✅   | `message send` / `outbound.sendMedia` 可用 `asVoice=true` |

> **重要限制：**
> 当前**不支持图片的图文混排**。也就是说，Markdown 消息和 AI 互动卡片目前都只能发送文本内容，不能在同一条消息中同时内嵌图片。
> 如果需要发送图片，请单独调用 `outbound.sendMedia(...)` 或 `sendProactiveMedia(...)`。
> 无论是**本地图片路径**还是**远程 HTTP(S) 图片 URL**，都支持单独发送；远程图片会先下载到临时文件，再上传到钉钉后发送。
> 远程 URL 下载默认限制为：**10 秒超时**、**20MB 上限**，并拒绝 `localhost` / 内网地址（如 `127.0.0.1`、`10.x.x.x`、`192.168.x.x`、`172.16-31.x.x`）以降低 SSRF 风险。
> 如需从受控内网媒体服务下载，请配置 `mediaUrlAllowlist`（例如 `192.168.1.23`、`files.internal.example`、`10.0.0.0/8`）；配置后仅白名单主机可下载。
> 远程域名会先做 DNS 解析并校验解析结果；若解析到内网/本地地址且未被白名单明确允许，将在下载前拒绝。
> `asVoice=true` 需要同时提供 `media/path/filePath/mediaUrl` 指向音频文件；纯文本不会自动转语音。

#### mediaUrlAllowlist 配置示例

`mediaUrlAllowlist` 支持以下写法：

- 主机名：`cdn.example.com`
- 泛域名：`*.example.com`
- 主机+端口：`files.internal.example:8443`
- 单个 IP：`192.168.1.23`、`fd00::1`
- CIDR 网段：`10.0.0.0/8`、`fc00::/7`

示例：

```json
{
  "channels": {
    "dingtalk": {
      "clientId": "your-app-key",
      "clientSecret": "your-app-secret",
      "mediaUrlAllowlist": [
        "cdn.example.com",
        "*.assets.example.com",
        "files.internal.example:8443",
        "192.168.1.23",
        "10.0.0.0/8",
        "fc00::/7"
      ]
    }
  }
}
```

> 行为说明：配置 `mediaUrlAllowlist` 后，下载阶段进入严格白名单模式，非白名单目标一律拒绝。

#### sendMedia 常见错误码

`outbound.sendMedia(...)` 在下载准备失败时会透出错误码前缀（例如 `remote media preparation failed: [ERR_MEDIA_PRIVATE_HOST] ...`）：

- `ERR_MEDIA_ALLOWLIST_MISS`：目标 host 不在 `mediaUrlAllowlist`
- `ERR_MEDIA_PRIVATE_HOST`：URL 本身是本地/内网 host 且未被允许
- `ERR_MEDIA_DNS_UNRESOLVED`：域名无法解析
- `ERR_MEDIA_DNS_PRIVATE`：域名解析结果命中本地/内网地址且未被允许
- `ERR_MEDIA_REDIRECT_HOST`：下载阶段出现非预期重定向 host

## API 消耗说明

### Text/Markdown 模式

| 操作       | API 调用次数 | 说明                                                                         |
| ---------- | ------------ | ---------------------------------------------------------------------------- |
| 获取 Token | 1            | 共享/缓存（60 秒检查过期一次）                                               |
| 发送消息   | 1            | 使用 `/v1.0/robot/oToMessages/batchSend` 或 `/v1.0/robot/groupMessages/send` |
| **总计**   | **2**        | 每条回复 1 次                                                                |

### Card（AI 互动卡片）模式

| 阶段         | API 调用               | 说明                                                |
| ------------ | ---------------------- | --------------------------------------------------- |
| **创建卡片** | 1                      | `POST /v1.0/card/instances/createAndDeliver`        |
| **流式更新** | M                      | M = 回复块数量，每块一次 `PUT /v1.0/card/streaming` |
| **完成卡片** | 包含在最后一次流更新中 | 使用 `isFinalize=true` 标记                         |
| **总计**     | **1 + M**              | M = Agent 产生的回复块数                            |

### 典型场景成本对比

| 场景             | Text/Markdown | Card | 节省   |
| ---------------- | ------------- | ---- | ------ |
| 简短回复（1 块） | 2             | 2    | ✓ 相同 |
| 中等回复（5 块） | 6             | 6    | ✓ 相同 |
| 长回复（10 块）  | 12            | 11   | ✓ 1 次 |

### 优化策略

**降低 API 调用的方法：**

1. **合并回复块** — 通过调整 Agent 输出配置，减少块数量
2. **使用缓存** — Token 自动缓存（60 秒），无需每次都获取
3. **Buffer 模式** — 使用 `dispatchReplyWithBufferedBlockDispatcher` 合并多个小块

**成本建议：**

- ✅ **推荐** — Card 模式：流式体验更好，成本与 Text/Markdown 相当或更低
- ⚠️ **谨慎** — 频繁调用需要监测配额，建议使用钉钉开发者后台查看 API 调用量

## 消息类型选择

插件支持两种消息回复类型，可通过 `messageType` 配置：

### 1. markdown（Markdown 格式）**【默认】**

- 支持富文本格式（标题、粗体、列表等）
- 自动检测消息是否包含 Markdown 语法
- 适用于大多数场景

### 2. card（AI 互动卡片）

- 支持流式更新（实时显示 AI 生成内容）
- 更好的视觉呈现和交互体验
- 支持 Markdown 格式渲染
- 通过 `cardTemplateId` 指定模板
- 通过 `cardTemplateKey` 指定内容字段
- **适用于 AI 对话场景**
- 支持在卡片中实时显示 AI 思考过程（推理流）和工具执行结果
- 当前卡片模式仅支持**文本内容流式更新**，不支持图片图文混排

**AI Card API 特性：**
当配置 `messageType: 'card'` 时：

1. 使用 `/v1.0/card/instances/createAndDeliver` 创建并投放卡片
2. 使用 `/v1.0/card/streaming` 实现真正的流式更新
3. 自动状态管理（PROCESSING → INPUTING → FINISHED）
4. 更稳定的流式体验，无需手动节流

**AI Card 持久化与恢复机制（v3.2.x）：**

- 仅对**会话内流式卡片（inbound）**记录 pending 状态，用于进程重启后的自动收尾
- pending 文件路径基于 OpenClaw session `storePath` 目录推导：`path.dirname(storePath)/dingtalk-active-cards.json`
- **proactive 卡片**采用 createAndDeliver 后立即 finalize 的短路径，默认**不写入** pending 状态文件
- 插件启动时会尝试恢复并 finalize 未完成的 inbound 卡片；停止/重启时会 best-effort finalize 当前 active 卡片

### AI 思考过程与工具执行显示（AI Card 模式）

当 `messageType` 为 `card` 时，插件可以在卡片中实时展示 AI 的推理过程（🤔 思考中）和工具调用结果（🛠️ 工具执行）。这两项功能通过**对话级命令**控制，无需修改配置文件：

| 功能              | 对话命令              | 说明                               |
| ----------------- | --------------------- | ---------------------------------- |
| 显示 AI 推理流    | `/reasoning stream`   | 开启后，AI 思考内容实时更新到卡片  |
| 显示工具执行结果  | `/verbose on`         | 开启后，工具调用结果实时更新到卡片 |
| 关闭 AI 推理流    | `/reasoning off`      | 关闭推理流显示                     |
| 关闭工具执行显示  | `/verbose off`        | 关闭工具执行结果显示               |

**显示格式：**

- 思考内容以 `🤔 **思考中**` 为标题，正文以 `>` 引用块展示，最多显示前 500 个字符
- 工具结果以 `🛠️ **工具执行**` 为标题，正文以 `>` 引用块展示，最多显示前 500 个字符

> **注意：** 推理流和工具执行均会产生额外的卡片流式更新 API 调用，在 AI 推理步骤较多时可能显著增加 API 消耗，建议按需开启。

**配置示例：**

```json5
{
  messageType: 'card', // 启用 AI 互动卡片模式
  cardTemplateId: '382e4302-551d-4880-bf29-a30acfab2e71.schema', // AI 卡片模板 ID（默认值）
  cardTemplateKey: 'content', // 卡片内容字段键（默认值：content）
}
```

> **注意**：`cardTemplateKey` 应与您的卡片模板中定义的字段名称一致。默认值为 `'content'`，适用于 DingTalk 官方 AI 卡片模板。如果您使用自定义模板，请根据模板定义的字段名称进行配置。

## 使用示例

配置完成后，直接在钉钉中：

1. **私聊机器人** — 找到机器人，发送消息
2. **群聊 @机器人** — 在群里 @机器人名称 + 消息

如果你是通过 OpenClaw 的 outbound 能力主动发消息，也可以直接调用：

```typescript
import { dingtalkPlugin } from './src/channel';

const cfg = {
  channels: {
    dingtalk: {
      clientId: 'dingxxxxxx',
      clientSecret: 'your-app-secret',
      robotCode: 'dingxxxxxx',
    },
  },
};

// 发送本地图片
await dingtalkPlugin.outbound.sendMedia({
  cfg,
  to: 'cidxxxxxxxx',
  mediaPath: '/absolute/path/to/photo.png',
  accountId: 'default',
});

// 发送远程图片 URL（插件会先下载到临时文件，再上传到钉钉）
await dingtalkPlugin.outbound.sendMedia({
  cfg,
  to: 'cidxxxxxxxx',
  mediaUrl: 'https://example.com/banner.jpg',
  accountId: 'default',
});

// 发送文件或其他媒体，也可以显式指定 mediaType
await dingtalkPlugin.outbound.sendMedia({
  cfg,
  to: 'user_123456',
  mediaPath: '/absolute/path/to/manual.pdf',
  mediaType: 'file',
  accountId: 'default',
});
```

`to` 支持两类目标：

- 群会话：`cid...`
- 单聊用户：`userId`，或显式写成 `user:<userId>`

如果你传入的是远程图片 URL，插件当前会按下面的方式处理：

1. 下载远程图片到本地临时文件
2. 调用钉钉媒体上传接口获取 `media_id`
3. 以独立图片消息发送
4. 发送完成后清理临时文件

## 故障排除

### 收不到消息

1. 确认应用已发布
2. 确认消息接收模式是 Stream
3. 检查 Gateway 日志：`openclaw logs | grep dingtalk`

### 群消息无响应

1. 确认机器人已添加到群
2. 确认正确 @机器人（使用机器人名称）
3. 确认群是企业内部群

### 连接失败

初始化阶段如果只看到 HTTP `400`，它通常不等于“单纯网络不通”；更常见的是钉钉已收到请求，但拒绝了请求内容或当前应用状态不满足要求。

建议先运行仓库内的最小连接检查脚本，确认 `POST /v1.0/gateway/connections/open` 是否成功：

- macOS / Linux: `bash scripts/dingtalk-connection-check.sh --config ~/.openclaw/openclaw.json`
- Windows PowerShell: `pwsh -File scripts/dingtalk-connection-check.ps1 -Config ~/.openclaw/openclaw.json`
  - 旧版 Windows 可使用：`powershell.exe -File scripts/dingtalk-connection-check.ps1 -Config $env:USERPROFILE\.openclaw\openclaw.json`

完整排障流程：
- 英文版：[docs/connection-troubleshooting.md](docs/connection-troubleshooting.md)
- 中文版：[docs/connection-troubleshooting.zh-CN.md](docs/connection-troubleshooting.zh-CN.md)

如果新日志里出现 `connect.open` 或 `connect.websocket`，也可以直接按文档中的阶段说明来判断：前者优先查钉钉应用配置，后者优先查 WSS / 代理 / 企业网关。

关键设置清单（钉钉后台）
- 应用为企业内部应用/机器人，且已“发布”版本（不是草稿）
- 版本管理 → 已发布 → 版本详情：可见范围需为“全员员工”
- 已开启“机器人能力”，消息接收方式为“Stream 模式”

### 错误 payload 日志规范（`[ErrorPayload]`）

为便于快速定位 4xx/5xx 参数问题，插件会在 API 错误分支输出统一格式日志：

- 通用前缀：`[DingTalk][ErrorPayload][<scope>]`
- AI Card 前缀：`[DingTalk][AICard][ErrorPayload][<scope>]`
- 内容格式：`code=<...> message=<...> payload=<...>`（同时保留脱敏后的完整 payload）

常见 scope 示例：

- `send.proactiveMessage` / `send.proactiveMedia` / `send.message`
- `outbound.sendText` / `outbound.sendMedia`
- `inbound.downloadMedia` / `inbound.cardFinalize`
- `card.create` / `card.stream` / `card.stream.retryAfterRefresh`
- `retry.beforeDecision`

排查建议：

```bash
openclaw logs | grep "\[ErrorPayload\]"
```

如果你看到 `code=invalidParameter`，通常优先检查请求 payload 的必填字段（例如 `robotCode`、`userIds`、`msgKey`、`msgParam`）是否完整且格式正确。

## 开发指南

### 首次设置

1. 克隆仓库并安装依赖

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
```

2. 验证开发环境

```bash
npm run type-check              # TypeScript 类型检查
npm run lint                    # ESLint 代码检查
```

### 常用命令

| 命令                 | 说明                |
| -------------------- | ------------------- |
| `npm run type-check` | TypeScript 类型检查 |
| `npm run lint`       | ESLint 代码检查     |
| `npm run lint:fix`   | 自动修复格式问题    |

### 项目结构

```
src/
  channel.ts           - 插件定义和辅助函数（535 行）
  runtime.ts           - 运行时管理（14 行）
  types.ts             - 类型定义（30+ interfaces）

index.ts              - 插件注册（29 行）
utils.ts              - 工具函数（110 行）

openclaw.plugin.json  - 插件配置
package.json          - 项目配置
README.md             - 本文件
```

### 代码质量

- **TypeScript**: 严格模式，0 错误
- **ESLint**: 自动检查和修复
- **Type Safety**: 完整的类型注解（30+ 接口）

### 类型系统

核心类型定义在 `src/types.ts` 中，包括：

```typescript
// 配置
DingTalkConfig; // 插件配置
DingTalkChannelConfig; // 多账户配置

// 消息处理
DingTalkInboundMessage; // 收到的钉钉消息
MessageContent; // 解析后的消息内容
HandleDingTalkMessageParams; // 消息处理参数

// AI 互动卡片
AICardInstance; // AI 卡片实例
AICardCreateAndDeliverRequest; // 创建并投放卡片请求
AICardStreamingRequest; // 流式更新请求
AICardStatus; // 卡片状态常量

// 工具函数类型
Logger; // 日志接口
RetryOptions; // 重试选项
MediaFile; // 下载的媒体文件
```

### 公开 API

插件导出以下低级 API 函数，可用于自定义集成：

```typescript
// 文本/Markdown 消息
sendBySession(config, sessionWebhook, text, options); // 通过会话发送

// AI 互动卡片
createAICard(config, conversationId, log); // 创建并投放 AI 卡片
streamAICard(card, content, finished, log); // 流式更新卡片内容
finishAICard(card, content, log); // 完成并关闭卡片

// 自动模式选择
sendMessage(config, conversationId, text, options); // 根据配置自动选择（含卡片/文本回退）

// 主动媒体发送
uploadMedia(config, mediaPath, mediaType, log); // 上传媒体并返回 media_id
sendProactiveMedia(config, target, mediaPath, mediaType, options); // 发送图片/语音/视频/文件

// 认证
getAccessToken(config, log); // 获取访问令牌
```

**使用示例：**

```typescript
import {
  createAICard,
  finishAICard,
  sendProactiveMedia,
  streamAICard,
} from './src/channel';

// 创建 AI 卡片
const card = await createAICard(config, conversationId, log);

// 流式更新内容
for (const chunk of aiResponseChunks) {
  await streamAICard(card, currentText + chunk, false, log);
}

// 完成并关闭卡片
await finishAICard(card, finalText, log);

// 主动发送图片
await sendProactiveMedia(config, 'cidxxxxxxxx', '/absolute/path/to/photo.png', 'image', {
  accountId: 'default',
  log,
});
```

### 架构

插件遵循 Telegram 参考实现的架构模式：

- **index.ts**: 最小化插件注册入口
- **src/channel.ts**: 所有 DingTalk 特定的逻辑（API、消息处理、配置等）
- **src/runtime.ts**: 运行时管理（getter/setter）
- **src/types.ts**: 类型定义
- **utils.ts**: 通用工具函数

## 测试

项目已基于 Vitest 初始化自动化测试，目录结构如下：

```text
tests/
  unit/
    sign.test.ts               # HmacSHA256 + Base64 签名测试
    message-transform.test.ts  # 文本/Markdown 消息转换测试
  integration/
    send-lifecycle.test.ts     # 插件 outbound.sendText 生命周期适配测试
```

### 运行测试

```bash
# 安装依赖（pnpm）
pnpm install

# 运行全部测试
pnpm test

# 生成覆盖率报告（coverage/）
pnpm test:coverage
```

### Mock 约束

- 所有测试中的网络请求均通过 `vi.mock('axios')` 拦截，禁止真实调用钉钉 API。
- 集成测试通过模块 mock 隔离 `openclaw/plugin-sdk`、`dingtalk-stream` 等外部依赖。

## 许可

MIT
