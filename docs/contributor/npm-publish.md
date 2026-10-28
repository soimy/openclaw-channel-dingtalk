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

ClawHub 自动执行内容（`.github/workflows/clawhub-publish.yml`，两个 job）：
- `verify` job：校验 tag 与 `package.json` 的 `version` 同步；从远端重新解析 tag 并用 `^{commit}` 剥离，确认工作树就是该 tag 指向的提交；跑 `type-check` / `lint` / `test` / `build` / `pack:check`；最后 `npm pack` 出发布 tarball 并作为 Actions artifact 上传
- `publish` job：下载该 tarball → checkout ClawHub 仓库到**固定的 commit SHA** → `bun install --frozen-lockfile` → 用仓库内的 CLI 源码发布，并断言终态 `publicationStatus === "published"`

> [!IMPORTANT]
> **发布步骤不再安装 npm 上的 `clawhub`，而是用 ClawHub 仓库内的 CLI 源码（当前 0.24.0）。**
> 原因是 npm 上的 CLI 仍停在 `clawhub@0.23.3`（2026-08-04），而仓库里的 0.24.0 才支持服务端已经切换到的 staged-upload / publication-settling 协议。
> 这条链路会用本仓库的 `CLAWHUB_TOKEN` 执行上游代码，所以 checkout 的 `ref:` 固定在一个**已审阅的上游 commit SHA** 上，而不是 `@main`；上游改变发布协议时再显式升级这个 SHA。`clawhub-audit.yml` 使用同一个 SHA，测试会断言两边一致。

> [!WARNING]
> **当前 ClawHub 侧发布会因服务端 OOM 失败（2026-10-19 仍在复现）。** `publish` job 会报
> `Node.js action execution ran out of memory (maximum memory usage: 512 MB)`，这是 ClawHub 的 Convex action 挂掉，
> 客户端只能等到请求超时（0.23.3 是 120s，0.24.0 是 300s），期间 `/versions/{v}/publication` 一直是 `absent`。
> 与本地 tarball 无关：`3.9.0` 与 `3.8.1` 的包体几乎一样（2.05 MB / 199 文件 vs 2.02 MB / 188 文件）。
> 等上游修复后再 `gh workflow run clawhub-publish.yml -f tag=<tag>` 补发。

为什么不是直接 `uses: openclaw/clawhub/.github/workflows/package-publish.yml`（官方可复用工作流）：
该工作流的 "Run plugin validation" 步骤用 `bun` 调用 CLI，而 CLI 在 Bun 下**拒绝**执行 `package validate`（`process.versions.bun` → "requires Node.js 22.13+"），
因此它对任何调用方都会在真正发布前失败（本地实跑 `run 39048527709` 复现）。`publish` job 复刻其参数但去掉这一步；打包面由 `verify` 里的 `pack:check` 覆盖。

发布参数：
- `--wait --wait-timeout 2400`：让退出码成为发布判定（`blocked` / `failed` / `expired` / 超时均为非 0）；job 的 `timeout-minutes`（50）必须大于 2400s
- 断言 `publicationStatus === "published"`：等待是对外契约，但终态仍要显式检查，避免将来 CLI 丢掉 `--wait` 语义时静默变成"投递即成功"
- `--source-repo` / `--source-commit` / `--source-ref`：沿用校验过的 release commit 与 tag，保持来源可追溯


> [!IMPORTANT]
> **ClawHub 发布不再由安全审计门禁。** 安全审计已拆分为**手动触发**的独立 workflow
> `.github/workflows/clawhub-audit.yml`，它只产出结论，不阻断 `clawhub-publish.yml`。
> 需要审计结论时请在发版前手动跑一次，详见下方「ClawHub 安全审计（手动触发）」章节。

说明：
- 两条 workflow 都由同一个 tag push 触发
- 两条 workflow 相互独立，不存在 job 级依赖
- 任一发布渠道失败，不会阻止另一条 workflow 被 GitHub 触发
- 两条 workflow 都支持 `workflow_dispatch` 手动触发；`clawhub-publish.yml` 要求显式输入一个已有 tag

