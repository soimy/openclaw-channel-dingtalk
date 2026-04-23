# OpenClaw DingTalk Channel 贡献指南

English version: [`CONTRIBUTING.md`](CONTRIBUTING.md)

感谢你为 OpenClaw 的 DingTalk Channel 插件做出贡献。

这个仓库有几个改动时需要特别谨慎的区域：

- Stream 模式连接生命周期与入站回调处理
- 仅内存运行态，例如 `dedup.processed-message`、`session.lock`、`channel.inflight`
- 文字、媒体、文件、AI 卡片等引用消息恢复链路
- 会随着租户环境、应用权限和 `dingtalk-stream` 版本变化的钉钉平台行为

这份文档是贡献入口；更深入的钉钉平台细节请继续查看 `README.md` 和 `docs/` 下的文档。

## 文档放置规范

今后的文档更新请遵守分层约束：

- `README.md` 只作为仓库入口页，不要继续把长篇功能说明、配置矩阵、深度排障、发布历史等内容塞回 `README`。
- 面向用户的安装、配置、功能说明和故障排查，统一更新到 `docs/user/`。
- 面向贡献者的架构、测试、开发和发布流程，统一更新到 `docs/contributor/`。
- 版本发布说明统一放到 `docs/releases/`。
- 新增版本发布说明时，同时更新 `docs/releases/latest.md`，保证 latest 入口和 `/releases/` 默认页始终指向最新版本。

如果某次代码改动影响了用户可见行为、配置、权限、路由、卡片、媒体、引用链或排障方式，请在同一个 PR 里同步更新对应 `docs/` 页面，而不是把说明追加进 `README.md`。

## 架构边界

仓库的整体架构说明、模块职责边界和增量迁移规则以 [`docs/contributor/architecture.en.md`](docs/contributor/architecture.en.md) 为准。
中文版本见 [`docs/contributor/architecture.zh-CN.md`](docs/contributor/architecture.zh-CN.md)。

新增模块或扩展现有模块前，请先对齐以下规则：

- 保持 `src/channel.ts` 为装配层
- 先遵守逻辑领域边界，再考虑大规模物理迁移
- 新代码优先落在清晰的业务域内，而不是继续往 `src/` 根目录平铺
- 结构重排与行为改动在条件允许时尽量拆分
- 具体的落位与迁移判断以架构文档为准

计划中的逻辑分区摘要：

- `gateway/`: Stream 连接生命周期、回调注册、入站事件入口
- `targeting/`: `conversationId`、peer 身份、session alias、目标解析
- `messaging/`: 入站内容提取、reply strategy、文本与媒体发送
- `card/`: AI Card 生命周期、恢复与缓存
- `command/`: slash 命令、feedback learning、目标级命令扩展
- `platform/`: config、auth、runtime、logger、核心 types
- `shared/`: 可复用持久化原语、dedup 与跨领域工具

当前仓库仍处于渐进整理阶段；进行中的 PR 不要求为此做全仓文件搬迁，但新代码应尽量沿着文档中的边界收敛。

## 快速开始

1. Fork 并克隆仓库。
2. 安装依赖。
3. 将插件链接到本地 OpenClaw 环境。
4. 配置一个用于测试的钉钉应用和工作区。
5. 在提交 PR 前运行验证命令。

```bash
git clone https://github.com/soimy/openclaw-channel-dingtalk.git
cd openclaw-channel-dingtalk
npm install
openclaw plugins install -l .
```

如果你希望走更干净的本地配置流程，优先使用：

```bash
openclaw onboard
```

或者：

```bash
openclaw configure --section channels
```

## 本地开发环境

推荐的本地开发方式：

- 使用全局安装的 `openclaw` CLI / runtime 做手工联调
- 将本插件仓库作为独立仓库放在 OpenClaw 父仓库之外
- 本地保留一个 `~/Repo/openclaw` 仓库，仅用于源码跳转、`plugin-sdk` 类型解析和内部链路研究

推荐目录结构：

```text
~/Repo/openclaw
~/Repo/openclaw-channel-dingtalk
```

然后把独立插件仓库以链接方式安装进全局 OpenClaw 环境：

```bash
cd ~/Repo/openclaw-channel-dingtalk
openclaw plugins install -l .
```

本仓库的 `tsconfig.json` 已刻意兼容以下两种路径来源：

- 独立仓库模式：`~/Repo/openclaw-channel-dingtalk -> ../openclaw/src/plugin-sdk`
- 历史嵌套模式：`~/Repo/openclaw/extensions/openclaw-channel-dingtalk -> ../../src/plugin-sdk`

