# Fix Plan: Codex Adversarial Review 问题修复

**日期：** 2026-04-07
**审核类型：** Adversarial Review (对抗性审核)
**状态：** 已完成
**分支：** card-template-v2-clean vs main (排除测试文件)

---

## 问题概览

| 编号 | 严重性 | 问题 | 影响 |
|------|--------|------|------|
| F1 | 🔴 Critical | 图片可能被嵌入错误用户的卡片 | 跨用户数据泄露、状态污染 |
| F2 | 🔴 High | Abort 路径使用废弃的 finalize API | 卡片状态不一致、用户界面卡住 |
| F3 | 🟡 Medium | 非图片附件绕过 reply session 权限语义变化 | 权限语义变化、消息类型降级 |
| F4 | 🟡 Medium | quoteContent 使用重写后的入站文本 | 引用内容显示内部路由信息 |

---

## 问题 F1 [Critical]: 图片可能被嵌入错误用户的卡片

### 位置
`src/channel.ts:599-608`

### 问题机制

```typescript
// 当前代码
if (mediaType === "image" && result.mediaId) {
  try {
    const { resolveCardRunByConversation } = await import("./card/card-run-registry");
    const activeRun = resolveCardRunByConversation(
      accountId ?? "default",
      to,  // ← 仅用 accountId + conversationId
    );
    if (activeRun?.controller?.appendImageBlock) {
      await activeRun.controller.appendImageBlock(result.mediaId);
    }
  } catch (bridgeErr: any) {
    // Best-effort: failure to embed in card should not block the send.
  }
}
```

**根本原因：** `resolveCardRunByConversation` 只匹配 `accountId` + `conversationId`，返回**最近注册**的卡片。在群聊中两个用户同时有活跃卡片回复时，一个用户生成的图片会被嵌入到另一个用户的卡片。

**攻击场景：**
1. 群聊中用户 A 发送消息触发卡片生成
2. 紧接着用户 B 发送消息触发另一卡片生成
3. 用户 A 的回复包含图片，`sendMedia` 被调用
4. `resolveCardRunByConversation` 返回用户 B 的卡片（因为最近注册）
5. 图片被嵌入用户 B 的卡片 → **跨用户数据泄露**

### 修复方案

**策略：** 传递期望的卡片 run 标识符，验证匹配后再嵌入。若无法精确匹配则跳过嵌入。

#### Step 1: 扩展 `resolveCardRunByConversation` 支持精确匹配

**文件：** `src/card/card-run-registry.ts`

```typescript
/**
 * Resolve card run with optional owner filtering.
 * Returns null if ownerUserId is specified but doesn't match.
 */
export function resolveCardRunByConversation(
  accountId: string,
  conversationId: string,
  options?: { ownerUserId?: string },
): CardRunRecord | null {
  const lowerCid = conversationId.toLowerCase();
  let latest: CardRunRecord | null = null;
  for (const record of records.values()) {
    if (record.accountId !== accountId) { continue; }
    if (!record.sessionKey.toLowerCase().includes(lowerCid)) { continue; }
    // 新增：如果指定了 ownerUserId，必须精确匹配
    if (options?.ownerUserId && record.ownerUserId !== options.ownerUserId) { continue; }
    if (!latest || record.registeredAt > latest.registeredAt) {
      latest = record;
    }
  }
  return latest;
}
```

#### Step 2: 扩展 `sendMedia` gateway 方法参数

**文件：** `src/channel.ts`

在 `sendMedia` gateway 方法中添加可选的 `expectedCardOwnerId` 参数：

```typescript
// gateway.sendMedia 参数类型扩展
interface SendMediaParams {
  to: string;
  mediaPath: string;
  mediaType: string;
  accountId?: string;
  expectedCardOwnerId?: string;  // ← 新增
}
```

修改嵌入逻辑：

