# 表单互动卡片

表单互动卡片用于 `dingtalk_ask_user_question` 工具。当模型在钉钉会话中需要用户确认、选择或补充结构化字段后才能继续任务时，插件会投放一张钉钉原生互动表单卡片；用户提交或取消后，插件把结果作为新的会话消息注入，驱动原任务继续执行。

## 基本流程

1. 模型调用 `dingtalk_ask_user_question`
2. 插件根据 `questions` 或 `fields` 构造表单变量
3. 插件使用内置模板 ID 创建并投放钉钉互动卡片
4. 用户在卡片中提交或取消
5. 钉钉回调携带 `question_id` 与表单内容返回插件
6. 插件匹配 pending question，并把回答重新注入当前会话

该能力不受 `messageType` 控制；即使普通回复使用 `markdown`，工具仍会发送独立的钉钉互动表单卡片。

## 权限与生命周期

表单互动卡片不是公开表单。插件会先通过卡片实例 `outTrackId` 或提交事件里的 `question_id` 命中正在等待的 pending question，再校验点击人是否是原始提问用户；不是目标用户的提交会被拒绝。

每张表单卡片都有有效期。超过等待时间后，插件会把卡片状态更新为 `expired`，并向原会话注入一条超时结果消息，让 agent 知道这次等待已经结束。之后再点击旧卡片会被视为已处理回调，不会再次提交给 agent。

同一账号、同一会话、同一用户同时只保留最新的表单实例。agent 再次发起新的表单提问时，插件会把该 scope 下旧的 pending 表单置为 `expired`，并记录为已被新表单替换；用户后续再点旧表单不会提交给 agent，避免旧问题覆盖最新上下文。

## 入参形态

`dingtalk_ask_user_question` 支持两种入参：

| 字段 | 说明 |
| --- | --- |
| `questions` | 轻量问题 DSL，适合确认、单选、多选和简单文本输入 |
| `fields` | 钉钉表单变量协议，适合多字段收集、复杂表单、日期时间、数字、布尔开关等 |

`fields` 支持 `TEXT`、`TEXT_AREA`、`NUMBER`、`SELECT`、`MULTI_SELECT`、`DATE`、`TIME`、`DATETIME`、`CHECKBOX`、`SWITCH`、`CHECKBOX_GROUP`、`MULTI_CHECKBOX_GROUP` 等表单字段类型。

## 如何让 agent 使用

使用者不需要单独配置工具 schema，也不需要手动填写卡片模板 ID。安装包含该能力的后续 `@soimy/dingtalk` 发布版本并允许 `dingtalk` 插件后，OpenClaw 会在工具发现阶段把 `dingtalk_ask_user_question` 暴露给 agent。

> 当前 npm `latest` 为 `3.6.5`；本能力需要维护者在合并后发布高于 `3.6.5` 的新版本，或使用包含本页改动的本地源码安装。

最小启用步骤：

1. 安装或升级 DingTalk 插件。

   ```bash
   openclaw plugins install @soimy/dingtalk
   ```

   已安装时使用：

   ```bash
   openclaw plugins update dingtalk
   ```

2. 在 OpenClaw 配置中允许插件。

   ```json5
   {
     "plugins": {
       "enabled": true,
       "allow": ["dingtalk"]
     }
   }
   ```

3. 配置并启用 DingTalk channel。

   ```json5
   {
     "channels": {
       "dingtalk": {
         "enabled": true,
         "clientId": "dingxxxxxx",
         "clientSecret": "your-app-secret",
         "dmPolicy": "open",
         "groupPolicy": "open",
         "messageType": "markdown"
       }
     }
   }
   ```

4. 重启 gateway，让 OpenClaw 重新加载插件和工具列表。

   ```bash
   openclaw gateway restart
   ```

完成后，agent 在钉钉会话中遇到“必须让用户确认、选择或填写字段才能继续”的任务时，就可以自动调用 `dingtalk_ask_user_question`。例如让它“先用表单问我发布环境、版本号和是否立即执行”，agent 就应该发送表单互动卡片，而不是回复一段普通 Markdown 清单。

如果 agent 仍然只用文字追问，优先检查：

- `plugins.allow` 中是否包含 `dingtalk`
- `channels.dingtalk.enabled` 是否为 `true`
- 是否已经执行 `openclaw gateway restart`
- 当前 OpenClaw 版本是否支持插件工具发现；不支持时插件仍可收发普通钉钉消息，但 agent 看不到该工具

## 模板变量

模板需要保持以下变量与插件输出字段对齐：

| 变量 | 说明 |
| --- | --- |
| `question_id` | 本次问题的回调 ID，也作为提交事件的 actionId |
| `question_title` | 卡片标题 |
| `question_desc` | 问题描述 |
| `form_btn_text` | 表单提交按钮文案 |
| `card_status` | 卡片状态：`pending`、`processing`、`submitted`、`cancelled`、`expired` |
| `form.fields` | 钉钉表单字段列表 |

模板事件链需要保留以 `question_id` 作为 actionId 的提交回调；插件依赖该值匹配对应的 pending question。

运行时处理卡片回调时会优先使用卡片实例的 `outTrackId` 匹配 pending question；只有缺少 `outTrackId` 时才回退到 `question_id`。因此旧模板中某个按钮 actionId 误写为全角字符时，在携带 `outTrackId` 的回调里仍可能正常工作；但模板资产仍应保持 `${question_id}`，避免用户定制模板或平台回调形态变化时失去 fallback 匹配能力。

## 模板资产

当前表单互动卡片模板导出文件：

- **[`dingtalk-ask-user-card-template.json`](../../assets/dingtalk-ask-user-card-template.json)** — 钉钉卡片搭建器导出格式，包含表单变量定义、状态表达式和提交事件链，可导入钉钉卡片搭建器进行编辑。

如需定制样式或字段展示，建议基于该模板修改并上传到钉钉开放平台，同时保持上面的变量 key 和提交事件链不变。

## 相关文档

- [AI 卡片](ai-card.md)
- [回复模式](reply-modes.md)
- [配置项参考](../reference/configuration.md)
