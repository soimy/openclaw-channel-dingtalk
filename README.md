# DingTalk Channel for OpenClaw 

钉钉企业内部机器人 Channel 插件，使用 Stream 模式（无需公网 IP）。

## 功能特性

- ✅ **Stream 模式** — WebSocket 长连接，无需公网 IP 或 Webhook
- ✅ **私聊支持** — 直接与机器人对话
- ✅ **群聊支持** — 在群里 @机器人
- ✅ **多种消息类型** — 文本、图片、语音（自带识别）、视频、文件
- ✅ **Markdown 回复** — 支持富文本格式回复
- ✅ **互动卡片** — 支持流式更新，适用于 AI 实时输出
- ✅ **完整 AI 对话** — 接入 Clawdbot 消息处理管道

## 安装

### 方法 A：通过远程仓库安装 (推荐)

直接运行 openclaw 插件安装命令，openclaw 会自动处理下载、安装依赖和注册：

```bash
openclaw plugins install https://github.com/soimy/clawdbot-channel-dingtalk.git
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

## 配置

### 1. 创建钉钉应用

1. 访问 [钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 创建企业内部应用
3. 添加「机器人」能力
4. 配置消息接收模式为 **Stream 模式**
5. 发布应用

### 2. 配置权限管理

在应用的权限管理页面，需要开启以下权限：

- ✅ **Card.Instance.Write** — 创建和投放卡片实例
- ✅ **Card.Streaming.Write** — 对卡片进行流式更新

**步骤：**
1. 进入应用 → 权限管理
2. 搜索「Card」相关权限
3. 勾选上述两个权限
4. 保存权限配置

### 3. 建立卡片模板

如需使用 AI 互动卡片功能，需要在钉钉卡片平台创建模板：

**步骤：**
1. 访问 [钉钉卡片平台](https://open.dingtalk.com/document/development/card)
2. 进入「我的模板」
3. 点击「创建模板」
4. 卡片模板场景选择 **「AI 卡片」**
5. **无需选择预设模板**，直接点击保存
6. 复制模板 ID（格式如：`xxxxx-xxxxx-xxxxx.schema`）
7. 将 templateId 配置到 `openclaw.json` 的 `cardTemplateId` 字段
8. 或在OpenClaw控制台的Channel标签->Dingtalk配置面板-> Card Template Id填入

**模板配置示例：**
```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardTemplateId": "你复制的模板ID" // 粘贴复制的模板 ID
    }
  }
}
```

### 4. 获取凭证

从开发者后台获取：

- **Client ID** (AppKey)
- **Client Secret** (AppSecret)
- **Robot Code** (与 Client ID 相同)
- **Corp ID** (企业 ID)
- **Agent ID** (应用 ID)

### 5. 配置 OpenClaw

在 `~/.openclaw/openclaw.json` 的 `channels` 下添加：
> 只添加dingtalk部分，内容自己替换

```json5
{
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
      "messageType": "markdown",       
      "debug": false
    }
  },
  ...
}
```

### 6. 重启 Gateway

```bash
openclaw gateway restart
```

## 配置选项

| 选项               | 类型     | 默认值                                                          | 说明                                      |
| ------------------ | -------- | --------------------------------------------------------------- | ----------------------------------------- |
| `enabled`          | boolean  | `true`                                                          | 是否启用                                  |
| `clientId`         | string   | 必填                                                            | 应用的 AppKey                             |
| `clientSecret`     | string   | 必填                                                            | 应用的 AppSecret                          |
| `robotCode`        | string   | -                                                               | 机器人代码（用于下载媒体和发送卡片）      |
| `corpId`           | string   | -                                                               | 企业 ID                                   |
| `agentId`          | string   | -                                                               | 应用 ID                                   |
| `dmPolicy`         | string   | `"open"`                                                        | 私聊策略：open/pairing/allowlist          |
| `groupPolicy`      | string   | `"open"`                                                        | 群聊策略：open/allowlist                  |
| `allowFrom`        | string[] | `[]`                                                            | 允许的发送者 ID 列表                      |
| `messageType`      | string   | `"markdown"`                                                    | 消息类型：markdown/card                   |
| `cardTemplateId`   | string   | `"382e4302-551d-4880-bf29-a30acfab2e71.schema"`                 | AI 互动卡片模板 ID（仅当 messageType=card）|
| `debug`            | boolean  | `false`                                                         | 是否开启调试日志                          |

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

| 类型   | 支持 | 说明                 |
| ------ | ---- | -------------------- |
| 文本   | ✅   | 完整支持             |
| 富文本 | ✅   | 提取文本内容         |
| 图片   | ✅   | 下载并传递给 AI      |
| 语音   | ✅   | 使用钉钉语音识别结果 |
| 视频   | ✅   | 下载并传递给 AI      |
| 文件   | ✅   | 下载并传递给 AI      |

### 发送

| 类型         | 支持 | 说明                                       |
| ------------ | ---- | ------------------------------------------ |
| 文本         | ✅   | 完整支持                                   |
| Markdown     | ✅   | 自动检测或手动指定                         |
| 互动卡片     | ✅   | 支持流式更新，适用于 AI 实时输出           |
| 图片         | ⏳   | 需要通过媒体上传 API                       |

## API 消耗说明

### Text/Markdown 模式

| 操作     | API 调用次数 | 说明 |
|---------|-----------|------|
| 获取 Token | 1 | 共享/缓存（60 秒检查过期一次） |
| 发送消息 | 1 | 使用 `/v1.0/robot/oToMessages/batchSend` 或 `/v1.0/robot/groupMessages/send` |
| **总计** | **2** | 每条回复 1 次 |

### Card（AI 互动卡片）模式

| 阶段 | API 调用 | 说明 |
|-----|---------|------|
| **创建卡片** | 1 | `POST /v1.0/card/instances/createAndDeliver` |
| **流式更新** | M | M = 回复块数量，每块一次 `PUT /v1.0/card/streaming` |
| **完成卡片** | 包含在最后一次流更新中 | 使用 `isFinalize=true` 标记 |
| **总计** | **1 + M** | M = Agent 产生的回复块数 |

### 典型场景成本对比

| 场景 | Text/Markdown | Card | 节省 |
|-----|--------------|------|------|
| 简短回复（1 块） | 2 | 2 | ✓ 相同 |
| 中等回复（5 块） | 6 | 6 | ✓ 相同 |
| 长回复（10 块） | 12 | 11 | ✓ 1 次 |

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
- **适用于 AI 对话场景**

**AI Card API 特性：**
当配置 `messageType: 'card'` 时：
1. 使用 `/v1.0/card/instances/createAndDeliver` 创建并投放卡片
2. 使用 `/v1.0/card/streaming` 实现真正的流式更新
3. 自动状态管理（PROCESSING → INPUTING → FINISHED）
4. 更稳定的流式体验，无需手动节流

**配置示例：**
```json5
{
  messageType: 'card', // 启用 AI 互动卡片模式
  cardTemplateId: '382e4302-551d-4880-bf29-a30acfab2e71.schema', // AI 卡片模板 ID（默认值）
}
```

## 使用示例

配置完成后，直接在钉钉中：

1. **私聊机器人** — 找到机器人，发送消息
2. **群聊 @机器人** — 在群里 @机器人名称 + 消息

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

1. 检查 clientId 和 clientSecret 是否正确
2. 确认网络可以访问钉钉 API

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
createAICard(config, conversationId, data, log); // 创建并投放 AI 卡片
streamAICard(card, content, finished, log); // 流式更新卡片内容
finishAICard(card, content, log); // 完成并关闭卡片

// 自动模式选择
sendMessage(config, conversationId, text, options); // 根据配置自动选择（含卡片/文本回退）

// 认证
getAccessToken(config, log); // 获取访问令牌
```

**使用示例：**

```typescript
import { createAICard, streamAICard, finishAICard } from './src/channel';

// 创建 AI 卡片
const card = await createAICard(config, conversationId, messageData, log);

// 流式更新内容
for (const chunk of aiResponseChunks) {
  await streamAICard(card, currentText + chunk, false, log);
}

// 完成并关闭卡片
await finishAICard(card, finalText, log);
```

### 架构

插件遵循 Telegram 参考实现的架构模式：

- **index.ts**: 最小化插件注册入口
- **src/channel.ts**: 所有 DingTalk 特定的逻辑（API、消息处理、配置等）
- **src/runtime.ts**: 运行时管理（getter/setter）
- **src/types.ts**: 类型定义
- **utils.ts**: 通用工具函数

## 许可

MIT
