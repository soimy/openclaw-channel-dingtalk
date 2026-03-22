# Scenario-Driven 真机测试 Harness

English version: [`real-device-harness.md`](real-device-harness.md)

本文档说明 DingTalk 插件的 scenario-driven 真机验证 harness。

它是在现有低层 `debug:session` 工作流之上增加的一层高层编排，提供：

- 可版本化的 scenario 定义
- 标准化的 operator prompt / input / observation 界面
- 可暂停、可恢复的 phase machine
- 不依赖固定用户或固定群的 target 动态解析

## 为什么需要它

仓库现在已经有 `pnpm debug:session ...`，它很适合作为低层真机调试原语：

- 启动 session
- 执行预检
- 记录 observation
- 做最终判定

当开发者自己在盯完整个过程时，这已经很有帮助。

但一旦团队希望把“真机测试”沉淀为可复用资产，仅有 `debug:session` 还不够。我们还需要：

- 把测试场景本身写进仓库
- 让人或桌面 Agent 拿到固定 prompt 就能执行
- 让流程可以在中途暂停和恢复，而不依赖聊天上下文

这正是 scenario-driven harness 要解决的问题。

## 它和 `debug:session` 的关系

这两个入口不要混用成同一个东西，而应该理解为两层。

### `pnpm debug:session`

这是低层 primitive。

适合：

- 一次性临时排查
- 开发者自己手动操控 session
- 需要直接控制 `start / prepare / observe / judge`

### `pnpm real-device:verify`

这是高层 scenario 入口。

适合：

- 为某个 PR / commit 定义可复用的真机验证场景
- 让仓库自动生成标准化 operator prompt
- 把客户端侧步骤交给人工或桌面 Agent
- 把场景定义和预期结果一起版本化

简单说：

- `debug:session` = 低层原语
- `real-device:verify` = 高层场景编排器

## 当前范围

当前实现范围是有意收窄的：

- 仅支持 DingTalk
- 仅有第一版 scenario schema
- 已支持 prompt / template 生成
- 已支持 phase machine
- 已支持 DM / group 的 target 动态解析
- 已能桥接到现有 `prepareSession`、`recordObservation` 和 `judgeSession`

它还不是一套覆盖所有真机场景的完整 harness，也不会直接控制钉钉 UI。

## 文件结构与职责

### Scenario 定义

目录：

```text
scripts/real-device-scenarios/scenarios/
```

示例：

- `pr389-quoted-attachment.mjs`
- `pr389-preview-store-miss.mjs`

每个 scenario 定义：

- 验证目标
- target 要求
- fixture
- 有序步骤
- 期望结果
- 清理提示

### Runtime 层

目录：

```text
scripts/real-device-scenarios/runtime/
```

关键模块：

- `scenario-loader.mjs`
- `prompt-renderer.mjs`
- `phase-machine.mjs`
- `target-resolver.mjs`
- `operator-io.mjs`
- `verify.mjs`

### 测试

目录：

```text
tests/unit/real-device-scenarios/
tests/integration/real-device-scenarios/
```

这些测试覆盖：

- schema
- prompt 渲染
- phase 流转
- target 解析
- runner shell
- 与现有 debug-session 的桥接

## 基本命令流程

### 启动一个 scenario

```bash
pnpm real-device:verify --scenario pr389-preview-store-miss
```

这条命令会创建标准化运行包，并停在等待态。

根据当前已知信息，它会生成：

- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`

或：

- `operator-prompt.md`
- `operator-input.json`
- `operator-response.template.json`
- `observation.template.json`

### 恢复一个 scenario

```bash
pnpm real-device:verify --resume <sessionDir>
```

这条命令会读取当前 `session.json.phase`，并在输入文件齐备时继续推进流程。

当前公开 CLI 下，`--resume` 可能停在这些状态之一：

- `WAITING_FOR_TARGET`
- `WAITING_FOR_OPERATOR`
- `WAITING_FOR_OBSERVATION`
- `READY_FOR_JUDGING`

程序化调用时还支持内部 `autoJudge` 路径，用于 observation 记录后的自动判定桥接。

## 标准化运行包

harness 会在 session 目录中生成一个标准化操作包。

常见文件：

- `session.json`
- `scenario.snapshot.json`
- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`
- `resolve-target.response.json`
- `operator-prompt.md`
- `operator-input.json`
- `operator-response.template.json`
- `operator-response.json`
- `observation.template.json`
- `observation.json`

这个操作包的目标消费方包括：

- 人工 operator
- 有桌面交互能力的智能体
- 后续自动化 adapter

当前这些关键文件的含义分别是：

- `resolve-target.response.json`：自动解析 target 不足时的人工回填结果
- `operator-response.json`：每个 operator 步骤的完成信号
- `observation.json`：最终观察结果，用来把流程推进到判定阶段

## Target 动态解析

target 不能被硬编码成某个具体用户或某个固定群。

harness 当前按以下优先级解析 target：

1. 最新 inbound 上下文
2. `resolve-target.response.json`
3. 本地学习到的 `targets.directory`
4. 显式 override

如果都解析失败，session 就保持在 `resolve_target` 阶段。

## 如何新增一个 Scenario

新增 scenario 时建议：

1. 在 `scripts/real-device-scenarios/scenarios/` 下新增场景文件
2. 保持声明式，不要把太多运行时逻辑塞进 scenario 里
3. 优先复用现有 `debug:session` 底层能力
4. 如果引入了新形状，补充 loader / renderer / phase 测试

每个 scenario 最好只验证一个清晰的、用户可见的假设。

好例子：

- quoted attachment 是否进入 `ReplyToBody`
- store miss 时 preview fallback 是否仍然生效

避免把多个不相关假设塞进同一个 scenario。

## 当前推荐用法

日常开发中建议：

- 想要版本化、可复用的真机场景：用 `pnpm real-device:verify ...`
- 想做底层一次性调试：用 `pnpm debug:session ...`

## 相关文档

- [`docs/real-device-debugging.md`](real-device-debugging.md)
- [`docs/real-device-debugging.zh-CN.md`](real-device-debugging.zh-CN.md)
- [`docs/designs/2026-03-21-scenario-driven-real-device-harness-design.md`](designs/2026-03-21-scenario-driven-real-device-harness-design.md)
- [`docs/implementation-plans/2026-03-21-scenario-driven-real-device-harness-implementation.md`](implementation-plans/2026-03-21-scenario-driven-real-device-harness-implementation.md)
