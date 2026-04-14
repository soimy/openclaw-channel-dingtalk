# 智能体约束文档向 Skills 固化实施计划

> **For agentic workers:** Execute this plan task-by-task with review between steps. If your environment supports subagent-based execution you may use it; otherwise execute the checklist inline.

**Goal:** 将当前文档中适合稳定流程化的内容逐步固化为 skills，减少主入口文档膨胀，并让 PR、release、impact analysis、文档落盘等流程具备更强的自动触发与一致性。

**Architecture:** 采用“文档保留规则与上下文，skill 承载高重复流程”的分工：文档层负责长期约束与参考资料，skill 层负责在具体任务场景下触发、编排步骤、生成标准输出，并在可选能力（如 GitNexus）与 fallback 之间做自动分流。

**Tech Stack:** Claude Code skills, Markdown SKILL.md, repository contributor docs, GitNexus MCP, GitHub PR workflow

---

### Task 1: 定义 Skill 边界与优先级

**Files:**
- Create: `docs/spec/2026-04-08-agent-constraint-skills-roadmap-design.md`
- Create: `docs/plans/2026-04-08-agent-constraint-skills-roadmap-plan.md`

- [ ] **Step 1: 固化候选 skills 的职责边界**

```text
第一批：pr-description-writer, release-note-authoring, repo-impact-analysis
第二批：repo-doc-routing, release-publish-orchestration
第三批：增强 dingtalk-real-device-testing
```

- [ ] **Step 2: 明确哪些内容继续留在文档层**

```text
保留在文档层：项目事实、架构边界、静态 code conventions、fallback reference
迁移到 skill 层：高重复、触发稳定、输出结构明确的流程
```

- [ ] **Step 3: 确认技能触发边界与高风险动作确认策略**

```text
release-publish-orchestration 默认只生成 readiness 结论与 checklist，不直接执行不可逆发布动作。
```

### Task 2: 设计第一批 Skills

**Files:**
- Create: `.claude/skills/pr-description-writer/SKILL.md`
- Create: `.claude/skills/release-note-authoring/SKILL.md`
- Create: `.claude/skills/repo-impact-analysis/SKILL.md`
- Modify: `docs/contributor/agent-workflow.md`
- Modify: `docs/contributor/gitnexus-optional.md`
- Modify: `docs/contributor/fallback-navigation.md`

- [ ] **Step 1: 设计 `pr-description-writer`**

```text
输入：git diff、相关 spec/plan、验证记录
输出：中文 PR body，含 背景 / 目标 / 实现 / 实现 TODO / 验证 TODO
```

- [ ] **Step 2: 设计 `release-note-authoring`**

```text
输入：版本号、变更范围、docs/releases 现状
输出：release note 草案、必要的 release index/sidebar 联动提示
```

- [ ] **Step 3: 设计 `repo-impact-analysis`**

```text
输入：目标 symbol 或概念
输出：GitNexus-first 或 fallback 的统一影响面摘要、关键入口、验证建议
```

- [ ] **Step 4: 为每个 skill 制定 2-3 个触发测试 prompt**

```text
示例：
- "帮我写这个 PR 的描述，并补齐验证 TODO"
- "根据最近的改动整理 3.5.4 的 release note"
- "如果我改 message-context-store，会影响什么？"
```

### Task 3: 设计第二批 Skills

**Files:**
- Create: `.claude/skills/repo-doc-routing/SKILL.md`
- Create: `.claude/skills/release-publish-orchestration/SKILL.md`
- Modify: `WORKFLOW.md`
- Modify: `docs/contributor/release-process.md`

- [ ] **Step 1: 设计 `repo-doc-routing`**

```text
输入：用户要写的文档类型或任务描述
输出：推荐落盘路径、需要同步更新的文档入口、禁止落盘位置提醒
```

- [ ] **Step 2: 设计 `release-publish-orchestration`**

```text
输入：版本号、发布目标、当前 readiness 状态
输出：发布 checklist、阻塞项、需要用户确认的不可逆动作列表
```

- [ ] **Step 3: 明确发布 skill 与 release note skill 的边界**

```text
release-note-authoring 只负责编写说明；release-publish-orchestration 只负责编排发布准备与确认。
```

### Task 4: 增强 `dingtalk-real-device-testing`

**Files:**
- Modify: existing `dingtalk-real-device-testing` skill files
- Modify: `docs/contributor/testing.md`
- Modify: `docs/contributor/agent-workflow.md`

- [ ] **Step 1: 对齐该 skill 与 PR / release 流程的接口**

```text
让 skill 输出可直接复用到 PR 的 验证 TODO 和发布前检查。
```

- [ ] **Step 2: 让真机验证清单按改动范围分层**

```text
区分 docs/workflow 改动、消息链路改动、card 交互改动、引用/媒体改动。
```

- [ ] **Step 3: 更新文档中的 skill 入口提示**

```text
当任务涉及 DingTalk 用户可见行为时，优先使用该 skill。
```

### Task 5: 评测与迭代

**Files:**
- Create: `evals/evals.json` under each new skill as needed
- Create: skill workspaces for iteration runs

- [ ] **Step 1: 为第一批 skills 写触发测试集**

```json
{
  "skill_name": "pr-description-writer",
  "evals": [
    {
      "id": 1,
      "prompt": "我准备开 PR 了，帮我把这次改动整理成仓库要求的中文 PR 描述，并补 验证 TODO",
      "expected_output": "生成符合仓库模板的 PR body",
      "files": []
    }
  ]
}
```

- [ ] **Step 2: 跑 with-skill / baseline 对比**

```text
比较是否更稳定地产出仓库约定格式、是否减少漏项、是否更准确分流 GitNexus 与 fallback。
```

- [ ] **Step 3: 根据反馈精修 skill 描述与触发条件**

```text
重点看 under-trigger 和 over-trigger 问题。
```

### Task 6: 更新入口文档

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `WORKFLOW.md`
- Modify: `docs/contributor/agent-workflow.md`

- [ ] **Step 1: 在入口文档中加入技能入口提示**

```text
例如：准备 PR 时使用 pr-description-writer；写 release note 时使用 release-note-authoring。
```

- [ ] **Step 2: 删除已被 skill 明确接管的长流程段**

```text
保留规则摘要，移除可执行细节，避免重复维护。
```

- [ ] **Step 3: 跑 docs 构建并复核链接**

Run: `pnpm run docs:build`
Expected: PASS
