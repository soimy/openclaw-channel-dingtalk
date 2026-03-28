# 多 Bot 内部 Reroute 可行性分析与 PR317 多 Agent 方案对比

## 1. 背景

当前仓库已经支持：

- 多个钉钉账号（`channels.dingtalk.accounts`）
- 按 `accountId` 加载不同账号配置
- 入站消息在 `accountId` 维度进入处理链
- 出站发送显式指定 `accountId`

围绕“多机器人、多智能体”的实现，当前存在两条不同方向：

1. **单 Bot 多 Agent**：一个钉钉机器人作为统一入口，在插件内解析 `@agent` 并把消息转给不同 agent。对应 PR #317。
2. **多 Bot 内部 Reroute**：每个 bot 固定绑定一个 agent，入口 bot 收到消息后，插件内部决定是否把消息转交给另一个 bot/agent 处理，并最终由目标 bot 发出回复。

本文目标：

- 评估“多 bot 内部 reroute”在当前插件中的可行性
- 与 PR #317 的“单 bot 多 agent”方案做设计、架构和工程对比
- 给出推荐方向

---

## 2. 结论摘要

### 2.1 多 Bot 内部 Reroute：可行

在“**bot 固定绑定 agent**”的前提下，多 bot 内部 reroute 是可行的，而且从当前插件架构看，**明显比 PR #317 的单 bot 多 agent 更稳妥**。

成立前提：

- `bot_A` 收到消息后，插件内部可以决定目标 `targetAccountId = bot_B`
- `bot_B` 对应唯一 agent，不需要在一个 bot 下继续二次解析 `@agent`
- 最终回复由 `bot_B` 对用户或群发出

### 2.2 PR317 方向：产品合理，但不适合作为当前主线方案

PR317 解决的是“一个 bot 内如何模拟多 agent”的问题，产品交互自然，但：

- 路由职责落在 channel plugin 层
- 依赖 runtime 未公开或未稳定的边界
- 对 DingTalk 文本 `@mention` 的识别依赖启发式
- 对 OpenClaw 内部 session 文件格式产生耦合

因此更适合视为**实验性原型**，不适合直接作为当前仓库的长期主线设计。

### 2.3 推荐方向

如果需求是“多 bot、多 agent 之间在插件内部转交处理”，推荐采用：

- **bot = agent identity**
- **内部 handoff / reroute**
- **目标 bot 负责最终出站**

不推荐继续在当前插件层扩大 `#317` 的单 bot 多 agent 方案。

---

## 3. 当前代码基础与可行性依据

当前插件已经具备多 bot 内部 reroute 的基础能力。

### 3.1 入站按 `accountId` 进入

`src/channel.ts` 在每个 Stream 连接回调中，带着当前账号的 `accountId` 调用 `handleDingTalkMessage`：

- `src/channel.ts`

这意味着每个 bot 的入站上下文天然已经被账号维度隔离。

### 3.2 账号配置按 `accountId` 读取

`src/config.ts` 的 `getConfig(cfg, accountId)` 已支持按账号读取配置：

- `accountId` 命中 `channels.dingtalk.accounts[accountId]` 时，返回该 bot 的配置
- 否则返回 channel 级默认配置

这为“同一插件运行多个 bot”提供了统一配置入口。

### 3.3 出站已支持显式指定 `accountId`

`src/channel.ts` 的 outbound 能力已经按 `accountId` 取配置并调用发送逻辑：

- `outbound.sendText`
- `outbound.sendMedia`

因此“入口 bot 和出口 bot 不是同一个 bot”在发送侧并不是概念问题。

### 3.4 当前处理链以统一 reply pipeline 为核心

`src/inbound-handler.ts` 当前流程本质是：

1. 解析入站消息
2. 构造统一上下文
3. 记录 session
4. 调用 `dispatchReplyWithBufferedBlockDispatcher`
5. 通过 `deliver` 回调把结果发回钉钉

这意味着只要能在“构造统一上下文”之前决定目标 bot / agent，就可以把 reroute 做成一个清晰的中间层。

---

## 4. 多 Bot 内部 Reroute 的推荐语义

