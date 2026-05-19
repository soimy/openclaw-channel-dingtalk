# Gap #01 · DingTalk Native Approval Implementation Plan

> **For implementers:** 本文保留原 task-by-task 执行结构；实施前仍以当前源码和上游 OpenClaw 真实签名为准，不要只照伪代码搬运。

**Goal:** 为 `openclaw-channel-dingtalk` 接入 OpenClaw 原生审批能力（exec + plugin approval），交付 `/approve` 命令路径 + AI Card 按钮路径双轨 UX。

**Architecture:**
- v1 仅 origin-only 投递（D4），不投 approver DM、不引入本地 approval store（D18）、不做 finalize-on-stop（D13）。
- AI Card 路径在原 agent reply card 上 PUT cardParamMap 三变量（`show_approve_btns` / `approveId` / `hasAction`，参 spec §1.X 单一事实表），按钮组定义在 v3 模板内置；markdown 路径发独立消息含 `/approve <id> <decision>` 模板。
- 按钮回调 + `/approve` 命令两条入口都收敛到 `approval-resolver.ts` 单点，再调上游 SDK 公开 API `resolveApprovalOverGateway`。
- 原设计按 3 个 PR 顺序交付：PR-1 接口骨架 + 命令通道；PR-2 完整 native runtime + 模板替换 + 真机回归；PR-3 文档。当前功能分支已把这些改动收敛到同一分支，文中的 PR 标签仅作为历史边界和 review 分区。

**Tech Stack:** TypeScript（strict, ES2023）· Vitest（V8 coverage）· oxlint + oxfmt · pnpm · OpenClaw `>=2026.4.7` peer SDK · DingTalk Stream SDK + Open API。

**Source spec:** `docs/features/2026-05-18-gap-01-approval-native-design.html` (v3.12, 2329 行)。所有 §X.Y 引用均指向该 spec。

---

## 文件结构

### 新增（src/approval/ 目录，~900 行业务 + ~2000 行测试）

| 文件 | 单一职责 | PR |
|---|---|---|
| `src/approval/approval-config.ts` | 读 `execApprovals` schema helper（list/isAuth/resolveMode） | PR-1 |
| `src/approval/approval-command-parser.ts` | 纯解析 `/approve` 文本（20 合法形式） | PR-1 |
| `src/approval/approval-target-resolver.ts` | v1 仅 `resolveOriginTarget` | PR-1 |
| `src/approval/approval-resolver.ts` | D20 单点：kind 推导 + 授权 + gateway 调用 + 5 类错误分类 | PR-1 |
| `src/approval/approval-card-locator.ts` | 按 sessionKey 查 card-run-registry，D22 路由决策 | PR-1 |
| `src/approval/approval-command-intercept.ts` | `/approve` early intercept 入口 | PR-1 |
| `src/approval/approval-capability.ts` | SDK 工厂装配 `ChannelApprovalCapability` | PR-1（不含 nativeRuntime）+ PR-2（接上） |
| `src/approval/approval-card-patcher.ts` | 三 patcher：pending/resolved/expired | PR-2 |
| `src/approval/approval-markdown-render.ts` | buildExec/PluginApprovalMarkdown | PR-2 |
| `src/approval/approval-callback-handler.ts` | TOPIC_CARD 入口 → resolver → patcher | PR-2 |
| `src/approval/approval-native-runtime.ts` | 4 子 adapter（availability/presentation/transport/observe） | PR-2 |

### 修改（向后兼容）

| 文件 | 改动要点 | PR |
|---|---|---|
| `package.json` | `peerDependencies.openclaw` bump `2026.3.28` → `>=2026.4.7` | PR-1（前置） |
| `pnpm-lock.yaml` | 同步 lockfile，确认 `node_modules/openclaw` 版本 | PR-1（前置） |
| `src/types.ts` | 加 `ExecApprovalsConfig` + `ApprovalDecision` + `ApprovalPhase`；`DingTalkConfig` 加 `execApprovals?` 字段 | PR-1 |
| `src/config-schema.ts` | 加 `execApprovalsSchema`；挂到 `DingTalkConfigSchema` + account schema | PR-1 |
| `src/config.ts:279-310` | `resolveDingTalkAccount` default-account 路径 rawConfig 加 `execApprovals: dingtalk?.execApprovals,` | PR-1 |
| `src/channel.ts:22-127` | plugin 对象加 `approvalCapability` 字段 | PR-1 |
| `src/inbound-handler.ts:~770` | 早期 intercept `/approve`（早于 L817/L874/L2053） | PR-1 |
| `src/card/card-template.ts:6` | `BUILTIN_DINGTALK_CARD_TEMPLATE_ID` v2 → v3：`58f73932-fc3b-46ae-8e90-93313e405061.schema` | PR-2 |
| `src/card-callback-service.ts` | `CardCallbackAnalysis` 加 `cardPrivateData?` 字段（~5 行） | PR-2 |
| `src/card-service.ts:~802` | createAICard/finalize 路径 cardParamMap 显式补 `show_approve_btns:"false"` + `approveId:""` | PR-2 |
| `src/card/card-run-registry.ts` | 加 `resolveActiveCardRunBySession` / `isActiveCardRun` / `pendingApprovalId` 字段 / mark/clear API | PR-1（locator 需要的部分）+ PR-2（pendingApprovalId） |
| `src/gateway/channel-gateway.ts:~383` | TOPIC_CARD listener 在 `handleCardAction` 之前插 `tryHandleApprovalCallback` 分支 | PR-2 |

### 资产

- `docs/assets/card-template-v3.json`（268KB，已 commit） — v3 模板低代码 schema，含 `approve_btns` + `show_approve_btns` + `approveId`。

### 测试（tests/unit/ + tests/integration/）

| 测试文件 | PR | ~case 数 |
|---|---|---|
| `tests/unit/approval-config.test.ts` | PR-1 | 12 |
| `tests/unit/approval-command-parser.test.ts` | PR-1 | 26 |
| `tests/unit/approval-target-resolver.test.ts` | PR-1 | 10 |
| `tests/unit/approval-resolver.test.ts` | PR-1 | 22 |
| `tests/unit/approval-card-locator.test.ts` | PR-1 | 8 |
| `tests/unit/approval-command-intercept.test.ts` | PR-1 | 12 |
| `tests/unit/approval-capability.test.ts` | PR-1 + PR-2 增量 | 6 |
| `tests/unit/inbound-handler-approve-intercept.test.ts` | PR-1 | 8 |
| `tests/unit/config.test.ts`（扩） | PR-1 | +4 |
| `tests/unit/approval-card-patcher.test.ts` | PR-2 | 14 |
| `tests/unit/approval-markdown-render.test.ts` | PR-2 | 8 |
| `tests/unit/approval-callback-handler.test.ts` | PR-2 | 18 |
| `tests/unit/approval-native-runtime.test.ts` | PR-2 | 14 |
| `tests/unit/card-callback-service.test.ts`（扩） | PR-2 | +6 |
| `tests/integration/approval-end-to-end.test.ts` | PR-2 | 12（DEFERRED：当前分支尚未落地，见 Task 21） |

---

## 通用约定

- TDD 严格遵循：每个 task 都是「写失败测试 → 跑确认 fail → 实现 → 跑确认 pass → commit」。
- 测试 mock 网络：`vi.mock("../../src/http-client")` + `vi.mock("../../src/auth")`；上游 SDK **必须按 impl 真实 import subpath mock**（参 Stage 0.A 导入子路径表），如 `vi.mock("openclaw/plugin-sdk/approval-gateway-runtime")` —— 不要 mock 根 entry `"openclaw/plugin-sdk"`，因为 impl 从 subpath import 时根 mock **不会拦截**；`vi.mock("../../src/card-callback-service", ...)` 视模块需要。`clearMocks/restoreMocks/mockReset` 已在 vitest 全局开启。
- 日志统一前缀 `[DingTalk][Approval]`（参 CLAUDE.md 约定 + 现有 `[DingTalk][AICard]` 模式）。
- 所有 `sendProactiveTextOrMarkdown` 调用 **必须** 传 `forceMarkdown: true`（messageType=card 配置下否则会回退发卡片，参 `src/send-service.ts:371-393`）。
- 不引入 `@ts-ignore`；oxlint 必须通过；commit 前跑 `pnpm run type-check && pnpm run lint && pnpm test`。
- Commit 信息使用约定：`feat(approval): ...` / `test(approval): ...` / `chore(approval): ...` / `docs(approval): ...`；BREAKING 在 footer 注明。
- **署名按需添加**：commit 模板里不预填 `Co-Authored-By:`。如果执行者是 AI agent，按各自约定追加（如 Claude Code 按 `.claude/settings.json` 行为；其他 agent 按其规则；人工执行可省）。
- 每完成一个 Task 立即 commit；PR 边界处提示用户开 PR review。

---

# PR-1 · 接口骨架 + 统一 resolver + `/approve` 命令链路

**交付目标:** DingTalk 端具备 `/approve` 命令的 resolve 通道（权限校验 + 早期 intercept 绕过 session lock + resolver 单点收敛）；按钮 UX 留待 PR-2。
**授权边界:** `/approve` 是消息路径能力，当前实现位置在 DM/group access control 之后、session lock/routing 之前；因此它同时受 channel 普通访问策略和 `execApprovals.approvers` 约束。卡片按钮回调不是普通消息路径，只受 approver 名单约束。若后续产品要求“approver 可在被普通 allowlist 拦截的会话中仍通过 `/approve`”，需要把 intercept 前移并补对应访问控制测试。

**PR-1 任务清单:** Stage 0 + Task 1 ~ Task 11。

---

## Stage 0 · 源码签名核对表 + SDK 基线四件套（D17，PR-1 前置 BLOCKER）

### Stage 0.A · 源码签名核对表（实施前用 Read 核对，不要相信 spec / plan 内的伪代码签名）

| 名称 | 真实签名 / 字段 | 路径 |
|---|---|---|
| `ExecApprovalRequest` | `{ id, request: ExecApprovalRequestPayload, createdAtMs, expiresAtMs }`<br/>**`turnSourceChannel` / `turnSourceTo` / `turnSourceAccountId` / `turnSourceThreadId` / `sessionKey` / `allowedDecisions` / `agentId` / `command` / `cwd` 全部在 `request.request.*`**（嵌套 payload，不是顶层！） | `openclaw/src/infra/exec-approvals.ts:117-140` |
| `PluginApprovalRequest` | 同形：`{ id, request: PluginApprovalRequestPayload, createdAtMs, expiresAtMs }`，payload 含 `pluginId / title / description / severity / toolName / toolCallId / allowedDecisions / agentId / sessionKey / turnSourceChannel / turnSourceTo / turnSourceAccountId / turnSourceThreadId` | `openclaw/src/infra/plugin-approvals.ts:3-30` |
| `ChannelApprovalNativeRuntimeAdapter` | 3 必需 + 2 可选：`availability / presentation / transport` + `interactions? / observe?` | `openclaw/src/infra/approval-handler-runtime-types.ts:216-235` |
| `createLazyChannelApprovalNativeRuntimeAdapter` | **不是简单的字面量打包**——只接受 `{ load: () => Promise<adapter>, isConfigured, shouldHandle, eventKinds?, resolveApprovalKind? }`，把 availability/presentation/transport/observe 都塞同一对象会 type-check fail。<br/>**v1 不用此 lazy 包装**——直接 `return { eventKinds, availability, presentation, transport, observe }`。 | `openclaw/src/infra/approval-handler-adapter-runtime.ts:10-...` |
| `createApproverRestrictedNativeApprovalCapability` | SDK 工厂（16 参数） | `openclaw/src/plugin-sdk/approval-delivery-helpers.ts:30-261` |
| **`createChannelNativeOriginTargetResolver`** | **target-resolver 上游 helper**：channel + shouldHandleRequest + resolveTurnSourceTarget(request) + resolveSessionTarget(sessionTarget, request) + normalizeTarget?(target, request)；接受 `ApprovalResolverParams { cfg, accountId, request }`，**input.request 是 ApprovalRequest 整体；helper 内部访问 input.request.request.\* payload** | `openclaw/src/plugin-sdk/approval-native-helpers.ts:137-153` |
| `createChannelApproverDmTargetResolver` | DM 目标 helper（v1 不用，v2 future） | `openclaw/src/plugin-sdk/approval-native-helpers.ts:155-182` |
| `resolveApprovalOverGateway` | SDK 公开 API（v2026.4.7+） | `openclaw/src/plugin-sdk/approval-gateway-runtime.ts:1`（re-export 也在 `approval-handler-runtime.ts:31`） |
| `resolveDingTalkAccount(cfg, accountId)` | 返回 **`ResolvedDingTalkAccount extends DingTalkConfig`**——**配置字段直接挂顶层**（如 `account.execApprovals`），<strong>不是</strong> `account.config.execApprovals`；额外字段 `{ accountId, configured }` | `src/config.ts:263-272` |
| `registerCardRun(outTrackId, params)` | **签名是 `(outTrackId: string, params: { accountId, sessionKey, agentId, ownerUserId?, card?, registeredAt? })`**；**字段名是 `registeredAt`**（不是 `createdAt`） | `src/card/card-run-registry.ts:13-25`（record）+ `:56`（fn 签名） |
| `CardRunRecord` | `{ outTrackId, accountId, sessionKey, agentId, ownerUserId?, card?, controller?, stopRequestedAt?, registeredAt }`，无 `createdAt` 字段 | `src/card/card-run-registry.ts:13` |
| `CardCallbackAnalysis` | 当前接口字段（PR-2 之前）—— 实施前 Read 核对扩展点 | `src/card-callback-service.ts:1-30` |
| **`updateCardVariables(outTrackId, params, token, config?)`** | **返回 `Promise<number>` HTTP status code**；失败靠 axios throw（**不是** `{ ok, error }`）；第 4 个可选 `config` 仅取 `bypassProxyForSend`。patcher / runtime 调用必须传 `config` 否则会绕过 proxy 配置 | `src/card-callback-service.ts:175-201` |
| **`getAccessToken(config, log?)`** | **签名是 `(config: DingTalkConfig, log?: Logger)`**——传入**已解析的 DingTalkConfig**（用 `getConfig(cfg, accountId)` 先解析），<strong>不是</strong> `(cfg, accountId)` | `src/auth.ts:18` |
| `sendProactiveTextOrMarkdown(config, target, text, opts)` | `opts` 含 `forceMarkdown?: boolean`；`messageType=card` 时不传 forceMarkdown 会被发成卡片 | `src/send-service.ts:352-482`（判断在 :371-393） |
| `getLogger(accountId?)` | 项目约定的 logger 入口；**不要用 `console.*`**——`src/` 全部用 `getLogger()?.info/warn/error` | `src/logger-context.ts:25` |
| `Logger` 类型 | 本仓库别名 `ChannelLogSink`；从 `../types` 导入，**不是** SDK 根 | `src/types.ts:583` |

> **使用规则：**
> 1. 写代码 / 测试前 `Read` 上面任何一个文件，**以源文件为准**，本 plan 内 / spec 内的伪代码签名都是辅助说明。
> 2. 任何 task 实施时如果发现 plan 内的伪代码与真实签名冲突，**fix plan 而非编造类型**——把 Drift 记在 commit message。

### Stage 0.A · 导入子路径权威表（openclaw/plugin-sdk 根入口很瘦；不要从根 import 这些符号）

| 符号 | 子路径 | peer 引用样本 |
|---|---|---|
| `OpenClawConfig` | `openclaw/plugin-sdk/core` | `src/channel.ts:1` / `src/types.ts:17`（本仓库现有用法） |
| `Logger` 类型 | 本仓库 `../types`（再导出 `ChannelLogSink`） | `src/types.ts:583` |
| `getLogger` | 本仓库 `../logger-context` | `src/logger-context.ts:25` |
| `ChannelApprovalCapability` | `openclaw/plugin-sdk/channel-contract` | `openclaw/extensions/telegram/src/approval-native.ts:15` |
| `createApproverRestrictedNativeApprovalCapability`<br/>`splitChannelApprovalCapability` | `openclaw/plugin-sdk/approval-delivery-runtime` | telegram :1-4 |
| `createLazyChannelApprovalNativeRuntimeAdapter` | `openclaw/plugin-sdk/approval-handler-adapter-runtime` | telegram :5 |
| `ChannelApprovalNativeRuntimeAdapter` (type) | `openclaw/plugin-sdk/approval-handler-runtime` | telegram :6 |
| `createChannelNativeOriginTargetResolver`<br/>`createChannelApproverDmTargetResolver` | `openclaw/plugin-sdk/approval-native-runtime` | telegram :7-10 |
| `NativeApprovalTarget` (type) | **不从公共子路径导出**——上游定义在 internal `approval-native-helpers.ts`。channel 模块自定义本地 `DingTalkApprovalTarget` 类型，通过 helper 泛型参数传入（参 Task 5 + telegram peer 同模式） | `openclaw/src/plugin-sdk/approval-native-helpers.ts:51`（仅参考，不 import） |
| `ExecApprovalRequest` / `PluginApprovalRequest` (types) | `openclaw/plugin-sdk/approval-runtime` | telegram :11-14 |
| `resolveApprovalOverGateway` | `openclaw/plugin-sdk/approval-gateway-runtime`<br/>（或 `openclaw/plugin-sdk/approval-handler-runtime` re-export） | `openclaw/src/plugin-sdk/approval-handler-runtime.ts:31` |
| 字符串/normalize helper | `openclaw/plugin-sdk/string-coerce-runtime` | telegram :17-20 |

> **不要从 `openclaw/plugin-sdk` 根 import 上述符号**——根入口故意做得很瘦（仅 channel plugin 公共 surface），上述类型/函数都在 subpath。如发现 plan 内还有从根 import 的，按本表纠正。

### Stage 0.B · SDK 基线四件套（peerDep + lockfile + manifest + tsconfig）

**Files:**
- Modify: `package.json`（peer + manifest 三处）
- Modify: `pnpm-lock.yaml`
- Verify: `node_modules/openclaw/package.json`、`tsconfig.json`

- [ ] **Step 0.1: bump peerDependency + manifest 三处**

修改 `package.json` 内 4 处 `2026.3.28` → `2026.4.7`：

```json
"peerDependencies": {
  "openclaw": ">=2026.4.7"
},
...
"openclaw": {
  "compat": {
    "pluginApi": ">=2026.4.7"
  },
  "build": {
    "openclawVersion": "2026.4.7"
  },
  ...
  "install": {
    "minHostVersion": ">=2026.4.7",
    ...
  }
}
```

> 4 处必须同步——`peerDependencies` 控 npm 安装时的 peer 提示；`openclaw.compat.pluginApi` 与 `openclaw.install.minHostVersion` 控 OpenClaw 主程序的 manifest 兼容性检查；`openclaw.build.openclawVersion` 控构建期 SDK 类型基线。少改任何一处都会出现"npm 装得上但 OpenClaw 拒绝加载"或反之的不一致。

- [ ] **Step 0.2: 同步 lockfile + 安装**

Run: `pnpm install`
Expected: 安装成功，`node_modules/openclaw/package.json` `"version"` 字段 `>=2026.4.7`。

- [ ] **Step 0.3: 验证 type-check 通过**

Run: `pnpm run type-check`
Expected: 0 错误。若 fail 提示 `ChannelApprovalNativeRuntimeAdapter` 等类型找不到，确认 `tsconfig.json` paths 优先级；monorepo 场景可临时把 `../openclaw/src/plugin-sdk` 调到 `node_modules/openclaw/dist` 之前。

- [ ] **Step 0.4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(deps): bump openclaw peer/manifest baseline to >=2026.4.7

4 处同步：peerDependencies + openclaw.compat.pluginApi +
openclaw.build.openclawVersion + openclaw.install.minHostVersion。
获取 ChannelApprovalNativeRuntimeAdapter 契约 +
resolveApprovalOverGateway 公开 API。

BREAKING CHANGE: openclaw peer 升级到 2026.4.7+，老版本（2026.3.28）不再支持；OpenClaw host 端 manifest 兼容性同步收紧。
EOF
)"
```

---

## Task 1 · 类型与配置 schema 准备

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config-schema.ts`
- Test: `tests/unit/approval-config-schema.test.ts`（新建）

- [ ] **Step 1.1: 在 src/types.ts 加 approval 类型**

文件末尾追加：

```typescript
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ApprovalPhase = "pending" | "resolved" | "expired";

export interface ExecApprovalsConfig {
  enabled?: boolean | "auto";
  approvers?: string[];
}
```

并在 `DingTalkConfig` 接口加 `execApprovals?: ExecApprovalsConfig;` 字段（紧贴 `learningEnabled` 等同级配置之后）。

- [ ] **Step 1.2: 写 config schema 失败测试**

新增 `tests/unit/approval-config-schema.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { DingTalkConfigSchema } from "../../src/config-schema";

describe("DingTalkConfigSchema · execApprovals", () => {
  it("接受 enabled=auto + approvers 列表", () => {
    const parsed = DingTalkConfigSchema.parse({
      clientId: "x",
      clientSecret: "y",
      execApprovals: { enabled: "auto", approvers: ["staff001"] },
    });
    expect(parsed.execApprovals?.enabled).toBe("auto");
    expect(parsed.execApprovals?.approvers).toEqual(["staff001"]);
  });

  it("接受 enabled=true / false", () => {
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x", clientSecret: "y",
        execApprovals: { enabled: true, approvers: [] },
      }),
    ).not.toThrow();
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x", clientSecret: "y",
        execApprovals: { enabled: false },
      }),
    ).not.toThrow();
  });

  it("execApprovals 完全省略时合法（向后兼容）", () => {
    expect(() =>
      DingTalkConfigSchema.parse({ clientId: "x", clientSecret: "y" }),
    ).not.toThrow();
  });

  it("approvers 元素必须是 string", () => {
    expect(() =>
      DingTalkConfigSchema.parse({
        clientId: "x", clientSecret: "y",
        execApprovals: { approvers: [123 as unknown as string] },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 1.3: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-config-schema.test.ts`
Expected: FAIL（schema 不识别 execApprovals 字段或字段缺失）。

- [ ] **Step 1.4: 在 src/config-schema.ts 加 schema**

在 `src/config-schema.ts` 加入：

```typescript
const ExecApprovalsConfigSchema = z.object({
  enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
  approvers: z.array(z.string()).optional(),
}).strict();
```

并把 `execApprovals: ExecApprovalsConfigSchema.optional(),` 加到 `DingTalkConfigSchema` 与 account override schema 两处。导出 `ExecApprovalsConfigSchema` 供测试用。

> **`.strict()` 的语义边界**：v1 schema **有意**拒绝 `target` / `ttlMs` 等 spec §4.2 列为"v2 future"的字段。这样可以让用户取消 v2 注释的 yaml 时立即得到清晰的 parse 错误，而不是默默忽略导致部分行为不生效。
>
> 若想让 schema 接受未知字段以便 forward-compat，去掉 `.strict()` 即可——但这会让 v2 future config 出现"看起来生效但 v1 不读"的迷惑行为。**v1 选 strict + future-field test 强对齐**。
>
> 在 Step 1.2 的测试里**加一个 case**显式断言 strict 行为：
>
> ```typescript
> it("拒绝 v2 future 字段 target / ttlMs（strict 边界）", () => {
>   expect(() =>
>     DingTalkConfigSchema.parse({
>       clientId: "x", clientSecret: "y",
>       execApprovals: { approvers: ["s"], target: "dm" } as never,
>     }),
>   ).toThrow();
>   expect(() =>
>     DingTalkConfigSchema.parse({
>       clientId: "x", clientSecret: "y",
>       execApprovals: { approvers: ["s"], ttlMs: 600000 } as never,
>     }),
>   ).toThrow();
> });
> ```
>
> 当 v2 future 实施时**同时**更新 schema 接受这两个字段 + 删掉本测试。

- [ ] **Step 1.5: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-config-schema.test.ts`
Expected: 5 PASS（含 strict 边界 case）。

- [ ] **Step 1.6: 类型一致性验证**

Run: `pnpm run type-check`
Expected: 0 错误。

- [ ] **Step 1.7: Commit**

```bash
git add src/types.ts src/config-schema.ts tests/unit/approval-config-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 ExecApprovalsConfig 类型与 schema

为 DingTalk channel 增加 execApprovals 配置块（enabled + approvers），
为 Gap #01 approver 名单与 enabled 三态做类型与 schema 准备。