需要在 npm 与 GitHub 完成 Trusted publisher 绑定：
1. 在 npm 包设置中配置 GitHub Actions Trusted publisher
2. 确保工作流具备 `id-token: write` 权限（已在本仓库 workflow 配置）

说明：Trusted publisher 模式下，发布步骤不再需要 `NPM_TOKEN` Secret。

`npm-publish.yml` 在 `npm publish` 之前**主动清除遗留的 token 认证上下文**，强制走 OIDC：

```bash
# Force trusted publishing path: remove any legacy token auth context.
if [[ -n "${NPM_CONFIG_USERCONFIG:-}" && -f "${NPM_CONFIG_USERCONFIG}" ]]; then
  rm -f "${NPM_CONFIG_USERCONFIG}"
fi
unset NODE_AUTH_TOKEN
unset NPM_TOKEN
```

因此仓库/组织里即使存在 `NODE_AUTH_TOKEN` 或 `NPM_TOKEN`，**也不会**让该 workflow 退回 token 认证——
这一步已经把它消除了。仍然建议不要注入这两个变量，但理由是**减少冗余凭据**，而不是"会覆盖 OIDC"。
（手动执行 `npm publish` 时该保护不存在，那时才需要留意本地认证上下文。）

ClawHub 自动发布额外要求：
1. 配置仓库 Secret：`CLAWHUB_TOKEN`
2. 该 token 需要具备目标 ClawHub publisher 的 package publish 权限
3. 当前 ClawHub 发布逻辑位于独立 workflow：`.github/workflows/clawhub-publish.yml`
4. 手动审计位于独立 workflow：`.github/workflows/clawhub-audit.yml`（同样使用 `CLAWHUB_TOKEN`）

说明：
- ClawHub **发布**不安装 npm 上的 CLI，改从 ClawHub 仓库 checkout 源码；`clawhub@0.23.3` 只保留在审计 workflow 的**离线命令**上（`package validate`、`scan download`、`package delete --version`），因为这些命令在旧版上可用，而它们恰好是"无论如何都要跑到撤回"的关键路径
- 审计需要"发布 → 判定 → 撤回"三步，官方可复用工作流只覆盖发布（且当前因 Bun 校验 bug 不可用），所以两步都由本仓库自己的 job 驱动，共用同一套 CLI 参数
- 该版本下限的由来：`--wait` / `--wait-timeout` 与"可恢复的版本撤回"语义在 `clawhub@0.23.2` 才加入；`0.23.1` 的 `package delete --version` 是**永久删除**且没有 `--wait`，不要降级
- 源码引用的 commit SHA 是**显式升级点**：两条 workflow 各写一份，测试断言两边一致；升级时重新核对 CLI 的命令行参数（`--tags` / `--wait-timeout` / `--source-*`）

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

## ClawHub 安全审计（手动触发）

ClawHub 的安全审计（ClawScan）只在服务端、对**已提交的版本**运行，没有本地等效功能。
拿到一次判定的唯一办法就是提交一个一次性版本，因此审计被拆成**手动触发**的独立入口：

- `.github/workflows/clawhub-audit.yml` —— 远端仓库上的手动审计
- `scripts/clawhub-audit-local.mjs` —— 本地工作树上的等价审计（含未提交改动）

远端审计由三个 job 组成，**发布那一步与正式发布共用同一条链路**：

1. `prepare`：checkout 被审计的 ref → 构建与 `pack:check` → 离线校验（`clawhub package validate`）→ 解析审计版本号 → 确认该版本未被占用 → 打上审计版本并 `npm pack`
2. `publish`：checkout 固定 SHA 的 ClawHub CLI 源码并用 Bun 安装依赖，以 `--tags audit` 发布上一步的 tarball（与正式发布同一套参数）
3. `verdict`：**只要 `prepare` 或 `publish` 任一失败也会运行**——取安全判定 → 跑 `scripts/clawhub-beta-gate.mjs` → 下载扫描报告 → 等发布状态落定 → 撤回审计版本 → 汇总并上传证据
   - 审计工具（`clawhub-beta-gate.mjs` / `clawhub-publication-state.mjs`）按 `github.workflow_sha` 检出，即"定义这条 workflow 的那个提交"：它对单次 run 固定，分支前进也换不掉脚本；而按被审计提交检出会让老 tag 或没有这些脚本的分支直接崩掉（run 39527450201 就是这样丢掉了撤回）
   - "等发布状态落定"由 `scripts/clawhub-publication-state.mjs` 完成，见下方说明

