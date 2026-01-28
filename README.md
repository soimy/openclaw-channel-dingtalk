# DingTalk Channel for Clawdbot

钉钉企业内部机器人 Channel 插件，使用 Stream 模式（无需公网 IP）。

## 功能特性

- ✅ **Stream 模式** — WebSocket 长连接，无需公网 IP 或 Webhook
- ✅ **私聊支持** — 直接与机器人对话
- ✅ **群聊支持** — 在群里 @机器人
- ✅ **多种消息类型** — 文本、图片、语音（自带识别）、视频、文件
- ✅ **Markdown 回复** — 支持富文本格式回复
- ✅ **完整 AI 对话** — 接入 Clawdbot 消息处理管道

## 安装

### 方法 A：通过远程仓库安装 (推荐)

直接运行 Clawdbot 插件安装命令，Clawdbot 会自动处理下载、安装依赖和注册：

```bash
clawdbot plugins install https://github.com/soimy/clawdbot-channel-dingtalk.git
```

### 方法 B：通过本地源码安装

如果你想对插件进行二次开发，可以先克隆仓库：

```bash
# 1. 克隆仓库
git clone https://github.com/soimy/clawdbot-channel-dingtalk.git
cd clawdbot-channel-dingtalk

# 2. 安装依赖 (必需)
npm install

# 3. 以链接模式安装 (方便修改代码后实时生效)
clawdbot plugins install -l .
```

### 方法 C：手动安装

1. 将本目录下载或复制到 `~/.clawdbot/extensions/dingtalk`。
2. 确保包含 `index.ts`, `clawdbot.plugin.json` 和 `package.json`。
3. 运行 `clawdbot plugins list` 确认 `dingtalk` 已显示在列表中。

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

在 `~/.clawdbot/clawdbot.json` 的 `channels` 下添加：

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      clientId: 'dingxxxxxx',
      clientSecret: 'your-app-secret',
      robotCode: 'dingxxxxxx',
      corpId: 'dingxxxxxx',
      agentId: '123456789',
      dmPolicy: 'open', // open | pairing | allowlist
      groupPolicy: 'open', // open | allowlist
      debug: false,
    },
  },
}
```

### 4. 重启 Gateway

```bash
clawdbot gateway restart
```

## 配置选项

| 选项           | 类型     | 默认值   | 说明                             |
| -------------- | -------- | -------- | -------------------------------- |
| `enabled`      | boolean  | `true`   | 是否启用                         |
| `clientId`     | string   | 必填     | 应用的 AppKey                    |
| `clientSecret` | string   | 必填     | 应用的 AppSecret                 |
| `robotCode`    | string   | -        | 机器人代码（用于下载媒体）       |
| `corpId`       | string   | -        | 企业 ID                          |
| `agentId`      | string   | -        | 应用 ID                          |
| `dmPolicy`     | string   | `"open"` | 私聊策略：open/pairing/allowlist |
| `groupPolicy`  | string   | `"open"` | 群聊策略：open/allowlist         |
| `allowFrom`    | string[] | `[]`     | 允许的发送者 ID 列表             |
| `debug`        | boolean  | `false`  | 是否开启调试日志                 |

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

| 类型     | 支持 | 说明                 |
| -------- | ---- | -------------------- |
| 文本     | ✅   | 完整支持             |
| Markdown | ✅   | 自动检测或手动指定   |
| 图片     | ⏳   | 需要通过媒体上传 API |
| 交互卡片 | ⏳   | 计划中               |

## 使用示例

配置完成后，直接在钉钉中：

1. **私聊机器人** — 找到机器人，发送消息
2. **群聊 @机器人** — 在群里 @机器人名称 + 消息

## 故障排除

### 收不到消息

1. 确认应用已发布
2. 确认消息接收模式是 Stream
3. 检查 Gateway 日志：`clawdbot logs | grep dingtalk`

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
git clone https://github.com/soimy/clawdbot-channel-dingtalk.git
cd clawdbot-channel-dingtalk
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

clawdbot.plugin.json  - 插件配置
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

// 工具函数类型
Logger; // 日志接口
RetryOptions; // 重试选项
MediaFile; // 下载的媒体文件
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