EOF
)"
```

---

## Task 2 · config.ts default-account 路径补 execApprovals

**Files:**
- Modify: `src/config.ts:279-310`（`resolveDingTalkAccount` 的 default-account rawConfig 字面量）
- Modify: `tests/unit/config.test.ts`

- [ ] **Step 2.1: 写 default account 配置遗漏测试**

在 `tests/unit/config.test.ts` 末尾追加：

```typescript
// resolveDingTalkAccount 返回 ResolvedDingTalkAccount extends DingTalkConfig
// 字段直接挂顶层（参 Stage 0.A 签名核对表）：account.execApprovals，不是 account.config.execApprovals
describe("resolveDingTalkAccount · execApprovals 字段传递", () => {
  it("default 账号能拿到 channel 级 execApprovals", () => {
    const cfg = {
      channels: {
        dingtalk: {
          clientId: "x", clientSecret: "y",
          execApprovals: { enabled: "auto", approvers: ["staff001"] },
        },
      },
    };
    const account = resolveDingTalkAccount(cfg, undefined);
    expect(account.execApprovals?.approvers).toEqual(["staff001"]);
    expect(account.execApprovals?.enabled).toBe("auto");
  });

  it("account override 完全替换 channel 级 approvers（不合并）", () => {
    const cfg = {
      channels: {
        dingtalk: {
          clientId: "x", clientSecret: "y",
          execApprovals: { approvers: ["staffA"] },
          accounts: {
            acme: {
              clientId: "x", clientSecret: "y",
              execApprovals: { approvers: ["staffB"] },
            },
          },
        },
      },
    };
    const acme = resolveDingTalkAccount(cfg, "acme");
    expect(acme.execApprovals?.approvers).toEqual(["staffB"]);
  });

  it("account 未配 execApprovals 时继承 channel-level（spread 自动 cover）", () => {
    const cfg = {
      channels: {
        dingtalk: {
          clientId: "x", clientSecret: "y",
          execApprovals: { approvers: ["staffA"] },
          accounts: { acme: { clientId: "x", clientSecret: "y" } },
        },
      },
    };
    const acme = resolveDingTalkAccount(cfg, "acme");
    expect(acme.execApprovals?.approvers).toEqual(["staffA"]);
  });

  it("channel 级未配 execApprovals 时 default 账号 execApprovals 为 undefined", () => {
    const cfg = { channels: { dingtalk: { clientId: "x", clientSecret: "y" } } };
    const account = resolveDingTalkAccount(cfg, undefined);
    expect(account.execApprovals).toBeUndefined();
  });
});
```

- [ ] **Step 2.2: 跑测试确认 fail（至少第 1 个 case fail）**

Run: `pnpm vitest run tests/unit/config.test.ts -t "execApprovals 字段传递"`
Expected: 第 1 个 case FAIL（default 账号拿不到 execApprovals）；第 3 个可能 PASS（spread 自动 cover）。

- [ ] **Step 2.3: 在 src/config.ts:279-310 rawConfig 字面量加 execApprovals**

在 default-account 路径 `rawConfig` 字面量末尾（与 `learningNoteTtlMs` 同级，保持字母顺序或紧贴 `learningEnabled` 等扩展字段后）补一行：

```typescript
execApprovals: dingtalk?.execApprovals,
```

`mergeAccountWithDefaults` 的 spread 模式（src/config.ts:60-85）自动保留新字段，不需要改。

- [ ] **Step 2.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/config.test.ts -t "execApprovals 字段传递"`
Expected: 4 PASS。

- [ ] **Step 2.5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "$(cat <<'EOF'
fix(config): default 账号补 execApprovals 字段拷贝

resolveDingTalkAccount default 路径用字面量构造 rawConfig，必须显式列出
execApprovals 字段否则多账号场景 default 账号完全拿不到该配置。
account-level 路径走 mergeAccountWithDefaults 的 spread 模式自动 cover。

EOF
)"
```

---

## Task 3 · approval-config.ts（读 helper）

**Files:**
- Create: `src/approval/approval-config.ts`
- Test: `tests/unit/approval-config.test.ts`

- [ ] **Step 3.1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import {
  getExecApprovalsConfig,
  listExecApprovers,
  isExecAuthorizedSender,
  isPluginAuthorizedSender,
  resolveNativeDeliveryMode,
} from "../../src/approval/approval-config";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const cfg = (approvers: string[], opts: { ownerAllowFrom?: string[]; enabled?: boolean | "auto" } = {}): OpenClawConfig =>
  ({
    channels: {
      dingtalk: {
        clientId: "x", clientSecret: "y",
        execApprovals: { enabled: opts.enabled ?? "auto", approvers },
      },
    },
    commands: { ownerAllowFrom: opts.ownerAllowFrom },
  }) as unknown as OpenClawConfig;

describe("approval-config", () => {
  it("listExecApprovers 返回去重 normalize 后的 staffId 列表", () => {
    const c = cfg(["staff001", "dingtalk:staff002", "DD:staff003", "ding:staff001"]);
    expect(listExecApprovers({ cfg: c, accountId: "default" })).toEqual([
      "staff001", "staff002", "staff003",
    ]);
  });

  it("approvers 为空时 fallback 到 commands.ownerAllowFrom", () => {
    const c = cfg([], { ownerAllowFrom: ["staff999"] });
    expect(listExecApprovers({ cfg: c, accountId: "default" })).toEqual(["staff999"]);
  });

  it("isExecAuthorizedSender 名单内 staffId 返回 true", () => {
    const c = cfg(["staff001"]);
    expect(isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff001" })).toBe(true);
    expect(isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff999" })).toBe(false);
  });

  it("isExecAuthorizedSender 接受 dingtalk:/dd:/ding: 前缀的 senderId", () => {
    const c = cfg(["staff001"]);
    expect(isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "dingtalk:staff001" })).toBe(true);
  });

  it("isPluginAuthorizedSender 默认 = isExecAuthorizedSender", () => {
    const c = cfg(["staff001"]);
    expect(isPluginAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff001" })).toBe(true);
  });

  it("enabled=false 时 getExecApprovalsConfig.enabled 显式 false（即使 approvers 非空）", () => {
    const c = cfg(["staff001"], { enabled: false });
    const conf = getExecApprovalsConfig({ cfg: c, accountId: "default" });
    expect(conf.enabled).toBe(false);
  });

  it("enabled=auto + approvers 非空时 isNativeDeliveryEnabled 返回 true", () => {
    const c = cfg(["staff001"]);
    const conf = getExecApprovalsConfig({ cfg: c, accountId: "default" });
    expect(conf.isNativeDeliveryEnabled).toBe(true);
  });

  it("enabled=auto + approvers 为空时 isNativeDeliveryEnabled 返回 false", () => {
    const c = cfg([]);
    expect(getExecApprovalsConfig({ cfg: c, accountId: "default" }).isNativeDeliveryEnabled).toBe(false);
  });

  it('resolveNativeDeliveryMode 在 v1 永远返回 "channel"', () => {
    const c = cfg(["staff001"]);
    expect(resolveNativeDeliveryMode({ cfg: c, accountId: "default" })).toBe("channel");
  });
});
```

- [ ] **Step 3.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-config.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 3.3: 实现 src/approval/approval-config.ts**

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getConfig } from "../config";

const PREFIX_RE = /^(dingtalk|dd|ding):/i;
const normalizeStaffId = (raw: string): string => raw.replace(PREFIX_RE, "").trim();

export interface ApprovalConfigQuery {
  cfg: OpenClawConfig;
  accountId: string;
}

export interface ResolvedExecApprovalsConfig {
  enabled: boolean | "auto" | undefined;
  approvers: string[];
  isNativeDeliveryEnabled: boolean;
}

export function listExecApprovers({ cfg, accountId }: ApprovalConfigQuery): string[] {
  const account = getConfig(cfg, accountId);
  const raw = account?.execApprovals?.approvers ?? [];
  const fallback = raw.length === 0 ? (cfg.commands?.ownerAllowFrom ?? []) : raw;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of fallback) {
    const id = normalizeStaffId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function getExecApprovalsConfig(
  q: ApprovalConfigQuery,
): ResolvedExecApprovalsConfig {
  const account = getConfig(q.cfg, q.accountId);
  const enabled = account?.execApprovals?.enabled;
  const approvers = listExecApprovers(q);
  const isNativeDeliveryEnabled = enabled === false ? false : approvers.length > 0;
  return { enabled, approvers, isNativeDeliveryEnabled };
}

export function isExecAuthorizedSender({
  cfg, accountId, senderId,
}: ApprovalConfigQuery & { senderId: string }): boolean {
  const approvers = listExecApprovers({ cfg, accountId });
  const normalized = normalizeStaffId(senderId);
  return approvers.includes(normalized);
}

export function isPluginAuthorizedSender(
  q: ApprovalConfigQuery & { senderId: string },
): boolean {
  return isExecAuthorizedSender(q);
}

export function resolveNativeDeliveryMode(_q: ApprovalConfigQuery): "channel" {
  return "channel";
}
```

- [ ] **Step 3.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-config.test.ts`
Expected: 9 PASS。

- [ ] **Step 3.5: Lint + type-check**

Run: `pnpm run type-check && pnpm run lint`
Expected: 0 错误。

- [ ] **Step 3.6: Commit**

```bash
git add src/approval/approval-config.ts tests/unit/approval-config.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-config 读 helper

新增 listExecApprovers / getExecApprovalsConfig / isExecAuthorizedSender /
isPluginAuthorizedSender / resolveNativeDeliveryMode 5 个纯读 helper。
支持 dingtalk:/dd:/ding: 前缀 normalize、commands.ownerAllowFrom fallback。
enabled=auto 即"有 approvers 就启用"；v1 deliveryMode 永远 channel。

EOF
)"
```

---

## Task 4 · approval-command-parser.ts（纯解析 10 alias × 2 顺序）

**Files:**
- Create: `src/approval/approval-command-parser.ts`
- Test: `tests/unit/approval-command-parser.test.ts`

- [ ] **Step 4.1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { parseApproveCommand } from "../../src/approval/approval-command-parser";

const ALIAS_ALLOW_ONCE = ["allow", "once", "allow-once", "allowonce"] as const;
const ALIAS_ALLOW_ALWAYS = ["always", "allow-always", "allowalways"] as const;
const ALIAS_DENY = ["deny", "reject", "block"] as const;

describe("parseApproveCommand", () => {
  describe('order A: /approve <id> <decision>', () => {
    for (const a of ALIAS_ALLOW_ONCE)
      it(`/approve abc ${a} → allow-once`, () =>
        expect(parseApproveCommand(`/approve abc ${a}`)).toEqual({ approvalId: "abc", decision: "allow-once" }));
    for (const a of ALIAS_ALLOW_ALWAYS)
      it(`/approve abc ${a} → allow-always`, () =>
        expect(parseApproveCommand(`/approve abc ${a}`)).toEqual({ approvalId: "abc", decision: "allow-always" }));
    for (const a of ALIAS_DENY)
      it(`/approve abc ${a} → deny`, () =>
        expect(parseApproveCommand(`/approve abc ${a}`)).toEqual({ approvalId: "abc", decision: "deny" }));
  });

  describe('order B: /approve <decision> <id>', () => {
    for (const a of ALIAS_ALLOW_ONCE)
      it(`/approve ${a} abc → allow-once`, () =>
        expect(parseApproveCommand(`/approve ${a} abc`)).toEqual({ approvalId: "abc", decision: "allow-once" }));
    for (const a of ALIAS_ALLOW_ALWAYS)
      it(`/approve ${a} abc → allow-always`, () =>
        expect(parseApproveCommand(`/approve ${a} abc`)).toEqual({ approvalId: "abc", decision: "allow-always" }));
    for (const a of ALIAS_DENY)
      it(`/approve ${a} abc → deny`, () =>
        expect(parseApproveCommand(`/approve ${a} abc`)).toEqual({ approvalId: "abc", decision: "deny" }));
  });

  it("接受裸 approve（无前导斜杠）", () => {
    expect(parseApproveCommand("approve abc once")).toEqual({ approvalId: "abc", decision: "allow-once" });
  });

  it("大小写不敏感的 decision alias", () => {
    expect(parseApproveCommand("/approve abc ALLOW")).toEqual({ approvalId: "abc", decision: "allow-once" });
  });

  it("approvalId 保留原始大小写（不 normalize）", () => {
    expect(parseApproveCommand("/approve ABC-123 deny")?.approvalId).toBe("ABC-123");
  });

  it("malformed: 缺 decision 或 id 返 null", () => {
    expect(parseApproveCommand("/approve")).toBeNull();
    expect(parseApproveCommand("/approve abc")).toBeNull();
    expect(parseApproveCommand("/approve abc xyz")).toBeNull();
    expect(parseApproveCommand("approve foo bar baz qux")).toBeNull();
    expect(parseApproveCommand("")).toBeNull();
  });

  it("alias 数量 == 上游 commands-approve.ts:19-30 的 10 个", () => {
    const channelAliasCount = ALIAS_ALLOW_ONCE.length + ALIAS_ALLOW_ALWAYS.length + ALIAS_DENY.length;
    expect(channelAliasCount).toBe(10);
  });
});
```

- [ ] **Step 4.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-command-parser.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 4.3: 实现 src/approval/approval-command-parser.ts**

```typescript
import type { ApprovalDecision } from "../types";

const ALIAS_MAP: Record<string, ApprovalDecision> = {
  // allow-once（4）
  "allow": "allow-once", "once": "allow-once",
  "allow-once": "allow-once", "allowonce": "allow-once",
  // allow-always（3）
  "always": "allow-always", "allow-always": "allow-always", "allowalways": "allow-always",
  // deny（3）
  "deny": "deny", "reject": "deny", "block": "deny",
};

export interface ParsedApproveCommand {
  approvalId: string;
  decision: ApprovalDecision;
}

const HEAD = /^\/?approve(?:\s|$)/i;

export function parseApproveCommand(text: string): ParsedApproveCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!HEAD.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 3) return null;
  const [, a, b] = tokens;
  const aDecision = ALIAS_MAP[a.toLowerCase()];
  const bDecision = ALIAS_MAP[b.toLowerCase()];
  if (aDecision && !bDecision) return { approvalId: b, decision: aDecision };
  if (bDecision && !aDecision) return { approvalId: a, decision: bDecision };
  return null;
}
```

- [ ] **Step 4.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-command-parser.test.ts`
Expected: 26 PASS。

- [ ] **Step 4.5: Commit**

```bash
git add src/approval/approval-command-parser.ts tests/unit/approval-command-parser.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 /approve 命令解析器

支持 10 个 decision alias × 2 种顺序 = 20 合法形式，
对齐上游 openclaw/src/auto-reply/reply/commands-approve.ts:19-30。
regex 与上游 COMMAND_REGEX = /^\\/?approve(?:\\s|$)/i 完全对齐（前导斜杠可选；严格要求空格或行尾分隔，
避免 /approve! /approve-x 等误命中——\\b 比上游更宽松，不要用）。

EOF
)"
```


---

## Task 5 · approval-target-resolver.ts（薄壳——复用上游 helper）

**Files:**
- Create: `src/approval/approval-target-resolver.ts`
- Test: `tests/unit/approval-target-resolver.test.ts`

**关键设计决策：** 复用上游 `createChannelNativeOriginTargetResolver`（`openclaw/src/plugin-sdk/approval-native-helpers.ts:137-153`，参 Stage 0.A）做 turnSource / session target / fallback / accountId 一致性校验，channel 端只保留 DingTalk 专属的 `normalizeApprovalTargetTo`（前缀补全）。peer telegram 同模式（`openclaw/extensions/telegram/src/approval-native.ts:64`）。

注意上游 helper 的 input 签名：`(input: ApprovalResolverParams) => target | null`，其中 `input.request` 是 `ExecApprovalRequest | PluginApprovalRequest`（嵌套），**payload 字段在 `input.request.request.turnSourceChannel`** 等（参 Stage 0.A）。

- [ ] **Step 5.1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import {
  normalizeApprovalTargetTo,
  resolveDingTalkOriginTarget,
} from "../../src/approval/approval-target-resolver";

const req = (payload: Partial<{
  turnSourceChannel: string | null;
  turnSourceTo: string | null;
  turnSourceAccountId: string | null;
  turnSourceThreadId: string | number | null;
  sessionKey: string | null;
}>) =>
  ({
    id: "abc", createdAtMs: 0, expiresAtMs: 0,
    request: { ...payload },
  }) as never;

describe("normalizeApprovalTargetTo", () => {
  it("带 group: 前缀的输入原样保留", () => {
    expect(normalizeApprovalTargetTo("group:cidxxxxx")).toBe("group:cidxxxxx");
  });
  it("带 user: 前缀的输入原样保留", () => {
    expect(normalizeApprovalTargetTo("user:staff001")).toBe("user:staff001");
  });
  it("裸 cid 开头加 group: 前缀", () => {
    expect(normalizeApprovalTargetTo("cidxxxxx")).toBe("group:cidxxxxx");
  });
  it("裸 staffId 加 user: 前缀", () => {
    expect(normalizeApprovalTargetTo("staff001")).toBe("user:staff001");
  });
});

describe("resolveDingTalkOriginTarget（用上游 helper 装配）", () => {
  it("turnSourceChannel != dingtalk → null", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "default",
      request: req({ turnSourceChannel: "discord", turnSourceTo: "group:c" }),
    });
    expect(r).toBeNull();
  });

  it("turnSourceTo 为空 → null", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "default",
      request: req({ turnSourceChannel: "dingtalk", turnSourceTo: null }),
    });
    expect(r).toBeNull();
  });

  it("dingtalk + group:cid 形态 → normalize 并返带 prefix 的 target（threadId null）", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "default",
      request: req({ turnSourceChannel: "dingtalk", turnSourceTo: "group:cidxxx" }),
    });
    expect(r).toEqual(expect.objectContaining({ to: "group:cidxxx" }));
  });

  it("dingtalk + 裸 cid 形态 → 加 group: 前缀", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "default",
      request: req({ turnSourceChannel: "dingtalk", turnSourceTo: "cidxxx" }),
    });
    expect(r?.to).toBe("group:cidxxx");
  });

  it("dingtalk + 裸 staffId 形态 → 加 user: 前缀", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "default",
      request: req({ turnSourceChannel: "dingtalk", turnSourceTo: "staff001" }),
    });
    expect(r?.to).toBe("user:staff001");
  });

  it("turnSourceAccountId != input.accountId → null（上游 helper 内置校验）", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "acme",
      request: req({ turnSourceChannel: "dingtalk", turnSourceTo: "group:c", turnSourceAccountId: "other" }),
    });
    expect(r).toBeNull();
  });

  it("保留 turnSourceAccountId + turnSourceThreadId（向上游 target 透传）", () => {
    const r = resolveDingTalkOriginTarget({
      cfg: {} as never, accountId: "acme",
      request: req({
        turnSourceChannel: "dingtalk",
        turnSourceTo: "group:c",
        turnSourceAccountId: "acme",
        turnSourceThreadId: "thread-xyz",
      }),
    });
    expect(r).toEqual(expect.objectContaining({
      to: "group:c", accountId: "acme", threadId: "thread-xyz",
    }));
  });
});
```

> 注：`turnSourceAccountId != accountId → null` 这一行依赖上游 helper 内置 account-binding 校验；如本地核对发现行为不同（如返非空），按上游真实行为调整断言。

- [ ] **Step 5.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-target-resolver.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 5.3: 实现 src/approval/approval-target-resolver.ts**

```typescript
import { createChannelNativeOriginTargetResolver } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

// 本地 target 类型（telegram peer 同模式：用本地 alias，不 import）
// 上游 NativeApprovalTarget 实际在 approval-native-helpers.ts，但只有 runtime.ts 是公共子路径
// 入口；runtime.ts 没 re-export 这个 type 别名（核实 Stage 0.A）。我们参照 telegram 的
// TelegramOriginTarget 同模式，在 channel 模块内自定义最小形态：
export type DingTalkApprovalTarget = {
  to: string;
  accountId?: string | null;
  // 保留 threadId 即使 v1 不用——上游 NativeApprovalTarget 形状有此字段，留着排查 / 未来扩展更稳
  threadId?: string | number | null;
};

export function normalizeApprovalTargetTo(raw: string): string {
  if (/^(user|group):/i.test(raw)) return raw;
  if (/^cid/i.test(raw)) return `group:${raw}`;
  return `user:${raw}`;
}

function resolveTurnSourceTarget(request: ApprovalRequest): DingTalkApprovalTarget | null {
  const payload = request.request;
  if (payload.turnSourceChannel !== "dingtalk") return null;
  if (!payload.turnSourceTo) return null;
  return {
    to: normalizeApprovalTargetTo(payload.turnSourceTo),
    accountId: payload.turnSourceAccountId ?? null,
    threadId: payload.turnSourceThreadId ?? null,
  };
}

function resolveSessionTarget(
  sessionTarget: { to: string; accountId?: string | null; threadId?: string | number | null } | null,
  _request: ApprovalRequest,
): DingTalkApprovalTarget | null {
  if (!sessionTarget?.to) return null;
  return {
    to: normalizeApprovalTargetTo(sessionTarget.to),
    accountId: sessionTarget.accountId ?? null,
    threadId: sessionTarget.threadId ?? null,
  };
}

export const resolveDingTalkOriginTarget = createChannelNativeOriginTargetResolver<DingTalkApprovalTarget>({
  channel: "dingtalk",
  resolveTurnSourceTarget,
  resolveSessionTarget,
  normalizeTarget: (target) => ({
    ...target,
    to: normalizeApprovalTargetTo(target.to),
  }),
});
```

> **NativeApprovalTarget 导入说明**：上游 `approval-native-runtime.ts` 公共子路径**只 re-export 函数**（`createChannelNativeOriginTargetResolver` 等），没 re-export `NativeApprovalTarget` 类型别名（核实 Stage 0.A）。
>
> 为避免从 internal `approval-native-helpers.ts` 直接 import 类型（破坏封装），本仓库采用 telegram peer 同模式——在 channel 内自定义本地 `DingTalkApprovalTarget` 类型，通过 `createChannelNativeOriginTargetResolver<DingTalkApprovalTarget>` 泛型参数告诉上游 helper 这是 channel-specific shape。
>
> 如果将来 OpenClaw SDK 在 `approval-native-runtime.ts` 加上 `export type { NativeApprovalTarget }` re-export，可以直接 import 并 `DingTalkApprovalTarget extends NativeApprovalTarget`。

- [ ] **Step 5.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-target-resolver.test.ts`
Expected: 全部 PASS（上游 helper 行为 + DingTalk 专属 normalize）。

- [ ] **Step 5.5: Commit**

```bash
git add src/approval/approval-target-resolver.ts tests/unit/approval-target-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-target-resolver（复用上游 helper）

调用上游 createChannelNativeOriginTargetResolver 装配 origin target 解析；
channel 端只保留 DingTalk 专属的 normalizeApprovalTargetTo（user:/group:
前缀补全）。turnSource / session / accountId 一致性校验由上游 helper 内置。
模式对齐 openclaw/extensions/telegram/src/approval-native.ts:64。

resolveApproverDmTargets 推迟 v2（v1 不实现 DM 投递）。
EOF
)"
```

---

## Task 6 · approval-resolver.ts（D20 单点 + 5 类错误分类）

**Files:**
- Create: `src/approval/approval-resolver.ts`
- Test: `tests/unit/approval-resolver.test.ts`

**关键参考：**
- 上游 `resolveApprovalOverGateway`：`openclaw/src/plugin-sdk/approval-gateway-runtime.ts`
- exec invalid-decision 错误：`openclaw/src/gateway/server-methods/exec-approval.ts:45-46,449-470`
- plugin invalid-decision 错误：`openclaw/src/gateway/server-methods/plugin-approval.ts:184-204`
- `isApprovalNotFoundError`：`openclaw/src/infra/approval-errors.ts`

- [ ] **Step 6.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveApproval,
  isInvalidApprovalDecisionError,
} from "../../src/approval/approval-resolver";

// mock 必须对齐 impl 的真实 import subpath（Stage 0.A 导入子路径表）
// approval-resolver.ts impl 从 openclaw/plugin-sdk/approval-gateway-runtime import，不是根 entry
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: vi.fn(),
}));
vi.mock("../../src/approval/approval-config", () => ({
  isExecAuthorizedSender: vi.fn(() => true),
  isPluginAuthorizedSender: vi.fn(() => true),
}));

const { resolveApprovalOverGateway } = await import("openclaw/plugin-sdk/approval-gateway-runtime");
const { isExecAuthorizedSender, isPluginAuthorizedSender } = await import("../../src/approval/approval-config");

const base = { cfg: {} as never, accountId: "default", senderId: "staffA", log: undefined as never };
const mockGw = resolveApprovalOverGateway as unknown as ReturnType<typeof vi.fn>;

describe("approval-resolver · kind 推导（D21）", () => {
  beforeEach(() => mockGw.mockReset());

  it("approvalId 带 plugin: 前缀 → resolveMethod=plugin", async () => {
    mockGw.mockResolvedValue({});
    await resolveApproval({ ...base, approvalId: "plugin:xyz", decision: "allow-once" });
    expect(mockGw).toHaveBeenCalledWith(expect.objectContaining({ resolveMethod: "plugin" }));
  });

  it("无前缀 + 两边都授权 → 默认 exec + allowPluginFallback=true", async () => {
    mockGw.mockResolvedValue({});
    (isExecAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (isPluginAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });
    expect(mockGw).toHaveBeenCalledWith(expect.objectContaining({
      allowPluginFallback: true,
    }));
    expect(mockGw.mock.calls[0][0]).not.toHaveProperty("resolveMethod");
  });

  it("无前缀 + 仅 plugin 授权 → resolveMethod=plugin", async () => {
    mockGw.mockResolvedValue({});
    (isExecAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    (isPluginAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });
    expect(mockGw).toHaveBeenCalledWith(expect.objectContaining({ resolveMethod: "plugin" }));
  });

  it("无前缀 + 仅 exec 授权 → 默认 exec（无 plugin fallback）", async () => {
    mockGw.mockResolvedValue({});
    (isExecAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    (isPluginAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });
    expect(mockGw).toHaveBeenCalledWith(expect.objectContaining({
      allowPluginFallback: false,
    }));
    expect(mockGw.mock.calls[0][0]).not.toHaveProperty("resolveMethod");
  });

  it("两边都未授权 → 返 unauthorized 且不调 gateway", async () => {
    (isExecAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    (isPluginAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });
    expect(r).toEqual({ ok: false, reason: "unauthorized" });
    expect(mockGw).not.toHaveBeenCalled();
  });
});