这样做的原因是：审计失败的根因和正式发布是同一个（发布这一跳），把发布统一到同一份 CLI 源码后，审计与发布不会再出现"一边能发、一边发不出"的漂移。撤回、判定、报告下载仍走本仓库脚本与公开接口。

> [!IMPORTANT]
> **"版本 404"不能证明"没发布过"。** `wait_for_publication` 超时只让 workflow 失败，
> **不会取消服务端的 publication attempt**：此时 `GET /versions/{version}` 仍可能 404，
> 而版本会在 run 结束之后才真正发布，一次性审计版本就逃逸了自动撤回。
> 因此撤回前必须先用 `GET /versions/{version}/publication` 判定状态
> （`absent` / `pending` / `published` / `failed`）：`absent` 才允许无操作结束，`published` 立即撤回，
> `pending` 继续等到终态，超时则**明确失败**并留下 attempt 供人工清理。

> [!IMPORTANT]
> **审计不再阻断发布。** `.github/workflows/clawhub-publish.yml` 没有 `needs: audit`，也不读取任何审计状态，
> 推 tag 就会发布。审计的退出码回答的是"这次审计干净吗"，而不是"能不能发版"。
> 需要结论时请在发版前手动跑一次，并把结论作为发版评审的依据。

### 触发方式

| 场景 | 触发 | 行为 |
| --- | --- | --- |
| 审计远端 ref | `gh workflow run clawhub-audit.yml`（可选 `-f ref=<tag/branch/SHA>`，留空则审计发起该 run 的 ref） | 产出判定；审计版本**默认自动撤回** |
| 保留审计版本 | 追加 `-f keep_audit_version=true` | 审计版本保留在 `audit` dist-tag 上，便于烟测，之后需手动撤回 |
| 只撤回某个遗留版本 | `gh workflow run clawhub-audit.yml -f withdraw_version=<version>` | 不审计、不发布，仅用 CI 里的 `CLAWHUB_TOKEN` 撤回该版本并复查 404 |
| 放行 suspicious | 追加 `-f allow_suspicious=true` | 让 `suspicious` 也能通过判定（见下方 P2 策略） |
| 本地审计 | `node scripts/clawhub-audit-local.mjs` | 同上，直接审计当前工作树；`--keep` 保留审计版本，`--allow-suspicious` 放行 |

`allow_suspicious` 与 `keep_audit_version` 都是 `workflow_dispatch` 的输入，run 记录会留下触发者与输入值，
构成"人工放行"与"保留产物"的审计线索。

发版前跑一次审计的推荐序列：

```bash
# 1. 审计准备发布的那个 ref（tag 还没推时先审计 main HEAD）
gh workflow run clawhub-audit.yml --ref main -f ref=v3.8.0

# 2. 查看结论（job summary 里有 scanStatus / reasons / ClawScan 原文）
gh run list --workflow=clawhub-audit.yml --limit 1
gh run view <run-id>

# 3. 结论干净，或已复核并显式放行后，再推 tag 触发发布
git push origin v3.8.0
```

> [!IMPORTANT]
> **`ref` 不接受短 SHA。** `actions/checkout` 会先试 `git branch --list --remote origin/<ref>` 与
> `git tag --list <ref>`，两者都失败就报
> `A branch or tag with the name '<short-sha>' could not be found` 并终止 run（该次 run 不会消耗审计版本号）。
> 要审计某个提交，请传**完整 40 位 SHA**：
>
> ```bash
> gh workflow run clawhub-audit.yml --ref main -f ref="$(git rev-parse HEAD)"
> ```
>
> 也可以传 tag 或分支名；tag 尚未创建时用分支名或完整 SHA。

