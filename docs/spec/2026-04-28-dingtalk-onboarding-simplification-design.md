# DingTalk Onboarding Simplification Design

## 背景

PR #537 已为 DingTalk setup wizard 增加 Device Flow 自动注册能力。真机验证证明自动注册可以创建机器人、写入 `clientId` / `clientSecret`，并在 gateway restart 后连接 DingTalk Stream。

当前 `src/onboarding.ts` 在拿到凭证后继续询问大量配置项，包括 card、DM allowlist、media allowlist、displayNameResolution、contextVisibility、重连、mediaMax、journal TTL 等。这个流程偏长，且把新用户很难在 onboarding 阶段获得的 DingTalk ID 输入提前暴露出来。

本设计目标是在不改变 runtime 配置语义的前提下，简化 onboarding，并补齐多账号配置流程与指引。

## 参考

- 本插件配置来源：
  - `src/config-schema.ts`
  - `openclaw.plugin.json`
  - `src/onboarding.ts`
- 上游参考：
  - `~/Repo/openclaw/extensions/telegram/src/setup-surface.ts`
  - `~/Repo/openclaw/extensions/discord/src/setup-surface.ts`
  - `~/Repo/openclaw/extensions/feishu/src/setup-surface.ts`
- 官方 DingTalk connector 参考：
  - `https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector`

参考结论：

- Telegram / Discord onboarding 主要覆盖凭证与访问策略。
- Feishu onboarding 优先扫码/手动凭证，再只问关键群策略。
- 官方 DingTalk connector 优先扫码授权，失败回退手动；复杂参数留给配置 schema、配置 UI 或文档。

因此，DingTalk onboarding 不应等同于完整 schema 表单。`config-schema.ts` / `openclaw.plugin.json` 是完整能力面，onboarding 应是最短可用路径加可选高级入口。

## 目标

- 降低新用户完成 DingTalk 配置的交互成本。
- 保留 DM 与群聊策略作为基础安全配置。
- 不在 onboarding 中要求用户输入难以提前获得的 `userId` / `conversationId`。
- 让多账号配置在 wizard 中有明确入口和写入路径。
- 将 card 相关高级参数只暴露给选择 card 模式的用户。
- 保持 runtime 默认值与现有配置兼容。

## 非目标

- 不修改 DingTalk runtime 的配置解析语义。
- 不移除 `config-schema.ts` 或 `openclaw.plugin.json` 中的高级字段。
- 不重新设计 DingTalk target directory、displayNameResolution、message context 或连接管理。
- 不在本次改动中实现 allowlist ID 自动配置。
- 不改变 Device Flow API 行为。

## 字段分层

### 基础 Onboarding

基础流程覆盖必须配置或必须让用户明确选择的项目：

- `accountId`
- 新增命名账号时的可选 `name`
- `clientId`
- `clientSecret`
- 凭证获取方式：自动注册或手动输入
- `dmPolicy`
- `groupPolicy`
- `messageType`

`dmPolicy` 和 `groupPolicy` 同等重要，都进入基础流程。

### Allowlist 指引

`allowFrom` 和 `groupAllowFrom` 不在 onboarding 中输入。

原因：

- DingTalk 的 user ID 和 conversation ID 对新用户不容易提前获得。
- 当前插件已能在目标用户或群组向机器人发送消息时提示当前 ID，并引导管理员加入 allowlist。

当用户选择 allowlist 策略时，wizard 只展示文字提示：

- `dmPolicy=allowlist`: 请让目标用户先私聊机器人，以获取 userId，再手动配置 `allowFrom`。
- `groupPolicy=allowlist`: 请在目标群里 @机器人，以获取 conversationId / group id，再手动配置 `groups` 或相关 allowlist。

### 高级 Onboarding

基础流程结束前询问一次：

```text
Configure advanced DingTalk options?
```

默认值为 `false`。

高级流程只保留用户容易理解且常用的行为开关。

如果 `messageType=markdown`：

- 当前不继续询问其他高级项。

如果 `messageType=card`：

- `cardStreamingMode`
- `cardStreamInterval`
- `cardAtSender`
- `cardStatusLine`

卡片相关参数只在用户选择 `messageType=card` 后出现。

### 直接使用默认值

以下字段不进入基础或高级 onboarding，直接使用 schema/runtime 默认值或保留现有值：

