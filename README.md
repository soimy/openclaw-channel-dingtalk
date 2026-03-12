# @mjand66/openclaw-dingtalk

钉钉企业内部机器人 Channel 插件，基于 [OpenClaw](https://openclaw.ai)，使用 Stream 模式（**无需公网 IP**）。

在原版插件基础上新增**实时任务进度推送**：AI 执行长任务时，每一步操作即时发送到钉钉，不再等任务全部完成才收到回复。

---

## ✨ 核心新特性：实时进度通知

原版插件在 AI 执行多步任务（安装软件、处理文件、运行命令等）时，用户需等待任务全部完成才能看到任何输出，过程完全不透明。

本版本解决了这个问题：

### 进度消息示例

```
⚙️ 我来帮你检查一下是否已安装 tesseract...
⚙️ 📦 安装 tesseract
⚙️ 处理中：poll
⏳ 处理中，已用时约 60 秒...
⚙️ 🔍 检查 brew 是否已安装
⚙️ ⚡ `brew install tesseract`
✅ 任务完成，tesseract 已成功安装。
```

- **每次工具调用立即推送** — 不等任务结束，执行每一步时实时发消息
- **语义化标签** — 自动解析命令意图（`📦 安装 xxx`、`🔍 检查 xxx`、`📝 写入 文件名` 等），而非显示原始命令
- **模型自己的说明优先** — 若模型在调用工具前有解释性文字，直接用作进度标签，更自然
- **60 秒心跳** — 长任务每分钟发一次 `⏳ 处理中，已用时约 X 秒...`，避免用户以为卡住
- **无重复内容** — 任务完成后只发送最终结果，进度过程不再重复

---

## 功能特性

- ✅ **Stream 模式** — WebSocket 长连接，无需公网 IP 或 Webhook
- ✅ **实时任务进度** — AI 执行过程逐步推送，长任务不再沉默
- ✅ **私聊支持** — 直接与机器人对话
- ✅ **群聊支持** — 在群里 @机器人
- ✅ **多种消息类型** — 文本、图片、语音（自带识别）、视频、文件
- ✅ **引用消息支持** — 支持恢复大多数引用场景
- ✅ **Markdown 回复** — 支持富文本格式回复
- ✅ **互动卡片** — 支持流式更新，适用于 AI 实时输出

---

## 安装

### 方法 A：通过 npm 包安装（推荐）

```bash
openclaw plugins install @mjand66/openclaw-dingtalk
```

### 方法 B：通过本地源码安装

```bash
git clone https://github.com/MyQiongbao/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
openclaw plugins install .
```

---

## 配置

安装后在 `~/.openclaw/openclaw.json` 中配置钉钉频道：

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "你的钉钉机器人 ClientID",
      "clientSecret": "你的钉钉机器人 ClientSecret",
      "robotCode": "你的钉钉机器人 ClientID",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "messageType": "markdown"
    }
  }
}
```

### 配置项说明

| 字段 | 说明 |
|------|------|
| `clientId` | 钉钉开放平台机器人的 Client ID |
| `clientSecret` | 钉钉开放平台机器人的 Client Secret |
| `robotCode` | 同 `clientId` |
| `dmPolicy` | 私聊策略：`open`（所有人）/ `allowFrom`（白名单） |
| `groupPolicy` | 群聊策略：`open`（所有人）/ `allowFrom`（白名单） |
| `messageType` | 回复格式：`markdown`（默认）/ `text` |
| `allowFrom` | 白名单用户 ID 列表（当 policy 为非 open 时生效） |

---

## 钉钉机器人配置步骤

1. 登录[钉钉开放平台](https://open.dingtalk.com)
2. 进入 **应用开发 → 企业内部开发 → 机器人**
3. 创建机器人，记录 **Client ID** 和 **Client Secret**
4. 在机器人设置中开启 **Stream 模式**
5. 将 Client ID 和 Client Secret 填入 OpenClaw 配置

---

## 与原版的区别

本包 (`@mjand66/openclaw-dingtalk`) 基于 [soimy/openclaw-channel-dingtalk](https://github.com/soimy/openclaw-channel-dingtalk) 开发，在原版基础上增加了：

| 改动 | 说明 |
|------|------|
| 实时工具进度通知 | 通过全局事件总线监听每次工具调用，即时推送进度 |
| 语义化工具标签 | 解析命令意图生成可读标签（brew install、文件读写等） |
| 60 秒心跳 | 长任务定期报告已用时，避免用户等待焦虑 |
| 去重过滤 | 模型前置说明文字不在最终回复中重复出现 |
| tool 类型 deliver 过滤 | 任务完成后仅发送最终结果，中间过程不批量重发 |

相关 PR：[soimy/openclaw-channel-dingtalk#314](https://github.com/soimy/openclaw-channel-dingtalk/pull/314)

---

## License

MIT