### 判定策略（P2）

判定输入是公开、免鉴权、版本精确的安装信任接口：

```bash
curl -sS "https://clawhub.ai/api/v1/packages/%40soimy%2Fdingtalk/versions/<version>/security"
```

| 档位 | 条件 | 结果 |
| --- | --- | --- |
| 硬失败 | `blockedFromDownload=true`、`scanStatus=malicious`、`moderationState=quarantined/revoked`、`pending=true`、`stale=true`、`not-run`、未知 `scanStatus`、响应结构不合法 | 一律未通过（fail-closed） |
| 软失败 | `scanStatus=suspicious` | 默认未通过；只有显式 `allow_suspicious=true` 才放行，并记为 `pass-with-override` |
| 通过 | `scanStatus=clean` | 通过 |

`clawhub package publish --wait` 的非 0 退出码（`blocked` / `failed` / `expired` / 超时）是第一道拦截；
上面的接口判定是第二道，用来把"没被拦截"和"确实干净"区分开。

### 审计版本的命名与 dist-tag

- 版本号：`<package.json version>-beta.<run_number>.<run_attempt>`，只改写 runner 内的 `package.json`，**不会提交**
  - 必须改写文件而不是用 `--version`：发布时 CLI 会校验包内版本与发布版本一致，不一致直接失败。审计走的是预构建 tarball（`npm pack` 打的就是被打过版本号的那份 `package.json`），因此版本号必须烙进 tarball，而不是只作为参数传入
- dist-tag：固定 `audit`
  - **不使用 `latest`**：审计包绝不能成为用户的安装目标；而且 `clawhub package delete --version` 只能撤回**非 latest** 版本，一旦打成 `latest` 就再也撤不掉
  - **不使用 `beta`**：避免审计包抢占或清空正式的 beta 通道
  - 撤回只影响 `audit` tag，`latest` / `beta` 不受影响
- **默认自动撤回**：先等发布状态落定（`/publication` 为 `published`），再执行
  `clawhub package delete <name> --version <v> --yes`，并复查 `GET /versions/{v}` 返回 404 作为后置条件；
  撤回失败或复核不通过会让该次 run 失败
- **撤回不依赖落定探针是否成功**：探针本身报错（脚本缺失、网络抖动）时仍会尝试清理——用版本端点复查，能解析到就删；只有 `absent` / `failed` 这两个已落定状态才允许直接结束
- `pending` 且版本端点仍是 404 时**不会**当作"从未创建"：`publication-state.json` 里 `settled: false` 会让 run 明确失败并打印手动清理命令，避免审计版本在 run 结束后才发布
- 撤回语义：这是 withdraw 而不是删除——版本号**永久保留**且不能用不同内容重发，但可用 `clawhub package undelete` 恢复
- **`audit` dist-tag 本身删不掉**：`clawhub` CLI 没有 dist-tag 管理命令，撤回后该 tag 只会变成指向已撤回版本的悬空指针，不会留下任何可安装产物

### 获取审计结果

一次运行会产出：

- job summary：判定档位、`scanStatus`、`moderationState`、`reasons`、`securityAuditUrl`、ClawScan 结论原文，以及审计版本是保留还是已撤回
- artifact `clawhub-audit-<version>`：`verdict.json`、`gate-result.json`、`publication-state.json`（发布状态的采样记录）、上游发布的 `clawhub-package-publish-json` 结果、`scan-report.zip`（保留 30 天）
- ClawHub 审计页：`https://clawhub.ai/soimy/plugins/dingtalk/security-audit?version=<version>`

> 审计版本默认会被撤回，撤回后 `GET /versions/{version}` 返回 404。**长期留痕请以 artifact 里的
> `verdict.json` 与 `scan-report.zip` 为准**，不要依赖审计页在撤回后仍可访问。

