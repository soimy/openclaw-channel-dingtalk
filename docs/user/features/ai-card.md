# AI 卡片

AI 卡片模式是钉钉插件最有辨识度的回复方式，基于结构化 block 渲染（CardBlock[]），适合实时输出和对话式场景。

## 基本流程

插件使用统一的预置卡片模板，无需用户配置 `cardTemplateId` / `cardTemplateKey`。

如需覆盖预置模板 ID，可通过环境变量 `DINGTALK_CARD_TEMPLATE_ID` 设置，默认值为 `675cde2f-f526-40cb-b828-f5b2b57b8b77.schema`。

AI 卡片生命周期：

1. 创建卡片并投放
2. 按流式节奏持续更新 block 列表
3. 首次进入流式内容后切换到输入中状态
4. 最终完成并关闭卡片
5. 如果流式过程失败，按策略回退到 Markdown 文本

## 长回复分片（issue #615）

钉钉对单个 Markdown block 有隐性长度上限（实测约 3000 中文字符，超限时 API 成功但客户端渲染为空白卡片）。插件按 Unicode 码点对超长内容做两级分片保护：

- **单卡多 block**：单个 markdown block 超过安全上限（约 2500 码点）时，拆为多个 answer block 一次提交；切分按码点计量，不会切断 emoji/代理对，代码围栏跨片自动闭合重开。
- **多卡兜底**：卡片提交失败或卡片失败时，超长内容拆分为多张 AI Card 按顺序补发（每张标注 `(n/m)` 续接标识）；仅当新卡也无法创建时才降级为 Markdown 文本，且只补发未投递的剩余部分，避免重复。

普通 Markdown 消息（会话 webhook 与主动消息）同样按码点在约 3800 码点处分片，切分规则与卡片一致。

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

## 长任务进度块

卡片模式下，长任务会在卡片顶部保留一个可替换的进度块，让用户知道任务仍在推进：

```text
执行检查中，已完成 3 步，耗时 1 分 20 秒
```

结构为 `{任务种类}中，已完成 N 步，耗时 …`：

- 任务开始 10 秒后出现；若期间已有可关联的工具调用，则随该调用立即出现
- 之后按 `cardTaskProgressRefresh` 刷新步数与耗时（默认每 30 秒）
- 进度块始终是单行、单个 block：真机验证发现，同一 block 内的多行 markdown 在钉钉客户端只会刷新尾行，会让步数看起来停在 0
- 同一张卡片始终只有一个进度块，最终答案提交前会被移除
- 进度文本只由归一化后的工具名派生，不会渲染命令参数、工具输出、URL 或凭证
- ask-user 问题卡片接管本轮回复时，进度块会立即释放并停止刷新；若旧卡片无法撤回且进度块是其唯一内容，会显式清空该卡片

`{任务种类}` 由归一化后的工具名映射而来，共 7 种：

| 工具名 | 任务种类 |
| --- | --- |
| `read` / `view` / `find` / `list` / `glob` | 检查文件 |
| `write` / `edit` / `patch` / `apply_patch` | 应用修改 |
| `web_search` / `search` / `fetch` / `open` / `open_url` | 查询资料 |
| 名称含 `browser` | 验证页面 |
| `bash` / `exec` / `process` / `exec_command` | 执行检查 |
| 名称含 `database` / `sql` / `query` | 查询数据 |
| 其它 | 处理任务 |

> 在多数宿主上，所有工具调用都通过 `exec` 承载，因此实际最常见的种类是「执行检查」。

`cardTaskProgress` 控制是否启用：

| 值 | 说明 |
| --- | --- |
| 未设置（默认） | 开启；但当 `cardStreamingMode` 显式设为 `"off"` 时默认关闭 |
| `true` | 强制开启（即使 `cardStreamingMode` 为 `"off"`） |
| `false` | 强制关闭 |

`cardTaskProgressRefresh` 控制刷新节奏，即「数字新鲜度」与「卡片更新调用量」之间的取舍：

| 值 | 说明 |
| --- | --- |
| `heartbeat`（默认） | 工具事件只更新内存中的步数，随下一次 30 秒刷新一起落盘；调用量固定为「出现时 1 次 + 每 30 秒 1 次」，工具密集的任务也不会增加；代价是步数/耗时最多滞后 30 秒 |
| `interval` | 每次可关联的工具事件都推送一次，由 `cardStreamInterval`（默认 `1000`ms）节流；数字更及时，但调用量随工具调用次数增长，工具密集的长任务会明显更高 |

> 注意：运行时会把未配置的 `cardStreamingMode` 归一化为生效值 `"off"`，但进度块的默认值只把**用户显式写入**的 `"off"` 视为关闭信号。

调用开销见 [API 用量与成本](../reference/api-usage-and-cost.md)。

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
- 支持失败时优先拆分为多张 AI Card 补发，再降级回退到 Markdown（只补发未投递部分）

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

- **[`card-template-v2.json`](../../assets/card-template-v2.json)** — 当前预置卡片模板的完整低代码 schema（钉钉卡片搭建器导出格式），包含组件映射、组件树、数据源和交互定义，可直接导入钉钉卡片搭建器进行编辑。
- **[`card-data-mock-v2.json`](../../assets/card-data-mock-v2.json)** — 卡片渲染时的 mock 数据样例，展示 `blockList`、`content`、`quoteContent`、`statusLine` 等变量结构和取值，方便在搭建器中预览卡片效果。

定制时注意保持变量 key 与插件输出字段的对齐：`content`、`blockList`、`quoteContent`、`copy_content`、`statusLine`、`hasAction` 等。

## 相关文档

- [回复模式](reply-modes.md)
- [表单互动卡片](form-interactive-card.md)
- [API 消耗说明](../reference/api-usage-and-cost.md)
- [配置项参考](../reference/configuration.md)
