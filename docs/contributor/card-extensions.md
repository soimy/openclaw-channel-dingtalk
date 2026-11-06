# 自定义卡片扩展接口

独立 OpenClaw 插件可以通过 `@soimy/dingtalk/card-extensions`，向指定用户投递机器人私聊卡片、更新模板变量并接收按钮或表单回调。接口复用 Channel 已有账号、Token、HTTP 和 Stream；消费者不需要取得钉钉凭据或建立第二套连接。

## 能力边界

OpenClaw 管理插件注册、运行时能力发现及交互去重；Channel 负责钉钉协议和传输；消费者负责业务权限、输入校验、持久化、幂等及失败恢复。

普通按钮、选择器和状态展示应优先采用宿主 `MessagePresentation`，并确认目标 Channel 已实现对应呈现能力。宿主存在该类型不代表所有 Channel 都能渲染；当前 DingTalk Channel 尚未实现完整的通用交互呈现。本接口仅补充钉钉原生 `cardTemplateId`、复杂表单、模板变量、原卡更新等能力，不承担通用 UI 框架、模型工具或业务审批框架的职责。

首版仅支持机器人私聊卡片。群卡片、模板设计及通用钉钉 HTTP API 不属于接口范围。

## 安装与构建

需要 OpenClaw ≥ 2026.9.2，并启用包含本接口的 DingTalk Channel 版本。在[企业开发者后台的卡片平台](https://open-dev.dingtalk.com/fe/card)选择当前企业及机器人所属应用，使用该应用可访问的已发布互动模板。个人卡片入口发布的模板不一定可由企业机器人投递。沿用原有卡片 API 权限，无需额外 Stream 连接。

```ts
import { registerDingTalkCardExtension } from '@soimy/dingtalk/card-extensions';
```

消费者与 Channel 通常不共享 `node_modules`，请采用以下一种方式：

- 构建时将 `/card-extensions` 子入口打入消费者 bundle，将 `openclaw` 和所有 `openclaw/plugin-sdk/*` 保持为 **external**，由正在运行的宿主提供。
- 在消费者依赖中安装包含本接口的 `@soimy/dingtalk`，运行时导入子入口。不要再次把这份依赖注册为 Channel。

子入口只引用狭窄的宿主公共 SDK，不导入 Channel 主入口、HTTP 客户端或 Stream SDK。不要打包另一份宿主实现，也不要自行创建 runtime；必须传入当前插件收到的 `api`。跨进程使用不受支持。

`variables` 的键必须与所选模板一致，对象和数组先 `JSON.stringify`。接口不替消费者选择模板或补充模板字段；API 成功后仍应在客户端确认实际渲染与交互。

## 同步注册与业务生命周期

必须在插件 **同步 `register(api)` 阶段**调用一次注册函数，不能放进异步初始化、定时器或服务 `start()`。宿主才能把处理器登记到本轮正在构建的插件注册表，在激活、卸载、重载时正确切换。注册不需要 Channel 已连接，也不访问网络。

需要在 Gateway 启动时运行后台服务或恢复历史卡片的消费者，应在自己的 `openclaw.plugin.json` 中声明 `"activation": { "onStartup": true }`。按需激活的宿主不保证仅凭插件启用配置就执行此类插件的启动服务；业务服务仍在 `registerService()` 中定义，卡片处理器仍在同步 `register()` 中注册。

下面示例假设模板有 `title`、`status` 变量，`note` 文本表单项和 `save` 动作。配置读取与已鉴权业务入口由消费者提供。

```ts
register(api) {
  const config = readConsumerConfig(api.pluginConfig);
  const pending = new Map<string, { owner: string; expiresAt: number; saving: boolean }>();
  let active = false;

  const cards = registerDingTalkCardExtension(api, {
    accountId: config.accountId,
    namespace: 'settings-example',
    async onAction(action) {
      if (!active) return;
      const state = pending.get(action.cardId);
      if (!state || state.saving || Date.now() > state.expiresAt) return;
      if (action.userId !== state.owner || !action.actionIds.includes('save')) return;
      const note = action.form.note;
      if (typeof note !== 'string' || note.length > 200) return;

      state.saving = true;
      try {
        // 示例只更新显示。写业务数据时另以稳定业务 ID 实现持久化幂等。
        await cards.updateCard({
          cardId: action.cardId,
          variables: { title: '设置已保存', status: 'saved' },
        });
        pending.delete(action.cardId);
      } catch (error) {
        state.saving = false;
        throw error;
      }
    },
  });

  api.registerService({
    id: 'settings-card-example',
    start() { active = true; },
    stop() { active = false; pending.clear(); },
  });

  // 从消费者自己的已鉴权命令或业务入口调用。
  async function showSettings(cardId: string) {
    if (!active || !cards.isReady()) throw new Error('服务尚未就绪，请稍后重试');
    pending.set(cardId, { owner: config.ownerUserId, expiresAt: Date.now() + 600_000, saving: false });
    await cards.sendCard({
      cardId, userId: config.ownerUserId, templateId: config.templateId,
      variables: { title: '编辑设置', status: 'pending' },
    });
  }
}
```

插件注册生命周期和业务服务生命周期不同：服务停止时，消费者仍需拒绝旧回调、停止后台工作，并避免继续使用已停用业务的句柄。宿主清理处理器不会取消已经执行中的业务或 HTTP 请求。

示例仅使用内存业务状态，重启后旧卡片不再执行操作。需要恢复的业务应持久化卡片 ID、所有者、到期时间和处理状态。

## 公开契约

| 方法或字段 | 说明 |
| --- | --- |
| `registerDingTalkCardExtension(api, { accountId, namespace, onAction })` | 显式绑定账号与命名空间。同账号同命名空间重复注册立即报错；不同账号独立。 |
| `isReady(): boolean` | 本地同步查询当前账号能力和连接，无 HTTP 请求。只供提示；发送前仍会重新检查。 |
| `sendCard({ cardId, templateId, userId, variables }): Promise<void>` | 创建并投递机器人私聊卡片。`userId` 为企业 staffId，不是 unionId/openDingTalkId。固定 STREAM 回调、禁止转发。 |
| `updateCard({ cardId, variables }): Promise<void>` | 更新同一卡片提供的变量键。失败不会创建新卡片。 |
| `onAction({ cardId, userId, actionIds, form, callbackId? })` | 只提供业务卡片 ID、外层可信用户 ID、动作、表单及可选事件 ID。 |
| `variables` | 字符串映射；1–256 个键，键长 ≤128，序列化后 ≤262144 字符。平台自身还可能施加限制。 |

不提供 `getStatus()` 或 `dispose()`，也不返回或接收作为公共契约的 `outTrackId`。消费者仅持有稳定 `cardId`，不要构造、持久化或依赖 Channel 的内部路由编码。

账号 ID 允许字母、数字、下划线和短横线，长度 1–64；namespace 以小写字母开头，后续为小写字母、数字或短横线，长度 1–32；cardId 允许字母、数字、下划线、短横线，长度 1–64。组合路由有平台长度约束，过长时返回 `invalid-argument`，建议使用简短 namespace 与 UUID 卡片 ID。

## 宿主集成与回调边界

- 账号 Gateway 使用宿主提供的 `ctx.channelRuntime` 注册版本化卡片传输 capability，通过 `abortSignal` 和 lease 撤销绑定。
- 消费者使用 `api.runtime.channel` 每次查找当前 transport，不缓存旧连接，不注册 watcher，也不维护第二张 transport Map。
- 使用宿主公开 `registerPluginInteractiveHandler()` 注册处理器。它与 `api.registerInteractiveHandler()` 使用同一套宿主注册机制，但返回 `{ ok, error }`，因此可以在冲突时立即失败，避免返回无有效处理器的发送句柄。
- 宿主交互 namespace 只有 Channel 维度，适配层内部加入账号维度。入站仍核验实际 Stream 账号与卡片路由一致，消费者不会收到其他账号的回调。
- 通过宿主 `dispatchPluginInteractiveHandler()` 查找并调用处理器，复用宿主进行中占位和近期完成去重。

账号来自接收事件的 Stream 连接，用户 ID 仅来自外层 `userId`。`actionIds` 和 `form` 是不可信输入；`form` 中 `{ value: ... }` 包装会解包，其他值保持原样。嵌套字段不能覆盖账号、身份或路由。

模板回调应在 `content` 或 `value` 的 `cardPrivateData.actionIds`、`cardPrivateData.params.form` 中提供动作及表单；`content/value` 可为对象或 JSON 字符串。消费者必须验证操作人、卡片归属、动作、输入、到期时间和业务状态。可信用户 ID 本身不授予业务权限。

Channel 在调用业务处理器前发送 ACK，确认“事件已收到”，而不是“业务已成功”。重复、未匹配或格式错误的保留前缀事件也被消费；不会转入内置停止、反馈、问卷或 Agent。原有内置卡片继续使用原流程。

## 去重、错误与恢复

遵循宿主通用交互语义：

- 进行中的事件占位不按 TTL 释放，重投不会并行重复执行。
- 正常完成后进入宿主完成记录；OpenClaw 2026.8.1 当前为 5 分钟、进程共享最多 4096 条。具体容量和淘汰策略由宿主管理，不是本接口的永久保证。
- **处理器抛错时释放占位**。以后同一事件再次到达可能重新执行，但 Channel 不主动重试业务或 HTTP，也不会因此转交 Agent。
- 未提供有效事件 ID 时不做推测去重；用户再次点击也可能产生新事件 ID。
- 去重不是持久化业务锁，不保证 exactly-once。若业务已产生副作用后抛错，必须以业务 ID、事务或状态记录避免二次执行。

创建或更新不新增自动重试；Token 获取沿用 Channel 缓存及有限重试。创建超时可能已经投递，不应换 ID 盲目重发，也不能改走另一后端再次发送。错误只暴露稳定 `code` 和脱敏描述，不附带凭据、卡片正文或原始 HTTP 异常。

| 错误 code | 处理建议 |
| --- | --- |
| `unavailable` | 核对宿主版本、Channel 能力、账号配置与启用状态。账号未启动或 transport 已撤销时也会返回此错误。 |
| `not-connected` | 当前 transport 存在但 Stream 不可用，等待 Channel 恢复后再操作。 |
| `namespace-conflict` | 保证同账号同 namespace 只在同步 register 阶段注册一次。 |
| `invalid-argument` | 修正 ID、模板 ID、用户 ID、变量格式或长度。 |
| `request-failed` | 检查平台权限、模板和网络；先核对实际结果，避免重复投递。 |

`isReady()` 为 false 不能用于判定“应该切换另一发送后端”。即使为 true，异步获取 Token 期间也可能断线；最终以发送/更新结果为准。

## 运行成本与验证

新增路径是宿主本地能力查询、路由解析和交互分派；不增加模型调用、子进程、HTTP 服务、轮询或 Stream 连接。传输调用才访问原有钉钉 API。同步阻塞的消费者仍会阻塞 Gateway 事件循环，耗时业务应持久化入队后尽快返回。

验证重点包括：独立消费者打包与 SDK external、候选注册与激活、插件重载、账号隔离、重复注册、启动顺序、断线与停止后的发送检查、提前 ACK、并发重投、失败释放，以及真实客户端渲染、表单提交和原卡更新。接口属于受信任插件间扩展点，不是恶意插件的沙箱。
