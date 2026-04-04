# 本地开发

本页面向插件贡献者，说明本地开发的推荐工作流。

## 首次设置

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
```

## 常用命令

```bash
npm run type-check
npm run lint
npm run lint:fix
pnpm run docs:dev
npm run docs:build
pnpm run docs:preview
pnpm test
pnpm test:coverage
```

文档站基于 VitePress，开发态使用 `pnpm run docs:dev`，构建产物预览使用 `pnpm run docs:preview`。
仓库线上文档发布由 GitHub Actions 驱动，通过 Vercel CLI 在 CI 内执行预构建与部署；启用该流程需要在仓库 Secrets 中配置 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

## 推荐仓库布局

```text
~/Repo/openclaw                    # OpenClaw 主仓库，用于阅读源码
~/Repo/openclaw-channel-dingtalk   # 插件开发仓库
~/.openclaw/extensions/...         # OpenClaw 运行时管理目录
```

## 开发建议

- 使用独立分支或 worktree 开发
- 把文档、结构重排和行为变更尽量拆开
- 避免在 `src/channel.ts` 继续堆积新业务逻辑

## 相关文档

- [测试与验证](testing.md)
- [架构说明](architecture.md)
- [Persistence API 使用指南](reference/persistence-api-usage.zh-CN.md)
