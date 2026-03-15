import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRecentGroupHistoryEntry,
  listConversationHistoryIndex,
  listGroupHistorySummarySegments,
  listRecentGroupHistory,
  queryConversationHistory,
  upsertConversationHistoryIndex,
} from "../../src/group-history-store";

describe("group-history-store", () => {
  it("indexes direct and group conversations independently", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-index-"), "store.json");
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "dm_1",
      chatType: "direct",
      title: "Alice",
    });
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      chatType: "group",
      title: "Ops Group",
    });

    expect(listConversationHistoryIndex({ storePath, accountId: "main", chatType: "direct" })).toEqual([
      expect.objectContaining({ conversationId: "dm_1", chatType: "direct", title: "Alice" }),
    ]);
    expect(listConversationHistoryIndex({ storePath, accountId: "main", chatType: "group" })).toEqual([
      expect.objectContaining({ conversationId: "group_1", chatType: "group", title: "Ops Group" }),
    ]);
  });

  it("rolls older entries into dated summary segments", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-rollup-"), "store.json");
    for (let i = 0; i < 205; i++) {
      appendRecentGroupHistoryEntry({
        storePath,
        accountId: "main",
        conversationId: "group_1",
        limit: 200,
        entry: {
          sender: `User ${i} (u${i})`,
          senderId: `u${i}`,
          body: `message-${i}`,
          timestamp: 1_700_000_000_000 + i * 1000,
          messageId: `m_${i}`,
        },
      });
    }

    const recent = listRecentGroupHistory({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      limit: 200,
    });
    const segments = listGroupHistorySummarySegments({
      storePath,
      accountId: "main",
      conversationId: "group_1",
    });

    expect(recent.length).toBeLessThanOrEqual(200);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]).toEqual(
      expect.objectContaining({
        fromTs: expect.any(Number),
        toTs: expect.any(Number),
        createdAt: expect.any(Number),
        messageCount: expect.any(Number),
        summary: expect.stringContaining("message-"),
      }),
    );
    expect(segments[0]!.toTs).toBeGreaterThanOrEqual(segments[0]!.fromTs);
  });

  it("rolls older entries once the configured recent window is exceeded", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-window-rollup-"), "store.json");
    for (let i = 0; i < 75; i++) {
      appendRecentGroupHistoryEntry({
        storePath,
        accountId: "main",
        conversationId: "group_1",
        limit: 50,
        entry: {
          sender: `User ${i} (u${i})`,
          senderId: `u${i}`,
          body: `window-message-${i}`,
          timestamp: 1_700_000_000_000 + i * 1000,
          messageId: `wm_${i}`,
        },
      });
    }

    const recent = listRecentGroupHistory({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      limit: 50,
    });
    const segments = listGroupHistorySummarySegments({
      storePath,
      accountId: "main",
      conversationId: "group_1",
    });

    expect(recent.length).toBeLessThanOrEqual(50);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.at(-1)?.summary).toContain("window-message-");
  });

  it("queries slices by chat type, time range, and sender", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-query-"), "store.json");
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "dm_1",
      chatType: "direct",
      title: "Alice",
    });
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      chatType: "group",
      title: "Ops Group",
    });
    appendRecentGroupHistoryEntry({
      storePath,
      accountId: "main",
      conversationId: "dm_1",
      limit: 50,
      entry: {
        sender: "Alice (u_alice)",
        senderId: "u_alice",
        body: "direct-old",
        timestamp: 1_700_000_000_000,
      },
    });
    appendRecentGroupHistoryEntry({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      limit: 50,
      entry: {
        sender: "Bob (u_bob)",
        senderId: "u_bob",
        body: "group-new",
        timestamp: 1_700_000_100_000,
      },
    });

    const slices = queryConversationHistory({
      storePath,
      accountId: "main",
      chatType: "group",
      sinceTs: 1_700_000_050_000,
      senderIds: ["u_bob"],
    });

    expect(slices).toEqual([
      expect.objectContaining({
        conversation: expect.objectContaining({ conversationId: "group_1", chatType: "group" }),
        recentEntries: [
          expect.objectContaining({
            senderId: "u_bob",
            body: "group-new",
          }),
        ],
      }),
    ]);
  });

  it("does not include unfiltered summary segments for sender-scoped queries", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-sender-segments-"), "store.json");
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      chatType: "group",
      title: "Ops Group",
    });
    for (let i = 0; i < 205; i++) {
      appendRecentGroupHistoryEntry({
        storePath,
        accountId: "main",
        conversationId: "group_1",
        limit: 200,
        entry: {
          sender: i % 2 === 0 ? "Alice (u_alice)" : "Bob (u_bob)",
          senderId: i % 2 === 0 ? "u_alice" : "u_bob",
          body: `message-${i}`,
          timestamp: 1_700_000_000_000 + i * 1000,
          messageId: `m_${i}`,
        },
      });
    }

    const slices = queryConversationHistory({
      storePath,
      accountId: "main",
      senderIds: ["u_bob"],
      recentLimitPerConversation: 8,
    });

    expect(slices[0]?.recentEntries.every((entry) => entry.senderId === "u_bob")).toBe(true);
    expect(slices[0]?.summarySegments).toEqual([]);
  });

  it("filters before applying recent per-conversation limit", () => {
    const storePath = path.join(fs.mkdtempSync("/tmp/dt-history-recent-filter-"), "store.json");
    upsertConversationHistoryIndex({
      storePath,
      accountId: "main",
      conversationId: "group_1",
      chatType: "group",
      title: "Ops Group",
    });
    for (let i = 0; i < 20; i++) {
      appendRecentGroupHistoryEntry({
        storePath,
        accountId: "main",
        conversationId: "group_1",
        limit: 200,
        entry: {
          sender: i === 10 ? "Target (u_target)" : `User ${i} (u_${i})`,
          senderId: i === 10 ? "u_target" : `u_${i}`,
          body: `message-${i}`,
          timestamp: 1_700_000_000_000 + i * 1000,
          messageId: `m_${i}`,
        },
      });
    }

    const slices = queryConversationHistory({
      storePath,
      accountId: "main",
      senderIds: ["u_target"],
      recentLimitPerConversation: 8,
    });

    expect(slices).toEqual([
      expect.objectContaining({
        recentEntries: [
          expect.objectContaining({
            senderId: "u_target",
            body: "message-10",
          }),
        ],
      }),
    ]);
  });
});
