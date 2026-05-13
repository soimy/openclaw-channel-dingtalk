# X/Twitter 伴随工作流

DingTalk Channel 负责把 OpenClaw Agent 接入钉钉企业内部机器人，让同一个 Agent 能在私聊、群聊、AI 卡片、富媒体、引用消息、多 Agent 绑定和主动消息中工作。

如果这个钉钉会话里的 Agent 还需要执行 X/Twitter 自动化，可以把 [TweetClaw](https://github.com/Xquik-dev/tweetclaw) 作为并列 OpenClaw 插件安装：

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

## 责任边界

| 插件 | 负责什么 |
| --- | --- |
| DingTalk Channel | 钉钉私聊、群聊、@机器人、AI 卡片、Markdown 回复、富媒体、钉钉文档/文件卡片、多 Agent 路由、主动消息 |
| TweetClaw | 搜索推文、搜索推文回复、导出粉丝、查询用户、发推/回复、媒体上传/下载、私信、推文监控、webhook、抽奖 |

这样的组合适合把钉钉作为团队入口，让 Agent 在需要时调用 TweetClaw 完成 X/Twitter 任务。例如：

- 在钉钉群里让 Agent 搜索某个话题的最近推文和回复，再汇总为 AI 卡片。
- 从 X/Twitter 导出关注者或候选用户名单，再把结果发回钉钉群。
- 先在钉钉中确认文案，再通过 TweetClaw 发推或回复。
- 用 TweetClaw 监控关键词或账号事件，再通过 OpenClaw 主动消息通知钉钉会话。

## 安全边界

- TweetClaw 的凭据只放在 TweetClaw 配置或 OpenClaw 主机环境变量中，不要写入钉钉消息、README 示例或共享截图。
- 发推、回复、关注、私信、监控、webhook 和其他可见或写入操作，应继续经过 OpenClaw 审批后再执行。
- DingTalk Channel 不替 TweetClaw 保存 X/Twitter 凭据，也不改变 TweetClaw 的工具权限。
- 如果当前 OpenClaw profile 看得到 TweetClaw skill 但无法调用工具，优先使用 `tools.alsoAllow` 增加 `explore` 和 `tweetclaw`，不要为了一个外部插件替换整套工具 profile。
