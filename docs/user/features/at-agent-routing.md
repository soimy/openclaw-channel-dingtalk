# @多助手路由

> 实验性功能

在群聊中，用户可以通过 `@助手名` 指定要对话的 agent。每个 agent 拥有独立 session。

## 使用效果

```text
用户: @frontend 帮我看看这个组件的问题
[frontend] 好的，请贴出代码...

用户: @dba 数据库慢查询怎么处理？
[dba] 从数据库角度分析...
```

## 配置方式

在 OpenClaw 配置中设置 `agents.list`：

```json
{
  "agents": {
    "list": [
      { "id": "main", "name": "助手", "default": true },
      { "id": "frontend", "name": "前端专家" },
      { "id": "dba", "name": "DBA" }
    ]
  }
}
```

## 当前范围

- 解析 `@mention`
- 根据 `name` 或 `id` 匹配 agent
- 路由到独立 agent session
- 回复自动附加助手名前缀

## 已知限制

- 当前与顶层 `bindings` 机制独立运作
- 同时配置时可能让路由认知变复杂
- 仍属于实验能力，建议先在小范围群聊试用

## 相关文档

- [多 Agent 与多机器人绑定](multi-agent-bindings.md)
