# DingTalk 停止按钮替代 WS Client 路线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用原生命令 / 控制通道路由替代自定义 Gateway WebSocket `chat.abort` 客户端，同时保持停止按钮仍然是一个真正可用的“急停按钮”。

**Architecture:** 复用 OpenClaw 已有的 `/stop` 语义，而不是在 DingTalk 插件里额外维护一套 Gateway WS abort 协议。把 DingTalk 停止按钮建模成一个“native targeted command”：通过独立的 command session key 加 `CommandTargetSessionKey` 精确指向当前运行中的会话，并借鉴 Telegram 的 control lane 模式以及 Feishu 的卡片交互旁路模式。停止按钮必须绑定真实的 abort 能力，因此按钮点击路径需要绕开 DingTalk 当前普通消息的 session lock，直接进入 OpenClaw 的 fast-abort 处理链。

**Tech Stack:** TypeScript、DingTalk 插件 runtime helper、OpenClaw `command-auth` / `reply-runtime` 公共导出、Vitest

---

## 背景研究

### 为什么当前 PR 会引入一个 Gateway WS client

- OpenClaw 本身已经支持通过 `/stop`、`stop` 及相关 abort trigger 中止当前运行。
- 但这个能力目前主要挂在“入站文本消息 / 命令”处理链上，而不是暴露成类似 `runtime.abortSession(sessionKey)` 这样的公共插件 runtime API。
- `PluginRuntime` 虽然暴露了 `subagent.run / wait / getSessionMessages / deleteSession` 以及大量 `channel.*` helper，但没有直接的 session abort 方法。
- DingTalk 的卡片按钮回调属于 out-of-band 交互事件，不会天然进入现有 `/stop` 处理链，因此当前 PR 选择通过自建 Gateway WebSocket client 去调用 `chat.abort`。

### Telegram 的实现路径

- Telegram 全局使用 `sequentialize(getTelegramSequentialKey)` 来串行化更新。
- `getTelegramSequentialKey()` 对 `/stop` 及一组 abort trigger 做了特殊分流：它们走 `telegram:<chatId>:control`，而不是普通的 `telegram:<chatId>`。
- Telegram 的 callback button 很多时候会被翻译成 synthetic text message 再送回 `processMessage(...)`，但这个 callback 路径本身仍然先经过 middleware 链；也就是说，synthetic text 出现得晚于 sequentialize key 的计算。
- 结论：
  - Telegram 证明了“交互按钮 -> synthetic command/message”这条模式是可行的。
  - Telegram 同时也证明了“急停”需要单独的 control lane，而不是和普通聊天消息共用同一个串行键。

### Feishu 的实现路径

- Feishu 的普通入站消息 `im.message.receive_v1` 会进入 `monitor.account.ts` 里的 per-chat 串行队列。
- 但 `card.action.trigger` 并不走这条队列，而是直接分发到 `handleFeishuCardAction(...)`。
- `handleFeishuCardAction(...)` 会把按钮点击转换成 synthetic command：构造 synthetic message event，然后直接调用 `handleFeishuMessage(...)`。
- 结论：
  - Feishu 证明了卡片 / 按钮交互完全可以复用已有命令语义。
  - 关键前提是这条交互路径不要被强行塞回普通 per-chat 队列，否则“急停”实时性会下降。

### Discord 的实现路径

- Discord 组件交互会优先尝试 plugin interactive handler。
- 如果组件本身携带显式 `callbackData`，Discord 会保留这个 payload，把它重新路由到 session pipeline 中作为 `eventText`。
- 如果组件没有显式 callback payload，Discord 才回退到诸如 `Clicked "Label".` 这样的描述性文本。
- 结论：
  - Discord 说明，当一个交互应该表现得像命令时，保留原始 callback payload 作为命令文本是一个成熟模式。

### Slack 的实现路径

- Slack block actions 更偏向 plugin interactive handler，处理不了时再 enqueue structured system event。
- 相比 Telegram / Feishu / Discord，Slack 更偏事件驱动，而不是命令驱动。
- 结论：
  - Slack 更适合作为反例参考，不是 DingTalk stop button 的最优借鉴对象。

### 对 DingTalk 的直接结论

