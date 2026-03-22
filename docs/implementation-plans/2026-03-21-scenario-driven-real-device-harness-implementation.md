# Scenario-Driven 真机测试 Harness 开发计划

> **状态更新时间：** 2026-03-22
> **当前分支：** `feat/real-device-debug-session-automation-pr`
> **当前 PR：** `#393`（Draft）
> **目标：** 把 DingTalk 真机验证沉淀为“场景定义 + 标准化操作包 + 可恢复阶段机 + 底层 debug-session primitive”组合，形成可复用、可归档、可在新 thread 中无缝接续的半自动闭环。

## 一、实现结论与当前边界

- [x] 已确认采用“分层半自动闭环”方案，而不是把人工桌面交互强塞进 `Vitest`。
- [x] 已确认 `debug:session` 保持为底层 primitive。
- [x] 已确认新增 `real-device:verify` 作为高层 scenario runner。
- [x] 已确认 target 不能固化某个用户/群，而应优先从 inbound / operator 响应 / 学习目录动态解析。
- [x] 已确认本阶段不直接控制钉钉桌面 UI，桌面操作继续交给人工或外部具备桌面操作能力的 agent / peekaboo。

## 二、已落地的主要提交

- [x] `40dbf9b` `feat: scaffold scenario-driven real-device harness`
- [x] `2a46fde` `feat: add scenario-driven real-device harness runtime`
- [x] `838541d` `fix: complete scenario harness observation flow`
- [x] `78ae1bc` `test: make scenario runner checks deterministic in CI`

## 三、已落地文件范围

### 1. Runtime / Harness

- [x] `scripts/real-device-scenarios/runtime/scenario-schema.mjs`
- [x] `scripts/real-device-scenarios/runtime/scenario-loader.mjs`
- [x] `scripts/real-device-scenarios/runtime/prompt-renderer.mjs`
- [x] `scripts/real-device-scenarios/runtime/phase-machine.mjs`
- [x] `scripts/real-device-scenarios/runtime/target-resolver.mjs`
- [x] `scripts/real-device-scenarios/runtime/operator-io.mjs`
- [x] `scripts/real-device-scenarios/runtime/verify.mjs`
- [x] `scripts/real-device-scenarios/runtime/harness-actions.mjs`
- [x] `scripts/real-device-scenarios/runtime/log-evidence.mjs`

### 2. 场景定义

- [x] `scripts/real-device-scenarios/scenarios/pr389-preview-store-miss.mjs`
- [x] `scripts/real-device-scenarios/scenarios/pr389-quoted-attachment.mjs`

### 3. 文档

- [x] `docs/real-device-harness.md`
- [x] `docs/real-device-harness.zh-CN.md`
- [x] `docs/designs/2026-03-21-scenario-driven-real-device-harness-design.md`
- [x] `docs/implementation-plans/2026-03-21-scenario-driven-real-device-harness-implementation.md`
- [x] `README.md`
- [x] `CONTRIBUTING.md`
- [x] `CONTRIBUTING.zh-CN.md`

## 四、任务执行状态

### 任务 1：锁定 scenario schema 与场景加载器

- [x] 已完成最小 schema 校验与 `loadScenario(id)`。
- [x] 已完成两个 PR389 场景定义落盘。
- [x] 已补充并跑通 `tests/unit/real-device-scenarios/scenario-loader.test.ts`。
- [x] 当前阶段仅支持 `channel = dingtalk`，并覆盖 `dm | group` 的 target 模式。

### 任务 2：实现标准化 prompt / input / template 渲染

- [x] 已完成 `resolve-target` 与 `operator-action` 两阶段 prompt 渲染。
- [x] 已输出标准化文件：
  - `resolve-target-prompt.md`
  - `resolve-target.input.json`
  - `resolve-target.response.template.json`
  - `operator-prompt.md`
  - `operator-input.json`
  - `observation.template.json`
- [x] 已补充并跑通 `tests/unit/real-device-scenarios/prompt-renderer.test.ts`。

### 任务 3：实现 phase machine

- [x] 已完成 `created -> resolve_target / setup -> operator_step -> waiting_for_observation -> judging -> completed` 的主状态流。
- [x] 已支持多阶段暂停与 `resumeCommand` 生成。
- [x] 已补充并跑通 `tests/unit/real-device-scenarios/phase-machine.test.ts`。

### 任务 4：实现 target resolver

- [x] 已支持从当前 session inbound 数据解析 target。
- [x] 已支持从 `resolve-target.response.json` 恢复 target。
- [x] 已支持结合本地学习目录补齐 target 信息。
- [x] 已保证 target 不固化某个用户或群，解析失败时进入结构化人工补充流程。
- [x] 已补充并跑通 `tests/unit/real-device-scenarios/target-resolver.test.ts`。

### 任务 5：实现 scenario runner 外壳

- [x] 已实现 `pnpm real-device:verify --scenario <id>`。
- [x] 已实现 `pnpm real-device:verify --resume <sessionDir>`。
- [x] 已使用 `session.json` 作为会话状态真源。
- [x] 已在等待态输出明确下一步提示，并通过产物文件作为操作闭环接口。
- [x] 已在 `package.json` 中补充 `real-device:verify` script。
- [x] 已补充并跑通 `tests/integration/real-device-scenarios/verify-runner.test.ts`。
- [x] 已为 CI 增加 `--dry-run` 路径，避免测试误触真实 `prepareSession`。

