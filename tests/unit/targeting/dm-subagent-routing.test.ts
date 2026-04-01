/**
 * Tests for DM (direct message) @mention-based sub-agent routing.
 *
 * extractMessageContent already parses @name tokens from text-type messages
 * and populates atMentions — this applies to both group and DM messages.
 * Removing the !isGroup guard in resolveSubAgentRoute is sufficient to
 * enable sub-agent routing in DMs without duplicating the extraction logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAtAgents } from "../../../src/targeting/agent-name-matcher";
import { resolveSubAgentRoute } from "../../../src/targeting/agent-routing";
import { extractMessageContent } from "../../../src/message-utils";
import { sendBySession } from "../../../src/send-service";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { DingTalkConfig, DingTalkInboundMessage, Logger, MessageContent } from "../../../src/types";

vi.mock("../../../src/send-service", () => ({
  sendBySession: vi.fn(),
}));

const KNOWN_COMMANDS = new Set([
  "/new", "/stop", "/clear", "/compact", "/reasoning", "/model",
  "/config", "/session", "/session-alias", "/whoami", "/whereami",
  "/help", "/status", "/tools", "/reset", "/think", "/verbose",
  "/bash", "/activation", "/agents", "/restart", "/usage",
]);

vi.mock("openclaw/plugin-sdk/command-auth", () => ({
  maybeResolveTextAlias: (raw: string) => {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed.startsWith("/")) return null;
    const token = trimmed.match(/^\/([^\s:]+)(?:\s|$)/);
    if (!token) return null;
    const key = `/${token[1]}`;
    return KNOWN_COMMANDS.has(key) ? key : null;
  },
}));

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

const dingtalkConfig = {
  dmPolicy: "open",
  messageType: "markdown",
} as DingTalkConfig;

const log = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as Logger;

describe("DM sub-agent @mention routing", () => {
  it("extractMessageContent populates atMentions in DM text messages", () => {
    const content = extractMessageContent(makeDmMessage("@agent-alpha 你好"));
    expect(content.atMentions).toHaveLength(1);
    expect(content.atMentions![0].name).toBe("agent-alpha");
  });

  it("strips quoted prefix and still extracts @mention from real message text", () => {
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

describe("resolveSubAgentRoute in DM", () => {
  const mockedSendBySession = vi.mocked(sendBySession);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not include atUserId in DM fallback notice", async () => {
    const extractedContent: MessageContent = {
      text: "@nonexistent 你好",
      messageType: "text",
      atMentions: [{ name: "nonexistent" }],
    };

    const result = await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup: false,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      senderId: "user-001",
      log,
    });

    expect(result).toBeNull();
    expect(mockedSendBySession).toHaveBeenCalledTimes(1);
    const options = mockedSendBySession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options).toMatchObject({ log });
    expect(options).not.toHaveProperty("atUserId");
  });

  it("keeps atUserId in group fallback notice", async () => {
    const extractedContent: MessageContent = {
      text: "@nonexistent 你好",
      messageType: "text",
      atMentions: [{ name: "nonexistent" }],
      atUserDingtalkIds: [],
    };

    await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup: true,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      senderId: "user-001",
      log,
    });

    const options = mockedSendBySession.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options).toMatchObject({ log, atUserId: "user-001" });
  });

  it("skips sub-agent routing for /learn commands in DM", async () => {
    const extractedContent: MessageContent = {
      text: "/learn list",
      messageType: "text",
      atMentions: [{ name: "agent-alpha" }],
    };

    const result = await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup: false,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      senderId: "user-001",
      log,
    });

    expect(result).toBeNull();
    expect(mockedSendBySession).not.toHaveBeenCalled();
  });

  it.each(["/new", "/stop", "/clear", "/compact", "/reasoning stream", "/reasoning on", "/model", "/config", "/session", "/whoami", "/whereami", "/session-alias show", "/session-alias clear"])(
    "skips sub-agent routing for slash command '%s' with @mention",
    async (command) => {
      const extractedContent: MessageContent = {
        text: `@agent-alpha ${command}`,
        messageType: "text",
        atMentions: [{ name: "agent-alpha" }],
      };

      const result = await resolveSubAgentRoute({
        extractedContent,
        cfg,
        isGroup: false,
        dingtalkConfig,
        sessionWebhook: "https://session.webhook",
        senderId: "user-001",
        log,
      });

      expect(result).toBeNull();
      expect(mockedSendBySession).not.toHaveBeenCalled();
    },
  );

  it("skips sub-agent routing for slash commands in group chat", async () => {
    const extractedContent: MessageContent = {
      text: "/new",
      messageType: "text",
      atMentions: [{ name: "agent-alpha" }],
      atUserDingtalkIds: [],
    };

    const result = await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup: true,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      senderId: "user-001",
      log,
    });

    expect(result).toBeNull();
    expect(mockedSendBySession).not.toHaveBeenCalled();
  });

  it("still routes to sub-agent for normal @mention messages", async () => {
    const extractedContent: MessageContent = {
      text: "@agent-alpha 你好",
      messageType: "text",
      atMentions: [{ name: "agent-alpha" }],
    };

    const result = await resolveSubAgentRoute({
      extractedContent,
      cfg,
      isGroup: false,
      dingtalkConfig,
      sessionWebhook: "https://session.webhook",
      senderId: "user-001",
      log,
    });

    expect(result).not.toBeNull();
    expect(result?.matchedAgents[0]?.agentId).toBe("agent-alpha");
  });
});
