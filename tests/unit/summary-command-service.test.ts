import { describe, expect, it, vi } from "vitest";

const sessionLockMocks = vi.hoisted(() => ({
  acquireSessionLockMock: vi.fn(),
}));
const historyStoreMocks = vi.hoisted(() => ({
  queryConversationHistoryMock: vi.fn(),
}));

vi.mock("../../src/session-lock", () => ({
  acquireSessionLock: sessionLockMocks.acquireSessionLockMock,
}));
vi.mock("../../src/history/group-history-store", () => ({
  queryConversationHistory: historyStoreMocks.queryConversationHistoryMock,
}));

import {
  buildSummaryNarrativePrompt,
  formatSummaryReply,
  formatSummaryCommandHelp,
  generateSummaryNarrative,
  parseSummaryCommand,
  resolveSummaryMentionNames,
} from "../../src/commands/summary-command-service";

describe("summary-command-service", () => {
  it("serializes summary dispatch with a dedicated summary session lock", async () => {
    const releaseLock = vi.fn();
    sessionLockMocks.acquireSessionLockMock.mockResolvedValueOnce(releaseLock);
    historyStoreMocks.queryConversationHistoryMock.mockReturnValueOnce([
      {
        conversation: {
          conversationId: "cid_group_1",
          chatType: "group",
          title: "研发群",
          updatedAt: 2000,
        },
        recentEntries: [
          {
            sender: "Bob (user_1)",
            senderId: "user_1",
            body: "今天上线么",
            timestamp: 2000,
          },
        ],
        summarySegments: [],
      },
    ]);

    const dispatchReplyWithBufferedBlockDispatcher = vi
      .fn()
      .mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "summary final" }, { kind: "final" });
        return { queuedFinal: "queued final" };
      });

    const finalText = await generateSummaryNarrative({
      rt: {
        channel: {
          reply: {
            finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1::summary" }),
            dispatchReplyWithBufferedBlockDispatcher,
          },
        },
      } as any,
      cfg: {},
      accountId: "main",
      senderId: "owner_1",
      senderName: "Owner",
      replyTarget: "cid_group_1",
      routeSessionKey: "s1",
      conversationLabel: "研发群 - Owner",
      chatType: "group",
      windowLabel: "最近 1 天",
      storePath: undefined,
      historyRetainLimit: 50,
      conversationIds: undefined,
      senderIds: undefined,
      mentionNames: undefined,
      sinceTs: undefined,
      chatTypeFilter: undefined,
    });

    expect(sessionLockMocks.acquireSessionLockMock).toHaveBeenCalledWith("s1::summary");
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(finalText).toBe("summary final");
  });

  it("parses summary mention and here scopes", () => {
    expect(parseSummaryCommand("/summary mention @Alice,me 1d", 2000)).toEqual({
      scope: "summary",
      mentionNames: ["Alice", "me"],
      sinceTs: 2000 - 24 * 60 * 60 * 1000,
      windowLabel: "最近 1 天",
    });

    const parsedToday = parseSummaryCommand("/summary here today", 2000);
    expect(parsedToday).toEqual(expect.objectContaining({
      scope: "summary",
      useCurrentConversation: true,
      windowLabel: "今天",
    }));
    expect(typeof parsedToday.sinceTs).toBe("number");
  });

  it("resolves mention self alias and formats help", () => {
    expect(resolveSummaryMentionNames(["me", "Alice"], "Bob")).toEqual(["Bob", "Alice"]);
    expect(formatSummaryCommandHelp()).toContain("/summary mention");
  });

  it("formats summary reply for both hit and empty cases", () => {
    expect(formatSummaryReply({
      slices: [],
      windowLabel: "最近 1 天",
      chatType: "group",
      mentionNames: ["alice"],
    })).toContain("未找到可总结的消息。");

    const reply = formatSummaryReply({
      windowLabel: "最近 1 天",
      slices: [
        {
          conversation: {
            conversationId: "cid_group_1",
            chatType: "group",
            title: "研发群",
            updatedAt: 2000,
          },
          recentEntries: [
            {
              sender: "Bob (user_1)",
              senderId: "user_1",
              body: "今天上线么",
              timestamp: 2000,
            },
          ],
          summarySegments: [
            {
              id: "seg_1",
              fromTs: 1000,
              toTs: 1500,
              createdAt: 1600,
              messageCount: 3,
              summary: "a\nb\nc",
            },
          ],
        },
      ],
    });

    expect(reply).toContain("Summary 检索结果");
    expect(reply).toContain("研发群");
    expect(reply).toContain("历史摘要");
    expect(reply).toContain("最近消息");
  });

  it("builds bounded summary prompt material from queried slices", () => {
    historyStoreMocks.queryConversationHistoryMock.mockReturnValueOnce([
      {
        conversation: {
          conversationId: "cid_group_1",
          chatType: "group",
          title: "研发群",
          updatedAt: 2000,
        },
        recentEntries: [
          {
            sender: "Bob (user_1)",
            senderId: "user_1",
            body: "今天上线么",
            timestamp: 2000,
            mentions: ["alice"],
          },
        ],
        summarySegments: [
          {
            id: "seg_1",
            fromTs: 1000,
            toTs: 1500,
            createdAt: 1600,
            messageCount: 3,
            summary: "已确认发布窗口",
          },
        ],
      },
    ]);

    const prompt = buildSummaryNarrativePrompt({
      accountId: "main",
      windowLabel: "最近 1 天",
      chatType: "group",
      mentionNames: ["alice"],
      senderIds: ["user_1"],
      conversationIds: ["cid_group_1"],
      sinceTs: 1000,
      historyRetainLimit: 50,
    });

    expect(historyStoreMocks.queryConversationHistoryMock).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "main",
      chatType: "group",
      mentionNames: ["alice"],
      senderIds: ["user_1"],
      conversationIds: ["cid_group_1"],
      sinceTs: 1000,
      historyRetainLimit: 50,
      recentLimitPerConversation: 8,
    }));
    expect(prompt.fallbackReply).toContain("Summary 检索结果");
    expect(prompt.userPrompt).toContain("命中会话数：1");
    expect(prompt.userPrompt).toContain("已确认发布窗口");
    expect(prompt.userPrompt).toContain("mentions: alice");
    expect(prompt.systemPrompt).toContain("只能基于给定材料总结");
  });

  it("falls back to formatted summary reply when dispatch throws", async () => {
    const releaseLock = vi.fn();
    sessionLockMocks.acquireSessionLockMock.mockResolvedValueOnce(releaseLock);
    historyStoreMocks.queryConversationHistoryMock.mockReturnValueOnce([
      {
        conversation: {
          conversationId: "cid_group_1",
          chatType: "group",
          title: "研发群",
          updatedAt: 2000,
        },
        recentEntries: [
          {
            sender: "Bob (user_1)",
            senderId: "user_1",
            body: "今天上线么",
            timestamp: 2000,
          },
        ],
        summarySegments: [],
      },
    ]);

    const finalText = await generateSummaryNarrative({
      rt: {
        channel: {
          reply: {
            finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1::summary" }),
            dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockRejectedValue(new Error("dispatch failed")),
          },
        },
      } as any,
      cfg: {},
      accountId: "main",
      senderId: "owner_1",
      senderName: "Owner",
      replyTarget: "cid_group_1",
      routeSessionKey: "s1",
      conversationLabel: "研发群 - Owner",
      chatType: "group",
      windowLabel: "最近 1 天",
      storePath: undefined,
      historyRetainLimit: 50,
      conversationIds: undefined,
      senderIds: undefined,
      mentionNames: undefined,
      sinceTs: undefined,
      chatTypeFilter: undefined,
    });

    expect(finalText).toContain("Summary 检索结果");
    expect(finalText).toContain("研发群");
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
