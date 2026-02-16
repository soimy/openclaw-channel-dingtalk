# NPM 发布流程

本文档说明如何将 DingTalk 频道插件发布到 npm 供 OpenClaw 用户安装使用。

## 前置要求

1. **npm 账号**
   - 需要有 npm 账号（https://www.npmjs.com/）
   - 需要有 `@openclaw` organization 的发布权限

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

### 3. 执行发布前检查

发布前会自动运行类型检查和 lint：

```bash
npm run prepublishOnly
```

如果检查失败，修复所有问题后重试。

### 4. 发布到 npm

```bash
npm run publish
```

或直接使用：

```bash
npm publish --access public
```

**注意**：由于这是 scoped package (`@openclaw/dingtalk`)，必须使用 `--access public` 标志。

### 5. 验证发布

发布成功后，验证包已可用：

```bash
# 查看包信息
npm info @openclaw/dingtalk

# 查看最新版本
npm view @openclaw/dingtalk version

# 查看包内容
npm view @openclaw/dingtalk
```

### 6. 测试安装

在测试环境验证安装流程：

```bash
# 通过 OpenClaw CLI 安装
openclaw plugins install @openclaw/dingtalk

# 或通过 npm 直接安装（仅测试）
npm install @openclaw/dingtalk
```

## 发布检查清单

在执行发布前，确认以下事项：

- [ ] 代码已合并到 main 分支
- [ ] 所有测试通过
- [ ] `npm run type-check` 无错误
- [ ] `npm run lint` 无错误
- [ ] README.md 文档已更新
- [ ] RELEASES.md 已记录新版本变更
- [ ] 版本号已更新（`npm version`）
- [ ] `.npmignore` 配置正确
- [ ] 已登录 npm (`npm whoami`)
- [ ] 有 `@openclaw` organization 发布权限

## 文件包含规则

通过 `.npmignore` 控制哪些文件会被发布：

**包含的文件：**
- `index.ts` - 插件入口
- `src/` - 源代码目录
- `utils.ts` - 工具函数
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

## 常见问题

### Q: 发布失败，提示权限错误

**A:** 确保：
1. 已登录正确的 npm 账号：`npm whoami`
2. 该账号有 `@openclaw` organization 的发布权限
3. 使用了 `--access public` 标志

### Q: 如何撤销已发布的版本？

**A:** 在发布后 72 小时内可以撤销：

```bash
npm unpublish @openclaw/dingtalk@版本号
```

**警告**：不建议撤销已被用户使用的版本，应发布修复版本。

### Q: 如何发布 beta 版本？

**A:** 使用预发布版本号：

```bash
# 创建 beta 版本
npm version prerelease --preid=beta

# 发布为 beta tag
npm publish --access public --tag beta
```

用户可通过以下方式安装：

```bash
openclaw plugins install @openclaw/dingtalk@beta
```

## 参考资源

- [npm 发布文档](https://docs.npmjs.com/cli/v8/commands/npm-publish)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
- [OpenClaw 插件开发指南](https://github.com/soimy/openclaw/docs/plugin-development)
