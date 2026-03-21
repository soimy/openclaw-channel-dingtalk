# Scenario-Driven 真机测试 Harness 开发计划

> **给执行型 agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行本计划。所有步骤使用 `- [ ]` 复选框语法跟踪。

**目标：** 在现有 `debug:session` 基础上实现一套 scenario-driven real-device harness，把真机验证固化为声明式场景、标准化 operator 输入输出界面和可恢复的 phase machine，同时让 `Vitest` 只验证协议和状态流转，不直接执行真机交互。

**架构：** 保留当前 `scripts/dingtalk-debug-session.mjs` 作为底层 primitive，新增 `scripts/real-device-scenarios/` 作为高层编排层。第一阶段仅支持 DingTalk，并只固化两个已真实跑通的场景：`pr389-quoted-attachment` 与 `pr389-preview-store-miss`。Runner 统一输出 `session.json`、`operator-prompt.md`、`operator-input.json`、`observation.template.json` 等标准化文件，并通过 `verify --scenario` / `verify --resume` 推进阶段。

**技术栈：** Node.js `.mjs` 脚本、现有 debug-session helpers、Vitest、Markdown、JSON 产物、DingTalk 现有会话状态与本地学习目录。

---

### 任务 1：先锁定 scenario schema 与场景加载器

**文件：**
- 新建：`scripts/real-device-scenarios/runtime/scenario-loader.mjs`
- 新建：`scripts/real-device-scenarios/runtime/scenario-schema.mjs`
- 新建：`scripts/real-device-scenarios/scenarios/pr389-quoted-attachment.mjs`
- 新建：`scripts/real-device-scenarios/scenarios/pr389-preview-store-miss.mjs`
- 新建：`tests/unit/real-device-scenarios/scenario-loader.test.ts`

- [ ] **步骤 1：先写失败测试**

新增测试，确认：

- 合法 scenario 可以被加载
- 缺失关键字段时会抛出错误
- 两个 PR389 场景都能通过 schema 校验

至少覆盖：

```ts
it("loads pr389 preview store miss scenario", () => {
  const scenario = loadScenario("pr389-preview-store-miss");
  expect(scenario.id).toBe("pr389-preview-store-miss");
  expect(scenario.channel).toBe("dingtalk");
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-scenarios/scenario-loader.test.ts`

预期：FAIL，因为 loader / schema / scenario 文件尚不存在。

- [ ] **步骤 3：补最小实现**

实现：

- 最小 schema 校验
- `loadScenario(id)`
- 两个 PR389 场景文件

第一阶段只支持：

- `channel = dingtalk`
- `target.mode = dm | group`
- `target.resolver = latest_inbound_sender | latest_inbound_conversation`

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-scenarios/scenario-loader.test.ts`

预期：PASS。

### 任务 2：实现标准化 prompt / input / template 渲染

**文件：**
- 新建：`scripts/real-device-scenarios/runtime/prompt-renderer.mjs`
- 新建：`tests/unit/real-device-scenarios/prompt-renderer.test.ts`

- [ ] **步骤 1：先写失败测试**

锁定这些输出：

- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`
- `operator-prompt.md`
- `operator-input.json`
- `observation.template.json`

测试应确认：

- operator prompt 可独立阅读执行
- prompt 中包含场景目标、trace token 占位和步骤顺序
- observation template 结构固定且字段齐全

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-scenarios/prompt-renderer.test.ts`

预期：FAIL。

- [ ] **步骤 3：补最小渲染器实现**

渲染器需要：

- 接收 `scenario + session metadata + current phase`
- 输出 markdown 和 JSON 字符串
- 支持两阶段 prompt：
  - `resolve-target`
  - `operator-action`

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-scenarios/prompt-renderer.test.ts`

预期：PASS。

### 任务 3：实现 phase machine

**文件：**
- 新建：`scripts/real-device-scenarios/runtime/phase-machine.mjs`
- 新建：`tests/unit/real-device-scenarios/phase-machine.test.ts`

- [ ] **步骤 1：先写失败测试**

先锁定 phase 流转：

- `created -> resolve_target`
- `resolve_target -> setup`
- `setup -> operator_step`
- `operator_step -> waiting_for_observation`
- `waiting_for_observation -> judging`
- `judging -> completed`

并覆盖至少一个多阶段暂停场景，例如：

- 先发 seed message
- 等待 harness 删除 `messages.context`
- 再继续执行 quote step

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-scenarios/phase-machine.test.ts`

预期：FAIL。

- [ ] **步骤 3：补最小状态机实现**

状态机至少需要：

- 当前 `phase`
- 当前 `status`
- `resumeCommand`
- 下一步由谁执行

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-scenarios/phase-machine.test.ts`

预期：PASS。

### 任务 4：实现 target resolver

**文件：**
- 新建：`scripts/real-device-scenarios/runtime/target-resolver.mjs`
- 新建：`tests/unit/real-device-scenarios/target-resolver.test.ts`

- [ ] **步骤 1：先写失败测试**

锁定以下优先级：

1. 从当前 session 的 inbound 数据解析
2. 从 `resolve-target.response.json` 解析
3. 从本地 `targets.directory` 学习目录补齐
4. 最后才接受显式 override

场景至少包括：

