# NPM 发布流程

本文档说明如何将 DingTalk 频道插件发布到 npm，并同步发布到 ClawHub 插件包仓库。

## GitHub CI 自动发布（推荐）

仓库已提供两条相互独立的自动发布工作流：
- `.github/workflows/npm-publish.yml`
- `.github/workflows/clawhub-publish.yml`

触发条件：
- 推送任意新 tag 时触发

自动执行内容：
- 安装依赖
- 校验 tag 与 `package.json` 的 `version` 同步（支持 `v2.7.0` 与 `2.7.0` 两种 tag 形式）
- 当 tag 版本为标准 semver 预发布格式（如 `v2.8.0-beta.0`）时，自动发布到 npm `beta` dist-tag
- 运行 `type-check`、`lint`、`test`
- 通过后自动执行 `npm publish --access public`

ClawHub 自动执行内容（同一个 workflow 内的两个 job）：
- `audit` job（发版安全审计门禁）：
  - 安装依赖、构建运行时产物、跑本地 Plugin Inspector 预检
  - 用当前 `package.json` 版本生成一次性审计版本 `<version>-beta.<run_number>.<run_attempt>`
  - 以 `audit` dist-tag 发布审计包，并用 `clawhub package publish --wait` 等待 ClawHub 安全审计到达终态
  - 读取 `GET /api/v1/packages/{name}/versions/{version}/security`，按 P2 策略判定
  - 下载审计报告并归档证据；发版模式下自动撤回审计版本
- `publish` job（`needs: audit`）：
  - 校验 tag 与 `package.json` 的 `version` 同步
  - 当 tag 版本为标准 semver 预发布格式（如 `v2.8.0-beta.0`）时，自动使用 `beta` tag 发布到 ClawHub
  - 运行 `type-check`、`lint`、`test`
  - 通过后自动执行 `clawhub package publish`

审计 gate 未通过时，`publish` job 不会启动，发布被阻断。详见下方「ClawHub Beta 安全审计门禁」章节。

说明：
- 两条 workflow 都由同一个 tag push 触发
- 两条 workflow 相互独立，不存在 job 级依赖
- 任一发布渠道失败，不会阻止另一条 workflow 被 GitHub 触发
- ClawHub workflow 还支持 `workflow_dispatch` 手动触发，并要求显式输入一个已有 tag

需要在 npm 与 GitHub 完成 Trusted publisher 绑定：
1. 在 npm 包设置中配置 GitHub Actions Trusted publisher
2. 确保工作流具备 `id-token: write` 权限（已在本仓库 workflow 配置）

说明：Trusted publisher 模式下，发布步骤不再需要 `NPM_TOKEN` Secret。
同时不要在仓库/组织变量里注入 `NODE_AUTH_TOKEN` 或 `NPM_TOKEN`，否则 npm 会优先尝试 token 认证，可能导致 OIDC 不生效。

ClawHub 自动发布额外要求：
1. 配置仓库 Secret：`CLAWHUB_TOKEN`
2. 该 token 需要具备目标 ClawHub publisher 的 package publish 权限
3. 当前 ClawHub 发布逻辑位于独立 workflow：`.github/workflows/clawhub-publish.yml`

说明：
- 本仓库在 workflow 内固定安装 `clawhub@0.23.3`
- 该版本下限由审计门禁决定：`--wait` / `--wait-timeout` 与"可恢复的版本撤回"语义都在 `clawhub@0.23.2` 才加入；`0.23.1` 的 `package delete --version` 是**永久删除**且没有 `--wait`，不要降级
- 上游官方 reusable workflow 仍在演进，本仓库继续使用独立 workflow，以便把审计门禁固定在发布链路里

推荐发布命令：

```bash
# 先更新版本并提交
npm version patch
git push origin main --follow-tags
```

或手动打 tag：

```bash
# package.json version = 2.7.1 时
git tag v2.7.1
git push origin v2.7.1
```

## Beta 版本发布（CI）

当前 CI 支持标准 semver 预发布版本（`-beta.*`）自动发布到 npm `beta` dist-tag。

推荐流程：

```bash
# 例如从 2.7.1 生成 2.7.2-beta.0，并自动创建对应 git tag
npm version prerelease --preid=beta

# 推送代码和 tag，触发 GitHub Actions 自动发布
git push origin main --follow-tags
```

CI 行为：
- tag（去掉可选 `v` 前缀）必须与 `package.json.version` 完全一致
- 版本包含 `-beta.*` 时，自动执行 `npm publish --access public --tag beta`
- 非预发布版本自动发布到 `latest`

## ClawHub Beta 安全审计门禁

ClawHub 的安全审计（ClawScan）只在服务端、对**已提交的版本**运行，没有本地等效功能。
为了在正式发版前拿到这份判定，`.github/workflows/clawhub-publish.yml` 的 `audit` job 会先发布一个
一次性审计版本，等审计到达终态后再决定是否放行 `publish` job。

### 触发方式

