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
      "learningNoteTtlMs": 21600000
    }
  }
}
```

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
