# AI 卡片

AI 卡片模式是钉钉插件最有辨识度的回复方式，适合实时输出和对话式场景。

## 基本流程

插件的 AI 卡片生命周期通常是：

1. 创建卡片并投放
2. 按流式节奏持续更新
3. 首次进入流式内容后切换到输入中状态
4. 最终完成并关闭卡片
5. 如果流式过程失败，按策略回退到 Markdown 文本

## 卡片流式模式

通过 `cardStreamingMode` 控制：

| 值 | 模式 | 说明 |
| --- | --- | --- |
| `off` | 关闭增量流式 | 不实时推送答案片段；思考内容在完整块形成、边界或结束时落盘到时间线 |
| `answer` | 仅答案实时流式 | 实时推送答案片段；思考内容在完整块形成、边界或结束时合并更新 |
| `all` | 全量实时流式 | 实时推送答案与思考内容，体验最流畅、API 调用通常最高 |

`cardStreamInterval` 用于控制实时更新节奏（毫秒）。在 `answer` / `all` 下生效，默认 `1000`。

## 兼容项：`cardRealTimeStream`（已弃用）

- `cardRealTimeStream` 已弃用，仅保留兼容。
- 仅当未配置 `cardStreamingMode` 且 `cardRealTimeStream=true` 时，才回退为 `cardStreamingMode: "all"`。
- 如果两者同时配置，始终以 `cardStreamingMode` 为准。

## 适用场景

适合：

- AI 实时输出
- 需要思考过程或工具执行可视化
- 更重视体验而不是最低 API 开销的场景

不适合：

- 只要稳定文本回复的场景
- 对配置复杂度敏感的场景
- 对额外 API 消耗非常敏感的部署

## 卡片模式的额外能力

- 流式更新正文
- 动态摘要改善会话列表预览
- 可显示思考流与工具执行结果
- 支持失败时回退到 Markdown

## 配置示例

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

## 相关文档

- [回复模式](reply-modes.md)
- [API 消耗说明](../reference/api-usage-and-cost.md)
- [配置项参考](../reference/configuration.md)
