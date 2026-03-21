import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMessageContextCacheForTest,
  resolveByMsgId,
  upsertInboundMessageContext,
  upsertOutboundMessageContext,
} from "../../src/message-context-store";
import { resolveQuotedRuntimeContext } from "../../src/messaging/quoted-context";

describe("quoted-context", () => {
  beforeEach(() => {
    clearMessageContextCacheForTest();
  });

  it("builds an inbound -> outbound -> inbound chain in order", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_chain",
      msgId: "chain_in_0",
      createdAt: 1000,
      messageType: "text",
      text: "third hop",
      topic: null,
    });
    upsertOutboundMessageContext({
      accountId: "main",
      conversationId: "cid_chain",
      createdAt: 2000,
      messageType: "card",
      text: "second hop",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "chain_in_0",
      },
      topic: null,
      delivery: {
        processQueryKey: "chain_out_1",
        kind: "session",
      },
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_chain",
      msgId: "chain_in_2",
      createdAt: 3000,
      messageType: "text",
      text: "first hop",
      quotedRef: {
        targetDirection: "outbound",
        key: "processQueryKey",
        value: "chain_out_1",
      },
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_chain",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "chain_in_2",
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.replyToId).toBe("chain_in_2");
    expect(resolved?.replyToBody).toBe("first hop");
    expect(resolved?.replyToSender).toBeUndefined();
    expect(resolved?.chain).toEqual([
      {
        depth: 1,
        direction: "inbound",
        messageType: "text",
        body: "first hop",
        createdAt: 3000,
        sender: undefined,
      },
      {
        depth: 2,
        direction: "outbound",
        messageType: "card",
        body: "second hop",
        createdAt: 2000,
        sender: "assistant",
      },
      {
        depth: 3,
        direction: "inbound",
        messageType: "text",
        body: "third hop",
        createdAt: 1000,
        sender: undefined,
      },
    ]);
    expect(JSON.parse(resolved?.untrustedContext || "")).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "outbound",
          messageType: "card",
          body: "second hop",
          createdAt: 2000,
          sender: "assistant",
        },
        {
          depth: 3,
          direction: "inbound",
          messageType: "text",
          body: "third hop",
          createdAt: 1000,
        },
      ],
    });
  });

  it("reuses a provided firstRecord without changing the resolved runtime context", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_first_record",
      msgId: "first_record_leaf",
      createdAt: 1000,
      messageType: "text",
      text: "leaf",
      topic: null,
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_first_record",
      msgId: "first_record_head",
      createdAt: 2000,
      messageType: "text",
      text: "head",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "first_record_leaf",
      },
      topic: null,
    });

    const firstRecord = resolveByMsgId({
      accountId: "main",
      conversationId: "cid_first_record",
      msgId: "first_record_head",
    });

    expect(firstRecord).not.toBeNull();

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_first_record",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "first_record_head",
      },
      firstRecord,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.replyToId).toBe("first_record_head");
    expect(resolved?.replyToBody).toBe("head");
    expect(resolved?.chain).toEqual([
      {
        depth: 1,
        direction: "inbound",
        messageType: "text",
        body: "head",
        createdAt: 2000,
        sender: undefined,
      },
      {
        depth: 2,
        direction: "inbound",
        messageType: "text",
        body: "leaf",
        createdAt: 1000,
        sender: undefined,
      },
    ]);
    expect(JSON.parse(resolved?.untrustedContext || "")).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "inbound",
          messageType: "text",
          body: "leaf",
          createdAt: 1000,
        },
      ],
    });
  });

  it("truncates the chain when maxDepth is exceeded", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_depth",
      msgId: "depth_0",
      createdAt: 1000,
      messageType: "text",
      text: "depth 0",
      topic: null,
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_depth",
      msgId: "depth_1",
      createdAt: 2000,
      messageType: "text",
      text: "depth 1",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "depth_0",
      },
      topic: null,
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_depth",
      msgId: "depth_2",
      createdAt: 3000,
      messageType: "text",
      text: "depth 2",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "depth_1",
      },
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_depth",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "depth_2",
      },
      maxDepth: 2,
    });

    expect(resolved?.chain.map((entry) => entry.depth)).toEqual([1, 2]);
    expect(JSON.parse(resolved?.untrustedContext || "")).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "inbound",
          messageType: "text",
          body: "depth 1",
          createdAt: 2000,
        },
      ],
    });
  });

  it("truncates bodies when the total body budget is exceeded", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_budget",
      msgId: "budget_0",
      createdAt: 1000,
      messageType: "text",
      text: "c".repeat(1000),
      topic: null,
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_budget",
      msgId: "budget_1",
      createdAt: 2000,
      messageType: "text",
      text: "b".repeat(1000),
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "budget_0",
      },
      topic: null,
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_budget",
      msgId: "budget_2",
      createdAt: 3000,
      messageType: "text",
      text: "a".repeat(1000),
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "budget_1",
      },
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_budget",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "budget_2",
      },
      totalBodyLimit: 1500,
    });

    expect(resolved?.replyToBody.length).toBe(1000);
    expect(resolved?.chain).toHaveLength(2);
    expect(resolved?.chain[1]?.body.length).toBe(500);
    expect(JSON.parse(resolved?.untrustedContext || "").quotedChain[0]?.body.length).toBe(500);
  });

  it("stops cleanly when the current record has no quotedRef", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_single",
      msgId: "single_0",
      createdAt: 1000,
      messageType: "text",
      text: "single hop",
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_single",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "single_0",
      },
    });

    expect(resolved?.chain).toHaveLength(1);
    expect(resolved?.untrustedContext).toBeUndefined();
  });

  it("stops safely on cycles without throwing", () => {
    upsertOutboundMessageContext({
      accountId: "main",
      conversationId: "cid_cycle",
      createdAt: 2000,
      messageType: "markdown",
      text: "second hop",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "cycle_0",
      },
      topic: null,
      delivery: {
        processQueryKey: "cycle_out_1",
        kind: "session",
      },
    });
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_cycle",
      msgId: "cycle_0",
      createdAt: 1000,
      messageType: "text",
      text: "first hop",
      quotedRef: {
        targetDirection: "outbound",
        key: "processQueryKey",
        value: "cycle_out_1",
      },
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_cycle",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "cycle_0",
      },
    });

    expect(resolved?.chain).toHaveLength(2);
    expect(JSON.parse(resolved?.untrustedContext || "")).toEqual({
      quotedChain: [
        {
          depth: 2,
          direction: "outbound",
          messageType: "markdown",
          body: "second hop",
          createdAt: 2000,
          sender: "assistant",
        },
      ],
    });
  });

  it("falls back to the event preview when the first quoted record is missing", () => {
    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_preview_only",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "missing_preview_only",
      },
      firstPreview: {
        text: "preview from inbound event",
        messageType: "text",
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.replyToId).toBe("missing_preview_only");
    expect(resolved?.replyToBody).toBe("preview from inbound event");
    expect(resolved?.replyToSender).toBeUndefined();
    expect(resolved?.chain).toEqual([]);
    expect(resolved?.untrustedContext).toBeUndefined();
  });

  it("keeps preview body for outbound fallbackCreatedAt quotes without a stable reply id", () => {
    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_preview_created_at_only",
      quotedRef: {
        targetDirection: "outbound",
        fallbackCreatedAt: 1772817989679,
      },
      firstPreview: {
        text: "preview from outbound fallback",
        messageType: "interactiveCard",
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.replyToId).toBeUndefined();
    expect(resolved?.replyToBody).toBe("preview from outbound fallback");
    expect(resolved?.replyToSender).toBe("assistant");
    expect(resolved?.chain).toEqual([]);
    expect(resolved?.untrustedContext).toBeUndefined();
  });

  it("prefers attachment excerpts over generic stored text for document hops", () => {
    upsertInboundMessageContext({
      accountId: "main",
      conversationId: "cid_attachment_chain",
      msgId: "doc_0",
      createdAt: 1000,
      messageType: "interactiveCardFile",
      text: "[钉钉文档]",
      attachmentText: "文档第一段\n文档第二段",
      attachmentTextSource: "pdf",
      topic: null,
    });

    const resolved = resolveQuotedRuntimeContext({
      accountId: "main",
      conversationId: "cid_attachment_chain",
      quotedRef: {
        targetDirection: "inbound",
        key: "msgId",
        value: "doc_0",
      },
    });

    expect(resolved?.replyToBody).toBe("文档第一段\n文档第二段");
    expect(resolved?.chain).toEqual([
      {
        depth: 1,
        direction: "inbound",
        messageType: "interactiveCardFile",
        body: "文档第一段\n文档第二段",
        createdAt: 1000,
        sender: undefined,
      },
    ]);
  });
});
