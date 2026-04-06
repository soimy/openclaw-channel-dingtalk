# OpenClaw Upstream 2026.3.31-2026.4.5 Impact Design

**Date:** 2026-04-06

## Goal

盘点父仓库 `openclaw` 在 `v2026.3.31`、`v2026.4.1`、`v2026.4.2`、`v2026.4.5` 这几期稳定版中的关键变化，结合当前 DingTalk 插件实现，明确：

1. 哪些变化已经被本仓库吸收。
2. 哪些变化会在宿主升级后自动生效。
3. 哪些变化需要本仓库主动对齐。
4. 哪些事项应当立即修复，哪些可以延后。

## Scope

- 上游事实来源：
  - `~/Repo/openclaw/CHANGELOG.md`
  - `~/Repo/openclaw` 对应 tag 之间的提交历史
  - GitHub Releases：`v2026.3.31`、`v2026.4.1`、`v2026.4.2`、`v2026.4.5`
- 本仓库对照范围：
  - `src/channel.ts`
  - `src/inbound-handler.ts`
  - `src/targeting/agent-routing.ts`
  - `src/onboarding.ts`
  - `src/config-schema.ts`
  - `openclaw.plugin.json`
  - 相关单元/集成测试

## Current Integration Map

当前 DingTalk 插件与上游 `openclaw/plugin-sdk/*` 的主要耦合面如下：

- Channel entry 与 runtime 接线：
  - [`index.ts`](../../index.ts)
  - [`src/channel.ts`](../../src/channel.ts)
- Setup / onboarding：
  - [`src/onboarding.ts`](../../src/onboarding.ts)
- Inbound reply runtime：
  - [`src/inbound-handler.ts`](../../src/inbound-handler.ts)
- Native command routing：
  - [`src/command/card-stop-command.ts`](../../src/command/card-stop-command.ts)
- Agent/session routing：
  - [`src/targeting/agent-routing.ts`](../../src/targeting/agent-routing.ts)
- Plugin config validation / WebUI metadata：
  - [`src/config-schema.ts`](../../src/config-schema.ts)
  - [`openclaw.plugin.json`](../../openclaw.plugin.json)

这意味着本仓库受上游变化影响最大的区域不是 DingTalk API 本身，而是：

1. 宿主 reply runtime 的 payload 契约。
2. 宿主 channel/plugin config 的 schema 与 setup surface。
3. 宿主 routing / session-key / hook surface。

## Version-By-Version Impact

## 2026.3.31

### Upstream Facts

与本仓库最相关的变化有：

- Plugin SDK 明确弃用旧的 compat subpath，要求统一走 `openclaw/plugin-sdk/*`。
- Background tasks / Task Flow 开始成为正式宿主能力。
- 渠道路由与 plugin-owned session-key surface 持续收敛。

### Current Repo Status

- 本仓库已经完成 plugin-sdk 子路径迁移，且有防回退测试：
  - [`tests/unit/sdk-import-structure.test.ts`](../../tests/unit/sdk-import-structure.test.ts)
- 本仓库已经将 `/stop` 改成走上游 native command session-target 模型：
  - [`src/command/card-stop-command.ts`](../../src/command/card-stop-command.ts)
- 本仓库依然保留一段针对 sub-agent session key 的运行时 fallback：
  - [`src/targeting/agent-routing.ts`](../../src/targeting/agent-routing.ts)

### Impact Judgment

- **已基本对齐**：SDK import 迁移没有新增工作。
- **部分对齐**：native stop 已对齐上游语义。
- **保留技术债**：sub-agent session key 仍依赖运行时探测 + fallback，而不是完全信任 SDK 的稳定 helper。

### Follow-up Need

- 不需要为 `2026.3.31` 单独修 bug。
- 需要把“删除旧 routing fallback”列入后续对齐项，但优先级不高于用户可见行为修复。

## 2026.4.1

### Upstream Facts

与本仓库最相关的变化有：

- setup / onboarding / channel metadata 路径继续稳定。
- chat 错误回复、媒体路径与 inbound context 等 runtime 行为持续收敛。
- 宿主侧对插件 channel setup surface 的依赖更加明确。

### Current Repo Status

- 本仓库已经接入 `setup` 和 `setupWizard`：
  - [`src/channel.ts`](../../src/channel.ts)
  - [`src/onboarding.ts`](../../src/onboarding.ts)
- 本仓库已经为外部插件 WebUI 配置页补了 `channelConfigs.dingtalk`：
  - [`openclaw.plugin.json`](../../openclaw.plugin.json)
- 兼容版本下限也已经提升到 `>=2026.3.28`：
  - [`package.json`](../../package.json)

### Impact Judgment

- **已吸收大部分宿主变化**：DingTalk 插件不会因 `2026.4.1` 的 setup/channel metadata 收敛而额外失效。
- **宿主升级自动受益**：setup 与 host-side config surfaces 会更稳定，但这不是当前 DingTalk 的主要风险点。

### Follow-up Need

