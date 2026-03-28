# OpenClaw DingTalk Channel 插件推介文（社交媒体版）

想在钉钉里部署企业内部 AI 助手，但不想折腾公网 IP / Webhook 回调？

`OpenClaw DingTalk Channel` 走的是 **Stream 模式（WebSocket 长连接）**：只要机器能出网，就能把机器人稳定跑在内网、开发机、甚至笔记本上。

> 【截图占位：效果展示（AI 互动卡片流式吐字 / Markdown 回复对比）】

---

## 功能特色

- **Stream 模式**：WebSocket 长连接，无需公网 IP、无需回调地址
- **私聊 + 群聊**：支持私聊机器人；群里 @机器人对话
- **多消息类型**：文本、富文本、图片、语音（使用钉钉识别结果）、视频、文件（媒体会下载并交给 Agent）
- **两种回复模式**：
  - `markdown`：默认模式，兼容性强，自动检测 Markdown
  - `card`：AI 互动卡片，支持真正的流式更新，更接近 ChatGPT 的体验
- **AI Card 增强（可控开关）**：在卡片中显示推理流与工具执行结果
  - `/reasoning stream` 开启推理流展示，`/reasoning off` 关闭
  - `/verbose on` 开启工具执行展示，`/verbose off` 关闭
- **企业级访问控制**：
  - 私聊策略 `dmPolicy`: `open` / `pairing`（配对码验证）/ `allowlist`
  - 群聊策略 `groupPolicy`: `open` / `allowlist`
  - `allowFrom` 支持 `dingtalk:` / `dd:` / `ding:` 前缀，支持 `*` 通配
- **连接鲁棒性**：断线自动重连 + 指数退避，可配置最大重试次数与抖动
- **多账号**：支持 `channels.dingtalk.accounts` 进行多账号配置（适合多企业/多机器人）

---

## 快速上手

1. 安装插件（推荐 npm 安装）

```bash
openclaw plugins install @soimy/dingtalk
```

2. 配置插件信任白名单 `plugins.allow`（这是安全告警机制的一部分）

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  }
}
```

> 【截图占位：`openclaw.json` 中 `plugins.allow` 配置】

3. 交互式配置（推荐）

```bash
openclaw onboard
# 或：
openclaw configure --section channels
```

> 【截图占位：OpenClaw onboard 选择 DingTalk / 配置项填写界面】

4. 试运行

- 私聊机器人发一句话
- 或在群里 `@机器人 + 问题`

---

## 配置流程及说明

### A. 钉钉开发者后台配置（一次性）

1. 创建企业内部应用
2. 添加「机器人」能力
3. 消息接收模式选择 **Stream 模式**
4. 发布应用

> 【截图占位：钉钉开发者后台-机器人能力-Stream 模式开关】

#### 卡片权限（仅当你要用 AI 互动卡片）

在「权限管理」里开启（名称以控制台为准）：

- `Card.Instance.Write`
- `Card.Streaming.Write`

> 【截图占位：钉钉开发者后台-权限管理-Card 权限勾选】

#### AI 卡片模板（可选，但 `messageType=card` 时必需）

1. 进入钉钉卡片平台，创建模板（场景选择 **AI 卡片**）
2. 记录模板 `templateId`（形如 `xxxxx-xxxxx-xxxxx.schema`）
3. 记录你在模板里用于承载正文的字段名（对应 `cardTemplateKey`）

> 【截图占位：钉钉卡片平台-创建 AI 卡片模板-选择 AI 卡片场景】
> 【截图占位：钉钉卡片平台-模板字段定义-正文变量名（cardTemplateKey）】

---

### B. OpenClaw 插件配置（两种方式）

#### 方式 1：交互式配置（推荐）

建议按向导填写：

- `Client ID` = AppKey
- `Client Secret` = AppSecret
- 进阶项（推荐填全以获得更好的兼容性）：`Robot Code`、`Corp ID`、`Agent ID`
- 选择回复模式：
  - 常规场景：`markdown`
  - AI 对话沉浸体验：`card`（需配置 `cardTemplateId` / `cardTemplateKey`）
- 设置安全策略：
  - 私聊 `dmPolicy`：`open` / `pairing` / `allowlist`
  - 群聊 `groupPolicy`：`open` / `allowlist`

> 【截图占位：OpenClaw DingTalk 配置向导-凭证填写】
> 【截图占位：OpenClaw DingTalk 配置向导-安全策略(dmPolicy/groupPolicy)】
> 【截图占位：OpenClaw DingTalk 配置向导-消息类型(messageType=markdown/card)】

#### 方式 2：手动编辑 `~/.openclaw/openclaw.json`

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "dingxxxxxx",
      "clientSecret": "your-app-secret",
      "dmPolicy": "open",
      "groupPolicy": "open",
      "allowFrom": [],
      "debug": false,
      "messageType": "markdown"

      // 当 messageType = "card" 时再加下面两项：
      // "cardTemplateId": "你复制的模板ID",
      // "cardTemplateKey": "你模板的内容变量"
    }
  }
}
```

手动配置后需要重启：

```bash
openclaw gateway restart
```

> 【截图占位：OpenClaw 日志中 DingTalk 连接成功 / 收到消息的关键日志】

---

## 欢迎加入

这个插件不是“拍脑袋做出来的成品”，它的起点来自社区真实需求，过程中经历了从 Stream 模式连接摸索（早期甚至需要逆向/试错）、能力补齐到架构重构，再到和 OpenClaw 社区一起打磨稳定性与体验的迭代。

一个简短时间线（摘自社区复盘，便于你在社媒里讲清“为什么它值得用”）：

- `2025-08`：社区开始推动“钉钉 Stream 模式 Channel”方向
- `2026-01`：架构模块化重构，补齐测试与工程化（Vitest、类型与 lint 约束等）
- `2026-02`：AI Card 流式更新链路与连接鲁棒性等持续迭代

- 如果你也在企业内网、开发机、本地环境里需要一个“可控、可扩展、能对话能做事”的钉钉机器人：欢迎来用、来提需求、来一起改
- 社区协作与开发历史可参考 OpenClaw 讨论帖（截至 `2026-02-16` 的阶段性复盘、里程碑与贡献者列表；其中也提到与社区维护者如 dzt、yuntianxiaozhi 的协作推进）：[openclaw/discussions/17843](https://github.com/openclaw/openclaw/discussions/17843)

项目地址：[soimy/openclaw-channel-dingtalk](https://github.com/soimy/openclaw-channel-dingtalk)

---

## 还可以补充什么？（建议）

- 增加一个「适用场景」段落：内网部署、企业知识库问答、工单/告警联动、研发群助手等
- 增加一段「故障排除」快捷清单：收不到消息、群聊无响应、连接失败（并配日志截图）
- 增加一张「成本提示」小卡片：`markdown` vs `card` 的 API 调用差异，提醒推理流/工具展示可能增加卡片流更新次数
- 增加「安全策略示例」：`pairing`、`allowlist` 的典型配置片段（便于企业落地）
- 增加「更新方式」：`openclaw plugins update dingtalk`（npm 安装）或源码更新后的重启流程
- 增加「贡献入口」：`npm run type-check` / `npm run lint` / `pnpm test`，欢迎提交 PR

标签建议：`#OpenClaw` `#钉钉机器人` `#AI助手` `#内网部署` `#开源` `#Stream模式`
