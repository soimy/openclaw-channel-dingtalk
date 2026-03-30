# 测试与验证

仓库使用 Vitest 进行单元和集成测试。

## 运行测试

```bash
pnpm test
```

生成覆盖率：

```bash
pnpm test:coverage
```

类型检查：

```bash
npm run type-check
```

Lint：

```bash
npm run lint
```

## 当前测试约束

- 网络请求通过 mock 拦截，不访问真实钉钉 API
- 集成测试会隔离外部依赖
- 文档与 workflow 变更应额外通过 `pnpm run docs:build` 做站点级验证

## 真机验证建议

当行为涉及 `/reasoning`、`/verbose`、tool summary 或 markdown/card 显示差异时，建议补一次真机验证。

推荐区分两层结论：

- 插件通路是否可用：事件一旦进入 DingTalk channel，能否按预期发送为 reasoning / tool / answer
- 模型是否真的触发了事件：例如是否真的发起了 `toolCall`

排查时可优先观察：

- `~/.openclaw/logs/gateway.log`
- `openclaw logs`
- 对应 session transcript：`~/.openclaw/agents/main/sessions/*.jsonl`

建议日志关键词：

- `stream=tool`
- `[DingTalk][Markdown] deliver kind=tool`
- `[DingTalk][SessionSend]`

### 关于 `/verbose on`

`/verbose on` 只表示插件允许发送 tool summary，不代表模型一定会产生真实工具调用。

如果想验证独立的 tool 消息通路，优先使用无法被模型直接“猜答案”的探针，例如：

```text
先执行 `uuidgen`，然后只回复两行：
第一行原样输出命令结果；
第二行“verbose on正常”。
```

如果日志里没有 `stream=tool` 或 `deliver kind=tool`，更可能是模型没有真的触发工具，而不是插件发送链路失效。

## 适用建议

- 行为改动优先补测试
- 文档结构调整优先验证链接、导航和构建链路
- 合并前至少跑一次与改动范围相符的完整验证
