# AI 卡片

AI 卡片模式是钉钉插件最有辨识度的回复方式，适合实时输出和对话式场景。

## 基本流程

插件的 AI 卡片生命周期通常是：

1. 创建卡片并投放
2. 按流式节奏持续更新
3. 首次进入流式内容后切换到输入中状态
4. 最终完成并关闭卡片
5. 如果流式过程失败，按策略回退到 Markdown 文本

## 两种流式策略

通过 `cardRealTimeStream` 控制：

| 值 | 模式 | 说明 |
| --- | --- | --- |
| `false` | Block 缓冲 | 默认值，API 调用量较少，但更新节奏更卡顿 |
| `true` | 真流式 | 首 token 更快、体验更流畅，但 API 调用更高 |

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
      "cardTemplateId": "382e4302-551d-4880-bf29-a30acfab2e71.schema",
      "cardTemplateKey": "content",
      "cardRealTimeStream": false
    }
  }
}
```

## 相关文档

- [回复模式](reply-modes.md)
- [API 消耗说明](../reference/api-usage-and-cost.md)
- [配置项参考](../reference/configuration.md)