describe("approval-resolver · 错误分类（5 类）", () => {
  beforeEach(() => {
    mockGw.mockReset();
    (isExecAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isPluginAuthorizedSender as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it("gateway 抛 APPROVAL_NOT_FOUND → not-found", async () => {
    mockGw.mockRejectedValue(Object.assign(new Error("not found"), { gatewayCode: "APPROVAL_NOT_FOUND" }));
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "not-found" }));
  });

  it("gateway 抛 APPROVAL_ALREADY_RESOLVED → already-resolved", async () => {
    mockGw.mockRejectedValue(Object.assign(new Error("already"), { gatewayCode: "APPROVAL_ALREADY_RESOLVED" }));
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });
    expect(r).toEqual(expect.objectContaining({ ok: false, reason: "already-resolved" }));
  });

  it("exec invalid-decision（reason=APPROVAL_ALLOW_ALWAYS_UNAVAILABLE） → invalid-decision", async () => {
    mockGw.mockRejectedValue(Object.assign(new Error("invalid"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
    }));
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "allow-always" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-decision");
  });

  it("plugin invalid-decision（allowedDecisions 数组） → invalid-decision 且透传 allowedDecisions", async () => {
    mockGw.mockRejectedValue(Object.assign(new Error("invalid"), {
      gatewayCode: "INVALID_REQUEST",
      details: { allowedDecisions: ["allow-once", "deny"] },
    }));
    const r = await resolveApproval({ ...base, approvalId: "plugin:p", decision: "allow-always" });
    expect(r).toEqual(expect.objectContaining({
      ok: false, reason: "invalid-decision", allowedDecisions: ["allow-once", "deny"],
    }));
  });

  it("非 invalid-decision 的 INVALID_REQUEST 归 gateway-error", async () => {
    mockGw.mockRejectedValue(Object.assign(new Error("misc"), {
      gatewayCode: "INVALID_REQUEST", details: { other: true },
    }));
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });
    expect(r.reason).toBe("gateway-error");
  });

  it("其它任意错误 → gateway-error", async () => {
    mockGw.mockRejectedValue(new Error("network down"));
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "deny" });
    expect(r.reason).toBe("gateway-error");
  });

  it("成功 → ok=true", async () => {
    mockGw.mockResolvedValue({});
    const r = await resolveApproval({ ...base, approvalId: "abc", decision: "allow-once" });
    expect(r).toEqual({ ok: true });
  });
});

describe("isInvalidApprovalDecisionError helper", () => {
  it("识别 exec 形态", () => {
    expect(isInvalidApprovalDecisionError({
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
    })).toBe(true);
  });
  it("识别 plugin 形态", () => {
    expect(isInvalidApprovalDecisionError({
      gatewayCode: "INVALID_REQUEST",
      details: { allowedDecisions: ["allow-once"] },
    })).toBe(true);
  });
  it("不识别 details 为空的 INVALID_REQUEST", () => {
    expect(isInvalidApprovalDecisionError({ gatewayCode: "INVALID_REQUEST" })).toBe(false);
  });
  it("不识别非 INVALID_REQUEST", () => {
    expect(isInvalidApprovalDecisionError({ gatewayCode: "NETWORK_ERROR" })).toBe(false);
  });
});
```

- [ ] **Step 6.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-resolver.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 6.3: 实现 src/approval/approval-resolver.ts**

```typescript
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ApprovalDecision, Logger } from "../types";
import {
  isExecAuthorizedSender,
  isPluginAuthorizedSender,
} from "./approval-config";

export type ResolverReason =
  | "unauthorized"
  | "already-resolved"
  | "not-found"
  | "invalid-decision"
  | "gateway-error";

export type ResolverResult =
  | { ok: true }
  | {
      ok: false;
      reason: ResolverReason;
      error?: unknown;
      allowedDecisions?: string[];
    };

export interface ResolveApprovalInput {
  cfg: OpenClawConfig;
  accountId: string;
  approvalId: string;
  decision: ApprovalDecision;
  senderId: string;
  log?: Logger;
}

export function isInvalidApprovalDecisionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { gatewayCode?: unknown; details?: { reason?: unknown; allowedDecisions?: unknown } };
  if (e.gatewayCode !== "INVALID_REQUEST") return false;
  const d = e.details;
  if (!d || typeof d !== "object") return false;
  if (d.reason === "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE") return true;
  if (Array.isArray(d.allowedDecisions)) return true;
  return false;
}

function extractAllowedDecisions(err: unknown): string[] | undefined {
  const d = (err as { details?: { allowedDecisions?: unknown } } | null)?.details;
  return Array.isArray(d?.allowedDecisions) ? (d!.allowedDecisions as string[]) : undefined;
}

function deriveResolveMethod(
  approvalId: string,
  execAuth: boolean,
  pluginAuth: boolean,
): { resolveMethod?: "plugin"; allowPluginFallback?: boolean } | null {
  if (!execAuth && !pluginAuth) return null;
  if (approvalId.startsWith("plugin:")) return { resolveMethod: "plugin" };
  if (execAuth && pluginAuth) return { allowPluginFallback: true };
  if (pluginAuth) return { resolveMethod: "plugin" };
  return { allowPluginFallback: false };
}

export async function resolveApproval(input: ResolveApprovalInput): Promise<ResolverResult> {
  const { cfg, accountId, approvalId, decision, senderId, log } = input;
  const execAuth = isExecAuthorizedSender({ cfg, accountId, senderId });
  const pluginAuth = isPluginAuthorizedSender({ cfg, accountId, senderId });
  const method = deriveResolveMethod(approvalId, execAuth, pluginAuth);
  if (!method) {
    log?.info?.(`[DingTalk][Approval] unauthorized sender=${senderId} approvalId=${approvalId}`);
    return { ok: false, reason: "unauthorized" };
  }
  try {
    await resolveApprovalOverGateway({
      cfg, approvalId, decision,
      senderId, clientDisplayName: "DingTalk",
      ...method,
    });
    return { ok: true };
  } catch (err) {
    const code = (err as { gatewayCode?: string } | null)?.gatewayCode;
    if (code === "APPROVAL_NOT_FOUND") return { ok: false, reason: "not-found", error: err };
    if (code === "APPROVAL_ALREADY_RESOLVED") return { ok: false, reason: "already-resolved", error: err };
    if (isInvalidApprovalDecisionError(err)) {
      return {
        ok: false, reason: "invalid-decision", error: err,
        allowedDecisions: extractAllowedDecisions(err),
      };
    }
    log?.warn?.(`[DingTalk][Approval] gateway-error approvalId=${approvalId} err=${(err as Error)?.message}`);
    return { ok: false, reason: "gateway-error", error: err };
  }
}
```

- [ ] **Step 6.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-resolver.test.ts`
Expected: 22 PASS。

- [ ] **Step 6.5: type-check + lint**

Run: `pnpm run type-check && pnpm run lint`
Expected: 0 错误。

- [ ] **Step 6.6: Commit**

```bash
git add src/approval/approval-resolver.ts tests/unit/approval-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-resolver 单点收敛（D20）

按 D21 推导 resolveMethod + allowPluginFallback；调上游 SDK
resolveApprovalOverGateway 公开 API；catch 5 类错误：unauthorized /
already-resolved / not-found / invalid-decision / gateway-error。
isInvalidApprovalDecisionError helper 识别上游 exec/plugin 两种 invalid 形态
（APPROVAL_ALLOW_ALWAYS_UNAVAILABLE / allowedDecisions[]）。

EOF
)"
```

---

## Task 7 · card-run-registry 加 isActiveCardRun + bySession 查询（locator 前置）

**Files:**
- Modify: `src/card/card-run-registry.ts`
- Test: `tests/unit/card-run-registry-approval.test.ts`（新建，避免污染既有大测试）

> 注：PR-1 只加 `isActiveCardRun` + `resolveActiveCardRunBySession`（locator 依赖）；`pendingApprovalId` 字段与 mark/clear API 推迟到 PR-2 的 Task 14 一起加（避免 PR-1 引入未使用的 setter）。

> ⚠️ 实施前必读 Stage 0.A 中的 `registerCardRun` 与 `CardRunRecord` 真实签名：
> - 注册签名：`registerCardRun(outTrackId: string, params: { accountId, sessionKey, agentId, ownerUserId?, card?, registeredAt? })`
> - 字段名：`registeredAt`（**不是** `createdAt`）
> - 既有清理 API：`removeCardRun(outTrackId)` 单个清；`clearCardRunRegistryForTest()` 全清（test-only export，参 `src/card/card-run-registry.ts:165`）

- [ ] **Step 7.1: 写失败测试**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCardRun,
  resolveActiveCardRunBySession,
  isActiveCardRun,
  clearCardRunRegistryForTest,
  type CardRunRecord,
} from "../../src/card/card-run-registry";

const STATE = (s: string) => ({ state: s } as unknown as CardRunRecord["card"]);

const register = (
  outTrackId: string,
  opts: {
    accountId?: string;
    sessionKey: string;
    agentId?: string;
    state?: string;
    registeredAt?: number;
  },
) => {
  registerCardRun(outTrackId, {
    accountId: opts.accountId ?? "default",
    sessionKey: opts.sessionKey,
    agentId: opts.agentId ?? "agent-default",
    card: opts.state ? STATE(opts.state) : undefined,
    registeredAt: opts.registeredAt,
  });
};

describe("card-run-registry · approval helpers", () => {
  beforeEach(() => clearCardRunRegistryForTest());

  it("isActiveCardRun: PROCESSING / INPUTING 返 true", () => {
    const make = (state: string): CardRunRecord =>
      ({
        outTrackId: "o", accountId: "default", sessionKey: "s",
        agentId: "agent", card: STATE(state), registeredAt: Date.now(),
      } as CardRunRecord);
    expect(isActiveCardRun(make("PROCESSING"))).toBe(true);
    expect(isActiveCardRun(make("INPUTING"))).toBe(true);
  });
  it("isActiveCardRun: FINISHED / STOPPED / FAILED 返 false", () => {
    const make = (state: string): CardRunRecord =>
      ({
        outTrackId: "o", accountId: "default", sessionKey: "s",
        agentId: "agent", card: STATE(state), registeredAt: Date.now(),
      } as CardRunRecord);
    for (const s of ["FINISHED", "STOPPED", "FAILED"]) {
      expect(isActiveCardRun(make(s))).toBe(false);
    }
  });
  it("isActiveCardRun: card 为 undefined 返 false", () => {
    expect(isActiveCardRun({
      outTrackId: "o", accountId: "default", sessionKey: "s",
      agentId: "agent", card: undefined, registeredAt: Date.now(),
    } as CardRunRecord)).toBe(false);
  });

  it("resolveActiveCardRunBySession: 匹配 accountId + sessionKey 且 active", () => {
    register("ot1", { sessionKey: "sess-A", state: "INPUTING" });
    expect(resolveActiveCardRunBySession("default", "sess-A")?.outTrackId).toBe("ot1");
  });
  it("resolveActiveCardRunBySession: accountId 不匹配返 null", () => {
    register("ot1", { accountId: "other", sessionKey: "sess-A", state: "INPUTING" });
    expect(resolveActiveCardRunBySession("default", "sess-A")).toBeNull();
  });
  it("resolveActiveCardRunBySession: state 已终止返 null", () => {
    register("ot1", { sessionKey: "sess-A", state: "FINISHED" });
    expect(resolveActiveCardRunBySession("default", "sess-A")).toBeNull();
  });
  it("resolveActiveCardRunBySession: sessionKey 不存在返 null", () => {
    expect(resolveActiveCardRunBySession("default", "no-such")).toBeNull();
  });
  it("resolveActiveCardRunBySession: 多 record 同 sessionKey 返最新 registeredAt", () => {
    register("ot-old", { sessionKey: "sess-A", state: "INPUTING", registeredAt: 1000 });
    register("ot-new", { sessionKey: "sess-A", state: "INPUTING", registeredAt: 2000 });
    expect(resolveActiveCardRunBySession("default", "sess-A")?.outTrackId).toBe("ot-new");
  });
});
```

- [ ] **Step 7.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/card-run-registry-approval.test.ts`
Expected: FAIL（API 未实现）。

- [ ] **Step 7.3: 在 src/card/card-run-registry.ts 加 helper**

在文件末尾追加（或紧贴现有 `resolveCardRun` 之后）：

```typescript
export function isActiveCardRun(record: CardRunRecord): boolean {
  const state = record.card?.state;
  return state === "PROCESSING" || state === "INPUTING";
}

export function resolveActiveCardRunBySession(
  accountId: string,
  sessionKey: string,
): CardRunRecord | null {
  let latest: CardRunRecord | null = null;
  for (const record of records.values()) {
    if (record.accountId !== accountId) continue;
    if (record.sessionKey !== sessionKey) continue;
    if (!isActiveCardRun(record)) continue;
    if (!latest || record.registeredAt > latest.registeredAt) latest = record;
  }
  return latest;
}
```

> `records` 是模块内 Map（参 `src/card/card-run-registry.ts:30`）。`CardRunRecord` 已有 `sessionKey`、`accountId`、`registeredAt`（参 `src/card/card-run-registry.ts:13-25`）。

- [ ] **Step 7.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/card-run-registry-approval.test.ts`
Expected: 8 PASS。

- [ ] **Step 7.5: 跑全部 card-run-registry 相关测试确认无回归**

Run: `pnpm vitest run tests/unit/card-run-registry`
Expected: 全部 PASS（既有 outTrackId 查询、TTL sweep 等不受影响）。

- [ ] **Step 7.6: Commit**

```bash
git add src/card/card-run-registry.ts tests/unit/card-run-registry-approval.test.ts
git commit -m "$(cat <<'EOF'
feat(card-run-registry): 添加 isActiveCardRun + resolveActiveCardRunBySession

为 Gap #01 approval-card-locator 提供按 sessionKey + 活跃 state 查询能力。
不动既有 outTrackId 查询、TTL sweep 行为。pendingApprovalId 字段与
mark/clear API 推迟到 PR-2（D24 主链路落地时一起加）。

EOF
)"
```

---

## Task 8 · approval-card-locator.ts（D22 路由决策）

**Files:**
- Create: `src/approval/approval-card-locator.ts`
- Test: `tests/unit/approval-card-locator.test.ts`

- [ ] **Step 8.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findActiveAgentCard } from "../../src/approval/approval-card-locator";

vi.mock("../../src/card/card-run-registry", () => ({
  resolveActiveCardRunBySession: vi.fn(),
}));
const { resolveActiveCardRunBySession } = await import("../../src/card/card-run-registry");
const mockResolver = resolveActiveCardRunBySession as ReturnType<typeof vi.fn>;

describe("approval-card-locator", () => {
  beforeEach(() => mockResolver.mockReset());

  it("registry 命中 active record → 返 { outTrackId, sessionKey }", () => {
    mockResolver.mockReturnValue({ outTrackId: "ai_card_xxx", sessionKey: "sess-A" });
    expect(findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "sess-A" }))
      .toEqual({ outTrackId: "ai_card_xxx", sessionKey: "sess-A" });
  });

  it("registry 返 null → 返 null（caller 走 markdown 路径）", () => {
    mockResolver.mockReturnValue(null);
    expect(findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "sess-A" })).toBeNull();
  });

  it("sessionKey 为空时返 null（不查 registry）", () => {
    expect(findActiveAgentCard({ cfg: {} as never, accountId: "default", sessionKey: "" })).toBeNull();
    expect(mockResolver).not.toHaveBeenCalled();
  });

  it("accountId 透传到 registry 查询", () => {
    mockResolver.mockReturnValue(null);
    findActiveAgentCard({ cfg: {} as never, accountId: "acme", sessionKey: "s" });
    expect(mockResolver).toHaveBeenCalledWith("acme", "s");
  });

  it("同一卡片已有不同 pendingApprovalId → 返 null（并发审批降级 markdown）", () => {
    mockResolver.mockReturnValue({
      outTrackId: "ai_card_xxx",
      sessionKey: "sess-A",
      pendingApprovalId: "approval-old",
    });
    expect(findActiveAgentCard({
      cfg: {} as never,
      accountId: "default",
      sessionKey: "sess-A",
      approvalId: "approval-new",
    })).toBeNull();
  });

  it("同一卡片 pendingApprovalId 相同 → 仍返 card 路径（同一审批重试幂等）", () => {
    mockResolver.mockReturnValue({
      outTrackId: "ai_card_xxx",
      sessionKey: "sess-A",
      pendingApprovalId: "approval-old",
    });
    expect(findActiveAgentCard({
      cfg: {} as never,
      accountId: "default",
      sessionKey: "sess-A",
      approvalId: "approval-old",
    })).toEqual({ outTrackId: "ai_card_xxx", sessionKey: "sess-A" });
  });
});
```

- [ ] **Step 8.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-card-locator.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 8.3: 实现 src/approval/approval-card-locator.ts**

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveActiveCardRunBySession } from "../card/card-run-registry";

export interface FindActiveAgentCardInput {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  approvalId?: string;
}

export interface ActiveAgentCardLocation {
  outTrackId: string;
  sessionKey: string;
}

export function findActiveAgentCard(input: FindActiveAgentCardInput): ActiveAgentCardLocation | null {
  if (!input.sessionKey) return null;
  const record = resolveActiveCardRunBySession(input.accountId, input.sessionKey);
  if (!record) return null;
  // v1 同一卡片同一时刻只承载一个 pending approval；后续并发审批走 markdown。
  if (record.pendingApprovalId && record.pendingApprovalId !== input.approvalId) return null;
  return { outTrackId: record.outTrackId, sessionKey: record.sessionKey };
}
```

- [ ] **Step 8.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-card-locator.test.ts`
Expected: 6 PASS。

- [ ] **Step 8.5: Commit**

```bash
git add src/approval/approval-card-locator.ts tests/unit/approval-card-locator.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-card-locator（D22 路由决策）

按 sessionKey 查 card-run-registry，仅 active record 返 location；
未命中返 null（caller 走 markdown 路径）。

EOF
)"
```


---

## Task 9 · approval-command-intercept.ts（薄壳：parser + resolver + 5 reason 分支）

**Files:**
- Create: `src/approval/approval-command-intercept.ts`
- Test: `tests/unit/approval-command-intercept.test.ts`

- [ ] **Step 9.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryInterceptApproveCommand } from "../../src/approval/approval-command-intercept";

vi.mock("../../src/approval/approval-resolver", () => ({
  resolveApproval: vi.fn(),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x" })),
}));

const { resolveApproval } = await import("../../src/approval/approval-resolver");
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");
const mockResolve = resolveApproval as ReturnType<typeof vi.fn>;
const mockSend = sendProactiveTextOrMarkdown as ReturnType<typeof vi.fn>;

const base = { cfg: {} as never, accountId: "default", senderId: "staffA", log: undefined as never };

describe("tryInterceptApproveCommand", () => {
  beforeEach(() => { mockResolve.mockReset(); mockSend.mockReset(); mockSend.mockResolvedValue({ ok: true }); });

  it("非 /approve 命令返 false", async () => {
    expect(await tryInterceptApproveCommand({ ...base, text: "hello world" })).toBe(false);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("malformed /approve 返 true 并私聊提示（forceMarkdown）", async () => {
    expect(await tryInterceptApproveCommand({ ...base, text: "/approve abc xyz" })).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), `user:${base.senderId}`,
      expect.stringContaining("格式错误"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("正常命令 → 调 resolver → ok=true 不私聊", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    expect(await tryInterceptApproveCommand({ ...base, text: "/approve abc allow-once" })).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "abc", decision: "allow-once", senderId: "staffA",
    }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("unauthorized → 私聊拒绝（含 approval id + forceMarkdown）", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "unauthorized" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringMatching(/无权.*abc/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("invalid-decision 含 allowedDecisions → 私聊带 allowed 列表", async () => {
    mockResolve.mockResolvedValue({
      ok: false, reason: "invalid-decision",
      allowedDecisions: ["allow-once", "deny"],
    });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc allow-always" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringMatching(/不支持.*allow-once.*deny/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("invalid-decision 无 allowedDecisions → 私聊默认提示", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "invalid-decision" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc allow-always" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringContaining("允许一次或拒绝"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("not-found 私聊轻提示", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "not-found" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringContaining("已处理或已过期"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("already-resolved 私聊轻提示", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "already-resolved" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });
    expect(mockSend).toHaveBeenCalledWith(expect.anything(), "user:staffA",
      expect.stringContaining("已处理或已过期"),
      expect.objectContaining({ forceMarkdown: true }));
  });

  it("gateway-error → 私聊提示稍后重试", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "gateway-error" });
    await tryInterceptApproveCommand({ ...base, text: "/approve abc deny" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringMatching(/暂时处理失败.*稍后重试/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("send 失败不抛", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "unauthorized" });
    mockSend.mockRejectedValueOnce(new Error("net"));
    await expect(tryInterceptApproveCommand({ ...base, text: "/approve abc deny" })).resolves.toBe(true);
  });
});
```

- [ ] **Step 9.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-command-intercept.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 9.3: 实现 src/approval/approval-command-intercept.ts**

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { Logger } from "../types";
import { getConfig } from "../config";
import { sendProactiveTextOrMarkdown } from "../send-service";
import { parseApproveCommand } from "./approval-command-parser";
import { resolveApproval } from "./approval-resolver";

export interface InterceptInput {
  cfg: OpenClawConfig;
  accountId: string;
  text: string;
  senderId: string;
  log?: Logger;
}

const sendDm = async (
  cfg: OpenClawConfig, accountId: string, senderId: string,
  text: string, log?: Logger,
): Promise<void> => {
  await sendProactiveTextOrMarkdown(
    getConfig(cfg, accountId),
    `user:${senderId}`,
    text,
    { forceMarkdown: true, accountId, log },
  ).catch(() => undefined);
};

export async function tryInterceptApproveCommand(input: InterceptInput): Promise<boolean> {
  const trimmed = input.text.trim();
  if (!/^\/?approve(?:\s|$)/i.test(trimmed)) return false;

  const parsed = parseApproveCommand(trimmed);
  if (!parsed) {
    await sendDm(
      input.cfg, input.accountId, input.senderId,
      "⚠️ /approve 命令格式错误。用法：`/approve <approvalId> <allow-once|allow-always|deny>`",
      input.log,
    );
    input.log?.warn?.("[DingTalk][Approval] /approve malformed");
    return true;
  }

  const result = await resolveApproval({
    cfg: input.cfg, accountId: input.accountId,
    approvalId: parsed.approvalId, decision: parsed.decision,
    senderId: input.senderId, log: input.log,
  });

  if (result.ok) {
    input.log?.info?.(`[DingTalk][Approval] /approve resolved approvalId=${parsed.approvalId} decision=${parsed.decision}`);
    return true;
  }

  switch (result.reason) {
    case "unauthorized":
      await sendDm(input.cfg, input.accountId, input.senderId,
        `⛔ 你不在 approver 名单，无权批准此请求（${parsed.approvalId}）`, input.log);
      break;
    case "invalid-decision": {
      const hint = result.allowedDecisions?.length
        ? `请选择：${result.allowedDecisions.join(" / ")}`
        : "请选择允许一次或拒绝";
      await sendDm(input.cfg, input.accountId, input.senderId,
        `ℹ️ 该审批不支持 ${parsed.decision}。${hint}（${parsed.approvalId}）`, input.log);
      break;
    }
    case "not-found":
    case "already-resolved":
      await sendDm(input.cfg, input.accountId, input.senderId,
        `ℹ️ 审批 ${parsed.approvalId} 已处理或已过期，无需再次操作。`, input.log);
      break;
    case "gateway-error":
      await sendDm(input.cfg, input.accountId, input.senderId,
        `ℹ️ 审批 ${parsed.approvalId} 暂时处理失败，请稍后重试。`, input.log);
      break;
  }
  input.log?.info?.(`[DingTalk][Approval] /approve resolver returned ${result.reason}`);
  return true;
}
```

- [ ] **Step 9.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-command-intercept.test.ts`
Expected: 10 PASS。

- [ ] **Step 9.5: Commit**

```bash
git add src/approval/approval-command-intercept.ts tests/unit/approval-command-intercept.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 /approve 命令 early intercept 入口

调 parser + approval-resolver；按 5 reason 分支私聊提示。所有
sendProactiveTextOrMarkdown 调用强制 forceMarkdown:true 避免 messageType=card
配置下被发成卡片（src/send-service.ts:371-393）。gateway-error 也私聊提示稍后重试，避免用户手敲命令后无反馈。

EOF
)"
```

---

## Task 10 · approval-capability.ts（PR-1：装配工厂，不挂 nativeRuntime）

**Files:**
- Create: `src/approval/approval-capability.ts`
- Test: `tests/unit/approval-capability.test.ts`

> PR-2 的 Task 19 会把 `nativeRuntime` 挂上。PR-1 先把工厂装配 + describeExecApprovalSetup 文案做好，channel 就能挂上 capability 触发 authorize 路径。

> **关于 `resolveApproveCommandBehavior` capability hook（有意不实现）：** 上游 `openclaw/src/auto-reply/reply/commands-approve.ts:148-158` 允许 channel capability 通过 `resolveApproveCommandBehavior` 接管命令处理。DingTalk 端**不**实现此 hook —— `/approve` 命令走 channel 自有的 inbound early intercept（Task 11 / D2 / §6.8），目的是绕过 OpenClaw 命令派发链路上的 session lock 死锁。Task 10 故意不传 `resolveApproveCommandBehavior` 字段；如 PR review 提及 telegram peer 有这个回调，回复"DingTalk 走 D2 early intercept 路径，不复用上游 commands-approve 注册系统"。

- [ ] **Step 10.1: 写失败测试**

```typescript
import { describe, it, expect, vi } from "vitest";

// mock 必须对齐 impl 的 import subpath（approval-capability.ts 从
// openclaw/plugin-sdk/approval-delivery-runtime import 工厂；不是根 entry）
vi.mock("openclaw/plugin-sdk/approval-delivery-runtime", () => ({
  createApproverRestrictedNativeApprovalCapability: vi.fn(() => ({ mock: "capability" })),
}));

const { createDingTalkApprovalCapability } = await import("../../src/approval/approval-capability");
const sdk = await import("openclaw/plugin-sdk/approval-delivery-runtime");
const factory = sdk.createApproverRestrictedNativeApprovalCapability as ReturnType<typeof vi.fn>;

describe("createDingTalkApprovalCapability", () => {
  it("装配工厂参数 channel='dingtalk' channelLabel='DingTalk' eventKinds=[exec,plugin]", () => {
    createDingTalkApprovalCapability();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      channel: "dingtalk",
      channelLabel: "DingTalk",
      eventKinds: ["exec", "plugin"],
    }));
  });

  it("notifyOriginWhenDmOnly=false（v1 无 DM 路径）", () => {
    createDingTalkApprovalCapability();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ notifyOriginWhenDmOnly: false }));
  });

  it("requireMatchingTurnSourceChannel=true（v1 origin-only）", () => {
    createDingTalkApprovalCapability();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ requireMatchingTurnSourceChannel: true }));
  });

  it("resolveApproverDmTargets 未传（v1 不实现）", () => {
    createDingTalkApprovalCapability();
    const args = factory.mock.calls[0][0];
    expect(args.resolveApproverDmTargets).toBeUndefined();
  });

  it("nativeRuntime 在 PR-1 未传（PR-2 补）", () => {
    createDingTalkApprovalCapability();
    const args = factory.mock.calls[0][0];
    expect(args.nativeRuntime).toBeUndefined();
  });

  it("describeExecApprovalSetup 返回中文配置指南字符串（含 approvers + commands.ownerAllowFrom + enabled）", () => {
    createDingTalkApprovalCapability();
    const args = factory.mock.calls[0][0];
    const text = args.describeExecApprovalSetup({ cfg: {}, accountId: "default" });
    expect(text).toMatch(/channels\.dingtalk\.execApprovals\.approvers/);
    expect(text).toMatch(/commands\.ownerAllowFrom/);
    expect(text).toMatch(/enabled/);
  });
});
```

- [ ] **Step 10.2: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/approval-capability.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 10.3: 实现 src/approval/approval-capability.ts**

```typescript
import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  getExecApprovalsConfig,
  listExecApprovers,
  isExecAuthorizedSender,
  isPluginAuthorizedSender,
  resolveNativeDeliveryMode,
} from "./approval-config";
import { resolveDingTalkOriginTarget } from "./approval-target-resolver";

