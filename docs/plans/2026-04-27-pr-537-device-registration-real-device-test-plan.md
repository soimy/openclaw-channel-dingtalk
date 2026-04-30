# PR #537 DingTalk Device Registration 真机测试计划

## 背景

PR: <https://github.com/soimy/openclaw-channel-dingtalk/pull/537>

分支: `feat/device-registration`

PR 目标是在 setup wizard 中新增钉钉 Device Flow 自动注册路径，让用户通过浏览器/钉钉扫码获取 `clientId` 和 `clientSecret`。自动注册失败时应优雅回退到原有手动输入流程。

本计划只覆盖 PR #537 实际影响的用户可见路径：`openclaw onboard` 的钉钉账号凭证获取、配置落盘，以及凭证可被后续网关连接使用。不扩展到引用恢复、媒体、AI Card、会话锁等未改动消息链路。

## 变更范围摘要

- 新增 `src/device-registration.ts`
  - 调用 `POST /app/registration/init` 获取 nonce
  - 调用 `POST /app/registration/begin` 获取 `device_code` 和授权 URL
  - 调用 `POST /app/registration/poll` 轮询 `WAITING` / `SUCCESS` / `FAIL` / `EXPIRED`
  - 打开浏览器时仅允许 `https://*.dingtalk.com` URL
- 修改 `src/onboarding.ts`
  - 在钉钉账号配置入口增加“自动注册 / 手动输入”选择
  - 未配置凭证时默认自动注册，已有凭证时默认手动输入
  - 自动注册异常时提示错误并回退到手动输入
  - 成功后继续原有 card、权限、媒体、displayName 等配置问题

## 测试前准备

1. 确认本地分支为 `feat/device-registration`，且插件目录指向当前仓库或当前 worktree。
2. 备份 `~/.openclaw/openclaw.json`，记录当前 `channels.dingtalk` 配置，尤其是已有 `clientId` / `clientSecret` / `accounts`。
3. 准备一个可扫码授权的钉钉账号和企业环境。
4. 若本机已有可用钉钉插件配置，不直接破坏日常配置。先备份，再按“现成配置机器上的隔离测试线路”临时移除或隔离现有凭证，避免 wizard 默认走已有配置。
5. 执行本地基础检查作为真机前置门禁：
   - `pnpm vitest run`
   - `pnpm run type-check`
   - `pnpm run format`
6. 完成 onboarding 后执行 `openclaw gateway restart`。
7. 立即执行 `openclaw channels status --probe --json`。如果首次 probe 正好撞上重启并出现 `1006 abnormal closure`，等待数秒后重试一次。
8. 只有当 `channels.dingtalk.running=true` 且 `channelAccounts.dingtalk[0].connected=true` 时，才开始消息侧 smoke check。

## 现成配置机器上的隔离测试线路

目标: 在本机已经存在可用 DingTalk 配置时，安全触发“未配置凭证 -> 默认自动注册”的 onboarding 分支。

推荐做法:

1. 备份当前配置：
   - `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.before-pr537-device-registration`
2. 记录当前插件目录指向和 `channels.dingtalk` 配置，尤其是：
   - `channels.dingtalk.clientId`
   - `channels.dingtalk.clientSecret`
   - `channels.dingtalk.accounts`
3. 在测试副本中临时隔离已有凭证，二选一即可：
   - 如果只测试默认账号，临时移除默认账号的 `clientId` / `clientSecret`。
   - 如果已有多账号配置，临时新增一个不含凭证的测试账号，或临时改用一个空账号 ID 跑 onboarding，避免覆盖日常账号。
4. 运行 `openclaw onboard`，确认 DingTalk 凭证获取方式默认落在“自动注册 OpenClaw 钉钉机器人”。
5. 完成自动注册后，确认新凭证只写入本次测试目标账号，不应覆盖其他日常账号配置。
6. 完成 gateway restart、probe 和 smoke check 后，恢复备份配置：
   - `cp ~/.openclaw/openclaw.json.before-pr537-device-registration ~/.openclaw/openclaw.json`
7. 恢复后再次执行 `openclaw gateway restart`，确认日常环境回到测试前状态。

注意:

- 不建议在没有备份的情况下直接清空整个 `channels.dingtalk`。
- 如果使用默认账号测试，恢复时必须确认原有 `clientId` / `clientSecret` 已回到测试前值。
- 如果使用临时账号测试，测试结束后应移除该临时账号或明确保留原因。

## 场景 1: 全新用户自动注册成功

目标: 验证默认自动注册路径能完成扫码授权、拿到凭证并写入配置。

步骤:

1. 按“现成配置机器上的隔离测试线路”准备临时配置，确保目标钉钉账号没有有效 `clientId` / `clientSecret`，同时保留可恢复备份。
2. 运行 `openclaw onboard`。
3. 进入钉钉配置时确认默认选项是“自动注册 OpenClaw 钉钉机器人”。
4. 选择自动注册。
5. 确认浏览器自动打开钉钉授权页面；如果未打开，使用终端提示中的 URL 手动打开。
6. 用钉钉真机扫码并完成授权。
7. 等待 wizard 显示注册成功提示。
8. 继续完成剩余配置问题，使用最小风险配置即可：markdown、DM open、group disabled 或按测试需要 open、displayName disabled。
9. 检查 `~/.openclaw/openclaw.json` 中写入了非空 `clientId` 和 `clientSecret`，且没有把 secret 明文打印在成功提示中。
10. 执行 `openclaw gateway restart` 和 `openclaw channels status --probe --json`。

