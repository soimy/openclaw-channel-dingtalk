# Scenario-Driven 真机测试 Harness 设计方案

## 背景

当前 DingTalk 插件的许多关键能力，只有在真实 `openclaw gateway + 钉钉客户端` 联动时才能验证：

- 引用消息恢复是否真的进入上游 runtime context
- AI Card 是否真的创建、流式更新、结束态可见
- markdown / text / media 回退链路是否在钉钉客户端中按预期呈现
- 某些 `quotedRef` / `ReplyToBody` / `UntrustedContext` 相关能力，是否真正被用户侧消息触发

现有自动化测试主要基于 `Vitest`，适合验证：

- 插件内部的纯逻辑
- 模块间行为
- 模拟网络请求后的回归

但真机验证目前仍然依赖临时聊天来制定步骤，存在几个问题：

1. 测试步骤没有被版本化
2. 测试人员或桌面 Agent 每次都需要额外补充上下文
3. 操作步骤、观察记录、判定结论之间没有统一协议
4. 很难把一次成功的真机验证沉淀成可复用资产

此前仓库已经引入了第一版 `debug session` 能力，提供：

- `start`
- `prepare`
- `observe`
- `judge`
- `run`

以及 `manifest / timeline / logs / summary / judgment` 这套基础产物。这为进一步建设更高层的、场景驱动的真机测试 harness 提供了良好基础。

## 目标

本设计方案的目标是：

1. 把“真机验证”提升为仓库中的一等测试资产
2. 将每个 PR / commit 需要的真机场景固化为声明式场景文件（scenario）
3. 通过统一 runner 生成标准化输入输出界面
4. 让人工 operator 和有桌面交互能力的智能体都能消费同一套 prompt / JSON 协议
5. 继续复用现有 `debug:session` 能力，而不是推翻重写
6. 让 `Vitest` 负责验证协议、状态机和判定器，而不直接执行真机交互

## 非目标

第一阶段明确 **不做**：

- 不直接将桌面 UI 自动化内嵌到仓库中
- 不要求 OCR 成为主流程的必要条件
- 不把人工等待步骤强行塞进 `Vitest` 生命周期
- 不把所有渠道的真机测试一起抽象，第一阶段只优先支持 DingTalk
- 不要求一开始就覆盖所有复杂场景，只先固化已经真实跑通过的场景

## 设计原则

### 1. 场景是核心，不是临时对话

以后每次要做真机验证，不再通过聊天临时定义步骤，而是提交一个或多个 `scenario` 文件。

`scenario` 文件必须回答：

- 要验证什么能力
- 前置准备是什么
- 哪些步骤由 harness 执行
- 哪些步骤由 operator 执行
- 何时等待
- observation 需要回填什么
- 怎样判定通过 / 失败 / 不确定

### 2. Harness 负责编排，人 / Agent 只负责执行和回填

runner 的职责是：

- 创建和推进 session
- 解析目标
- 渲染 operator prompt
- 执行 setup / teardown
- 等待外部完成
- 生成最终判定

人或桌面 Agent 的职责则被限制在：

- 按 prompt 执行客户端侧动作
- 回填 `resolve-target.response.json` 或 `observation.json`

### 3. 复用现有 debug-session 能力

不另起一套平行系统。新 harness 的底层能力应复用已有：

- `start`
- `prepare`
- `observe`
- `judge`
- `run`

新系统更像是一个高层 orchestrator，而不是重写现有脚本。

### 4. `Vitest` 只测可预测部分

`Vitest` 适合测：

- scenario schema
- prompt 渲染
- phase machine
- target resolver
- judge 逻辑

`Vitest` 不适合直接跑：

- 等待人工点击
- 等待桌面端消息出现
- 等待截图回传

## 总体架构

建议将新体系拆为 4 层：

### 1. Scenario 定义层

每个真机场景都是一个可导入的声明式对象，例如：

- `pr389-quoted-attachment`
- `pr389-preview-store-miss`

它定义：

- 元信息
- 目标要求
- fixture
- 步骤
- 预期
- 清理策略

