# 完整分析：为何 `/reasoning on` + `disableBlockStreaming=false` 下 DingTalk card 拿不到 answer

## 一、数据流总图

下面把三个频道的链路并排列出：

```text
上游 pi-embedded-subscribe (subscribeEmbeddedPiSession)
  ↓
handleMessageEnd / text_delta 事件
  ↓ 决策点：assistantTexts 的填充方式
  ↓
buildEmbeddedRunPayloads
  ↓
decide: answerTexts = rawAnswerSources? || fallbackAnswerText
  ↓
dispatchReplyWithBufferedBlockDispatcher
  ↓
deliver(payload, { kind: "block" | "final" })
  ↓
各频道 deliver 回调
```

---

## 二、三个频道的关键差异

### Telegram（`/reasoning on`，正常）

关键代码（`bot-message-dispatch.ts:384-392`）：

```ts
const disableBlockStreaming = !previewStreamingEnabled
  ? true
  : forceBlockStreamingForReasoning
    ? false
    : ...
```

所以 Telegram 在 `/reasoning on` 时：

- `disableBlockStreaming = false` ✔
- `forceBlockStreamingForReasoning = true`
- `canStreamAnswerDraft = false`（因为 `forceBlockStreaming` 阻止了 draft 流）

传给 `subscribeEmbeddedPiSession` 的 `replyOptions.disableBlockStreaming = false`，意味着上游会调用 `onBlockReply`。

在 `pi-embedded-subscribe.ts:52`：

```ts
shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
```

Telegram 传了 `onBlockReply`（通过 `dispatchReplyWithBufferedBlockDispatcher`），所以 `shouldEmitPartialReplies = true`。

这导致 `text_delta` 流中 `onPartialReply` 被调用，但 Telegram 已把 `canStreamAnswerDraft=false`，draft 流不更新。最重要的是，`assistantTexts` 通过 `emitBlockChunk -> pushAssistantText` 被填充了。

然后在 `buildEmbeddedRunPayloads`（`payloads.ts:288-297`）：

```ts
const answerTexts = rawAnswerSources.length
  ? needsFallbackAppend
    ? [...rawAnswerSources, fallbackAnswerText]
    : rawAnswerSources
  : fallbackAnswerText ? [fallbackAnswerText] : [];
```

`assistantTexts` 里有 block reply 内容，`answer` 能到达 `deliver(final)`。

### Feishu（正常）

`reply-dispatcher.ts:482`：

```ts
disableBlockStreaming: true,
```

`disableBlockStreaming=true`，上游不调用 `onBlockReply`。

`pi-embedded-subscribe.ts:52`：

```ts
shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
// true && true -> false -> shouldEmitPartialReplies = false
```

`shouldEmitPartialReplies=false`，`text_delta` 不调用 `onPartialReply`。

但 `assistantTexts` 不会被 block chunks 填充，所以 `buildEmbeddedRunPayloads` 走 fallback 分支：

```ts
rawAnswerSources.length === 0
  ? fallbackAnswerText ? [fallbackAnswerText] : []
```

直接用 `lastAssistant.text` 作为 fallback，`answer` 正常到达。

此外 Feishu 的 streaming card 在 `deliver(final)` 里：

```ts
if (info?.kind === "final" && streamingEnabled && useCard) {
  streamText = mergeStreamingText(streamText, text);
  await closeStreaming();
}
```

即使 `text` 来自 fallback，也能正确展示。

---

## 三、DingTalk Card 为何出问题

DingTalk card strategy（`reply-strategy-card.ts:78`）：

```ts
getReplyOptions(): ReplyOptions {
  return {
    disableBlockStreaming: true,
    ...
  }
}
```

表面上和 Feishu 一样写死 `true`，但现在的 `inbound-handler.ts` 在 markdown 模式下走的是：

```ts
disableBlockStreaming: shouldDisableMarkdownBlockStreaming({...})
// -> 在 reasoning on 时返回 true
```

但 card 模式另有一条路径：

```ts
const strategy = createReplyStrategy({
  ...
  disableBlockStreaming: shouldDisableMarkdownBlockStreaming({
    messageType: dingtalkConfig.messageType,
    ...
  }),
  ...
})
```

`shouldDisableMarkdownBlockStreaming` 第一行：

```ts
if (params.messageType !== "markdown") {
  return false;
}
```

