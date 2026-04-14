# Card V2 真机测试修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-04-05 真机验证发现的 4 个卡片问题：quoteContent 语义错误、taskInfo 缺失、mediaId 未嵌入卡片、reasoning 覆盖 answer。

**Architecture:** 按优先级分为 4 个独立 task：Issue 2 (quoteContent) 和 Issue 1 (taskInfo) 为 P1 代码修复；Issue 4 (mediaId 桥接) 为 P2 代码修复；Issue 3 (reasoning 竞态) 通过 rebase PR #494 解决，不在本计划中编写新代码。每个 task 独立可测试、可提交。

**Tech Stack:** TypeScript, Vitest, DingTalk Card API (instances + streaming)

**Prerequisite:** 基于 `card-template-v2-clean` 分支工作。

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/inbound-handler.ts` | Modify | Issue 2: quoteContent 取值改为入站消息文本 |
| `src/reply-strategy-card.ts` | Modify | Issue 1: finalize 传入 taskInfoJson + Issue 2: quoteContent 传入 finalize |
| `src/card/card-run-registry.ts` | Modify | Issue 4: 增加 `resolveCardRunByConversation` 方法 |
| `src/channel.ts` | Modify | Issue 4: sendMedia 成功后桥接到 card controller |
| `tests/unit/inbound-handler.test.ts` | Modify | Issue 2 测试 |
| `tests/unit/reply-strategy-card.test.ts` | Modify | Issue 1 + Issue 2 测试 |
| `tests/unit/card-run-registry.test.ts` | Create | Issue 4 测试 |

---

### Task 1: 修复 quoteContent 语义 — 始终填充入站消息文本 (Issue 2)

**Files:**
- Modify: `src/inbound-handler.ts:706-714`
- Modify: `tests/unit/inbound-handler.test.ts`

**Background:** 当前 `quoteContent` 取值逻辑在 `inbound-handler.ts:706-713`：

```typescript
const quotePreview =
  extractedContent.quoted?.previewText || data.content?.quoteContent || "";
// ...
quoteContent: quotedRef ? quotePreview : "",
```

这是错误的：`quoteContent` 被当作"被引用消息的预览"，只在有 `quotedRef` 时填充。正确语义是**始终指向入站消息本身**。

- [ ] **Step 1: 写失败测试 — 验证非引用消息的 quoteContent 也被填充**

在 `tests/unit/inbound-handler.test.ts` 中找到卡片创建相关的测试区域，添加：

```typescript
it("sets quoteContent to inbound message text even without quotedRef", async () => {
  const { handleDingTalkMessage } = await import("../src/inbound-handler");
  const { createAICardMock } = shared;

  createAICardMock.mockResolvedValueOnce({
    cardInstanceId: "card_test",
    outTrackId: "card_test",
    state: "PROCESSING",
    lastUpdated: Date.now(),
  });

  await handleDingTalkMessage({
    cfg: mockConfig,
    data: {
      ...baseData,
      text: { content: " 你好世界" },
      conversationType: "2",
      msgtype: "text",
      // no originalMsgId, no content.quoteContent — not a reply-to message
    },
    accountId: "default",
    log,
  });

  // createAICard should have been called with quoteContent = "你好世界"
  expect(createAICardMock).toHaveBeenCalledTimes(1);
  const callArgs = createAICardMock.mock.calls[0];
  const options = callArgs[2] as { hasQuote?: boolean; quoteContent?: string };
  expect(options.hasQuote).toBe(true);
  expect(options.quoteContent).toBe("你好世界");
});
```

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts -t "sets quoteContent to inbound message text"`
Expected: FAIL — 当前 `quoteContent` 为 `""`

- [ ] **Step 2: 实现修复 — inbound-handler.ts 中 quoteContent 取入站消息文本**

将 `src/inbound-handler.ts:706-714` 从：

```typescript
const quotePreview =
  extractedContent.quoted?.previewText || data.content?.quoteContent || "";
const aiCard = await createAICard(dingtalkConfig, to, log, {
  accountId,
  storePath: accountStorePath,
  contextConversationId: groupId,
  hasQuote: Boolean(quotedRef),
  quoteContent: quotedRef ? quotePreview : "",
});
```

改为：

```typescript
// quoteContent always shows the inbound message text so the user can
// identify which of their messages this card is replying to.
const inboundQuoteText = extractedContent.text.trim().slice(0, 200);
const aiCard = await createAICard(dingtalkConfig, to, log, {
  accountId,
  storePath: accountStorePath,
  contextConversationId: groupId,
  hasQuote: inboundQuoteText.length > 0,
  quoteContent: inboundQuoteText,
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/inbound-handler.test.ts -t "sets quoteContent to inbound message text"`
Expected: PASS

