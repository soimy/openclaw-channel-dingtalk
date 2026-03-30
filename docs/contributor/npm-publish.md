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

ClawHub 自动执行内容：
- 安装依赖
- 校验 tag 与 `package.json` 的 `version` 同步
- 当 tag 版本为标准 semver 预发布格式（如 `v2.8.0-beta.0`）时，自动使用 `beta` tag 发布到 ClawHub
- 运行 `type-check`、`lint`、`test`
- 通过后自动执行 `clawhub package publish`

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
- 上游官方 reusable workflow 主干已经切到依赖 `--dry-run` / `--json` 的新 CLI 参数
- 截至 `clawhub@0.9.0`，npm 已发布 CLI 还未包含这些参数
- 为避免在本仓库 CI 中直接调用官方 workflow 时因版本错位失败，当前实现改为使用兼容 `clawhub@0.9.0` 的独立本地 workflow
- 待上游发布版本对齐后，可再切换为直接 `uses: openclaw/clawhub/.github/workflows/package-publish.yml@main`

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
# 通过源码链接安装（当前推荐验证路径）
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
openclaw plugins install -l .

# 或通过 npm 直接安装（仅测试）
npm install @soimy/dingtalk
```

> [!IMPORTANT]
> 当前上游 ClawHub 安装链路对 `@soimy/dingtalk` 仍有已知 bug，发布后不要把
> `openclaw plugins install @soimy/dingtalk` 作为唯一验收路径。
> 请至少验证一次 `git clone + openclaw plugins install -l .` 的安装链路。

## 发布检查清单

在执行发布前，确认以下事项：

- [ ] 代码已合并到 main 分支
- [ ] 所有测试通过
- [ ] `npm run type-check` 无错误
- [ ] `npm run lint` 无错误
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

用户可通过以下方式安装：

```bash
openclaw plugins install @soimy/dingtalk@beta
```

> [!IMPORTANT]
> 在上游 ClawHub 修复前，beta 版本也不应默认引导用户使用上述命令。
> 如需验证 beta，请优先使用源码链接安装或直接 `npm install @soimy/dingtalk@beta` 做包内容检查。

## 参考资源

- [npm 发布文档](https://docs.npmjs.com/cli/v8/commands/npm-publish)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [OpenClaw 插件开发指南](https://github.com/soimy/openclaw/docs/plugin-development)