```typescript
if (mediaType === "image" && result.mediaId) {
  try {
    const { resolveCardRunByConversation } = await import("./card/card-run-registry");
    const activeRun = resolveCardRunByConversation(
      accountId ?? "default",
      to,
      { ownerUserId: params.expectedCardOwnerId },  // ← 传递 owner 过滤
    );
    if (activeRun?.controller?.appendImageBlock) {
      await activeRun.controller.appendImageBlock(result.mediaId);
      log?.debug?.(
        `[DingTalk] Embedded uploaded media in card: mediaId=${result.mediaId} ` +
        `card=${activeRun.outTrackId} owner=${activeRun.ownerUserId}`,
      );
    }
  } catch (bridgeErr: any) {
    log?.debug?.(`[DingTalk] Failed to embed media in card: ${bridgeErr.message}`);
  }
}
```

#### Step 3: 在 inbound-handler 中传递 senderId

**文件：** `src/inbound-handler.ts`

在调用 `rt.channel.gateway.sendMedia` 时传递 `senderId`：

```typescript
// 在 deliverMediaAttachments 函数中
const sendResult = await sendMessage(dingtalkConfig, to, "", {
  sessionWebhook,
  mediaPath: actualMediaPath,
  mediaType: outMediaType,
  log,
  accountId,
  storePath: accountStorePath,
  expectedCardOwnerId: senderId,  // ← 新增
});
```

#### Step 4: 更新测试

**文件：** `tests/unit/card-run-registry.test.ts`

```typescript
describe("resolveCardRunByConversation with owner filtering", () => {
  it("returns null when ownerUserId doesn't match", () => {
    registerCardRun("card-A", { accountId: "acc1", sessionKey: "conv1:userA", agentId: "agent1", ownerUserId: "userA" });
    registerCardRun("card-B", { accountId: "acc1", sessionKey: "conv1:userB", agentId: "agent1", ownerUserId: "userB" });

    const result = resolveCardRunByConversation("acc1", "conv1", { ownerUserId: "userA" });
    expect(result?.outTrackId).toBe("card-A");
  });

  it("returns latest match when no ownerUserId specified", () => {
    // 同上，但不传 ownerUserId
    const result = resolveCardRunByConversation("acc1", "conv1");
    expect(result?.outTrackId).toBe("card-B");  // 最近注册的
  });
});
```

---

## 问题 F2 [High]: Abort 路径使用废弃的 finalize API

### 位置
`src/inbound-handler.ts:1363-1368`

### 问题机制

```typescript
// 当前代码 - abort 分支
if (currentAICard && !isCardInTerminalState(currentAICard.state)) {
  try {
    await finishAICard(currentAICard, abortConfirmationText ?? "已停止", log);  // ← 废弃 API
  } catch (cardErr) {
    log?.warn?.(`[DingTalk] Abort card finalize failed: ${getErrorMessage(cardErr)}`);
    currentAICard.state = AICardStatus.FAILED;
  }
}
```

**根本原因：** V2 卡片生命周期使用 `commitAICardBlocks` 进行正常 finalize，但 abort 分支仍调用 `finishAICard`（基于 streaming 的废弃 finalize）。

**影响：**
- `/stop` 操作后卡片可能无法正确离开 PROCESSING 状态
- 用户界面持续显示"处理中..."或停止按钮
- 终态可能未正确持久化到 instances API

### 修复方案

**策略：** Abort 路径使用与正常 finalize 相同的 V2 finalize 机制。

#### Step 1: 替换 `finishAICard` 为 V2 finalize

**文件：** `src/inbound-handler.ts`

```typescript
// 替换当前代码
if (currentAICard && !isCardInTerminalState(currentAICard.state)) {
  try {
    // V2 abort finalize: 创建一个简单的文本块
    const abortBlockList = [{
      type: 2,  // markdown 块
      content: abortConfirmationText ?? "已停止",
    }];
    const blockListJson = JSON.stringify(abortBlockList);

    await commitAICardBlocks(currentAICard, {
      blockListJson,
      content: abortConfirmationText ?? "已停止",
      // abort 时不需要 quoteContent/taskInfo
    }, log);

    log?.debug?.(`[DingTalk] Abort card finalized successfully: card=${currentAICard.cardInstanceId}`);
  } catch (cardErr) {
    log?.warn?.(`[DingTalk] Abort card finalize failed: ${getErrorMessage(cardErr)}`);
    currentAICard.state = AICardStatus.FAILED;
  }
}
```

#### Step 2: 确保 `commitAICardBlocks` 正确处理 abort 场景

**文件：** `src/card-service.ts`