| 场景 | 触发 | 行为 |
| --- | --- | --- |
| 正式发版 | 推送 tag 或 `workflow_dispatch`（`audit_only=false`） | 审计通过后继续发布正式版本；审计版本**自动撤回** |
| 手动审计 | `workflow_dispatch` + `audit_only=true`（`tag` 留空即审计当前分支 HEAD） | 只审计、**保留**审计版本，便于烟测 |
| 放行 suspicious | `workflow_dispatch` 勾选 `allow_suspicious=true` | 让 `suspicious` 也能通过门禁（见下方 P2 策略） |

> **tag push 不接受人工放行**：`allow_suspicious` 是 `workflow_dispatch` 的输入，tag push 无法提供，因此 tag 触发的发版在 `suspicious` 结论下会被**严格阻断**（这是有意为之：放行必须是一次显式、可追溯的 dispatch）。审计被阻断时 workflow 会打出提示，按提示改用：
>
> ```bash
> gh workflow run clawhub-publish.yml -f tag=v3.8.0 -f allow_suspicious=true
> ```
>
> 该 run 会记录触发者与输入值，构成放行的审计线索。

### 判定策略（P2）

判定输入是公开、免鉴权、版本精确的安装信任接口：

```bash
curl -sS "https://clawhub.ai/api/v1/packages/%40soimy%2Fdingtalk/versions/<version>/security"
```

| 档位 | 条件 | 结果 |
| --- | --- | --- |
| 硬失败 | `blockedFromDownload=true`、`scanStatus=malicious`、`moderationState=quarantined/revoked`、`pending=true`、`stale=true`、`not-run`、未知 `scanStatus`、响应结构不合法 | 一律拦截（fail-closed） |
| 软失败 | `scanStatus=suspicious` | 默认拦截；只有显式 `allow_suspicious=true` 才放行，并记为 `pass-with-override` |
| 通过 | `scanStatus=clean` | 放行 |

`clawhub package publish --wait` 的非 0 退出码（`blocked` / `failed` / `expired` / 超时）是第一道拦截；
上面的接口判定是第二道，用来把"没被拦截"和"确实干净"区分开。

### 审计版本的命名与 dist-tag

- 版本号：`<package.json version>-beta.<run_number>.<run_attempt>`，只改写 runner 内的 `package.json`，**不会提交**
  - 必须改写文件而不是用 `--version`：code-plugin 走文件夹发布会内部 `npm pack`，CLI 会校验包内版本与发布版本一致，不一致直接失败
- dist-tag：固定 `audit`
  - **不使用 `latest`**：审计包绝不能成为用户的安装目标
  - **不使用 `beta`**：避免审计包抢占或清空正式的 beta 通道
  - 撤回只影响 `audit` tag，`latest` / `beta` 不受影响
- 撤回语义：`clawhub package delete <name> --version <v>` 是 withdraw，版本号**永久保留**、不能用不同内容重发，但可用 `clawhub package undelete` 恢复

### 获取审计结果

一次运行会产出：

- job summary：判定档位、`scanStatus`、`moderationState`、`reasons`、`securityAuditUrl`、ClawScan 结论原文
- artifact `clawhub-audit-<version>`：`verdict.json`、`gate-result.json`、`publish.json`、`scan-report.zip`（保留 30 天）
- ClawHub 审计页：`https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=<version>`

手动审计会保留审计版本，可对本机做一次烟测：

```bash
# 优先用具体版本号，避免依赖自定义 dist-tag 的解析行为
openclaw plugins install clawhub:@soimy/dingtalk@<审计版本号>
```

### 本地复现判定

```bash
# 1. 拉取任意版本的审计结论
curl -sS "https://clawhub.ai/api/v1/packages/%40soimy%2Fdingtalk/versions/3.7.0/security" -o verdict.json

# 2. 按 P2 策略判定（退出码 0=放行，1=拦截）
PACKAGE_NAME=@soimy/dingtalk BETA_VERSION=3.7.0-beta.1 AUDIT_MODE=manual \
  node scripts/clawhub-beta-gate.mjs verdict.json

# 3. 需要人工放行时
ALLOW_SUSPICIOUS=1 node scripts/clawhub-beta-gate.mjs verdict.json
```

### 已知边界

- **只覆盖 ClawHub 产物**：`npm-publish.yml` 走 registry.npmjs.org，ClawHub 审计对它无效
- **每次发版消耗一个版本号**：撤回不退号，审计版本号必须单调递增
- **审计是概率性判定**：同一份代码重跑可能出现 `suspicious` 与 `clean` 漂移，因此 `stale` / `pending` 一律按失败处理
- **当前基线是 `suspicious`**：ClawScan 认为插件默认开放 `gatewayCapabilities`（docs / proactiveSend）值得复核。P2 策略下需要显式 `allow_suspicious=true` 才能发版；要消除该告警，需要调整这些默认值或强制配置 `allowedSpaceIds` / `allowedTargets`
- **首次上线需要 canary**：先用一个低于当前 `latest` 的审计版本验证"审计包不影响 `latest` / `beta`，且可撤回可恢复"，再放开正常发版

## 前置要求