- 问题不在 synthetic command 这种模式本身。
- 问题在于 DingTalk 当前插件的锁放置位置：`handleDingTalkMessage(...)` 会先拿普通 `sessionKey` 的锁，再进入 dispatch。
- 如果停止按钮仅仅被翻译成一条普通 synthetic `/stop`，并重新走现有 DingTalk 入站路径，它大概率会排在自己想终止的那次 run 后面。
- 因此，替代 WS client 的路线不能是“把按钮点击变成普通 synthetic `/stop` 然后照常走现有入站链”。
- 正确替代路线应是：“native targeted stop command + dedicated control lane”。

### 为什么不是简单照搬 Telegram，而是要做混合式设计

- 如果只看 `stop` 这个动作，Telegram 提供了最关键的能力：`control lane` 与 `CommandTargetSessionKey`。这两点正是 DingTalk 当前最缺的“急停通道”。
- 但如果放眼未来更多 cardAction，Telegram 的模式并不完整。它更像“如何为命令开控制通道”，而不是“如何组织一个可扩展的交互动作框架”。
- Feishu 的价值在于它把 card action 当成独立入口：
  - 自己负责 payload 解析、验证、幂等、路由
  - 根据 action 类型决定是本地处理、synthetic command，还是其他交互流程
- 因此，对 DingTalk 更合理的借鉴不是二选一，而是混合：
  - **交互入口层**借鉴 Feishu
  - **控制命令层**借鉴 Telegram

### 面向未来 cardAction 的统一抽象

- stop 只是 cardAction 的一种，并且是控制语义最强的一种。
- 后续还可能出现：
  - `steer`：在当前 run 过程中插入新的纠偏信息，要求 agent 按新的补充上下文继续
  - `approve` / `deny`：审批类动作，既可能中断当前流程，也可能释放下一阶段执行
  - `retry` / `regenerate`：重新尝试当前步骤或重新生成当前答案
  - `inject note`：仅追加一条补充上下文，不要求立即打断当前 run
  - `refresh` / `collapse` / `hide`：只影响卡片 UI 的本地动作
- 如果仍然围绕“stop-only”设计，就会很快遇到第二套、第三套旁路逻辑，最后把 `TOPIC_CARD` 回调变成一个难以维护的 if/else 集合。
- 因此，这次设计建议直接上升为“通用 cardAction 底座”，stop 只是第一个落地动作。

## 文件结构

- Create: `src/command/card-stop-command.ts`  
  责任：把 DingTalk 停止按钮点击转换成 native targeted `/stop` 命令，使用 `commandSessionKey + CommandTargetSessionKey` 模型。
- Create: `tests/unit/card-stop-command.test.ts`  
  责任：验证 stop-command bridge 构造出的控制 session、目标 session、payload 语义都正确。
- Modify: `src/card/card-action-handler.ts`  
  责任：把当前 Gateway WS abort 调用入口替换为 native stop-command bridge，同时保留 owner 校验与 `outTrackId` 查找。
- Modify: `src/card/card-stop-handler.ts`  
  责任：把停止编排从 `gateway abort -> finalize -> hide button` 改成 `native targeted stop dispatch -> finalize -> hide button`，同时保留 stop-request 标记与本地 controller.stop()。
- Modify: `src/inbound-handler.ts`  
  责任：提取或共享 stop-command bridge 所需的最小 session/context 构造逻辑，但不能把 stop button 重新路由到普通带锁的 inbound path。
- Modify: `src/reply-strategy-card.ts`  
  责任：继续保留 stop-request guard，确保 stop 发出后后续 card stream/finalize 更新都成为 no-op。
- Modify: `src/card-service.ts`  
  责任：给 `finishStoppedAICard` 加终态短路。
- Delete: `src/shared/gateway-client.ts`  
  责任：在 native abort 路线替换完成后移除自定义 WS 控制面客户端。
- Modify: `tests/unit/card-action-handler.test.ts`  
  责任：把原先对 WebSocket / `chat.abort` 的断言改成对 native stop-command bridge 的断言。
- Modify: `tests/unit/inbound-handler.test.ts`  
  责任：补充回归测试，证明 stop button 不会因为 DingTalk 普通 session lock 而排队失效。
- Modify: `README.md`  
  责任：把停止按钮实现说明改为“原生 `/stop` 语义复用”而不是 “Gateway WS `chat.abort`”。

## 设计草案

### 建议的停止路径

1. DingTalk card callback 先通过 `outTrackId -> CardRunRecord` 找到当前运行中的卡片。
2. 插件立即：
   - `markCardRunStopRequested(...)`
   - 调 `controller.stop()` 停掉本地 draft streaming / throttle
