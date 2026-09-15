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

表单互动卡片不是公开表单。默认未指定 `target` 时，插件会先通过卡片实例 `outTrackId` 或提交事件里的 `question_id` 命中正在等待的 pending question，再校验点击人是否是原始提问用户；不是目标用户的提交会被拒绝。

每张表单卡片都有有效期。超过等待时间后，插件会把卡片状态更新为 `expired`，并向原会话注入一条超时结果消息，让 agent 知道这次等待已经结束。之后再点击旧卡片会被视为已处理回调，不会再次提交给 agent。

未指定 `target` 时，同一账号、同一会话、同一用户同时只保留最新的表单实例。agent 再次发起新的表单提问时，插件会把该 scope 下旧的 pending 表单置为 `expired`，并记录为已被新表单替换；用户后续再点旧表单不会提交给 agent，避免旧问题覆盖最新上下文。

对于未指定 `target` 的表单，如果用户在卡片发出后先发送了一条新的普通消息，插件会在处理新消息之前立即使同一 scope 的旧卡片失效，并提示“你在问题卡片发出后发送了新消息，此卡已失效”。之后再提交旧卡片不会注入 agent。卡片回调与新消息同时到达时采用原子状态竞争：已经成功取得回答处理权的回调继续执行，尚未取得处理权的旧卡片则由新消息失效。

问题卡片发出后，插件会定向暂停当前 agent run，避免原 run 继续输出并与后续回答混在一起。如果暂停失败，卡片会立即失效，工具返回失败，当前 run 的正常回复仍可继续发送。

卡片生命周期会以最小元数据写入插件状态目录。gateway 重启时不会把旧卡恢复成可回答状态：尚未提交的卡片会提示“服务已重启，原问题上下文已失效”；已经进入回答分发但尚未确认完成的卡片会提示本次处理结果可能未完成。重启恢复不会伪造一条新的用户消息。

如果卡片回答已收到，但重新注入 OpenClaw 会话失败，卡片会提示用户发送一条普通消息继续。生命周期持久化不包含 session webhook、access token、完整配置、日志对象、函数或用户回答正文。

## 入参形态

`dingtalk_ask_user_question` 支持两种入参：

| 字段 | 说明 |
| --- | --- |
| `questions` | 轻量问题 DSL，适合确认、单选、多选和简单文本输入 |
| `fields` | 钉钉表单变量协议，适合多字段收集、复杂表单、日期时间、数字、布尔开关等 |
| `target` | 可选的定向投放对象，支持指定同事私聊或群聊及填写人名单；省略时保持原来的当前用户提问行为 |

`fields` 支持 `TEXT`、`TEXT_AREA`、`NUMBER`、`SELECT`、`MULTI_SELECT`、`DATE`、`TIME`、`DATETIME`、`CHECKBOX`、`SWITCH`、`CHECKBOX_GROUP`、`MULTI_CHECKBOX_GROUP` 等表单字段类型。

## 发给同事或群里的指定填写人

通过可选的 `target`，可以从当前钉钉会话发起收集，把表单投放给另一位同事，或投放到群里供指定成员填写。卡片的投放位置与结果回传位置独立：结果始终返回**发起表单的原会话和原 agent 路由**，不会切换到填写人的会话。若从群聊发起，结果也回到该群聊；需要私下收集时，请从与机器人的私聊发起。

发给同事填写：

```json
{
  "target": { "type": "user", "id": "同事的真实staffId" },
  "title": "收集发布意见",
  "fields": [
    { "name": "comment", "label": "发布意见", "type": "TEXT_AREA" }
  ]
}
```

发到群里，由两位指定成员分别填写：

```json
{
  "target": {
    "type": "group",
    "id": "目标群的真实conversationId",
    "respondentUserIds": ["成员甲的真实staffId", "成员乙的真实staffId"]
  },
  "title": "收集发布时间",
  "fields": [
    { "name": "date", "label": "建议日期", "type": "DATE", "required": true }
  ]
}
```

`target.id` 使用原始 ID，不带 `user:`、`group:` 等前缀。ID 必须来自用户明确提供的信息或已核实的钉钉目录，不能根据姓名猜测。`type=user` 只接受该用户填写，不能另外设置 `respondentUserIds`；`type=group` 必须显式列出 1–50 个不重复的填写人 staffId。机器人必须具有向目标用户或群投放卡片的权限，接口投放失败时工具会返回失败。

定向表单的收集规则：