验证 `commitAICardBlocks` 不依赖必须提供的 `quoteContent`/`taskInfoJson`/`quotedRef`：

```typescript
// 当前 commitAICardBlocks 签名
export async function commitAICardBlocks(
  card: AICardInstance,
  options: FinalizeCardOptions,  // quoteContent/taskInfoJson/quotedRef 都是可选的
  log?: Logger,
): Promise<void>
```

当前实现已支持可选参数，无需额外修改。

#### Step 3: 添加 abort finalize 测试

**文件：** `tests/unit/inbound-handler.test.ts` (或 split 文件)

```typescript
it("uses V2 finalize (commitAICardBlocks) for abort path", async () => {
  // 设置 abort 场景
  // 验证 commitAICardBlocks 被调用而非 finishAICard
  // 验证卡片状态正确变为 FINISHED
});
```

---

## 问题 F3 [Medium]: 非图片附件绕过 reply session

### 位置
`src/reply-strategy-card.ts:493-503`

### 问题机制

```typescript
// 当前代码 - finalize 后发送延迟附件
if (pendingNonImageMedia.length > 0) {
  for (const { url, type } of pendingNonImageMedia) {
    const prepared = await prepareMediaInput(url, log);
    const result = await sendProactiveMedia(config, ctx.to, prepared.path, type, {
      log,
      accountId: ctx.accountId,
    });  // ← 绕过 sessionWebhook
  }
}
```

**根本原因：** `sendProactiveMedia` 不使用 `sessionWebhook`，导致：
- 回复消息变为主动发送（proactive send）
- 权限语义变化（某些对话中 session webhook 才有权限）
- 丢失 reply-session 关联信息

### 修复方案

**策略：** 使用 `ctx.sessionWebhook` 发送延迟附件，与正常媒体回复路径一致。

#### Step 1: 替换为 session-based 发送

**文件：** `src/reply-strategy-card.ts`

```typescript
// 替换当前代码
if (pendingNonImageMedia.length > 0) {
  log?.debug?.(`[DingTalk][Card] Sending ${pendingNonImageMedia.length} deferred non-image attachments`);
  for (const { url, type } of pendingNonImageMedia) {
    try {
      const prepared = await prepareMediaInput(url, log);
      const actualMediaPath = prepared.path;

      // 使用 sessionWebhook 发送（与 deliverMediaAttachments 一致）
      if (ctx.sessionWebhook) {
        const sendResult = await sendMessage(config, ctx.to, "", {
          sessionWebhook: ctx.sessionWebhook,
          mediaPath: actualMediaPath,
          mediaType: type,
          log: ctx.log,
          accountId: ctx.accountId,
          storePath: ctx.storePath,
        });
        if (!sendResult.ok) {
          ctx.log?.warn?.(`[DingTalk][Card] Deferred media session send failed: ${sendResult.error || "unknown"}`);
        }
      } else {
        // Fallback: 仅在无 sessionWebhook 时使用 proactive send
        const result = await sendProactiveMedia(config, ctx.to, actualMediaPath, type, {
          log: ctx.log,
          accountId: ctx.accountId,
        });
        if (!result.ok) {
          ctx.log?.warn?.(`[DingTalk][Card] Deferred media proactive send failed: ${result.error || "unknown"}`);
        }
      }

      await prepared.cleanup?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log?.warn?.(`[DingTalk][Card] Failed to send deferred media: ${msg}`);
    }
  }
  pendingNonImageMedia = [];
}
```

#### Step 2: 确保 `sendMessage` 导入

**文件：** `src/reply-strategy-card.ts`

```typescript
import { sendMessage, sendProactiveMedia } from "./send-service";
```

#### Step 3: 添加测试

**文件：** `tests/unit/reply-strategy-card.test.ts`

```typescript
it("sends deferred non-image attachments via sessionWebhook", async () => {
  // 设置有 sessionWebhook 的上下文
  // 触发 voice 类型的延迟附件
  // 验证 sendMessage(sessionWebhook) 被调用
  // 验证 sendProactiveMedia 未被调用
});

it("falls back to proactive send when no sessionWebhook available", async () => {
  // 设置无 sessionWebhook 的上下文
  // 触发延迟附件
  // 验证 sendProactiveMedia 被调用
});
```

---

