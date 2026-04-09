# API 消耗说明

不同回复模式的 API 调用成本差异较大。本页帮助你做体验与成本之间的取舍。

> [!IMPORTANT]
> 根据钉钉开放平台公告《[关于限时开放钉钉PaaS资源不限量额度以助力企业AI智能体集成的公告](https://open.dingtalk.com/document/development/open-ai-paas-report)》（更新于 `2026-03-11`），OpenClaw 调用钉钉 `API/Webhook/Stream` 的免费“不限量”额度默认有效至 `2026-03-31`；如已通过官方申请通道获批，豁免权益最晚有效至 `2026-04-30`。建议在评估 `cardStreamingMode` 和消息发送策略前，先到“钉钉开发者后台 -> 资源管理”确认企业当前额度与豁免状态。

## Markdown 模式

典型情况下，一次回复主要包括：

| 操作 | 调用次数 | 说明 |
| --- | --- | --- |
| 获取 Token | 1 | 会复用缓存 |
| 发送消息 | 1 | 单聊或群聊发送接口 |

整体成本较低，适合作为默认模式。

## AI 卡片模式

典型情况下包括：

| 阶段 | 调用次数 | 说明 |
| --- | --- | --- |
| 创建卡片 | 1 | `createAndDeliver` |
| 流式更新 | M | 次数取决于流式节奏 |
| 最终完成 | 包含在最后一次流更新中 | `isFinalize=true` |

总成本约为 `1 + M`。

## 三种卡片流式策略对比

以一次约 10 秒的 AI 回复为例：

| 模式 | `streamAICard` 调用数 | 首 token 延迟 | 体验 |
| --- | --- | --- | --- |
| `off` | 约 10-15 次 | 约 1-1.5 秒 | 更新更少、成本更稳 |
| `answer` | 约 15-25 次 | 约 300-800ms | 答案更流畅，成本中等 |
| `all` | 约 25-35 次 | 约 300ms | 答案+思考都更实时，成本最高 |

`cardStreamInterval` 会影响 `answer` / `all` 下的调用频率：间隔越小，`streamAICard` 调用通常越多。

## 推荐策略

- 默认部署：用 `markdown`
- 想要卡片体验但控制成本：`card` + `cardStreamingMode: "off"` 或 `"answer"`
- 想要流畅体验：`card` + `cardStreamingMode: "all"`

推荐配置示例：

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardStreamingMode": "answer",
      "cardStreamInterval": 1000
    }
  }
}
```

## 额外消耗来源

如果在卡片中开启思考流和工具执行展示，也会增加卡片流式更新次数。

## 相关文档

- [回复模式](../features/reply-modes.md)
- [AI 卡片](../features/ai-card.md)