预期结果:

- wizard 展示授权说明和 URL。
- 扫码成功后不再要求手动输入 Client ID / Secret。
- 配置文件中存在可用凭证。
- 成功提示只显示 Client ID，Client Secret 使用占位提示。
- 重启后 dingtalk channel running，首个账号 connected。

观察点:

- `~/.openclaw/openclaw.json`
- `openclaw channels status --probe --json`
- `~/.openclaw/logs/gateway.log`

## 场景 2: 已有凭证用户默认走手动输入

目标: 验证已有配置不会被自动注册流程意外打扰。

步骤:

1. 恢复或准备一个已有 `clientId` / `clientSecret` 的钉钉配置。
2. 运行 `openclaw onboard`。
3. 进入钉钉配置时观察凭证获取方式的默认选项。
4. 选择“输入已有钉钉机器人的 Client ID / Client Secret”。
5. 保持默认值或输入测试凭证，继续完成 wizard。

预期结果:

- 默认选项是手动输入。
- 不自动打开浏览器。
- 不调用扫码授权流程。
- 原有手动帮助文案、Client ID 输入、Client Secret 输入路径仍可完成配置。

观察点:

- 终端交互顺序
- `~/.openclaw/openclaw.json` 中凭证是否符合输入值

## 场景 3: 自动注册失败后回退手动输入

目标: 验证 Device Flow 不可用或用户无法完成授权时，wizard 不会中断，并能继续配置。

建议触发方式任选一种:

- 断网后选择自动注册，覆盖 init/begin 网络失败。
- 打开授权页后不扫码，等待过期或取消当前 wizard。
- 使用受限网络环境让 poll 长时间失败。

步骤:

1. 准备临时配置，移除有效钉钉凭证。
2. 运行 `openclaw onboard` 并选择自动注册。
3. 制造上述任一种失败条件。
4. 等待 wizard 显示自动注册失败原因。
5. 确认 wizard 自动进入手动输入帮助和 Client ID / Client Secret 输入。
6. 输入一组有效手动凭证并继续完成配置。
7. 重启 gateway 并 probe。

预期结果:

- wizard 显示“自动注册失败”以及具体错误原因。
- 失败后不会退出整个 onboarding。
- 手动输入路径仍能完成配置。
- 使用手动凭证重启后 dingtalk channel 可连接。

观察点:

- 失败提示是否清晰
- 是否进入 `noteDingTalkHelp` 对应的手动配置指引
- `openclaw channels status --probe --json`

## 场景 4: 授权等待期间的用户提示

目标: 验证用户扫码前等待体验不会像卡死。

步骤:

1. 运行 `openclaw onboard` 并选择自动注册。
2. 打开授权页后先不要扫码。
3. 至少等待 20 秒。
4. 再扫码完成授权。

预期结果:

- 等待期间约每 15 秒出现“仍在等待授权”的提示。
- 扫码后 wizard 能继续完成，不会因为等待提示的异步 note 造成异常。

观察点:

- 终端提示节奏
- wizard 是否保持可继续状态

## 场景 5: 配置后最小消息链路 smoke check

目标: 证明自动注册得到的凭证不仅写入配置，而且能用于实际钉钉连接。

前提:

- 场景 1 已完成。
- `openclaw channels status --probe --json` 显示 dingtalk running/connected。

步骤:

1. 在钉钉真机中向新注册机器人发送一条简单私聊消息，例如“回复 OK”。
2. 如果本次配置启用了群聊，则在测试群中 @机器人发送同样的简单消息。

预期结果:

- 机器人能收到消息并产生正常回复。
- 若群聊策略被设置为 disabled，则群聊不响应是预期结果，应按配置记录。

观察点:

- 钉钉客户端实际显示
- `~/.openclaw/logs/gateway.log`

## 不纳入本 PR 真机范围

- AI Card 流式渲染细节
- markdown 渲染兼容性矩阵
- 引用恢复
- 媒体上传/下载
- displayNameResolution 目标解析
- session alias 和 learned target directory

这些路径没有被 PR #537 修改；若 smoke check 中碰巧暴露异常，可作为独立问题记录，不阻塞本 PR 的 Device Flow 验收结论，除非能证明异常由新凭证配置路径引入。

## PR 验证 TODO 建议文案