const DESCRIBE_TEMPLATE =
  "Configure channels.dingtalk.execApprovals.approvers or commands.ownerAllowFrom; " +
  "leave channels.dingtalk.execApprovals.enabled unset/auto or set it to true.";

export function createDingTalkApprovalCapability(): ChannelApprovalCapability {
  return createApproverRestrictedNativeApprovalCapability({
    channel: "dingtalk",
    channelLabel: "DingTalk",
    listAccountIds: (cfg) => {
      const accounts = cfg.channels?.dingtalk?.accounts ?? {};
      const ids = Object.keys(accounts);
      return ids.length > 0 ? ids : ["default"];
    },
    hasApprovers: ({ cfg, accountId }) =>
      listExecApprovers({ cfg, accountId }).length > 0,
    isExecAuthorizedSender,
    isPluginAuthorizedSender,
    isNativeDeliveryEnabled: (q) => getExecApprovalsConfig(q).isNativeDeliveryEnabled,
    resolveNativeDeliveryMode,
    requireMatchingTurnSourceChannel: true,
    // 直接把 Task 5 上游 helper 装好的 resolver 传进去；接受 ApprovalResolverParams
    // ({ cfg, accountId, request }) → target | null；内部走 input.request.request.* payload
    resolveOriginTarget: resolveDingTalkOriginTarget,
    // resolveApproverDmTargets: v1 不实现
    notifyOriginWhenDmOnly: false,
    // nativeRuntime: PR-2 接上
    describeExecApprovalSetup: (_q: { cfg: OpenClawConfig; accountId: string }) => DESCRIBE_TEMPLATE,
    eventKinds: ["exec", "plugin"],
  });
}
```

- [ ] **Step 10.4: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/approval-capability.test.ts`
Expected: 6 PASS。

- [ ] **Step 10.5: Commit**

```bash
git add src/approval/approval-capability.ts tests/unit/approval-capability.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 装配 ChannelApprovalCapability（PR-1：无 nativeRuntime）

createApproverRestrictedNativeApprovalCapability 工厂调用，16 参数中 v1
需要的全部到位（resolveApproverDmTargets / nativeRuntime / 等 v1 不需要的
留空，PR-2 再补 nativeRuntime）。describeExecApprovalSetup 文案与上游
Slack/Telegram/Discord 三家完全对齐。

EOF
)"
```

---

## Task 11 · channel.ts 挂 approvalCapability + inbound-handler /approve early intercept

**Files:**
- Modify: `src/channel.ts:22-127`
- Modify: `src/inbound-handler.ts:~770`
- Test: `tests/unit/inbound-handler-approve-intercept.test.ts`

- [ ] **Step 11.1: 在 src/channel.ts 挂 approvalCapability**

文件顶部 import：

```typescript
import { createDingTalkApprovalCapability } from "./approval/approval-capability";
```

在 `dingtalkPlugin` 对象字面量内（与现有 `messaging` / `directory` / `gateway` 等字段同级）加：

```typescript
approvalCapability: createDingTalkApprovalCapability(),
```

> 工厂在 module load 时调一次返回单例 capability，与 telegram/slack peer 一致；后续 PR-2 把 `nativeRuntime` 挂上后无需再改 channel.ts。

- [ ] **Step 11.2: 写 inbound-handler intercept 失败测试**

新建 `tests/unit/inbound-handler-approve-intercept.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/approval/approval-command-intercept", () => ({
  tryInterceptApproveCommand: vi.fn(),
}));
const { tryInterceptApproveCommand } = await import("../../src/approval/approval-command-intercept");
const mockIntercept = tryInterceptApproveCommand as ReturnType<typeof vi.fn>;

// 提示：本测试的设计是「在 inbound-handler 真实路径里 mock intercept，断言它被调」。
// 实现 step 11.4 前需要先看 src/inbound-handler.ts 现有测试套件的 mock 套路；
// 推荐复用同名 setup helper（如已有 `tests/unit/fixtures/inbound-handler-fixtures.ts`）。

import { handleDingTalkMessage } from "../../src/inbound-handler";
// 以下伪代码：实施时按现有测试 fixture 重写 setupMessage
declare function setupMessage(opts: { isGroup: boolean; text: string; senderStaffId: string }): {
  invoke: () => Promise<unknown>;
  expectReplyNotDispatched: () => void;
  expectSessionLockNotAcquired: () => void;
};

describe("inbound-handler · /approve early intercept", () => {
  beforeEach(() => { mockIntercept.mockReset(); mockIntercept.mockResolvedValue(false); });

  it("非 /approve 消息走正常路径，不调 intercept", async () => {
    const m = setupMessage({ isGroup: false, text: "hello bot", senderStaffId: "staffA" });
    await m.invoke();
    expect(mockIntercept).not.toHaveBeenCalled();
  });

  it("私聊 /approve 命令调 intercept", async () => {
    mockIntercept.mockResolvedValue(true);
    const m = setupMessage({ isGroup: false, text: "/approve abc deny", senderStaffId: "staffA" });
    await m.invoke();
    expect(mockIntercept).toHaveBeenCalledWith(expect.objectContaining({
      text: "/approve abc deny", senderId: "staffA",
    }));
    m.expectReplyNotDispatched();
    m.expectSessionLockNotAcquired();
  });

  it("群里 @bot /approve 命令：剥前导 @mention 后传给 intercept", async () => {
    mockIntercept.mockResolvedValue(true);
    const m = setupMessage({ isGroup: true, text: "@OpenClaw /approve abc once", senderStaffId: "staffA" });
    await m.invoke();
    expect(mockIntercept).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/^\/approve(?:\s|$)/),
    }));
  });

  it("intercept 返 true → 不进 reply 派发", async () => {
    mockIntercept.mockResolvedValue(true);
    const m = setupMessage({ isGroup: false, text: "/approve abc once", senderStaffId: "staffA" });
    await m.invoke();
    m.expectReplyNotDispatched();
  });

  it("intercept 返 false → 走正常 inbound pipeline", async () => {
    mockIntercept.mockResolvedValue(false);
    const m = setupMessage({ isGroup: false, text: "approve maybe wrong format", senderStaffId: "staffA" });
    await m.invoke();
    // 正常 pipeline 继续，不在此断言；具体行为由其它已有测试覆盖
  });

  it("接受裸 'approve abc once'（无前导 /）", async () => {
    mockIntercept.mockResolvedValue(true);
    const m = setupMessage({ isGroup: false, text: "approve abc once", senderStaffId: "staffA" });
    await m.invoke();
    expect(mockIntercept).toHaveBeenCalled();
  });
});
```

> ⚠️ 实施时第一步先 grep `tests/unit/inbound-handler*` 找现有 fixture/setup 模式（参 `tests/unit/fixtures/` 或既有大测试套件），按那个模式重写 `setupMessage`。本伪代码仅描述断言意图。

- [ ] **Step 11.3: 跑测试确认 fail**

Run: `pnpm vitest run tests/unit/inbound-handler-approve-intercept.test.ts`
Expected: FAIL（intercept 没插入到 handler）。

- [ ] **Step 11.4: 在 src/inbound-handler.ts 插入 intercept 块**

精确插入位置：`L770` sessionPeer 解析之后、`L780` routing 解析之前（参 spec §6.8 + §3.3 接触面表）。

必须满足 4 个前后约束：
- ✓ 晚于 `L575`（extractedContent ready）
- ✓ 晚于 `L671/729`（DM/Group 授权通过）
- ✓ **早于 `L817`**（sub-agent routing 分支，否则 `@agent /approve` 被吞）
- ✓ 早于 `L874`（handleInboundCommandDispatch）
- ✓ 早于 `L2053`（acquireSessionLock，否则 plugin waitDecision 死锁）

**先在文件顶部 import** 区域加静态 import（与既有 approval/* 同级 module，无循环依赖风险）：

```typescript
import { tryInterceptApproveCommand } from "./approval/approval-command-intercept";
```

然后插入 block：

```typescript
// ---- Early /approve bypass：early intercept 绕过 session lock 死锁（D2，§6.8）
{
  const rawApproveText = !isDirect
    ? extractedContent.text.replace(/^(?:@\S+\s+)*/u, "").trim()
    : extractedContent.text.trim();
  if (/^\/?approve(?:\s|$)/i.test(rawApproveText)) {
    const intercepted = await tryInterceptApproveCommand({
      cfg, accountId: account.accountId,
      text: rawApproveText, senderId, log,
    });
    if (intercepted) return; // 不进 reply 派发
  }
}
```

> 变量名 `isDirect` / `extractedContent` / `cfg` / `account` / `senderId` / `log` 都来自既有 handler scope；插入时请按当前 main 实际命名调整（用 `Read` 现场核对 `src/inbound-handler.ts:L760-L820` 周边）。
>
> **不要用 `await import(...)` 动态加载** —— `src/approval/approval-command-intercept.ts` 不会反向依赖 `src/inbound-handler.ts`（intercept 只引 parser / resolver / send-service / config，不引 inbound-handler），无循环依赖。静态 import 更利于 tree-shaking 与 lint 检查。

- [ ] **Step 11.5: 跑测试确认 pass**

Run: `pnpm vitest run tests/unit/inbound-handler-approve-intercept.test.ts`
Expected: 6 PASS。

- [ ] **Step 11.6: 跑全部 inbound 相关测试无回归**

Run: `pnpm vitest run tests/unit/inbound-handler`
Expected: 全部 PASS（既有 dedup / self-filter / routing / dispatch 行为不变）。

- [ ] **Step 11.7: type-check + lint + 全套测试**

Run: `pnpm run type-check && pnpm run lint && pnpm test`
Expected: 0 错误，全部 PASS。

- [ ] **Step 11.8: Commit**

```bash
git add src/channel.ts src/inbound-handler.ts tests/unit/inbound-handler-approve-intercept.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): channel 挂 approvalCapability + inbound /approve early intercept

(1) src/channel.ts plugin 对象加 approvalCapability 字段（PR-2 再接 nativeRuntime）。
(2) src/inbound-handler.ts 在 sessionPeer 解析之后、routing 决策之前插入
    /approve early intercept：剥群里前导 @mention，regex /^\\/?approve(?:\\s|$)/i
    对齐上游 commands-approve.ts:16；命中后调 tryInterceptApproveCommand 并
    return，避免进 reply 派发触发 session lock 死锁（D2 / §6.8）。

EOF
)"
```

---

## PR-1 收尾

- [ ] **Step PR1.1: 跑完整测试套件 + coverage**

```bash
pnpm test
pnpm test:coverage
```

Expected: 所有 unit test PASS；`src/approval/*` line coverage ≥ 90%，branch ≥ 85%。

- [ ] **Step PR1.2: 真机抽检（PR-1 范围）**

仅验证 `/approve` 命令通道生效：在 OpenClaw WebUI/CLI 跑一个需要 approval 的 task，从日志拿 approval id，到钉钉里发 `/approve <id> allow-once` —— 验证：
- approver 名单内用户：上游 store 收到 resolve（OpenClaw 端可见 resolved）
- 非 approver：收到 `⛔ 你不在 approver 名单` 私聊
- 不会触发 session lock 死锁（120s 等待）

可选：在 `skills/dingtalk-real-device-testing/SKILL.md` 列出的 checklist 内勾选 PR-1 范围条目。

- [ ] **Step PR1.3: 开 PR**

```bash
git push -u origin docs/gap-01-approval-native-design
gh pr create --title "feat(approval): PR-1 ChannelApprovalCapability + /approve early intercept" --body "$(cat <<'EOF'
## Summary
- 装配 ChannelApprovalCapability 工厂（D7 approver schema + D20 单点 resolver + D21 kind 推导 + invalid-decision 分类）
- /approve 命令早期 intercept（D2）绕过 session lock 死锁；对齐上游 10 alias × 2 顺序 = 20 合法形式
- approval-card-locator（D22）就位，PR-2 加按钮路径时 0 新增 routing 逻辑

## PR boundaries（参 docs/plans/2026-05-19-gap-01-approval-native.md §PR-1）
- 不含 native runtime 4 子 adapter 实现（PR-2）
- 不含模板 ID 替换（PR-2）
- 不含按钮回调路径（PR-2）

## Test plan
- [x] `pnpm test` 全部 PASS（新增 ~100 case，src/approval 覆盖 ≥ 90%）
- [x] 真机：/approve 命令通道 + 非 approver 拒绝 + session lock 不触发

BREAKING CHANGE: peerDependencies.openclaw bump >= 2026.4.7

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

提示用户做 PR review；PR review 通过 + merge 后再启动 PR-2。


---

# PR-2 · 完整 Native Runtime + 模板替换 + 真机回归

**交付目标：** 完整 v3.3 双路由 UX（card 路径在原 agent reply card 上挂按钮；markdown 路径发独立消息含 `/approve` 模板）；按钮回调通路接通；真机回归 PASS。

**PR-2 任务清单：** Task 12 ~ Task 22。

---

## Task 11b · 抽 `approval-card-state.ts`（cardParamMap 字段集 single source）

**Files:**
- Create: `src/approval/approval-card-state.ts`
- Test: `tests/unit/approval-card-state.test.ts`

**动机：** v3 模板的 3 个 cardParamMap 变量（`show_approve_btns` / `approveId` / `hasAction`）以及 pending / cleared 字段值会被多处引用：`card-service.ts` 的 createAICard 默认值、`approval-card-patcher.ts` 三 patcher、`approval-callback-handler.ts` clearing path、`tests/unit/*` 断言。如果分散写就会出现"模板加字段时漏改"或"字段名拼错没人发现"。集中到一个模块 + 一组常量后，模板字段名改动只在一处发生，所有 caller 自动跟随。

> 这是 PR-1 ↔ PR-2 之间的桥梁 Task：让 PR-2 的 patcher / card-service 修订都基于这一组工具，而不是各自字面量写。同 spec §1.X 单一事实表 1:1 对齐。

- [ ] **Step 11b.1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import {
  APPROVAL_CARD_KEYS,
  buildApprovalPendingCardParams,
  buildApprovalClearedCardParams,
  type ApprovalCardParams,
} from "../../src/approval/approval-card-state";

describe("approval-card-state · APPROVAL_CARD_KEYS 常量", () => {
  it("固化三个 key 名（模板字段名 single source）", () => {
    expect(APPROVAL_CARD_KEYS).toEqual({
      showApproveBtns: "show_approve_btns",
      approveId: "approveId",
      hasAction: "hasAction",
    });
  });
});

describe("buildApprovalPendingCardParams", () => {
  it("PUT pending：show_approve_btns='true' + hasAction='false' + approveId=<id>", () => {
    expect(buildApprovalPendingCardParams("abc123")).toEqual({
      show_approve_btns: "true",
      hasAction: "false",
      approveId: "abc123",
    });
  });
});

describe("buildApprovalClearedCardParams", () => {
  it("cardStillActive=true → hasAction='true'（恢复 stop）", () => {
    expect(buildApprovalClearedCardParams(true)).toEqual({
      show_approve_btns: "false",
      approveId: "",
      hasAction: "true",
    });
  });
  it("cardStillActive=false → hasAction='false'", () => {
    expect(buildApprovalClearedCardParams(false)).toEqual({
      show_approve_btns: "false",
      approveId: "",
      hasAction: "false",
    });
  });
  it("不写终态文字（v1 schema 无字段位，§7.1）", () => {
    const params = buildApprovalClearedCardParams(true);
    expect(params).not.toHaveProperty("status");
    expect(params).not.toHaveProperty("statusFooter");
    expect(params).not.toHaveProperty("approval_status");
  });
});

describe("createAICard 默认值的常量 export", () => {
  it("APPROVAL_CARD_INITIAL 提供 createAICard cardParamMap 用的初始值（show_approve_btns:false + approveId:''）", async () => {
    const { APPROVAL_CARD_INITIAL } = await import("../../src/approval/approval-card-state");
    expect(APPROVAL_CARD_INITIAL).toEqual({
      show_approve_btns: "false",
      approveId: "",
    });
  });
});
```

- [ ] **Step 11b.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-card-state.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 11b.3: 实现 src/approval/approval-card-state.ts**

```typescript
/**
 * v3 卡片模板 approval 相关 cardParamMap 字段集 + 状态转换 helper。
 * 所有 approval 业务模块（patcher / card-service 默认值 / callback handler 清理）
 * 都通过本模块拿字段名与值，避免字面量散落。spec §1.X 单一事实表的代码化身。
 */

export const APPROVAL_CARD_KEYS = {
  /** 控制 approve_btns 按钮组可见性 */
  showApproveBtns: "show_approve_btns",
  /** approval id 主链路载体（绑定到三按钮 params） */
  approveId: "approveId",
  /** 控制 btn_stop（既有 AI Card v2 字段，与 D23 共存策略） */
  hasAction: "hasAction",
} as const;

export type ApprovalCardParams = {
  [APPROVAL_CARD_KEYS.showApproveBtns]: "true" | "false";
  [APPROVAL_CARD_KEYS.approveId]: string;
  [APPROVAL_CARD_KEYS.hasAction]: "true" | "false";
};

/** card-service.createAICard / finalize / stop 路径的初始默认值（仅 2 字段，hasAction 由既有逻辑驱动） */
export const APPROVAL_CARD_INITIAL: { show_approve_btns: "false"; approveId: "" } = {
  show_approve_btns: "false",
  approveId: "",
};

/** pending 状态 → 显示三按钮 + 隐藏 stop + 注入 approvalId */
export function buildApprovalPendingCardParams(approvalId: string): ApprovalCardParams {
  return {
    show_approve_btns: "true",
    hasAction: "false",
    approveId: approvalId,
  };
}

/** resolved / expired 状态 → 隐藏三按钮 + 清 approvalId + hasAction 按 cardStillActive 恢复 stop */
export function buildApprovalClearedCardParams(cardStillActive: boolean): ApprovalCardParams {
  return {
    show_approve_btns: "false",
    approveId: "",
    hasAction: cardStillActive ? "true" : "false",
  };
}
```

- [ ] **Step 11b.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-card-state.test.ts`
Expected: 6 PASS。

- [ ] **Step 11b.5: Commit**

```bash
git add src/approval/approval-card-state.ts tests/unit/approval-card-state.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-card-state（cardParamMap 字段集 single source）

集中 APPROVAL_CARD_KEYS 常量 + APPROVAL_CARD_INITIAL（createAICard 默认值）
+ buildApprovalPendingCardParams + buildApprovalClearedCardParams 两个 builder，
作为 spec §1.X 单一事实表的代码化身。后续 patcher / card-service / callback
handler 全部从本模块拿字段名与值，避免字面量散落 / 模板字段改名漏改。
EOF
)"
```

> **下文 Task 12 / 15 / 17 都改用本模块的常量 + builder**——不再写字面量 `"show_approve_btns": "true"` 等。

---

## Task 12 · v3 模板 ID 替换 + createAICard cardParamMap 默认值修正

**Files:**
- Modify: `src/card/card-template.ts:6`
- Modify: `src/card-service.ts`（createAICard、finalize、stop 三处 cardParamMap）
- Test: `tests/unit/card-service.test.ts`（扩既有）

- [ ] **Step 12.1: 写 createAICard cardParamMap 默认值失败测试**

在 `tests/unit/card-service.test.ts` 加：

```typescript
import { describe, it, expect, vi } from "vitest";
// 沿用既有 test 文件的 mock 套路（http-client / auth / card-callback-service）

describe("createAICard · approval cardParamMap defaults（D24 v3.6 / Task 12）", () => {
  it("createAICard cardParamMap 默认包含 show_approve_btns:'false' + approveId:''", async () => {
    // 沿用既有 createAICard test 的 setup，断言 cardParamMap 包含这两个 KV
    // mock createAndDeliver 拿到调用参数
    const params = await captureCreateAndDeliverParams(/* 既有 helper */);
    expect(params.cardParamMap).toEqual(expect.objectContaining({
      show_approve_btns: "false",
      approveId: "",
    }));
  });

  it("finalize 路径 PUT cardParamMap 包含 show_approve_btns:'false' + approveId:''", async () => {
    // 沿用既有 finalize test setup
    const params = await captureFinalizePutParams();
    expect(params).toEqual(expect.objectContaining({
      show_approve_btns: "false",
      approveId: "",
    }));
  });
});
```

> 伪代码：`captureCreateAndDeliverParams` / `captureFinalizePutParams` 按既有 `tests/unit/card-service*.test.ts` 内的 mock 模式写。

- [ ] **Step 12.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/card-service.test.ts -t "approval cardParamMap defaults"`
Expected: FAIL（字段不存在）。

- [ ] **Step 12.3: 替换 v3 模板 ID**

修改 `src/card/card-template.ts:6-7`：

```typescript
export const BUILTIN_DINGTALK_CARD_TEMPLATE_ID =
  process.env.DINGTALK_CARD_TEMPLATE_ID || "58f73932-fc3b-46ae-8e90-93313e405061.schema";
```

- [ ] **Step 12.4: 在 src/card-service.ts createAICard 加 cardParamMap 默认值**

文件头加 import：

```typescript
import { APPROVAL_CARD_INITIAL } from "./approval/approval-card-state";
```

定位 `src/card-service.ts:802` 附近 `createAICard` 内 cardParamMap 字面量。用 spread 注入：

```typescript
cardParamMap: {
  // ... 既有字段如 hasAction:"true"
  ...APPROVAL_CARD_INITIAL,  // show_approve_btns:"false" + approveId:"" — 见 approval-card-state.ts
},
```

finalize（约 `src/card-service.ts:711-785`）与 stop / 错误兜底路径：在 PUT updateCardVariables 的 params 对象同样 `...APPROVAL_CARD_INITIAL` spread。

> 用常量 import 而不是写字面量——字段名要改时只改 `approval-card-state.ts` 一处（issue 3 设计目标）。

- [ ] **Step 12.5: 跑确认 pass**

Run: `pnpm vitest run tests/unit/card-service.test.ts -t "approval cardParamMap defaults"`
Expected: PASS。

- [ ] **Step 12.6: 跑全部 card-service 测试无回归**

Run: `pnpm vitest run tests/unit/card-service`
Expected: 全部 PASS（既有 streaming / finalize / stop 行为不变）。

- [ ] **Step 12.7: 构建 runtime + 真机抽检**

```bash
pnpm run build:runtime
openclaw gateway restart  # 用户手动跑
```

在钉钉里发一条非 approval 消息，验证 agent reply card 渲染正常 + **不显示 approval 按钮**（show_approve_btns=false 生效）+ btn_stop 正常显示。

> ⚠️ 这一步不可跳过 —— 如果模板 ID 错或者 cardParamMap 默认值缺失，每条 agent reply 都会显示 3 个未绑 approval 的按钮。

- [ ] **Step 12.8: Commit**

```bash
git add src/card/card-template.ts src/card-service.ts tests/unit/card-service.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 替换 AI Card 模板为 v3 + 补 cardParamMap 默认值

(1) src/card/card-template.ts BUILTIN_DINGTALK_CARD_TEMPLATE_ID
    675cde2f-...8b77 (v2) → 58f73932-...05061 (v3, 含 approve_btns/
    show_approve_btns/approveId 三变量)。env DINGTALK_CARD_TEMPLATE_ID
    覆盖能力保留用于开发期测试。
(2) src/card-service.ts createAICard / finalize / stop / 错误兜底路径
    cardParamMap 显式补 show_approve_btns:"false" + approveId:""，避免
    v3 模板默认值导致 agent reply 一上线就显示未绑 approval 的按钮。