3. 不再调用自定义 Gateway WS client，而是分发一个 native targeted `/stop` 命令：
   - `SessionKey = agent:<agentId>:dingtalk:card-stop:<user-or-chat>`
   - `CommandTargetSessionKey = 原始 route.sessionKey`
   - `CommandSource = "native"`
   - `Body` / `RawBody` / `CommandBody` 都为 `/stop`
4. OpenClaw 现有 fast-abort 链接手该命令，执行：
   - `abortEmbeddedPiRun(sessionId)`
   - 清 followup queue
   - 为目标 session 持久化 abort cutoff 元数据
5. abort 命令发出后，DingTalk 再 finalize 卡片并隐藏停止按钮。

### 建议的通用 cardAction 技术底座

建议把 DingTalk cardAction 明确分成四条 lane，而不是只有 stop 一种特殊路径：

#### 1. `local lane`

- 只修改卡片 UI 或本地状态
- 不进入 session，不影响 agent 执行
- 例子：
  - 隐藏按钮
  - 翻页
  - 展开 / 收起
  - 本地 ack / 本地状态标记

#### 2. `control lane`

- 抢占式控制动作
- 必须绕开普通聊天消息锁/队列
- 例子：
  - `stop`
  - `reset`
  - `approve`
  - `deny`
  - 取消当前工具执行
- 技术模型：
  - `commandSessionKey`
  - `CommandTargetSessionKey`
  - `CommandSource = "native"`

#### 3. `steer lane`

- 也是抢占式，但语义不是“停止”，而是“纠偏并继续”
- 典型场景：
  - “不是这个目录，是另一个路径”
  - “不要删文件，只做 dry-run”
  - “忽略上一张图，按这段文字继续”
  - “把这条用户补充当作当前 run 的更正上下文”
- 这类动作不能退化成普通 follow-up，也不适合只是 assistant note 注入
- 推荐语义上靠近 `sessions.steer`：打断 / 插入 / 继续，而不是纯追加

#### 4. `inject lane`

- 非抢占式上下文补充
- 适合“希望 agent 下一轮能看到”，但不要求立即打断当前 run 的信息
- 例子：
  - 外部观察结果
  - 诊断日志
  - 卡片状态提示
  - 低优先级补充说明
- 更接近 `enqueueSystemEvent(...)` 或类似 transcript / note 注入

### 为什么 `steer` 不能简单等于 `inject`

- `inject` 的语义是“补充一条信息”，通常不要求立即打断正在运行的 agent。
- `steer` 的语义是“用户正在纠正 agent”，它需要高优先级地影响当前 run。
- 两者如果混用，最终要么：
  - `steer` 不够及时，失去纠偏价值
  - 要么 `inject` 过于侵入，破坏正常对话流
- 所以这两类 action 必须分 lane 处理。

### 推荐的模块边界

- `src/card-action/runtime.ts`
  - 统一入口：解析 action、鉴权、幂等去重、路由到不同 lane
- `src/card-action/lanes/local.ts`
  - 本地 UI 动作
- `src/card-action/lanes/control.ts`
  - stop / approve / deny / reset 等控制命令
- `src/card-action/lanes/steer.ts`
  - 纠偏、补充上下文并要求立即生效的动作
- `src/card-action/lanes/inject.ts`
  - 非抢占式上下文注入

这样 stop 不再是整个设计的中心，而只是 `control lane` 中第一个实现的动作。

### 为什么这条路线优于自定义 WS client

- 复用 `/stop` 的现有 abort 语义，而不是在 DingTalk 插件里再维护第二套 abort 协议。
- 避免 DingTalk 插件自己承担 Gateway URL / auth / device-auth / remote mode 的兼容性工作。
- 保持停止按钮语义诚实：按钮仍然代表“停止当前 run”，而不是“仅停止卡片 UI 更新”。
- 与 Telegram 已经验证过的 native command targeting 模式一致。

### 为什么这条路线仍然需要 DingTalk 侧重构

- stop-command bridge **不能**简单回调现有的 `handleDingTalkMessage(...)` 并使用普通 session key。
- 否则问题会原样复现：synthetic `/stop` 会被排在它想终止的 run 后面。
- bridge 必须直接构造 native command context，使用独立 command/control session key + `CommandTargetSessionKey`。
- 同理，如果后续实现 `steer`，也不能简单回调普通 inbound path；否则“纠偏”会在最需要及时生效的时候排队失效。

