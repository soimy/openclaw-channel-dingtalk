# 回复模式

插件支持两类主要回复模式，由 `messageType` 控制。

## 1. `markdown`

这是默认模式，适合大多数场景。

特点：

- 配置简单
- 发送成本低
- 支持富文本格式
- Markdown 表格会自动转成更稳妥的可读文本

适合：

- 普通机器人问答
- 对钉钉 API 调用量较敏感的场景
- 不需要卡片流式体验的部署

## 2. `card`

这是 AI 互动卡片模式，适合强调流式体验和更强视觉反馈的场景。

特点：

- 支持创建并投放 AI 卡片
- 支持流式更新
- 支持更好的会话列表预览能力
- 适合展示思考流与工具执行结果

代价：

- 配置复杂度更高
- 需要额外卡片模板
- API 调用量通常高于 `markdown`

## 如何选择

推荐决策顺序：

1. 如果只是稳定可用，先选 `markdown`
2. 如果需要更强的流式互动体验，再选 `card`
3. 如果担心钉钉 API 调用量或卡片失败降级，先从 `markdown` 开始验证

## 会话级显示开关

`/reasoning` 与 `/verbose` 是上游 OpenClaw 的会话级显示开关。插件负责把已经到达钉钉通路的事件送出去，但不负责强制模型一定产出 reasoning 或 tool 事件。

### `markdown` 模式

- `/reasoning off`：只发送最终答复，不额外发送中间 reasoning 消息
- `/reasoning on`：如果上游确实产出 reasoning 与 answer，钉钉侧会按独立 markdown 消息分拨发送
- `/reasoning stream`：命令本身仍可设置，但 live reasoning stream 设计上是 Telegram-only；在 DingTalk 上通常不会看到实时逐段 thinking 流
- `/verbose off`：插件不会额外发送 tool summary；最终答复里是否提到工具，取决于模型自己的回答内容
- `/verbose on`：当上游真的触发 `toolCall` 并发出 tool 事件时，钉钉 markdown 会额外发送独立的 tool 消息；如果模型直接给出答案而没有真实调用工具，则不会凭空出现 tool 消息

### `card` 模式

- AI Card 会更适合承载 reasoning / tool / answer 的单时间线显示
- `/reasoning on` 与 `/verbose on` 在 card 模式下通常更容易形成连续、可见的过程反馈
- 如果更关注过程可视化体验，优先考虑 `card`

## 实时中止

插件支持对进行中的 AI generation 发送停止指令并立即中断，无需等待当前长回复自然结束。

常见停止指令包括：

- `停止`
- `stop`
- `/stop`
- `esc`

在群聊中，停止请求也会走专门的快速中断路径，尽量避免被普通会话锁阻塞。

## 配置示例

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "markdown"
    }
  }
}
```

```json5
{
  "channels": {
    "dingtalk": {
      "messageType": "card",
      "cardTemplateId": "your-template-id.schema",
      "cardTemplateKey": "content"
    }
  }
}
```

## 继续阅读

- [AI 卡片](ai-card.md)
- [API 消耗说明](../reference/api-usage-and-cost.md)
- [配置项参考](../reference/configuration.md)
