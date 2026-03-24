/**
 * Tests for DM (direct message) @mention-based sub-agent routing.
 *
 * extractMessageContent already parses @name tokens from text-type messages
 * and populates atMentions — this applies to both group and DM messages.
 * Removing the !isGroup guard in resolveSubAgentRoute is sufficient to
 * enable sub-agent routing in DMs without duplicating the extraction logic.
 */

import { describe, expect, it } from "vitest";
import { resolveAtAgents } from "../../../src/targeting/agent-name-matcher";
import { extractMessageContent } from "../../../src/message-utils";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { DingTalkInboundMessage } from "../../../src/types";

function makeDmMessage(text: string): DingTalkInboundMessage {
  return {
    msgtype: "text",
    text: { content: text },
    conversationType: "1", // direct message
    senderId: "user-001",
    chatbotUserId: "bot-001",
    msgId: "msg-001",
    createAt: Date.now(),
  } as unknown as DingTalkInboundMessage;
}

const cfg = {
  agents: {
    list: [
      { id: "main", name: "Main Agent", default: true },
      { id: "agent-alpha", name: "Alpha助手" },
      { id: "agent-beta", name: "Beta助手" },
    ],
  },
} as OpenClawConfig;

describe("DM sub-agent @mention routing", () => {
  it("extractMessageContent populates atMentions in DM text messages", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha 你好"));
    expect(content.atMentions).toHaveLength(1);
    expect(content.atMentions![0].name).toBe("agent-alpha");
  });

  it("does not extract @mention from quoted previewText (P1 guard)", () => {
    // Quoted prefix is stripped before @mention extraction in message-utils.ts
    const content = extractMessageContent(makeDmMessage("[引用消息] @agent-alpha 你好"));
    // The quoted prefix is stripped; only the real message text is matched
    expect(content.atMentions).toHaveLength(1);
    expect(content.atMentions![0].name).toBe("agent-alpha");
  });

  it("ignores email-like patterns in DM text", () => {
    const content = extractMessageContent(makeDmMessage("发邮件到 user@example.com 谢谢"));
    expect(content.atMentions).toHaveLength(0);
  });

  it("resolves @id to agent in DM", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha 你是谁"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents[0]).toMatchObject({ agentId: "agent-alpha", matchSource: "id" });
  });

  it("resolves @name (Chinese) to agent in DM", () => {
    const content = extractMessageContent(makeDmMessage("@Alpha助手 帮我看看"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents[0]).toMatchObject({ agentId: "agent-alpha", matchSource: "name" });
  });

  it("routes to multiple agents in DM", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha @agent-beta 一起看"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents.map((m) => m.agentId)).toEqual(
      expect.arrayContaining(["agent-alpha", "agent-beta"]),
    );
  });

  it("reports invalid agent name", () => {
    const content = extractMessageContent(makeDmMessage("@nonexistent 你好"));
    const result = resolveAtAgents(content.atMentions!, cfg);
    expect(result.matchedAgents).toHaveLength(0);
    expect(result.hasInvalidAgentNames).toBe(true);
  });
});
