# 智能体约束文档向 Skills 固化的下一阶段设计

## 背景

当前仓库已完成智能体约束文档的第一轮信息架构整理：

- `AGENTS.md` 作为公开、通用的项目级智能体入口
- `CLAUDE.md` 作为 Claude Code 兼容入口并与 `AGENTS.md` 保持高同步
- `WORKFLOW.md` 作为仓库级工作流摘要导航
- `docs/contributor/agent-workflow.md` 作为共享基础规则层
- `docs/contributor/gitnexus-optional.md` 作为 GitNexus-first 增强层
- `docs/contributor/fallback-navigation.md` 作为无 GitNexus 的手工 fallback 层

这一层面已经解决了“规则如何分层披露”的问题，但仍有若干高重复、步骤稳定、输出格式明确的流程继续停留在文档规则中。对于这些内容，继续放在文档里只提供“可阅读的约束”，而不能提供“可执行的流程编排”。

## 目标

将适合固化的高频流程从智能体约束文档中进一步抽取为 skills，使 Claude/其他 agent 在特定上下文中能够自动进入稳定流程，减少漏步、减少输出格式漂移，并降低主入口文档继续膨胀的风险。

## 非目标

- 不把项目事实、架构边界、静态规则全部迁移成 skills。
- 不在本阶段实现所有 skill 细节或完成所有 eval。
- 不把高风险发布动作默认自动执行到不可逆阶段。

## 选择原则

一个流程适合 skill 化，通常满足以下特征：

1. 触发语义清晰，用户请求容易识别。
2. 步骤相对稳定，流程编排可以复用。
3. 输出格式明确，适合模板化或 checklist 化。
4. 容易漏掉关键步骤，文档提醒不够强。
5. 与仓库约定强相关，通用模型容易偏离。

## 建议的 Skill 分组

### 一、文档与交付类

#### 1. `repo-doc-routing`

**职责：**
根据用户要写的内容类型，决定文档应该落在哪个目录、是否属于用户文档 / contributor 文档 / release note / spec / plan，并提醒需要同步的相关入口。

**适用场景：**
- 写 spec
- 写 implementation plan
- 写 contributor 指南
- 更新 release note
- 调整 docs 页面但不确定归属

**为什么适合 skill 化：**
该流程高度稳定，并且当前仓库已经明确禁止创建工具私有根目录、禁止在 README 堆积长文，skill 可显著减少错放文档的概率。

#### 2. `pr-description-writer`

**职责：**
根据 diff、相关 spec / plan 和验证信息，生成符合本仓库约定的 PR 描述，并补齐 `背景` / `目标` / `实现` / `实现 TODO` / `验证 TODO` 结构。

**适用场景：**
- 准备创建 PR
- 需要补 PR body
- 需要根据改动生成 `验证 TODO`

**为什么适合 skill 化：**
PR 描述格式稳定、输出结构固定、容易漏 `验证 TODO`，且与仓库中文 PR body 规范强绑定。

#### 3. `release-note-authoring`

**职责：**
根据已完成改动、版本号、最近 commit / diff 或 release 目标，生成版本说明文档，并在必要时提示同步 release index / sidebar / 站点导航。

**适用场景：**
- 编写新版本说明
- 补发版本记录
- 需要根据改动汇总用户可见变化

**为什么适合 skill 化：**
版本说明结构、措辞和产物位置都相对稳定，并且与 docs 发布导航高度联动。

### 二、流程与安全类

#### 4. `repo-impact-analysis`

**职责：**
统一封装“修改前影响评估”流程：
- GitNexus 可用时走 GitNexus-first
- GitNexus 不可用时退到 `fallback-navigation.md`
- 输出统一的影响面摘要、关键入口和建议验证范围

**适用场景：**
- 用户问“改这个会影响什么”
- 在编辑某个 symbol 前做安全评估
- 定位入口文件或执行流
- 准备做 rename / refactor

**为什么适合 skill 化：**
当前仓库已经形成了明确的能力分流逻辑，这比长期把流程写在文档里更适合 skill 化。

#### 5. `release-publish-orchestration`

**职责：**
编排发布前检查、版本 readiness、docs / test / release note / npm publish checklist，并把危险操作与只读检查动作清晰区分。