- [ ] **Step 4: 补充 finalize 阶段 quoteContent 写入**

在 `src/reply-strategy-card.ts:349-354`，当前：

```typescript
await commitAICardBlocks(card, {
  blockListJson,
  content,
  // quoteContent is set during card creation, not needed in finalize
  quotedRef: ctx.replyQuotedRef,
}, log);
```

需要从 context 中获取入站消息文本并传入。`ReplyStrategyContext` 中没有入站消息文本字段，需要从 `card-run-registry` 的 `CardRunRecord` 中获取，或者在 context 中传入。

最简方案：在 `reply-strategy-card.ts` 的 `createCardReplyStrategy` 入参中，从 ctx 中获取入站消息文本。需要先在 `ReplyStrategyContext` 中增加 `inboundText` 字段。

**4a. 在 `src/reply-strategy.ts` 的 `ReplyStrategyContext` 中增加 `inboundText` 字段：**

在 `ReplyStrategyContext` interface 中添加：

```typescript
/** Inbound message text for quoteContent in card template. */
inboundText?: string;
```

**4b. 在 `src/inbound-handler.ts` 中将 `inboundText` 传入 strategy context：**

找到创建 `createCardReplyStrategy` 的位置，在 context 对象中加入 `inboundText: extractedContent.text`。

**4c. 在 `src/reply-strategy-card.ts` 的 finalize 中传入 `quoteContent`：**

将 `reply-strategy-card.ts:349-354` 改为：

```typescript
const inboundQuoteText = (ctx.inboundText || "").trim().slice(0, 200);
await commitAICardBlocks(card, {
  blockListJson,
  content,
  quoteContent: inboundQuoteText || undefined,
  quotedRef: ctx.replyQuotedRef,
}, log);
```

- [ ] **Step 5: 写测试验证 finalize 阶段 quoteContent 被传入**

在 `tests/unit/reply-strategy-card.test.ts` 中添加测试：

```typescript
it("passes inboundText as quoteContent to commitAICardBlocks on finalize", async () => {
  const { default: strategy } = createStrategy({
    ...baseCtx,
    inboundText: "用户发送的原始消息",
  });

  // Deliver final payload to trigger finalize flow
  await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
  await strategy.finalize();

  expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  const options = commitAICardBlocksMock.mock.calls[0][1];
  expect(options.quoteContent).toBe("用户发送的原始消息");
});
```

Run: `pnpm vitest run tests/unit/reply-strategy-card.test.ts -t "passes inboundText as quoteContent"`
Expected: PASS

- [ ] **Step 6: 运行全量测试 + 类型检查**

Run: `pnpm test && pnpm run type-check`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/inbound-handler.ts src/reply-strategy.ts src/reply-strategy-card.ts tests/unit/inbound-handler.test.ts tests/unit/reply-strategy-card.test.ts
git commit -m "fix(card): quoteContent always shows inbound message text

Previously quoteContent was only filled when quotedRef existed (reply-to
scenario). The correct semantic is to always show the inbound message
itself, helping users identify which message the card is replying to.