### 4.1 推荐问题定义

推荐限定为以下模型：

- 每个 bot 固定绑定一个 agent
- 不在 bot 内部再做 `@agent` 二次路由
- reroute 只解决“这条消息应由哪个 bot/agent 负责”

推荐示例：

- `bot_frontdesk` 收到消息
- 根据群、用户、指令、规则或策略，决定应转交给 `bot_growth`
- 由 `bot_growth` 对应的 agent 处理
- 最终由 `bot_growth` 发出回复

### 4.2 不推荐的问题定义

不建议把“多 bot reroute”扩展成：

- bot 内部再管理多个 agent
- bot 与 bot 之间多轮互相调用
- 在 channel plugin 层做复杂 agent orchestration

这些能力一旦做深，本质上已经不是“渠道适配”，而是“编排引擎”。

---

## 5. 推荐实现路径

### 5.1 关键原则

**不要伪造目标 bot 的钉钉原始入站 payload。**

推荐做法是：

1. 使用入口 bot 完成原始 DingTalk payload 的解包
2. 完成引用恢复、媒体下载、权限检查、会话上下文提取
3. 形成插件内部的标准化消息对象
4. 只把“标准化后的消息”交给目标 bot/agent

原因：

- 引用消息恢复、下载码、文件缓存、`quote-journal` 都是入口 bot 视角下最完整
- 目标 bot 未必拥有相同的入站下载能力或原始消息上下文
- 直接伪造另一 bot 的 inbound payload 容易污染 `accountId`、session、媒体和引用语义

### 5.2 推荐新增内部信封

建议新增内部 handoff 对象，例如：

```ts
type InternalRerouteEnvelope = {
  ingressAccountId: string;
  targetAccountId: string;
  conversationId: string;
  peerKind: "direct" | "group";
  senderId: string;
  senderName?: string;
  text: string;
  mediaPath?: string;
  mediaType?: string;
  quotedText?: string;
  traceId: string;
  hopCount: number;
};
```

这个对象应只承载**标准化后的消息语义**，不承载原始 DingTalk callback 细节。

### 5.3 推荐处理流程

#### 阶段 A：Ingress 归一化

入口 bot 正常接收消息后：

1. 解析文本 / 富文本 / 引用 / 媒体
2. 使用入口 bot 的配置完成下载和恢复
3. 形成标准化消息

#### 阶段 B：Reroute 决策

引入 `reroutePolicy` 或 `botHandoffResolver`：

- 输入：`ingressAccountId + conversationId + senderId + normalizedMessage`
- 输出：`targetAccountId`

如果未命中规则，则继续由当前 bot 处理。

#### 阶段 C：目标 bot / agent 处理

使用 `targetAccountId`：

1. 读取目标 bot 配置
2. 解析目标 bot 对应 agent 的 sessionKey
3. 构造目标上下文
4. 调统一 reply pipeline

#### 阶段 D：目标 bot 出站

在 `deliver` 阶段使用目标 bot 的配置发送消息。

注意：

- **不能复用入口 bot 的 `sessionWebhook`**
- 如果目标 bot 与入口 bot 不同，应使用目标 bot 的主动发送能力

---

## 6. 关键约束与风险

### 6.1 目标 bot 无法复用入口 `sessionWebhook`

当前 `sendBySession` 依赖当前入站消息提供的 `sessionWebhook`。该 webhook 只属于当前 bot 当前会话，不属于其他 bot。

因此：

- 同 bot reroute：可以继续使用 `sessionWebhook`
- 跨 bot reroute：必须使用目标 bot 的主动发送能力

这意味着“跨 bot reroute”虽然不依赖 bot-to-bot 入站链路，但**最终回复仍然依赖目标 bot 的出站权限**。

### 6.2 群聊优先，私聊风险更高

跨 bot reroute 在群聊场景最容易成立：

- 只要目标 bot 也在同一个群里
- 目标 bot 能向该群主动发送消息

私聊场景约束更大：

- 目标 bot 未必与该用户建立过会话
- 主动私聊发送可能受权限或可见范围限制

因此推荐优先支持：

- **群聊内的跨 bot reroute**