```text
验证 TODO
- [x] 已切换插件目录到 feat/device-registration 对应仓库/worktree，备份并按需临时调整 ~/.openclaw/openclaw.json
- [x] 已运行 pnpm vitest run / pnpm run type-check / pnpm run format
- [ ] 已真机验证：本机已有 DingTalk 配置时，通过备份配置并临时移除/隔离目标账号凭证，成功触发未配置账号的自动注册默认分支
- [ ] 已真机验证：全新配置下 openclaw onboard 选择自动注册，浏览器打开钉钉授权页，手机扫码后成功写入 clientId/clientSecret
- [ ] 已真机验证：已有凭证配置下 wizard 默认选择手动输入，未误触发自动注册
- [ ] 已真机验证：自动注册失败后回退手动输入，wizard 不退出，手动凭证可继续完成配置
- [ ] 已真机验证：注册后 openclaw gateway restart，openclaw channels status --probe --json 显示 dingtalk running/connected
- [ ] 已真机验证：自动注册凭证下至少完成一次钉钉私聊 smoke check
- [ ] 收尾：已复原插件目录指向与临时 openclaw.json 设置，并按需重启 gateway
```

## 收尾

1. 恢复 `~/.openclaw/openclaw.json` 中本次测试临时改动。
2. 如果插件目录曾指向临时 worktree，恢复到测试前路径。
3. 执行 `openclaw gateway restart`，确保日常环境使用恢复后的配置。
4. 将实际执行结果回填到 PR #537 的 `验证 TODO`，明确哪些场景已跑、结果是否符合预期、哪些场景未覆盖。

## 执行记录: 2026-04-28

执行环境:

- 分支: `feat/device-registration`
- 插件加载路径: `/Users/sym/Repo/openclaw-channel-dingtalk`
- OpenClaw: `2026.4.21`
- 配置备份:
  - `~/.openclaw/openclaw.json.before-pr537-device-registration`
  - `~/.openclaw/openclaw.json.before-pr537-device-registration.20260428-203546`

本地前置验证:

- `pnpm vitest run`: 通过，`100` 个测试文件、`1062` 个测试通过。
- `pnpm run type-check`: 未通过，原因是本机链接的 `/Users/sym/Repo/openclaw/dist/plugin-sdk/*` 缺少声明文件，触发 `TS7016` 及后续隐式 any/never 派生错误；该失败看起来属于本机 OpenClaw SDK 类型产物问题，不是本 PR 设备注册路径的运行时失败。
- `pnpm run format:check`: 未通过，报告既有源码格式差异；未执行写入式 `pnpm run format`，避免在真机验证中混入格式化改动。

已验证场景:

- 已有凭证配置下，进入 DingTalk 配置时默认选中“输入已有钉钉机器人的 Client ID / Client Secret”，未误触发自动注册。
- 备份配置后临时移除默认账号 `channels.dingtalk.clientId` / `channels.dingtalk.clientSecret`，再次进入 DingTalk 配置时默认选中“自动注册 OpenClaw 钉钉机器人”。
- 自动注册流程可生成钉钉开放平台授权 URL；若浏览器没有自动弹出，可复制终端 URL 手动打开继续流程。
- 用户在钉钉开放平台页面登录并填写机器人名称等信息后，可完成自动注册；CLI onboarding 最终写入新的 `clientId` / `clientSecret`。
- 授权等待期间，CLI 周期性展示“仍在等待授权，请在钉钉中完成扫码...”提示。
- 配置落盘后，红acted 检查确认 `channels.dingtalk.clientId` / `channels.dingtalk.clientSecret` 均为非空。
- 执行 `openclaw gateway restart` 后，`openclaw channels status --probe --json` 显示:
  - `channels.dingtalk.configured=true`
  - `channels.dingtalk.running=true`
  - `channelAccounts.dingtalk[0].configured=true`
  - `channelAccounts.dingtalk[0].running=true`
  - `channelAccounts.dingtalk[0].connected=true`
  - `channelAccounts.dingtalk[0].probe.ok=true`

未完成或待人工确认:

- 未记录一次钉钉客户端私聊 smoke check 的用户侧截图/现象。当前已验证到 Stream 连接层 connected/probe OK；若要补齐消息侧闭环，需在钉钉真机中向新注册机器人发送一条简单私聊消息并确认回复。
- 未验证自动注册失败后回退手动输入路径；该路径已有单元测试覆盖，本次真机主线以成功注册为主。

建议回填 PR `验证 TODO`:

```text
- [x] 已切换插件目录到 feat/device-registration 对应仓库/worktree，备份并按需临时调整 ~/.openclaw/openclaw.json
- [x] 已运行 pnpm vitest run；type-check 当前受本机 openclaw/plugin-sdk 声明文件缺失影响失败；format:check 报既有格式差异，未执行写入式 format
- [x] 已真机验证：本机已有 DingTalk 配置时，通过备份配置并临时移除/隔离目标账号凭证，成功触发未配置账号的自动注册默认分支
- [x] 已真机验证：openclaw configure --section channels 选择 DingTalk 自动注册，手动打开授权 URL 后在钉钉开放平台完成机器人创建，CLI 成功写入 clientId/clientSecret
- [x] 已真机验证：已有凭证配置下 wizard 默认选择手动输入，未误触发自动注册
- [x] 已真机验证：注册后 openclaw gateway restart，openclaw channels status --probe --json 显示 dingtalk running/connected 且 probe.ok=true
- [ ] 已真机验证：自动注册凭证下至少完成一次钉钉私聊 smoke check
- [ ] 已真机验证：自动注册失败后回退手动输入
```