### 2. Runtime 编排层

负责：

- 加载 scenario
- 创建 / 恢复 session
- 推进 phase
- 调用现有 `debug:session` 原语
- 生成标准化产物

### 3. Operator I/O 层

负责：

- `operator-prompt.md`
- `operator-input.json`
- `resolve-target.response.template.json`
- `observation.template.json`

这一层定义人与桌面 Agent 的最小输入输出协议。

### 4. Judge 层

负责把：

- session manifest
- logs
- observation
- scenario expectation

汇总成：

- `judgment.json`
- `summary.md`

## Scenario 模型

第一阶段推荐的最小模型如下：

```ts
type RealDeviceScenario = {
    id: string;
    title: string;
    goal: string;
    channel: "dingtalk";
    tags?: string[];

    target: {
        mode: "dm" | "group";
        resolver:
            | "latest_inbound_sender"
            | "latest_inbound_conversation";
    };

    fixtures?: {
        seedMessages?: Array<
            | {
                  id: string;
                  kind: "text";
                  content: string;
              }
            | {
                  id: string;
                  kind: "file";
                  filePath: string;
                  contentHint?: string;
              }
        >;
    };

    setup: {
        createSession: boolean;
        restartGateway: boolean;
        startLogs: boolean;
        streamMonitor: boolean;
    };

    steps: Array<
        | {
              id: string;
              actor: "operator";
              kind: "send_message";
              message: string;
          }
        | {
              id: string;
              actor: "operator";
              kind: "quote_message";
              sourceRef: string;
              message: string;
          }
        | {
              id: string;
              actor: "operator";
              kind: "send_fixture";
              sourceRef: string;
          }
        | {
              id: string;
              actor: "harness";
              kind: "delete_message_context_record";
              sourceRef: string;
          }
    >;

    expected: {
        replyVisible: boolean;
        replyShouldContain?: string[];
        replyShouldNotContain?: string[];
        logSignals?: string[];
    };

    cleanup?: {
        restoreBackups?: boolean;
    };
};
```

## Target 解析策略

一个重要约束是：`target` 不能固化成某个具体用户或某个固定群。

不同测试人员、不同租户、不同会话环境下，真实目标应由运行时动态提取。

因此 `target` 不再保存固定 `targetId`，而是保存：

- 目标类型要求
- 解析策略

推荐解析优先级：

1. 从当前 session 期间捕获的 inbound 数据解析
2. 从 operator 回填的 `resolve-target.response.json` 解析
3. 从本地学习目录（如 `targets.directory`）补齐
4. 最后才允许显式 `--target-id` override

这意味着 operator 交互会分两阶段：

### 阶段 A：Resolve Target

如果 harness 无法自动解析当前目标，就生成：

- `resolve-target-prompt.md`
- `resolve-target.input.json`
- `resolve-target.response.template.json`

由人或桌面 Agent 回填最小上下文，例如：

- 当前是私聊还是群聊
- 当前 `conversationId`
- 当前发送人 `staffId`
- 当前显示名

### 阶段 B：Operator Action

目标一旦解析完成，runner 才生成正式的：

- `operator-prompt.md`
- `operator-input.json`
- `observation.template.json`

## 标准化输入输出界面

每次 `verify` 都应生成一个完整的“操作包”。

推荐目录：

```text
.local/real-device-runs/<sessionId>/
  session.json
  scenario.snapshot.json

  resolve-target-prompt.md
  resolve-target.input.json
  resolve-target.response.template.json
  resolve-target.response.json

  operator-prompt.md
  operator-input.json
  observation.template.json
  observation.json

  logs/
  screenshots/
  judgment.json
  summary.md
```

关键文件职责：

### `session.json`

作为全局状态真源，包含：

- 当前 phase
- 当前状态
- `traceToken`
- `sessionId`
- `resumeCommand`

### `operator-prompt.md`

必须是独立、完整、可执行的说明，不依赖聊天上下文。

### `observation.template.json`

