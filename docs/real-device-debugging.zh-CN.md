# 真机调试工作流

English version: [`real-device-debugging.md`](real-device-debugging.md)

本文档说明仓库内用于 DingTalk Channel 插件的半自动真机调试流程。

适用场景：

- 需要同时结合 `openclaw gateway restart`、`openclaw logs` 和钉钉客户端可见结果
- 需要把一次真机联调沉淀为可复盘、可归档、可附在 PR / issue 上的证据包
- 需要给人工操作员、Peekaboo 类桌面 agent，或未来可能出现的钉钉 CLI 提供一个稳定接入边界

这套流程刻意停在“仓库自动化”和“钉钉客户端自动化”的边界上：

- 仓库负责 session 生命周期、日志采集、产物归档和判定
- 人工或外部桌面 agent 负责在钉钉客户端里执行动作、观察可见结果、回填 observation

## 为什么要用 Debug Session

在以下情况中，优先使用 debug session，而不是临时盯 `openclaw logs`：

- 插件是否成功的最终可见性发生在钉钉客户端里
- 你需要区分“消息有没有进入插件”和“回复有没有在客户端里真正显示出来”
- 你需要把一次测试沉淀为结构化证据，而不是零散命令输出

## 当前能力边界

仓库当前已经实现：

- 创建标准化 session 目录与 `manifest.json`
- `prepare` 阶段的连接检查、可选 stream monitor、`openclaw gateway restart` 和 `openclaw logs`
- `observe` 阶段的 operator observation 回填
- `judge` 阶段的机器可读结论与人工可读摘要
- `run` 阶段的 `start + prepare` 一键组合

仓库当前明确 **不做**：

- 不直接驱动钉钉桌面端 UI
- 不要求 OCR 成为调试成功的前置条件
- 不改运行时消息收发逻辑
- 不假定钉钉已经提供 CLI

## Session 状态模型

概念上，一次完整真机调试的状态机会经历：

```text
created
  -> preflight_ok
  -> gateway_restarted
  -> probes_running
  -> message_sent
  -> reply_observed | timeout
  -> judged
  -> archived
```

当前实现写入 `manifest.json` 的简化状态包括：

- `created`
- `probes_running`
- `message_sent`
- `reply_observed`
- `timeout`

也就是说，当前 `prepare` 会在内部完成预检、gateway 重启和日志采集启动，然后把 session 推进到 `probes_running`。

## 产物目录结构

默认目录：

```text
.local/debug-sessions/<YYYY-MM-DD>/<sessionId>/
```

例如：

```text
.local/debug-sessions/2026-03-21/dtdbg-20260321-081530-dm-text-reply/
```

常见产物：

- `manifest.json`：session 元数据、状态、探针状态、observation
- `timeline.json`：按时间顺序记录 session 事件
- `operator-steps.md`：钉钉客户端侧的操作步骤
- `logs/connection-check.log`：连接检查脚本输出
- `logs/stream-monitor.log`：短时 stream monitor 输出
- `logs/gateway-restart.log`：`openclaw gateway restart` 输出
- `logs/openclaw.log`：`openclaw logs` 采集结果
- `logs/filtered.log`：用于判定的过滤日志片段
- `screenshots/`：人工或桌面 agent 回填的截图
- `judgment.json`：机器可读判定
- `summary.md`：人工可读摘要

## 命令入口

先安装依赖：

```bash
pnpm install
```

统一入口：

```bash
pnpm debug:session
```

### 1. 创建 Session

仅创建 session 与交接文档：

```bash
pnpm debug:session start \
  --scenario dm-text-reply \
  --target-id <conversationId> \
  --target-label "Debug Chat"
```

该命令会创建：

- `manifest.json`
- `timeline.json`
- `operator-steps.md`

### 2. 启动预检与运行态采集

```bash
pnpm debug:session prepare --session-dir <sessionDir>
```

如果希望更快地进入 handoff，可跳过短时 stream monitor：

```bash
pnpm debug:session prepare --session-dir <sessionDir> --no-stream-monitor
```

当前 `prepare` 会执行：

- `bash scripts/dingtalk-connection-check.sh`
- 可选 `node scripts/dingtalk-stream-monitor.mjs --duration 20`
- `openclaw gateway restart`
- `openclaw logs`

### 3. 回填客户端观察结果

先准备一份 observation JSON，例如：

```json
{
  "sentAt": "2026-03-21T08:16:00.000Z",
  "replyObservedAt": "2026-03-21T08:16:18.000Z",
  "sendStatus": "sent",
  "replyStatus": "visible",
  "replyPreview": "ok",
  "notes": "桌面端已看到回复",
  "screenshots": [
    "/absolute/path/to/<sessionDir>/screenshots/reply-visible.png"
  ]
}
```

然后执行：

```bash
pnpm debug:session observe \
  --session-dir <sessionDir> \
  --observation-file /path/to/observation.json
```

`observe` 会把截图路径归一化成相对 session 目录的路径后写回 `manifest.json`。

### 4. 判定 Session

```bash
pnpm debug:session judge --session-dir <sessionDir>
```

该命令会写出：

- `judgment.json`
- `summary.md`

当前可能的结论包括：

- `no_inbound_evidence`
- `inbound_without_outbound`
- `outbound_not_visible_in_client`
- `end_to_end_success`
- `success_high_latency`

如果 `logs/filtered.log` 不存在，但 `logs/openclaw.log` 存在，`judge` 会先自动生成过滤日志。

### 5. 一键启动到 Handoff

如果你想一次完成 `start + prepare`：

```bash
pnpm debug:session run \
  --scenario dm-text-reply \
  --target-id <conversationId> \
  --target-label "Debug Chat" \
  --no-stream-monitor
```

`run` 目前会停在“等待 operator/桌面 agent 接手”的边界上，只打印下一步动作，不会伪装成已经自动操作了钉钉客户端。

## 推荐的人类操作流程

1. 运行 `pnpm debug:session run ...`，或手动执行 `start` 再 `prepare`
2. 打开 `operator-steps.md`
3. 在钉钉里发送包含 trace token 的精确探针消息
4. 等待回复可见或超时
5. 把截图拷贝到当前 session 的 `screenshots/` 目录
6. 写一份 observation JSON 并执行 `observe`
7. 执行 `judge`
8. 把 `summary.md`、`judgment.json` 和关键截图附到 PR 或 issue

## 外部桌面 Agent 的接入边界

为了让桌面侧能力可以独立演进，仓库定义了稳定的 adapter 边界。

输入：

- `manifest.json`
- `operator-steps.md`

输出：

- 可被 `observe` 消费的 observation JSON
- 拷贝到 session 目录内的截图

这意味着当前工作流同时兼容：

- 人工 operator
- Peekaboo 类桌面 agent
- 未来可能出现的钉钉 CLI

## PR 中建议附上的证据

如果你的改动影响运行时行为，建议附上：

- `sessionId`
- 测试场景
- 最终 `outcome`
- 回复是否在钉钉客户端中真正可见
- `summary.md` 或其中的关键摘录
- 如果争议点在“客户端是否可见”，附关键截图

## 相关文件

- `scripts/dingtalk-debug-session.mjs`
- `scripts/real-device-debug/`
- `scripts/dingtalk-connection-check.sh`
- `scripts/dingtalk-stream-monitor.mjs`
- `docs/connection-troubleshooting.md`