不建议第一期就承诺：

- **私聊跨 bot reroute**

### 6.3 群聊主动发送不等价于“当前回合回复”

跨 bot reroute 如果走主动发送：

- 目标 bot 无法天然继承“当前回合 reply”的会话感
- 不能保证与入口 bot 的回复呈现完全一致
- 在钉钉群里更像“另一个 bot 主动在群里发言”

这在产品上通常是可接受的，但必须在设计上明确。

### 6.4 仍需做循环保护

即使不依赖钉钉 bot-to-bot 入站链路，也应在插件内部防止：

- `bot_A -> bot_B -> bot_A`
- 多次 handoff 形成环

建议：

- `hopCount`
- `traceId`
- `maxHops = 1 or 2`

作为第一期的硬限制。

---

## 7. PR317 单 Bot 多 Agent 方案概要

PR317 的核心路径是：

1. 单个 bot 收到群消息
2. 插件内解析 `@agent名`
3. 匹配 `cfg.agents.list`
4. 对匹配到的 agent 构造独立 sessionKey
5. 递归调用 `handleDingTalkMessage`
6. 回复仍由同一个 bot 发出，只是在文本前加 `[AgentName]`

其能力本质上是：

- **同一个 bot 对外模拟多个 agent**

而不是：

- 多个 bot 之间真正的消息互通

---

## 8. PR317 的优势

### 8.1 单 bot 用户体验自然

用户只需要面对一个 bot，在群里通过：

- `@frontend`
- `@dba`

这类方式就能切换角色，交互成本低。

### 8.2 不需要多个 bot 同时入群

组织侧、运维侧更轻量：

- 不需要为每个角色单独创建 bot
- 不需要给多个 bot 配置进群和可见范围

### 8.3 当前回合回复能力更强

因为回复仍由入口 bot 完成，所以它可以继续使用：

- 当前回合 `sessionWebhook`
- 当前 bot 持有的卡片流式能力
- 当前 bot 视角下的会话上下文

这一点是多 bot 跨账号 reroute 很难完全复制的。

---

## 9. PR317 的主要问题

### 9.1 路由职责放错层

PR317 在 channel plugin 层直接实现 `@mention -> agent` 路由，这与 framework 级 `bindings` / routing 能力天然冲突。

问题不在于“能不能跑”，而在于：

- 以后其他渠道也想支持 `@agent` 时，会复制同类逻辑
- agent 路由从框架能力退化成各插件私有能力

### 9.2 依赖未稳定 runtime 边界

PR317 为 sub-agent 模式自己构造 route，并调用 `buildAgentSessionKey`。但当前公开 plugin runtime 文档中稳定暴露的 routing 能力只有 `resolveAgentRoute`。

这也是该方案当前 `type-check` 失败的核心原因之一。

### 9.3 文本 `@mention` 识别不稳定

PR317 文本模式对 `@mention` 的识别依赖：

- 正则提取名字
- `atUsers` 只给出 `dingtalkId`
- 无法把展示名和真实用户精确对应

因此只能使用保守启发式：

- 有真实用户被 @ 时，不再轻易报告“agent 不存在”

这保证了不误报，但牺牲了精确性。

### 9.4 直接读取 OpenClaw 内部 session 文件

`session-history.ts` 直接读取 `sessions.json` 和 `.jsonl` 来构造群聊历史。

这会带来：

- 对内部文件格式的硬耦合
- 与插件自有存储不一致
- runtime 演进时脆弱

### 9.5 它解决的是“角色模拟”，不是“bot identity”

PR317 中所有回复最终仍来自同一个 bot，只是文本前缀不同。

所以它更适合：

- “一个 bot 扮演多个角色”

不适合：

- “多个 bot 具有不同身份并互相转交消息”

---

## 10. 多 Bot 内部 Reroute 的优势

### 10.1 身份模型更清晰

在该方案里：

- `bot = agent`
- `accountId = bot identity`

这与当前插件的多账号架构天然一致。

### 10.2 不需要解析 `@agent`

避免了 PR317 最脆弱的一环：

- 文本 `@mention` 识别
- 富文本与纯文本差异
- 真实用户 / agent 名的模糊判断