**适用场景：**
- 准备发布 npm 包
- 做 release readiness check
- 需要确认能否发版

**为什么适合 skill 化：**
发布是高风险但流程稳定的动作，最适合通过 skill 进行强引导和明确确认边界。

### 三、项目专属验证类

#### 6. `dingtalk-real-device-testing`（增强现有 skill）

**职责：**
继续强化当前真机验证流程，做到：
- 根据 diff 判断是否需要真机验证
- 按改动类型生成更细颗粒度的 `验证 TODO`
- 区分 docs/workflow 改动与用户可见消息链路改动
- 为 PR 描述和发布前检查复用同一套验证抽象

**适用场景：**
- 影响 DingTalk 用户可见行为的 PR
- 需要补真机验证清单
- 需要在发布前检查真机覆盖情况

## 为什么不是所有内容都适合做 Skill

以下内容更适合继续保留在文档层：

- 项目事实和静态背景：例如 OpenClaw / DingTalk / Stream mode 的基本介绍
- 长期稳定的架构边界：例如 `src/channel.ts` 保持薄、逻辑领域划分
- fallback navigation 本身：它更适合作为 skill 的 reference，而不是独立 skill
- 日志前缀、返回值形状、基础 code conventions 等静态规则

这些内容本质上是上下文，而不是动作流程。

## 推荐实施顺序

### 第一批（优先级最高）

1. `pr-description-writer`
2. `release-note-authoring`
3. `repo-impact-analysis`

理由：
- 触发频率高
- 流程最稳定
- 对当前文档规约的减负效果最明显
- 复用 GitNexus-first / fallback 分流最自然

### 第二批

4. `repo-doc-routing`
5. `release-publish-orchestration`

理由：
- 价值高，但需要先稳定好第一批的输出接口和约定
- `release-publish-orchestration` 涉及高风险动作，需要更审慎设计确认边界

### 第三批

6. 增强 `dingtalk-real-device-testing`

理由：
- 现有技能已经承担一部分职责，应先在前两批 skill 成型后再对齐接口，避免重复设计

## 触发与边界建议

### `repo-doc-routing`
- 应在用户提到“写文档、写 spec、写计划、更新 contributor 文档、更新 release 文档”时触发
- 只负责“文档类型判断与落盘路由”，不替代具体写作 skill

### `pr-description-writer`
- 应在用户准备开 PR、补 PR 描述、生成 `验证 TODO` 时触发
- 可读取 diff、spec、plan，但不直接 push / create PR

### `release-note-authoring`
- 应在用户提到版本说明、release note、发布页时触发
- 只负责文案和 docs 导航联动，不直接发布 npm 包

### `repo-impact-analysis`
- 应在用户问“改这个会影响什么”“这个从哪进来”“我要重构这里”时触发
- 统一决定走 GitNexus-first 还是 fallback path

### `release-publish-orchestration`
- 应在用户明确表示“准备发版 / 发 npm / 做发布检查”时触发
- 默认只生成 checklist 和 readiness 结论；真正不可逆操作必须再次确认

### `dingtalk-real-device-testing`
- 继续用于 PR 级别真机验证与 `验证 TODO` 生成
- 与 `pr-description-writer` / `release-publish-orchestration` 做接口衔接

## 对现有文档体系的影响

如果这些 skill 逐步落地，当前文档体系中的变化方向应是：

- `AGENTS.md` / `CLAUDE.md` / `WORKFLOW.md` 保留“读哪些文档、何时触发哪些 skill”的入口语义
- `docs/contributor/agent-workflow.md` 保留基础规则，不承载长 checklist
- `docs/contributor/gitnexus-optional.md` 继续作为 `repo-impact-analysis` 的参考文档之一
- `docs/contributor/fallback-navigation.md` 继续作为手工 fallback reference，而不是默认入口
- 发布、PR、文档落盘、真机验证等高重复流程更多通过 skills 表达

## 预期收益

- 减少主入口文档继续膨胀
- 减少 PR / release / docs / impact 分析等流程的漏步率
- 提升对公开仓库协作者的行为一致性
- 让 GitNexus-first 与 fallback 路径真正变成可执行流程，而不只是文字约束
- 为未来继续接入更多 MCP / 图谱 / 发布工具保留统一的 skill 化扩展点