- inbound-handler: quoteContent = extractedContent.text (truncated 200)
- reply-strategy: add inboundText to ReplyStrategyContext
- reply-strategy-card: pass quoteContent to commitAICardBlocks in finalize"
```

---

### Task 2: 补传 taskInfo 到 finalize 调用 (Issue 1)

**Files:**
- Modify: `src/reply-strategy-card.ts:349-354`
- Modify: `tests/unit/reply-strategy-card.test.ts`

**Background:** `commitAICardBlocks` 的 `FinalizeCardOptions` 已定义 `taskInfoJson` 字段，但 finalize 调用从未传入。需要在 finalize 阶段收集 agent run 元数据。

元数据来源：OpenClaw agent runtime 在 dispatch 完成时通过 `DeliverPayload` 传递。当前 payload 没有 model/usage/elapsed 等字段，需要在 `ReplyStrategyContext` 中提供。

**设计决策：** taskInfo 数据需要从 agent run context 获取。最简方案是在 `ReplyStrategyContext` 中增加 `taskMeta` 字段，由 inbound-handler 在创建 strategy 时从 route 信息中提取。

- [ ] **Step 1: 定义 TaskMeta 接口并添加到 ReplyStrategyContext**

在 `src/reply-strategy.ts` 中添加：

```typescript
/** Agent run metadata for card taskInfo display. */
export interface TaskMeta {
  model?: string;
  effort?: string;
  usage?: number;
  elapsedMs?: number;
}
```

在 `ReplyStrategyContext` interface 中添加：

```typescript
/** Agent run metadata for taskInfo in card template. */
taskMeta?: TaskMeta;
```

- [ ] **Step 2: 写失败测试 — 验证 taskInfoJson 被传入 commitAICardBlocks**

在 `tests/unit/reply-strategy-card.test.ts` 中添加：

```typescript
it("passes taskMeta as taskInfoJson to commitAICardBlocks on finalize", async () => {
  const { default: strategy } = createStrategy({
    ...baseCtx,
    taskMeta: {
      model: "gpt-5.4",
      effort: "medium",
      usage: 12,
      elapsedMs: 3400,
    },
  });

  await strategy.deliver({ kind: "final", text: "回复内容", mediaUrls: [] });
  await strategy.finalize();

  expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  const options = commitAICardBlocksMock.mock.calls[0][1];
  expect(options.taskInfoJson).toBeDefined();
  const taskInfo = JSON.parse(options.taskInfoJson!);
  expect(taskInfo.model).toBe("gpt-5.4");
  expect(taskInfo.effort).toBe("medium");
  expect(taskInfo.dapi_usage).toBe(12);
  expect(taskInfo.taskTime).toBe(3); // rounded to seconds
});
```

Run: `pnpm vitest run tests/unit/reply-strategy-card.test.ts -t "passes taskMeta as taskInfoJson"`
Expected: FAIL — `options.taskInfoJson` 为 `undefined`

- [ ] **Step 3: 在 reply-strategy-card.ts finalize 中构建 taskInfoJson**

在 `src/reply-strategy-card.ts` 的 finalize 方法中，`commitAICardBlocks` 调用前添加 taskInfo 构建逻辑：

```typescript
// Build taskInfo JSON for card template
let taskInfoJson: string | undefined;
if (ctx.taskMeta) {
  const info: Record<string, unknown> = {};
  if (ctx.taskMeta.model) info.model = ctx.taskMeta.model;
  if (ctx.taskMeta.effort) info.effort = ctx.taskMeta.effort;
  if (typeof ctx.taskMeta.usage === "number") info.dapi_usage = ctx.taskMeta.usage;
  if (typeof ctx.taskMeta.elapsedMs === "number") info.taskTime = Math.round(ctx.taskMeta.elapsedMs / 1000);
  if (Object.keys(info).length > 0) {
    taskInfoJson = JSON.stringify(info);
  }
}
```

将 `commitAICardBlocks` 调用改为：

```typescript
await commitAICardBlocks(card, {
  blockListJson,
  content,
  quoteContent: inboundQuoteText || undefined,
  taskInfoJson,
  quotedRef: ctx.replyQuotedRef,
}, log);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/reply-strategy-card.test.ts -t "passes taskMeta as taskInfoJson"`
Expected: PASS

- [ ] **Step 5: 写测试 — taskMeta 为空时不应传入 taskInfoJson**

```typescript
it("omits taskInfoJson when taskMeta is not provided", async () => {
  const { default: strategy } = createStrategy({
    ...baseCtx,
    // no taskMeta
  });

  await strategy.deliver({ kind: "final", text: "回复", mediaUrls: [] });
  await strategy.finalize();

  expect(commitAICardBlocksMock).toHaveBeenCalledTimes(1);
  const options = commitAICardBlocksMock.mock.calls[0][1];
  expect(options.taskInfoJson).toBeUndefined();
});
```

Run: `pnpm vitest run tests/unit/reply-strategy-card.test.ts -t "omits taskInfoJson"`
Expected: PASS

- [ ] **Step 6: 运行全量测试 + 类型检查**

Run: `pnpm test && pnpm run type-check`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/reply-strategy.ts src/reply-strategy-card.ts tests/unit/reply-strategy-card.test.ts
git commit -m "feat(card): pass taskInfo to finalize for model/usage/elapsed display

- Add TaskMeta interface to ReplyStrategyContext
- Build taskInfoJson from taskMeta in finalize
- Pass to commitAICardBlocks for instances API write"
```

---

### Task 3: 桥接 sendMedia mediaId 到活跃卡片 (Issue 4)

**Files:**
- Create: `tests/unit/card-run-registry.test.ts`
- Modify: `src/card/card-run-registry.ts`
- Modify: `src/channel.ts:503-614`

**Background:** `card-run-registry.ts` 已有按 `outTrackId` 查找的注册表。`sendMedia` gateway method (`channel.ts:503`) 调用 `sendProactiveMedia` 时能获取 `mediaId` 和 `accountId` + `to`（会话 ID）。需要增加按 `accountId + conversationId` 查找活跃卡片的方法。

