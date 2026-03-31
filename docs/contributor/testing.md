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
- 文档与 workflow 变更应额外通过 `npm run docs:build` 做站点级验证

## 真机测试指引

### 适用范围

凡是 PR 改动涉及钉钉消息链路的用户可感知行为，PR 作者都应在最终合并前完成与本 PR 相关的真机测试。

这里的“钉钉消息链路”包括但不限于：

- 入站接收与消息解析
- 路由、上下文注入与会话关联
- 出站发送与降级路径
- markdown 或 card 等客户端展示
- 卡片回调、停止交互与恢复链路
- 引用恢复、媒体下载/上传与相关附件处理

当前阶段，真机测试结果只要求由作者写入 PR 描述的 `验证 TODO` 做口头确认，不强制附截图、日志片段或固定证据模板。

### 推荐真机环境

推荐使用全局运行中的 `openclaw` 做真机联调，并在开始前确认以下事项：

- 插件目录已经指向当前开发仓库或对应 worktree
- `~/.openclaw/openclaw.json` 已按本次测试链路需要完成设置调整
- 如果本次测试依赖特定账号、reply mode 或其他钉钉链路配置，应先修改配置再开始
- 执行一次 `openclaw gateway restart`，确认最新代码与配置已经生效

测试完成后，应复原插件目录指向与 `~/.openclaw/openclaw.json` 中为本次联调临时修改的设置；如有必要，再执行一次 `openclaw gateway restart`。

### 标准执行清单

1. 先完成与改动范围匹配的本地验证，通常至少包括 `pnpm test`、`npm run type-check`、`npm run lint`；如果改动涉及文档站或 workflow，再补 `npm run docs:build`。
2. 明确本 PR 实际影响的真机场景，只测试相关链路，不额外追加无关基线。例如私聊回复、群聊展示、卡片交互、引用恢复、媒体处理等。
3. 在钉钉里逐项跑通这些场景，确保每个场景都真实走完一遍用户侧闭环，而不是只看日志或只依赖本地测试结果。
4. 如结果不符合预期，再按需观察 `~/.openclaw/logs/gateway.log`、`openclaw logs`，必要时查看对应 session transcript：`~/.openclaw/agents/main/sessions/*.jsonl`。
5. 在 PR 描述的 `验证 TODO` 中写清本次实际执行的真机场景、结果是否符合预期，以及是否存在已知限制或未覆盖项。

### 通用判定与排查

真机测试优先以钉钉侧的实际现象为准：用户是否能看到预期消息、交互是否真的生效、恢复链路是否真的闭环。

测试输入应尽量覆盖本 PR 改动路径，并优先选择结果可客观核对的探针。避免使用“模型可能直接猜对也会看起来通过”的提示词，否则容易把不充分的测试误判为链路通过。

如果结果不符合预期，建议优先按以下顺序判断：

- 先确认本次测试输入是否真的覆盖了被改动链路
- 再判断偏差发生在入站、路由与上下文、出站发送、客户端展示，还是交互回调或恢复阶段
- 最后结合 `gateway.log`、`openclaw logs` 与 session transcript 缩小范围

只有在怀疑连接或 stream 接收本身异常时，再按需使用仓库里的连接诊断脚本，例如 `scripts/dingtalk-connection-check.*` 和 `scripts/dingtalk-stream-monitor.mjs`。

不要把一次含糊的提示词、一次无法客观核对的回复，或一次未覆盖真实路径的测试，直接等同于“插件链路正常”或“插件链路失效”。

### `验证 TODO` 示例

可在 PR 描述中按下面的方式简要确认：

```text
验证 TODO
- 已按当前 worktree 切换插件目录，按需更新 ~/.openclaw/openclaw.json，并执行 openclaw gateway restart
- 已真机验证：群聊 markdown 回复、引用恢复
- 结果：与本 PR 目标一致，未发现新增异常
- 收尾：已复原插件目录指向与临时 openclaw.json 设置
```

## 适用建议

- 行为改动优先补测试
- 文档结构调整优先验证链接、导航和构建链路
- 合并前至少跑一次与改动范围相符的完整验证
