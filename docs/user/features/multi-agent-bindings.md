# 多 Agent 与多机器人绑定

如果一个 OpenClaw 实例需要同时接入多个钉钉机器人，并把不同机器人的消息路由给不同 agent，可以结合三部分配置：

1. `agents.list`
2. `bindings`
3. `channels.dingtalk.accounts`

## 核心原则

- `bindings[].match.accountId` 必须与 `channels.dingtalk.accounts` 中的 key 完全一致
- 每个 agent 最好使用独立的 `workspace`
- 每个机器人都应配置完整的钉钉凭证

## 最小示意

```json5
{
  "agents": {
    "list": [
      { "id": "main" },
      { "id": "growth-agent", "workspace": "/path/to/growth/workspace" }
    ]
  },
  "bindings": [
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "dingtalk", "accountId": "bot_1" }
    },
    {
      "type": "route",
      "agentId": "growth-agent",
      "match": { "channel": "dingtalk", "accountId": "bot_2" }
    }
  ],
  "channels": {
    "dingtalk": {
      "accounts": {
        "bot_1": { "clientId": "..." },
        "bot_2": { "clientId": "..." }
      }
    }
  }
}
```

## 常见错误

- `accountId` 名字拼写不一致
- 多个 agent 共享同一个 `workspace`
- 修改完配置后没有重启 gateway

## 相关文档

- [配置项参考](../reference/configuration.md)
- [@多助手路由](at-agent-routing.md)