真机抽检确认：(a) v3 模板下既有 AI Card 流式行为不变；(b) 非 approval
消息卡片底部不出现 approval 按钮组。

EOF
)"
```

---

## Task 13 · card-callback-service 扩 cardPrivateData 字段（D16 BLOCKER）

**Files:**
- Modify: `src/card-callback-service.ts:6` 起（接口）+ `src/card-callback-service.ts:94-168`（analyzeCardCallback）
- Test: `tests/unit/card-callback-service.test.ts`（扩既有）

> 改动量 ~5 行：interface 加字段 + 函数末尾把已解析的 cardPrivateData 拷到返回值。analyzeCardCallback 内部 L100-110 已在解析三层 embedded JSON，只是没附到返回值。

- [ ] **Step 13.1: 写失败测试**

在 `tests/unit/card-callback-service.test.ts` 加：

```typescript
describe("analyzeCardCallback · cardPrivateData 提取（D16）", () => {
  it("payload 嵌套 cardPrivateData 含 actionIds + params → analysis.cardPrivateData", () => {
    const payload = {
      // 沿用既有 test fixture 的 embedded JSON 嵌套形态
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: ["allow-once"],
          params: { action: "allow-once", approveId: "abc123" },
        },
      }),
      userId: "staffA",
      outTrackId: "ai_card_xxx",
    };
    const result = analyzeCardCallback(payload);
    expect(result.cardPrivateData).toEqual({
      actionIds: ["allow-once"],
      params: { action: "allow-once", approveId: "abc123" },
    });
  });

  it("payload 无 cardPrivateData → analysis.cardPrivateData 为 undefined", () => {
    const result = analyzeCardCallback({ content: "{}", userId: "u", outTrackId: "o" });
    expect(result.cardPrivateData).toBeUndefined();
  });

  it("既有 actionId 抽取行为不变（兼容回归）", () => {
    const payload = {
      content: JSON.stringify({ cardPrivateData: { actionIds: ["feedback_up"] } }),
      userId: "u", outTrackId: "o",
    };
    const result = analyzeCardCallback(payload);
    expect(result.actionId).toBe("feedback_up");
  });
});
```

- [ ] **Step 13.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/card-callback-service.test.ts -t cardPrivateData`
Expected: FAIL（字段未暴露）。

- [ ] **Step 13.3: 修改 CardCallbackAnalysis 接口**

`src/card-callback-service.ts:6` 起的 interface 加：

```typescript
export interface CardCallbackAnalysis {
  // ... 既有字段
  cardPrivateData?: {
    actionIds?: string[];
    params?: Record<string, unknown>;
  };
}
```

- [ ] **Step 13.4: 在 analyzeCardCallback 内附加 cardPrivateData**

定位 `src/card-callback-service.ts:94-168` 中已经把 `cardPrivateData` 解析出的局部变量（参 spec：L100-110 已在解析三层 embedded JSON）。函数 return 之前把该对象附到返回值：

```typescript
return {
  // ... 既有字段
  cardPrivateData: extractedCardPrivateData ?? undefined,
};
```

> 现场用 Read 核对变量名 —— spec 内 §3.3 描述的是「内部已经解析」，实现细节看实际代码。

- [ ] **Step 13.5: 跑确认 pass**

Run: `pnpm vitest run tests/unit/card-callback-service.test.ts`
Expected: 全部 PASS（既有 case + 3 新 case）。

- [ ] **Step 13.6: Commit**

```bash
git add src/card-callback-service.ts tests/unit/card-callback-service.test.ts
git commit -m "$(cat <<'EOF'
feat(card-callback): CardCallbackAnalysis 暴露 cardPrivateData 字段（D16）

analyzeCardCallback 内部已解析 cardPrivateData（actionIds + params），
仅需附到返回 analysis 上。为 Gap #01 approval callback handler 提供
params.action / params.approveId 解码主链路。

既有 actionId 抽取行为完全不变。

EOF
)"
```

---

## Task 14 · card-run-registry 加 pendingApprovalId 字段 + mark/clear API（D24 fallback）

**Files:**
- Modify: `src/card/card-run-registry.ts`
- Test: `tests/unit/card-run-registry-approval.test.ts`（扩 PR-1 已建文件）

> **fallback 语义边界（v3.6 D24 + v4 review issue 4）：**
> - **主事实源永远是 callback payload 的 `cardPrivateData.params.approveId`**（v3 模板将 approveId 绑定到三按钮 params）。正常运行链路从不读 registry。
> - `pendingApprovalId` registry 字段 **只是异常兜底**——应对老卡片（v3 前发的、模板没 approveId 变量）、平台 callback payload 字段丢失等罕见路径。
> - **不是历史审批状态恢复入口**——重启后 registry 是空的，这是**可接受**的行为：用户点旧卡片会走"approveId 反查失败 → applyExpiredPatch → 按钮消失"降级路径（参 spec §6.6 "Channel 重启后用户点旧卡片"）。
> - 这一点必须明确在 commit message + 用户文档里，避免后续维护者把它当成"应该持久化的状态"过度优化。

- [ ] **Step 14.1: 写失败测试**

在 `tests/unit/card-run-registry-approval.test.ts` 加（沿用 Task 7 引入的 `register()` 帮手 + `clearCardRunRegistryForTest()`）：

```typescript
import {
  markCardRunPendingApproval,
  clearCardRunPendingApproval,
  resolveCardRun,
  removeCardRun,
} from "../../src/card/card-run-registry";

describe("card-run-registry · pendingApprovalId（D24 fallback）", () => {
  beforeEach(() => clearCardRunRegistryForTest());

  it("markCardRunPendingApproval 写入 pendingApprovalId", () => {
    register("ot1", { sessionKey: "s1", state: "INPUTING" });
    markCardRunPendingApproval("ot1", "abc123");
    expect(resolveCardRun("ot1")?.pendingApprovalId).toBe("abc123");
  });

  it("clearCardRunPendingApproval 清除 pendingApprovalId", () => {
    register("ot1", { sessionKey: "s1", state: "INPUTING" });
    markCardRunPendingApproval("ot1", "abc123");
    clearCardRunPendingApproval("ot1");
    expect(resolveCardRun("ot1")?.pendingApprovalId).toBeUndefined();
  });

  it("mark on non-existent outTrackId 无副作用（不抛）", () => {
    expect(() => markCardRunPendingApproval("no-such", "abc")).not.toThrow();
  });

  it("clear on non-existent outTrackId 无副作用（不抛）", () => {
    expect(() => clearCardRunPendingApproval("no-such")).not.toThrow();
  });

  it("record 被 removeCardRun（或 TTL sweep）后整条 record 不存在，反查走 null fallback", () => {
    register("ot1", { sessionKey: "s1", state: "INPUTING" });
    markCardRunPendingApproval("ot1", "abc123");
    removeCardRun("ot1");
    expect(resolveCardRun("ot1")).toBeNull();
  });
});
```

- [ ] **Step 14.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/card-run-registry-approval.test.ts -t pendingApprovalId`
Expected: FAIL（API 未实现）。

- [ ] **Step 14.3: 在 src/card/card-run-registry.ts 实现**

`CardRunRecord` 接口加：

```typescript
export interface CardRunRecord {
  // ... 既有字段
  pendingApprovalId?: string;
}
```

模块末尾追加：

```typescript
export function markCardRunPendingApproval(outTrackId: string, approvalId: string): void {
  const r = records.get(outTrackId);
  if (r) r.pendingApprovalId = approvalId;
}

export function clearCardRunPendingApproval(outTrackId: string): void {
  const r = records.get(outTrackId);
  if (r) r.pendingApprovalId = undefined;
}
```

- [ ] **Step 14.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/card-run-registry-approval.test.ts`
Expected: 全部 PASS（PR-1 8 case + 5 新 case ≈ 13）。

- [ ] **Step 14.5: 跑既有 card-run-registry 测试无回归**

Run: `pnpm vitest run tests/unit/card-run-registry`
Expected: 全部 PASS。

- [ ] **Step 14.6: Commit**

```bash
git add src/card/card-run-registry.ts tests/unit/card-run-registry-approval.test.ts
git commit -m "$(cat <<'EOF'
feat(card-run-registry): 添加 pendingApprovalId 字段 + mark/clear API

D24 v3.6 fallback：approveId 主链路通过卡片自带 callback 拿，但 callback
没带（老卡片 / 平台异常）时反查 registry。setter/clearer 对既有 outTrackId
路径无影响；record 被 sweep 时 pendingApprovalId 自然丢失（callback
反查失败时降级为 applyExpiredPatch）。

EOF
)"
```

---

## Task 15 · approval-card-patcher.ts（三 patcher，§1.X 单一事实表）

**Files:**
- Create: `src/approval/approval-card-patcher.ts`
- Test: `tests/unit/approval-card-patcher.test.ts`

- [ ] **Step 15.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// 真实 updateCardVariables 返回 Promise<number>（HTTP status code），失败靠 axios throw
vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn().mockResolvedValue(200),
}));
vi.mock("../../src/card/card-run-registry", () => ({
  markCardRunPendingApproval: vi.fn(),
  clearCardRunPendingApproval: vi.fn(),
}));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));

const { applyPendingPatch, applyResolvedPatch, applyExpiredPatch } = await import("../../src/approval/approval-card-patcher");
const { updateCardVariables } = await import("../../src/card-callback-service");
const { markCardRunPendingApproval, clearCardRunPendingApproval } = await import("../../src/card/card-run-registry");
const mockPut = updateCardVariables as ReturnType<typeof vi.fn>;
const mockMark = markCardRunPendingApproval as ReturnType<typeof vi.fn>;
const mockClear = clearCardRunPendingApproval as ReturnType<typeof vi.fn>;
const TOKEN = "tok-xxx";
const CONFIG = { clientId: "x", bypassProxyForSend: false } as never;

describe("approval-card-patcher · applyPendingPatch", () => {
  beforeEach(() => { mockPut.mockReset().mockResolvedValue(200); mockMark.mockReset(); mockClear.mockReset(); });

  it("PUT 三变量：show_approve_btns='true' + hasAction='false' + approveId=<id>", async () => {
    await applyPendingPatch("ot1", "abc123", TOKEN, CONFIG);
    expect(mockPut).toHaveBeenCalledWith("ot1", expect.objectContaining({
      show_approve_btns: "true", hasAction: "false", approveId: "abc123",
    }), TOKEN, CONFIG);
  });

  it("不 PUT btns/status/statusFooter（v1 字段集严格）", async () => {
    await applyPendingPatch("ot1", "abc123", TOKEN, CONFIG);
    const vars = mockPut.mock.calls[0][1];
    expect(vars).not.toHaveProperty("btns");
    expect(vars).not.toHaveProperty("status");
    expect(vars).not.toHaveProperty("statusFooter");
  });

  it("调 markCardRunPendingApproval(outTrackId, approvalId) 写 fallback", async () => {
    await applyPendingPatch("ot1", "abc123", TOKEN, CONFIG);
    expect(mockMark).toHaveBeenCalledWith("ot1", "abc123");
  });

  it("PUT 失败（axios throw）会向上传播（不静默吞）", async () => {
    const httpErr = Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } });
    mockPut.mockRejectedValueOnce(httpErr);
    await expect(applyPendingPatch("ot1", "abc123", TOKEN, CONFIG)).rejects.toThrow();
  });

  it("调用透传 config（用于 bypassProxyForSend）", async () => {
    await applyPendingPatch("ot1", "abc123", TOKEN, CONFIG);
    expect(mockPut).toHaveBeenCalledWith("ot1", expect.any(Object), TOKEN, CONFIG);
  });
});

describe("approval-card-patcher · applyResolvedPatch", () => {
  beforeEach(() => { mockPut.mockReset().mockResolvedValue(200); mockClear.mockReset(); });

  it("cardStillActive=true → hasAction='true'（恢复 stop）", async () => {
    await applyResolvedPatch("ot1", "allow-once", TOKEN, true, CONFIG);
    expect(mockPut).toHaveBeenCalledWith("ot1", expect.objectContaining({
      show_approve_btns: "false", approveId: "", hasAction: "true",
    }), TOKEN, CONFIG);
  });

  it("cardStillActive=false → hasAction='false'", async () => {
    await applyResolvedPatch("ot1", "deny", TOKEN, false, CONFIG);
    expect(mockPut).toHaveBeenCalledWith("ot1", expect.objectContaining({
      show_approve_btns: "false", approveId: "", hasAction: "false",
    }), TOKEN, CONFIG);
  });

  it("不写终态文字（v1 schema 无字段位，§7.1）", async () => {
    await applyResolvedPatch("ot1", "allow-once", TOKEN, true, CONFIG);
    const vars = mockPut.mock.calls[0][1];
    expect(vars).not.toHaveProperty("status");
    expect(vars).not.toHaveProperty("statusFooter");
    expect(vars).not.toHaveProperty("approval_status");
  });

  it("调 clearCardRunPendingApproval(outTrackId)", async () => {
    await applyResolvedPatch("ot1", "allow-once", TOKEN, true, CONFIG);
    expect(mockClear).toHaveBeenCalledWith("ot1");
  });
});

describe("approval-card-patcher · applyExpiredPatch", () => {
  beforeEach(() => { mockPut.mockReset().mockResolvedValue(200); mockClear.mockReset(); });

  it("字段集与 resolved 完全相同（show_approve_btns='false' + approveId='' + hasAction 按 cardStillActive）", async () => {
    await applyExpiredPatch("ot1", TOKEN, true, CONFIG);
    expect(mockPut).toHaveBeenCalledWith("ot1", expect.objectContaining({
      show_approve_btns: "false", approveId: "", hasAction: "true",
    }), TOKEN, CONFIG);
    await applyExpiredPatch("ot2", TOKEN, false, CONFIG);
    expect(mockPut).toHaveBeenLastCalledWith("ot2", expect.objectContaining({
      show_approve_btns: "false", approveId: "", hasAction: "false",
    }), TOKEN, CONFIG);
  });

  it("不写终态文字", async () => {
    await applyExpiredPatch("ot1", TOKEN, true, CONFIG);
    const vars = mockPut.mock.calls[0][1];
    expect(vars).not.toHaveProperty("status");
  });

  it("调 clearCardRunPendingApproval(outTrackId)", async () => {
    await applyExpiredPatch("ot1", TOKEN, true, CONFIG);
    expect(mockClear).toHaveBeenCalledWith("ot1");
  });
});
```

- [ ] **Step 15.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-card-patcher.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 15.3: 实现 src/approval/approval-card-patcher.ts**

```typescript
import { updateCardVariables } from "../card-callback-service";
import {
  markCardRunPendingApproval,
  clearCardRunPendingApproval,
} from "../card/card-run-registry";
import type { ApprovalDecision, DingTalkConfig } from "../types";
import {
  buildApprovalPendingCardParams,
  buildApprovalClearedCardParams,
} from "./approval-card-state";

// updateCardVariables 返回 Promise<number>（HTTP status），失败靠 axios throw。
// patcher 不再检查 result.ok —— await 成功即成功，error 直接向上传播让 caller 决定（catch 内降级到 markdown）。
// 字段集来源：approval-card-state.ts（spec §1.X 单一事实表的代码化身）

export async function applyPendingPatch(
  outTrackId: string,
  approvalId: string,
  token: string,
  config: DingTalkConfig,
): Promise<void> {
  await updateCardVariables(
    outTrackId,
    buildApprovalPendingCardParams(approvalId),
    token,
    config,
  );
  markCardRunPendingApproval(outTrackId, approvalId);
}

export async function applyResolvedPatch(
  outTrackId: string,
  _decision: ApprovalDecision,
  token: string,
  cardStillActive: boolean,
  config: DingTalkConfig,
): Promise<void> {
  await updateCardVariables(
    outTrackId,
    buildApprovalClearedCardParams(cardStillActive),
    token,
    config,
  );
  clearCardRunPendingApproval(outTrackId);
}

export async function applyExpiredPatch(
  outTrackId: string,
  token: string,
  cardStillActive: boolean,
  config: DingTalkConfig,
): Promise<void> {
  await updateCardVariables(
    outTrackId,
    buildApprovalClearedCardParams(cardStillActive),
    token,
    config,
  );
  clearCardRunPendingApproval(outTrackId);
}
```

- [ ] **Step 15.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-card-patcher.test.ts`
Expected: 14 PASS。

- [ ] **Step 15.5: Commit**

```bash
git add src/approval/approval-card-patcher.ts tests/unit/approval-card-patcher.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-card-patcher（pending/resolved/expired）

三个 patcher 函数 PUT cardParamMap 三变量集，与 spec §1.X 单一事实表 1:1
对齐：pending = show_approve_btns:true + hasAction:false + approveId:<id>；
resolved/expired = show_approve_btns:false + approveId:"" + hasAction 按
cardStillActive 决定。v1 不写终态文字（schema 无字段位，§7.1）。
pending 同时调 markCardRunPendingApproval 写 fallback；resolved/expired
调 clearCardRunPendingApproval 清。

EOF
)"
```


---

## Task 16 · approval-markdown-render.ts（markdown 路径主路径）

**Files:**
- Create: `src/approval/approval-markdown-render.ts`
- Test: `tests/unit/approval-markdown-render.test.ts`

- [ ] **Step 16.1: 写失败测试**

```typescript
import { describe, it, expect } from "vitest";
import {
  buildExecApprovalMarkdown,
  buildPluginApprovalMarkdown,
} from "../../src/approval/approval-markdown-render";

const NOW = Date.parse("2026-05-19T10:00:00Z");

// 真实形态：ExecApprovalRequest = { id, request: payload, createdAtMs, expiresAtMs }
// payload 含 command / cwd / agentId / sessionKey / turnSourceXxx 等（Stage 0.A）
const execRequest = (payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  ({
    id: "abc123",
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + 10 * 60_000,
    request: {
      command: 'docker image prune -a -f --filter "until=720h"',
      cwd: "/Users/zhumin/projects/openclaw",
      ...payload,
    },
    ...overrides,
  }) as never;

const pluginRequest = (payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  ({
    id: "plugin:xyz789",
    createdAtMs: NOW - 1000,
    expiresAtMs: NOW + 10 * 60_000,
    request: {
      toolName: "query_database",
      description: "对 production.orders 表查询近 7 天订单",
      ...payload,
    },
    ...overrides,
  }) as never;

describe("buildExecApprovalMarkdown", () => {
  it("含 approval id", () => {
    expect(buildExecApprovalMarkdown(execRequest(), NOW)).toContain("abc123");
  });
  it("含 command preview（代码块）", () => {
    expect(buildExecApprovalMarkdown(execRequest(), NOW)).toMatch(/```[\s\S]*docker image prune/);
  });
  it("默认（无 allowedDecisions 限制） → 三种 decision 全显示", () => {
    const md = buildExecApprovalMarkdown(execRequest(), NOW);
    expect(md).toContain("/approve abc123 allow-once");
    expect(md).toContain("/approve abc123 allow-always");
    expect(md).toContain("/approve abc123 deny");
  });
  it("ask='always' → resolveExecApprovalRequestAllowedDecisions 返 [allow-once, deny] → 不渲染 allow-always", () => {
    // ask=always 时上游 resolveExecApprovalRequestAllowedDecisions 返 ["allow-once", "deny"]，不含 allow-always
    const md = buildExecApprovalMarkdown(execRequest({ ask: "always" }), NOW);
    expect(md).toContain("/approve abc123 allow-once");
    expect(md).toContain("/approve abc123 deny");
    expect(md).not.toContain("/approve abc123 allow-always");
  });
  it("显式 allowedDecisions=['deny'] → 仅渲染 deny 命令", () => {
    const md = buildExecApprovalMarkdown(execRequest({ allowedDecisions: ["deny"] }), NOW);
    expect(md).toContain("/approve abc123 deny");
    expect(md).not.toContain("/approve abc123 allow-once");
    expect(md).not.toContain("/approve abc123 allow-always");
  });
  it("含过期 hint（分钟）", () => {
    expect(buildExecApprovalMarkdown(execRequest(), NOW)).toMatch(/10\s*分钟/);
  });
});

describe("buildPluginApprovalMarkdown", () => {
  it("含 approval id（plugin: 前缀保留）", () => {
    expect(buildPluginApprovalMarkdown(pluginRequest(), NOW)).toContain("plugin:xyz789");
  });
  it("含 toolName 与 description", () => {
    const md = buildPluginApprovalMarkdown(pluginRequest(), NOW);
    expect(md).toContain("query_database");
    expect(md).toContain("production.orders");
  });
  it("默认（无 allowedDecisions） → 三种 decision 全显示", () => {
    const md = buildPluginApprovalMarkdown(pluginRequest(), NOW);
    expect(md).toContain("/approve plugin:xyz789 allow-once");
    expect(md).toContain("/approve plugin:xyz789 allow-always");
    expect(md).toContain("/approve plugin:xyz789 deny");
  });
  it("显式 allowedDecisions=['allow-once'] → 仅渲染 allow-once", () => {
    const md = buildPluginApprovalMarkdown(pluginRequest({ allowedDecisions: ["allow-once"] }), NOW);
    expect(md).toContain("/approve plugin:xyz789 allow-once");
    expect(md).not.toContain("/approve plugin:xyz789 allow-always");
    expect(md).not.toContain("/approve plugin:xyz789 deny");
  });
  it("过期时间为 0 / 负数时不显示分钟数（边界）", () => {
    const md = buildPluginApprovalMarkdown(pluginRequest({}, { expiresAtMs: NOW - 1000 }), NOW);
    expect(md).not.toMatch(/-?\d+\s*分钟/);
  });
});
```

- [ ] **Step 16.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-markdown-render.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 16.3: 实现 src/approval/approval-markdown-render.ts**

```typescript
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ApprovalDecision } from "../types";

const ALL_DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "批准（仅一次）",
  "allow-always": "批准（总是）",
  "deny": "拒绝",
};

function formatExpireHint(expiresAtMs: number | undefined, nowMs: number): string {
  if (!expiresAtMs || expiresAtMs <= nowMs) return "";
  const minutes = Math.round((expiresAtMs - nowMs) / 60_000);
  return minutes > 0 ? `\n**过期时间**: ${minutes} 分钟` : "";
}

// 本地 plugin allowedDecisions 归一化 —— 上游 resolvePluginApprovalRequestAllowedDecisions
// 定义在 openclaw/src/infra/plugin-approvals.ts:54-69，但**未**从 openclaw/plugin-sdk/approval-runtime
// re-export（核实：approval-runtime.ts 只 re-export exec 版本，没有 plugin 版本）。
// 跨进程引用 infra/* internal 文件不可取，所以 channel 内自实现轻量 helper，与上游 :54-69 的语义对齐：
//   - 有显式 allowedDecisions 且非空 → 过滤合法值返回
//   - 否则返三种全允
// 若将来上游公开 plugin 版本，直接替换为 SDK import + 删本 helper。
function normalizePluginAllowedDecisions(
  allowedDecisions?: readonly (ApprovalDecision | string)[] | null,
): readonly ApprovalDecision[] {
  if (!Array.isArray(allowedDecisions)) return ALL_DECISIONS;
  const filtered = allowedDecisions.filter(
    (d): d is ApprovalDecision => (ALL_DECISIONS as readonly string[]).includes(d as string),
  );
  return filtered.length > 0 ? filtered : ALL_DECISIONS;
}

// 用上游 resolve 出的 allowed 列表生成命令模板——不渲染上游会拒的 decision
function decisionBlock(id: string, allowed: readonly ApprovalDecision[]): string {
  return allowed
    .map((d) => `${DECISION_LABEL[d]}：\`/approve ${id} ${d}\``)
    .join("\n");
}

export function buildExecApprovalMarkdown(request: ExecApprovalRequest, nowMs: number): string {
  const id = request.id;
  const payload = request.request;
  const cmd = payload?.command ?? "(no command)";
  const cwd = payload?.cwd;
  const cwdLine = cwd ? `\n**cwd**: \`${cwd}\`` : "";
  // 上游公开 helper：同时考虑 ask + 显式 allowedDecisions（显式优先）
  // 参 openclaw/src/infra/exec-approvals.ts:1251-1262
  const allowed = resolveExecApprovalRequestAllowedDecisions({
    ask: payload?.ask ?? null,
    allowedDecisions: payload?.allowedDecisions,
  });
  return [
    "### ⚠️ 需要审批：命令执行",
    `**ID**: \`${id}\`${cwdLine}${formatExpireHint(request.expiresAtMs, nowMs)}`,
    "",
    "```",
    cmd,
    "```",
    "",
    decisionBlock(id, allowed),
  ].join("\n");
}

export function buildPluginApprovalMarkdown(request: PluginApprovalRequest, nowMs: number): string {
  const id = request.id;
  const payload = request.request;
  const tool = payload?.toolName ?? "(unknown tool)";
  // PluginApprovalRequestPayload 字段是 description（不是 toolDescription，参 Stage 0.A）
  const desc = payload?.description ?? "";
  // 本地 helper（上游 resolvePluginApprovalRequestAllowedDecisions 定义在
  // openclaw/src/infra/plugin-approvals.ts:54-69 但未从 plugin-sdk 公开）
  const allowed = normalizePluginAllowedDecisions(payload?.allowedDecisions);
  return [
    "### ⚠️ 需要审批：插件调用",
    `**ID**: \`${id}\`\n**Tool**: \`${tool}\`${formatExpireHint(request.expiresAtMs, nowMs)}`,
    desc ? `\n${desc}` : "",
    "",
    decisionBlock(id, allowed),
  ].join("\n");
}
```

- [ ] **Step 16.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-markdown-render.test.ts`
Expected: 11 PASS（含 ask=always + 显式 allowedDecisions 两个新 case）。

