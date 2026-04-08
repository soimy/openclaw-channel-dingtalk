# AGENTS / CLAUDE 文档分层与 GitNexus 可选增强设计

## 背景

仓库近期引入 GitNexus，用节点式知识图谱增强代码理解、影响评估与变更追溯能力。现有 `AGENTS.md` 与 `CLAUDE.md` 直接内嵌了大量 GitNexus 工作流、强约束语句与工具速查表，导致：

1. 两个根入口文件体积显著膨胀。
2. 项目事实、基础协作规则、工具增强说明混写，职责边界不清。
3. `CLAUDE.md` 是 Claude Code 的正式入口，但公开仓库无法假设所有开发者或 AI 协作者都使用 Claude Code。
4. `AGENTS.md` 作为更通用的项目级智能体入口，需要继续成立；同时又希望和 `CLAUDE.md` 尽量同步，减少漂移。
5. 无 GitNexus 本地环境的贡献者不应被阻塞，基础工作流必须完整可用。

## 目标

- 保持 `AGENTS.md` 为公开、通用的项目级智能体约束入口。
- 保持 `CLAUDE.md` 为 Claude Code 的兼容入口，并与 `AGENTS.md` 尽量同步。
- 将“基础工作流”与“GitNexus 可选增强”拆层披露，减少根文档体积与重复。
- 确保不安装 GitNexus 的开发者仍可完整遵循仓库协作规则。
- 为后续继续接入其他可选工具保留扩展空间，而不再次膨胀根入口文档。

## 非目标

- 不改变现有代码架构或运行时行为。
- 不要求删除 GitNexus 能力，也不降低其对熟悉仓库时的价值。
- 不把规则迁移到仅对某个特定工具可见的位置。

## 设计原则

### 1. 双入口、同骨架

`AGENTS.md` 与 `CLAUDE.md` 都保留，且章节骨架尽量一致：

- 项目概览
- 开始阅读顺序
- 文档落盘约定
- 协作与 PR 约定
- 可选工具原则
- 架构入口与高优先级约束

其中 `CLAUDE.md` 只额外补充最少量的 Claude Code 专属说明，不再承载一整套独立规则体系。

### 2. 入口短、规则长

根目录入口文档只保留不应被忽略的摘要信息与导航链接。详细规则下沉到普通 Markdown 文档中，避免在两个入口文件中重复维护长篇手册。

### 3. 强制目标与可选工具分离

基础规则可要求“修改前评估影响面”“提交前核对变更范围”，但不能要求唯一依赖 GitNexus 命令实现这些目标。GitNexus 作为推荐增强路径单独说明。

### 4. Repo 内普通文档优先

共享规则文档必须是仓库内普通 Markdown 文件，使人类贡献者、Claude Code 以外的 AI 工具、以及纯网页浏览用户都能访问。

## 信息分层

### 第一层：根入口

- `AGENTS.md`
- `CLAUDE.md`
- `WORKFLOW.md`

职责：快速起步、导航、强调高优先级仓库规则。

### 第二层：共享详细规则

- `docs/contributor/agent-workflow.md`

职责：作为所有贡献者与代理共享的基础工作流权威来源。

### 第三层：可选工具增强

- `docs/contributor/gitnexus-optional.md`

职责：说明 GitNexus 在理解代码、影响评估、重构与提交流程中的增强作用，以及缺失时的降级路径。

### 第四层：领域文档

- `docs/contributor/architecture.zh-CN.md`
- `docs/contributor/architecture.en.md`
- `docs/contributor/testing.md`
- `docs/contributor/release-process.md`
- 其他 contributor 文档

职责：承载专项长期文档，不再由根入口文件重复镜像。

## 目标文件职责

### `AGENTS.md`

作为公开项目中的通用 agent 入口文件：

- 保留项目概览与关键高优先级约束。
- 指向 `WORKFLOW.md`、`docs/contributor/agent-workflow.md` 与架构文档。
- 保留文档放置约定、Issue / PR 约定摘要。
- 用短段说明 GitNexus 是可选增强，而非必须依赖。
- 删除超长结构镜像、CODE MAP 与详细 GitNexus 速查表。

