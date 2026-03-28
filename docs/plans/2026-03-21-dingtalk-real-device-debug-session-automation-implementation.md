# 钉钉真机调试 Session 自动化实现计划

> **给执行型 agent：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行本计划。所有步骤使用 `- [ ]` 复选框语法跟踪。

**目标：** 构建一套分层、半自动的真机调试工作流，把每一次钉钉调试都标准化为可复现的 debug session，覆盖 gateway 重启、探针执行、日志采集、桌面操作交接、证据判定与归档。

**架构：** 不改动插件运行时行为，所有能力都作为仓库内开发者工具实现于 `scripts/` 下。orchestrator 负责 session 生命周期和 `.local/debug-sessions/` 下的产物，复用现有的连接检查与 stream monitor 脚本做探针，对外输出稳定的 manifest/observation 协议供外部桌面 agent 或人工执行，并在 session 结束后生成机器可读判定结果与人工可读摘要。

**技术栈：** Node.js `.mjs` 脚本、现有 Bash 诊断脚本复用、OpenClaw CLI、Vitest、Markdown 文档、JSON 产物、现有 DingTalk monitor 脚本。

---

### 任务 1：先用失败测试锁定 session 产物布局与 manifest 协议

**文件：**
- 新建：`scripts/real-device-debug/session-contract.mjs`
- 新建：`scripts/real-device-debug/session-fs.mjs`
- 新建：`tests/unit/real-device-debug/session-contract.test.ts`
- 阅读：`.gitignore`
- 阅读：`scripts/dingtalk-connection-check.sh`
- 阅读：`scripts/dingtalk-stream-monitor.mjs`

- [ ] **步骤 1：先写失败测试**

新增聚焦的单元测试，先定义本功能的核心数据模型：

```ts
import {
    buildSessionArtifacts,
    buildTraceToken,
    createInitialManifest,
} from "../../../scripts/real-device-debug/session-contract.mjs";

it("为 debug session 生成稳定的本地产物目录结构", () => {
    const manifest = createInitialManifest({
        now: new Date("2026-03-21T08:15:30.000Z"),
        scenario: "dm-text-reply",
        targetId: "cid-test",
    });

    expect(manifest.sessionId).toBe("dtdbg-20260321-081530-dm-text-reply");
    expect(manifest.traceToken).toMatch(/^DTDBG-20260321-081530-[A-Z0-9]{4}$/);
    expect(buildSessionArtifacts(manifest.sessionId)).toEqual({
        rootDir: ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply",
        logsDir: ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/logs",
        screenshotsDir: ".local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/screenshots",
    });
});

it("初始化 manifest 时写入状态位、探针状态与 operator 占位信息", () => {
    const manifest = createInitialManifest({
        now: new Date("2026-03-21T08:15:30.000Z"),
        scenario: "group-card",
        targetId: "cid-group",
    });

    expect(manifest.status).toBe("created");
    expect(manifest.timeline).toEqual([]);
    expect(manifest.operator).toMatchObject({
        mode: "external",
        observationStatus: "pending",
    });
    expect(manifest.probes).toEqual({
        connectionCheck: "pending",
        streamMonitor: "pending",
        gatewayRestart: "pending",
        openclawLogs: "pending",
    });
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-debug/session-contract.test.ts`

预期：FAIL，因为 session 协议相关 helper 还不存在。

- [ ] **步骤 3：补最小实现**

只实现以下最小能力：
- 生成 `sessionId`
- 生成短格式 `traceToken`
- 计算 `.local/debug-sessions/<date>/<sessionId>/...` 路径
- 生成带显式状态占位符的初始 manifest