这样在从 `submodule + worktree` 迁移到独立仓库开发时，编辑器跳转和本地类型解析不会一起失效。

开始本地测试前，请先确认：

- `~/.openclaw/openclaw.json` 中已通过 `plugins.allow: ["dingtalk"]` 允许加载本插件
- 已创建或复用了一个启用了机器人能力的钉钉企业内部应用
- 消息接收模式已设置为 Stream 模式
- 应用版本已发布到目标租户，否则回调测试可能无效
- 已在 OpenClaw 配置中填入必需的钉钉凭证

完整配置步骤请优先参考结构化文档：

- 安装与本地链接：`docs/user/getting-started/install.md`
- 钉钉应用配置与权限说明：`docs/user/getting-started/permissions.md`
- 配置说明：`docs/user/getting-started/configure.md`
- 英文连接排障文档：`docs/user/troubleshooting/connection.en.md`
- 中文连接排障文档：`docs/user/troubleshooting/connection.zh-CN.md`

## 提交前验证清单

在新开 PR 或更新 PR 前，请运行以下命令：

```bash
npm run type-check
npm run lint
pnpm test
pnpm test:coverage
```

这些命令分别覆盖：

- `npm run type-check`：严格的 TypeScript 类型检查
- `npm run lint`：风格与 type-aware lint 检查
- `pnpm test`：Vitest 单元测试和集成测试
- `pnpm test:coverage`：辅助确认改动路径没有完全缺少测试覆盖

自动化测试中的网络请求应保持 mock；不要依赖真实 DingTalk API 访问来通过测试。

## 测试文件维护

添加新测试或维护既有测试文件时，请遵循以下规模指南：

### 规模阈值

| 行数 | 处理 |
|------|------|
| <500 | 正常，无需处理 |
| 500-800 | 规划拆分，可在后续工作中执行 |
| >800 | 必须拆分后再合并 |

### 拆分策略

1. **识别功能域** — 按被测功能分组（如 quote handling、card lifecycle）
2. **提取共享 mock** — 在 `tests/unit/fixtures/` 创建 fixture 模块
3. **按域拆分** — 创建 `source-module-{domain}.test.ts`，每个文件 10-25 个测试
4. **保留核心流程** — 端到端 pipeline 测试留在主文件
5. **清理冗余** — 拆分前合并重复验证相同行为 ≥3 次的测试

### 命名规范

- 拆分文件：`inbound-handler-quote.test.ts`、`send-service-media.test.ts`
- Fixture 文件：`tests/unit/fixtures/inbound-handler-fixture.ts`

## 手工测试建议

如果你的改动影响运行时行为，请在 PR 描述里附上一段简短的手工测试说明。

建议至少覆盖：

- 单聊和群聊中的文本消息
- 如改动相关，则验证图片、语音、视频、文件等媒体处理
- 如果改了入站解析或媒体/文件处理，验证引用消息恢复
- 如果改了 outbound 或卡片流程，验证 AI 卡片创建、流式更新、结束态和 markdown 回退
- 如果改了 dedup、inflight 防重或 ack 时机，验证重试与重复投递行为

测试时常用的仓库入口：

- `tests/unit/`
- `tests/integration/`
- `scripts/dingtalk-stream-monitor.mjs`

## 按问题类型补充验证

### 消息丢失或 Stream 投递语义改动（#104）

如果你的改动涉及入站回调、连接生命周期、去重或 ack 逻辑，请额外提供：

- 消息到达时间戳和消息 ID
- 该消息是否到达 DingTalk、Stream 客户端、插件处理器的判断结果
- 你做过的缺失 ID 对账方式
- 如有可能，附上监控脚本输出

可以使用仓库自带的 Stream 监控脚本：

```bash
npm run monitor:stream -- --duration 300 --summary-every 30 --probe-every 20
```

如果 PR 改动了消息到达语义，请同时在描述中引用 `README.md` 中的说明和 issue `#104`。

### 模块加载或 SDK 兼容性改动（#264）

如果你的改动涉及 `dingtalk-stream` 集成或启动行为，请附上：

- Node.js 版本
- 插件安装方式（`npm`、本地 link、手动复制）
- `package.json` 中的 `dingtalk-stream` 版本
- 你验证启动、建立连接、重连行为的具体过程

### 多图或消息格式解析改动（#268）

如果你的改动涉及入站消息提取或媒体解析，请附上：

- 精确复现步骤
- 在可行情况下附上原始或最小脱敏后的入站 payload 结构
- 说明场景是单聊、群聊、引用回复，还是混合媒体
- 说明新增或更新了哪些自动化测试