### 任务 6：接入现有 debug-session primitive

- [x] Runner 已桥接现有 `prepareSession` / `recordObservation` / `judgeSession`。
- [x] 已明确 runner 只负责场景编排，不重写底层调试能力。
- [x] 已补充并跑通 `tests/integration/real-device-scenarios/debug-session-bridge.test.ts`。
- [x] 已修复此前真机测试中出现的 `observe` / `judge` 时序误判问题：
  - 在 debug-session 层串行化 `prepare`、`observe`、`judge`
  - 补全 observation 证据组装逻辑
  - 扩展 `judge-session` 对 `Full Inbound Data` / `Inbound:` 证据格式的识别

### 任务 7：补文档与使用说明

- [x] 已完成 harness 专用中英文文档。
- [x] 已在 README 中补入口，说明 `debug:session` 与 `real-device:verify` 的分层关系。
- [x] 已在贡献指南中补充真机验证、scenario 提交与产物归档说明。
- [x] 已校对主要路径、脚本名、命令名与当前实现一致。

### 任务 8：最终验证

- [x] 本地已跑通：
  - `pnpm test tests/unit/real-device-scenarios/*.test.ts tests/integration/real-device-scenarios/*.test.ts tests/unit/real-device-debug/judge-session.test.ts`
  - 共 `8` 个文件、`35` 个测试通过
- [x] 本地已跑通：`npm run type-check`
- [x] 已完成两条真实 smoke scenario：
  - `pr389-preview-store-miss`
  - `pr389-quoted-attachment`
- [ ] `npm run lint` 仍存在仓库历史 warning，需要在后续 thread 中按需区分“历史噪音”与“新增问题”。
- [ ] GitHub Actions 最新 rerun 结果需要在新 thread 中再次确认是否全部转绿。

## 五、真实场景验证结果

### 1. `pr389-preview-store-miss`

- [x] 已完成真实 harness 驱动验证。
- [x] 运行目录：
  - `.local/real-device-runs/2026-03-21/dtdbg-20260321-151226-pr389-preview-store-miss`
- [x] 最终结果：
  - `judgment.json` 为 `end_to_end_success`
  - `summary.md` 与实际操作过程一致
- [x] 场景中已验证 harness action：
  - 备份并删除 `message-context` 记录
  - 观察缺失上下文后的引用恢复行为

### 2. `pr389-quoted-attachment`

- [x] 已完成真实 harness 驱动验证。
- [x] 运行目录：
  - `.local/real-device-runs/2026-03-21/dtdbg-20260321-152840-pr389-quoted-attachment`
- [x] 最终结果：
  - `judgment.json` 为 `end_to_end_success`
  - `summary.md` 与实际操作过程一致

## 六、面向新 Thread 的接续说明

### 1. 当前最重要的未完成项

- [ ] 检查 PR `#393` 的 GitHub Actions 最新 rerun 是否已全部通过。
- [ ] 如果仍有失败，优先查看：
  - `tests/integration/real-device-scenarios/verify-runner.test.ts`
  - `tests/integration/real-device-scenarios/debug-session-bridge.test.ts`
  - `scripts/real-device-scenarios/runtime/verify.mjs`
- [ ] 如果 CI 已转绿，更新 PR 最近一条进展评论，说明：
  - scenario harness 已完成
  - 两条真实场景已跑通
  - 当前剩余工作主要是后续 polish，而非主链路阻塞

### 2. 已知非阻塞项

- [ ] 根仓库与 worktree 同时可见时，可能出现重复 plugin-id warning；当前不影响 DingTalk harness 主流程。
- [ ] OpenClaw 全局配置中仍可能有其他 channel 的旧字段 warning；当前不影响 DingTalk 真机场景执行。
- [ ] 还可以继续增强：
  - 更丰富的 operator response / observation schema
  - 更多 `harness-actions`
  - 从 run artifacts 自动生成 PR/Issue 汇报摘要

### 3. 推荐的新 Thread 起手动作

- [ ] 先执行：`gh pr checks 393 --repo soimy/openclaw-channel-dingtalk`
- [ ] 如需查看 PR 状态：`gh pr view 393 --repo soimy/openclaw-channel-dingtalk --json statusCheckRollup,headRefOid,headRefName,url`
- [ ] 如需本地回归：
  `pnpm test tests/unit/real-device-scenarios/*.test.ts tests/integration/real-device-scenarios/*.test.ts tests/unit/real-device-debug/judge-session.test.ts`
- [ ] 如需重新触发真实场景：
  - `pnpm real-device:verify --scenario pr389-preview-store-miss`
  - `pnpm real-device:verify --scenario pr389-quoted-attachment`

## 七、阶段性结论

- [x] “把真机验证固化为流程 / prompt / 脚本，并与现有测试体系衔接”的第一阶段目标已经达成。
- [x] 当前方案已经具备标准化输入输出界面：
  - 给人工 / 外部桌面 agent 的操作 prompt
  - 等待完成信号的结构化输入文件
  - 归档后的 observation / judgment / summary 证据
- [x] 现阶段最合适的分工仍然是：
  - `Vitest` 验证协议、状态机、runner 行为与桥接逻辑
  - `real-device:verify` 编排真实场景
  - 人工 / peekaboo / 外部具备桌面能力的 agent 完成 DingTalk 客户端操作