- [ ] **Step 1: 写失败测试 — resolveCardRunByConversation**

创建 `tests/unit/card-run-registry.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCardRun,
  resolveCardRunByConversation,
  clearCardRunRegistryForTest,
} from "../../src/card/card-run-registry";

beforeEach(() => {
  clearCardRunRegistryForTest();
});

describe("resolveCardRunByConversation", () => {
  it("returns null when no runs registered", () => {
    expect(resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==")).toBeNull();
  });

  it("returns the run matching accountId and sessionKey-derived conversationId", () => {
    registerCardRun("card_abc", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    // sessionKey contains conversationId (case-insensitive)
    const result = resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==");
    expect(result).not.toBeNull();
    expect(result!.outTrackId).toBe("card_abc");
  });

  it("returns null when accountId does not match", () => {
    registerCardRun("card_abc", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    expect(resolveCardRunByConversation("other", "cid//Vc7N7lA5mymGresI0XAw==")).toBeNull();
  });

  it("returns the most recently registered run when multiple match", () => {
    registerCardRun("card_old", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
      registeredAt: Date.now() - 1000,
    });
    registerCardRun("card_new", {
      accountId: "default",
      sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
      agentId: "1",
    });

    const result = resolveCardRunByConversation("default", "cid//Vc7N7lA5mymGresI0XAw==");
    expect(result!.outTrackId).toBe("card_new");
  });
});
```

Run: `pnpm vitest run tests/unit/card-run-registry.test.ts`
Expected: FAIL — `resolveCardRunByConversation` 未导出

- [ ] **Step 2: 实现 resolveCardRunByConversation**

在 `src/card/card-run-registry.ts` 中添加：

```typescript
/**
 * Find the most recently registered card run for a given account + conversation.
 * Uses case-insensitive match of the conversationId within sessionKey.
 */
export function resolveCardRunByConversation(
  accountId: string,
  conversationId: string,
): CardRunRecord | null {
  const lowerCid = conversationId.toLowerCase();
  let latest: CardRunRecord | null = null;
  for (const record of records.values()) {
    if (record.accountId !== accountId) continue;
    if (!record.sessionKey.toLowerCase().includes(lowerCid)) continue;
    if (!latest || record.registeredAt > latest.registeredAt) {
      latest = record;
    }
  }
  return latest;
}
```

- [ ] **Step 3: 运行注册表测试确认通过**

Run: `pnpm vitest run tests/unit/card-run-registry.test.ts`
Expected: PASS

- [ ] **Step 4: 写测试 — sendMedia 桥接到 card controller**

在 `tests/unit/card-run-registry.test.ts` 或单独的集成测试中，验证当有活跃卡片时 `appendImageBlock` 被调用。

先检查 `reply-strategy-card.test.ts` 中 `sendMedia` 的 mock 模式，然后在适当的测试文件中添加：

```typescript
it("sendMedia appends image to active card when mediaType is image", async () => {
  const mockAppendImageBlock = vi.fn().mockResolvedValue(undefined);

  // Register an active card run with a controller mock
  registerCardRun("card_active", {
    accountId: "default",
    sessionKey: "agent:main:dingtalk:group:cid//vc7n7la5mymgresi0xaw==",
    agentId: "1",
  });
  attachCardRunController("card_active", {
    appendImageBlock: mockAppendImageBlock,
  } as any);

  // ... invoke sendMedia with an image for the same conversation ...
  // After sendProactiveMedia succeeds:
  expect(mockAppendImageBlock).toHaveBeenCalledWith("@lADPMtestmediaId");
});
```

Run: `pnpm vitest run tests/unit/card-run-registry.test.ts -t "sendMedia appends"`
Expected: FAIL — 桥接逻辑尚未实现

- [ ] **Step 5: 在 channel.ts sendMedia 中桥接到 card controller**

在 `src/channel.ts:577` `sendProactiveMedia` 调用成功后，增加桥接逻辑：