## 问题 F4 [Medium]: quoteContent 使用重写后的入站文本

### 位置
`src/inbound-handler.ts:729-737`

### 问题机制

```typescript
// 当前代码 - 卡片创建时
const inboundQuoteText = extractedContent.text.trim().slice(0, 200);
const aiCard = await createAICard(dingtalkConfig, to, log, {
  accountId,
  storePath: accountStorePath,
  contextConversationId: groupId,
  hasQuote: inboundQuoteText.length > 0,
  quoteContent: inboundQuoteText,  // ← 使用重写后的文本
});
```

**根本原因：** 在 sub-agent 路由场景下，`extractedContent.text` 在第 445 行被重写：

```typescript
// 第 442-445 行
if (subAgentOptions) {
  const cleanText = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
  const contextHint = `[你被 @ 为"${subAgentOptions.matchedName}"]\n\n`;
  extractedContent.text = contextHint + cleanText;  // ← 重写
}
```

这导致 `quoteContent` 显示内部路由信息如 `[你被 @ 为"子代理名称"]...` 而非用户原始消息。

**注意：** 根据项目 memory，`quoteContent` 的正确语义是**入站消息本身**（标识当前卡片回复的是哪条消息），而非被引用消息的预览。

### 修复方案

**策略：** 在 sub-agent 重写前保存原始入站文本，用于 `quoteContent`。

#### Step 1: 保存原始入站文本

**文件：** `src/inbound-handler.ts`

```typescript
// 在第 442 行之前（sub-agent 重写之前）
const rawInboundText = extractedContent.text.trim();  // ← 保存原始文本

// Add context hint for sub-agent mode...
if (subAgentOptions) {
  const cleanText = extractedContent.text.replace(/^\[引用[^\]]*\]\s*/, "");
  const contextHint = `[你被 @ 为"${subAgentOptions.matchedName}"]\n\n`;
  extractedContent.text = contextHint + cleanText;
}
```

#### Step 2: 使用原始文本创建卡片

**文件：** `src/inbound-handler.ts`

```typescript
// 第 729-737 行
// 使用保存的原始文本而非重写后的文本
const inboundQuoteText = rawInboundText.slice(0, 200);
const aiCard = await createAICard(dingtalkConfig, to, log, {
  accountId,
  storePath: accountStorePath,
  contextConversationId: groupId,
  hasQuote: inboundQuoteText.length > 0,
  quoteContent: inboundQuoteText,  // ← 使用原始文本
});
```

#### Step 3: 添加测试

**文件：** `tests/unit/inbound-handler.test.ts`

```typescript
it("preserves raw inbound text for quoteContent when sub-agent routing is active", async () => {
  // 设置 sub-agent 路由场景
  // 验证 createAICard 的 quoteContent 参数是原始用户消息
  // 不包含 "[你被 @ 为...]" 前缀
});
```

---

## 实施顺序

按严重性排序：

1. **F1 [Critical]** - 跨用户图片嵌入问题
   - 修改 `card-run-registry.ts`（添加 owner 过滤）
   - 修改 `channel.ts`（传递 expectedCardOwnerId）
   - 修改 `inbound-handler.ts`（传递 senderId）
   - 添加测试

2. **F2 [High]** - Abort finalize 路径
   - 修改 `inbound-handler.ts`（替换 finishAICard）
   - 添加测试

3. **F3 [Medium]** - 非图片附件 session 发送
   - 修改 `reply-strategy-card.ts`（使用 sessionWebhook）
   - 添加测试

4. **F4 [Medium]** - quoteContent 原始文本
   - 修改 `inbound-handler.ts`（保存原始文本）
   - 添加测试

5. **验证**
   - `pnpm test`
   - `pnpm run type-check`
   - `pnpm run lint`

---

## 测试验证清单

- [x] F1: `resolveCardRunByConversation` owner 过滤已实现
- [x] F1: `sendMedia` 嵌入已改为仅在提供 expectedCardOwnerId 时执行
- [x] F2: Abort 使用 V2 finalize (commitAICardBlocks) 测试通过
- [x] F3: 非图片附件 sessionWebhook 发送测试通过
- [x] F3: 无 sessionWebhook 时 fallback 到 proactive send
- [x] F4: quoteContent 使用 rawInboundText (重写前保存)
- [x] 所有单元测试通过 (`pnpm test`)
- [x] TypeScript 类型检查通过 (`pnpm run type-check`)
- [x] Lint 检查通过 (`pnpm run lint` - 只有 warnings)