需要真机烟测审计产物时，用 `keep_audit_version=true` 跑一次：

```bash
gh workflow run clawhub-audit.yml -f ref=v3.8.0 -f keep_audit_version=true

# 优先用具体版本号，避免依赖自定义 dist-tag 的解析行为
openclaw plugins install clawhub:@soimy/dingtalk@<审计版本号>

# 烟测完成后手动清理
clawhub package delete @soimy/dingtalk --version <审计版本号> --yes
```

### 本地复现判定

```bash
# 1. 拉取任意已提交版本的审计结论
curl -sS "https://clawhub.ai/api/v1/packages/%40soimy%2Fdingtalk/versions/3.7.0/security" -o verdict.json

# 2. 按 P2 策略判定（退出码 0=通过，1=未通过）
PACKAGE_NAME=@soimy/dingtalk BETA_VERSION=3.7.0 AUDIT_VERSION_RETENTION=withdrawn \
  node scripts/clawhub-beta-gate.mjs verdict.json

# 3. 需要人工放行时
ALLOW_SUSPICIOUS=1 node scripts/clawhub-beta-gate.mjs verdict.json
```

### 已知边界

- **只覆盖 ClawHub 产物**：`npm-publish.yml` 走 registry.npmjs.org，ClawHub 审计对它无效
- **审计不再阻断发布**：`clawhub-publish.yml` 不消费审计结论。"发版前必须审计"是流程约定，不是 CI 强制
- **每次审计消耗一个版本号**：撤回不退号，审计版本号必须单调递增
- **审计是概率性判定**：同一份代码重跑可能出现 `suspicious` 与 `clean` 漂移，因此 `stale` / `pending` 一律按未通过处理
- **已知驱动已逐项消除，但结论仍可能漂移**：v3.7.0 时期的基线是 `suspicious`，驱动为"默认开放 `gatewayCapabilities`（docs / proactiveSend）"与"学习回路可静默改写回复"。这两项已在 `v3.8.0` 收敛（能力面默认关闭、学习回路 kill switch + 规则 TTL + 账号级 opt-in），出站媒体边界与随包依赖告警也已在同一轮清掉；此后针对 `PR #621`、`PR #623` 终态以及 v3.8.0 发布树的审计均返回 `clean`。但因判定具备概率性，重跑仍可能得到 `suspicious`——遇到时先读 `reasons` 判断是不是已知驱动，若不是则按软失败走显式 `allow_suspicious=true` 放行并记录复核结论，**不要**因为"上一轮是 clean"就跳过判定
- **首次上线需要 canary**：先用一个低于当前 `latest` 的审计版本验证"审计包不影响 `latest` / `beta`，且可撤回可恢复"，再放开正常使用

## 前置要求

1. **npm 账号**
   - 需要有 npm 账号（https://www.npmjs.com/）
   - 需要有 `@soimy` scope 的发布权限（或你本人的账号可发布该 scope）

2. **认证：走 npm Trusted Publisher（OIDC），不需要本地登录**

   发布由 `.github/workflows/npm-publish.yml` 在 tag push 时执行，通过 **Trusted Publisher + OIDC** 向 npm 认证：

   - 工作流已配置 `id-token: write`，发布时用 OIDC 换取短期凭证
   - **不需要 `NPM_TOKEN` Secret**，**也不需要在本机 `npm login`**
   - 因此本机 `npm whoami` 返回 401 是**正常现象**，不代表没有发布能力
   - 前提是在 npm 包设置里已完成 GitHub Actions Trusted publisher 绑定（见上方「GitHub CI 自动发布」）

   > [!NOTE]
   > 仓库/组织里即使存在 `NODE_AUTH_TOKEN` / `NPM_TOKEN` 也不会影响该 workflow——
   > 它在 `npm publish` 前会 `unset` 这两个变量并删除 npm user config，强制走 OIDC。
   > 不注入它们的理由是减少冗余凭据，而不是"否则 OIDC 会失效"。

   只有需要**手动**执行 `npm publish`（绕过 CI 的应急路径）时，才需要 `npm login`；
   此时请确认登录的是有 `@soimy` scope 权限的账号。

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
> 对**目录**执行 `clawhub package publish` 时会直接扫描目录，只应用 `.clawhubignore` / `.clawdhubignore`
> 以及内置忽略项。因此仓库内开发产物的排除规则需要单独维护在 `.clawhubignore` 中。
> 本仓库的 CI 发布（`.github/workflows/clawhub-publish.yml`）发布的是 `npm pack` 产出的 tarball，
> 所以线上 ClawHub 包内容**与 npm 包完全一致**；`.clawhubignore` 只在手动对目录发布时生效。