- [ ] **Step 16.5: Commit**

```bash
git add src/approval/approval-markdown-render.ts tests/unit/approval-markdown-render.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 approval-markdown-render（markdown 路径主路径）

buildExec/PluginApprovalMarkdown 构造含 approval id、命令/工具 preview、
过期 hint、三种 decision 的 /approve 复制即用模板的 markdown 文本。
markdown 路径是主路径（D10 修订），非 fallback。

EOF
)"
```

---

## Task 17 · approval-callback-handler.ts（TOPIC_CARD 入口 → resolver → patcher）

**Files:**
- Create: `src/approval/approval-callback-handler.ts`
- Test: `tests/unit/approval-callback-handler.test.ts`

- [ ] **Step 17.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/approval/approval-resolver", () => ({ resolveApproval: vi.fn() }));
vi.mock("../../src/approval/approval-card-patcher", () => ({
  applyResolvedPatch: vi.fn().mockResolvedValue(undefined),
  applyExpiredPatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/card/card-run-registry", () => ({
  resolveCardRun: vi.fn(),
  isActiveCardRun: vi.fn(() => true),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("tok-xxx"),
}));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));

const { tryHandleApprovalCallback } = await import("../../src/approval/approval-callback-handler");
const { resolveApproval } = await import("../../src/approval/approval-resolver");
const { applyResolvedPatch, applyExpiredPatch } = await import("../../src/approval/approval-card-patcher");
const { resolveCardRun } = await import("../../src/card/card-run-registry");
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");

const mockResolve = resolveApproval as ReturnType<typeof vi.fn>;
const mockApplyResolved = applyResolvedPatch as ReturnType<typeof vi.fn>;
const mockApplyExpired = applyExpiredPatch as ReturnType<typeof vi.fn>;
const mockResolveCard = resolveCardRun as ReturnType<typeof vi.fn>;
const mockSend = sendProactiveTextOrMarkdown as ReturnType<typeof vi.fn>;

const analysis = (overrides: Record<string, unknown> = {}) => ({
  actionId: "allow-once",
  userId: "staffA",
  outTrackId: "ai_card_xxx",
  cardPrivateData: {
    actionIds: ["allow-once"],
    params: { action: "allow-once", approveId: "abc123" },
  },
  ...overrides,
}) as never;

const base = { cfg: {} as never, accountId: "default", log: undefined as never };

describe("tryHandleApprovalCallback · 主链路解码", () => {
  beforeEach(() => {
    mockResolve.mockReset(); mockApplyResolved.mockReset(); mockApplyExpired.mockReset();
    mockResolveCard.mockReset(); mockSend.mockReset();
  });

  it("非 approval actionId 返 { handled: false }", async () => {
    const r = await tryHandleApprovalCallback({ ...base, analysis: analysis({ cardPrivateData: undefined, actionId: "feedback_up" }) });
    expect(r.handled).toBe(false);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("主链路从 params.action 取 decision + params.approveId 取 approvalId", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "abc123", decision: "allow-once", senderId: "staffA",
    }));
  });

  it("fallback：params.approveId 缺失时反查 resolveCardRun(outTrackId).pendingApprovalId", async () => {
    mockResolveCard.mockReturnValue({ pendingApprovalId: "from-registry" });
    mockResolve.mockResolvedValue({ ok: true });
    const a = analysis({ cardPrivateData: { actionIds: ["allow-once"], params: { action: "allow-once" } } });
    await tryHandleApprovalCallback({ ...base, analysis: a });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "from-registry" }));
  });

  it("fallback：主链路缺失且 registry 也无 → 调 applyExpiredPatch 且 return", async () => {
    mockResolveCard.mockReturnValue(null);
    const a = analysis({ cardPrivateData: { actionIds: ["allow-once"], params: { action: "allow-once" } } });
    const r = await tryHandleApprovalCallback({ ...base, analysis: a });
    expect(mockApplyExpired).toHaveBeenCalledWith(
      "ai_card_xxx", "tok-xxx", expect.any(Boolean),
      expect.objectContaining({ clientId: "x" }),
    );
    expect(mockResolve).not.toHaveBeenCalled();
    expect(r.handled).toBe(true);
  });

  it("泛用 actionId fallback 但无 approvalId → 不接管，避免吞其它卡片按钮", async () => {
    mockResolveCard.mockReturnValue(null);
    const a = analysis({ cardPrivateData: { actionIds: ["deny"], params: {} } });
    const r = await tryHandleApprovalCallback({ ...base, analysis: a });
    expect(r).toEqual({ handled: false });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("decision fallback：params.action 缺失但 actionIds[0]∈ALLOWED → 用 actionId 推 decision", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    const a = analysis({ cardPrivateData: { actionIds: ["deny"], params: { approveId: "abc" } } });
    await tryHandleApprovalCallback({ ...base, analysis: a });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny" }));
  });

  it("非 ALLOWED 的 actionId → 返 { handled: false }（让位 feedback / btn_stop）", async () => {
    const a = analysis({ actionId: "btn_stop", cardPrivateData: { actionIds: ["btn_stop"], params: {} } });
    expect((await tryHandleApprovalCallback({ ...base, analysis: a })).handled).toBe(false);
  });
});

describe("tryHandleApprovalCallback · 5 reason 分支", () => {
  beforeEach(() => {
    mockResolve.mockReset(); mockApplyResolved.mockReset(); mockApplyExpired.mockReset();
    mockSend.mockReset().mockResolvedValue({ ok: true });
  });

  it("ok=true → 调 applyResolvedPatch（三变量），不私聊", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockApplyResolved).toHaveBeenCalledWith(
      "ai_card_xxx", "allow-once", "tok-xxx", expect.any(Boolean),
      expect.objectContaining({ clientId: "x" }),
    );
    expect(mockApplyExpired).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("unauthorized → 私聊 forceMarkdown + 卡片不变", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "unauthorized" });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringContaining("无权"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });

  it("invalid-decision → 不调 patcher，私聊重选提示（含 allowedDecisions）", async () => {
    mockResolve.mockResolvedValue({
      ok: false, reason: "invalid-decision",
      allowedDecisions: ["allow-once", "deny"],
    });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockApplyExpired).not.toHaveBeenCalled();
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringMatching(/不支持.*allow-once.*deny/),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("already-resolved → applyExpiredPatch（兜底）", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "already-resolved" });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockApplyExpired).toHaveBeenCalled();
  });

  it("not-found → applyExpiredPatch", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "not-found" });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockApplyExpired).toHaveBeenCalled();
  });

  it("gateway-error → 私聊提示重试 + 卡片保持 pending", async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: "gateway-error" });
    await tryHandleApprovalCallback({ ...base, analysis: analysis() });
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(), "user:staffA",
      expect.stringContaining("稍后重试"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockApplyExpired).not.toHaveBeenCalled();
    expect(mockApplyResolved).not.toHaveBeenCalled();
  });

  it("patcher 抛错被 catch（callback 已 ack）", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    mockApplyResolved.mockRejectedValueOnce(new Error("PUT failed"));
    await expect(tryHandleApprovalCallback({ ...base, analysis: analysis() })).resolves.toEqual(
      expect.objectContaining({ handled: true }),
    );
  });

  it("DingTalk token 获取失败不阻塞上游审批 resolve", async () => {
    mockResolve.mockResolvedValue({ ok: true });
    mockGetAccessToken.mockRejectedValueOnce(new Error("token unavailable"));
    await expect(tryHandleApprovalCallback({ ...base, analysis: analysis() })).resolves.toEqual(
      { handled: true, reason: "resolved" },
    );
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "abc123", decision: "allow-once" }),
    );
    expect(mockApplyResolved).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 17.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-callback-handler.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 17.3: 实现 src/approval/approval-callback-handler.ts**

```typescript
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { Logger } from "../types";
import type { CardCallbackAnalysis } from "../card-callback-service";
import type { ApprovalDecision } from "../types";
import { getConfig } from "../config";
import { getAccessToken } from "../auth";
import { sendProactiveTextOrMarkdown } from "../send-service";
import { resolveApproval } from "./approval-resolver";
import {
  applyResolvedPatch,
  applyExpiredPatch,
} from "./approval-card-patcher";
import {
  resolveCardRun,
  isActiveCardRun,
} from "../card/card-run-registry";

const ALLOWED_DECISIONS: ReadonlyArray<ApprovalDecision> = ["allow-once", "allow-always", "deny"];

export interface HandleCallbackInput {
  cfg: OpenClawConfig;
  accountId: string;
  analysis: CardCallbackAnalysis;
  log?: Logger;
}

export interface HandleCallbackResult {
  handled: boolean;
  reason?: string;
}

function parseDecision(analysis: CardCallbackAnalysis): ApprovalDecision | null {
  const cpd = analysis.cardPrivateData;
  const fromParams = typeof cpd?.params?.action === "string" ? cpd.params.action : null;
  if (fromParams && (ALLOWED_DECISIONS as readonly string[]).includes(fromParams)) {
    return fromParams as ApprovalDecision;
  }
  const fromActionId =
    (Array.isArray(cpd?.actionIds) && typeof cpd.actionIds[0] === "string")
      ? cpd.actionIds[0]
      : (typeof analysis.actionId === "string" ? analysis.actionId : null);
  if (fromActionId && (ALLOWED_DECISIONS as readonly string[]).includes(fromActionId)) {
    return fromActionId as ApprovalDecision;
  }
  return null;
}

/**
 * 解出 approvalId。
 * **主事实源**：callback payload 的 `cardPrivateData.params.approveId`（v3 模板将 approveId 绑定到三按钮 params）。
 * **fallback**：registry `pendingApprovalId` 只在主事实源缺失时反查——属于异常兜底（老卡片 / 平台 payload 字段丢失等），
 * 不是历史审批状态恢复入口；registry 是进程内 Map，重启 / 多 worker / TTL sweep 都会让 fallback miss，这是可接受行为
 * （miss 时 caller 会走 applyExpiredPatch 让按钮消失，参 spec §6.6）。
 */
function resolveApprovalId(analysis: CardCallbackAnalysis): string | null {
  // 主链路 —— 正常运行从这里返回
  const fromParams = analysis.cardPrivateData?.params?.approveId;
  if (typeof fromParams === "string" && fromParams.length > 0) return fromParams;
  // Fallback —— 异常情况才走（老卡片 / 平台异常）
  const run = analysis.outTrackId ? resolveCardRun(analysis.outTrackId) : null;
  return run?.pendingApprovalId ?? null;
}

async function privateDmReject(
  cfg: OpenClawConfig, accountId: string, userId: string,
  text: string, log?: Logger,
): Promise<void> {
  await sendProactiveTextOrMarkdown(
    getConfig(cfg, accountId), `user:${userId}`, text,
    { forceMarkdown: true, accountId, log },
  ).catch(() => undefined);
}

async function patchCardBestEffort(
  dtConfig: ReturnType<typeof getConfig>,
  log: Logger | undefined,
  patch: (token: string) => Promise<void>,
): Promise<void> {
  try {
    const token = await getAccessToken(dtConfig, log);
    await patch(token);
  } catch (err) {
    log?.warn?.(`[DingTalk][Approval] card patch skipped: ${String(err)}`);
  }
}

export async function tryHandleApprovalCallback(
  input: HandleCallbackInput,
): Promise<HandleCallbackResult> {
  const { cfg, accountId, analysis, log } = input;
  const decision = parseDecision(analysis);
  if (!decision) return { handled: false };
  if (!analysis.outTrackId) return { handled: false };

  const dtConfig = getConfig(cfg, accountId);
  const cardRun = resolveCardRun(analysis.outTrackId);
  const cardStillActive = cardRun ? isActiveCardRun(cardRun) : false;

  const approvalId = resolveApprovalId(analysis);
  if (!approvalId) {
    if (!ALLOWED_DECISIONS.includes(analysis.cardPrivateData?.params?.action as ApprovalDecision)) {
      // 没有 params.action 主链路、没有 approveId/fallback 时，可能只是其它卡片用了 deny 这类泛用 actionId。
      return { handled: false };
    }
    await patchCardBestEffort(dtConfig, log, (token) =>
      applyExpiredPatch(analysis.outTrackId, token, cardStillActive, dtConfig));
    return { handled: true, reason: "no-pending-approval" };
  }

  const result = await resolveApproval({
    cfg, accountId, approvalId, decision,
    senderId: analysis.userId ?? "",
    log,
  });

  if (result.ok) {
    await patchCardBestEffort(dtConfig, log, (token) =>
      applyResolvedPatch(analysis.outTrackId, decision, token, cardStillActive, dtConfig));
    return { handled: true, reason: "resolved" };
  }

  switch (result.reason) {
    case "unauthorized":
      await privateDmReject(cfg, accountId, analysis.userId ?? "",
        `⛔ 你不在 approver 名单，无权批准此请求（${approvalId}）`, log);
      return { handled: true, reason: "unauthorized" };
    case "invalid-decision": {
      const hint = result.allowedDecisions?.length
        ? `请选择：${result.allowedDecisions.join(" / ")}`
        : "请选择允许一次或拒绝";
      await privateDmReject(cfg, accountId, analysis.userId ?? "",
        `ℹ️ 该审批不支持 ${decision}。${hint}（${approvalId}）`, log);
      return { handled: true, reason: "invalid-decision" };
    }
    case "gateway-error":
      await privateDmReject(cfg, accountId, analysis.userId ?? "",
        `ℹ️ 审批暂时处理失败，请稍后重试（${approvalId}）`, log);
      return { handled: true, reason: "gateway-error" };
    case "already-resolved":
    case "not-found":
      await patchCardBestEffort(dtConfig, log, (token) =>
        applyExpiredPatch(analysis.outTrackId, token, cardStillActive, dtConfig));
      return { handled: true, reason: result.reason };
  }
}
```

- [ ] **Step 17.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-callback-handler.test.ts`
Expected: 13 PASS。

- [ ] **Step 17.5: Commit**

```bash
git add src/approval/approval-callback-handler.ts tests/unit/approval-callback-handler.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 添加 TOPIC_CARD callback handler

主链路 params.action / params.approveId + fallback actionIds[0] / registry
pendingApprovalId；调 approval-resolver 单点；按 5 reason 分支：
- ok → applyResolvedPatch
- unauthorized → 私聊 + 卡片保留
- invalid-decision → 私聊重选 + 卡片保 pending（不调 patcher）
  - already-resolved/not-found → applyExpiredPatch
  - gateway-error → 私聊提示稍后重试 + 卡片保 pending（不调 patcher）
所有私聊强制 forceMarkdown:true。patcher 失败被 catch 不影响 ack。

EOF
)"
```

---

## Task 18 · approval-native-runtime.ts（4 子 adapter）

**Files:**
- Create: `src/approval/approval-native-runtime.ts`
- Test: `tests/unit/approval-native-runtime.test.ts`

> 上游契约：`openclaw/src/infra/approval-handler-runtime-types.ts:216-235` ChannelApprovalNativeRuntimeAdapter（3 必需 + 2 可选）。v1 实现 availability/presentation/transport/observe 4 个；interactions 推迟 v2。
> **不用 `createLazyChannelApprovalNativeRuntimeAdapter`**——该 lazy 包装只接受 `{ load, isConfigured, shouldHandle, eventKinds?, resolveApprovalKind? }`，不能把 availability/presentation/transport 塞进同一对象（参 Stage 0.A）。直接 `return { eventKinds, availability, presentation, transport, observe }` 即满足 `ChannelApprovalNativeRuntimeAdapter` 类型。

- [ ] **Step 18.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/approval/approval-config", () => ({
  getExecApprovalsConfig: vi.fn(),
  listExecApprovers: vi.fn(),
  resolveNativeDeliveryMode: vi.fn(() => "channel"),
}));
vi.mock("../../src/approval/approval-card-locator", () => ({
  findActiveAgentCard: vi.fn(),
}));
vi.mock("../../src/approval/approval-card-patcher", () => ({
  applyPendingPatch: vi.fn().mockResolvedValue(undefined),
  applyResolvedPatch: vi.fn().mockResolvedValue(undefined),
  applyExpiredPatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/approval/approval-markdown-render", () => ({
  buildExecApprovalMarkdown: vi.fn(() => "exec-md"),
  buildPluginApprovalMarkdown: vi.fn(() => "plugin-md"),
}));
vi.mock("../../src/approval/approval-target-resolver", () => ({
  normalizeApprovalTargetTo: vi.fn((s: string) => s),
}));
vi.mock("../../src/card/card-run-registry", () => ({
  resolveCardRun: vi.fn(),
  isActiveCardRun: vi.fn(() => false),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
// getAccessToken 真实签名 (config: DingTalkConfig, log?: Logger) → Promise<string>
vi.mock("../../src/auth", () => ({ getAccessToken: vi.fn().mockResolvedValue("tok") }));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));
vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn(() => undefined),
}));

const { createDingTalkApprovalNativeRuntime } = await import("../../src/approval/approval-native-runtime");
const { getExecApprovalsConfig, listExecApprovers } = await import("../../src/approval/approval-config");
const { findActiveAgentCard } = await import("../../src/approval/approval-card-locator");
const { applyPendingPatch } = await import("../../src/approval/approval-card-patcher");
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");

const mockGetCfg = getExecApprovalsConfig as ReturnType<typeof vi.fn>;
const mockListApprovers = listExecApprovers as ReturnType<typeof vi.fn>;
const mockFind = findActiveAgentCard as ReturnType<typeof vi.fn>;
const mockPending = applyPendingPatch as ReturnType<typeof vi.fn>;
const mockSend = sendProactiveTextOrMarkdown as ReturnType<typeof vi.fn>;

const runtime = createDingTalkApprovalNativeRuntime();

// 真实 ApprovalRequest 形态：turnSourceXxx / sessionKey 嵌在 request.request.* payload
const baseRequest = (payload: Record<string, unknown> = {}) => ({
  id: "abc123",
  createdAtMs: Date.now() - 1000,
  expiresAtMs: Date.now() + 600_000,
  request: {
    sessionKey: "sess-A",
    turnSourceChannel: "dingtalk",
    turnSourceTo: "group:cid_xxx",
    turnSourceAccountId: "default",
    turnSourceThreadId: null,
    ...payload,
  },
}) as never;

describe("availability", () => {
  beforeEach(() => { mockGetCfg.mockReset(); mockListApprovers.mockReset(); });

  it("isConfigured 透传 getExecApprovalsConfig().isNativeDeliveryEnabled", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: true });
    expect(runtime.availability.isConfigured({ cfg: {} as never, accountId: "default" })).toBe(true);
  });

  it("shouldHandle 四连判：dingtalk turn source + 可解析 to + 非空 approvers + isConfigured", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: true });
    mockListApprovers.mockReturnValue(["staffA"]);
    expect(runtime.availability.shouldHandle({
      cfg: {} as never, accountId: "default", request: baseRequest(),
    })).toBe(true);
  });

  it("shouldHandle: turnSourceChannel != dingtalk 返 false", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: true });
    mockListApprovers.mockReturnValue(["staffA"]);
    expect(runtime.availability.shouldHandle({
      cfg: {} as never, accountId: "default",
      request: baseRequest({ turnSourceChannel: "discord" }),
    })).toBe(false);
  });

  it("shouldHandle: turnSourceTo 为空返 false", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: true });
    mockListApprovers.mockReturnValue(["staffA"]);
    expect(runtime.availability.shouldHandle({
      cfg: {} as never, accountId: "default",
      request: baseRequest({ turnSourceTo: null }),
    })).toBe(false);
  });

  it("shouldHandle: 无 approvers 返 false", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: true });
    mockListApprovers.mockReturnValue([]);
    expect(runtime.availability.shouldHandle({
      cfg: {} as never, accountId: "default", request: baseRequest(),
    })).toBe(false);
  });

  it("shouldHandle: isConfigured=false 返 false", () => {
    mockGetCfg.mockReturnValue({ isNativeDeliveryEnabled: false });
    mockListApprovers.mockReturnValue(["staffA"]);
    expect(runtime.availability.shouldHandle({
      cfg: {} as never, accountId: "default", request: baseRequest(),
    })).toBe(false);
  });
});

describe("transport.prepareTarget", () => {
  beforeEach(() => mockFind.mockReset());

  // prepareTarget 真实参数：{ cfg, accountId, plannedTarget, request, approvalKind, view, pendingPayload }
  // plannedTarget shape = { surface, target, reason }（不含 cfg）

  it("找到 active card → route=card + activeCardOutTrackId", () => {
    mockFind.mockReturnValue({ outTrackId: "ai_card_xxx", sessionKey: "sess-A" });
    const t = runtime.transport.prepareTarget({
      cfg: {} as never, accountId: "default",
      plannedTarget: { surface: "channel", target: { to: "group:cid_xxx" }, reason: "preferred" },
      request: baseRequest(),
      approvalKind: "exec",
    } as never);
    expect(t).toEqual(expect.objectContaining({
      route: "card", activeCardOutTrackId: "ai_card_xxx",
      target: expect.objectContaining({ to: "group:cid_xxx" }),
    }));
  });

  it("未找到 active card → route=markdown", () => {
    mockFind.mockReturnValue(null);
    const t = runtime.transport.prepareTarget({
      cfg: {} as never, accountId: "default",
      plannedTarget: { surface: "channel", target: { to: "group:cid_xxx" }, reason: "preferred" },
      request: baseRequest(),
      approvalKind: "exec",
    } as never);
    expect(t.route).toBe("markdown");
    expect(t).not.toHaveProperty("activeCardOutTrackId");
  });

  it("dedupeKey 含 accountId + to + outTrackId（card 路径，target.accountId 优先于 params.accountId）", () => {
    mockFind.mockReturnValue({ outTrackId: "ot1", sessionKey: "s1" });
    const t = runtime.transport.prepareTarget({
      cfg: {} as never, accountId: "default",
      plannedTarget: { surface: "channel", target: { to: "group:c", accountId: "acme" }, reason: "preferred" },
      request: baseRequest(),
      approvalKind: "exec",
    } as never);
    expect(t.dedupeKey).toContain("acme");
    expect(t.dedupeKey).toContain("ot1");
  });

  it("target.accountId 缺失时 fallback 到 params.accountId", () => {
    mockFind.mockReturnValue(null);
    const t = runtime.transport.prepareTarget({
      cfg: {} as never, accountId: "acme",
      plannedTarget: { surface: "channel", target: { to: "group:c" }, reason: "preferred" },
      request: baseRequest(),
      approvalKind: "exec",
    } as never);
    expect(t.dedupeKey).toContain("acme");
  });
});

describe("transport.deliverPending", () => {
  beforeEach(() => { mockPending.mockReset().mockResolvedValue(undefined); mockSend.mockReset().mockResolvedValue({ ok: true }); });

  it("route=card 成功 → entry.mode=card + outTrackId", async () => {
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never, accountId: "default",
      preparedTarget: { route: "card", activeCardOutTrackId: "ot1", target: { to: "group:c" } },
      request: baseRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(mockPending).toHaveBeenCalledWith("ot1", "abc", "tok", expect.objectContaining({ clientId: "x" }));
    expect(entry).toEqual(expect.objectContaining({ mode: "card", outTrackId: "ot1", approvalId: "abc" }));
  });

  it("route=card 明确失败 → 降级 markdown，entry.mode=markdown", async () => {
    mockPending.mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400 }));
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never, accountId: "default",
      preparedTarget: { route: "card", activeCardOutTrackId: "ot1", target: { to: "group:c" } },
      request: baseRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(mockSend).toHaveBeenCalledWith(expect.anything(), "group:c", "md", expect.objectContaining({ forceMarkdown: true }));
    expect(entry?.mode).toBe("markdown");
  });

  it("route=card 模糊失败（超时）→ 返 null（不重发）", async () => {
    mockPending.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never, accountId: "default",
      preparedTarget: { route: "card", activeCardOutTrackId: "ot1", target: { to: "group:c" } },
      request: baseRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(entry).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("route=markdown 走 sendProactiveTextOrMarkdown(forceMarkdown:true)", async () => {
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never, accountId: "default",
      preparedTarget: { route: "markdown", target: { to: "group:c" } },
      request: baseRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(mockSend).toHaveBeenCalledWith(expect.anything(), "group:c", "md", expect.objectContaining({ forceMarkdown: true }));
    expect(entry?.mode).toBe("markdown");
  });

  it("route=markdown 失败 → return null", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, error: "5xx" });
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never, accountId: "default",
      preparedTarget: { route: "markdown", target: { to: "group:c" } },
      request: baseRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(entry).toBeNull();
  });
});

describe("transport.updateEntry · 按 entry.mode 分支 + cardStillActive 真实查询", () => {
  let mockApplyResolved: ReturnType<typeof vi.fn>;
  let mockApplyExpired: ReturnType<typeof vi.fn>;
  let mockResolveCard: ReturnType<typeof vi.fn>;
  let mockIsActive: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const patcher = await import("../../src/approval/approval-card-patcher");
    const registry = await import("../../src/card/card-run-registry");
    mockApplyResolved = patcher.applyResolvedPatch as ReturnType<typeof vi.fn>;
    mockApplyExpired = patcher.applyExpiredPatch as ReturnType<typeof vi.fn>;
    mockResolveCard = registry.resolveCardRun as ReturnType<typeof vi.fn>;
    mockIsActive = registry.isActiveCardRun as ReturnType<typeof vi.fn>;
    mockApplyResolved.mockReset(); mockApplyExpired.mockReset();
    mockResolveCard.mockReset(); mockIsActive.mockReset();
  });

  it("mode=card · resolved · card 仍 active → applyResolvedPatch(..., true)", async () => {
    mockResolveCard.mockReturnValue({ outTrackId: "ot1", card: { state: "INPUTING" } });
    mockIsActive.mockReturnValue(true);
    await runtime.transport.updateEntry({
      cfg: {} as never, accountId: "default",
      entry: { mode: "card", outTrackId: "ot1", approvalId: "abc" } as never,
      payload: { decision: "allow-once" } as never,
      phase: "resolved" as never,
    } as never);
    expect(mockApplyResolved).toHaveBeenCalledWith("ot1", "allow-once", "tok", true, expect.objectContaining({ clientId: "x" }));
  });

  it("mode=card · resolved · card 已 FINISHED → applyResolvedPatch(..., false)", async () => {
    mockResolveCard.mockReturnValue({ outTrackId: "ot1", card: { state: "FINISHED" } });
    mockIsActive.mockReturnValue(false);
    await runtime.transport.updateEntry({
      cfg: {} as never, accountId: "default",
      entry: { mode: "card", outTrackId: "ot1", approvalId: "abc" } as never,
      payload: { decision: "allow-once" } as never,
      phase: "resolved" as never,
    } as never);
    expect(mockApplyResolved).toHaveBeenCalledWith("ot1", "allow-once", "tok", false, expect.objectContaining({ clientId: "x" }));
  });

  it("mode=card · phase=expired → applyExpiredPatch（cardStillActive 同样按 registry）", async () => {
    mockResolveCard.mockReturnValue(null);
    mockIsActive.mockReturnValue(false);
    await runtime.transport.updateEntry({
      cfg: {} as never, accountId: "default",
      entry: { mode: "card", outTrackId: "ot1", approvalId: "abc" } as never,
      payload: {} as never,
      phase: "expired" as never,
    } as never);
    expect(mockApplyExpired).toHaveBeenCalledWith("ot1", "tok", false, expect.objectContaining({ clientId: "x" }));
  });

  it("mode=markdown · phase=resolved → no-op", async () => {
    await runtime.transport.updateEntry({
      cfg: {} as never, accountId: "default",
      entry: { mode: "markdown", approvalId: "abc" } as never,
      payload: { decision: "allow-once" } as never,
      phase: "resolved" as never,
    } as never);
    expect(mockApplyResolved).not.toHaveBeenCalled();
    expect(mockApplyExpired).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 18.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-native-runtime.test.ts`