- [ ] **步骤 4：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-debug/session-contract.test.ts`

预期：PASS。

### 任务 2：实现 session 启动 CLI 与产物初始化流程

**文件：**
- 新建：`scripts/real-device-debug/start-session.mjs`
- 新建：`scripts/real-device-debug/timeline.mjs`
- 新建：`scripts/dingtalk-debug-session.mjs`
- 新建：`tests/integration/real-device-debug/start-session-cli.test.ts`
- 按需修改：`package.json`

- [ ] **步骤 1：先写失败的 CLI 集成测试**

新增一个集成风格的 Vitest 测试，执行入口脚本并断言 session 初始化文件都被写出：

```ts
it("启动 debug session 时会写出 manifest、timeline 和 operator 步骤文档", async () => {
    const result = await execa("node", [
        "scripts/dingtalk-debug-session.mjs",
        "start",
        "--scenario",
        "dm-text-reply",
        "--target-id",
        "cid-test",
        "--target-label",
        "Debug Chat",
        "--operator-mode",
        "external",
        "--output-root",
        tempDir,
    ]);

    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(tempDir, "2026-03-21", expect.any(String), "manifest.json"))).toBe(true);
    expect(await pathExists(join(tempDir, "2026-03-21", expect.any(String), "timeline.json"))).toBe(true);
    expect(await pathExists(join(tempDir, "2026-03-21", expect.any(String), "operator-steps.md"))).toBe(true);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/integration/real-device-debug/start-session-cli.test.ts`

预期：FAIL，因为 session CLI 还不存在。

- [ ] **步骤 3：实现 `start` 子命令**

`start` 流程需要完成：
- 接收 `--scenario`、`--target-id`、`--target-label`、`--operator-mode`、可选 `--output-root`
- 创建产物目录
- 写出 `manifest.json`
- 写出 `timeline.json`
- 写出 `operator-steps.md`
- 在终端打印简洁摘要，至少包含 `sessionId`、`traceToken`、产物路径

交接给桌面 operator 的 markdown 必须包含：
- session 元信息
- 要发送的精确消息文本
- 超时时间窗
- 期望观察点
- 截图应复制到哪里

- [ ] **步骤 4：补一个最小 package script 别名**

增加一个简洁别名，例如：

```json
{
  "scripts": {
    "debug:session": "node scripts/dingtalk-debug-session.mjs"
  }
}
```

这一任务里不要一次性加太多脚本别名。

- [ ] **步骤 5：重新运行聚焦集成测试**

运行：`pnpm test tests/integration/real-device-debug/start-session-cli.test.ts`

预期：PASS。

### 任务 3：实现预检探针与受控运行态采集

**文件：**
- 新建：`scripts/real-device-debug/process-runner.mjs`
- 新建：`scripts/real-device-debug/runtime-probe.mjs`
- 新建：`tests/unit/real-device-debug/runtime-probe.test.ts`
- 阅读：`scripts/dingtalk-connection-check.sh`
- 阅读：`scripts/dingtalk-stream-monitor.mjs`

- [ ] **步骤 1：先写探针编排与状态流转的失败测试**

新增测试，锁定以下行为：
- 预检时先执行连接检查
- 短时 stream monitor 可选启用，也可以跳过
- `openclaw gateway restart` 会更新 `manifest.probes.gatewayRestart`
- `openclaw logs` 会被建模为长时间运行的采集进程，并有显式开始/停止状态

建议测试形态：

```ts
it("按预期顺序规划探针命令", async () => {
    const commands = [];
    const runner = createFakeRunner(commands);

    await runPreflightAndCapture({
        manifest,
        runner,
        enableStreamMonitor: true,
    });

    expect(commands).toEqual([
        expect.stringContaining("scripts/dingtalk-connection-check.sh"),
        expect.stringContaining("scripts/dingtalk-stream-monitor.mjs --duration 20"),
        "openclaw gateway restart",
        "openclaw logs",
    ]);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-debug/runtime-probe.test.ts`

预期：FAIL，因为运行器和探针编排层还不存在。

- [ ] **步骤 3：实现运行态探针层**

实现以下 helper：
- 运行连接检查，并把脱敏输出写入 `logs/connection-check.log`
- 可选运行短时 stream monitor，并把输出写入 `logs/stream-monitor.log`
- 执行 `openclaw gateway restart`
- 启动 `openclaw logs` 持续采集，并落到 `logs/openclaw.log`
- 为每次状态变更追加 timeline 事件
- 把 manifest 探针状态更新为 `pending | running | ok | failed | skipped`

进程管理要尽量保持通用，后续桌面工具可以复用同一套 session 状态。

- [ ] **步骤 4：把 `prepare` 子命令接到 CLI**

增加 `prepare` 子命令，或者增加 `start --with-preflight` 模式，让已创建的 session 推进到：
- `preflight_ok`
- `gateway_restarted`
- `probes_running`

该命令结束时必须打印下一步 operator 应做什么，而不是静默退出。

- [ ] **步骤 5：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-debug/runtime-probe.test.ts`

预期：PASS。

### 任务 4：定义 operator 交接协议与 observation 回填流程

**文件：**
- 新建：`scripts/real-device-debug/operator-contract.mjs`
- 新建：`scripts/real-device-debug/record-observation.mjs`
- 新建：`tests/unit/real-device-debug/operator-contract.test.ts`
- 修改：`scripts/dingtalk-debug-session.mjs`

- [ ] **步骤 1：先写 operator 请求与 observation 载荷的失败测试**

新增测试，确认以下行为：
- 生成的 operator 请求里包含一条带 `traceToken` 的探针消息
- 回填 observation 时不会覆盖 manifest 中无关字段
- 截图路径会保存为相对产物目录的路径，而不是机器专属绝对路径

示例断言：

```ts
expect(buildOperatorRequest(manifest)).toMatchObject({
    action: "send_probe_message",
    messageText: expect.stringContaining(manifest.traceToken),
    timeoutSec: 120,
    expectedChecks: [
        "message appears in DingTalk conversation",
        "bot reply becomes visible",
    ],
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-debug/operator-contract.test.ts`

预期：FAIL，因为 operator 协议相关 helper 还不存在。

- [ ] **步骤 3：实现 operator 协议 helper**

实现：
- `buildOperatorRequest(manifest)`
- `writeOperatorSteps(manifest, paths)`
- `appendOperatorObservation(sessionDir, observation)`

observation 载荷至少支持：
- `sentAt`
- `replyObservedAt`
- `sendStatus`
- `replyStatus`
- `notes`
- `screenshots`
- `replyPreview`

这一层不要尝试桌面自动化，它只定义 peekaboo 或人工需要遵守的协议。

- [ ] **步骤 4：增加 observation 记录 CLI**

增加类似下面的子命令：

```bash
pnpm debug:session observe --session-dir <path> --observation-file <file.json>
```

该命令需要：
- 把 observation 回填到 manifest
- 更新 timeline
- 打印当前 session 已推进到 `message_sent`、`reply_observed` 还是 `timeout`

- [ ] **步骤 5：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-debug/operator-contract.test.ts`

预期：PASS。

### 任务 5：实现证据判定器与机器可读 session 摘要

**文件：**
- 新建：`scripts/real-device-debug/judge-session.mjs`
- 新建：`tests/unit/real-device-debug/judge-session.test.ts`
- 修改：`scripts/dingtalk-debug-session.mjs`

- [ ] **步骤 1：先写分类判定的失败测试**

用表驱动测试覆盖以下核心结果：
- 完全没有 inbound 证据
- 只有 inbound
- inbound + outbound 但桌面端不可见
- 端到端成功
- 成功但延迟偏高

示例测试表：

```ts
[
    {
        name: "没有 inbound 证据时判为消息未进入插件",
        evidence: { inboundSeen: false, outboundSeen: false, replyObserved: false },
        expected: "no_inbound_evidence",
    },
    {
        name: "有 outbound 但客户端不可见时判为可见性问题",
        evidence: { inboundSeen: true, outboundSeen: true, replyObserved: false },
        expected: "outbound_not_visible_in_client",
    },
]
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-debug/judge-session.test.ts`

预期：FAIL，因为判定器还不存在。

- [ ] **步骤 3：实现 judge**

实现一个纯分类器，读取：
- `manifest.json` 里的探针结果
- 过滤后的日志文本里的提示信息
- operator observation 状态

输出：
- `judgment.json`
- `summary.md`

`summary.md` 至少包含：
- session 元信息
- timeline
- 探针结果
- operator observation
- 最终判定
- 下一步建议动作

- [ ] **步骤 4：增加 `judge` 子命令**

支持：

```bash
pnpm debug:session judge --session-dir <path>
```

这个命令必须可以重复执行，方便在后续补充截图或 observation 后重新判定。

- [ ] **步骤 5：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-debug/judge-session.test.ts`

预期：PASS。

### 任务 6：增加日志过滤器与一键式 happy-path orchestrator

**文件：**
- 新建：`scripts/real-device-debug/log-filter.mjs`
- 新建：`tests/unit/real-device-debug/log-filter.test.ts`
- 修改：`scripts/dingtalk-debug-session.mjs`

- [ ] **步骤 1：先写 trace token 日志切片的失败测试**

新增测试，确认以下行为：
- 包含 `traceToken` 的日志行会被保留
- trace token 附近的 DingTalk 生命周期日志也可以保留
- 捕获窗口外的无关日志会被剔除

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm test tests/unit/real-device-debug/log-filter.test.ts`

预期：FAIL，因为日志过滤 helper 还不存在。

- [ ] **步骤 3：实现日志过滤器**

实现 helper，根据以下信息从 `logs/openclaw.log` 生成 `logs/filtered.log`：
- 当前 session 的 `traceToken`
- DingTalk 相关关键词
- 少量前后文窗口

第一版不要过度依赖某一个固定日志格式，优先使用保守的字符串匹配与上下文截取。

- [ ] **步骤 4：增加一个 `run` 便捷命令**

实现 `run` 子命令，串起：
- `start`
- `prepare`
- 暂停等待外部 operator 执行动作
- 可选 `judge`

它必须明确停在“等待桌面操作”这个边界上，不能假装仓库代码已经能控制钉钉 UI。暂停时应打印或写出下一步明确动作，随后等待后续的 `observe` / `judge`。

- [ ] **步骤 5：重新运行聚焦测试**

运行：`pnpm test tests/unit/real-device-debug/log-filter.test.ts`

预期：PASS。

### 任务 7：补齐工作流文档与集成边界说明

**文件：**
- 新建：`docs/real-device-debugging.md`
- 修改：`README.md`

- [ ] **步骤 1：写新的工作流手册**

文档需要说明：
- 什么情况下应使用 debug session，而不是临时看日志
- session 状态机
- `.local/debug-sessions/` 下的产物目录结构
- `start`、`prepare`、`observe`、`judge`、`run` 的使用方式
- 外部桌面 agent 需要读取什么、写回什么
- 为什么当前仓库刻意不直接接管钉钉 UI 自动化

- [ ] **步骤 2：增加未来桌面 agent adapter 的边界说明**

明确一个稳定的 adapter 边界：
- 输入：`manifest.json` + `operator-steps.md`
- 输出：observation JSON + 拷贝到 session 目录内的截图

文档里给出三种接入示例：
- 人工 operator
- peekaboo 类桌面 agent
- 未来可能的 DingTalk CLI

- [ ] **步骤 3：更新 README 开发流程**

新增一个简短的“真机调试”章节，链接到 `docs/real-device-debugging.md`，并给出最短可用命令序列：

```bash
pnpm debug:session start --scenario dm-text-reply --target-id <conversationId> --target-label "Debug Chat"
pnpm debug:session prepare --session-dir <path>
pnpm debug:session judge --session-dir <path>
```

- [ ] **步骤 4：逐条校对路径与命令**

确认文档中所有路径、脚本名、CLI 子命令都与最终实现完全一致。

### 任务 8：最终验证与非目标检查

**文件：**
- 验证任务 1 到任务 7 涉及的全部文件

- [ ] **步骤 1：运行聚焦自动化测试**

运行：
- `pnpm test tests/unit/real-device-debug/session-contract.test.ts`
- `pnpm test tests/unit/real-device-debug/runtime-probe.test.ts`
- `pnpm test tests/unit/real-device-debug/operator-contract.test.ts`
- `pnpm test tests/unit/real-device-debug/judge-session.test.ts`
- `pnpm test tests/unit/real-device-debug/log-filter.test.ts`
- `pnpm test tests/integration/real-device-debug/start-session-cli.test.ts`

预期：全部通过。

- [ ] **步骤 2：运行仓库级检查**

运行：
- `pnpm test`
- `npm run type-check`
- `npm run lint`

预期：全部通过。

- [ ] **步骤 3：执行一次真实本地 smoke session**

选择一个安全测试会话，执行一轮真实 smoke：
- 启动一个 session
- 执行 prepare，完成预检与 gateway 重启
- 在钉钉里手动发送一条带 trace token 的探针消息
- 回填一份 observation
- 执行 judge

预期产物：
- `manifest.json`
- `timeline.json`
- `logs/openclaw.log`
- `logs/filtered.log`
- `summary.md`
- 可选截图证据

- [ ] **步骤 4：合并前确认显式非目标**

在宣布功能完成前，明确确认第一版 **不做**：
- 不在仓库代码里直接驱动钉钉桌面 UI
- 不要求 OCR 成为核心测试通过条件
- 不改动运行时消息收发逻辑
- 不假定未来的 DingTalk CLI 已经存在

如果实现过程开始漂向这些方向，立即停止并拆成后续计划。