- 未指定 `target` 的现有调用完全保持原行为；指定 `target` 后，发起人不会自动获得填写权限，只有目标用户或名单内成员可提交。
- 每人仅接收第一次提交或取消，重复回调不会覆盖已收集的答案。一个人取消只记为该人的 `cancelled`，不会取消其他人的填写。
- 收齐所有指定人员的回应后，仅向发起会话回传一次汇总；空提交记为 `empty`，每份结果都附带填写人的 `respondent_user_id`。
- 等待时间默认 5 分钟，可用 `timeoutMinutes` 指定 1–1440 分钟（最长 24 小时），只适用于定向表单。工具返回 `deadline` 和 `questionId`。截止时回传已收集结果，未回应的人标为 `missing`，整体标为 `expired`；旧卡不能继续提交。
- 群卡片在标题右侧显示收集进度（如 `1/2`），收集期间保留原始填写说明，不展示填写内容；全部收齐前仍显示表单，已经填写的人再次提交会被忽略。定向卡片关闭转发，服务端仍校验实际回调账号和填写人，不能通过转发获得填写权限。
- 定向表单独立收集：普通聊天、新建定向表单或当前用户表单，都不会覆盖已有定向表单。收齐仍立即结束；发起人可在原会话明确取消某张表单。暂停原任务失败时卡片仍会失效。
- 回答只在内存中等待汇总，不写入生命周期持久化文件。重启会终止未完成的收集，部分结果不会恢复或自动回传。
- 长时收集回传时会重新检查原会话 webhook 的有效期；已过期、即将过期或有效期未知时，通过主动消息接口回到原发起私聊或群聊，不会改发给填写人。机器人需要拥有向原发起用户或群主动发送消息的权限，且目标仍在应用可访问范围内；延长表单时间不会延长 webhook 的有效期。

### 指定时长、查看和取消

例如：“发到项目群让甲乙填写，等 30 分钟”，创建时使用 `target` 和 `timeoutMinutes: 30`。未指定 `target` 的旧表单不支持自定义超时，仍保持 5 分钟及原失效规则。

发起人在原会话说“查看我正在收集的表单”，机器人调用 `{"action":"list"}`，取得标题、`questionId`、截止时间和已回应人数。说“取消午餐表单”时，先从列表确定唯一表单，再调用 `{"action":"cancel","questionId":"真实ID"}`；重名时须确认，不能猜 ID。

取消使该表单立即结束，并通过本次工具结果返回已收集答案及未回应名单，不另发一条重复回传。列表和取消仅对原会话、原 agent 下由当前用户发起的定向表单生效。表单内的“取消”仍仅表示该成员不填写。

**网关或钉钉通道重启会终止未完成表单。**本阶段不持久化答案，也不在重启后恢复收集。电脑睡眠后，宿主健康检查可能重启钉钉通道，同样会终止收集。

这不是匿名问卷或面向任意群成员的公开表单，也不支持从钉钉上下文之外发起投放。`questions` 和 `fields` 两种表单定义都可搭配 `target`，无需更换内置模板。

汇总回复由 agent 根据结构化结果生成。工具会引导 agent 使用会话语言、原始题目标签和逐人结果；中文会话使用“已提交”“未回应”等状态，避免直接展示 JSON 或内部字段名。创建字段时应提供易读的 `label`，例如 `name: "code", label: "测试代号"`。这是展示指引，并非固定消息模板；复制消息时的客户端换行转换不由该指引控制。

标题和整体状态使用顶层列表，填写人分段，答案使用简单列表；避免行尾双空格强制换行、前导对齐空格、嵌套列表和表格。多行答案可单独使用代码块保留原文，排版规范不删除答案本身的空格或缩进。

中文汇总开头统一为以下格式，收集状态按实际结果使用“已完成”“已超时”或“已取消”；“已完成”不代表每位填写人都提交了答案，各人的状态在后面单独列出。

```text
- 表单标题：DISPLAY-022 多字段展示
- 收集状态：已完成
```

## 如何让 agent 使用

使用者不需要单独配置工具 schema，也不需要手动填写卡片模板 ID。安装包含该能力的后续 `@soimy/dingtalk` 发布版本并允许 `dingtalk` 插件后，OpenClaw 会在工具发现阶段把 `dingtalk_ask_user_question` 暴露给 agent。

> 本能力需要安装包含表单互动卡片实现的发布版本，或使用包含本页实现的本地源码安装。

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