- `2026.4.1` 相关事项以“维持现状 + 继续补测试”为主。
- 本轮无需为它单独开修复分支。

## 2026.4.2

### Upstream Facts

与本仓库最相关的变化有：

- 新增 `before_agent_reply` hook，允许插件在 LLM 运行前短路并返回 synthetic reply。
- 恢复并扩展 Task Flow substrate，同时为插件暴露 `runtime.taskFlow`。
- 渠道 session routing 更进一步收敛到 plugin-owned session-key surface。

### Current Repo Status

- DingTalk inbound 最终仍然通过宿主 reply runtime 分发：
  - [`src/inbound-handler.ts`](../../src/inbound-handler.ts)
- 因此 `before_agent_reply` 会在宿主升级后自动影响 DingTalk，无需额外接线。
- 本仓库没有直接消费 `runtime.taskFlow`。
- 本仓库的 sub-agent session-key 仍有 fallback 拼接逻辑：
  - [`src/targeting/agent-routing.ts`](../../src/targeting/agent-routing.ts)

### Impact Judgment

- **自动获益**：`before_agent_reply` 对 DingTalk 是宿主级增强，不是破坏性变化。
- **暂不需要强行接入**：`taskFlow` 对本仓库不是短期必选项。
- **存在清理机会**：上游路由 helper 更稳定后，本仓库应考虑移除自定义 session-key fallback。

### Follow-up Need

- 文档上要明确：宿主升级到 `2026.4.2+` 后，DingTalk 会自动进入 `before_agent_reply` 的宿主 hook 链。
- 代码上可在后续版本中清理 routing fallback，但这不是本轮最高优先级。

## 2026.4.5

### Upstream Facts

与本仓库最相关的变化有：

- 新增 per-channel `contextVisibility`，用于控制补充上下文、引用上下文、线程/历史上下文的可见性。
- 新增 `video_generate`、`music_generate` 等媒体工具，reply payload 更频繁地携带媒体结果。
- 宿主 outbound/reply payload 继续使用 `audioAsVoice` 语义而不是 channel-specific 的自定义别名。
- setup flow 增强了 plugin-config TUI prompts。

### Current Repo Status

#### 1. DingTalk 已经提供足够的上下文字段给宿主

本仓库会向宿主 reply runtime 注入：

- `QuotedRef`
- `ReplyToId`
- `ReplyToBody`
- `ReplyToSender`
- `ReplyToIsQuote`
- `UntrustedContext`

见：

- [`src/inbound-handler.ts`](../../src/inbound-handler.ts)

这意味着 DingTalk **具备被 `contextVisibility` 调度的基础**。

#### 2. 但本仓库自己的 schema / manifest / onboarding 还没有暴露 `contextVisibility`

当前以下位置都没有该字段：

- [`src/config-schema.ts`](../../src/config-schema.ts)
- [`openclaw.plugin.json`](../../openclaw.plugin.json)
- [`src/onboarding.ts`](../../src/onboarding.ts)

这会导致：

- 宿主虽然支持 `channels.dingtalk.contextVisibility`
- 但 DingTalk 插件自己的 schema 很可能不接受这个字段
- WebUI 与 setup flow 也不会提示这个能力

#### 3. 音频语义存在“偶然可用但未完全对齐”的问题

宿主 reply/outbound 现在传递的是 `audioAsVoice` 语义；但 DingTalk 插件当前主要读取：

- outbound adapter 中的 `asVoice`
- reply runtime 自定义媒体处理里仅抽 `mediaUrl` / `mediaUrls`

见：

- [`src/channel.ts`](../../src/channel.ts)
- [`src/inbound-handler.ts`](../../src/inbound-handler.ts)

好处是：

- DingTalk 会基于扩展名自动把 `.mp3/.amr/.wav` 识别成 `voice`
- 所以很多常见 TTS 音频仍然会“碰巧工作”

问题是：

- 这是依赖扩展名推断的宽松成功，不是明确兼容宿主 `audioAsVoice` 契约
- 一旦上游媒体工具更频繁地产生音频结果，DingTalk 的兼容不确定性会被放大

### Impact Judgment

- **这是最近几期里最需要主动对齐的一组变化。**
- `contextVisibility` 是明确的新宿主能力，而 DingTalk 当前没有把它暴露到自己的 config surface。
- `audioAsVoice` 是明确的宿主 payload 语义，而 DingTalk 只部分吸收了该语义。

### Follow-up Need

- 需要新增 `contextVisibility` 配置支持：
  - runtime schema
  - manifest schema / ui hints
  - onboarding / docs
  - tests
- 需要显式兼容 `audioAsVoice`：
  - outbound adapter
  - inbound reply delivery bridge
  - tests

## Cross-Version Alignment Themes

从 `2026.3.31` 到 `2026.4.5`，对 DingTalk 插件最重要的不是“多了多少功能”，而是宿主对以下三类边界的持续收敛：

1. **插件配置边界**
   - 插件自己的 schema / manifest / setup 必须把宿主支持的新 channel-level 语义显式暴露出来。