给 operator / 桌面 Agent 一个固定结构的回填模板。

### `observation.json`

作为“完成信号”的一部分。只要该文件存在且 `status=completed`，runner 就可以继续推进。

## Runner 命令面

第一阶段建议只暴露两个命令：

```bash
pnpm real-device verify --scenario <id>
pnpm real-device verify --resume <sessionDir>
```

其中：

### `verify --scenario`

负责：

- 加载 scenario
- 创建 session
- 执行 setup
- 尝试 target resolve
- 渲染 prompt / template
- 推进到等待态

### `verify --resume`

负责：

- 读取 `session.json`
- 判断当前 phase
- 消费 `resolve-target.response.json` 或 `observation.json`
- 继续执行后续步骤
- 最后调用 `judge`

## 与现有 `debug:session` 的关系

新体系不替代现有能力，而是包一层：

- `debug:session` 继续作为底层 primitive
- `real-device verify` 作为高层 scenario orchestrator

建议的内部复用关系：

- `verify --scenario`
  - 调现有 `start`
  - 调现有 `prepare`
- `verify --resume`
  - 调现有 `observe`
  - 调现有 `judge`

这样可以最大化复用现有代码和测试。

## 与 Vitest 的关系

`Vitest` 不直接运行真机交互，而是验证 harness 的可预测部分。

第一阶段建议新增以下测试类型：

1. `scenario-loader.test.ts`
   - 验证场景 schema 合法

2. `prompt-renderer.test.ts`
   - 验证 prompt / JSON 模板输出符合预期

3. `phase-machine.test.ts`
   - 验证 phase 流转正确

4. `target-resolver.test.ts`
   - 验证动态目标解析逻辑

5. 复用现有 `judge` 相关测试
   - 验证 observation + filtered log -> outcome

## 第一阶段场景范围

第一阶段不要追求覆盖所有复杂真机场景，只固化已经真实跑通的两条：

1. `pr389-quoted-attachment`
   - 验证 quoted attachment excerpt 能进入 `ReplyToBody`

2. `pr389-preview-store-miss`
   - 验证在 first-hop `store miss` 时，事件 preview 仍能进入 `ReplyToBody`

这样做的好处是：

- 场景已被真实验证
- 预期清晰
- 便于反推最小 schema 和 phase machine

## 增量迁移策略

### 阶段 A：并行存在

- 保留 `pnpm debug:session ...`
- 新增 `pnpm real-device verify ...`
- 先让少数场景通过 harness 跑通

### 阶段 B：场景成为默认入口

当首批 scenario 稳定后：

- 日常真机验证优先写 scenario
- PR 描述中直接引用 `scenario id`
- reviewer / operator 直接运行 `verify --scenario ...`

## 风险与应对

### 1. 场景过度抽象

风险：
- 一开始 schema 过大、过通用，导致落不了地

应对：
- 第一阶段只支持 DingTalk
- 只支持两条已知真机场景

### 2. prompt 不够独立

风险：
- 仍然需要靠聊天补充说明

应对：
- 将 `operator-prompt.md` 视为第一等产物
- 所有等待点必须写入 `session.json`

### 3. session 状态竞争

风险：
- `observe` / `judge` 并发导致误判

应对：
- 继续复用并扩展现有 session 锁机制

### 4. target 解析不稳定

风险：
- 在不同测试人员环境中找不到目标

应对：
- 明确两阶段 target resolve
- 自动解析失败时退回最小人工补充

## 验收标准

第一阶段完成后，应满足：

1. 两个 PR389 场景都能被固化为 scenario 文件
2. `pnpm real-device verify --scenario <id>` 能生成完整操作包
3. 无需额外聊天说明，也能让人或桌面 Agent 完成操作
4. `Vitest` 能验证 scenario schema、phase machine、prompt 渲染和判定逻辑

## 建议落点

设计文档：

- `docs/designs/2026-03-21-scenario-driven-real-device-harness-design.md`

开发计划：

- `docs/plans/2026-03-21-scenario-driven-real-device-harness-implementation.md`