### 可直接复用的 OpenClaw 公共 helper

- OpenClaw 已有 `resolveNativeCommandSessionTargets(...)`，并通过 `plugin-sdk/command-auth` 暴露。
- 这个 helper 正好提供 DingTalk 所需的双键模型：
  - 一个 command session key
  - 一个 target session key
- DingTalk 应该直接复用这套模型，而不是自行发明 stop-session key 格式。

### 本方案的非目标

- 不重做整个 DingTalk inbound routing。
- 不引入第二种“仅停 UI”的 stop mode。
- 不长期同时维护 native stop 路线和自定义 WS client 两条路径。
- 不通过 deep import 私有 OpenClaw 内部模块来拿 abort helper；若已有公共 helper，可优先复用公共导出。
- 本阶段不要求一次性把所有 cardAction 都实现完成，但要求留下可扩展的 lane 架构与模块边界。

## Tasks

### Task 1: 增加 Native Stop Command Bridge

**Files:**
- Create: `src/command/card-stop-command.ts`
- Test: `tests/unit/card-stop-command.test.ts`

- [ ] **Step 1: 确认可用的 OpenClaw 公共 helper 导入路径**

确认本仓库可以通过公共 Plugin SDK surface 导入 `resolveNativeCommandSessionTargets`。

Run: `rg -n "resolveNativeCommandSessionTargets" src package.json`
Expected: 本仓库当前未使用该 helper；helper 可从 `openclaw/plugin-sdk/command-auth` 导入

- [ ] **Step 2: 先写失败测试**

覆盖以下场景：
- bridge 会生成独立的 command session key
- bridge 会把原始 session 填入 `CommandTargetSessionKey`
- bridge 会把 `/stop` 写入 `Body` / `RawBody` / `CommandBody`
- bridge 会标记 `CommandSource = "native"`

- [ ] **Step 3: 用公共 helper 实现 bridge**

在 `src/command/card-stop-command.ts` 中实现类似如下函数：

```ts
export async function dispatchDingTalkCardStopCommand(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  accountId: string;
  agentId: string;
  commandUserId: string;
  targetSessionKey: string;
  conversationLabel: string;
  senderId?: string;
  senderName?: string;
  log?: Logger;
}): Promise<void>
```

优先复用：
- `resolveNativeCommandSessionTargets(...)`
- `finalizeInboundContext(...)`
- `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)`

- [ ] **Step 4: 跑 bridge 测试**

Run: `pnpm test tests/unit/card-stop-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/command/card-stop-command.ts tests/unit/card-stop-command.test.ts
git commit -m "feat: add dingtalk native stop command bridge"
```

### Task 2: 用 Native Stop Bridge 替换 Gateway WS Abort

**Files:**
- Modify: `src/card/card-action-handler.ts`
- Modify: `src/card/card-stop-handler.ts`
- Test: `tests/unit/card-action-handler.test.ts`

- [ ] **Step 1: 先补失败测试**

覆盖：
- stop button 走 native stop bridge，而不是 Gateway WS abort
- owner 校验仍然生效
- 缺失 `outTrackId` 时仍然 fail closed
- stop 成功后仍会 finalize 卡片并隐藏按钮

- [ ] **Step 2: 移除 stop path 上的 Gateway WS 依赖**

修改 `card-stop-handler.ts`：
- 保留 `markCardRunStopRequested(...)`
- 保留 `controller.stop()`
- 改为调用 native stop bridge
- 再 finalize stopped card
- 再 hide stop button

- [ ] **Step 3: 更新 stop 测试断言**

把 `tests/unit/card-action-handler.test.ts` 里基于 WebSocket 帧和 `chat.abort` 的断言改成 bridge dispatch 断言。

- [ ] **Step 4: 跑 stop 测试**

Run: `pnpm test tests/unit/card-action-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/card/card-action-handler.ts src/card/card-stop-handler.ts tests/unit/card-action-handler.test.ts
git commit -m "refactor: route dingtalk stop button through native stop command"
```

### Task 3: 保证 DingTalk 锁模型下仍然具备“急停”语义

**Files:**
- Modify: `src/inbound-handler.ts`
- Modify: `src/reply-strategy-card.ts`
- Test: `tests/unit/inbound-handler.test.ts`

