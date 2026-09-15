# PR #611 真机测试方案：Gateway docs / 主动发送 RPC 能力开关与白名单

- PR: [#611](https://github.com/soimy/openclaw-channel-dingtalk/pull/611) `feat(gateway): add capability gates for docs and proactive-send RPCs`
- 分支 / 工作树：`fix/issue-608-gateway-gate` → `.worktrees/fix-issue-608-gateway-gate`（HEAD `c3ebd59`，= `origin/main` + 3 个 gate 提交）
- 被测改动：13 个文件；核心是 `src/config-schema.ts`（schema）、`src/config.ts`（`resolveGatewayCapabilityConfig` / 按子键合并 / 白名单校验）、`index.ts`（`withDocsGatewayCapability` / `withProactiveSendGatewayCapability`）、`openclaw.plugin.json`（manifest 同步）
- 配置键：`channels.dingtalk.gatewayCapabilities`（复审阶段由 `gatewayRpc` 改名；若 PR 描述里仍写 `gatewayRpc`，以本文件为准）
- 不在本方案范围：ClawHub 重新审核（需先发版）、Issue #608 问题 1/2/4、`src/media-utils.ts`（属 #610，已并入 `origin/main`）

## 0. 一句话结论

本 PR 改的是 **Gateway RPC 的授权边界**，不是消息链路。因此主验证手段是 `openclaw gateway call` + 网关日志，只有"聊天回复通道不受影响"这一条必须走真实钉钉入站。**关键坑：被 gate 拒绝时 CLI 只显示 `"gateway request failed"`，拒绝原因只出现在日志里**——测试必须按第 2 节的三个信号来判断，不能只看 CLI 文案。

## 1. 测试前必须知道的两件事（否则会误判）

### 1.1 拒绝原因不透出到 CLI

`index.ts` 的 `denyGatewayCapability()` 调用的是 `respond(false, { error: reason })`，没有传 `ErrorShape`。实测（当前线上网关，走的是未含 gate 的 main 构建，用等价的 deny 分支）：

```bash
$ openclaw gateway call dingtalk-connector.send --params '{"target":"foo:bar","content":"hi"}' --json
{
  "ok": false,
  "error": { "type": "gateway_request_error", "code": "UNAVAILABLE",
             "message": "gateway request failed", "retryable": false }
}
```

原因文案丢失。所以**判定依据必须叠加日志**（见 2.2 / 2.3）。这也是本方案与 PR 里"返回禁用错误"这条 TODO 的差异，建议按第 6 节补一条可观测性改进。

### 1.2 多账号配置陷阱

`src/channel.ts` 的 `listAccountIds()` 在 `accounts` 非空时**只返回命名账号**（不再返回 `default`）。若直接加 `accounts.gateprobe = {...}`，线上 `default` 账号会不再被 host 启动。
规避方式：测试时同时加 `accounts.default = {}`（空对象合法，继承渠道级配置，accountId 仍是 `default`，会话键不变）。

已用 PR 构建产物本地验证该配置：

```text
listAccountIds: ["default","gateprobe"]
default -> {accountId:"default", configured:true, enabled:true, clientId:"<真实值>"}
gateprobe -> {enabled:false, configured:true}
gateprobe gatewayCapabilities: {"tools":{"docs":true},"docs":{},"send":{"allowedTargets":["group:<渠道级>"]}}
default   gatewayCapabilities: {"tools":{"docs":false},"send":{"allowedTargets":["group:<渠道级>"]}}
```

即：账号级只覆盖 `tools.docs` 时，渠道级 `send.allowedTargets` 仍在（本轮复审的 fail-open 修复点），且 `enabled:false` 的账号会被 host 以 `reason=disabled` 跳过启动。

## 2. 观测方法（三个信号）

### 2.1 信号 A：CLI 的 `ok` 字段（粗判）

```bash
openclaw gateway call <method> --params '<JSON>' --json --timeout 20000
```

- `ok:true` → 放行且执行成功
- `ok:false` + `message:"gateway request failed"` → **可能是** gate 拒绝，也可能是 plugin 里的 `respond(false,...)`；需看信号 B
- `ok:false` + `message:"AxiosError: ..."` / 其他具体文案 → 抛出型错误，说明 handler 已被执行（gate 已放行）

### 2.2 信号 B：Denied 日志行（主证据）

每次 deny 都会打 WARN，格式固定：

```text
[DingTalk][GatewayRPC][Denied] <method>: <reason>
```

查询方式（两种等价，`openclaw logs` 读的是当日 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`）：

```bash
openclaw logs --limit 200 --plain --no-color | grep 'GatewayRPC\]\[Denied\]'
# 或实时跟：
tail -n 0 -f "/tmp/openclaw/openclaw-$(date +%F).log" | grep --line-buffered 'GatewayRPC'
```

### 2.3 信号 C：`⇄ res` 行的形态反差（反向证据）

当日日志里每个 RPC 结束都有一行 `gateway/ws ⇄ res ✓|✗ <method> ...`，两种失败形态明显不同：

| 情况 | 日志行特征 | 说明 |
| --- | --- | --- |
| gate 拒绝（`respond(false,{error})`） | `⇄ res ✗ <method> 2ms conn=… id=…`，**无 `errorCode=` / `errorMessage=`** | 实测样本：`⇄ res ✗ dingtalk-connector.send 2ms conn=… id=…` |
| gate 放行但钉钉 API 报错（抛出） | `⇄ res ✗ <method> 146ms errorCode=UNAVAILABLE errorMessage=AxiosError: Request failed with status code 404: code=ERR_BAD_REQUEST …` | 实测样本：`dingtalk.docs.list` |

因此即使在缺少钉钉文档权限、无法拿到 `ok:true` 的环境里，也能客观区分"被 gate 拦下"和"gate 放行"。

### 2.4 建议的探针封装

```bash
oc_call() {
  local method="$1" params="$2"
  echo "── $(date +%T) $method $params"
  openclaw gateway call "$method" --params "$params" --json --timeout 20000
  sleep 1
  openclaw logs --limit 40 --plain --no-color \
    | grep -E "GatewayRPC..\[Denied\]|res . $method" | tail -3
}
oc_call dingtalk.docs.search '{"keyword":"x"}'
```

每一轮测试前先记一次 `date +%T`，避免把旧日志当成本次证据。

## 3. 环境准备

### 3.1 切到 PR 工作树并构建

```bash
cd /Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/fix-issue-608-gateway-gate
git rev-parse HEAD              # 期望 c3ebd597f709997ceeb5bb01fc25c428b8e0ea39
pnpm run build:runtime          # 已实测通过：dist/index.js 661.8kb，~22ms
grep -c 'GatewayRPC\]\[Denied\]' dist/index.js   # 期望 1
```

### 3.2 把插件加载路径指向工作树（`--dry-run` 先验）

```bash
cat > /tmp/pr611-path.json5 <<'EOF'
{ plugins: { load: { paths: ["/Users/sym/Repo/openclaw-channel-dingtalk/.worktrees/fix-issue-608-gateway-gate"] } } }
EOF
openclaw config patch --file /tmp/pr611-path.json5 --replace-path plugins.load.paths --dry-run --json
openclaw config patch --file /tmp/pr611-path.json5 --replace-path plugins.load.paths
```

### 3.3 重启并确认（按 skill 要求，不许跳过）

```bash
openclaw config validate --json
openclaw gateway restart
openclaw channels status --probe --json   # 期望 channels.dingtalk.running=true 且 channelAccounts.dingtalk[0].connected=true
openclaw plugins list --json              # 期望 dingtalk.rootDir = …/.worktrees/fix-issue-608-gateway-gate
```

- 若首次 probe 落在重启窗口、出现 `1006 abnormal closure`，等几秒重新 probe，不要当成缺陷。
- **加载正确性的自证**：只有工作树的 manifest 才认识 `gatewayCapabilities`，用例 A2 通过即证明加载的是本 PR 的构建（用例 A1 是切换前的对照）。

## 4. 测试矩阵

> 记法：**信号 A / 信号 B / 信号 C** 对应第 2 节。所有"期望 Denied"用例都必须同时满足 A+B（C 为加分项）。

### A. 前置 + P0 回归（0 风险，dry-run，不必重启）

| # | 场景 | 命令 | 期望 |
| --- | --- | --- | --- |
| A1 | 切换前对照（当前 main 插件，已实测） | `echo '{"channels":{"dingtalk":{"gatewayCapabilities":{"tools":{"docs":false}}}}}' \| openclaw config patch --stdin --dry-run --json` | `ok:false`，error `must not have additional properties: "gatewayCapabilities"` |
| A2 | 切换后同一命令 | 同 A1 | `ok:true`（`checks.schema:true`）→ 证明 worktree manifest 已生效、P0 修复成立 |

### B. 基线 / 向后兼容（**不配置** `gatewayCapabilities`）

| # | 场景 | 命令 | 期望 |
| --- | --- | --- | --- |
| B1 | docs RPC 行为不变 | `oc_call dingtalk.docs.list '{"spaceId":"bogus-space-probe"}'` | 与切换前**逐字一致**：A `ok:false` + `AxiosError: Request failed with status code 404: code=ERR_BAD_REQUEST`；C 该行**有** `errorCode=UNAVAILABLE errorMessage=AxiosError…`；B **无** Denied 行 |
| B2 | status 正常 | `oc_call dingtalk-connector.status '{}'` | A `ok:true`，`accounts[0].clientId` 为脱敏尾号（当前 `****hjfp`） |
| B3 | 主动发送默认放行 | `oc_call dingtalk-connector.sendToUser '{"userId":"manager8031","content":"PR611 基线探针（可忽略）"}'` | A `ok:true` + `messageId` 非空；钉钉客户端**真实收到**该私聊消息；B 无 Denied |

> B1 的"切换前基线"已在本机采集（见第 7 节）；测试时不要改任何配置，直接复跑对比。
> `manager8031` 与 `cid//Vc7N7lA5mymGresI0XAw==` 取自你当前 `~/.openclaw/openclaw.json` 的 `allowFrom` / `groupAllowFrom`。

### C. docs 能力开关（`gatewayCapabilities.tools.docs = false`）

配置：`{"channels":{"dingtalk":{"gatewayCapabilities":{"tools":{"docs":false}}}}}` → 重启。

| # | 方法 | params | 期望 reason（B，逐字） |
| --- | --- | --- | --- |
| C1 | `dingtalk.docs.create` | `{"spaceId":"spaceA","title":"T"}` | `dingtalk docs Gateway RPC is disabled by config (gatewayCapabilities.tools.docs = false)` |
| C2 | `dingtalk-connector.docs.create` | 同 C1 | 同 C1（**必须单独验**：别名共享 handler，但注册是两条） |
| C3 | `dingtalk.docs.append` | `{"docId":"d1","content":"c"}` | 同 C1 |
| C4 | `dingtalk.docs.search` | `{"keyword":"k"}` | 同 C1 |
| C5 | `dingtalk.docs.list` | `{"spaceId":"spaceA"}` | 同 C1 |
| C6 | 别名全量抽查 | `dingtalk-connector.docs.append` / `.search` / `.list` | 同 C1 |

C1–C6 全部：A `ok:false` + `message:"gateway request failed"`；B 出现对应的 `[Denied] <method>: …`；C 无 `errorMessage`。

### D. docs 白名单（`tools.docs` 保持 `true`，`docs.allowedSpaceIds = ["space-allow-probe"]`）

| # | 方法 / params | 期望 |
| --- | --- | --- |
| D1 | `dingtalk.docs.list {"spaceId":"space-allow-probe"}` | 命中白名单：B **无** Denied；C 变成 `errorCode=UNAVAILABLE errorMessage=AxiosError…`（gate 已放行，失败原因是钉钉文档权限，见第 5 节） |
| D2 | `dingtalk.docs.list {"spaceId":"space-other"}` | A `ok:false`；B reason = `spaceId is not in gatewayCapabilities.docs.allowedSpaceIds allowlist` |
| D3 | `dingtalk.docs.append {"docId":"d1","content":"c"}` | A `ok:false`；B reason = `docs RPC denied: this request carries no spaceId while gatewayCapabilities.docs.allowedSpaceIds is configured (dingtalk.docs.append never carries a spaceId)` |
| D4 | `dingtalk.docs.search {"keyword":"k"}`（不带 spaceId） | 同 D3 reason（**这是本轮复审新增的行为说明**） |
| D5 | `dingtalk.docs.search {"keyword":"k","spaceId":"space-allow-probe"}` | 同 D1：无 Denied，放行 |
| D6 | 别名验一条 | `dingtalk-connector.docs.list {"spaceId":"space-other"}` → 同 D2 reason |

### E. 主动发送能力开关（`tools.proactiveSend = false`）

| # | 方法 / params | 期望 |
| --- | --- | --- |
| E1 | `dingtalk-connector.sendToUser {"userId":"manager8031","content":"x"}` | A `ok:false`；B reason = `dingtalk proactive-send Gateway RPC is disabled by config (gatewayCapabilities.tools.proactiveSend = false)`；**钉钉不收到任何消息** |
| E2 | `dingtalk-connector.sendToGroup {"openConversationId":"<你的群cid>","content":"x"}` | 同 E1 |
| E3 | `dingtalk-connector.send {"target":"user:manager8031","content":"x"}` | 同 E1 |
| E4 | **fast-path 回归**：`dingtalk-connector.sendToUser {}`（缺 userId 与 content） | 仍为 E1 的结构化 deny，**不得**是 `content or message is required` 或参数解析抛错（gate 先于 required 参数解析，本轮复审修复点） |

### F. 发送目标白名单（`proactiveSend` 为 `true`，`send.allowedTargets = ["group:<你的群cid>"]`）

| # | 方法 / params | 期望 |
| --- | --- | --- |
| F1 | `dingtalk-connector.sendToGroup {"openConversationId":"cid//Vc7N7lA5mymGresI0XAw==","content":"PR611 白名单探针"}` | A `ok:true` + `messageId`；钉钉群**真实收到**；B 无 Denied |
| F2 | `dingtalk-connector.sendToUser {"userId":"manager8031","content":"x"}` | A `ok:false`；B reason = `target is not in gatewayCapabilities.send.allowedTargets allowlist`（`user:*` 与 `group:*` 共用同一名单） |
| F3 | `dingtalk-connector.send {"target":"user:manager8031","content":"x"}` | 同 F2 |
| F4 | `dingtalk-connector.send {"target":"foo:bar","content":"x"}` | 同 F2（gate 先于 `target must start with user: or group:` 校验——顺序差异是预期） |

### G. 多账号按子键合并（**必须用 `accounts.default = {}`**，见 1.2）

测试配置：

```json5
{ channels: { dingtalk: {
  gatewayCapabilities: {
    tools: { docs: false },
    send: { allowedTargets: ["group:cid//Vc7N7lA5mymGresI0XAw=="] }
  },
  accounts: {
    default: {},
    gateprobe: {
      enabled: false,
      clientId: "gate-probe-dummy",
      clientSecret: "gate-probe-dummy",
      gatewayCapabilities: { tools: { docs: true } }
    }
  }
} } }
```

| # | 场景 | 期望 |
| --- | --- | --- |
| G0 | 重启后 `openclaw plugins list --json` + `channels status --probe --json` | `default` 账号仍 `running/connected=true`，`gateprobe` 为 `enabled:false` 且未启动（host 跳过原因 `disabled`）；钉钉 bot 不掉线 |
| G1 | `oc_call dingtalk.docs.list '{"accountId":"gateprobe","spaceId":"space-other"}'` | 账号级 `tools.docs:true` 覆盖渠道级 `false` → **无 Denied**，放行到 API（C 行出现 `errorMessage=AxiosError…`） |
| G2 | `oc_call dingtalk.docs.list '{"spaceId":"space-other"}'`（不带 accountId） | 走 `default`，渠道级 kill switch 生效 → Denied，reason 同 C1 |
| G3 | `oc_call dingtalk-connector.send '{"accountId":"gateprobe","target":"user:manager8031","content":"x"}'` | 账号级只覆盖了 `tools`，渠道级 `send.allowedTargets` 仍生效 → Denied，reason = `target is not in gatewayCapabilities.send.allowedTargets allowlist`（**本轮复审 fail-open 修复的核心断言**） |
| G4 | 未配置账号的继承 | 临时再加 `accounts.inherit = { enabled:false, clientId:"d", clientSecret:"d" }`（不带 `gatewayCapabilities`）→ 用 `accountId=inherit` 复跑 G2，期望与 G2 相同的 Denied（完全继承渠道级） |

### H. 聊天回复通道不受影响（**真机钉钉入站，必做**）

在 `tools.docs=false` + `tools.proactiveSend=false`（或 F 组白名单）配置下：

1. 私聊机器人发一条消息 → 期望正常回复（按当前 `messageType:"card"`/`cardStreamingMode:"answer"` 走卡片）
2. 群里 @机器人 发一条消息 → 期望正常回复
3. 从钉钉客户端**引用**上一条消息再发 → 期望引用恢复正常（引用链路未被本 PR 触碰，作为回归项）
4. 期望：`openclaw logs --limit 300 --plain | grep 'GatewayRPC'` 在这几步**不新增** Denied 行

> 这条不能由 `gateway call` 替代：reply 路径只有真实入站回调才会走到（skill 明确要求）。

### I. `status` / `probe` 不受开关影响

在 `tools.docs=false` 且 `tools.proactiveSend=false` 下：

| # | 命令 | 期望 |
| --- | --- | --- |
| I1 | `oc_call dingtalk-connector.status '{}'` | `ok:true`，`clientId` 仅脱敏尾号 |
| I2 | `oc_call dingtalk-connector.probe '{}'` | `ok:true`（会真实请求 access token） |

### J. 配置校验负例（`--dry-run`，0 风险，无需重启）

每条都用 `openclaw config patch --stdin --dry-run --json`，期望 `ok:false` + 对应 `errors[].message`：

| # | patch | 期望拒绝原因 |
| --- | --- | --- |
| J1 | `{"channels":{"dingtalk":{"gatewayCapabilities":{"docs":{"allowedSpaceIds":[]}}}}}` | 空数组被拒（`minItems: 1`）——空名单不会被静默解释为"不限制" |
| J2 | `{"channels":{"dingtalk":{"gatewayCapabilities":{"send":{"allowedTargets":[]}}}}}` | 同上 |
| J3 | `{... "allowedTargets":["foo:bar"]}` | 不匹配 `^(user\|group):\S+$` |
| J4 | `{... "gatewayCapabilities":{"tool":{"docs":false}}}` | `must not have additional properties: "tool"`（键名拼错即报错） |
| J5 | 账号级：`{"channels":{"dingtalk":{"accounts":{"gateprobe":{"gatewayCapabilities":{"docs":{"allowedSpaceIds":[]}}}}}}}` | 账号级同样被拒（manifest 两处 schema 同步的守护） |

> 说明：J 组验证的是"配置层 fail-closed"。运行时"已配置但为空的白名单按全部拒绝"这一分支在真机上写不进配置（会被校验拦下），只能由 `tests/unit/gateway-capability-gate.test.ts` 覆盖——真机测 J 组即可。
>
> J1–J5 已在本轮用 PR 的 `openclaw.plugin.json` schema + ajv 预验证（见第 9 节），真机复测的目的是确认宿主走的确实是这份 manifest（与 A2 呼应）。
>
> 提示：B3 / F1 是矩阵里**仅有的两处会产生真实用户可见消息**的用例。若 `user:manager8031` 被钉钉判为非法 userId（返回具体 API 错误而非 `ok:true`），改用 F1 的群目标建立"放行"基线即可，不要在没建立放行基线的情况下继续 C–G 的判定。

## 5. 已知限制与环境风险

1. **docs 成功路径（`ok:true`）在当前环境不可达。** 实测当前凭证调用 `/v1.0/doc/*`（`src/docs-service.ts` 的 `https://api.dingtalk.com/v1.0/doc/...`）返回 `AxiosError: Request failed with status code 404: code=ERR_BAD_REQUEST`，即当前应用未开通文档相关 OpenAPI 权限。因此 D1/D5/G1 只能证明"gate 放行"，不能证明"文档操作成功"。若需要完整闭环：给该 app 开通文档 OpenAPI 权限并提供真实 `spaceId`，再补一轮 `docs.create` → `ok:true` 的用例。
2. **拒绝原因对调用方不可见**（1.1）。agent/cron 调用方只能看到 `gateway request failed`。安全语义正确，但排障体验差；建议后续小改（第 6 节）。
3. **多账号测试是配置陷阱**（1.2）。若忘记 `accounts.default = {}`，线上 `default` 账号不会被启动——G0 就是用来兜这条的，发现异常立刻回滚配置。
4. `src/config.ts` 的 `resolveDingTalkAccount()` 在 `default` 分支的字段白名单里没有透出 `gatewayCapabilities`。当前不影响 gate（`resolveGatewayCapabilityConfig` 走 `getConfig(cfg, accountId)` 直读 `channels.dingtalk`），但与其他字段的投影不一致，可作为后续清理项。
5. 需要临时改 `~/.openclaw/openclaw.json` 两次（`plugins.load.paths` + `gatewayCapabilities`/`accounts`），全程用 `openclaw config patch`（带校验），不要手写整个文件。

## 6. 建议的收尾动作（非本 PR 阻塞项）

- 可观测性：给 `denyGatewayCapability()` 补 `ErrorShape`（例如 `errorShape(ErrorCodes.PERMISSION_DENIED, reason)`），让 CLI/调用方能拿到真实拒绝原因；或至少让 `openclaw gateway call` 展示 `responsePayload`。当前 `respond(false,{error})` 的 payload 其实被 client 以不可枚举的 `responsePayload` 保留了，只是 CLI 不打印。
- 清理：把 `gatewayCapabilities` 补进 `resolveDingTalkAccount()` 的 default 投影字段。
- 发版后单独复查 ClawHub `gateway-docs-and-send-rpc` finding 是否降级/消除（PR `验证 TODO` 最后一条，不属真机范围）。

## 7. 收尾与回滚

```bash
# 1) 删除临时 gate 配置（含 accounts 里的）
openclaw config patch --stdin <<'EOF'
{ channels: { dingtalk: { gatewayCapabilities: null, accounts: null } } }
EOF
# 2) 插件路径指回主仓库
cat > /tmp/pr611-restore.json5 <<'EOF'
{ plugins: { load: { paths: ["/Users/sym/Repo/openclaw-channel-dingtalk"] } } }
EOF
openclaw config patch --file /tmp/pr611-restore.json5 --replace-path plugins.load.paths
# 3) 校验 + 重启 + 确认
openclaw config validate --json
openclaw gateway restart
openclaw channels status --probe --json    # running=true / connected=true
openclaw plugins list --json               # rootDir 回到主仓库
# 4) 钉钉里私聊发一条消息，确认线上 bot 正常
```

## 8. 可直接粘贴到 PR 的 `验证 TODO`

```text
验证 TODO（真机）
- 已按 .worktrees/fix-issue-608-gateway-gate 切换 plugins.load.paths，pnpm run build:runtime 后 openclaw gateway restart；
  channels status --probe 确认 running/connected=true，plugins list 确认 rootDir 为该 worktree
- P0 回归：切换前 gatewayCapabilities 被 manifest 拒绝（must not have additional properties），切换后同一 dry-run patch 通过
- 向后兼容：未配置 gatewayCapabilities 时 dingtalk.docs.list 的 CLI 输出与日志形态与切换前逐字一致；sendToUser 真实投递成功
- docs 开关：tools.docs=false 后 dingtalk.docs.* 与 dingtalk-connector.docs.*（create/append/search/list）全部 deny，
  日志出现 [DingTalk][GatewayRPC][Denied] 及 "disabled by config" 原因
- docs 白名单：allowedSpaceIds 命中时放行、未命中拒绝；append 与不带 spaceId 的 search 返回"未携带 spaceId"拒绝
- proactiveSend 开关：三个发送 RPC 全部 deny；缺参时仍是结构化 deny（gate 先于参数解析）；status/probe 不受影响
- send 白名单：allowedTargets 命中的群目标真实投递成功，未命中的 user 目标被拒；聊天回复通道（私聊/群聊/引用）不受影响
- 多账号：accounts.default={} + 账号级只覆盖 tools.docs 时，渠道级 send.allowedTargets 仍生效；线上 default 账号未掉线
- 配置负例：空白名单、非法 target、未知子键均被配置校验拒绝
- 已知限制：当前 app 未开通文档 OpenAPI 权限（/v1.0/doc/* 返回 404），故 docs 的 ok:true 成功路径未覆盖；
  拒绝原因不通过 CLI 透出，判定依赖 [DingTalk][GatewayRPC][Denied] 日志
- 收尾：已删除临时 gatewayCapabilities/accounts 配置、plugins.load.paths 还原为主仓库并重启确认
```

## 9. 附：本轮已完成的零风险预验证（未改配置、未发消息）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| PR 分支与范围 | `git diff --name-status origin/main...HEAD` | 13 文件（gate 相关）；`#610` 已在 `origin/main` |
| 构建 | `pnpm run build:runtime` | 成功，`dist/index.js` 661.8kb，产物含 `withDocsGatewayCapability` / `denyGatewayCapability` 源 |
| P0 对照 | `openclaw config patch --stdin --dry-run` | 当前 main 插件拒绝 `gatewayCapabilities`（`must not have additional properties`） |
| 基线 | `openclaw gateway call dingtalk.docs.list '{"spaceId":"bogus-space-probe"}'` | `AxiosError … 404`，日志 `errorMessage=AxiosError…`（供 B1 比对） |
| deny 形态 | `dingtalk-connector.send`（非法 target）/`sendToUser`（缺 content） | CLI 仅 `"gateway request failed"`；日志 `⇄ res ✗ …` 无 errorCode/errorMessage |
| 多账号策略 | 用 PR 产物跑 `dingtalkPlugin.config.listAccountIds/resolveAccount` | `accounts.default={}` 保住线上 default 账号；账号级子键合并符合预期 |
| 拒绝文案 | 用 PR 产物 + 假 api 调用各 handler | 第 4 节 C/D/E/F 的 reason 已逐字确认 |
| schema 负例 | 用 PR 的 `openclaw.plugin.json` schema + ajv 校验第 4 节 J 组 payload | J1 `fewer than 1 items`、J2 同、J3 `must match pattern "^(user\|group):\S+$"`、J4 `must NOT have additional properties`、J5 账号级同样被拒；G 组测试配置（含 `accounts.default={}`）校验通过 |
| 单测回归 | `pnpm vitest run tests/unit/{gateway-capability-gate,gateway-rpc-capability-entry,config-schema,plugin-manifest}.test.ts` | 4 文件 70 tests 全绿 |
| 恢复补丁 | `openclaw config patch --stdin --dry-run` 带 `gatewayCapabilities: null, accounts: null` | `ok:true`（null 可删除路径），第 7 节回滚命令可用 |
| 日志通道 | `openclaw logs`、`/tmp/openclaw/openclaw-$(date +%F).log` | 插件日志以 WARN 落盘可被 grep（**实测 subsystem 是 `plugins`，不是 `channels/dingtalk`**，见 10.3） |

## 10. 执行记录（2026-09-13 真机执行）

执行对象：worktree `ea92ecf`（含 `gatewayRpc` → `gatewayCapabilities` 重命名提交），`pnpm run build:runtime` 产物 662.1kb；插件路径切到 worktree 后 `plugins list` 的 `rootDir` 指向 worktree。

### 10.1 结果总览

| 组 | 用例 | 结果 |
| --- | --- | --- |
| A | A1 / A2 | ✅ A1 切换前被 manifest 拒绝；A2 切换后通过（自证加载的是 PR 构建） |
| J | J1–J5 + 合法对照 | ✅ 5 条负例全部按预期被宿主校验拒绝（错误信息逐字匹配）；合法配置通过 |
| B | B1–B3 | ✅ B1 与切换前逐字一致；B2 status 正常；B3 真实私聊送达 |
| C | C1–C6 | ✅ docs 全关：8 个方法（含 `dingtalk-connector.*` 别名）全部 deny，reason 逐字匹配 |
| D | D1–D6 | ✅ 命中放行 / 未命中拒绝 / `append` 与无 `spaceId` 的 `search` 专用原因 |
| E | E1–E4 | ✅ 三个发送 RPC deny；缺参仍为结构化 deny（fast-path 修复生效） |
| F | F1–F4 | ✅ 命中白名单真实群发成功；未命中拒绝（`user:*` 同样受约束） |
| G | G0–G4 | ✅ `default` 未掉线；账号级覆盖 `tools.docs` 生效；渠道级 `send.allowedTargets` 仍生效 |
| H | 私聊 / 群聊@ / 引用 | ✅ 三项均正常回复，观测窗口内**新增 Denied = 0** |
| I | I1–I2 | ✅ `status` / `probe` 不受开关影响 |

### 10.2 关键证据（节选）

```text
A1  ok=false  must not have additional properties: "gatewayCapabilities"
A2  ok=true   checks.schema=true
J1  channels.dingtalk.gatewayCapabilities.docs.allowedSpaceIds: must not have fewer than 1 items
J3  ...send.allowedTargets.0: must match pattern "^(user|group):\S+$"
J4  channels.dingtalk.gatewayCapabilities: must not have additional properties: "tool"
B1  ok=false  AxiosError: Request failed with status code 404: code=ERR_BAD_REQUEST
    日志 ⇄ res ✗ dingtalk.docs.list 125ms errorCode=UNAVAILABLE errorMessage=AxiosError…（无 Denied）
C1  warn plugins [DingTalk][GatewayRPC][Denied] dingtalk.docs.create: dingtalk docs Gateway RPC is disabled by config (gatewayCapabilities.tools.docs = false)
D1  （无 Denied）+ ⇄ res ✗ … errorMessage=AxiosError…404      ← gate 放行
D2  [Denied] …: spaceId is not in gatewayCapabilities.docs.allowedSpaceIds allowlist
D3  [Denied] …: docs RPC denied: this request carries no spaceId while gatewayCapabilities.docs.allowedSpaceIds is configured (dingtalk.docs.append never carries a spaceId)
E4  [Denied] dingtalk-connector.sendToUser: dingtalk proactive-send Gateway RPC is disabled by config (gatewayCapabilities.tools.proactiveSend = false)   ← 缺参仍是结构化 deny
F1  ok=true  target=group:cid//Vc7N7lA5mymGresI0XAw==  tracking.processQueryKey 非空；⇄ res ✓；无 Denied
F2  [Denied] …: target is not in gatewayCapabilities.send.allowedTargets allowlist
G1  （无 Denied）+ ⇄ res ✗ … errorMessage=AxiosError…400      ← 账号级 tools.docs=true 覆盖渠道级 false
G2  [Denied] dingtalk.docs.list: dingtalk docs Gateway RPC is disabled by config (gatewayCapabilities.tools.docs = false)
G3  [Denied] dingtalk-connector.send: target is not in gatewayCapabilities.send.allowedTargets allowlist   ← 渠道级白名单未被账号级局部配置吞掉
G4  [Denied] dingtalk.docs.list: dingtalk docs Gateway RPC is disabled by config (gatewayCapabilities.tools.docs = false)
H   [DingTalk][QuotedRef][Persist] direction=outbound scope=cid//Vc7N7lA5mymGresI0XAw== messageType=card
    [DingTalk][AICard] Card finalized: … state=FINISHED；Native ack reaction recall succeeded
    12:16:27 之后新增 [Denied] 行数 = 0
```

用户侧确认：B3 私聊探针、F1 群聊探针**均收到**；H 组私聊 / 群聊@ / 引用三项回复**均正常**。

### 10.3 与方案的偏差（4 条，认知需修正）

1. **日志 subsystem 是 `plugins`，不是 `channels/dingtalk`**。`index.ts` 用 `api.logger`（插件级），只有通道运行时日志才在 `channels/dingtalk`。观测时必须按 `[DingTalk][GatewayRPC][Denied]` 文本 grep，**不要按 subsystem 过滤**。
2. **B3/F1 的 `messageId` 为 `null`**：两条都走 AI 卡片路径，送达凭据是 `tracking.processQueryKey` + `⇄ res ✓`。方案里"`messageId` 非空"的判据应改为 `tracking.processQueryKey` 非空。
3. **G1 首跑被拒，根因是测试配置遗漏而非产品缺陷**：`openclaw config patch` 是**递归合并**，Phase 4 的补丁没清掉 Phase 3 配的 `docs.allowedSpaceIds`，于是渠道级白名单把账号级覆盖后的请求拦下了。这反倒正面印证了"渠道级限制不会被账号级局部配置静默移除"，但不是 G1 要隔离的断言；用 `null` 清掉遗留项后重跑通过（失败原因变成 `AxiosError…400`，因为走的是 gateprobe 的 dummy 凭证，这也顺带证明确实用了该账号的凭证）。
4. **`--replace-path plugins.load.paths` 会整体替换数组**：首次应用顺带移除了 `goofish-cli` 插件路径（stderr 出现 `plugin not found: goofish` 警告），已立即修正为两元素并在收尾还原。同类操作要显式带上无关路径。

### 10.4 环境限制（未覆盖项）

- **docs 成功路径仍不可达**：`/v1.0/doc/*` 对 `default` 账号返回 **404**、对 gateprobe（dummy 凭证）返回 **400**。因此 D1 / D5 / G1 只证明"gate 放行"，不能证明文档操作成功。要闭环需给 app 开通文档 OpenAPI 权限并提供真实 `spaceId`。
- **拒绝原因不通过 CLI 透出**：`respond(false, { error })` 未带 `ErrorShape`，CLI 恒为 `"gateway request failed"`，RPC 日志行也没有 `errorCode` / `errorMessage`（这恰好成为与被放行后 API 报错的判别特征）。判定依赖 Denied 行；建议后续给 deny 补 `ErrorShape`。

### 10.5 收尾状态

- `channels.dingtalk.gatewayCapabilities` 与 `accounts` 已删除；`plugins.load.paths` 还原为 `["/Users/sym/Repo/openclaw-channel-dingtalk", "/Users/sym/Repo/goofish-cli"]`
- 重启后：`plugins list` 的 `rootDir` 回到主仓库、`default` 账号 `connected=true`、`dingtalk.docs.list {"spaceId":"bogus-space-probe"}` 行为回到切换前基线（`AxiosError…404` 且无 Denied 行）