### 3. 执行发布前检查

**先说明本仓库实际存在的钩子，避免照着不存在的脚本敲命令：**

| 命令 / 钩子 | 是否存在 | 实际行为 |
| --- | --- | --- |
| `npm run prepublishOnly` | ❌ **不存在** | 仓库没有定义该脚本 |
| `prepack`（`npm pack` / `npm publish` 前自动触发） | ✅ 存在 | `pnpm run build` = `build:runtime` + `build:types`（`tsc -p tsconfig.build.json`）。**会做 TypeScript 编译检查**，但不跑独立的 `type-check`（`tsc -p tsconfig.json`，配置不同）、也**不跑 lint** |
| `pnpm run pack:check` | ✅ 存在 | 只校验三件事：必需文件存在（`dist/index.js`、`dist/index.d.ts`、`openclaw.plugin.json`）、不含 source map、bundle 不含 `child_process` / 进程执行 / 整体 `process.env` 透传。**不比对完整文件清单** |

所以类型检查、lint、测试、格式检查都需要**显式执行**：

```bash
pnpm run format:check
pnpm run type-check
pnpm run lint
pnpm test
pnpm run build
pnpm run pack:check
npm pack --dry-run   # 核对将被发布的完整文件清单（见下方说明）
```

关于 CI 覆盖范围，**不要把两个 workflow 混为一谈**：

| 检查 | `npm-publish.yml`（tag 触发） | `ci-tests.yml`（push / PR 触发） |
| --- | --- | --- |
| `type-check` | ✅ | ✅ |
| `lint` | ✅ | ✅ |
| `test` | ✅ | ✅ |
| `test:coverage` | ❌ | ✅ |
| `format:check` | ❌ | ✅ |
| `build` / `pack:check` | ✅ | ✅ |

**`npm-publish.yml` 不跑 `format:check`，`ci-tests.yml` 也不是 tag 发布的门禁**（它由 push / PR 触发，与 tag 发布是两条独立 workflow）。因此**格式检查需要在推 tag 前自行确认**，不能假定"CI 会拦住"。

**`pack:check` 通过 ≠ 文件清单正确。** 它只断言几个必需文件存在与若干禁止项，多出一个不该发布的文件时它**依然会通过**。要核对完整清单请用：

```bash
npm pack --dry-run
```

上面这组命令用于**手动发布**或本地预检；CI 路径下已由两个 workflow 覆盖的部分见上表。如有检查失败，修复后重试。

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

### 7. 建立 GitHub Release 页面

> [!IMPORTANT]
> **推 tag 不会自动建立 Release 页面。** tag push 只触发 `.github/workflows/npm-publish.yml` 与
> `clawhub-publish.yml`；仓库里**没有**创建 GitHub Release 的 workflow。这一步必须手动做，
> 漏掉的表现是：包已经发布、tag 已存在，但 `https://github.com/<owner>/<repo>/releases` 上找不到该版本。

约定：**Release 正文就是 `docs/releases/<tag>.md` 的逐字内容**，标题与 tag 同名。

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes-file docs/releases/vX.Y.Z.md \
  --verify-tag
