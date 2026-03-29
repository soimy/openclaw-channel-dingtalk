import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleInboundCommandDispatch } from "../../src/command/inbound-command-dispatch-service";
import {
  clearSessionPeerOverride,
  getSessionPeerOverride,
  setSessionPeerOverride,
} from "../../src/session-peer-store";

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

  it("returns false for non-command text", async () => {
    const { params, sendReply } = buildParams({
      extractedText: "随便聊一句普通话",
    });

    await expect(handleInboundCommandDispatch(params)).resolves.toBe(false);

    expect(sendReply).not.toHaveBeenCalled();
  });
});