- `mediaMaxMb`
- `journalTTLDays`
- `displayNameResolution`
- `contextVisibility`
- `maxReconnectCycles`
- `useConnectionManager`
- `maxConnectionAttempts`
- `initialReconnectDelay`
- `maxReconnectDelay`
- `reconnectJitter`
- `reconnectDeadlineMs`
- `keepAlive`
- `bypassProxyForSend`
- `proactivePermissionHint`
- `learningEnabled`
- `learningAutoApply`
- `learningNoteTtlMs`
- `convertMarkdownTables`
- deprecated compatibility fields such as `agentId`, `corpId`, `cardTemplateId`, `cardTemplateKey`, `cardRealTimeStream`, `showThinkingStream`, and `asyncMode`

`displayNameResolution` continues to default to `disabled` and should not be promoted during onboarding, because learned displayName resolution can misroute on stale or duplicate names.

### 配置 UI / 文档指引

以下配置只通过提示指向配置 UI、`openclaw.json` 或文档：

- `groups`
- per-group `systemPrompt`
- per-group `requireMention`
- per-group `groupAllowFrom`
- deep reconnect/backoff tuning
- proxy bypass
- learning options
- card status line fine-tuning beyond the wizard prompt shape

## 多账号流程

Wizard 应提供明确账号目标选择：

1. Configure default account
2. Modify existing named account
3. Add named account

行为：

- 默认账号写入 `channels.dingtalk`。
- 命名账号写入 `channels.dingtalk.accounts[accountId]`。
- 新增命名账号时要求输入 `accountId`，并可选输入 `name`。
- 修改已有命名账号时保留该账号未在 wizard 中触及的已有配置。
- 命名账号继承顶层默认配置的 runtime 语义不变。

若上游 channel setup 已提供 account-id prompt，当前插件可以继续复用，但提示文案需要更清晰，避免用户不知道“default account”和“named account”的差异。

## 推荐流程

1. 选择账号目标：
   - default account
   - existing named account
   - new named account
2. 若新增命名账号：
   - 输入 `accountId`
   - 可选输入 `name`
3. 获取凭证：
   - 未配置账号默认自动注册
   - 已配置账号默认手动/保留既有凭证
   - 自动注册失败回退手动输入
4. 选择 `dmPolicy`。
5. 如果 `dmPolicy=allowlist`，展示如何获取 userId 并手动配置 allowlist 的提示。
6. 选择 `groupPolicy`。
7. 如果 `groupPolicy=allowlist`，展示如何获取 conversationId / group id 并手动配置 groups 或 allowlist 的提示。
8. 选择 `messageType`：
   - markdown
   - card
9. 询问是否配置高级 DingTalk options，默认否。
10. 若选择高级且 `messageType=card`，配置 card 相关字段。
11. 结束时提示：
    - 多账号配置位置：`channels.dingtalk.accounts`
    - allowlist ID 获取方法
    - 高级 runtime 参数可通过配置 UI 或 `openclaw.json` 调整
    - 执行 `openclaw gateway restart` 生效

## 错误处理

- 自动注册失败时继续保持现有行为：展示错误并回退到手动输入。
- 手动输入 `clientId` / `clientSecret` 继续做非空校验。
- 命名账号 `accountId` 使用 `normalizeAccountId`。
- 新增账号时如果用户输入已存在 `accountId`，应提示将修改已有账号，或要求重新输入；实现时可选择更简单的一种，但不能静默覆盖而不提示。
- 高级 card 数值项需要正整数校验：
  - `cardStreamInterval >= 200`

## 测试策略

更新 `tests/unit/onboarding.test.ts`，覆盖：

- 未配置账号默认自动注册。
- 已配置账号默认手动/保留凭证路径。
- 基础流程写入 `dmPolicy`、`groupPolicy`、`messageType`。
- `allowlist` 策略只展示提示，不要求输入 `allowFrom` / `groupAllowFrom`。
- `Configure advanced DingTalk options? = false` 时不写入 card 高级项。
- `messageType=card` 且选择高级时写入 card 高级项。
- 新增命名账号写入 `channels.dingtalk.accounts[accountId]`，且不破坏默认账号。
- 修改已有命名账号保留未触及字段。

手动 / 真机验证：

- 跑一遍自动注册基础流程，确认问题数量明显减少。
- 跑一遍 `dmPolicy=allowlist` 和 `groupPolicy=allowlist`，确认只出现获取 ID 的提示。
- 跑一遍新增命名账号，确认配置写入 `accounts`。
- `openclaw gateway restart` 后 `openclaw channels status --probe --json` 显示目标账号 connected。

## PR 验证说明

该优化仍属于 PR #537 的 onboarding 改动范围。PR 描述应补充：

- onboarding 已从全量配置表单收敛为基础流程 + 可选高级流程。
- allowlist ID 不再在 wizard 中输入，改为提示用户通过目标用户/群向机器人发送消息获取 ID 后手动配置。
- 多账号配置已有明确入口。
