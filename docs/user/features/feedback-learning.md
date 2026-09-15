# 反馈学习

插件支持一个本地反馈学习闭环，用于把用户反馈沉淀为可审计的会话级或账号级规则，而不是直接修改模型本身。

## 设计分层

- 发送快照：保存最近问答，便于回溯
- 显式反馈：例如点赞、点踩
- 隐式不满：例如后续纠错或抱怨
- 会话笔记：仅对当前 target 生效
- 全局规则：按 account 共享

## 持久化位置

运行时数据写在 `storePath` 同级目录下的 `dingtalk-state/` 中，不应提交到仓库。

常见命名空间包括：

- `feedback.events`
- `feedback.snapshots`
- `feedback.reflections`
- `feedback.session-notes`
- `feedback.learned-rules`
- `feedback.target-rules`

## 推荐配置

```json5
{
  "channels": {
    "dingtalk": {
      "learningEnabled": true,
      "learningAutoApply": false,
      "learningNoteTtlMs": 21600000,
      "learningRuleTtlMs": 2592000000,
      "learningAllowManualGlobalRules": false
    }
  }
}
```

## 精确回复规则（会绕过模型）

`/learn` 支持一种"精确回复"规则：当指令形如

```text
当用户问"<触发语>"时，必须回答"<固定回复>"
```

时，插件会把触发语与固定回复一起写进 `feedback.learned-rules`（会话级写入 `feedback.target-rules`）。此后只要入站文本与触发语逐字匹配，插件**直接返回这条固定回复，不经过模型**。

需要知道的边界：

- 这类规则**只能由 owner 写入**。"owner" 指在宿主配置 `commands.ownerAllowFrom` 中列出的 senderId；普通 `allowFrom` 管理员不在此列，发命令会被 owner-only 拒绝（先用 `/learn whoami` 查 senderId，再由宿主加入该列表）
- `learningEnabled` 是学习回路的总开关：关闭时既不能写入/修改规则，已存的规则也不会命中（只读与清理命令仍可用，见下节）
- 规则默认 **30 天后过期**（`learningRuleTtlMs`，设为 `0` 可关闭过期）：过期规则**既不会被注入 prompt，也不会命中触发语**，需要重新发布
- **account 级（`/learn global`）规则默认完全不生效**：既不会作为「高优先级学习约束」注入 prompt，也不能强制精确回复；需要额外设置 `learningAllowManualGlobalRules: true` 才会生效。会话级（`/learn here`、`/learn target`）不受此限制；自动学习产生的 account 级规则由 `learningAutoApply` 控制，不受该开关影响
- 每次命中都会打日志 `[DingTalk][Learning][ForcedReply] ruleId=… scope=… target=…`（不含回复正文），便于审计
- 固定回复是逐字返回的，因此不要把凭证、内部地址等内容写进规则
- 作用域优先级与其它学习内容一致（target 规则优先于 account 级规则），见下方"作用域优先级"

## 开关语义

`learningEnabled` 是整个学习回路（含精确回复）的总开关：

- 关闭时：规则写入/修改命令（`/learn global|session|here|target|targets|target-set ...`）会被拒绝并提示开启方式；**已存的规则也不会命中**，消息回落到正常的 agent 流程
- 关闭时仍可用：`/learn whoami`、`/learn whereami`、`/learn owner status`、`/learn help`、`/learn list`，以及清理类命令 `/learn disable <ruleId>`、`/learn delete <ruleId>`（清理只会减少状态，不会增加暴露面）
- 开启时：命令可写入规则，命中的精确回复会直接返回固定文本；account 级（`/learn global`）规则还需 `learningAllowManualGlobalRules: true` 才会被注入或强制回复

## 常用命令

- `/learn whoami`
- `/learn whereami`
- `/learn here #@# <规则>`
- `/learn target <conversationId> #@# <规则>`
- `/learn targets <id1,id2> #@# <规则>`
- `/learn global <规则>`
- `/learn list`
- `/learn disable <ruleId>`
- `/learn delete <ruleId>`

## 作用域优先级

规则生效顺序通常是：

1. 当前会话临时笔记
2. 当前 target 规则
3. 当前账号全局规则

## 适用建议

- 默认只采集，不自动注入
- 先手动审核，再提升为更广范围的规则
- 对会影响多人场景的规则，优先使用 target 级而不是全局级

## 相关文档

- [配置项参考](../reference/configuration.md)
- [安全策略](../reference/security-policies.md)
