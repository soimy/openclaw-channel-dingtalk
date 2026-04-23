# Card Template v2 修复 + 真机测试 Handoff

**日期：** 2026-04-05
**分支：** card-template-v2-clean (worktree: `.worktrees/card-template-v2`)
**PR：** #480
**状态：** 代码修复已完成并推送，待真机验证

---

## 已完成工作

### Codex 审核修复 (P0-P3)

基于 Codex adversarial review 发现的 5 个问题，已完成全部修复并推送：

| # | 问题 | 优先级 | Commit | 状态 |
|---|------|--------|--------|------|
| 1 | `getRenderedContent()` 返回 JSON 而非 markdown | P1 | `2e10243` | ✅ |
| 2 | `finishAICard()` 使用 streaming API finalize | P0 | `6dc9419` | ✅ |
| 3 | 远程 media URL 直接传给 `uploadMedia()` | P2 | `d9f8f80` | ✅ |
| 4 | 非图片附件硬编码为 `image` 类型 | P2 | `d9f8f80` | ✅ |
| 5 | Quote header 用错内容来源 | P3 | `fab3738` | ✅ |

### 关键修复内容

#### P0: commitAICardBlocks 单次 instances API 固化

`commitAICardBlocks()` 重构为 V2 finalize 入口，使用 `FinalizeCardOptions` 接口：

```typescript
export interface FinalizeCardOptions {
    blockListJson: string;    // CardBlock[] JSON
    content: string;          // 纯文本 (供复制)
    quoteContent?: string;    // 引用内容
    quotedRef?: QuotedRef;    // 用于缓存
}
```

单次 `updateCardVariables()` 调用写入 `blockList + content + flowStatus=3`。

#### P1: getRenderedContent 方法拆分

- `getRenderedBlocks()` → 返回 `CardBlock[]` JSON string (供 instances API)
- `getRenderedContent()` → 返回纯 markdown (供复制/fallback)

#### P2: 远程 Media URL 处理

使用 `prepareMediaInput()` 处理远程 URL，`resolveOutboundMediaType()` 检测类型：
- 图片 → `uploadMedia()` + `appendImageBlock()`
- 非图片 → 跳过 (卡片只支持 type=3 图片块)

#### P3: Quote 内容来源

从 `extractedContent.quoted?.previewText || data.content?.quoteContent` 获取被引用消息预览。

### 验证状态

- 831 tests passed
- type-check passed
- lint passed (0 errors, 89 warnings for `no-explicit-any`)
- 实施记录: `docs/artifacts/2026-04-04-v2-card-fix-implementation.md`

---

## 待办：真机测试方案

基于 `skills/dingtalk-real-device-testing/SKILL.md` 设计的 PR-scoped 测试清单。

### 环境准备

1. 切换 openclaw 插件目录指向 worktree
2. `openclaw gateway restart` 加载最新代码
3. 准备测试群组（群聊 + 单聊场景）

### T1: V2 Finalize 链路验证 (P0)

**目标：** 验证 `commitAICardBlocks()` 使用 instances API 正确固化卡片

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 在群聊发送简单问题（如"你好"） | 卡片创建并流式显示 |
| 2 | 等待回复完成 | 卡片进入完成态，Stop Button 自动隐藏 |
| 3 | 点击复制按钮 | 复制到纯 markdown 文本（非 JSON） |
| 4 | 检查日志 `[DingTalk][Finalize]` | 确认 `commitAICardBlocks` 调用成功 |

**观测点：**
- 日志中搜索 `commitAICardBlocks` 确认走 instances API 路径
- 日志中不应出现 `finishAICard` 或 `streaming API finalize` 调用
- `flowStatus=3` 写入后 Stop Button 应自动消失

### T2: getRenderedContent/Blocks 输出验证 (P1)

**目标：** 验证两个方法输出格式正确

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 发送需要思考的问题（如"解释量子纠缠"） | 卡片显示 thinking + answer 块 |
| 2 | 等待完成 | 复制按钮获取纯 markdown |
| 3 | 长回答场景（>500字） | 完整内容被保留，无截断 |

**观测点：**
- 复制内容应为纯 markdown，不应包含 JSON 结构（如 `[{"type":0,"markdown":"..."}]`）
- Thinking 块内容不应出现在复制文本中（`getRenderedContent` 只取 type=0 的 answer 块）

### T3: 远程 Media URL 处理 (P2)

**目标：** 验证远程图片 URL 能正确嵌入卡片

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 发送图片 URL（如"请描述这张图片 https://example.com/test.png"） | 图片嵌入卡片 |
| 2 | 等待完成 | 卡片中显示图片块 |

**观测点：**
- 日志中搜索 `prepareMediaInput` 确认走远程 URL 处理路径
- 不应出现 ENOENT 错误

### T4: 非图片附件降级 (P2)

**目标：** 验证非图片附件被跳过而非报错

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 发送 PDF URL（如"请分析这个文件 https://example.com/doc.pdf"） | 卡片正常显示文本回复 |
| 2 | 等待完成 | 无报错，日志显示 `Skipping non-image media` |

**观测点：**
- 日志中搜索 `Skipping non-image media` 确认降级路径
- 不应出现 `uploadMedia` 调用失败错误

### T5: Quote 内容来源验证 (P3)

**目标：** 验证卡片引用头部显示被引用消息内容

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | 在群聊中回复一条消息（引用） | 卡片创建时引用头部显示被引用消息预览 |
| 2 | 等待完成 | 引用内容正确（非当前消息内容） |

**观测点：**
- 卡片顶部引用区域显示的是被回复的消息内容，而非用户发送的消息

### 附加测试场景

#### A1: cardRealTimeStream 双模式

| 场景 | 操作 | 预期 |
|------|------|------|
| `cardRealTimeStream=false` | 发送问题 | answer 文本直接更新到 blockList |
| `cardRealTimeStream=true` | 发送问题 | answer 先流式显示在 content，边界处清空并提交 blockList |

#### A2: 卡片失败降级

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1 | 触发卡片失败（如 token 过期） | 自动降级为 markdown 消息 |
| 2 | 检查日志 | 显示 `Card failed, sending markdown fallback` |

---

## 关键文件索引

| 文件 | 作用 |
|------|------|
| `src/card-service.ts` | `commitAICardBlocks()`, `updateAICardBlockList()` |
| `src/card-draft-controller.ts` | `getRenderedBlocks()`, `getRenderedContent()`, timeline 渲染 |
| `src/reply-strategy-card.ts` | finalize 调用链, media 处理 |
| `src/inbound-handler.ts` | quote 内容来源 |
| `src/media-utils.ts` | `prepareMediaInput()`, `resolveOutboundMediaType()` |
| `docs/spec/2026-03-30-card-template-v2-design.md` | V2 模板设计规格 |
| `docs/artifacts/2026-04-04-v2-card-fix-implementation.md` | 修复实施记录 |

## 参考文档

- Hybrid Streaming 实现: `docs/plans/2026-04-04-dingtalk-card-v2-hybrid-streaming-implementation.md`
- Hybrid Streaming Handoff: `docs/plans/2026-04-04-card-v2-hybrid-streaming-handoff.md`
- Image Block 迁移 Handoff: `docs/plans/2026-04-04-card-v2-image-block-test-migration-handoff.md`
