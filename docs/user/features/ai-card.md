# AI 卡片

AI 卡片模式是钉钉插件最有辨识度的回复方式，基于结构化 block 渲染（CardBlock[]），适合实时输出和对话式场景。

## 基本流程

插件使用统一的预置卡片模板，无需用户配置 `cardTemplateId` / `cardTemplateKey`。

如需覆盖预置模板 ID，可通过环境变量 `DINGTALK_CARD_TEMPLATE_ID` 设置，默认值为 `58f73932-fc3b-46ae-8e90-93313e405061.schema`。

AI 卡片生命周期：

1. 创建卡片并投放
2. 按流式节奏持续更新 block 列表
3. 首次进入流式内容后切换到输入中状态
4. 最终完成并关闭卡片
5. 如果流式过程失败，按策略回退到 Markdown 文本

## 卡片内容结构（v2 Block 渲染）

卡片通过结构化 `CardBlock[]` 数组渲染，支持以下 block 类型：

| type | 名称 | 说明 |
| --- | --- | --- |
| `0` | answer | Markdown 正文 block |
| `1` | think | 思考/推理过程 block |
| `2` | tool | 工具执行结果 block |
| `3` | image | 图片 block（需 mediaId） |

`think` / `tool` block 按 DingTalk markdown 变量 token 渲染为次级文本样式，与正文形成层级区分。

## 卡片附加信息

- **quoteContent**：群聊或引用场景下，在卡片头部展示入站消息原文，方便定位上下文
- **taskInfo**：卡片底部状态栏，通过 `cardStatusLine` 按需开关以下子项：

  | 子项 | 说明 |
  | --- | --- |
  | `model` | 当前使用的模型名称 |
  | `effort` | effort 参数（如适用） |
  | `taskTime` | 任务耗时 |
  | `tokens` | Token 用量统计 |
  | `dapiUsage` | DingTalk API 调用次数 |
  | `agent` | 当前 agent 名称（多 Agent 场景） |

  配置示例：

  ```json5
  {
    "channels": {
      "dingtalk": {
        "cardStatusLine": {
          "model": true,
          "taskTime": true,
          "tokens": false
        }
      }
    }
  }
  ```
- **cardAtSender**：群聊中卡片完成后追加 @发送者 的文本消息（`channels.dingtalk.cardAtSender` 配置）

## 卡片流式模式

通过 `cardStreamingMode` 控制 block 列表和 content key 的推送节奏：

| 值 | 模式 | 说明 |
| --- | --- | --- |
| `off` | 关闭增量流式 | 不实时推送答案片段；思考内容在完整块形成、边界或结束时落盘到时间线 |
| `answer` | 仅答案实时流式 | 实时推送答案片段到 content key；思考内容在完整块形成、边界或结束时合并更新 block 列表 |
| `all` | 全量实时流式 | 答案片段实时推送到 content key；思考/工具内容实时更新 block 列表，答案在边界或结束时固化到 block 列表 |

`cardStreamInterval` 用于控制实时更新节奏（毫秒）。在 `answer` / `all` 下生效，默认 `1000`。

## 兼容项：`cardTemplateId` / `cardTemplateKey`（已弃用）

- v2 已固定使用预置统一模板，不再需要用户配置这两个字段。已有的配置值会被忽略，不影响正常运行。
- `cardRealTimeStream` 已弃用，仅保留兼容。仅当未配置 `cardStreamingMode` 且 `cardRealTimeStream=true` 时，才回退为 `cardStreamingMode: "all"`。

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

- 结构化 block 渲染（answer/think/tool/image），层级清晰
- 流式更新正文与 block 列表
- 动态摘要改善会话列表预览
- 可显示思考流、工具执行结果与图片 media
- 卡片头部引用原文展示
- 底部任务元数据（模型名、effort、耗时、token 用量等）
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

## 自定义卡片模板

如需在预置模板基础上定制卡片样式或新增自定义变量/组件，可以参考以下资产文件，将修改后的模板上传到钉钉开放平台，再通过 `DINGTALK_CARD_TEMPLATE_ID` 环境变量指向新模板 ID：

- **[`card-template-v3.json`](../../assets/card-template-v3.json)** — 当前预置卡片模板的完整低代码 schema（钉钉卡片搭建器导出格式），包含组件映射、组件树、数据源、AI Card 展示与 Native Approval 按钮组，可直接导入钉钉卡片搭建器进行编辑。
- **[`card-template-v2.json`](../../assets/card-template-v2.json)** — 旧版模板，仅用于历史参考。
- **[`card-data-mock-v2.json`](../../assets/card-data-mock-v2.json)** — 卡片渲染时的 mock 数据样例，展示 `blockList`、`content`、`quoteContent`、`statusLine` 等变量结构和取值，方便在搭建器中预览卡片效果。

定制时注意保持变量 key 与插件输出字段的对齐：`content`、`blockList`、`quoteContent`、`copy_content`、`statusLine`、`hasAction`、`show_approve_btns`、`approveId` 等。

## 相关文档

- [回复模式](reply-modes.md)
- [DingTalk Native Approval](exec-approval.md)
- [API 消耗说明](../reference/api-usage-and-cost.md)
- [配置项参考](../reference/configuration.md)