## 如何提交高质量 Issue

优先使用 `.github/ISSUE_TEMPLATE/` 下的 GitHub Issue 模板。
考虑到本仓库的主要用户与贡献者以中文为主，Issue 标题和描述优先使用简体中文，便于更高效地沟通和定位。

推荐的 Issue 提交方式：

- bug、回归、兼容性或运行异常，使用 `问题反馈` 模板
- 功能需求、体验改进或设计建议，使用 `功能建议` 模板
- 标题尽量直接概括问题或目标，避免只有“有问题”“求支持”这类信息量过低的标题
- bug 类问题尽量补齐 `背景`、`复现步骤`、`期望行为`、`实际行为`、`环境信息`
- 功能建议尽量补齐 `背景`、`目标`、可选的 `建议实现`，以及 `验收标准或预期效果`
- 如果日志、截图、payload 样本或关联 issue/PR 能帮助判断，请一并附上
- 发布前请先脱敏，不要提交 token、secret、租户凭证或私有客户数据
- 空白 Issue 仍然可用，但按模板结构补齐信息，通常能更快获得有效响应

提交 bug report 时，请至少包含：

- 插件版本
- OpenClaw 版本
- `dingtalk-stream` 版本
- Node.js 版本
- 安装方式（`openclaw plugins install`、`openclaw plugins install -l .`、或手动安装）
- 问题发生在单聊、群聊还是两者都有
- 带时间戳的相关日志
- 精确复现步骤

请务必脱敏 secrets、token 和私有租户信息。

如果希望问题报告更高信号，建议再补充：

- #104 类问题：缺失消息 ID、消息到达时间窗口、监控脚本输出
- #264 类问题：启动日志、模块解析错误、环境细节
- #268 类问题：消息 payload 样本和精确的多图格式

## Pull Request 要求

请尽量让 PR 聚焦、易审阅：

- 一个 PR 只解决一个问题，或一组紧密相关的改动
- PR 标题使用英文 Conventional 风格，例如 `fix(targeting): normalize learned display names`
- 标题中的 type、可选 scope 和 summary 均使用英文，不要写中文标题
- PR 描述统一使用简体中文
- PR 描述需要清晰写出 `背景`、`目标`、`实现`
- PR 描述中必须包含 `实现 TODO` 和 `验证 TODO` 两组 checklist
- 在 PR 描述里链接相关 issue
- 说明改了什么，以及为什么这样改
- 列出你跑过的自动化验证
- 如果做了手工验证，也一并写清楚

推荐的 PR 描述结构：

- `背景`：说明为什么要改、对应什么问题或上下文
- `目标`：说明这个 PR 预期达成什么结果
- `实现`：说明主要实现思路和关键取舍
- `实现 TODO`：用 checkbox 列出已完成和待完成的实现项
- `验证 TODO`：用 checkbox 列出自动化验证和手工验证项

如果改动了状态管理相关逻辑，请明确说明是否影响：

- `dedup.processed-message`
- `session.lock`
- `channel.inflight`

这些命名空间刻意保持为进程内、仅内存态。除非先讨论设计，否则不要引入跨进程持久化或共享锁语义。

如果你的 PR 是 AI 辅助生成的，请遵循上游 OpenClaw 的透明原则：

- 在标题或描述中标注这是 AI-assisted PR
- 说明你的测试程度
- 如果有帮助，附上 prompts 或 session logs
- 确认你理解提交的代码和验证结果

## 测试风格建议

- parser、config、auth、dedup、service 逻辑优先补充聚焦的单元测试
- 当行为跨越多个模块时，再补集成测试，例如 gateway start、inbound dispatch、send lifecycle、persistence migration
- 测试里保持网络访问为 mocked 状态
- 尽量对齐 `tests/unit/` 和 `tests/integration/` 的现有 Vitest 风格

## 安全与敏感数据

- 不要提交 token、应用 secret、租户凭证或原始私有客户 payload
- 除非诊断必须，否则公开日志时请脱敏各类 ID
- 不要在新代码或测试夹具里记录原始 access token

如果是安全问题，请不要在公开 issue 中披露可利用细节。请按上游 OpenClaw 贡献指南中的安全提交流程处理。

## 参考资料

- `README.md`
- `docs/user/troubleshooting/connection.en.md`
- `docs/user/troubleshooting/connection.zh-CN.md`
- `docs/assets/card-template.json`
- issue `#104`
- issue `#264`
- issue `#268`

感谢贡献。