Expected: FAIL（模块未实现）。

- [ ] **Step 18.3: 实现 src/approval/approval-native-runtime.ts**

```typescript
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  getExecApprovalsConfig,
  listExecApprovers,
} from "./approval-config";
import { findActiveAgentCard } from "./approval-card-locator";
import {
  applyPendingPatch, applyResolvedPatch, applyExpiredPatch,
} from "./approval-card-patcher";
import {
  buildExecApprovalMarkdown,
  buildPluginApprovalMarkdown,
} from "./approval-markdown-render";
import { normalizeApprovalTargetTo } from "./approval-target-resolver";
import {
  resolveCardRun,
  isActiveCardRun,
} from "../card/card-run-registry";
import { getAccessToken } from "../auth";
import { getConfig } from "../config";
import { getLogger } from "../logger-context";
import { sendProactiveTextOrMarkdown } from "../send-service";

// HTTP status 已知错误码集合 — 明确失败（降级 markdown）
//
// 设计决策：4xx + 5xx 都归"明确失败 → 降级 markdown"，而不是把 5xx 当"模糊失败 → null"。
// 理由：
//   1. payload 就在手上（pendingPayload.markdownText），降级到 markdown 不需要额外请求即可送达；
//   2. 我们**不**做 retry-with-backoff —— deliverPending 设计为单次尝试，重试逻辑由上游 approval-
//      handler-runtime 决定（如果上游觉得需要重试它会再调一次 deliverPending，到时再走完整 flow）；
//   3. 5xx 当 null 会让用户在群里**完全看不到 pending 提示**，UX 比"上线的是 markdown 而非按钮"更差。
// 只有 timeout / ECONNRESET / ECONNABORTED 这类**结果未定**的失败才 return null（卡片可能已经 PUT
// 成功但响应丢了；再发 markdown 会变重复提示）。
function isExplicitHttpFailure(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number }; code?: string } | null;
  if (!e) return false;
  const status = typeof e.status === "number" ? e.status : e.response?.status;
  if (typeof status === "number" && status >= 400) return true;
  if (e.code === "EBADREQ") return true;
  return false;
}

function isTimeoutFailure(err: unknown): boolean {
  const e = err as { code?: string } | null;
  return e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET" || e?.code === "ECONNABORTED";
}

// 不用 createLazyChannelApprovalNativeRuntimeAdapter（参 Stage 0.A）—— 直接返字面量 adapter
export function createDingTalkApprovalNativeRuntime(): ChannelApprovalNativeRuntimeAdapter {
  return {
    eventKinds: ["exec", "plugin"],

    availability: {
      isConfigured: ({ cfg, accountId }) =>
        getExecApprovalsConfig({ cfg, accountId }).isNativeDeliveryEnabled,
      shouldHandle: ({ cfg, accountId, request }) => {
        if (!getExecApprovalsConfig({ cfg, accountId }).isNativeDeliveryEnabled) return false;
        const payload = request.request;
        if (payload?.turnSourceChannel !== "dingtalk") return false;
        if (!payload.turnSourceTo) return false;
        if (listExecApprovers({ cfg, accountId }).length === 0) return false;
        return true;
      },
    },

    presentation: {
      buildPendingPayload: ({ request, approvalKind, nowMs }) => {
        // 用上游传入的 approvalKind ("exec" | "plugin")，不靠 id 前缀猜
        // —— 上游 id 格式将来变化（如 plugin id 不带前缀）也不会错位
        const markdownText = approvalKind === "plugin"
          ? buildPluginApprovalMarkdown(request as never, nowMs)
          : buildExecApprovalMarkdown(request as never, nowMs);
        return { approvalId: request.id, markdownText };
      },
      buildResolvedResult: ({ resolved }) => ({
        kind: "update",
        payload: { phase: "resolved", decision: resolved.decision },
      }),
      buildExpiredResult: () => ({
        kind: "update",
        payload: { phase: "expired" },
      }),
    },

    transport: {
      // 注意：prepareTarget params 含 cfg / accountId（来自 ChannelApprovalCapabilityHandlerContext，
      // 参 Stage 0.A）；plannedTarget 只是 { surface, target, reason }，不含 cfg
      prepareTarget: ({ cfg, accountId, plannedTarget, request }) => {
        const rawTo = (plannedTarget.target as { to: string }).to;
        const normalizedTo = normalizeApprovalTargetTo(rawTo);
        const resolvedAccountId =
          (plannedTarget.target as { accountId?: string }).accountId ?? accountId ?? "default";
        const found = findActiveAgentCard({
          cfg,
          accountId: resolvedAccountId,
          sessionKey: request.request?.sessionKey ?? "",
        });
        if (found) {
          return {
            target: { ...plannedTarget.target, to: normalizedTo, accountId: resolvedAccountId },
            threadId: null,
            route: "card" as const,
            activeCardOutTrackId: found.outTrackId,
            dedupeKey: `dingtalk:${resolvedAccountId}:${normalizedTo}:${found.outTrackId}`,
          };
        }
        return {
          target: { ...plannedTarget.target, to: normalizedTo, accountId: resolvedAccountId },
          threadId: null,
          route: "markdown" as const,
          dedupeKey: `dingtalk:${resolvedAccountId}:${normalizedTo}:markdown:${request.id}`,
        };
      },

      deliverPending: async ({ cfg, accountId, preparedTarget, request: _request, pendingPayload }) => {
        const tgt = preparedTarget as {
          route: "card" | "markdown";
          activeCardOutTrackId?: string;
          target: { to: string };
        };
        const dtConfig = getConfig(cfg, accountId);
        const log = getLogger(accountId);
        if (tgt.route === "card" && tgt.activeCardOutTrackId) {
          const token = await getAccessToken(dtConfig, log);
          try {
            await applyPendingPatch(tgt.activeCardOutTrackId, pendingPayload.approvalId, token, dtConfig);
            return {
              approvalId: pendingPayload.approvalId,
              accountId, mode: "card",
              outTrackId: tgt.activeCardOutTrackId,
            };
          } catch (err) {
            if (isTimeoutFailure(err)) return null;
            if (isExplicitHttpFailure(err)) {
              // 明确失败 → 降级到 markdown
              const md = await sendProactiveTextOrMarkdown(
                dtConfig, tgt.target.to, pendingPayload.markdownText,
                { forceMarkdown: true, accountId, log },
              );
              if (md?.ok) {
                return { approvalId: pendingPayload.approvalId, accountId, mode: "markdown" };
              }
              return null;
            }
            return null;
          }
        }
        // markdown 路径
        const md = await sendProactiveTextOrMarkdown(
          dtConfig, tgt.target.to, pendingPayload.markdownText,
          { forceMarkdown: true, accountId, log },
        );
        if (!md?.ok) return null;
        return { approvalId: pendingPayload.approvalId, accountId, mode: "markdown" };
      },

      updateEntry: async ({ cfg, accountId, entry, payload, phase }) => {
        const e = entry as { mode: "card" | "markdown"; outTrackId?: string };
        if (e.mode !== "card" || !e.outTrackId) return;
        const dtConfig = getConfig(cfg, accountId);
        const log = getLogger(accountId);
        const token = await getAccessToken(dtConfig, log);
        // 按 registry 真实状态判 cardStillActive，用于 hasAction 恢复
        const record = resolveCardRun(e.outTrackId);
        const cardStillActive = record ? isActiveCardRun(record) : false;
        if (phase === "resolved") {
          await applyResolvedPatch(e.outTrackId, (payload as { decision: never }).decision, token, cardStillActive, dtConfig);
        } else {
          await applyExpiredPatch(e.outTrackId, token, cardStillActive, dtConfig);
        }
      },
    },

    observe: {
      // accountId 直接从上游 ChannelApprovalCapabilityHandlerContext 拿（observe 参数继承自 context）
      // —— 比从 entry.accountId / plannedTarget.target.accountId 回推更稳：delivery error 阶段
      // entry 可能为 null，plannedTarget 也可能因 prepareTarget 抛错没成形。
      onDelivered: ({ accountId, entry, request }) => {
        getLogger(accountId)?.info(`[DingTalk][Approval] delivered approval=${request.id} mode=${(entry as { mode?: string }).mode}`);
      },
      onDeliveryError: ({ accountId, error, request }) => {
        getLogger(accountId)?.warn(`[DingTalk][Approval][DeliveryError] approval=${request.id} error=${(error as Error)?.message}`);
      },
    },
  };
}
```

> 注：`cardStillActive` 用 `resolveCardRun(outTrackId)` + `isActiveCardRun()` 真实查询，保证审批通过后 agent 仍在 stream 时能恢复 btn_stop（参 spec D23）。registry record 被 sweep / 不存在时退化为 `false`（resolved 时不恢复 stop，符合"卡片已不可控"语义）。

- [ ] **Step 18.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-native-runtime.test.ts`
Expected: ≥ 14 PASS。

- [ ] **Step 18.5: Commit**

```bash
git add src/approval/approval-native-runtime.ts tests/unit/approval-native-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): 实现 native runtime 4 子 adapter

availability（4 连判 origin-only）+ presentation（pending/resolved/expired
payload，按上游传入的 approvalKind ("exec"|"plugin") 选 markdown builder）+ transport（D22 双路由：
prepareTarget 查 card-locator 决定 route；deliverPending card 明确失败降级
markdown，模糊失败 return null；updateEntry 按 entry.mode 分支调 patcher 或
no-op）+ observe（投递日志）。

interactions 推迟 v2。

EOF
)"
```


---

## Task 19 · approval-capability.ts 接 nativeRuntime

**Files:**
- Modify: `src/approval/approval-capability.ts`
- Test: `tests/unit/approval-capability.test.ts`（扩 PR-1 已建文件）

- [ ] **Step 19.1: 写失败测试**

在 `tests/unit/approval-capability.test.ts` 加：

```typescript
import { createDingTalkApprovalNativeRuntime } from "../../src/approval/approval-native-runtime";
vi.mock("../../src/approval/approval-native-runtime", () => ({
  createDingTalkApprovalNativeRuntime: vi.fn(() => ({ marker: "native-runtime" })),
}));

describe("PR-2 增量 · nativeRuntime 挂接", () => {
  it("createDingTalkApprovalCapability 传 nativeRuntime 给工厂", () => {
    createDingTalkApprovalCapability();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      nativeRuntime: expect.objectContaining({ marker: "native-runtime" }),
    }));
  });
});
```

- [ ] **Step 19.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/approval-capability.test.ts -t "nativeRuntime 挂接"`
Expected: FAIL（capability 未传 nativeRuntime）。

- [ ] **Step 19.3: 修改 src/approval/approval-capability.ts**

加 import：

```typescript
import { createDingTalkApprovalNativeRuntime } from "./approval-native-runtime";
```

在工厂参数对象内加：

```typescript
nativeRuntime: createDingTalkApprovalNativeRuntime(),
```

- [ ] **Step 19.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/approval-capability.test.ts`
Expected: 7 PASS（PR-1 6 + 1 新增）。

- [ ] **Step 19.5: Commit**

```bash
git add src/approval/approval-capability.ts tests/unit/approval-capability.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): capability 接上 nativeRuntime（PR-2 收尾装配）

createDingTalkApprovalCapability 工厂参数加 nativeRuntime，至此 channel
plugin 完整实现 ChannelApprovalCapability —— 上游 approval-handler-runtime
可以触发 4 子 adapter 调用 DingTalk channel 投递路径。

EOF
)"
```

---

## Task 20 · channel-gateway TOPIC_CARD listener 接入 approval 分支

**Files:**
- Modify: `src/gateway/channel-gateway.ts`：在 `channel-gateway.ts:352-382` 的 feedback-learning block **之后**、`channel-gateway.ts:383` `handleCardAction` 调用**之前**插入 approval 分支
- Test: `tests/unit/channel-gateway-approval.test.ts`

### TOPIC_CARD listener 三段式优先级（PR-2 落地后的稳定形态）

按此**固定顺序**处理 card callback，未来加新按钮类型也按这个表插。**违反顺序即被视为回归**。

| 顺序 | 阶段 | actionId 范围 | 实现入口 | 命中后行为 |
|---|---|---|---|---|
| 1 | feedback-learning | `feedback_up` / `feedback_down` | 既有 `channel-gateway.ts:352-382` block | 记录学习 + 发**反馈确认消息**（业务层 ack，发给用户的提示，不是平台 callback ack）；不 return，让 listener 继续走到阶段 2/3；**平台 callback ack 统一由 listener 顶部 `finally { acknowledge() }` 处理，本阶段不要手动调 `client.socketCallBackResponse`** |
| 2 | **approval (本 task 新增)** | `allow-once` / `allow-always` / `deny`（按 `cardPrivateData.params.action` 主链路 + actionId fallback 精确匹配） | `tryHandleApprovalCallback` | 命中 → `return`（短路；listener 顶部已有 `finally { acknowledge() }` 完成 ack）；未命中 → 继续到阶段 3 |
| 3 | handleCardAction | `btn_stop` 等其它按钮 | 既有 `handleCardAction(...)` 调用 | 既有逻辑 |

**为什么这个顺序**：
- feedback 必须在 approval **之前**——feedback / approval actionId 实际不冲突，但 feedback block 已与上游 OpenClaw 学习链路深度耦合（写 store / 发 ack）；放在 approval 后会让 reviewer 怀疑 approval 是否吞了 feedback。
- approval 必须在 handleCardAction **之前**——approval 按钮命中后必须 `return`，避免 `handleCardAction` 继续处理同一 actionId（虽然 actionId 不重叠，**显式短路**更安全 + 减少不必要的 stop-detection 日志）。
- 三段都是**单一职责**：阶段 1 不解析 approval，阶段 2 不发 feedback，阶段 3 不识 approval。**actionId 路由集中在各阶段内部**，gateway 不做总分发。

**未来扩展原则**：再加新按钮类型（如 v2 future feedback-button-with-comment）时，遵循"先 ack 类（无 return）→ 中 short-circuit 类（return）→ 末尾 fallback 类（既有 handleCardAction）"的顺序；新增 short-circuit 类按钮必须更新本表 + 加单测验证不踩之前阶段。

- [ ] **Step 20.1: 写失败测试**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/approval/approval-callback-handler", () => ({
  tryHandleApprovalCallback: vi.fn(),
}));
vi.mock("../../src/card-callback-service", () => ({
  analyzeCardCallback: vi.fn(),
  // 不 mock socketCallBackResponse —— 该方法在 client 实例上，由 gateway fixture 的 client mock 提供
  // （listener 通过 client.socketCallBackResponse 在 finally 块的 acknowledge() helper 里 ack，
  //  参 src/gateway/channel-gateway.ts:332,337,404）
}));

// 沿用现有 channel-gateway tests 的 setup 模式
describe("channel-gateway · TOPIC_CARD approval 分支", () => {
  beforeEach(() => { /* reset mocks */ });

  it("analysis 含 cardPrivateData.params.action 命中 → 调 tryHandleApprovalCallback", async () => {
    // setup analyzeCardCallback 返回带 approval 数据的 analysis
    // invoke gateway TOPIC_CARD listener
    // 断言 tryHandleApprovalCallback 被调
  });

  it("tryHandleApprovalCallback handled=true → 跳过 handleCardAction", async () => {
    // mock tryHandleApprovalCallback 返 { handled: true }
    // 断言 handleCardAction 未调
  });

  it("tryHandleApprovalCallback handled=false → 继续 handleCardAction（feedback / btn_stop 不受影响）", async () => {
    // mock tryHandleApprovalCallback 返 { handled: false }
    // 断言 handleCardAction 被调
  });

  it("无论 approval 分支是否命中、即使 approval handler 抛错，listener 的 finally 块都会通过 client.socketCallBackResponse 完成 ack", async () => {
    // 断言 mocked client.socketCallBackResponse 总是被调
  });
});
```

> 沿用既有 `tests/unit/channel-gateway*.test.ts` 的 fixture 模式——**fixture 用 `client` mock（含 `socketCallBackResponse` 方法）**，**不要** `vi.mock("../../src/card-callback-service")` 去 mock 一个不存在的顶层 `socketCallBackResponse` 函数。真实 ack 路径是 `client.socketCallBackResponse(messageId, { success: true })`（参 `src/gateway/channel-gateway.ts:239` + `:337`）。

- [ ] **Step 20.2: 跑确认 fail**

Run: `pnpm vitest run tests/unit/channel-gateway-approval.test.ts`
Expected: FAIL（分支未插入）。

- [ ] **Step 20.3: 修改 src/gateway/channel-gateway.ts**

定位 feedback-learning block 末尾（约 `src/gateway/channel-gateway.ts:382`，`if (analysis.feedbackTarget && ...) { ... }` 的右花括号）与 `handleCardAction` 调用开始（约 `:383`）之间。

**先在文件顶部 import** 区域加静态 import（与 `analyzeCardCallback` / `handleCardAction` 等既有 import 同级）：

```typescript
import { tryHandleApprovalCallback } from "../approval/approval-callback-handler";
```

> `src/approval/approval-callback-handler.ts` 不会反向依赖 `src/gateway/channel-gateway.ts`，无循环依赖；用静态 import 即可，不要写 `await import(...)`。

然后插入：

```typescript
            // -- approval 分支：feedback-learning 之后、handleCardAction 之前 --
            const approvalResult = await tryHandleApprovalCallback({
              cfg,
              accountId: account.accountId,
              analysis,
              log: pluginLog,
            });
            if (approvalResult.handled) {
              // 命中即短路 —— listener 顶部的 finally { acknowledge() } 会发 ack
              // 不要在这里手动调 acknowledge / client.socketCallBackResponse
              return;
            }
            // 未命中（非 approval 按钮）继续既有 handleCardAction
            const actionResult = await handleCardAction({...});  // ← 既有这一行不动
```

> 实施前必读 `Read src/gateway/channel-gateway.ts:330-407`：
> - 变量名按 listener scope 实际命名（`cfg` / `account` / `analysis` / `pluginLog` / `messageId` 都已在外层 closure 中）。
> - **listener 已有 `try { ... } finally { acknowledge(); }` 结构**（参 `channel-gateway.ts:332` 的 `const acknowledge = () => {...}` + `:404` 的 `finally { acknowledge(); }`）——approval 分支只需要 `return` 即可，**不要**手动写 `socketCallBackResponse(...)`（这变量不在当前 scope；ack 路径走 `client.socketCallBackResponse` 在 `acknowledge` helper 内）。
> - feedback path（`channel-gateway.ts:352-382`）的 actionId 仅匹配 `feedback_up/down`，与 approval 三按钮 actionId（`allow-once/allow-always/deny`）永远不冲突；放在 feedback 之后是**显式排序**而非冲突回避（spec v3.9）。

- [ ] **Step 20.4: 跑确认 pass**

Run: `pnpm vitest run tests/unit/channel-gateway-approval.test.ts`
Expected: 4 PASS。

- [ ] **Step 20.5: 跑既有 channel-gateway 测试无回归**

Run: `pnpm vitest run tests/unit/channel-gateway`
Expected: 全部 PASS（feedback / btn_stop 行为不变）。

- [ ] **Step 20.6: Commit**

```bash
git add src/gateway/channel-gateway.ts tests/unit/channel-gateway-approval.test.ts
git commit -m "$(cat <<'EOF'
feat(approval): channel-gateway TOPIC_CARD 接入 approval 分支

在 handleCardAction 之前 try approval-callback-handler；命中即 ack + return，
未命中（非 approval 按钮）走既有 feedback / btn_stop 路径。actionId 集合
{allow-once, allow-always, deny} 与 {feedback_up, feedback_down, btn_stop}
永不冲突，所以放前后均可。

EOF
)"
```

---

## Task 21 · integration test approval-end-to-end（DONE）

**Files:**
- Create: `tests/integration/approval-end-to-end.test.ts`（12 sub-test 单 commit 落地）

> spec §9.3 列出 12 个关键 integration 场景（含 v3.11 invalid-decision exec/plugin 两个）。
> **关键约定：** 这是 integration 级——mock HTTP/auth/registry/上游 SDK，但保持 channel 内部模块（callback-handler + resolver + patcher + native-runtime）真实串联（不要 mock `src/approval/*` 内部）。
> **实施偏差：** 原 plan 要求按 21a–21l 分 12 次 commit（TDD red→green）；实施时源码已落地，12 个测试是补覆盖而非 TDD 增量，因此单 commit 一并落地，commit message 列出 12 个场景。共享 setup 用 `vi.hoisted` 持有 mock 实例（解决 vi.fn().mockResolvedValue 在 factory 内对静态 import 的初始化竞态）。

### 共享 setup（Step 21.0：每个 sub-task 都依赖）

```typescript
// tests/integration/approval-end-to-end.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// integration 测试：mock 对齐 impl 真实 subpath（Stage 0.A 表）
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: vi.fn(),
}));
// updateCardVariables 真实返 Promise<number>（不是 {ok}），失败 throw
// 不 mock socketCallBackResponse —— card-callback-service 不导出该函数（真实 ack 在 client 实例上）
vi.mock("../../src/card-callback-service", () => ({
  updateCardVariables: vi.fn().mockResolvedValue(200),
  analyzeCardCallback: vi.fn(),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/auth", () => ({ getAccessToken: vi.fn().mockResolvedValue("tok") }));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));
vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn(() => undefined),
}));

// 真实串联 channel 内部 approval 模块（不 mock src/approval/*）
const { tryHandleApprovalCallback } = await import("../../src/approval/approval-callback-handler");
const { tryInterceptApproveCommand } = await import("../../src/approval/approval-command-intercept");
const { createDingTalkApprovalNativeRuntime } = await import("../../src/approval/approval-native-runtime");
const sdk = await import("openclaw/plugin-sdk/approval-gateway-runtime");
const cardSvc = await import("../../src/card-callback-service");
const sendSvc = await import("../../src/send-service");

const mockGateway = sdk.resolveApprovalOverGateway as ReturnType<typeof vi.fn>;
const mockPut = cardSvc.updateCardVariables as ReturnType<typeof vi.fn>;
const mockSend = sendSvc.sendProactiveTextOrMarkdown as ReturnType<typeof vi.fn>;

// 通用 fixture
const baseCfg = {
  channels: {
    dingtalk: {
      clientId: "x", clientSecret: "y",
      execApprovals: { approvers: ["staffA", "staffB"] },
    },
  },
} as never;

const callbackAnalysis = (overrides: Record<string, unknown> = {}) => ({
  actionId: "allow-once",
  userId: "staffA",
  outTrackId: "ai_card_xxx",
  cardPrivateData: {
    actionIds: ["allow-once"],
    params: { action: "allow-once", approveId: "abc123" },
  },
  ...overrides,
}) as never;

beforeEach(() => {
  mockGateway.mockReset();
  mockPut.mockReset().mockResolvedValue(200);
  mockSend.mockReset().mockResolvedValue({ ok: true });
});
```

### Step 21a · (1) Multi-approver 竞争点击 — already-resolved 第二次也刷成终态

- [ ] 写测试并 commit：

```typescript
it("(1) multi-approver: 1st wins → 2nd already-resolved → applyExpiredPatch 仍调（卡片再刷一次）", async () => {
  // 1st 调用：gateway 成功
  mockGateway.mockResolvedValueOnce({});
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({ userId: "staffA" }),
  });
  expect(mockPut).toHaveBeenCalledWith(
    "ai_card_xxx",
    expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
    "tok",
    expect.objectContaining({ clientId: "x" }),
  );
  mockPut.mockClear();

  // 2nd 调用：gateway 抛 APPROVAL_ALREADY_RESOLVED → applyExpiredPatch
  mockGateway.mockRejectedValueOnce(Object.assign(new Error("already"), {
    gatewayCode: "APPROVAL_ALREADY_RESOLVED",
  }));
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({ userId: "staffB" }),
  });
  expect(mockPut).toHaveBeenCalledWith(
    "ai_card_xxx",
    expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
    "tok",
    expect.objectContaining({ clientId: "x" }),
  );
});
```

