# 贡献指南

感谢你对钉钉 Clawdbot 插件的贡献！

## 开发流程

### 1. 设置开发环境

```bash
git clone https://github.com/soimy/clawdbot-channel-dingtalk.git
cd clawdbot-channel-dingtalk
npm install
npm run check  # 验证环境
```

### 2. 创建特性分支

```bash
git checkout -b feature/your-feature-name
```

### 3. 编写代码

- 遵循现有的代码风格
- 在 `src/types.ts` 中定义新类型
- 使用 TypeScript 严格模式（没有 `any`）
- 为 public 函数添加 JSDoc 注释

### 4. 运行测试和检查

```bash
npm run type-check    # 类型检查
npm run lint          # 代码检查
npm run lint:fix      # 自动修复
npm test              # 运行单元测试
npm run check         # 运行所有检查
```

所有检查必须通过才能提交 PR。

### 5. 编写有意义的提交信息

格式: `<type>(<scope>): <subject>`

示例:
```
feat(message): add support for video messages
fix(types): correct DingTalkConfig interface
docs: update developer quickstart
test: add retry logic tests
refactor(plugin): simplify token management
```

类型:
- `feat`: 新功能
- `fix`: bug 修复
- `docs`: 文档更新
- `test`: 测试相关
- `refactor`: 代码重构
- `style`: 格式调整（不改变逻辑）

### 6. 提交 Pull Request

- 提交前 squash commits（如有多个）
- 在 PR 描述中说明变更内容
- 参考相关 issue（如有）
- 等待 CI/CD 通过和代码审核

## 代码标准

### TypeScript

- 使用严格模式（见 `tsconfig.json`）
- 所有函数需要显式的参数和返回类型
- 避免使用 `any`，使用类型定义
- 为复杂的类型定义添加 JSDoc

### 命名约定

- 常量: `UPPER_SNAKE_CASE`
- 函数/变量: `lowerCamelCase`
- 类型: `PascalCase`
- 接口: `I` 前缀（如 `ILogger`）或直接 `PascalCase`

### 注释和文档

- 仅在必要时添加内联注释
- 为 public 函数编写 JSDoc
- 复杂算法需要解释性注释
- 所有 TODO/FIXME 需要说明原因

## 项目结构

```
src/types.ts          # 类型定义（30+ interfaces）
plugin.ts             # 主插件（400 行）
utils.ts              # 工具函数（100 行）
plugin.test.ts        # 单元测试（12 个测试）
.eslintrc.json        # ESLint 配置
tsconfig.json         # TypeScript 配置
vitest.config.ts      # Vitest 配置
```

## 测试

- 为新增功能编写单元测试
- 修改现有代码时更新相关测试
- 测试应覆盖正常路径和错误情况
- 运行 `npm test` 确保所有测试通过

## 提交前检查清单

- [ ] 代码遵循项目风格
- [ ] 所有 TypeScript 类型检查通过 (`npm run type-check`)
- [ ] ESLint 检查通过 (`npm run lint`)
- [ ] 所有测试通过 (`npm test`)
- [ ] 提交信息清晰有意义
- [ ] 没有调试代码或 console.log

## 常见问题

**Q: 如何修复 TypeScript 错误？**
A: 运行 `npm run type-check` 查看详细错误，然后添加适当的类型注解。参考 `src/types.ts`。

**Q: ESLint 报告太多错误怎么办？**
A: 运行 `npm run lint:fix` 自动修复格式问题。对于 type-related 错误，需要手动添加类型。

**Q: 如何添加新的依赖？**
A: 运行 `npm install <package>`，更新 package.json 和 package-lock.json。

## 获取帮助

- 查看 AGENT.md 了解架构
- 查看 NEXT_STEPS.md 了解项目规划
- 查看 ANALYSIS_REPORT.md 了解设计决策

感谢你的贡献！