```

- `--verify-tag`：tag 不存在时直接失败，避免建出指向不存在 tag 的 Release
- 不要加 `--draft` / `--prerelease`（除非确实要发预发布）；最新的正式版本会被 GitHub 自动标记为 `Latest`
- 发布后用 `gh release view vX.Y.Z --json body -q .body | diff - docs/releases/vX.Y.Z.md` 核对正文一致

> [!WARNING]
> **发布说明里的链接必须是绝对链接。** 同一个文件会在两个渲染器下出现：VitePress 文档站
> （相对链接有效）与 GitHub Release 页面（相对链接无效）。
> 例如 `[latest.md](./latest.md)` 在 Release 页面上会被 GitHub 解析成
> `/releases/latest.md` 并 302 回当前 Release 页面本身——不报错，但等于一个点不动的自我链接。
> 写文档站链接时用正式域名 `https://dingtalk-channel.nanoo.app/...`，
> 写仓库文件时用 `https://github.com/soimy/openclaw-channel-dingtalk/blob/main/...`。

## 发布检查清单

在执行发布前，确认以下事项：

- [ ] 代码已合并到 main 分支
- [ ] 所有测试通过
- [ ] `pnpm run type-check` 无错误
- [ ] `pnpm run lint` 无错误
- [ ] 已手动跑过一次 ClawHub 安全审计（`gh workflow run clawhub-audit.yml -f ref="$(git rev-parse HEAD)"`），结论为 `clean`，或 `suspicious` 已显式 `allow_suspicious=true` 放行并有复核结论（审计不阻断发布，但这是流程约定）
- [ ] README.md 文档已更新（若本次新增了配置项或用户可见行为，确认 `docs/user/` 已覆盖；README 只保留入口级内容）
- [ ] `docs/releases/` 已记录新版本变更
- [ ] 发布说明中的链接均为**绝对链接**（该文件会逐字成为 GitHub Release 正文，相对链接在那里无效）
- [ ] `pnpm run format:check` 无错误（**`npm-publish.yml` 不跑它，`ci-tests.yml` 也不是 tag 门禁**）
- [ ] 版本号已更新（`npm version`）
- [ ] 已用 `npm pack --dry-run` 核对完整文件清单（`pack:check` 只查必需文件与若干禁止项，**不比对清单**，多出文件时它照样通过）
- [ ] 已在 npm 包设置中完成 GitHub Actions Trusted publisher 绑定（**无需**本地 `npm login`；本机 `npm whoami` 返回 401 属正常）
- [ ] **已建立 GitHub Release 页面**（`gh release create vX.Y.Z --title vX.Y.Z --notes-file docs/releases/vX.Y.Z.md --verify-tag`；推 tag 不会自动建，见「发布步骤 7」）

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

ClawHub 的发布范围分两条路径：

- **CI 发布（本仓库实际路径）**：发布 `npm pack` 产出的 tarball，文件集由 `package.json#files` 决定，与 npm 包一致
- **手动对目录发布**：`clawhub package publish .` 直接扫描目录，只看 `.clawhubignore`（`.npmignore` 不生效）

所以：

- `.npmignore` 只影响 `npm publish` 与 `npm pack`
- `.clawhubignore` 只在手动对目录发布时影响 `clawhub package publish`
- 若仓库新增开发产物目录，CI 路径只需 `package.json#files` 不收录它；手动目录发布才需要同时评估 `.clawhubignore`

## 常见问题

### Q: 发布失败，提示权限错误

**A:** 分两种情况：

**CI 自动发布（推荐路径）失败时**，问题几乎总在 Trusted Publisher 绑定上：
1. 确认 npm 包设置中已完成 GitHub Actions Trusted publisher 绑定（仓库、workflow 文件名都要对上）
2. 确认 workflow 具备 `id-token: write` 权限
3. 确认 tag 版本与 `package.json#version` 完全一致（workflow 第一步就会校验，失败时日志里有明确提示）
4. 注意本机 `npm whoami` 返回 401 是正常的，与 CI 能否发布无关
5. **不必去查 `NODE_AUTH_TOKEN` / `NPM_TOKEN`**：workflow 在发布前会 `unset` 它们并删除 npm user config，
   这两个变量无法影响该路径的认证

**手动 `npm publish`（应急路径）失败时**，才检查本地登录态：
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
