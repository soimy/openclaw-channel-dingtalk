import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageContent } from "../../src/platform/types";
import * as feedbackLearningService from "../../src/command/feedback-learning-service";
import {
  applyManualGlobalLearningRule,
  applyManualTargetLearningRule,
} from "../../src/command/feedback-learning-service";
import { handleInboundCommandDispatch } from "../../src/command/inbound-command-dispatch-service";
import {
  clearSessionPeerOverride,
  getSessionPeerOverride,
  setSessionPeerOverride,
} from "../../src/targeting/session-peer-store";

describe("inbound-command-dispatch-service", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-inbound-command-dispatch-"));
    storePath = path.join(tempDir, "session-store.json");
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
    storePath = "";
  });

  function buildParams(overrides: Partial<Parameters<typeof handleInboundCommandDispatch>[0]> = {}) {
    const sendReply = vi.fn().mockResolvedValue(undefined);
    return {
      params: {
        cfg: { commands: { ownerAllowFrom: ["dingtalk:owner-test-id"] } },
        accountId: "main",
        dingtalkConfig: { allowFrom: ["owner-test-id"] } as any,
        senderId: "owner-test-id",
        isDirect: true,
        extractedText: "hello",
        messageType: "text" as MessageContent["messageType"],
        data: {
          conversationId: "cid_dm_1",
          senderId: "owner-test-id",
          senderStaffId: "staff_1",
        },
        accountStorePath: storePath,
        currentSessionSourceKind: "direct" as const,
        currentSessionSourceId: "owner-test-id",
        peerIdOverride: undefined,
        sessionPeer: {
          peerId: "peer-default",
        },
        sendReply,
        clearSessionPeerOverride,
        setSessionPeerOverride,
        ...overrides,
      },
      sendReply,
    };
  }

  it("returns whoami reply for direct command", async () => {
    const { params, sendReply } = buildParams({
      extractedText: "/learn whoami",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("senderId");
    expect(sendReply.mock.calls[0]?.[0]).toContain("owner-test-id");
  });

  it("writes session alias override for owner command", async () => {
    const { params, sendReply } = buildParams({
      extractedText: "/session-alias set shared-dev",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("shared-dev");
    expect(getSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "direct",
      sourceId: "owner-test-id",
    })).toBe("shared-dev");
  });

  it("denies owner-only write commands for non-owner senders", async () => {
    const { params, sendReply } = buildParams({
      senderId: "guest-user",
      data: {
        conversationId: "cid_dm_1",
        senderId: "guest-user",
        senderStaffId: "staff_2",
      },
      extractedText: "/learn global 只允许 owner 写入",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("仅允许 owner 使用");
  });

  it("denies owner-only write commands for non-owner group senders", async () => {
    const { params, sendReply } = buildParams({
      isDirect: false,
      senderId: "guest-user",
      currentSessionSourceKind: "group",
      currentSessionSourceId: "cid_group_guest",
      data: {
        conversationId: "cid_group_guest",
        senderId: "guest-user",
        senderStaffId: "staff_guest",
      },
      extractedText: "/session-alias show",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("仅允许 owner 使用");
  });

  it("clears existing session alias override", async () => {
    setSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "direct",
      sourceId: "owner-test-id",
      peerId: "shared-dev",
    });
    const { params, sendReply } = buildParams({
      extractedText: "/session-alias clear",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("已清除当前会话共享会话别名");
    expect(getSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "direct",
      sourceId: "owner-test-id",
    })).toBeUndefined();
  });

  it("rejects invalid session alias values", async () => {
    const { params, sendReply } = buildParams({
      extractedText: "/session-alias set shared:dev",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("共享会话别名不合法");
    expect(getSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "direct",
      sourceId: "owner-test-id",
    })).toBeUndefined();
  });

  it("binds and unbinds a remote group alias for owner commands", async () => {
    const { params: bindParams, sendReply: bindReply } = buildParams({
      extractedText: "/session-alias bind group cid_group_9 team-room",
    });

    await expect(handleInboundCommandDispatch(bindParams)).resolves.toBe(true);

    expect(bindReply).toHaveBeenCalledTimes(1);
    expect(getSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "group",
      sourceId: "cid_group_9",
    })).toBe("team-room");

    const { params: unbindParams, sendReply: unbindReply } = buildParams({
      extractedText: "/session-alias unbind group cid_group_9",
    });

    await expect(handleInboundCommandDispatch(unbindParams)).resolves.toBe(true);

    expect(unbindReply).toHaveBeenCalledTimes(1);
    expect(unbindReply.mock.calls[0]?.[0]).toContain("已解除共享会话别名绑定");
    expect(getSessionPeerOverride({
      storePath,
      accountId: "main",
      sourceKind: "group",
      sourceId: "cid_group_9",
    })).toBeUndefined();
  });

  it("returns whereami details for group commands", async () => {
    const { params, sendReply } = buildParams({
      isDirect: false,
      extractedText: "/learn whereami",
      data: {
        conversationId: "cid_group_1",
        senderId: "owner-test-id",
        senderStaffId: "staff_1",
      },
      currentSessionSourceKind: "group",
      currentSessionSourceId: "cid_group_1",
      sessionPeer: {
        peerId: "cid_group_1",
      },
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("conversationType: `group`");
    expect(sendReply.mock.calls[0]?.[0]).toContain("cid_group_1");
  });

  it("lists saved learning rules and target sets", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "全局规则一",
    });
    const { params, sendReply } = buildParams({
      extractedText: "/learn list",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("[global]");
    expect(sendReply.mock.calls[0]?.[0]).toContain("全局规则一");
  });

  it("returns forced reply when a manual global rule exactly matches", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "当用户问“暗号是多少”时，必须回答“天王盖地虎”。",
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { params, sendReply } = buildParams({
      log: log as any,
      dingtalkConfig: {
        allowFrom: ["owner-test-id"],
        learningEnabled: true,
        learningAllowManualGlobalRules: true,
      } as any,
      extractedText: "暗号是多少",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("天王盖地虎");
    // The override bypasses the model, so it has to leave an audit trail.
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("[DingTalk][Learning][ForcedReply]"),
    );
  });

  it("passes through the original messageType for forced reply resolution", async () => {
    const spy = vi.spyOn(feedbackLearningService, "resolveManualForcedReply").mockReturnValue(null);
    const { params } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "图片口令",
      messageType: "picture",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.content).toMatchObject({
      text: "图片口令",
      messageType: "picture",
    });
    spy.mockRestore();
  });

  it("prefers target forced reply over global forced reply", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "当用户问“暗号是多少”时，必须回答“全局答案”。",
    });
    applyManualTargetLearningRule({
      storePath,
      accountId: "main",
      targetId: "cid_dm_1",
      instruction: "当用户问“暗号是多少”时，必须回答“当前会话答案”。",
    });
    const { params, sendReply } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "暗号是多少",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0]?.[0]).toContain("当前会话答案");
  });

  it("marks stored account-wide rules as not applied while the switch is off", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "历史全局规则",
    });
    // Learning itself is on; only the account-wide opt-in is missing, so the rule
    // must report that specific reason rather than the master-switch one.
    const { params, sendReply } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "/learn list",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).toContain("enabled, not applied (global rules disabled)");
    expect(sendReply.mock.calls[0]?.[0]).toContain("历史全局规则");
  });

  it("marks every rule as not applied while the learning master switch is off", async () => {
    applyManualTargetLearningRule({
        storePath,
        accountId: "main",
        targetId: "cid_dm_1",
        instruction: "会话级规则",
    });
    // buildParams leaves learningEnabled unset (false).
    const { params, sendReply } = buildParams({ extractedText: "/learn list" });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).toContain("enabled, not applied (learning disabled)");
  });

  it("marks a rule as not applied once it is past the TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      applyManualTargetLearningRule({
        storePath,
        accountId: "main",
        targetId: "cid_dm_1",
        instruction: "会过期的会话级规则",
      });

      vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
      const { params, sendReply } = buildParams({
        dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
        extractedText: "/learn list",
      });

      await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
      expect(sendReply.mock.calls[0]?.[0]).toContain("enabled, not applied (expired)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses account-wide rule writes while manual global rules are disabled", async () => {
    const refused = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "/learn global 当用户问“新口令”时，必须回答“新答案”。",
    });

    await expect(handleInboundCommandDispatch(refused.params)).resolves.toBe(true);
    expect(refused.sendReply.mock.calls[0]?.[0]).toContain("learningAllowManualGlobalRules");
    // The refusal points at the session-scoped alternatives.
    expect(refused.sendReply.mock.calls[0]?.[0]).toContain("/learn targets");

    const listed = buildParams({ extractedText: "/learn list" });
    await handleInboundCommandDispatch(listed.params);
    expect(listed.sendReply.mock.calls[0]?.[0]).not.toContain("新口令");
  });

  it("writes account-wide rules once manual global rules are allowed", async () => {
    const { params, sendReply } = buildParams({
      dingtalkConfig: {
        allowFrom: ["owner-test-id"],
        learningEnabled: true,
        learningAllowManualGlobalRules: true,
      } as any,
      extractedText: "/learn global 账号级规则一",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).toContain("ruleId");

    const listed = buildParams({ extractedText: "/learn list" });
    await handleInboundCommandDispatch(listed.params);
    expect(listed.sendReply.mock.calls[0]?.[0]).toContain("账号级规则一");
  });

  it("keeps explicit multi-target writes available without the global switch", async () => {
    const { params, sendReply } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "/learn targets cid_a,cid_b #@# 多目标规则",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).not.toContain("learningAllowManualGlobalRules");
  });

  it("ignores account-wide forced replies unless global rules are explicitly allowed", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "当用户问“暗号是多少”时，必须回答“全局答案”。",
    });
    const { params, sendReply } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "暗号是多少",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("still fires a target-scoped forced reply without the global opt-in", async () => {
    applyManualTargetLearningRule({
      storePath,
      accountId: "main",
      targetId: "cid_dm_1",
      instruction: "当用户问“暗号是多少”时，必须回答“本会话答案”。",
    });
    const { params, sendReply } = buildParams({
      dingtalkConfig: { allowFrom: ["owner-test-id"], learningEnabled: true } as any,
      extractedText: "暗号是多少",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).toContain("本会话答案");
  });

  it("does not fire a persisted forced reply while learning is disabled", async () => {
    applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "当用户问“暗号是多少”时，必须回答“天王盖地虎”。",
    });
    // buildParams defaults to learningEnabled unset (false).
    const { params, sendReply } = buildParams({ extractedText: "暗号是多少" });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(false);
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("refuses to write learning rules while learning is disabled", async () => {
    const refused = buildParams({ extractedText: "/learn global 当用户问“新口令”时，必须回答“新答案”。" });

    await expect(handleInboundCommandDispatch(refused.params)).resolves.toBe(true);
    expect(refused.sendReply.mock.calls[0]?.[0]).toContain("learningEnabled");

    const listed = buildParams({ extractedText: "/learn list" });
    await handleInboundCommandDispatch(listed.params);
    expect(listed.sendReply.mock.calls[0]?.[0]).not.toContain("新口令");
  });

  it("keeps cleanup commands available while learning is disabled", async () => {
    const applied = applyManualGlobalLearningRule({
      storePath,
      accountId: "main",
      instruction: "待清理规则",
    });
    const { params, sendReply } = buildParams({
      extractedText: `/learn delete ${applied?.ruleId}`,
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(true);
    expect(sendReply.mock.calls[0]?.[0]).not.toContain("learningEnabled");
  });

  it("returns false for non-command text", async () => {
    const { params, sendReply } = buildParams({
      extractedText: "随便聊一句普通话",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(false);

    expect(sendReply).not.toHaveBeenCalled();
  });
});
