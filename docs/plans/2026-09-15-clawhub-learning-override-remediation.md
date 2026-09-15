# ClawHub 审计剩余项修复方案：学习回路的持久化覆盖

**状态**：P0 已在 PR #617 内实现（`learningEnabled` kill switch + 文档措辞）；P1 / P2 待评审
**关联**：[PR #617](https://github.com/soimy/openclaw-channel-dingtalk/pull/617)、[Issue #616](https://github.com/soimy/openclaw-channel-dingtalk/issues/616)
**日期**：2026-09-15

## 1. 五轮审计结果汇总

| 轮次 | commit | 本轮改动 | scanStatus | ClawScan 关注点 |
| --- | --- | --- | --- | --- |
| R1 | `e97266a` | 改前基线 | `suspicious`（high） | messaging / document / persistent learning controls |
| R2 | `91bee7b` | 方案 A：补默认值 + 披露 | `suspicious`（high） | broad business messaging/document actions + persistent learning rules |
| R3 | `af32560` | 方案 B1：Gateway RPC 默认关闭 | **`clean`**（benign，high，5 维度） | mostly matches its stated purpose |
| R4 | `98cb40e` | 仅注释 / CI 改动 | `suspicious`（medium） | owner-entered rules + exact forced replies 披露不足 |
| R5 | `0f961b3` | 补 learning 精确回复披露 | `suspicious`（high） | learning controls 可持久地静默改写或覆盖回复 |

静态分析 `v2.4.26`（findings 0）、SkillSpector、VirusTotal 在可获取报告的轮次中全部 `clean`。

三条可复现结论：

1. **B1 消除了 Gateway 能力面这条驱动**：R4、R5 的 ClawScan 结论已完全不提 messaging / document RPC，而那是 R1、R2 的核心指控。
2. **单次 `clean` 不可依赖**：R3 与 R4 之间发布产物**只差注释**（`git diff af32560 98cb40e -- src/` 无任何非注释代码行，workflow/tests 又不在 `files` 白名单内），却分别得到 `clean` 与 `suspicious`。判定是概率性的，门禁应作为 tripwire 而非证书。
3. **剩余驱动是学习回路**，且 R4 → R5 的措辞变化（"under-disclosed" → "can persistently and quietly steer or override bot replies"）说明补齐披露后，矛头指向的是能力语义本身。

## 2. 根因：`learningEnabled` 不是学习回路的总开关

ClawScan 说"advertised disabled learning setting"与实现不符。核对代码后确认这是**声明与实现漂移**，不是模型臆测：

| 行为 | 是否受 `learningEnabled` 约束 | 证据 |
| --- | --- | --- |
| 笔记 / 规则注入后续 prompt | ✅ 是 | `src/gateway/inbound-handler.ts:1791` → `buildLearningContextBlock({ enabled })` |
| `/learn` 命令面（创建 / 列出 / 禁用 / 删除规则） | ❌ 否 | `src/command/inbound-command-dispatch-service.ts` **完全没有引用** `learningEnabled` |
| 精确回复命中（绕过模型直接返回固定文本） | ❌ 否 | 同文件 `resolveManualForcedReply(...)` → `sendReply(...)` → `return true` |

而 manifest 对该字段的描述是：

> Enable the local feedback-learning loop for notes, reflections, and **command-assisted learning**. Disabled by default; learned notes and rules persist ... **while enabled**.

即"命令面属于学习回路、关闭即不生效"是**已声明的语义**，但实现只在 prompt 注入这一条路径上遵守。测试固化了当前行为：`tests/unit/inbound-handler-commands.test.ts` 在 `dingtalkConfig` 未设置 `learningEnabled`（默认 `false`）的情况下，断言 `/learn global ...` 能够成功创建规则。

**风险模型（用于定级）**

- 创建规则需要 `commands.ownerAllowFrom` 命中，未配置该列表时 `isSenderOwner` 恒为 `false`，任何人都无法创建规则 —— 权限面是受控的；
- 但一旦规则存在，它：**绕过模型**、**跨会话持久**（无 TTL）、**可 account 级全局生效**、且**在 `learningEnabled=false` 时依然命中**；
- 命中过程当前没有结构化日志，因此"覆盖"对运维是不可见的。

## 3. 修复方案

### P0 — 让 `learningEnabled` 成为真正的总开关（✅ 已在 PR #617 实现）

- **执行面**：在 `resolveManualForcedReply` 的调用点（`inbound-command-dispatch-service.ts` 调度函数内）加 `isLearningEnabled(dingtalkConfig)` 门槛；关闭时直接不命中，回落到正常 agent 流程。
- **命令面**：对写入/修改类学习命令（`/learn global`、`session`、`here`、`target`、`targets`、`target-set-create`、`target-set-apply`）加同一门槛，关闭时回复明确指引（提示设置 `channels.dingtalk.learningEnabled = true`）。只读诊断（`whoami` / `whereami` / `help` / `owner-status` / `list`）与**清理类**命令（`disable` / `delete`）保持可用：清理只减少状态，若一并禁止，运维在开关关闭时反而无法移除历史规则。
- **影响**：关闭状态下已存规则不再生效。这是**行为变更**，但与该字段已声明的语义一致，按 bug fix 处理；需要在 release notes 明确写出，并说明"此前关闭开关并不能阻止规则命中"。
- **测试**：
  - 新增：`learningEnabled=false` 时 `/learn` 写命令被拒、已存规则不命中（防回归到当前行为）；
  - 更新：`tests/unit/inbound-handler-commands.test.ts` 中依赖"默认关闭仍可创建规则"的用例改为显式开启。
- **非目标**：不移除 `forcedReply` 能力本身。owner 定义固定回复是合法能力，且权限已受 `commands.ownerAllowFrom` 约束。

### P1 — 让覆盖不再"安静"（待实现，可观测性）

- 命中强制回复时输出结构化日志：`[DingTalk][Learning][ForcedReply] ruleId=<id> scope=<global|target> target=<id>`，不包含回复正文。
- 可选（默认关闭）：在卡片或回复尾部追加可配置标记（如 `learningForcedReplyMarker`），让终端用户也能看出这条回复来自规则。
- 对应 ClawScan 的 "quietly" 一词；不改变行为，风险最低。

### P2 — 收敛持久化与作用域（待决策）

- **规则 TTL**：新增 `learningRuleTtlMs`（默认建议 30 天），到期规则不再命中，需要 owner 重新确认；把 "persistently" 从无限期变为有界。
- **全局规则需二次显式开关**：新增 `learningAllowManualGlobalRules`（默认 `false`）。没有该开关时，owner 写入的 account 级规则既不会被注入 prompt，也不能强制精确回复，只允许会话级；避免单条规则静默影响所有会话。自动学习产生的 account 级规则不受该开关约束，由 `learningAutoApply` 控制。
- 这两项都是行为变更 + 新配置项，建议在 P0 落地并观察一轮审计结果后再评估。

## 4. 明确不做的事

- **不追求"跑出一次 `clean` 就收工"**：R3/R4 的对照已证明判定是概率性的；验收标准改为"连续 3 次审计的分布"，而不是单次结果。
- **不删除学习回路**：它是已发布功能，owner 权限面受控；本方案只收敛开关语义与可观测性。
- **不在 PR #617 内实现**：PR #617 已消除 Gateway 能力面驱动，本方案是独立的后续 PR，便于分别评审与回滚。

## 5. 验证方案

1. 单测：P0/P1 新增用例 + `pnpm test` 全量回归 + `type-check` / `lint` / `format:check`。
2. 手工验证（真机或单测模拟）：
   - `learningEnabled=false`：`/learn global ...` 被拒；已存规则的消息命中后走正常 agent 流程；
   - `learningEnabled=true`：规则可创建、命中后返回固定文本、日志出现 `[DingTalk][Learning][ForcedReply]`。
3. 审计：改完后**连续跑 3 次** `node scripts/clawhub-audit-local.mjs`，记录 `scanStatus` 分布与 ClawScan 措辞；三次中若仍出现指向学习回路的 `suspicious`，再评估 P2。
4. 门禁：维持 tripwire 语义，`suspicious` 时用 `workflow_dispatch` + `allow_suspicious=true` 显式放行并记录理由。

## 6. 实施顺序

1. ✅ P0 已随 PR #617 落地：`/learn` 写命令在关闭时被拒、`resolveManualForcedReply` 在关闭时跳过、单测覆盖三种状态、文档与 manifest 描述同步。
2. ⏳ P1（命中时的结构化日志 + 可选可见标记）待实现，需要把 logger 传进命令调度层。
3. ⏳ 按 §5.3 连跑 3 次审计，根据 `scanStatus` 分布决定是否启动 P2（规则 TTL、全局覆盖二次开关）。