---

## 修复总结

### F1: 图片跨用户嵌入问题

**修改文件：**
- `src/card/card-run-registry.ts` - 扩展 `resolveCardRunByConversation` 支持 `ownerUserId` 过滤
- `src/channel.ts` - 添加 `expectedCardOwnerId` 参数，仅在提供时执行嵌入

**修复策略：** 保守安全策略 - 只有当调用方能提供期望的卡片所有者 ID 时才执行图片嵌入，否则跳过以避免跨用户数据泄露。

### F2: Abort 路径使用废弃 API

**修改文件：**
- `src/inbound-handler.ts` - 替换 `finishAICard` 为 `commitAICardBlocks`
- `tests/unit/inbound-handler-abort.test.ts` - 更新测试期望

**修复策略：** 统一 abort 路径与正常 finalize 路径使用相同的 V2 instances API。

### F3: 非图片附件绕过 reply session

**修改文件：**
- `src/reply-strategy-card.ts` - 使用 `sessionWebhook` + `sendMessage` 发送延迟附件
- `tests/unit/reply-strategy-card.test.ts` - 更新测试期望

**修复策略：** 优先使用 sessionWebhook 发送以保持 reply-session 语义，仅在无 session 时 fallback 到 proactive send。

### F4: quoteContent 使用重写后的入站文本

**修改文件：**
- `src/inbound-handler.ts` - 在 sub-agent 重写前保存 `rawInboundText`

**修复策略：** 保存原始入站文本用于卡片 quoteContent，避免显示内部路由信息如 `[你被 @ 为"..."]`。

---

## 测试验证清单 (原)

- [ ] F1: `resolveCardRunByConversation` owner 过滤测试通过
- [ ] F1: `sendMedia` 嵌入测试通过（验证 owner 匹配）
- [ ] F2: Abort 使用 V2 finalize 测试通过
- [ ] F3: 非图片附件 sessionWebhook 发送测试通过
- [ ] F3: 无 sessionWebhook 时 fallback 测试通过
- [ ] F4: quoteContent 原始文本保留测试通过
- [ ] 所有单元测试通过 (`pnpm test`)
- [ ] TypeScript 类型检查通过 (`pnpm run type-check`)
- [ ] Lint 检查通过 (`pnpm run lint`)

---

## 相关文档

- `docs/plans/2026-04-07-codex-review-fixes.md` - 早期 Codex review P1/P2 修复
- `docs/plans/2026-04-04-fix-card-media-and-quote.md` - 非图片附件降级设计
- `docs/plans/2026-04-04-fix-v2-finalize-chain.md` - Finalize 链路设计
- `memory/feedback_quoteContent-semantics.md` - quoteContent 语义说明

---

## Appendix: Codex Adversarial Review 原始输出

```json
{
  "status": "needs-attention",
  "summary": "No-ship: the AI Card v2 branch still has live paths that can misroute media across concurrent runs, finalize aborts through the deprecated API, and show the wrong quote context. These are user-visible failures, and at least one crosses user boundaries inside the same group conversation.",
  "findings": [
    {
      "title": "Uploaded images can be appended to the wrong user's active card",
      "file": "src/channel.ts",
      "line_start": 599,
      "line_end": 608,
      "confidence": 0.98
    },
    {
      "title": "Abort handling still finalizes V2 cards through the deprecated streaming finalize path",
      "file": "src/inbound-handler.ts",
      "line_start": 1363,
      "line_end": 1368,
      "confidence": 0.95
    },
    {
      "title": "Deferred file/voice/video replies bypass the reply session and fall back to proactive delivery",
      "file": "src/reply-strategy-card.ts",
      "line_start": 493,
      "line_end": 503,
      "confidence": 0.93
    },
    {
      "title": "The card quote header is built from the current prompt, not the quoted message, and can leak sub-agent scaffolding",
      "file": "src/inbound-handler.ts",
      "line_start": 729,
      "line_end": 737,
      "confidence": 0.94
    }
  ]
}
```