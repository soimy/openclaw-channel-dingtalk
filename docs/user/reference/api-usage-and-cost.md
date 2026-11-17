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
| 关闭 content 流式生命周期 | 0-1 | 仅在打开过 content 实时流式时发送一次空 `content` + `isFinalize=true` |
| 最终完成 | 1 | 通过 instances API 一次性写入 `blockList`、`content`、`flowStatus=3` |

总成本通常约为 `2 + M`；如果打开过 content 实时流式，额外增加一次生命周期关闭调用。

## 三种卡片流式策略对比

以一次约 10 秒的 AI 回复为例：

| 模式 | 卡片更新调用数 | 首 token 延迟 | 体验 |
| --- | --- | --- | --- |
| `off` | 约 10-15 次 | 约 1-1.5 秒 | 更新更少、成本更稳 |
| `answer` | 约 15-25 次 | 约 300-800ms | 答案更流畅，成本中等 |
| `all` | 约 25-35 次 | 约 300ms | 答案片段实时预览，思考/工具块也更实时，成本最高 |

`cardStreamInterval` 会影响 `answer` / `all` 下的调用频率：间隔越小，卡片更新调用通常越多。

## 长任务进度块的额外调用

卡片模式下，超过 10 秒的长任务会启用「任务进度块」（见 [AI 卡片](../features/ai-card.md)）。默认 `cardTaskProgressRefresh: "heartbeat"`：

- 10 秒内结束的任务：0 次额外调用
- 超过 10 秒的任务：出现时 1 次，之后每 30 秒 1 次 `updateAICardBlockList`（例如 5 分钟任务约 11 次）
- 工具事件只更新内存中的步数，不额外触发卡片更新；这些变化随下一次 30 秒刷新一起落盘，因此工具密集任务也不会抬高调用量

改用 `cardTaskProgressRefresh: "interval"` 会让每次可关联的工具事件都推送一次，调用量随工具调用次数增长（仍受 `cardStreamInterval` 节流，默认约 1 秒 1 次），换来更及时的步数/耗时。工具密集的长任务建议保留默认值。

可用 `cardTaskProgress: false` 关闭；显式设置 `cardStreamingMode: "off"` 时默认也是关闭的。

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

## 模型费用角标

设置 `channels.dingtalk.cardStatusLine.cost: true`，在 AI 卡片左下角显示
类似 `~$0.0059` 的模型费用（美元）；默认关闭，不在正文插入用量页脚。
`DAPI+N` 仍表示钉钉接口调用次数，不是模型费用。

费用优先使用 `llm_output` 用量携带的 `cost.total`。没有金额时，仅在
`models.providers.<provider>.models[].cost` 配置了该模型所需的固定单价
（每百万 Token 的 `input`、`output`、`cacheRead`、`cacheWrite`）时逐次估算。
按每次调用的 provider/model 选择价格，再累加，避免回退模型或工具循环误计价。

未配置价格、只有总 Token 数、任一调用费用未知或不支持的分档价格时，
隐藏费用段，不显示零元或部分合计。真实零费用仍显示 `~$0.0000`。
插件不读取主机私有价格目录，也不请求供应商账单接口。

当前支持范围要求主机发出可关联到卡片 runId 的 `llm_output` 事件；
未发出该事件的外部运行时暂不能显示费用。估算不包含工具服务费用、
折扣或额外计费档位，实际收费以供应商账单为准。