- DM 场景从 sender staffId 解析成功
- group 场景从 conversationId 解析成功
- 无法自动解析时进入 `resolve-target`

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-scenarios/target-resolver.test.ts`

预期：FAIL。

- [ ] **步骤 3：补最小 resolver 实现**

要求：

- 不固化某个用户或某个群
- 能读取本地已有 DingTalk 目录状态
- 自动解析失败时返回“需要人工补充”的结构化结果

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-scenarios/target-resolver.test.ts`

预期：PASS。

### 任务 5：实现 scenario runner 外壳

**文件：**
- 新建：`scripts/real-device-scenarios/runtime/verify.mjs`
- 新建：`scripts/real-device-scenarios/runtime/operator-io.mjs`
- 新建：`tests/integration/real-device-scenarios/verify-runner.test.ts`
- 按需修改：`package.json`

- [ ] **步骤 1：先写失败集成测试**

集成测试锁定：

- `pnpm real-device verify --scenario pr389-preview-store-miss`
  - 会创建 session 目录
  - 会生成 `session.json`
  - 会生成 prompt / template 文件
  - 会在等待态退出，而不是卡住

- `pnpm real-device verify --resume <sessionDir>`
  - 在 observation 存在时会推进到 judge

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/integration/real-device-scenarios/verify-runner.test.ts`

预期：FAIL。

- [ ] **步骤 3：补 runner 实现**

实现：

- `verify --scenario <id>`
- `verify --resume <sessionDir>`

第一阶段要求：

- 内部复用现有 `debug:session` 能力
- 使用 `session.json` 作为全局状态真源
- 在等待态打印明确的下一步提示

- [ ] **步骤 4：补 package script**

增加：

```json
{
  "scripts": {
    "real-device:verify": "node scripts/real-device-scenarios/runtime/verify.mjs"
  }
}
```

- [ ] **步骤 5：重新运行聚焦集成测试**

运行：`pnpm test tests/integration/real-device-scenarios/verify-runner.test.ts`

预期：PASS。

### 任务 6：把现有 debug-session primitive 正式接入 runner

**文件：**
- 修改：`scripts/real-device-scenarios/runtime/verify.mjs`
- 读取并复用：`scripts/real-device-debug/*.mjs`
- 新建：`tests/integration/real-device-scenarios/debug-session-bridge.test.ts`

- [ ] **步骤 1：先写失败测试**

锁定：

- runner 会调用现有 session creation 能力
- runner 会使用现有 `prepare`
- runner 会使用现有 `observe`
- runner 会使用现有 `judge`

不要在测试里起真实 gateway，使用 fake runner / fake observation 即可。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/integration/real-device-scenarios/debug-session-bridge.test.ts`

预期：FAIL。

- [ ] **步骤 3：补桥接实现**

要求：

- 不重复实现已有逻辑
- runner 只做场景编排，不重写底层 session 能力

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/integration/real-device-scenarios/debug-session-bridge.test.ts`

预期：PASS。

### 任务 7：补文档与使用说明

**文件：**
- 新建：`docs/real-device-harness.md`
- 新建：`docs/real-device-harness.zh-CN.md`
- 修改：`README.md`
- 修改：`CONTRIBUTING.md`
- 修改：`CONTRIBUTING.zh-CN.md`

- [ ] **步骤 1：写 harness 专用文档**

文档需要覆盖：

- 为什么引入 scenario-driven harness
- 它和现有 `debug:session` 的关系
- 如何新增一个 scenario
- 如何运行 `verify --scenario`
- 如何运行 `verify --resume`
- target 动态解析的原则
- operator 输入输出文件说明

- [ ] **步骤 2：更新 README**

补一个短入口，说明：

- `debug:session` 是底层 primitive
- `real-device verify` 是推荐的场景入口

- [ ] **步骤 3：更新贡献指南**

让贡献者知道：

- 真机验证应优先提交 scenario
- PR 中可以引用 scenario id
- operator 产物如何附在 PR 中

- [ ] **步骤 4：校对路径和命令**

确保文档中所有文件路径、脚本名、命令与实际实现一致。

### 任务 8：最终验证

**文件：**
- 验证所有新增 scenario runtime 文件与文档

- [ ] **步骤 1：运行 scenario runtime 测试**

运行：

- `pnpm test tests/unit/real-device-scenarios/*.test.ts`
- `pnpm test tests/integration/real-device-scenarios/*.test.ts`

预期：全部通过。

- [ ] **步骤 2：运行现有 debug-session 测试**

运行：

- `pnpm test tests/unit/real-device-debug/*.test.ts tests/integration/real-device-debug/*.test.ts`

预期：全部通过，确保高层 harness 没破坏底层 primitive。

- [ ] **步骤 3：运行仓库级检查**

运行：

- `npm run type-check`
- `npm run lint`

预期：通过；若仍存在仓库原有 warning，需要在总结中明确说明与本次改动无关。

- [ ] **步骤 4：做两条真实 smoke scenario**

至少真实执行：

- `pr389-quoted-attachment`
- `pr389-preview-store-miss`

预期：

- 都能在 `verify --scenario` 下生成标准化操作包
- 都能在 `verify --resume` 后完成判定

- [ ] **步骤 5：确认第一阶段边界**

在宣布完成前，明确确认第一阶段仍然：

- 不直接控制钉钉桌面 UI
- 不把人工等待步骤塞进 `Vitest`
- 不要求固定 targetId
- 不扩展到所有渠道
