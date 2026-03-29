<p align="center">
  <img src="docs/assets/dingclaw-banner.svg" alt="DingClaw Banner" width="1040">
</p>

# DingTalk Channel for OpenClaw

<p class="repo-badges">
  <a href="https://github.com/openclaw/openclaw"><img alt="OpenClaw" src="https://img.shields.io/badge/OpenClaw-%3E%3D2026.3.24-0A7CFF"></a>
  <a href="https://www.npmjs.com/package/@soimy/dingtalk"><img alt="npm version" src="https://img.shields.io/npm/v/%40soimy%2Fdingtalk"></a>
  <a href="https://www.npmjs.com/package/@soimy/dingtalk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40soimy%2Fdingtalk"></a>
  <a href="https://github.com/soimy/openclaw-channel-dingtalk/actions/workflows/docs-pages.yml"><img alt="Docs" src="https://img.shields.io/github/actions/workflow/status/soimy/openclaw-channel-dingtalk/docs-pages.yml?branch=main&label=Docs"></a>
  <a href="https://github.com/soimy/openclaw-channel-dingtalk/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/soimy/openclaw-channel-dingtalk"></a>
</p>

针对 OpenClaw 的钉钉企业内部机器人 Channel 渠道插件，使用 Stream 模式，无需公网 IP。

## 功能特性

- Stream 模式，无需 Webhook 和公网入口
- 支持私聊、群聊和 @机器人
- 支持文本、图片、语音、视频、文件和钉钉文档/文件卡片
- 支持引用消息恢复和常见文本附件正文抽取
- 支持 Markdown 回复与 AI 卡片流式回复
- 支持多 Agent、多机器人绑定和实验性的 `@多助手路由`
- 支持实时中止当前 AI generation。常用停止指令包括 `停止`、`stop`、`/stop`、`esc` 等
- 接入 OpenClaw 消息处理与 outbound 能力

## 文档入口

- 文档站点：<https://soimy.github.io/openclaw-channel-dingtalk/>
- 用户文档入口：[docs/user/index.md](docs/user/index.md)
- 参与贡献入口：[docs/contributor/index.md](docs/contributor/index.md)
- 发布记录：[docs/releases/index.md](docs/releases/index.md)
- 英文入口：[docs/en/index.md](docs/en/index.md)

## 安装

> [!IMPORTANT]
> 最小兼容版本为 `OpenClaw 2026.3.24`。安装前请先升级到最新版 OpenClaw。
>
> 由于上游 ClawHub 安装链路目前存在 bug，暂时无法稳定通过 `openclaw plugins install @soimy/dingtalk` 完成安装。
> 当前推荐使用源码链接安装：
>
> ```bash
> git clone https://github.com/soimy/openclaw-channel-dingtalk.git
> cd openclaw-channel-dingtalk
> npm install # 或 pnpm install
> openclaw plugins install -l .
> ```
>
> 详见下方：[本地开发或联调可使用源码链接安装](#本地开发或联调可使用源码链接安装)

如需关注上游修复进展：

- ClawHub scoped package install bug: <https://github.com/openclaw/openclaw/issues/56452>
- ClawHub plugin package owner controls: <https://github.com/openclaw/openclaw/issues/56451>

历史 npm 安装命令如下，但在上游修复前不推荐使用：

```bash
openclaw plugins install @soimy/dingtalk
```

### 本地开发或联调可使用源码链接安装

当前生产安装也建议使用源码链接安装：

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install # 或 pnpm install
openclaw plugins install -l .
```

安装后建议显式配置 `plugins.allow`：

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["dingtalk"]
  }
}
```

详细说明：

- [安装指南](docs/user/getting-started/install.md)

## 更新

npm 安装来源：

```bash
openclaw plugins update dingtalk
```

本地源码 / 链接安装来源：

```bash
git pull
openclaw gateway restart
```

详细说明：

- [更新指南](docs/user/getting-started/update.md)

## 配置

推荐优先使用交互式配置：

```bash
openclaw onboard
```

或：

```bash
openclaw configure --section channels
```

最小手动配置示例：

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
      "messageType": "markdown"
    }
  }
}
```

详细说明：

- [配置指南](docs/user/getting-started/configure.md)
- [钉钉权限与凭证](docs/user/getting-started/permissions.md)
- [配置项参考](docs/user/reference/configuration.md)

## 重要功能文档

- [消息类型支持](docs/user/features/message-types.md)
- [回复模式](docs/user/features/reply-modes.md)
- [AI 卡片](docs/user/features/ai-card.md)
- [钉钉文档 API](docs/user/features/dingtalk-docs-api.md)
- [反馈学习](docs/user/features/feedback-learning.md)
- [多 Agent 与多机器人绑定](docs/user/features/multi-agent-bindings.md)
- [@多助手路由](docs/user/features/at-agent-routing.md)
- [安全策略](docs/user/reference/security-policies.md)
- [API 消耗说明](docs/user/reference/api-usage-and-cost.md)
- [故障排查](docs/user/troubleshooting/index.md)

## 开发简述

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
npm run type-check
npm run lint
pnpm test
```

更多开发与维护说明：

- [本地开发](docs/contributor/development.md)
- [测试与验证](docs/contributor/testing.md)
- [架构说明（中文详版）](docs/contributor/architecture.zh-CN.md)
- [NPM 发布](docs/contributor/npm-publish.md)

## 许可

[MIT](LICENSE)
