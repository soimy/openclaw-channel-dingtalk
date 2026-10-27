# AI 卡片评价部署与升级

适用：以社区版 3.9.0 为基础、包含本功能的构建，宿主要求 OpenClaw 2026.8.1 及以上。本次实现参考 RowanZhong/openclaw-channel-dingtalk 固定提交 [`62d95592365363ae021c1e58f0521c181077156f`](https://github.com/RowanZhong/openclaw-channel-dingtalk/tree/62d95592365363ae021c1e58f0521c181077156f)，已按社区新版模块结构接入。该提交的历史测试结果不代表本次构建已通过验收。

## 1. 部署条件

首次部署需要同时满足：

1. 安装包含本功能的插件，并构建 `dist/index.js` 和 `dist/feedback-reporting-worker.js`。
2. 钉钉配置启用 `messageType: "card"` 与 `feedbackEnabled: true`。
3. 实际卡片模板有原生 Feedback 组件，启用赞踩，回调 Action ID 为 `feedback_vote`。
4. 员工实例的状态目录可写且持久化，实例标识在重启后稳定。

平台模板不会随着代码更新自动修改。已有符合协议的模板可以继续使用；没有编辑权限时，在本企业应用下导入 `docs/assets/card-template-v2.json` 并发布。不要覆盖其他应用共享的模板。

当前模板 ID 由网关进程环境变量 `DINGTALK_CARD_TEMPLATE_ID` 指定，默认值在 `src/card/card-template.ts`。`channels.dingtalk.cardTemplateId` 不是当前流式模板的切换入口。环境变量应由本次网关进程或对应服务配置注入，不能只在另一个终端设置。

## 2. 构建与安装

先备份当前插件路径、配置和模板 ID。使用项目声明的 pnpm 版本安装锁定依赖：

```bash
pnpm install --frozen-lockfile
pnpm run type-check
pnpm run lint
pnpm run build
pnpm test
pnpm run pack:check
```

开发联调时将 `plugins.load.paths` 中原有钉钉插件路径替换为当前项目的绝对路径。不要同时加载两份 ID 为 `dingtalk` 的插件。保留其他插件配置；如需暂时禁用依赖旧钉钉插件的扩展，应备份并记录。

修改源码后必须重新执行 `pnpm run build:runtime` 再重启网关。OpenClaw 真机运行加载 `dist/index.js`。分发时核对构建哈希，不能只依赖 `package.json` 的版本号；本功能尚未发布到上游 npm。

## 3. 功能开关

将下面字段合并到现有配置，保留已有凭据和访问策略：

```json5
{
  channels: {
    dingtalk: {
      messageType: "card",
      feedbackEnabled: true,
      feedbackRetentionDays: 90,
      feedbackReporting: { enabled: false },
    },
  },
}
```

`feedbackEnabled` 默认关闭。`feedbackRetentionDays` 默认为 90 天，范围 1～365 天；按账号覆盖时使用 `channels.dingtalk.accounts.<accountId>`。赞踩与 `/learn` 无关，不需要开启 `learningEnabled`。

本地加载的插件在新宿主上还需要会话事件访问权限，才能取得 `llm_output` 与精确转录关联。合并以下插件设置，保留其他插件配置：

```json5
{
  plugins: {
    entries: {
      dingtalk: { enabled: true, hooks: { allowConversationAccess: true } },
    },
  },
}
```

若启动日志提示 `llm_output` 被阻止，请核对该设置。关联捕获仅保留当前卡片所属会话的消息标识，不会扫描其他会话；缺少可信关联时会明确返回不可反查状态。

原提问者归属来自真实入站消息的 `senderStaffId`，不接受卡片提交参数提供的所有者。旧卡片、主动推送、未完成或失败回答不接受评价。功能启用后使用新建并正常完成的回答卡片验收。

## 4. HTTP 上报

只有业务需要集中保存时才开启上报。公司接收服务提供完整 POST endpoint 和独立 Bearer 凭据；插件主动发送最新评价及对应的一问一答，不需要定时拉取。

```json5
{
  feedbackReporting: {
    enabled: true,
    endpoint: "https://internal.example.com/v1/feedback/snapshots",
    tenantId: "company-id",
    instanceId: "stable-employee-instance-id",
    token: { source: "env", provider: "default", id: "FEEDBACK_REPORT_TOKEN" },
  },
}
```

将该对象放入钉钉账号配置。SecretInput 的 provider 需由宿主配置并授权，详见[HTTP 上报说明](../features/feedback-http-reporting.md)。不要复用钉钉 appSecret 作为接收端凭据。

接收端按记录 ID 和 revision 幂等处理，事务提交成功后才返回协议 ACK。撤销同步为 `none`，不可累计请求次数作为票数。字段、异常语义和数据库映射见[接口对接手册](../reference/feedback-reporting-api.md)。参考 OceanBase DDL 不代表已经连接公司数据库。

关闭上报可设置 `feedbackReporting.enabled: false` 并重启；本地评价继续有效。保留待发送文件，重新启用后可补传。修改 endpoint、tenantId 或 instanceId 会改变目的地，历史记录不会自动批量迁移。

## 5. 真机验证

启动前检查端口。并行项目使用独立状态目录、测试账号或明确安排的独占测试窗口，记录实际端口及本次进程 PID。不要停止无关服务。

重启后执行 `openclaw channels status --probe --json`，确认钉钉渠道 running 且账号 connected，再在客户端操作：

- 原提问者点赞、撤销、点踩、提交原因、再次撤销；按钮和统计一致。
- 群内另一成员尝试每种操作，都被拒绝且不改变原提问者的记录。
- 私聊执行 `/feedback stats 30d`；群聊不公开本人统计。
- 连续提出两个不同问题，要求相同答案；分别用完整卡片 ID 执行 `/feedback detail <cardId>`，核对每次对应的问题。
- 重启后再次查询与撤销，核对本地持久化和上报结果。
- 接收端返回 503、超时或无效 ACK 时本地评价仍成功；恢复后补传，中心只保留最新状态。
- 删除测试转录或改变其内容，检查 missing/unverified/pending，不能回退到最近回答。

客户端实际操作与可见结果是验收依据。模拟回调、日志和本地 HTTP 测试不能替代真机交互。验证记录见源码 `docs/plans/2026-10-25-feedback-port-validation.md`。

## 6. 回滚

备份并恢复原插件路径、临时开关、模板环境和状态路径，再重启对应网关。若用户要求保留联调环境，则等待通知后恢复。不要删除评价或 outbox 文件来回滚；关闭功能即可停止接收新的评价或上报。

## 8. 数据在哪里、占多少空间

钉钉账号存储位置由宿主 `resolveStorePath(cfg.session?.store, { agentId: accountId })` 决定。账号 ID 与实际回答 Agent ID 可能不同，不能固定假设为 `main`。评价元数据位于该路径同级的 `dingtalk-state/feedback.ratings.*.json`，HTTP 待办和回执为 `feedback.report.*.json`。

每张新关联卡片在点击前即保存归属。容量估算应使用“每日关联卡片数 × 保留天数 × 实际文件系统分配大小”，另加尚未 ACK 的正文和回执容量，不能只按点赞数量估算。保留期限内不要让两个网关写同一份状态；Kubernetes 部署需使用持久卷。

管理员可导出当前快照：

```bash
node scripts/feedback-export.mjs \
  --state-dir /path/to/account/sessions/dingtalk-state \
  --account default --days 30 --format json
```

可选 `--user '<UserId>'`、`--format csv`。导出字段 `cardId` 等于原始记录 `outTrackId`，作为 `/feedback detail` 的完整参数。导出不含全部去重及生命周期状态，不是完整备份或迁移文件。

本功能基于 OpenClaw DingTalk Channel Plugin，YM Shen and contributors，遵循 [MIT 许可](https://github.com/soimy/openclaw-channel-dingtalk/blob/main/LICENSE)。