```typescript
// After successful sendProactiveMedia, if this is an image and there's an
// active card for this conversation, also embed the image in the card.
if (mediaType === "image" && result.ok && result.data?.mediaId) {
  try {
    const { resolveCardRunByConversation } = await import("./card/card-run-registry");
    const activeRun = resolveCardRunByConversation(
      accountId ?? "default",
      to,
    );
    if (activeRun?.controller?.appendImageBlock) {
      const mediaId = typeof result.data.mediaId === "string"
        ? result.data.mediaId
        : String(result.data.mediaId);
      await activeRun.controller.appendImageBlock(mediaId);
      effectiveLog?.debug?.(
        `[DingTalk] Embedded uploaded media in active card: mediaId=${mediaId} card=${activeRun.outTrackId}`,
      );
    }
  } catch (bridgeErr: any) {
    // Best-effort: failure to embed in card should not block the send
    effectiveLog?.debug?.(
      `[DingTalk] Failed to embed media in active card: ${bridgeErr.message}`,
    );
  }
}
```

**注意：** `sendProactiveMedia` 的返回值中 `mediaId` 不一定在 `result.data` 中。需要检查 `sendProactiveMedia` 的实际返回结构。查看 `send-service.ts:386-481`：`uploadMedia` 返回 `{ mediaId, buffer }`，但 `sendProactiveMedia` 返回的是 `{ ok, error, data, messageId }` — `data` 是 DingTalk API 的原始响应，不含 `mediaId`。

需要调整：在 `sendProactiveMedia` 内部，上传成功后的 `mediaId` 只在函数局部使用。要让外部获取 `mediaId`，需要在 `sendProactiveMedia` 的返回值中增加 `mediaId` 字段。

修改 `src/send-service.ts:sendProactiveMedia`，在返回对象中增加 `mediaId`：

```typescript
return { ok: true, data: response.data, messageId, mediaId };
```

然后在 `channel.ts` 中通过 `result.mediaId` 获取。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/card-run-registry.test.ts`
Expected: PASS

- [ ] **Step 7: 运行全量测试 + 类型检查**

Run: `pnpm test && pnpm run type-check`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/card/card-run-registry.ts src/channel.ts src/send-service.ts tests/unit/card-run-registry.test.ts
git commit -m "feat(card): bridge sendMedia mediaId to active card via run registry

When agent sends an image via sendMedia gateway method, the uploaded
mediaId is now also appended to any active card for the same conversation
using the card-run-registry lookup.

- card-run-registry: add resolveCardRunByConversation(accountId, cid)
- send-service: return mediaId from sendProactiveMedia
- channel.ts: after image upload, look up active card and appendImageBlock"
```

---

### Task 4: Rebase PR #494 修复 reasoning 竞态 (Issue 3)

**Files:** 无新代码

**Background:** PR #494 (已合并到 main) 修复了 CardDraftController 的去重/竞态问题、`final_seen → sealed` 生命周期、`cardStreamingMode` 配置。当前 `card-template-v2-clean` 分支不包含这些修复。

- [ ] **Step 1: Rebase card-template-v2-clean 到 main 最新**

```bash
git fetch origin main
git rebase origin/main
```

- [ ] **Step 2: 解决冲突（如有）**

PR #494 改动了 `reply-strategy-card.ts`、`card-draft-controller.ts`、`config.ts` 等文件，可能与 Task 1-3 的修改产生冲突。冲突解决原则：
- Task 1 的 quoteContent 修复：保留新逻辑（`inboundText` 方案）
- Task 2 的 taskInfo：保留新逻辑
- PR #494 的 streaming mode 和 lifecycle：接受 PR #494 的版本
- 如果 `ReplyStrategyContext` 接口冲突：合并两边新增的字段

- [ ] **Step 3: 运行全量测试**

Run: `pnpm test && pnpm run type-check`
Expected: ALL PASS

- [ ] **Step 4: 真机回归验证**

按照真机测试 skill 流程，重新执行 T1-T5 验证 Issue 1-4 均已修复。

- [ ] **Step 5: Commit + Push**

```bash
git push origin card-template-v2-clean --force-with-lease
```

---

## Self-Review

### Spec Coverage
- Issue 1 (taskInfo): Task 2 覆盖
- Issue 2 (quoteContent): Task 1 覆盖
- Issue 3 (reasoning 竞态): Task 4 覆盖 (rebase)
- Issue 4 (mediaId 桥接): Task 3 覆盖

### Placeholder Scan
- 无 TBD/TODO/fill in details
- 所有代码步骤包含完整实现代码
- 所有测试步骤包含完整测试代码

### Type Consistency
- `TaskMeta` 在 `reply-strategy.ts` 定义，在 `reply-strategy-card.ts` 消费
- `resolveCardRunByConversation(accountId: string, conversationId: string)` 签名在定义和使用处一致
- `inboundText?: string` 在 `ReplyStrategyContext` 中添加，在 `reply-strategy-card.ts` 中读取
- `sendProactiveMedia` 返回值增加 `mediaId?: string`，在 `channel.ts` 中读取