2. **reply payload 边界**
   - channel plugin 不应依赖私有字段名或历史别名，而应尽量贴齐宿主共享 payload 契约。

3. **session / routing 边界**
   - plugin 自己拼接 session key 的逻辑应逐步让位给 SDK helper，降低路由漂移风险。

## Recommended Alignment Decisions

## P0

- 对齐 `audioAsVoice` 到 DingTalk outbound / reply delivery。
- 为 DingTalk 增加 `contextVisibility` config 支持并补文档。

## P1

- 清理 sub-agent session-key fallback，改为直接使用稳定 SDK helper。
- 补一份面向用户/维护者的“宿主版本行为变化说明”。

## P2

- 评估是否在 DingTalk 内部显式消费 `runtime.taskFlow`。
- 若无明确需求，本轮先保持“不接入但记录原因”。

## TaskFlow Adoption Options

### Option A: Keep TaskFlow Out Of The Main DingTalk Runtime For Now

做法：

- 保持当前普通 inbound reply 主路径不变。
- 继续使用现有 session lock、reply strategy、card finalize 机制。
- 仅在文档中记录 TaskFlow 的潜在用途与重新评估条件。

优点：

- 改动最小，几乎没有回归风险。
- 不会把一个当前相对稳定的同步回复链路迁入更复杂的宿主状态机。
- 适合先解决更直接的 `audioAsVoice` 与 `contextVisibility` 问题。

缺点：

- AI Card stop / active run 的进程内状态问题仍然保留。
- 多进程或跨重启场景下，对 active run / stop 的观测与恢复能力仍然有限。
- 未来如果接 async media completion，再引入 TaskFlow 时会晚一些。

### Option B: Introduce TaskFlow Only For Card-Run Lifecycle

做法：

- 不碰普通 reply 主路径。
- 只把下面这类“跨阶段、可取消、可能跨重启”的状态迁到 TaskFlow：
  - AI Card active run
  - stop button cancel intent
  - pending finalize / recovery markers

优点：

- 这是 TaskFlow 在 DingTalk 插件里最有现实收益的切入点。
- 可以逐步替换当前的进程内 `card-run-registry`，降低多进程与重启后的失配风险。
- 让 stop 流程从“若干 Map + TTL + callback 拼装”变成宿主可观测的 lifecycle。

缺点：

- 仍然需要处理 DingTalk card callback 和宿主 flow owner/sessionKey 的映射。
- 会增加 card stop 相关测试与状态迁移复杂度。
- 如果设计不够克制，容易从“生命周期建模”滑到“整条 reply 链 TaskFlow 化”。

### Option C: Rebuild The Whole Reply Lifecycle Around TaskFlow

做法：

- 把普通流式 reply、card draft、stop、中间媒体、finalize 全部放到 TaskFlow 下管理。

优点：

- 理论上状态最统一。

缺点：

- 对当前仓库来说过度设计。
- 回归风险最高。
- 与本轮上游对齐目标不匹配。

### Recommendation

本轮对齐分支明确采用 **Option A：暂不接入 TaskFlow**。

原因：

- 当前最直接的宿主对齐缺口是 `audioAsVoice` 与 `contextVisibility`，它们都是用户立即可见的契约问题。
- 普通 DingTalk reply 主路径目前已经有 session lock、reply strategy 和 card finalize 保护；把这条主路径迁到 TaskFlow 的收益不足以覆盖额外迁移风险。
- AI Card run / stop 生命周期虽然是 TaskFlow 最可能带来收益的区域，但它已经超出这条 alignment 分支的最小闭环。

明确结论：

- **本轮落地**：完成 `audioAsVoice`、`contextVisibility`、sub-agent session-key 对齐，以及配套测试 / 文档。
- **本轮不做**：不在 DingTalk 插件中直接消费 `runtime.taskFlow`。
- **后续触发条件**：只有当 AI Card run / stop 出现跨重启恢复、跨 worker 迁移、或 card-run registry 明显成为维护瓶颈时，才为 “Option B: card-run lifecycle to TaskFlow” 单独开 spec/plan。
- **明确不建议**：把普通流式 reply 主路径整体迁入 TaskFlow。

## Non-Goals

- 本轮不改动 DingTalk 与钉钉平台 API 本身的协议实现。
- 本轮不把 `video_generate` / `music_generate` 做成 DingTalk 专属特性分支。
- 本轮不为了追新而强行引入 `taskFlow`，除非它能解决现有 DingTalk 痛点。

## Success Criteria

完成对齐后，应满足以下条件：

1. `channels.dingtalk.contextVisibility` 与 account-scoped 同名字段可以被 schema 接受，并在 manifest/WebUI 层可见。
2. 宿主通过共享 outbound/reply payload 传下来的 `audioAsVoice` 不再依赖扩展名“碰巧成功”。
3. 现有 DingTalk reply / quoted context / card stop 行为保持不回退。
4. 上游 `2026.3.31` 到 `2026.4.5` 中与 DingTalk 直接相关的变更，都有明确的“已对齐 / 自动受益 / 待对齐 / 暂缓”结论。