所以 `createReplyStrategy` 传给卡片策略的 `disableBlockStreaming=false`，但卡片策略 `getReplyOptions()` 里完全忽略了这个入参，写死返回 `disableBlockStreaming: true`。

这就是矛盾所在：`inbound-handler.ts` 里传的 `disableBlockStreaming` 参数被卡片策略的 `getReplyOptions()` 覆盖了。

更严重的问题在于上游这条链路。

### 真正的 Answer 丢失机制

当 card 模式 + `/reasoning on` 时，`replyOptions.disableBlockStreaming=true` 传给上游。上游的 `subscribeEmbeddedPiSession` 中：

```ts
shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply)
// 因为 disableBlockStreaming=true -> onBlockReply 不会被注册
// -> !(true && true) = false -> shouldEmitPartialReplies = false
```

`text_delta` 流不会调用 `onPartialReply`，同时也不会通过 `emitBlockChunk` 填充 `assistantTexts`。

然后 `handleMessageEnd`（`handlers.messages.ts:424-430`）：

```ts
const addedDuringMessage = ctx.state.assistantTexts.length > ctx.state.assistantTextBaseline;
ctx.finalizeAssistantTexts({
  text: finalAssistantText,
  addedDuringMessage,
  chunkerHasBuffered,
});
```

`finalizeAssistantTexts`（`pi-embedded-subscribe.ts:190-215`）：

```ts
finalizeAssistantTexts({ text, addedDuringMessage, chunkerHasBuffered }) {
  if (state.includeReasoning && text && !params.onBlockReply) {
    // reasoning on + 没有 onBlockReply -> 强制插入 text
    ...pushAssistantText(text);
  } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
    // 没有 block reply 也没有 chunker -> 插入 fallback
    pushAssistantText(text);
  }
  // 否则什么都不做
}
```

Card 模式下：

- `state.includeReasoning = true`（`reasoningMode=on`）
- `text =` 最终 assistant text（存在）
- `!params.onBlockReply`：这是关键。上游收到的 `onBlockReply` 是否为 `undefined`，取决于 `disableBlockStreaming`

让我确认这条路径：

> Searched for 2 patterns, read 1 file (ctrl+o to expand)

现在找到了最终的联接点。看 `get-reply-directives.ts` 的 `onBlockReply` 注册：

> Searched for 2 patterns (ctrl+o to expand)

现在我有完整的证据链了。

---

## 完整根因分析

### 整条链路（`/reasoning on` + card 模式）

#### 第一条死路：`blockStreamingEnabled` 控制 `onBlockReply` 的注册

`agent-runner.ts:171`：

```ts
const blockReplyPipeline =
  blockStreamingEnabled && opts?.onBlockReply
    ? createBlockReplyPipeline({ onBlockReply: opts.onBlockReply, ... })
    : undefined;
```

`blockStreamingEnabled`（`get-reply-directives.ts:418-419`）：

```ts
const blockStreamingEnabled =
  resolvedBlockStreaming === "on" && opts?.disableBlockStreaming !== true;
```

DingTalk card strategy 的 `getReplyOptions()` 返回 `disableBlockStreaming: true`，因此：

- `blockStreamingEnabled = false`
- `blockReplyPipeline = undefined`
- 上游 `subscribeEmbeddedPiSession` 收到的 `params.onBlockReply = undefined`

#### 第二条死路：`shouldEmitPartialReplies` 被关掉

`pi-embedded-subscribe.ts:52`：

```ts
shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply)
// true && true -> false
```

`params.onBlockReply` 为 `undefined`，所以 `shouldEmitPartialReplies = false`。`text_delta` 流中不调用 `onPartialReply`，`assistantTexts` 通过 block 路径完全不填充。

#### 第三条死路：`finalizeAssistantTexts` 的条件判断

`pi-embedded-subscribe.ts:199-215`：

```ts
if (state.includeReasoning && text && !params.onBlockReply) {
  // 条件：reasoningMode=on + 有 text + 没有 onBlockReply -> 本应强制写入
  pushAssistantText(text);
} else if (!addedDuringMessage && !chunkerHasBuffered && text) {
  // fallback 条件
  pushAssistantText(text);
}
```

表面上看第一个分支应该命中：`includeReasoning=true`、`text` 有值、`onBlockReply=undefined`，`text` 应该被 push 进去。

但问题在 `buildEmbeddedRunPayloads` 的后半段（`payloads.ts:254-287`）：