Run: `pnpm vitest run tests/integration/approval-end-to-end.test.ts -t "(1) multi-approver"` → PASS。
Commit: `test(approval): integration (1) multi-approver 竞争点击`。

### Step 21b · (2) Self-approval in DM

```typescript
it("(2) self-approval in DM: approver 自己点 → ok=true → applyResolvedPatch", async () => {
  mockGateway.mockResolvedValue({});
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({ userId: "staffA" }),
  });
  expect(mockGateway).toHaveBeenCalledWith(expect.objectContaining({
    approvalId: "abc123", decision: "allow-once", senderId: "staffA",
  }));
  expect(mockSend).not.toHaveBeenCalled(); // 不私聊
});
```

### Step 21c · (3) 非 approver 点击

```typescript
it("(3) 非 approver 点击 → 私聊拒绝 + 不调 patcher（卡片不变）", async () => {
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({ userId: "outsider" }),
  });
  expect(mockGateway).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledWith(
    expect.anything(), "user:outsider",
    expect.stringContaining("无权"),
    expect.objectContaining({ forceMarkdown: true }),
  );
  expect(mockPut).not.toHaveBeenCalled();
});
```

### Step 21d · (4) 上游过期事件 → updateEntry phase=expired

```typescript
it("(4) 上游 expired event → transport.updateEntry({phase:'expired'}) → applyExpiredPatch", async () => {
  const runtime = createDingTalkApprovalNativeRuntime();
  await runtime.transport.updateEntry({
    cfg: baseCfg, accountId: "default",
    entry: { mode: "card", outTrackId: "ot1", approvalId: "abc" } as never,
    payload: {} as never,
    phase: "expired" as never,
  } as never);
  expect(mockPut).toHaveBeenCalledWith(
    "ot1",
    expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
    "tok",
    expect.objectContaining({ clientId: "x" }),
  );
});
```

### Step 21e · (5) Card patch 明确失败 → 降级 markdown

```typescript
it("(5) card 路径 HTTP 400 → 降级 markdown，entry.mode='markdown'", async () => {
  // 让 first PUT 抛 HTTP 400（明确失败）
  mockPut.mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400 }));
  const runtime = createDingTalkApprovalNativeRuntime();
  const entry = await runtime.transport.deliverPending({
    cfg: baseCfg, accountId: "default",
    preparedTarget: { route: "card", activeCardOutTrackId: "ot1", target: { to: "group:c" } },
    request: { id: "abc", createdAtMs: 0, expiresAtMs: 0, request: { sessionKey: "s1", turnSourceChannel: "dingtalk", turnSourceTo: "group:c" } },
    pendingPayload: { approvalId: "abc", markdownText: "md-payload" },
  } as never);
  expect(mockSend).toHaveBeenCalledWith(
    expect.anything(), "group:c", "md-payload",
    expect.objectContaining({ forceMarkdown: true }),
  );
  expect(entry?.mode).toBe("markdown");
});
```

### Step 21f · (6) Card patch 模糊失败 → return null

```typescript
it("(6) card 路径 ETIMEDOUT → return null，不调 sendProactiveTextOrMarkdown", async () => {
  mockPut.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  const runtime = createDingTalkApprovalNativeRuntime();
  const entry = await runtime.transport.deliverPending({
    cfg: baseCfg, accountId: "default",
    preparedTarget: { route: "card", activeCardOutTrackId: "ot1", target: { to: "group:c" } },
    request: { id: "abc", createdAtMs: 0, expiresAtMs: 0, request: { sessionKey: "s1", turnSourceChannel: "dingtalk", turnSourceTo: "group:c" } },
    pendingPayload: { approvalId: "abc", markdownText: "md" },
  } as never);
  expect(entry).toBeNull();
  expect(mockSend).not.toHaveBeenCalled();
});
```

### Step 21g · (7) /approve 命令路径绕过 session lock

```typescript
it("(7) /approve 命令 → 调 resolveApprovalOverGateway，不触发 reply 派发", async () => {
  mockGateway.mockResolvedValue({});
  const intercepted = await tryInterceptApproveCommand({
    cfg: baseCfg, accountId: "default",
    text: "/approve abc once", senderId: "staffA",
  });
  expect(intercepted).toBe(true);
  expect(mockGateway).toHaveBeenCalledWith(expect.objectContaining({
    approvalId: "abc", decision: "allow-once", senderId: "staffA",
  }));
});
```

### Step 21h · (8) 未配置 approvers

```typescript
it("(8) 未配置 approvers → availability.shouldHandle=false", async () => {
  const cfgNoApprovers = { channels: { dingtalk: { clientId: "x", clientSecret: "y" } } } as never;
  const runtime = createDingTalkApprovalNativeRuntime();
  expect(runtime.availability.shouldHandle({
    cfg: cfgNoApprovers, accountId: "default",
    request: { id: "abc", request: { turnSourceChannel: "dingtalk", turnSourceTo: "group:c" } } as never,
  })).toBe(false);
});
```

### Step 21i · (9) CLI 触发 turnSourceChannel != dingtalk

```typescript
it("(9) turnSourceChannel=CLI → shouldHandle=false", async () => {
  const runtime = createDingTalkApprovalNativeRuntime();
  expect(runtime.availability.shouldHandle({
    cfg: baseCfg, accountId: "default",
    request: { id: "abc", request: { turnSourceChannel: "codex-cli", turnSourceTo: "group:c" } } as never,
  })).toBe(false);
});
```

### Step 21j · (10) Channel 重启后旧按钮 not-found

```typescript
it("(10) gateway 抛 APPROVAL_NOT_FOUND → applyExpiredPatch（三变量 PUT，无终态文字）", async () => {
  mockGateway.mockRejectedValue(Object.assign(new Error("nf"), { gatewayCode: "APPROVAL_NOT_FOUND" }));
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({ userId: "staffA" }),
  });
  const vars = mockPut.mock.calls[0][1] as Record<string, string>;
  expect(vars).toEqual(expect.objectContaining({
    show_approve_btns: "false", approveId: "",
  }));
  expect(vars).not.toHaveProperty("status");
  expect(vars).not.toHaveProperty("statusFooter");
  expect(vars).not.toHaveProperty("approval_status");
});
```

### Step 21k · (11) Invalid-decision exec (allow-always unavailable)

```typescript
it("(11) exec invalid-decision (APPROVAL_ALLOW_ALWAYS_UNAVAILABLE) → 不 patch + 私聊重选", async () => {
  mockGateway.mockRejectedValue(Object.assign(new Error("ad"), {
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
  }));
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({
      userId: "staffA",
      actionId: "allow-always",
      cardPrivateData: { actionIds: ["allow-always"], params: { action: "allow-always", approveId: "abc123" } },
    }),
  });
  expect(mockPut).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledWith(
    expect.anything(), "user:staffA",
    expect.stringContaining("不支持 allow-always"),
    expect.objectContaining({ forceMarkdown: true }),
  );
});
```

### Step 21l · (12) Invalid-decision plugin (allowedDecisions=[...])

```typescript
it("(12) plugin invalid-decision (allowedDecisions=['allow-once']) → 私聊含 allowedDecisions 文案", async () => {
  mockGateway.mockRejectedValue(Object.assign(new Error("ad"), {
    gatewayCode: "INVALID_REQUEST",
    details: { allowedDecisions: ["allow-once"] },
  }));
  await tryHandleApprovalCallback({
    cfg: baseCfg, accountId: "default",
    analysis: callbackAnalysis({
      userId: "staffA",
      actionId: "allow-always",
      cardPrivateData: {
        actionIds: ["allow-always"],
        params: { action: "allow-always", approveId: "plugin:xyz789" },
      },
    }),
  });
  expect(mockPut).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledWith(
    expect.anything(), "user:staffA",
    expect.stringContaining("allow-once"),
    expect.objectContaining({ forceMarkdown: true }),
  );
});
```

### Step 21.M · 总结 commit

- [ ] 跑全部 integration 测试

Run: `pnpm vitest run tests/integration/approval-end-to-end.test.ts`
Expected: 12 PASS。

- [ ] 跑覆盖率确认达标

Run: `pnpm test:coverage`
Expected: `src/approval/*` line ≥ 90%, branch ≥ 85%；仓库整体 coverage 不下降。

> 如 Step 21a-21l 已逐个 commit 完毕，此步无需再 commit；否则可一次性 commit：

```bash
git add tests/integration/approval-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test(approval): integration end-to-end 覆盖 12 关键场景

参 spec §9.3 + v3.11/v3.12 invalid-decision 场景：multi-approver 竞争、
self-approval、非 approver 拒绝、上游过期、card 失败降级 markdown、模糊
失败不重发、/approve 命令链路、未配 approvers、CLI 触发、channel 重启
not-found 降级 expired、exec/plugin invalid-decision 私聊重选。
EOF
)"
```

---

## Task 22 · 真机回归（PR-2 最终验证）

**Files:** 无代码改动；产出回归记录 `docs/artifacts/2026-05-19-approval-real-device-regression.md`

> 参 `skills/dingtalk-real-device-testing/SKILL.md`。**这一步不能跳过 —— PR-2 是真机回归 PR**。
> **当前分支状态：** 尚未产出该回归记录；若没有真实钉钉环境，本项应在 PR 验证 TODO 中明确标注为未执行，而不是写成已通过。

- [ ] **Step 22.1: 准备真机环境**

```bash
pnpm run build:runtime
openclaw gateway restart   # 用户手动跑
```

确认日志显示加载新的 `dist/index.js`。

- [ ] **Step 22.2: 真机回归 checklist（参 spec §10 阶段 2）**

依次在钉钉群里跑：

- [ ] (a) Agent 触发 exec approval（如 `docker image prune`）→ AI Card 出现 + **底部出现 3 个 approval 按钮** + btn_stop 暂时隐藏（show_approve_btns=true, hasAction=false 生效）
- [ ] (b) approver 点 "允许一次" → approval 按钮消失 + agent 继续 stream + btn_stop 恢复（show_approve_btns=false, approveId="", hasAction=true）
- [ ] (c) approver 点 "拒绝" → 按钮消失 + agent terminated（按钮变化与允许一致；agent 行为由上游决定）
- [ ] (d) 非 approver 点按钮 → 收到 `⛔ 你不在 approver 名单` 私聊 + **卡片不变**（按钮仍在）
- [ ] (e) approver 敲 `/approve <id> allow-once` 命令 → 等同点按钮（含群里 `@bot /approve ...` 形式）
- [ ] (f) callback payload 真机抓包确认含 `cardPrivateData.params.approveId` 字段（与 PUT 时一致）
- [ ] (g) markdown 模式（messageType=markdown）触发 approval → 群里出现独立 markdown 消息含 `/approve <id> <decision>` 三命令模板
- [ ] (h) Agent FINISHED 后旧按钮点 → 立即变 expired（按钮消失 + 卡片其余内容不变）
- [ ] (i) 同 approval 多 approver 同时点 → 第一个成功 + 第二个看到按钮立刻消失（already-resolved 走 applyExpiredPatch）
- [ ] (j) 用户点了 request 不允许的 decision（如 ask=always 时点 allow-always）→ 收到私聊重选提示 + **按钮保持 pending 可再点**

- [ ] **Step 22.3: 产出回归记录**

写入 `docs/artifacts/2026-05-19-approval-real-device-regression.md`，列每个 checklist 的实际行为 + 截图（可选）+ 任何 anomaly。模板参既有 v2 卡片真机回归记录（如 `docs/artifacts/` 内现存文件）。

- [ ] **Step 22.4: Commit 回归记录**

```bash
git add docs/artifacts/2026-05-19-approval-real-device-regression.md
git commit -m "$(cat <<'EOF'
docs(artifacts): 添加 Gap #01 approval PR-2 真机回归记录

10 项 checklist 全部 PASS（card 双路由 + 非 approver 拒绝 + /approve
命令 + markdown 路径 + already-resolved + invalid-decision 重选）。

EOF
)"
```

---

## PR-2 收尾

- [ ] **Step PR2.1: 跑完整测试套件 + coverage**

```bash
pnpm run type-check && pnpm run lint && pnpm test && pnpm test:coverage
```

Expected: 全部 PASS；`src/approval/*` line ≥ 90%, branch ≥ 85%。

- [ ] **Step PR2.2: 开 PR-2（基于 PR-1 已 merge 的 main）**

```bash
git push -u origin <pr2-branch>  # 若用 feature 分支
gh pr create --title "feat(approval): PR-2 native runtime + v3 模板替换 + 真机回归" --body "$(cat <<'EOF'
## Summary
- 模板 ID 从 v2 替换为 v3（含 approve_btns/show_approve_btns/approveId）；createAICard cardParamMap 默认值修正
- card-callback-service 暴露 cardPrivateData（D16 BLOCKER）
- card-run-registry 加 pendingApprovalId fallback（D24）
- approval-card-patcher 三个 patcher 与 §1.X 单一事实表 1:1
- approval-markdown-render markdown 主路径文案
- approval-callback-handler 主链路 + fallback 解码 + 5 reason 分支
- approval-native-runtime 4 子 adapter（含 card 失败降级 markdown 策略）
- channel-gateway TOPIC_CARD 接入 approval 分支
- 真机回归 PASS

## PR boundaries
- 不含用户文档（PR-3）
- 不含 release notes / README（PR-3）

## Test plan
- [x] `pnpm test` 全部 PASS
- [x] coverage src/approval ≥ 90% line / 85% branch
- [x] 真机 10 项 checklist 全部 PASS（参 docs/artifacts/...）

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# PR-3 · 用户文档与回归收尾

**交付目标：** feature 正式 production-ready。

**PR-3 任务清单：** Task 23 ~ Task 24。

---

## Task 23 · 用户文档 docs/user/features/exec-approval.md

**Files:**
- Create: `docs/user/features/exec-approval.md`

- [ ] **Step 23.1: 写文档**

按 spec §4.2 配置 schema + §6 数据流 + §7 mockup + §11.1 limitations 整理用户视角文档。结构：

```markdown
# DingTalk Exec / Plugin Approval

## 概述
（产品价值 1 段）

## 启用方法
（最小可用 yaml 配置：channels.dingtalk.execApprovals.approvers 一项即可）

## 配置 schema
（4.2 schema 完整版 + 字段说明 + 多账号 override）

## 交互方式
### 按钮路径（card 模式）
（mockup 截图 + 三按钮含义）
### 命令路径（/approve）
（10 alias × 2 顺序 = 20 形式 + 私聊提示样本）

## 真机 FAQ
- 为什么我点了按钮但没反应？ → 检查 approver 名单
- 为什么 agent reply 卡片底部一直显示 3 个按钮？ → 模板未替换 v3 或 cardParamMap 默认值缺失
- /approve 命令格式提示 → 列 20 合法形式
- invalid-decision 提示重选 → 上游 ExecApprovalRequest.allowedDecisions 限制

## v1 已知 limitation
（搬 spec §11.1：approver-DM 推迟、终态文字位、allowedDecisions 不动态隐藏、finalize-on-stop 推迟）

## v2 future（不在 v1 范围）
（搬 spec §10 "v2 future"）
```

- [ ] **Step 23.2: Commit**

```bash
git add docs/user/features/exec-approval.md
git commit -m "$(cat <<'EOF'
docs(user): 添加 DingTalk exec / plugin approval 用户配置指南

覆盖启用步骤、schema、按钮 / /approve 命令路径、FAQ、v1 limitation。
对齐 spec v3.12 §4.2 / §6 / §11.1。

EOF
)"
```

---

## Task 24 · README + release notes（BREAKING 标注）

**Files:**
- Modify: `README.md`
- Create: `docs/releases/v3.6.4.md`（参既有 `docs/releases/v3.5.3.md` 结构）
- Modify: `docs/releases/latest.md`（更新 include target）
- Modify: `docs/releases/index.md`（追加 v3.6.4 入口）

> ⚠️ 本仓库**没有** `CHANGELOG.md`——release notes 在 `docs/releases/` 目录每版一个 markdown 文件，`latest.md` 用 `<!--@include: ./vX.Y.Z.md-->` 指向最新版本。

- [ ] **Step 24.1: README 加 approval feature 段**

在 README features section 加：

```markdown
## DingTalk Native Approval（Gap #01 · v3.6.4+）

- Exec / Plugin approval 在钉钉群 AI Card 上挂 3 按钮原生体验
- 或敲 `/approve <id> <decision>` 命令完成审批
- approver 名单配置见 [docs/user/features/exec-approval.md](docs/user/features/exec-approval.md)
- 详细设计：[docs/features/2026-05-18-gap-01-approval-native-design.html](docs/features/2026-05-18-gap-01-approval-native-design.html)（v3.12）
```

- [ ] **Step 24.2: 新建 docs/releases/v3.6.4.md（参 v3.5.3.md 模板）**

```markdown
# v3.6.4 发布说明

本次发布聚焦一件大事：**DingTalk Native Approval (Gap #01)** —— 在钉钉群把 OpenClaw 的 exec / plugin 审批以原生 3 按钮 + `/approve` 命令双轨方式落地。

**最新版本入口**：[`latest.md`](./latest.md)

> [!IMPORTANT]
> **BREAKING：openclaw peerDependency 升级到 `>=2026.4.7`**
> 老版本（2026.3.28）不再支持。升级前请确认 OpenClaw 主程序版本。

## ✨ 功能

### 1. DingTalk Native Approval

* exec / plugin approval 在钉钉群 AI Card 底部挂 3 按钮（允许一次 / 总是允许 / 拒绝）
* 也支持文本命令 `/approve <id> <decision>`（10 alias × 2 顺序 = 20 合法形式，对齐上游）
* approver 名单配置：`channels.dingtalk.execApprovals.approvers` 或 `commands.ownerAllowFrom` fallback
* 详细配置 + FAQ + 限制：[`docs/user/features/exec-approval.md`](../user/features/exec-approval.md)
* 设计文档：[`docs/features/2026-05-18-gap-01-approval-native-design.html`](../features/2026-05-18-gap-01-approval-native-design.html) （v3.12）

### 2. 5 类 approval 错误分类

`unauthorized` / `not-found` / `already-resolved` / `invalid-decision` / `gateway-error`。`invalid-decision` 与 `gateway-error` 时按钮保留可再点；前者提示重选，后者提示稍后重试，避免用户卡死或瞬时网关失败误关有效审批。

## 🛠 内部改动

* 新增 `src/approval/` 域目录（10 个模块，~900 行业务 + ~2000 行测试）
* AI Card 模板从 v2 升级到 v3（含 `approve_btns` / `show_approve_btns` / `approveId` 三变量）
* `src/card/card-run-registry.ts` 新增 `resolveActiveCardRunBySession` / `isActiveCardRun` / `pendingApprovalId`
* `src/card-callback-service.ts` `CardCallbackAnalysis` 暴露 `cardPrivateData`

## ⚠️ 升级步骤

1. 升级 OpenClaw 主程序到 `>=2026.4.7`
2. 在 `channels.dingtalk.execApprovals.approvers` 配置 approver staffId 列表（详见上述用户文档）
3. AI Card 模板会自动用 v3（默认 templateId 已替换；可用 env `DINGTALK_CARD_TEMPLATE_ID` 覆盖回 v2）

## 🤝 贡献者

* @soimy（设计 + 实施）
```

- [ ] **Step 24.3: 更新 docs/releases/latest.md 的 include target**

```markdown
<!-- Latest release alias: update this include target when a new release note is added. -->
<!--@include: ./v3.6.4.md-->
```

- [ ] **Step 24.4: 更新 docs/releases/index.md**

按既有结构在版本列表顶部追加 v3.6.4 条目（不知道具体格式时先 `Read docs/releases/index.md` 比对）。

- [ ] **Step 24.5: Commit**

```bash
git add README.md docs/releases/v3.6.4.md docs/releases/latest.md docs/releases/index.md
git commit -m "$(cat <<'EOF'
docs(release): v3.6.4 release notes 含 Gap #01 + peer BREAKING

新增 docs/releases/v3.6.4.md（参 v3.5.3.md 模板）；
latest.md include target 切换；
index.md 追加 v3.6.4 入口；
README 加 approval feature 段引导到 docs/user/features/exec-approval.md。
EOF
)"
```

---

## PR-3 收尾

- [ ] **Step PR3.1: 开 PR**

```bash
gh pr create --title "docs(approval): PR-3 用户文档 + release notes" --body "$(cat <<'EOF'
## Summary
- docs/user/features/exec-approval.md 启用 + schema + 交互 + FAQ + limitation
- README features 段 + docs/releases/v3.6.4.md release notes（含 peerDep BREAKING 标注）

## Test plan
- [x] markdown 渲染检查（GitHub preview）
- [x] 文档示例可复制运行

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR-3 merge 后 Gap #01 正式 production-ready。

---

# 附录 A · 与 Spec 的映射

| Spec 锚点 | 实施 Task |
|---|---|
| §1.X 单一事实表 | Task 15（patcher）+ Task 17（callback handler）+ Task 18（runtime） |
| §2 D1 实现范围 4 子 adapter | Task 18 |
| §2 D2 /approve early intercept | Task 9 + Task 11 |
| §2 D4 v1 origin-only | Task 5 + Task 10 + Task 18 |
| §2 D7 approver schema | Task 1 + Task 3 |
| §2 D9 v3 模板 | Task 12 |
| §2 D10 双路由（不读 messageType） | Task 8 + Task 18 |
| §2 D11/D12/D13 TTL/重启/停机 | spec 决策 = v1 不做（无实施 task） |
| §2 D14 终态展示（v1 不写文字） | Task 15（patcher 不 PUT status） |
| §2 D15 按钮 payload 编码 | 模板已发布；Task 12 替换 ID |
| §2 D16 cardPrivateData 扩展 | Task 13 |
| §2 D17 SDK 基线 | Stage 0 |
| §2 D18 无本地 store | 整体设计（无实施 task） |
| §2 D20 单点 resolver | Task 6 |
| §2 D21 kind 推导 | Task 6（deriveResolveMethod） |
| §2 D22 agent-card-coalesce | Task 8（locator）+ Task 18（runtime.prepareTarget） |
| §2 D23 btn_stop 与 approval 共存 | Task 15（hasAction toggle 字段） |
| §2 D24 approveId 主链路 + fallback | Task 14 + Task 15 + Task 17 |
| §3.3 接触面表（含 v3.11 config.ts 修订） | Task 2 |
| §5 Sub-Adapter | Task 18 |
| §6.3 callback 数据流 + 5 reason | Task 17 |
| §6.4 entry.mode 分支 updateEntry | Task 18 |
| §6.6 失败 / 边界（重启 / 过期 / multi-approver） | Task 21（integration） |
| §6.7 失败处理（card 失败降级 markdown） | Task 18 |
| §6.8 /approve early intercept | Task 9 + Task 11 |
| §7.1 v1 终态文字限制 | Task 15（patcher 不 PUT 终态文字） |
| §8 错误矩阵（含 v3.11 invalid-decision） | Task 6 + Task 17 + Task 21 |
| §9 测试矩阵 | 所有 Task 的测试 + Task 21 |
| §10 阶段 0 / 1 / 2 / 3 | Stage 0 + PR-1 + PR-2 + PR-3 |
| §11.1 v1 limitation | Task 23 文档化 |
| §11.2 风险 | Task 23 FAQ + 真机回归 |

---

# 附录 B · 关键不可跳过的真机抽检节点

| Step | 原因 |
|---|---|
| Step 12.7 | 模板 ID 替换后必须确认非 approval 消息**不**显示 approval 按钮（默认值生效） |
| Step 22.2 (a-j) | PR-2 真机回归 10 项 checklist —— 唯一能 catch 模板字段错配 / 平台行为偏差 |
| PR1.2 | PR-1 /approve 通道生效抽检 —— 命令路径必须验证不死锁 |

---

# 附录 C · 实施时的 grep 安全清单

每完成一个 Task 跑：

```bash
# 1. 不留 TODO / FIXME / placeholder
git grep -n "TODO\|FIXME\|XXX" src/approval/ tests/

# 2. 不留 @ts-ignore
git grep -n "@ts-ignore" src/approval/ tests/

# 3. 不留 console.*（用 getLogger()?.info / warn / error）
git grep -nE "console\." src/approval/

# 4. 所有 sendProactiveTextOrMarkdown 调用都带 forceMarkdown:true
git grep -n "sendProactiveTextOrMarkdown" src/approval/

# 5. v3 模板 ID 全局一致
git grep -n "templateId\|TEMPLATE_ID" src/ docs/

# 6. patcher 调用都通过 approval-card-patcher，不绕过它直接调 updateCardVariables
git grep -n "updateCardVariables" src/approval/  # 应只在 approval-card-patcher.ts 出现

# 7. approve regex 没漂移回 \b（必须严格用 (?:\s|$) 与上游 commands-approve.ts:16 对齐）
git grep -nE '\^\\/\?approve\\b' src/ tests/  # 应为空；若有命中说明 regex 写错
```

---

**Plan 总结：** 1 个 stage（SDK 基线）+ 11 个 PR-1 task + 11 个 PR-2 task + 2 个 PR-3 task = 25 个 task，约 120 个 step。预计实施工时 8-12 工作日（含真机回归）。所有 task 都遵循 TDD + 频繁 commit；PR 边界处停下来等用户 review。