1. **npm 账号**
   - 需要有 npm 账号（https://www.npmjs.com/）
   - 需要有 `@soimy` scope 的发布权限（或你本人的账号可发布该 scope）

2. **认证登录**
   ```bash
   npm login
   ```

3. **代码质量检查**
   - 确保所有代码已通过类型检查和 lint 验证
   - 确保所有测试通过（如果有）

## 发布步骤

### 1. 更新版本号

根据改动类型选择版本号更新策略：

```bash
# 补丁版本（bug 修复）：2.6.1 -> 2.6.2
npm version patch

# 次要版本（新功能，向后兼容）：2.6.1 -> 2.7.0
npm version minor

# 主要版本（破坏性更新）：2.6.1 -> 3.0.0
npm version major
```

### 2. 验证发布内容

检查将要发布的文件列表：

```bash
npm pack --dry-run
```

这会显示哪些文件会被包含在 npm 包中。确保：
- ✅ 包含必要文件：`index.ts`, `src/`, `utils.ts`, `package.json`, `README.md`, `openclaw.plugin.json`
- ❌ 排除开发文件：`node_modules/`, `docs/`, `.git/`, 配置文件等

> [!IMPORTANT]
> ClawHub plugin 发布不读取 `.npmignore`。
> `clawhub package publish` 会直接扫描目录，并只应用 `.clawhubignore` / `.clawdhubignore`
> 以及内置忽略项。因此仓库内开发产物的排除规则需要单独维护在 `.clawhubignore` 中。

### 3. 执行发布前检查

发布前会自动运行类型检查和 lint：

```bash
npm run prepublishOnly
```

如果检查失败，修复所有问题后重试。

### 4. 发布到 npm

```bash
npm publish --access public
```

**注意**：由于这是 scoped package (`@soimy/dingtalk`)，必须使用 `--access public` 标志。

### 5. 验证发布

发布成功后，验证包已可用：

```bash
# 查看包信息
npm info @soimy/dingtalk

# 查看最新版本
npm view @soimy/dingtalk version

# 查看包内容
npm view @soimy/dingtalk
```

### 6. 测试安装

在测试环境验证安装流程：

```bash
# 通过 ClawHub 安装（推荐验收路径）
openclaw plugins install @soimy/dingtalk

# 如需验证本地开发/联调链路，可额外检查源码链接安装
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
pnpm install
openclaw plugins install -l .
```

## 发布检查清单

在执行发布前，确认以下事项：

- [ ] 代码已合并到 main 分支
- [ ] 所有测试通过
- [ ] `pnpm run type-check` 无错误
- [ ] `pnpm run lint` 无错误
- [ ] ClawHub beta 审计门禁通过（`audit` job 绿色；`suspicious` 需显式 `allow_suspicious=true` 并有复核结论）
- [ ] README.md 文档已更新
- [ ] `docs/releases/` 已记录新版本变更
- [ ] 版本号已更新（`npm version`）
- [ ] `.npmignore` 配置正确
- [ ] 已登录 npm (`npm whoami`)
- [ ] 有 `@soimy` scope 发布权限

## 文件包含规则

通过 `.npmignore` 控制哪些文件会被发布：

**包含的文件：**
- `index.ts` - 插件入口
- `src/` - 源代码目录
- `package.json` - 包配置
- `README.md` - 使用文档
- `openclaw.plugin.json` - 插件元数据
- `clawbot.plugin.json` - 兼容配置

**排除的文件：**
- `node_modules/` - 依赖包
- `docs/` - 开发文档
- `.git/` - Git 仓库
- 各类配置文件（`.eslintrc.json`, `tsconfig.json` 等）
- 开发工具文件（`AGENTS.md`, `TODO.md` 等）

ClawHub 发布范围由 `.clawhubignore` 控制，目标是尽量与 npm 包保持一致，但两者不是同一套机制：

- `.npmignore` 只影响 `npm publish`
- `.clawhubignore` 只影响 `clawhub package publish`
- 若仓库新增开发产物目录，需要同时评估两份 ignore 文件是否都要更新

## 常见问题

### Q: 发布失败，提示权限错误

**A:** 确保：
1. 已登录正确的 npm 账号：`npm whoami`
2. 该账号有 `@soimy` scope 的发布权限
3. 使用了 `--access public` 标志

### Q: 如何撤销已发布的版本？

**A:** 在发布后 72 小时内可以撤销：

```bash
npm unpublish @soimy/dingtalk@版本号
```

**警告**：不建议撤销已被用户使用的版本，应发布修复版本。

### Q: 如何发布 beta 版本？

**A:** 推荐走 GitHub CI 自动发布：

```bash
# 创建 beta 版本
npm version prerelease --preid=beta

# 推送代码和 tag，CI 将自动发布到 npm beta dist-tag
git push origin main --follow-tags
```

用户可通过以下方式通过 ClawHub 安装：

```bash
openclaw plugins install @soimy/dingtalk@beta
```

## 参考资源

- [npm 发布文档](https://docs.npmjs.com/cli/v8/commands/npm-publish)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [OpenClaw 插件开发指南](https://github.com/soimy/openclaw/docs/plugin-development)
