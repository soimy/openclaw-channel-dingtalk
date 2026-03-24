/**
 * Tests for DM (direct message) @mention-based sub-agent routing.
 *
 * In group messages, DingTalk populates atMentions via the SDK.
 * In DMs, atMentions is always empty — the plugin parses @name tokens from
 * message text instead, enabling sub-agent routing in private conversations.
 */

import { describe, expect, it } from "vitest";
import { resolveAtAgents } from "../../../src/targeting/agent-name-matcher";
import type { AtMention } from "../../../src/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

// Expose the private extractTextAtMentions helper indirectly by testing the
// full resolution flow with text-derived AtMention objects (simulating what
// resolveSubAgentRoute does for DM messages).
function simulateDmAtMentions(text: string): AtMention[] {
  const textForExtraction = text.replace(/^\[引用[^\]]*\]\s*/, "");
  const matches = textForExtraction.matchAll(/(?<!\w)@([^\s@.]+)(?!\.\w)/g);
  const mentions: AtMention[] = [];
  for (const match of matches) {
    mentions.push({ name: match[1].trim() });
  }
  return mentions;
}

const cfg = {
  agents: {
    list: [
      { id: "main", name: "Main Agent", default: true },
      { id: "agent-alpha", name: "Alpha助手" },
      { id: "agent-beta", name: "Beta助手" },
      { id: "agent-gamma", name: "agent-gamma" },
    ],
  },
} as OpenClawConfig;

describe("DM sub-agent @mention routing", () => {
  describe("extractTextAtMentions (via simulateDmAtMentions)", () => {
    it("extracts @id from plain DM text", () => {
      const mentions = simulateDmAtMentions("@agent-alpha 帮我看一下这个问题");
      expect(mentions).toHaveLength(1);
      expect(mentions[0].name).toBe("agent-alpha");
    });

    it("extracts multiple @mentions from text", () => {
      const mentions = simulateDmAtMentions("@agent-alpha @agent-beta 一起看一下");
      expect(mentions).toHaveLength(2);
      expect(mentions.map((m) => m.name)).toEqual(["agent-alpha", "agent-beta"]);
    });

    it("does not extract email-like patterns", () => {
      const mentions = simulateDmAtMentions("发邮件到 user@example.com 谢谢");
      expect(mentions).toHaveLength(0);
    });

    it("strips quoted prefix before extracting", () => {
      const mentions = simulateDmAtMentions("[引用消息] @agent-alpha 你好");
      expect(mentions).toHaveLength(1);
      expect(mentions[0].name).toBe("agent-alpha");
    });

    it("returns empty array when no @mention in text", () => {
      const mentions = simulateDmAtMentions("普通消息，没有 @ 任何人");
      expect(mentions).toHaveLength(0);
    });
  });

  describe("resolveAtAgents with text-derived DM mentions", () => {
    it("matches agent by id in DM text", () => {
      const mentions = simulateDmAtMentions("@agent-alpha 你是谁");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("agent-alpha");
      expect(result.matchedAgents[0].matchSource).toBe("id");
    });

    it("matches agent by name (Chinese) in DM text", () => {
      const mentions = simulateDmAtMentions("@Alpha助手 帮我看看");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("agent-alpha");
      expect(result.matchedAgents[0].matchSource).toBe("name");
    });

    it("matches agent when id equals name (agent-gamma)", () => {
      const mentions = simulateDmAtMentions("@agent-gamma 帮我处理一下");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(1);
      expect(result.matchedAgents[0].agentId).toBe("agent-gamma");
    });

    it("routes to multiple agents in a single DM message", () => {
      const mentions = simulateDmAtMentions("@agent-alpha @agent-beta 一起看一下");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(2);
      expect(result.matchedAgents.map((m) => m.agentId)).toContain("agent-alpha");
      expect(result.matchedAgents.map((m) => m.agentId)).toContain("agent-beta");
    });

    it("reports hasInvalidAgentNames when unrecognised @name present", () => {
      const mentions = simulateDmAtMentions("@nonexistent-agent 你好");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(0);
      expect(result.hasInvalidAgentNames).toBe(true);
      expect(result.unmatchedNames).toEqual(["nonexistent-agent"]);
    });

    it("returns no match when text has no @mention", () => {
      const mentions = simulateDmAtMentions("普通消息");
      const result = resolveAtAgents(mentions, cfg);
      expect(result.matchedAgents).toHaveLength(0);
      expect(result.hasInvalidAgentNames).toBe(false);
    });
  });
});
