# Card Markdown Image Reroute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk AI Cards keep public Markdown images in answer markdown while converting local/private Markdown images into `type:3` image blocks with descriptive text placeholders.

**Architecture:** Add a focused Markdown-image reroute layer inside the card reply strategy. Public `![alt](https://...)` images stay in markdown because DingTalk cards already render them natively; local/private markdown images are extracted, uploaded to DingTalk media, appended as `type:3` blocks, and replaced in answer text with `见下图{标题}` placeholders. The card draft controller is extended so image blocks carry both `mediaId` and `text`.

**Tech Stack:** TypeScript, Vitest, DingTalk AI Card blockList rendering, existing `prepareMediaInput` / `resolveOutboundMediaType` / `uploadMedia` helpers.

---

## File Structure

### Files to create
- `docs/spec/2026-04-10-card-markdown-image-reroute-design.md` — Design note describing public-vs-local markdown image routing rules, placeholder behavior, and failure fallback.
- `docs/plans/2026-04-10-card-markdown-image-reroute-implementation.md` — This implementation plan.
- `src/card/card-markdown-image-reroute.ts` — Pure functions for parsing markdown image syntax, classifying image URLs as public/local/private, producing placeholder text, and returning reroute candidates.
- `tests/unit/card-markdown-image-reroute.test.ts` — Unit tests for markdown image extraction, public/local classification, placeholder rendering, and failure-safe text preservation.

### Files to modify
- `src/card-draft-controller.ts` — Extend image timeline entries and `appendImageBlock()` so `type:3` blocks include both `mediaId` and `text`.
- `src/reply-strategy-card.ts` — Add markdown-image reroute flow for final answer text: keep public markdown images inline, extract local/private markdown images into uploaded card image blocks, and replace them with placeholders.
- `src/types.ts` — Update `CardBlock` type definition for image blocks so `type:3` supports `text` alongside `mediaId`.
- `tests/unit/card-draft-controller.test.ts` — Add tests for image block `text` rendering.
- `tests/unit/reply-strategy-card.test.ts` — Add card strategy tests for public markdown images, local markdown image reroute, placeholder replacement, and upload failure fallback.

### Files to review while implementing
- `src/media-utils.ts` — Reuse `prepareMediaInput()` and `resolveOutboundMediaType()` instead of inventing a second media classifier.
- `src/send-service.ts` — Reuse `uploadMedia()` as the only DingTalk media upload path.
- `docs/plans/2026-04-04-card-v2-image-block-test-migration-handoff.md` — Existing card image test handoff context.

---

### Task 1: Define the markdown-image reroute design

**Files:**
- Create: `docs/spec/2026-04-10-card-markdown-image-reroute-design.md`
- Review: `docs/plans/2026-04-04-card-v2-image-block-test-migration-handoff.md`

- [ ] **Step 1: Write the design note**

Create `docs/spec/2026-04-10-card-markdown-image-reroute-design.md` with this content:

```md
# DingTalk Card Markdown Image Reroute Design

## Problem

DingTalk AI Cards already render public Markdown images such as `![alt](https://example.com/a.png)`. However, local/private image references cannot be rendered directly by DingTalk card markdown and need to be uploaded as DingTalk media and inserted as `type:3` image blocks.

Today the card reply strategy only embeds images when `payload.mediaUrls` is already structured. When the answer contains Markdown image syntax, the card keeps the raw markdown as text.

## Goal

Implement a card-only reroute layer with these rules:

1. Public Markdown images stay in answer markdown untouched.
2. Local/private Markdown images are extracted into DingTalk card image blocks.
3. Extracted local/private Markdown images leave behind placeholder text in the answer: `见下图{图片标题}`.
4. Card image blocks must contain both `mediaId` and `text`.
5. On extraction/upload failure, preserve the original Markdown image text.

## Source Forms

Supported in phase 1:

- Markdown image syntax: `![alt](url)`

Out of scope for phase 1:

- Bare image URLs in plain text
- Message-tool image reroute
- Ordinary Markdown links `[text](url)`

## Classification Rules

### Public image
Treat as public when the URL:
- uses `http://` or `https://`
- is not localhost
- is not a private LAN IP (`10.x.x.x`, `172.16.x.x`–`172.31.x.x`, `192.168.x.x`)
- is not `file://`
- is not a relative or absolute local filesystem path

Public images remain in Markdown.

### Local/private image
Treat as local/private when the URL is any of:
- `file://...`
- relative path (`./`, `../`)
- absolute local filesystem path (`/tmp/a.png`)
- localhost URL
- private LAN URL

Local/private images are extracted and uploaded.

## Placeholder Rules

When a local/private Markdown image is successfully rerouted, replace the original Markdown image with placeholder text:

- preferred: `见下图{alt}`
- if `alt` is empty and a file name exists: `见下图{fileName}`
- final fallback: `见下图图片`

Examples:
- `![系统架构图](./artifacts/arch.png)` → `见下图系统架构图`
- `![](./artifacts/arch.png)` → `见下图arch.png`

## Card Block Shape

Rerouted images use card block:

```json
{ "type": 3, "mediaId": "@xxx", "text": "系统架构图" }
```

## Failure Fallback

If parsing, preparation, type detection, upload, or append fails:
- do not remove the Markdown image from answer text
- do not add the placeholder
- keep the original markdown unchanged

## Why this split is safe

- Public images already work in DingTalk markdown, so uploading them is unnecessary churn.
- Local/private images are not renderable by DingTalk clients, so converting them to media blocks improves reliability.
- Placeholder text keeps narrative continuity after extraction.
```

- [ ] **Step 2: Review the design for scope discipline**

Check that the spec only includes:
- Markdown image syntax `![]()`
- public/local split
- placeholder replacement
- image block `text`

Expected result: no mention of bare URL extraction or message-tool reroute in this first plan.

- [ ] **Step 3: Commit the spec**

```bash
git add docs/spec/2026-04-10-card-markdown-image-reroute-design.md
git commit -m "docs: add card markdown image reroute design"
```

---

### Task 2: Add pure markdown-image classification helpers

**Files:**
- Create: `src/card/card-markdown-image-reroute.ts`
- Test: `tests/unit/card-markdown-image-reroute.test.ts`

- [ ] **Step 1: Write the failing tests for markdown image parsing**

Create `tests/unit/card-markdown-image-reroute.test.ts` with this initial test suite:

```ts
import { describe, expect, it } from "vitest";
import {
  classifyMarkdownImageUrl,
  buildImagePlaceholderText,
  extractMarkdownImageCandidates,
} from "../../src/card/card-markdown-image-reroute";

describe("card-markdown-image-reroute", () => {
  describe("classifyMarkdownImageUrl", () => {
    it("classifies public https images as public", () => {
      expect(classifyMarkdownImageUrl("https://example.com/a.png")).toBe("public");
    });

    it("classifies file URLs as local", () => {
      expect(classifyMarkdownImageUrl("file:///tmp/a.png")).toBe("local");
    });

    it("classifies relative paths as local", () => {
      expect(classifyMarkdownImageUrl("./artifacts/a.png")).toBe("local");
    });

    it("classifies localhost URLs as local", () => {
      expect(classifyMarkdownImageUrl("http://127.0.0.1:3000/a.png")).toBe("local");
    });

    it("classifies LAN URLs as local", () => {
      expect(classifyMarkdownImageUrl("http://192.168.0.8/a.png")).toBe("local");
    });
  });

  describe("buildImagePlaceholderText", () => {
    it("uses markdown alt text when available", () => {
      expect(buildImagePlaceholderText({ alt: "系统架构图", url: "./arch.png" })).toBe("见下图系统架构图");
    });

    it("falls back to file name when alt text is empty", () => {
      expect(buildImagePlaceholderText({ alt: "", url: "./artifacts/arch.png" })).toBe("见下图arch.png");
    });

    it("falls back to generic label when no alt or file name exists", () => {
      expect(buildImagePlaceholderText({ alt: "", url: "file:///" })).toBe("见下图图片");
    });
  });

  describe("extractMarkdownImageCandidates", () => {
    it("extracts markdown image candidates with source positions", () => {
      const text = "前言\n\n![系统架构图](./artifacts/arch.png)\n\n结尾";
      expect(extractMarkdownImageCandidates(text)).toEqual([
        {
          alt: "系统架构图",
          url: "./artifacts/arch.png",
          raw: "![系统架构图](./artifacts/arch.png)",
          classification: "local",
          start: 4,
          end: 33,
        },
      ]);
    });

    it("does not extract ordinary markdown links", () => {
      const text = "请查看[设计文档](https://example.com/design.md)";
      expect(extractMarkdownImageCandidates(text)).toEqual([]);
    });

    it("extracts public markdown images without rewriting them yet", () => {
      const text = "![封面](https://example.com/cover.png)";
      expect(extractMarkdownImageCandidates(text)).toEqual([
        {
          alt: "封面",
          url: "https://example.com/cover.png",
          raw: "![封面](https://example.com/cover.png)",
          classification: "public",
          start: 0,
          end: 37,
        },
      ]);
    });
  });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run:

```bash
pnpm vitest run tests/unit/card-markdown-image-reroute.test.ts
```

Expected: FAIL because `src/card/card-markdown-image-reroute.ts` does not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

Create `src/card/card-markdown-image-reroute.ts` with this code:

```ts
export type MarkdownImageUrlClassification = "public" | "local" | "unsupported";

export interface MarkdownImageCandidate {
  alt: string;
  url: string;
  raw: string;
  classification: MarkdownImageUrlClassification;
  start: number;
  end: number;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const PRIVATE_HOST_RE = /^(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/;

function isLikelyLocalPath(url: string): boolean {
  return url.startsWith("./") || url.startsWith("../") || url.startsWith("/");
}

function safeFileNameFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("file://")) {
    const withoutScheme = trimmed.slice("file://".length);
    const segments = withoutScheme.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  }
  if (isLikelyLocalPath(trimmed)) {
    const segments = trimmed.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  }
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? "";
  } catch {
    return "";
  }
}

export function classifyMarkdownImageUrl(url: string): MarkdownImageUrlClassification {
  const trimmed = url.trim();
  if (!trimmed) {
    return "unsupported";
  }
  if (trimmed.startsWith("file://") || isLikelyLocalPath(trimmed)) {
    return "local";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "unsupported";
    }
    if (PRIVATE_HOST_RE.test(parsed.hostname)) {
      return "local";
    }
    return "public";
  } catch {
    return "unsupported";
  }
}

export function buildImagePlaceholderText(input: { alt: string; url: string }): string {
  const alt = input.alt.trim();
  if (alt) {
    return `见下图${alt}`;
  }
  const fileName = safeFileNameFromUrl(input.url);
  if (fileName) {
    return `见下图${fileName}`;
  }
  return "见下图图片";
}

export function extractMarkdownImageCandidates(text: string): MarkdownImageCandidate[] {
  const candidates: MarkdownImageCandidate[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const raw = match[0] ?? "";
    const alt = match[1] ?? "";
    const url = match[2] ?? "";
    const start = match.index ?? 0;
    candidates.push({
      alt,
      url,
      raw,
      classification: classifyMarkdownImageUrl(url),
      start,
      end: start + raw.length,
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run:

```bash
pnpm vitest run tests/unit/card-markdown-image-reroute.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper layer**

```bash
git add src/card/card-markdown-image-reroute.ts tests/unit/card-markdown-image-reroute.test.ts
git commit -m "feat: add markdown image reroute helpers"
```

---

### Task 3: Extend card image blocks to carry `text`

**Files:**
- Modify: `src/card-draft-controller.ts:21-38`
- Modify: `src/card-draft-controller.ts:227-230`
- Modify: `src/types.ts`
- Test: `tests/unit/card-draft-controller.test.ts`

- [ ] **Step 1: Write the failing image-block text test**

Append this test to `tests/unit/card-draft-controller.test.ts`:

```ts
it("renders image blocks with mediaId and text", async () => {
  const card = makeCard();
  const ctrl = createCardDraftController({ card, throttleMs: 0 }) as any;

  await ctrl.appendImageBlock("@media_123", "系统架构图");
  await vi.advanceTimersByTimeAsync(0);

  const sentContent = updateAICardBlockListMock.mock.calls[0]?.[1] as string;
  const blocks = parseBlocks(sentContent);
  expect(blocks[0]).toEqual({
    type: 3,
    mediaId: "@media_123",
    text: "系统架构图",
  });
});
```

- [ ] **Step 2: Run the single test to verify it fails**

Run:

```bash
pnpm vitest run tests/unit/card-draft-controller.test.ts -t "renders image blocks with mediaId and text"
```

Expected: FAIL because `appendImageBlock` only accepts `mediaId` and image block rendering omits `text`.

- [ ] **Step 3: Update the card draft controller interface and renderer**

Modify `src/card-draft-controller.ts` so these sections match exactly:

```ts
type TimelineEntry = {
    kind: TimelineEntryKind;
    text: string;
    mediaId?: string;
};
```

```ts
/** Append an image block (type=3) with an uploaded mediaId. */
appendImageBlock: (mediaId: string, text?: string) => Promise<void>;
```

```ts
case "image":
    if (entry.mediaId?.trim()) {
        blocks.push({
            type: 3,
            mediaId: entry.mediaId,
            ...(entry.text?.trim() ? { text: entry.text } : {}),
        });
    }
    break;
```

```ts
const appendImageBlock = async (mediaId: string, text = "") => {
    await waitForPendingBoundary();
    if (stopped || failed) {
        return;
    }
    if (!mediaId.trim()) {
        return;
    }
    if (timelineEntries.length > 0) {
        await flushBoundaryFrame();
    }
    sealLiveThinking();
    sealCurrentAnswer();
    timelineEntries.push({ kind: "image", text, mediaId });
    queueRender();
};
```

- [ ] **Step 4: Update the card block type definition**

Find the `CardBlock` union in `src/types.ts` and update the image branch so it includes `text`:

```ts
| {
    type: 3;
    mediaId: string;
    text?: string;
  }
```

- [ ] **Step 5: Run the draft controller test file**

Run:

```bash
pnpm vitest run tests/unit/card-draft-controller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the image block shape change**

```bash
git add src/card-draft-controller.ts src/types.ts tests/unit/card-draft-controller.test.ts
git commit -m "feat: include text in card image blocks"
```

---

### Task 4: Reroute local/private Markdown images inside card replies

**Files:**
- Modify: `src/reply-strategy-card.ts`
- Reuse: `src/card/card-markdown-image-reroute.ts`
- Test: `tests/unit/reply-strategy-card.test.ts`

- [ ] **Step 1: Write failing tests for public-vs-local markdown image behavior**

Append these tests to `tests/unit/reply-strategy-card.test.ts`:

```ts
it("keeps public markdown images inline in final answer text", async () => {
  const card = makeCard();
  const ctx = buildCtx(card);
  const strategy = createCardReplyStrategy(ctx);

  await strategy.deliver({
    kind: "final",
    text: "说明如下\n\n![公网图](https://example.com/demo.png)",
    mediaUrls: [],
  } as any);

  await strategy.finalize();

  expect(uploadMediaMock).not.toHaveBeenCalled();
  const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
  expect(commitPayload.blockListJson).toContain("![公网图](https://example.com/demo.png)");
});

it("extracts local markdown images into card image blocks and leaves placeholder text", async () => {
  const card = makeCard();
  const ctx = buildCtx(card);
  const strategy = createCardReplyStrategy(ctx);

  await strategy.deliver({
    kind: "final",
    text: "说明如下\n\n![本地图](./artifacts/demo.png)",
    mediaUrls: [],
  } as any);

  await strategy.finalize();

  expect(uploadMediaMock).toHaveBeenCalledTimes(1);
  const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
  expect(commitPayload.content).toContain("见下图本地图");
  expect(commitPayload.content).not.toContain("![本地图](./artifacts/demo.png)");
  expect(commitPayload.blockListJson).toContain('"type":3');
  expect(commitPayload.blockListJson).toContain('"mediaId":"test-media-id"');
  expect(commitPayload.blockListJson).toContain('"text":"本地图"');
});

it("preserves original markdown image text when local image upload fails", async () => {
  uploadMediaMock.mockRejectedValueOnce(new Error("upload failed"));
  const card = makeCard();
  const ctx = buildCtx(card);
  const strategy = createCardReplyStrategy(ctx);

  await strategy.deliver({
    kind: "final",
    text: "说明如下\n\n![本地图](./artifacts/demo.png)",
    mediaUrls: [],
  } as any);

  await strategy.finalize();

  const commitPayload = commitAICardBlocksMock.mock.calls[0]?.[1];
  expect(commitPayload.content).toContain("![本地图](./artifacts/demo.png)");
  expect(commitPayload.blockListJson).not.toContain('"type":3');
});
```

- [ ] **Step 2: Run the reply strategy tests to verify they fail**

Run:

```bash
pnpm vitest run tests/unit/reply-strategy-card.test.ts -t "markdown images"
```

Expected: FAIL because the card strategy currently treats markdown images as plain answer text.

- [ ] **Step 3: Add a local/public markdown image normalization helper inside the card strategy**

In `src/reply-strategy-card.ts`, add these imports near the top:

```ts
import {
  buildImagePlaceholderText,
  extractMarkdownImageCandidates,
} from "./card/card-markdown-image-reroute";
```

Then add this helper inside `createCardReplyStrategy(...)`, above `return {`:

```ts
  const rerouteMarkdownImagesFromAnswer = async (text: string): Promise<string> => {
    const candidates = extractMarkdownImageCandidates(text);
    if (candidates.length === 0) {
      return text;
    }

    let nextText = text;
    for (const candidate of candidates.toReversed()) {
      if (candidate.classification !== "local") {
        continue;
      }
      try {
        const prepared = await prepareMediaInput(candidate.url, log);
        const mediaType = resolveOutboundMediaType({ mediaPath: prepared.path, asVoice: false });
        if (mediaType !== "image") {
          await prepared.cleanup?.();
          continue;
        }
        const result = await uploadMedia(config, prepared.path, "image", log);
        await prepared.cleanup?.();
        if (!result?.mediaId) {
          continue;
        }
        const placeholder = buildImagePlaceholderText({ alt: candidate.alt, url: candidate.url });
        await controller.appendImageBlock(result.mediaId, candidate.alt.trim() || placeholder.replace(/^见下图/, "").trim() || "图片");
        nextText = `${nextText.slice(0, candidate.start)}${placeholder}${nextText.slice(candidate.end)}`;
      } catch {
        // Failure fallback: keep the original markdown unchanged.
      }
    }
    return nextText;
  };
```

- [ ] **Step 4: Route final answer text through the markdown-image rerouter**

In the `payload.kind === "final"` branch of `src/reply-strategy-card.ts`, replace this section:

```ts
        const rawFinalText = typeof textToSend === "string" ? textToSend : "";
        if (rawFinalText) {
          if (payload.isReasoning === true) {
            await applyModeAwareReasoningSnapshot(rawFinalText);
            await flushPendingReasoning();
          } else {
            const normalizedFinal = await applySplitTextToTimeline(rawFinalText, {
              answerHandling: "capture",
            });
            if (isFirstFinalDelivery && !normalizedFinal.answerText && !normalizedFinal.reasoningText) {
              finalTextForFallback = rawFinalText;
            }
            await flushPendingReasoning();
          }
        }
```

with this code:

```ts
        const rawFinalText = typeof textToSend === "string" ? textToSend : "";
        if (rawFinalText) {
          if (payload.isReasoning === true) {
            await applyModeAwareReasoningSnapshot(rawFinalText);
            await flushPendingReasoning();
          } else {
            const rewrittenFinalText = await rerouteMarkdownImagesFromAnswer(rawFinalText);
            const normalizedFinal = await applySplitTextToTimeline(rewrittenFinalText, {
              answerHandling: "capture",
            });
            if (isFirstFinalDelivery && !normalizedFinal.answerText && !normalizedFinal.reasoningText) {
              finalTextForFallback = rewrittenFinalText;
            }
            await flushPendingReasoning();
          }
        }
```

- [ ] **Step 5: Run the reply strategy test file**

Run:

```bash
pnpm vitest run tests/unit/reply-strategy-card.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the card strategy reroute**

```bash
git add src/reply-strategy-card.ts src/card/card-markdown-image-reroute.ts tests/unit/reply-strategy-card.test.ts tests/unit/card-markdown-image-reroute.test.ts
git commit -m "feat: reroute local markdown images into card blocks"
```

---

### Task 5: Verify end-to-end behavior and document manual test steps

**Files:**
- Modify: `docs/plans/2026-04-10-card-markdown-image-reroute-implementation.md`
- Review: `docs/spec/2026-04-10-card-markdown-image-reroute-design.md`

- [ ] **Step 1: Run the targeted test suite**

Run:

```bash
pnpm vitest run tests/unit/card-markdown-image-reroute.test.ts tests/unit/card-draft-controller.test.ts tests/unit/reply-strategy-card.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run type-check**

Run:

```bash
pnpm run type-check
```

Expected: PASS.

- [ ] **Step 3: Run manual DingTalk verification**

Send this public-image prompt in DingTalk DM:

```text
请输出以下 Markdown 图片，并附一句文字“公网图测试”：
![公网图](https://raw.githubusercontent.com/soimy/msdf-bmfont-xml/master/assets/atlas.0.png)
```

Expected:
- Card renders the public image inline via markdown.
- No image block upload logs.
- Final content retains the markdown image syntax.

Send this local-image prompt using a locally reachable path produced by the runtime (or a test fixture path wired through a dedicated test harness):

```text
请输出以下 Markdown 图片，并附一句文字“本地图测试”：
![本地图](./artifacts/demo.png)
```

Expected:
- Final answer text contains `见下图本地图`.
- Card blockList contains `type:3` with `mediaId` and `text`.
- Original markdown image syntax is removed from the final answer text.

- [ ] **Step 4: Record manual verification notes in the plan footer**

Append this section to the end of `docs/plans/2026-04-10-card-markdown-image-reroute-implementation.md` after implementation is complete:

```md
## Verification Notes

- Public Markdown image path: [pass/fail + log reference]
- Local/private Markdown image path: [pass/fail + log reference]
- Upload failure fallback: [pass/fail + test reference]
```

- [ ] **Step 5: Commit verification updates**

```bash
git add docs/plans/2026-04-10-card-markdown-image-reroute-implementation.md
git commit -m "docs: record card markdown image reroute verification"
```

---

## Self-Review

### Spec coverage
- Public Markdown image remains inline: covered by Task 4 tests and implementation.
- Local/private Markdown image reroutes to image block: covered by Task 4.
- Placeholder `见下图{标题}`: covered by Task 2 helper tests and Task 4 integration tests.
- `type:3` block includes `mediaId` and `text`: covered by Task 3.
- Upload failure preserves original markdown: covered by Task 4.
- Scope discipline (no bare URL/message tool reroute in phase 1): enforced in Task 1 and test matrix.

### Placeholder scan
- No `TODO` / `TBD` / “handle appropriately” placeholders remain.
- Each code step contains concrete code or exact file content.
- Each test step includes exact commands.

### Type consistency
- `appendImageBlock(mediaId, text?)` is defined in Task 3 and consumed in Task 4.
- Image block `text` is added consistently to `CardBlock` and renderer expectations.
- Placeholder text format is consistently `见下图{标题}` across helper tests and strategy tests.

## Verification Notes

- Public Markdown image path: pass — covered by `pnpm vitest run tests/unit/reply-strategy-card.test.ts` (`keeps public markdown images inline in final answer text`); no upload triggered, markdown retained in `content` and `blockListJson`.
- Local/private Markdown image path: pass — covered by `pnpm vitest run tests/unit/reply-strategy-card.test.ts` (`extracts local markdown images into card image blocks and leaves placeholder text`); final answer contains `见下图本地图`, blockList contains `type:3` with `mediaId` and `text`.
- Upload failure fallback: pass — covered by `pnpm vitest run tests/unit/reply-strategy-card.test.ts` (`preserves original markdown image text when local image upload fails`); original markdown stays in final content and no image block is appended.
- Targeted automated verification: pass — `pnpm vitest run tests/unit/card-markdown-image-reroute.test.ts tests/unit/card-draft-controller.test.ts tests/unit/reply-strategy-card.test.ts` passed (`110 passed`).
- Type-check: pass — `pnpm run type-check` passed.
- Manual DingTalk verification: not run in this session.