### 10.3 与 framework bindings 更一致

多 bot 方案天然更接近：

- `accountId -> agent`

这与现有 OpenClaw routing / bindings 心智是一致的。

### 10.4 更适合真正的“bot 间转交”

如果业务需求本身就是：

- 前台 bot 收消息
- 后台专业 bot 回答

那么多 bot 内部 reroute 直接对应这个目标，语义清晰。

---

## 11. 多 Bot 内部 Reroute 的不足

### 11.1 目标 bot 必须具备对外发送条件

目标 bot 必须：

- 在目标群中可发言
- 或对目标用户具有私聊发送条件

否则 reroute 成功，最终发送仍会失败。

### 11.2 跨 bot 失去当前回合 `sessionWebhook`

这会带来：

- 回合级“直接回复”语义变弱
- 需要走主动发送
- 某些精细回复体验可能不如入口 bot 原地回复

### 11.3 运维成本更高

需要：

- 多个 bot 的钉钉配置
- 多个 bot 的可见范围和权限
- 多个 bot 的账号生命周期管理

---

## 12. 对比结论

| 维度 | 多 Bot 内部 Reroute | PR317 单 Bot 多 Agent |
| --- | --- | --- |
| 身份模型 | 清晰，`bot = agent` | 模拟型，`一个 bot 扮演多个 agent` |
| 与现有 account 模型一致性 | 高 | 低 |
| 与 framework routing / bindings 一致性 | 高 | 低 |
| `@mention` 解析复杂度 | 低 | 高 |
| 依赖未稳定 runtime API | 低 | 高 |
| 对内部 session 文件耦合 | 可避免 | 明显存在 |
| 用户体验 | 多 bot 可感知，身份明确 | 单 bot 更自然 |
| 群聊场景适配 | 强 | 强 |
| 私聊场景适配 | 中到弱 | 中 |
| 维护成本 | 中 | 高 |
| 适合作为当前主线 | 是 | 否 |

---

## 13. 建议方案

### 13.1 建议主线

如果当前目标是“多 bot 之间的内部消息转交”，建议走：

- **多 Bot 内部 Reroute**
- **bot 固定绑定 agent**
- **群聊优先**

### 13.2 不建议当前主线继续扩展 PR317

除非 OpenClaw framework 后续提供：

- 明确的 `agentId` 指定路由能力
- 稳定的 sessionKey 构建 API
- 统一的 `@agent` 语义

否则不建议继续在本插件层扩大 `PR317` 的职责范围。

### 13.3 推荐的第一期边界

第一期建议只做：

1. 群聊场景
2. `maxHops = 1`
3. `bot_A -> bot_B` 单次 handoff
4. 目标 bot 直接主动发最终回复
5. 不做多轮 bot 间内部会话
6. 不做单 bot 多 agent 混合模式

---

## 14. 实施建议

建议后续实现分三步：

### 第一步：新增 reroute 配置与解析器

例如：

```json5
{
  "channels": {
    "dingtalk": {
      "reroute": {
        "enabled": true,
        "rules": [
          {
            "fromAccountId": "frontdesk",
            "toAccountId": "growth-bot",
            "when": {
              "conversationId": "cidxxxx"
            }
          }
        ]
      }
    }
  }
}
```

### 第二步：在入站标准化之后插入 handoff

入口 bot 完成：

- 消息解析
- 引用恢复
- 媒体下载
- 权限判断

然后再决定是否 handoff。

### 第三步：目标 bot 统一走主动发送

跨 bot 的最终回复统一使用目标 bot 的主动发送能力，避免误用入口 bot 的 `sessionWebhook`。

---

## 15. 最终建议

如果仓库下一阶段要在“多机器人、多智能体”上继续投入，建议采用以下判断：

- **要做“多 bot 互通 / 转交”**：优先做多 bot 内部 reroute
- **要做“一个 bot 下多个角色”**：暂不作为主线，仅保留为实验方案
- **要做真正的 agent 编排能力**：应上收至 OpenClaw framework，不应继续压在 channel plugin 层

---

**版本**: v1.0  
**日期**: 2026-03-16
