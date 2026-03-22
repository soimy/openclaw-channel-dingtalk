import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryConversationHistory } from "../../src/history/group-history-store";
import { upsertInboundMessageContext, upsertOutboundMessageContext } from "../../src/message-context-store";
import {
  clearTargetDirectoryStateCache,
  upsertObservedGroupTarget,
  upsertObservedUserTarget,
} from "../../src/targeting/target-directory-store";

describe("group-history-store", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(() => {
    clearTargetDirectoryStateCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dingtalk-group-history-"));
    storePath = path.join(tempDir, "session-store.json");
  });

  afterEach(() => {
    clearTargetDirectoryStateCache();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
    storePath = "";
  });

  it("filters conversation history by sender and mention", () => {
    upsertObservedGroupTarget({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      title: "研发群",
      seenAt: 3000,
    });

    upsertInboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      msgId: "m1",
      createdAt: 1000,
      messageType: "text",
      text: "@Alice 今天上线么",
      senderId: "user_1",
      senderName: "Bob",
      mentions: ["Alice"],
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
    });
    upsertOutboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_1",
      createdAt: 2000,
      messageType: "outbound",
      text: "今晚 8 点发版",
      senderId: "bot",
      senderName: "OpenClaw",
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
      delivery: { messageId: "out_1", kind: "session" },
    });

    const mentionSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      mentionNames: ["alice"],
    });
    expect(mentionSlices).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries[0]?.senderId).toBe("user_1");

    const senderSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      senderIds: ["bot"],
    });
    expect(senderSlices).toHaveLength(1);
    expect(senderSlices[0]?.recentEntries[0]?.senderId).toBe("bot");
  });

  it("filters conversation history by chatType and time window", () => {
    upsertObservedGroupTarget({
      storePath,
      accountId: "main",
      conversationId: "cid_group_2",
      title: "产品群",
      seenAt: 5000,
    });
    upsertObservedUserTarget({
      storePath,
      accountId: "main",
      senderId: "user_d",
      displayName: "私聊用户",
      conversationId: "cid_dm_1",
      seenAt: 5000,
    });

    upsertInboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_group_2",
      msgId: "g_old",
      createdAt: 1000,
      messageType: "text",
      text: "旧群消息",
      senderId: "user_g",
      senderName: "群成员",
      chatType: "group",
      ttlMs: 60_000,
      topic: null,
    });
    upsertInboundMessageContext({
      storePath,
      accountId: "main",
      conversationId: "cid_dm_1",
      msgId: "d_new",
      createdAt: 4000,
      messageType: "text",
      text: "新的私聊消息",
      senderId: "user_d",
      senderName: "私聊用户",
      chatType: "direct",
      ttlMs: 60_000,
      topic: null,
    });

    const groupSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      chatType: "group",
      sinceTs: 2000,
    });
    expect(groupSlices).toHaveLength(0);

    const directSlices = queryConversationHistory({
      storePath,
      accountId: "main",
      chatType: "direct",
      sinceTs: 2000,
    });
    expect(directSlices).toHaveLength(1);
    expect(directSlices[0]?.conversation.chatType).toBe("direct");
    expect(directSlices[0]?.recentEntries[0]?.body).toBe("新的私聊消息");
  });

  it("rolls older entries into summary segments when history exceeds retain limit", () => {
    upsertObservedGroupTarget({
      storePath,
      accountId: "main",
      conversationId: "cid_group_rollup",
      title: "归档群",
      seenAt: 10_000,
    });

    for (let index = 0; index < 25; index += 1) {
      upsertInboundMessageContext({
        storePath,
        accountId: "main",
        conversationId: "cid_group_rollup",
        msgId: `m_${index}`,
        createdAt: index + 1,
        messageType: "text",
        text: `消息 ${index}`,
        senderId: `user_${index}`,
        senderName: `成员 ${index}`,
        chatType: "group",
        ttlMs: 60_000,
        topic: null,
      });
    }

    const slices = queryConversationHistory({
      storePath,
      accountId: "main",
      conversationIds: ["cid_group_rollup"],
      historyRetainLimit: 5,
      recentLimitPerConversation: 5,
    });
    expect(slices).toHaveLength(1);
    expect(slices[0]?.recentEntries).toHaveLength(5);
    expect(slices[0]?.summarySegments.length).toBeGreaterThan(0);
    expect(slices[0]?.summarySegments[0]?.messageCount).toBeGreaterThan(0);
  });
});