- [ ] **Step 1: 先写失败回归测试**

新增测试，覆盖：
- 一条普通消息已经占有当前 DingTalk session lock
- stop button 作用于同一 session
- stop command 仍然能通过自己的 control session 立即发出
- 原始卡片会进入 stopped/finalize 状态，而不是等普通锁完全释放后才生效

- [ ] **Step 2: 明确 stop-button 不走普通 inbound lock path**

不要把 stop button 再路由到普通 `handleDingTalkMessage(...)`。

如果 `inbound-handler.ts` 里有某些 context-building 逻辑必须复用，只抽取最小 helper，不能把 stop-button 重新塞进普通锁模型。

- [ ] **Step 3: 保持 reply strategy 的 stop-safe 行为**

继续保留 `reply-strategy-card.ts` 当前的 `isStopRequested()` guard，确保 stop 发出后后续 answer/tool/final chunk 不再继续刷新卡片。

- [ ] **Step 4: 跑锁模型回归测试**

Run: `pnpm test tests/unit/inbound-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inbound-handler.ts src/reply-strategy-card.ts tests/unit/inbound-handler.test.ts
git commit -m "test: preserve emergency stop semantics under dingtalk session locking"
```

### Task 4: 移除自定义 Gateway Client 并更新文档

**Files:**
- Delete: `src/shared/gateway-client.ts`
- Modify: `README.md`
- Modify: `src/card-service.ts`
- Test: `tests/unit/card-service.test.ts`

- [ ] **Step 1: 先给 card-service 补失败测试**

覆盖：
- 当卡片已处于终态时，`finishStoppedAICard()` 不再重复发 finalize

- [ ] **Step 2: 实现终态 guard 并删除 Gateway client**

给 `finishStoppedAICard()` 增加终态短路，然后删除不再使用的 `gateway-client.ts`。

- [ ] **Step 3: 更新 README**

文档改为说明：
- 停止按钮复用的是 native `/stop` 语义
- 不再依赖自定义 Gateway WS client
- 按钮仍代表真实 abort 能力，而不是仅停止 UI

- [ ] **Step 4: 跑最小验证集**

Run:
- `pnpm test tests/unit/card-service.test.ts`
- `pnpm test tests/unit/card-action-handler.test.ts`
- `pnpm test tests/unit/inbound-handler.test.ts`
- `pnpm type-check`

Expected:
- tests PASS
- type-check PASS

- [ ] **Step 5: Commit**

```bash
git add README.md src/card-service.ts src/card/card-action-handler.ts src/card/card-stop-handler.ts src/reply-strategy-card.ts src/inbound-handler.ts tests/unit/card-service.test.ts
git rm src/shared/gateway-client.ts
git commit -m "refactor: replace dingtalk gateway ws abort with native stop path"
```

## Open Questions

- `resolveNativeCommandSessionTargets(...)` 本身是否足够，还是 DingTalk 还需要一个很薄的本地 helper 来规范 control session 命名与 user/chat 维度？
- DingTalk 的 control session key 前缀是复用 Telegram 风格（例如 `dingtalk:card-stop`）还是采用更通用的 `dingtalk:control`？
- 如果后续 DingTalk 还会加入 retry / approve / deny 等 card action，这个 bridge 是否应提升为通用的 `src/command/card-native-command.ts`，而不是 stop-only 文件？
- `steer lane` 是否应直接映射到 OpenClaw 现有 `sessions.steer` 语义，还是在 DingTalk 插件内先定义更窄的 native steer command？
- 对于“用户补充上下文但不想打断当前 run”的按钮动作，优先落到 `inject lane` 还是落到后续下一轮 follow-up 机制？

## Recommendation

- 不建议只围绕 stop 做孤立修复，而应顺手把 cardAction 抽象提升为“lane-based 流控底座”。
- 具体借鉴策略：
  - **交互入口层**借鉴 Feishu：card action 独立入口、独立解析、独立路由
  - **控制命令层**借鉴 Telegram：control lane、targeted command、急停通道
- 优先考虑这条 native-command/control-lane 路线，而不是继续维护自定义 Gateway WS client。
- 如果这条控制通道路线最终证明对 DingTalk 改动过大，也优先考虑推动 OpenClaw 上游暴露正式的 runtime abort / steer API，而不是让 DingTalk 插件长期自带一套协议客户端。