### `CLAUDE.md`

作为 Claude Code 专用入口文件：

- 与 `AGENTS.md` 保持相同主骨架。
- 保留相同的项目概览、规则导航与高优先级约束。
- 只新增少量 Claude Code 专属提示，如优先使用专用工具、遵循仓库工作流。
- 不再内嵌完整 GitNexus 手册。

### `WORKFLOW.md`

作为根目录摘要导航：

- 告诉新进入仓库的协作者应先读什么。
- 用 5 步以内描述基础工作流。
- 链接到 `agent-workflow.md`、架构、测试、发布流程。
- 说明 GitNexus 是可选增强，缺失时按基础工作流继续。

### `docs/contributor/agent-workflow.md`

作为共享基础规则的唯一权威来源：

- 说明适用对象与目标。
- 按阶段描述基础工作流：理解任务、评估影响、实施变更、验证结果、准备交付。
- 写清本仓库特有的高优先级约束。
- 保留文档与 PR 规范。
- 用工具无关语言表达必做事项。

### `docs/contributor/gitnexus-optional.md`

作为 GitNexus 增强说明：

- 说明何时使用 GitNexus。
- 把基础工作流步骤映射到 GitNexus 工具能力。
- 提供索引新鲜度与常用命令建议。
- 明确声明：GitNexus 缺失不阻塞常规开发。

## 关键措辞改造

需要将现有“工具绑定型强约束”改为“目标强制、工具可选”的表达。

### 旧表达

- MUST run `gitnexus_impact` before editing any symbol.
- MUST run `gitnexus_detect_changes()` before committing.
- NEVER edit a function without GitNexus impact analysis.

### 新表达

- 修改函数、类或方法前，必须评估影响面，检查直接调用方、导入方与受影响链路。
- 若本地可用 GitNexus，优先使用 `gitnexus_impact`、`gitnexus_context` 等图谱工具完成该步骤。
- 提交前必须确认变更范围与预期一致；若本地可用 GitNexus，`gitnexus_detect_changes()` 是推荐做法。
- 重命名不要依赖盲目的仓库级文本替换；若本地可用 GitNexus，优先使用图谱感知重命名流程。

## 兼容性策略

### 无 GitNexus 的开发者

必须能仅依赖：

- 阅读相关文件
- 搜索调用点/导入点
- 执行类型检查、lint、测试、docs 构建
- 阅读架构与 workflow 文档

完成一次完整且合规的贡献流程。

### 有 GitNexus 的开发者

可在以下环节获得增强：

- 初始理解仓库与执行流
- 变更前影响评估
- 重构与 rename 安全性提升
- 提交前核对受影响范围

但这些增强不改变基础规则的存在与可执行性。

## 迁移步骤

1. 新增 `WORKFLOW.md`，提供仓库工作流摘要导航。
2. 新增 `docs/contributor/agent-workflow.md`，承载共享基础规则。
3. 新增 `docs/contributor/gitnexus-optional.md`，承载工具增强说明。
4. 精简 `AGENTS.md`，移除长结构镜像、CODE MAP 与 GitNexus 详细手册，改为指向新文档。
5. 精简 `CLAUDE.md`，保持与 `AGENTS.md` 同骨架，并仅增加少量 Claude Code 专属说明。
6. 如有必要，在 contributor 入口页加入新文档链接。
7. 运行 docs 构建验证站点链接与文档结构。

## 预期结果

- `AGENTS.md` 与 `CLAUDE.md` 长度显著下降。
- 项目事实、基础规则、工具增强三类信息职责清晰。
- 通用入口与 Claude 入口高度同步，但不再需要维护两份巨型手册。
- GitNexus 从“主规则内嵌强依赖”转为“公开可选增强层”。
- 仓库对未安装 GitNexus 的开发者更友好，同时保留 GitNexus 对熟悉仓库的加速价值。
