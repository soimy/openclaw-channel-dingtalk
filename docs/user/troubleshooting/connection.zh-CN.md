# 钉钉连接排障手册（中文）

## 插件安装后无法加载

如果 `openclaw plugins list` 显示 `dingtalk` 但插件加载失败或 gateway 日志报缺少 runtime entry：

- ClawHub/npm 安装：发布包应包含编译后的 `dist/index.js`（v3.6.2+）。如果看到 `expected ./dist/index.js`，请报告 issue — 可能安装了旧版本包。
- 本地源码安装：必须在 `openclaw plugins install -l .` 之前执行 `pnpm run build`。OpenClaw 2026.5.x 需要编译后的 runtime 入口，纯源码安装会失败。
- 本地开发：拉取代码变更后，务必执行 `pnpm run build` 再 `openclaw gateway restart`，然后才能真机调试。

## 群聊回复丢失或出现空卡片

如果群聊回复表现为空卡片或 fallback markdown 消息，而非预期回复：

- 确认插件版本不低于 v3.6.2。OpenClaw 2026.5.7+ 群聊默认 `visibleReplies=message_tool`，会将 DingTalk card/markdown final 导向 message tool 路径。v3.6.2+ 已自动覆盖此行为（PR #553、PR #565）。
- 无需额外配置 — 覆盖是自动生效的。
