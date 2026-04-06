# Fix Plan: Codex Review 问题修复

**日期：** 2026-04-07
**优先级：** P1 + P2
**状态：** 待实施
**关联：** Codex Review against main branch

---

## 问题概览

| 优先级 | 问题 | 类型 | 影响 |
|--------|------|------|------|
| P1 | 非图片附件在 Card 模式下被静默丢弃 | 设计偏离 | 用户收不到 file/voice/video |
| P2 | 新 instances API 路径不刷新过期 token | 设计遗漏 | 长对话卡片更新失败 |
| P2 | Fallback 可能发送原始 blockList JSON | 设计偏离 | 用户看到 `[{"type":2,...}]` |

---

## 问题 1 [P1]：非图片附件被静默丢弃

### 位置
- `src/reply-strategy-card.ts:279-282`

### 当前代码

```typescript
if (mediaType !== "image") {
  log?.debug?.(`[DingTalk][Card] Skipping non-image media (${mediaType}) for card embedding: ${url}`);
  await prepared.cleanup?.();
  continue;  // ← 静默丢弃
}
```

### 设计预期
参见 `docs/plans/2026-04-04-fix-card-media-and-quote.md`：

| 附件类型 | 处理方式 |
|----------|----------|
| image | 嵌入卡片 (type=3 块) |
| voice | 卡片外单独发送 |
| video | 卡片外单独发送 |
| file | 卡片外单独发送 |

### 修复方案

**文件：** `src/reply-strategy-card.ts`

**Step 1:** 在 deliver final/block 函数顶部声明非图片附件收集数组

```typescript
// 在 deliverReplyViaCardStream() 函数顶部添加
let pendingNonImageMedia: { url: string; type: string }[] = [];
```

**Step 2:** 修改 media 处理循环 (两处：final 和 block)

```typescript
// 替换 continue 为收集
if (mediaType !== "image") {
  log?.debug?.(`[DingTalk][Card] Deferring non-image media (${mediaType}) for out-of-card delivery: ${url}`);
  pendingNonImageMedia.push({ url, type: mediaType });
  await prepared.cleanup?.();
  continue;
}
```

**Step 3:** 在 finalize 阶段发送非图片附件

在 `finalize()` 函数的 `commitAICardBlocks()` 调用之后添加：

```typescript
// 在 commitAICardBlocks() 成功后
if (pendingNonImageMedia.length > 0) {
  log?.debug?.(`[DingTalk][Card] Sending ${pendingNonImageMedia.length} deferred non-image attachments`);
  for (const { url, type } of pendingNonImageMedia) {
    try {
      const prepared = await prepareMediaInput(url, log);
      const result = await uploadMedia(config, prepared.path, type, log);
      await prepared.cleanup?.();
      if (result?.mediaId) {
        await sendProactiveMedia(config, to, result.mediaId, type, {
          sessionWebhook,
          log,
          accountId,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn?.(`[DingTalk][Card] Failed to send deferred media: ${msg}`);
    }
  }
  pendingNonImageMedia = [];  // 清空
}
```

**Step 4:** 添加测试用例

在 `tests/unit/reply-strategy-card.test.ts` 添加：

```typescript
it("defers non-image attachments and sends them after card finalize", async () => {
  // 设置 voice 类型的 mediaUrls
  // 验证 card finalize 后调用了 sendProactiveMedia
});
```

---

## 问题 2 [P2]：instances API 路径不刷新过期 token

### 位置
- `src/card-service.ts:867-872` (`updateAICardBlockList`)
- `src/card-service.ts:977` (`commitAICardBlocks`)

### 当前代码

```typescript
// updateAICardBlockList() 直接使用 card.accessToken
await updateCardVariables(
  card.outTrackId || card.cardInstanceId,
  params,
  card.accessToken,  // ← 不刷新
  card.config,
);
```

### 参考实现
`putAICardStreamingField()` (lines 223-243) 已有 token 刷新逻辑：

```typescript
const tokenAge = Date.now() - card.createdAt;
const tokenRefreshThreshold = 90 * 60 * 1000;

if (tokenAge > tokenRefreshThreshold && card.config) {
  log?.debug?.("[DingTalk][AICard] Token age exceeds threshold, refreshing...");
  try {
    card.accessToken = await getAccessToken(card.config, log);
    log?.debug?.("[DingTalk][AICard] Token refreshed successfully");
  } catch (err: any) {
    log?.warn?.(`[DingTalk][AICard] Failed to refresh token: ${err.message}`);
  }
}
```

### 修复方案

**文件：** `src/card-service.ts`

**Step 1:** 提取 token 刷新逻辑为辅助函数

```typescript
/**
 * Ensure card access token is fresh (refresh if >90min old).
 * Mutates card.accessToken in place if refreshed.
 */
async function ensureFreshToken(card: AICardInstance, log?: Logger): Promise<void> {
  const tokenAge = Date.now() - card.createdAt;
  const tokenRefreshThreshold = 90 * 60 * 1000;

  if (tokenAge > tokenRefreshThreshold && card.config) {
    log?.debug?.("[DingTalk][AICard] Token age exceeds threshold, refreshing...");
    try {
      card.accessToken = await getAccessToken(card.config, log);
      log?.debug?.("[DingTalk][AICard] Token refreshed successfully");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn?.(`[DingTalk][AICard] Failed to refresh token: ${msg}`);
    }
  }
}
```

