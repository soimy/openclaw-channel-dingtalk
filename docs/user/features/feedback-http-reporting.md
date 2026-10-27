# 评价 HTTP 上报：只同步最新状态与对应问答

适用：社区版 3.9.0，OpenClaw 2026.8.1 及以上。功能默认关闭。只上报发生过本人有效评价的卡片，不上传整个会话、思考过程、工具结果或未评价回答。中心数据库由公司接收服务负责，插件不直连 OceanBase。

## 数据流程和交付边界

**调用方是员工 Pod 内的钉钉插件，被调用方是公司接收服务。** 接收服务提供 POST 接口，插件向配置的完整 endpoint 发送；无需接收端定时拉取、OpenClaw cron 或 PowerJob 任务。有效评价触发待办，插件负责空闲发送、失败退避、pending 正文复查和重启补传。完整时机表见[接口对接手册第 1 节](../reference/feedback-reporting-api.md#_1-调用方向、触发时机与双方职责)。

```text
真实赞踩/撤销 → 本地评价与单调源版本同次落盘 → 钉钉确认
                            ↓ 小型内存通知 / 重启恢复
                     空闲时启动一个受限 Worker
                            ↓
                 精确读取原问题与最终回答，核对指纹
                            ↓
                  耐久保存请求 → HTTP POST → 持久化 ACK
```

插件与接收服务共同保证最终一致。第一版不是每次点击的完整审计流水：尚未发送的多次变化可以合并为最新状态；撤销必须同步成 `none`。中心统计只将 `like` / `dislike` 计为有效票，不能按 HTTP 请求次数累计。

配套文件：

- [接口对接手册](../reference/feedback-reporting-api.md)：字段逐项解释、完整请求/ACK、错误码、数据库映射与联调步骤。
- [OpenAPI 3.1 定义](../reference/feedback-reporting.openapi.json)及[完整示例集合](../reference/feedback-reporting-examples.json)：可导入接口调试工具，示例哈希已实际计算。
- `docs/user/reference/feedback-reporting-oceanbase.sql`：OceanBase 4.2.5.7 MySQL 模式参考 DDL 与事务步骤。
- `scripts/feedback-reporting-receiver.mjs`：本机契约验收接收器，以文件耐久存储模拟数据库提交；不是生产 OceanBase 服务。

## 配置

配置更新后重启网关加载。缺失启用所需字段或无法解析上报目标时，服务记录警告并停止该账号上报，保持渠道可用；JSON/schema 本身非法仍按 OpenClaw 普通配置校验处理，不能保证非法配置不影响网关启动。

将以下字段合并到已有钉钉配置中。每个员工实例使用稳定且唯一的 `instanceId`；Pod 重建时不能更换它。`tenantId` 是业务企业标识，不能用所有实例都相同的 `accountId=default` 替代实例身份。

```json5
{
  channels: {
    dingtalk: {
      feedbackEnabled: true,
      feedbackReporting: {
        enabled: true,
        endpoint: "https://internal.example.com/v1/feedback/snapshots",
        tenantId: "company-id",
        instanceId: "employee-instance-id",
        token: {
          source: "env",
          provider: "default",
          id: "FEEDBACK_REPORT_TOKEN",
        },
      },
    },
  },
}
```

上例的 `provider: "default"` 需与宿主 provider 名称一致。合并到已有配置的环境变量 provider 示例（不要覆盖其他 provider）：

```json5
{
  secrets: {
    providers: {
      default: { source: "env", allowlist: ["FEEDBACK_REPORT_TOKEN"] },
    },
  },
}
```

SecretInput 的 provider 必须在宿主现有 `secrets.providers` 中配置并授权该环境变量。也支持 file SecretInput；不支持执行命令获取凭据。可在多账号下覆盖 `feedbackReporting`，覆盖时应提供完整对象。

配置字段一览（下表均位于 `channels.dingtalk.feedbackReporting` 或对应 account 内）：

| 字段 | 类型 / 默认 | 必填条件与含义 |
| --- | --- | --- |
| `enabled` | boolean / false | 显式开启上报；还需渠道启用且 feedbackEnabled=true |
| `endpoint` | string / 无 | 开启必填；完整 HTTP(S) URL，最长 2048 字符，包含公司实际路由 |
| `tenantId` | string / 无 | 开启必填，1～128 字符；企业标识，不随 Pod 重建改变 |
| `instanceId` | string / 无 | 开启必填，1～128 字符；稳定逻辑实例标识 |
| `token` | string 或 SecretInput / 无 | 开启必填；公司接收服务凭据，推荐 env/file 引用，不能使用钉钉 token |
| `allowInsecureHttp` | boolean / false | 显式允许非本机 HTTP；默认 HTTPS，loopback 可例外 |
| `idleMs` | integer / 5000 | 等待前台空闲的毫秒数，1000～60000 |
| `requestTimeoutMs` | integer / 5000 | 请求全过程期限，500～10000ms |
| `maxTranscriptBytes` | integer / 8388608 | 读取上限 65536～33554432 字节 |
| `maxContentBytes` | integer / 131072 | 整组正文 JSON 编码上限 1024～262144 字节，超限 pending |
| `workerMemoryMb` | integer / 128 | JS 老生代预算 64～256MiB，不是整个进程 RSS 上限 |

`token` 引用对象逐项：`source` 必填为 env/file；`provider` 是已配置 provider 名；`id` 是该 provider 的变量/文件引用键，具体文件解析方式由宿主定义。内存缓存最多 10 分钟，失败后重读；env 来源的 Kubernetes Secret 变更需重启 Pod 才进入进程环境。

默认仅接受 HTTPS；本机 `localhost` / `127.0.0.1` / `::1` 可用 HTTP 验收。公司确需私网 HTTP 时须显式设置 `allowInsecureHttp: true`。禁止 URL 中的用户名、密码、query、fragment；请求不跟随重定向，避免把凭据转发到其他地址。目的地来自管理员配置，不由模型或卡片参数指定。

开启后新的有效评价操作会生成待上报版本；不会自动批量上传以前全部问答。关闭上报后保留原有本地评价；已进入同步范围的记录若继续变化，其源版本仍递增，重新启用后可补传。修改 endpoint / tenantId / instanceId 会改变目的地 scope，已有记录不会自动批量改投；同卡后续真实有效评价会按当前目的地重新登记。此类迁移应由管理员协调，不能简单换 URL 后认为历史同步完成。

## 协议语义

每次 POST 为一张卡片的最新评价快照。`recordId` 为以下 UTF-8 JSON 数组（无多余空格，按顺序）的 SHA-256：

```text
[tenantId, instanceId, accountId, cardId]
```

请求头：`Authorization: Bearer <credential>`、`Idempotency-Key: <recordId>:<revision>`。接收端必须验证凭据所属企业和实例与请求一致，不能仅相信请求体的身份。`questionerUserId` 是原提问者，可能与实例所属员工不同。

`revision` 是已持久化的上报版本，范围为 1～9007199254740990。它与本地评价源版本分开：正文从待采集变为可用也会形成新的上报版本。相同版本的重试必须复用同一份请求；同版本不同内容属于冲突。

200 响应必须包含：

```json
{
  "schemaVersion": 1,
  "recordId": "请求中的完整recordId",
  "acceptedRevision": 3,
  "status": "applied"
}
```

- `applied` / `duplicate`：确认的版本必须等于请求版本。
- `stale`：确认的版本必须严格大于请求版本；发送端将这个本地快照标记为已被取代并释放待发正文，不自动抬高旧快照版本去覆盖中心的新状态。它不证明中心已收到此快照的正文；后续真实评价变化会重新核验原问答，并使用高于已知中心版本的新版本；日志区分 superseded 与 saved。
- 接收服务只有在事务提交成功后才能确认。`200 {"ok":true}`、身份不符或版本不符均不能使插件清除待上报状态。
- 3xx 不跳转；非 200、网络失败、超时和非法 ACK 都保留请求并退避重试。
- 请求上限 300 KiB，响应上限 8 KiB；不得返回整份问答或大型诊断信息。

### 正文状态

| status | 含义 |
| --- | --- |
| `available` | 按精确 ID 取得一问一答，并核对回答 SHA-256 一致 |
| `missing` | 已确认转录/指定消息不存在，或旧记录没有精确引用；reason 区分原因 |
| `unverified` | 内容、身份、会话头或指纹校验不通过；不附带未经核实的正文 |
| `pending` | 资源预算不足、暂时读取失败或缺少受支持的有界读取能力；不是“正文已删除” |

`content.mode=replace` 提供此次正文结果；`preserve` 表示保留中心已有正文。available、missing、unverified 都是当前发送端的正文终态，获 applied/duplicate ACK 后后续评价只发保留指令，不自动重读；pending 才会继续定期尝试。接收方不得用缺省/空字段清空已有正文；可用正文不能被较弱的 pending/missing 状态覆盖。中心数据灾难恢复丢失原记录时，不能确认 `preserve`，应报告冲突并由管理员协调重放/恢复。

## 主线程和资源边界

- 评价回调不等待 HTTP，不读取转录，不新增一次评价文件落盘；只附加少量版本及目的地元数据。
- 正文解析、校验、JSON 请求打包和 HTTP 在独立 Worker 中进行，每实例最多一个；短时连续任务复用线程，空闲 5 秒回收，前台开始时立即退让。
- 钉钉入站处理、评价回调以及宿主 Agent 生命周期开始会终止当前 Worker；已保存 outbox 可重试，已经送达但 ACK 丢失的请求由接收端幂等处理。
- 启动恢复延后 30～90 秒，逐个读取最多 64 KiB 的小型评价元数据，默认间隔 100ms；不在插件启动时等待网络或扫描所有转录。
- 内存就绪队列最多 128 张卡。HTTP 失败或正文 pending 后，重试期限写入小型 receipt，并释放队列位置，避免旧待办阻挡新评价。另有最多 1024 项的重试索引，只保存账号引用、卡片标识、到期时间和调度标记，不复制问答正文；优先保留较早到期的任务。已索引任务到期直接定位小型记录，不必重新遍历历史目录；每次调度最多接纳一个到期任务，新评价可提前唤醒本卡。
- receipt 仍是重试的持久化依据。重启先进行一次节流恢复扫描，重建索引并保留退避期限；索引溢出或未收到通知的任务仍由扫描发现，不会因内存容量限制删除待办。首次恢复和溢出恢复仍受目录大小影响，不能将普通重试的优化理解为所有恢复路径均与历史量无关。
- 无待办时调度器休眠；前台 Agent 运行期间不启动扫描、资源探测或新 Worker，结束后等待空闲窗口。等待退避时按下一次到期时间唤醒，不持续轮询。
- 宿主事件循环最大延迟超过 50ms 时暂停新工作。Linux cgroup v2 的内存使用超过上限 80%、持续 CPU 限流或 cgroup CPU 等待压力（some avg10 > 10%）也会退让；同时要求实际可用内存至少为 `max(256MiB, 2 × Worker 老生代预算)`；无法读取 cgroup 或在其他系统上时使用 Node 的可用内存指标（含可回收内存），不将单独的进程 RSS 超过 1GiB 当作内存不足，也不将其声称为完整节点资源监控。
- Worker 默认 JS 老生代上限 128 MiB、任务最多 20 秒；这不是整个进程 RSS 硬上限。操作系统资源竞争和 OOM 仍必须通过部署容量与压力测试评估。
- 不同钉钉账号的 Worker 预算不同时，串行结束旧 Worker 并按新预算创建，不将正常预算切换计为投递失败。

可调参数：

| 字段 | 默认值 | 范围 / 用途 |
| --- | --- | --- |
| `idleMs` | 5000 | 1000～60000ms；空闲窗口 |
| `requestTimeoutMs` | 5000 | 500～10000ms；覆盖 DNS、连接、TLS、响应全过程 |
| `maxTranscriptBytes` | 8388608 | 64 KiB～32 MiB；单次转录读取总量上限 |
| `maxContentBytes` | 131072 | 1～256 KiB；整组正文编码大小上限，超限暂缓，不静默截断 |
| `workerMemoryMb` | 128 | 64～256；Worker JS 堆限制 |

重试间隔从约 5 秒指数增长到约 5 分钟，并带随机抖动。正文 pending 的正常复查间隔为 5 分钟。到期后仍须经过调度、资源采样和就绪队列；前台活动与资源压力期间索引不会启动读取或上报。负载高时允许延后上报，不影响评价在本地的有效性；不承诺零 CPU/内存开销或任意负载下绝对零延迟。

## 正文读取和宿主兼容

上报开启后，新回答可保存来自可信宿主事件的本地文件提示；它仅用于受限后台读取，必须位于相应 Agent 存储目录中，且仍校验会话头、消息 ID、提问者及回答指纹，绝不上传这个文件路径。没有提示的旧记录通过宿主公开的只读会话解析/路径 helper 定位精确转录，在 Worker 内按上限流式扫描，只保留目标消息。不会调用会写回宿主 session 元数据的旧 `resolveSessionTranscriptLegacyFileTarget`，也不会无上限物化整份历史。普通 main 会话重置后仍按保存的旧 SID 定位；无法可靠解析的线程目标保持 pending，不猜测最新回答。

SQLite 宿主通过公开的 `readSessionTranscriptRawDelta` 接口分页读取。每页最多 128 个事件，通常限于 64 KiB，单个事件最多 1 MiB，总读取量仍受 `maxTranscriptBytes` 约束；只保留指定会话头和两条目标消息。游标代际变化或读取期间发生替换时返回 pending，不能混用两个版本的转录。新宿主缺少该能力时发送 pending 元数据，不回退成主线程全量读取。旧 JSONL 直接进行有界读取，不调用会生成 SQLite 导出文件的旧路径 helper；单行缓冲超限同样返回 pending/resource_budget，不判为 invalid_transcript。

`scripts/feedback-host-compatibility.ts` 可针对独立安装的宿主运行真实 SQLite、Worker、HTTP 与事务 ACK 验收；本次版本矩阵与结果见源码验证记录。

## 本地持久化及运维

源评价仍在 `feedback.ratings.*.json`，新增 `reporting.revision / destinationKey / retainUntil`。后台 outbox 和小型 receipt 位于同级 `feedback.report.*.json` / `*.receipt.json`，仅发生过评价的卡片产生这些文件。

待发正文只在未获确认时进入 outbox；获确认后移除正文，保留关联及状态。文件权限为 0600。中断写入最多遗留每个 outbox 一个 `.tmp`，恢复扫描会清理过期临时文件。不得让两个网关进程共享同一员工状态目录写入。

本次修复升级包含一次本地状态维护：清理旧 superseded 终态中遗留的正文，并对旧版已确认的 `unverified/invalid_transcript` 做一次有界复核，修正长行超限误判。旧请求若尚未取得可靠 ACK，先原样重发，再用更高版本复核；真正损坏的转录复核后仍为终态。维护版本仅保存在本地，不改变 HTTP 协议，也不会每次重启重复复核全部终态记录。

评价清理会保留至少“最近一次待上报变更后 7 天”与原评价到期时间中的较晚者；超过原评价到期时间后不再计入员工统计。到达保留期限后可以清理，即不保证无限离线仍无损补传。后台状态文件在恢复扫描时按到期时间回收，空闲进程可能较晚清理；应监控目录容量。

日志只记录卡片 ID、版本和固定错误代码，不记录正文、Bearer 或服务端原始错误。`[DingTalk][FeedbackReport] saved` 表示接收方对该版本持久确认；`pending` 表示正文延后或请求尚未可靠确认。持续 401/403、409、资源预算不足应由管理员处理，不会弹出卡片干扰员工。

## 接收端与 OceanBase

接收端独立于 Agent/LLM 调用链，可复用公司已有后台。遵循参考 SQL 的事务步骤：按主键锁定/插入、核对不可变身份、按 revision 选择应用/重复/旧版本，再 COMMIT 后回应。并发首次插入冲突要回滚重试，不能先查询后无约束插入。账号、卡片、员工字段使用区分大小写的比较。

参考 DDL 不代表已连接或验证公司 OceanBase；本仓库交付通用上报接口、参考表结构和验收接收器，生产接口由公司按约定接入。

## 本机验收接收器

```bash
# 通过服务环境注入 FEEDBACK_REPORT_TOKEN，勿把真实凭据放进命令历史
node scripts/feedback-reporting-receiver.mjs \
  --state-dir /tmp/feedback-acceptance \
  --tenant test-org --instance test-instance --port 19071
```

接口为 `http://127.0.0.1:19071/v1/feedback/snapshots`，只供本机验证。接收器把每条最新结果原子保存到指定目录。可在该目录的 `control.json` 配置 `{"status":503}`、`{"delayMs":10000}` 或 `{"badAck":true}` 注入故障；改为 `{}` 恢复。不要将这个故障控制机制用于生产。

本次移植的验证范围、环境和结果记录在源码 `docs/plans/2026-10-25-feedback-port-validation.md`。参考分支的历史结果不代表当前构建已经通过真机、性能或部署容量验收。