```ts
const needsFallbackAppend =
  !suppressAssistantArtifacts &&
  rawAnswerSources.length > 0 &&
  params.reasoningLevel === "on" &&
  Boolean(normalizedFallback) &&
  !fallbackAlreadyCovered;
```

DingTalk card 模式的真正问题不是 `finalizeAssistantTexts` 失败，而是 `reasoningText` 会被 push 到 `assistantTexts` 中（通过 `emitBlockChunk` / `handleMessageEnd` 的 `emitBlockReplySafely`），但由于 `onBlockReply=undefined`，`emitBlockReplySafely` 直接返回，reasoning 文本进入了 `assistantTexts`，但 answer 文本没有。

具体时序：

1. `handleMessageEnd` 被触发。
2. `finalizeAssistantTexts`: `includeReasoning=true`、`onBlockReply=undefined` -> `pushAssistantText(finalText)` ✔
3. `shouldEmitReasoningBeforeAnswer`: `includeReasoning=true`、`onBlockReply` 存在？ -> `false`，不 emit reasoning。
4. 实际上 `assistantTexts = [finalAnswerText]`。
5. `buildEmbeddedRunPayloads`：
   - `reasoningText = formatReasoningMessage(lastAssistant.thinking)` -> push `isReasoning=true`
   - `answerTexts = rawAnswerSources (= [finalAnswerText])` -> push `isReasoning=false`
6. `replyItems` 顺序：`[reasoning, answer]`
7. `dispatchReplyWithBufferedBlockDispatcher` -> `deliver(reasoning, "block")`，`deliver(answer, "final")`

顺序错了。`deliver` 的时序是 reasoning 先（block）、answer 后（final），但 card strategy 的 `deliver()` 处理：

```ts
if (payload.kind === "final") {
  // answer 放在 finalTextForFallback，等 finalize 用
  finalTextForFallback = rawFinalText;
  return;
}

if (payload.kind === "block") {
  // reasoning 立即追加到 card thinking 区
  await appendAssembledThinkingBlocks(blocks);
}
```

`finalize()` 的顺序是：先 `controller.finalize()`，再用 `finalTextForFallback`。但此时 thinking block 已经是 card timeline 的第一个元素，而 `getFinalText()` 尝试从 `controller.getLastAnswerContent()` 取。

如果 `onPartialReply` 没有更新 answer（因为 `shouldEmitPartialReplies=false`，实时流路径断掉），`controller.getLastAnswerContent()` 为空或旧值，导致最终 card timeline 显示：

```text
[think block]   <- reasoning 先到
[answer]        <- 来自 finalTextForFallback（顺序不对或内容丢失）
```

### 对比总结

| 频道 | `disableBlockStreaming` | `onBlockReply` 注册 | `shouldEmitPartialReplies` | `assistantTexts` 填充方式 | `answer` 来源 |
| --- | --- | --- | --- | --- | --- |
| Telegram `/reasoning on` | `false` | ✔ 注册 | `true` | block chunks 填充 | `rawAnswerSources` |
| Feishu `/reasoning on` | `true` | ✗ 未注册 | `false` | 不填充 | `fallbackAnswerText`（`lastAssistant.text`） |
| DingTalk card `/reasoning on` | `true` | ✗ 未注册 | `false` | `finalizeAssistantTexts` 强制写入一次 | `rawAnswerSources = [finalText]` ✔ |

DingTalk 的 answer 文本确实进入了 `rawAnswerSources`，但顺序问题在 card strategy 的 `deliver` 层：reasoning 通过 `onBlockReply` 的 block deliver 实时追加到 card，而 answer 通过 `kind=final` deliver 被存为 `finalTextForFallback`，等待 `finalize()`。这个 `finalize` 路径在 `getFinalText()` 无法从 `controller` 拿到实时更新的 answer 时，就会产生 think 先于 answer 出现的顺序问题，或者在 `getLastAnswerContent()` 为空时 answer 被丢失。

核心矛盾：Feishu 的 `disableBlockStreaming=true` 路径完全绕开了 block deliver，直接在 final deliver 里用 merged text 关闭 streaming card；而 DingTalk card 策略试图同时：

1. 通过 `disableBlockStreaming=true` 禁用 block streaming（不让 `onBlockReply` 注册）
2. 又通过 `onReasoningStream` 单独处理 reasoning
3. 又依赖 final deliver 的 `finalTextForFallback`

这三条路在 `/reasoning on` 的 pure-reasoning 场景下发生了时序冲突。