**Step 2:** 在 `updateAICardBlockList()` 调用前刷新

```typescript
export async function updateAICardBlockList(
  card: AICardInstance,
  blockList: CardBlock[],
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }

  await ensureFreshToken(card, log);  // ← 添加

  const blockListJson = JSON.stringify(blockList);
  // ... rest of function
}
```

**Step 3:** 在 `commitAICardBlocks()` 调用前刷新

```typescript
export async function commitAICardBlocks(
  card: AICardInstance,
  options: FinalizeCardOptions,
  log?: Logger,
): Promise<void> {
  if (isCardInTerminalState(card.state)) {
    return;
  }

  await ensureFreshToken(card, log);  // ← 添加

  // ... rest of function
}
```

**Step 4:** 可选 - 添加 401 重试逻辑

```typescript
// 在 updateCardVariables 调用处添加 try-catch
try {
  await updateCardVariables(...);
} catch (err: unknown) {
  // 如果是 401，尝试刷新 token 后重试一次
  if (isAxiosError(err) && err.response?.status === 401) {
    log?.warn?.("[DingTalk][AICard] Got 401, refreshing token and retrying...");
    card.accessToken = await getAccessToken(card.config, log);
    await updateCardVariables(...);  // 重试
  } else {
    throw err;
  }
}
```

**Step 5:** 更新测试

在 `tests/unit/card-service.test.ts` 添加：

```typescript
it("refreshes token before updateAICardBlockList when token is old", async () => {
  // 设置 card.createdAt 为 100 分钟前
  // 验证 getAccessToken 被调用
});

it("refreshes token before commitAICardBlocks when token is old", async () => {
  // 同上
});
```

---

## 问题 3 [P2]：Fallback 发送 blockList JSON

### 位置
- `src/reply-strategy-card.ts:400-403`

### 当前代码

```typescript
const fallbackText = getRenderedTimeline({ preferFinalAnswer: true })
  || controller.getLastAnswerContent()
  || controller.getLastContent()        // ← 可能是 JSON
  || card.lastStreamedContent;          // ← 可能是 JSON
```

### 问题分析

| 来源 | 返回值 | 风险 |
|------|--------|------|
| `getRenderedTimeline()` | markdown | ✅ 安全 |
| `getLastAnswerContent()` | 纯文本 | ✅ 安全 |
| `getLastContent()` | 最后发送的内容 | ⚠️ 可能是 JSON |
| `card.lastStreamedContent` | blockList JSON | ❌ JSON |

当卡片在只有 thinking/tool 块时失败，`getLastAnswerContent()` 为空，会 fallback 到 JSON。

### 修复方案

**文件：** `src/reply-strategy-card.ts`

**方案 A：移除 JSON 来源（推荐）**

```typescript
const fallbackText = getRenderedTimeline({ preferFinalAnswer: true })
  || controller.getLastAnswerContent()
  || DEFAULT_FALLBACK_MESSAGE;

// 在文件顶部定义
const DEFAULT_FALLBACK_MESSAGE = "回复生成失败，请重试";
```

**方案 B：检测并跳过 JSON**

```typescript
const fallbackText = getRenderedTimeline({ preferFinalAnswer: true })
  || controller.getLastAnswerContent()
  || (() => {
      const lastContent = controller.getLastContent();
      // 如果看起来像 JSON，不使用
      if (lastContent && !lastContent.startsWith("[")) {
        return lastContent;
      }
      return "回复生成失败";
    })();
```

**Step 2:** 更新测试

在 `tests/unit/reply-strategy-card.test.ts` 添加：

```typescript
it("sends user-friendly fallback message when card fails without answer content", async () => {
  // 设置 card 状态为 FAILED
  // 不设置任何 answer 内容
  // 验证 sendMessage 被调用且内容不是 JSON
});
```

---

## 实施顺序

1. **P1: 非图片附件修复** (问题 1)
   - 修改 `reply-strategy-card.ts`
   - 添加测试
   - 验证功能

2. **P2: Token 刷新** (问题 2)
   - 修改 `card-service.ts`
   - 添加测试
   - 验证功能

3. **P2: Fallback JSON** (问题 3)
   - 修改 `reply-strategy-card.ts`
   - 添加测试
   - 验证功能

4. **最终验证**
   - 运行 `pnpm test`
   - 运行 `pnpm run type-check`
   - 运行 `pnpm run lint`

---

## 测试验证清单

- [ ] 问题 1: 非图片附件测试通过
- [ ] 问题 2: Token 刷新测试通过
- [ ] 问题 3: Fallback 测试通过
- [ ] 所有单元测试通过 (`pnpm test`)
- [ ] TypeScript 类型检查通过 (`pnpm run type-check`)
- [ ] Lint 检查通过 (`pnpm run lint`)

---

## 相关文档

- `docs/plans/2026-04-04-fix-card-media-and-quote.md` - 非图片附件降级设计
- `docs/plans/2026-04-04-fix-v2-finalize-chain.md` - Finalize 链路设计
- `docs/plans/2026-04-04-fix-get-rendered-content-markdown.md` - Markdown fallback 设计