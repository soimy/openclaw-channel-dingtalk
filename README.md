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

### 2. 获取凭证

从开发者后台获取：

- **Client ID** (AppKey)
- **Client Secret** (AppSecret)
- **Robot Code** (与 Client ID 相同)
- **Corp ID** (企业 ID)
- **Agent ID** (应用 ID)

### 3. 配置 Clawdbot

在 `~/.openclaw/clawdbot.json` 的 `channels` 下添加：
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

### 4. 重启 Gateway

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
| `messageType`      | string   | `"markdown"`                                                    | 消息类型：text/markdown/card              |
| `cardTemplateId`   | string   | `"382e4302-551d-4880-bf29-a30acfab2e71.schema"`                 | AI 互动卡片模板 ID（仅当 messageType=card）|
| `useNewCardApi`    | boolean  | `true`                                                          | 使用新版 AI Card API（推荐）              |
| `cardSendApiUrl`   | string   | `"https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send"` | 旧版卡片发送 API URL（向下兼容）          |
| `cardUpdateApiUrl` | string   | `"https://api.dingtalk.com/v1.0/im/robots/interactiveCards"`   | 旧版卡片更新 API URL（向下兼容）          |
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

## 消息类型选择

插件支持三种消息回复类型，可通过 `messageType` 配置：

### 1. text（纯文本）
- 基础文本消息
- 适用于简单回复
- 无格式化支持

### 2. markdown（Markdown 格式）**【默认】**
- 支持富文本格式（标题、粗体、列表等）
- 自动检测消息是否包含 Markdown 语法
- 适用于大多数场景

### 3. card（AI 互动卡片）**【推荐用于 AI 对话】**
- 🆕 **使用新版 AI Card API**（默认启用）
- 支持流式更新（实时显示 AI 生成内容）
- 更好的视觉呈现和交互体验
- 支持 Markdown 格式渲染
- 通过 `cardTemplateId` 指定模板

**新版 AI Card API 特性：**
当配置 `messageType: 'card'` 且 `useNewCardApi: true`（默认）时：
1. 使用 `/v1.0/card/instances` 创建并投放卡片
2. 使用 `/v1.0/card/streaming` 实现真正的流式更新
3. 自动状态管理（INPUTING → streaming → FINISHED）
4. 更稳定的流式体验，无需手动节流

**旧版兼容性：**
如需使用旧版 API，可设置 `useNewCardApi: false`：
- 自动节流：最小 500ms 更新间隔
- 超时检测：60 秒无更新自动视为完成
- 错误处理：遇到 404/410 错误自动清理缓存

**配置示例：**
```json5
{
  messageType: 'card', // 启用 AI 互动卡片模式
  useNewCardApi: true, // 使用新版 API（推荐，默认值）
  cardTemplateId: '382e4302-551d-4880-bf29-a30acfab2e71.schema', // AI 卡片模板 ID
}
```

**向下兼容旧版：**
```json5
{
  messageType: 'card',
  useNewCardApi: false, // 使用旧版 API
  cardTemplateId: 'StandardCard', // 标准卡片模板
  cardSendApiUrl: 'https://api.dingtalk.com/v1.0/im/v1.0/robot/interactiveCards/send',
  cardUpdateApiUrl: 'https://api.dingtalk.com/v1.0/im/robots/interactiveCards',
}
```

## 新版 AI Card API 升级指南

### 从旧版迁移到新版

**v2.1.2+ 默认使用新版 AI Card API**，无需额外配置。如果您从旧版本升级：

1. **自动迁移**（推荐）
   - 更新到最新版本后，新版 API 会自动启用
   - 现有配置保持兼容，不需要修改
   - 新的默认 `cardTemplateId` 会自动使用 AI 卡片模板

2. **手动控制**
   ```json5
   {
     "dingtalk": {
       "messageType": "card",
       "useNewCardApi": true,  // 显式启用新版 API
       // 其他配置保持不变...
     }
   }
   ```

3. **回退到旧版**（如遇到问题）
   ```json5
   {
     "dingtalk": {
       "messageType": "card",
       "useNewCardApi": false,  // 使用旧版 API
       "cardTemplateId": "StandardCard",
       // 其他配置保持不变...
     }
   }
   ```

### API 对比

| 特性 | 新版 AI Card API | 旧版 Card API |
|------|-----------------|--------------|
| API 端点 | `/v1.0/card/instances`<br/>`/v1.0/card/streaming` | `/v1.0/im/v1.0/robot/interactiveCards/send`<br/>`/v1.0/im/robots/interactiveCards` |
| 流式更新 | 原生支持，无需节流 | 需要手动节流（500ms） |
| 状态管理 | 自动（INPUTING → FINISHED） | 无状态管理 |
| 卡片创建 | 创建 + 投放两步 | 一步发送 |
| Markdown 支持 | 原生支持 | 需要自定义模板 |
| 稳定性 | 更高，官方推荐 | 可能被弃用 |

### 参考文档

- [创建并投放卡片](https://open.dingtalk.com/document/development/create-and-deliver-cards)
- [更新 AI 互动卡片](https://open.dingtalk.com/document/development/api-streamingupdate)
- [参考实现](https://github.com/DingTalk-Real-AI/dingtalk-moltbot-connector)

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

// 互动卡片（旧版 API）
InteractiveCardData; // 卡片数据结构
InteractiveCardSendRequest; // 发送卡片请求
InteractiveCardUpdateRequest; // 更新卡片请求
CardInstance; // 卡片实例（用于缓存）

// AI 互动卡片（新版 API）
AICardInstance; // AI 卡片实例
AICardCreateRequest; // 创建卡片请求
AICardDeliverRequest; // 投放卡片请求
AICardUpdateRequest; // 更新卡片请求
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
sendProactiveMessage(config, target, text, options); // 主动发送消息

// AI 互动卡片（新版 API，推荐）
createAICard(config, conversationId, data, log); // 创建并投放 AI 卡片
streamAICard(card, content, finished, log); // 流式更新卡片内容
finishAICard(card, content, log); // 完成并关闭卡片

// 互动卡片（旧版 API，向下兼容）
sendInteractiveCard(config, conversationId, text, options); // 发送卡片
updateInteractiveCard(config, cardBizId, text, options); // 更新卡片

// 自动模式选择
sendMessage(config, conversationId, text, options); // 根据配置自动选择

// 认证
getAccessToken(config, log); // 获取访问令牌
```

**使用示例（新版 AI Card API）：**

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

**使用示例（旧版 API）：**

```typescript
import { sendInteractiveCard, updateInteractiveCard } from './src/channel';

// 发送初始卡片
const { cardBizId } = await sendInteractiveCard(config, conversationId, '正在生成...', {
  log,
});

// 流式更新卡片内容
for (const chunk of aiResponseChunks) {
  await updateInteractiveCard(config, cardBizId, currentText + chunk, { log });
}
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
