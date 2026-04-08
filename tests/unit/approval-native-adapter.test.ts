import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("axios");
vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("mock-token"),
}));
vi.mock("../../src/peer-id-registry", () => ({
  resolveOriginalPeerId: vi.fn((id: string) => id),
}));
vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
  return {
    ...actual,
    getConfig: vi.fn(() => ({
      appKey: "k",
      appSecret: "s",
      clientId: "client-123",
      enabled: true,
    })),
  };
});
vi.mock("../../src/logger-context", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import axios from "axios";
import { dingtalkApprovalNativeRuntimeAdapter } from "../../src/approval/approval-native-adapter";

const mockedAxios = vi.mocked(axios);

const execRequest = {
  id: "exec:abc",
  expiresAtMs: Date.now() + 120_000,
  request: {
    command: "rm -rf /tmp/foo",
    cwd: "/work",
    agentId: "main",
    sessionKey: "agent:main:dingtalk:group:cid-1:user-1",
    turnSourceChannel: "dingtalk",
    turnSourceTo: "dingtalk:group:cid-1",
  },
} as never;

const pluginRequest = {
  id: "plugin:xyz",
  expiresAtMs: Date.now() + 120_000,
  request: {
    title: "Delete file",
    description: "Delete /tmp/foo",
    severity: "warning",
    toolName: "shell_exec",
    pluginId: "bash-tools",
    agentId: "main",
    sessionKey: "agent:main:dingtalk:direct:u-1",
    turnSourceChannel: "dingtalk",
    turnSourceTo: "dingtalk:direct:u-1",
  },
} as never;

const cfg = {} as never;

describe("dingtalkApprovalNativeRuntimeAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.post = vi.fn().mockResolvedValue({
      data: { result: { outTrackId: "effective-track-id" } },
    });
    mockedAxios.put = vi.fn().mockResolvedValue({ data: {} });
  });

  describe("availability", () => {
    it("shouldHandle returns true for dingtalk turn source", () => {
      expect(
        dingtalkApprovalNativeRuntimeAdapter.availability.shouldHandle({
          cfg,
          accountId: null,
          request: execRequest,
        }),
      ).toBe(true);
    });

    it("shouldHandle returns false for non-dingtalk turn source", () => {
      const foreign = {
        ...execRequest,
        request: { ...execRequest.request, turnSourceChannel: "telegram" },
      } as never;
      expect(
        dingtalkApprovalNativeRuntimeAdapter.availability.shouldHandle({
          cfg,
          accountId: null,
          request: foreign,
        }),
      ).toBe(false);
    });

    it("isConfigured true when DingTalk config resolves", () => {
      expect(
        dingtalkApprovalNativeRuntimeAdapter.availability.isConfigured({
          cfg,
          accountId: null,
        }),
      ).toBe(true);
    });
  });

  describe("presentation", () => {
    it("buildPendingPayload wraps exec card param map + outTrackId", async () => {
      const payload = await dingtalkApprovalNativeRuntimeAdapter.presentation.buildPendingPayload({
        cfg,
        accountId: null,
        request: execRequest,
        approvalKind: "exec",
        nowMs: Date.now(),
        view: {} as never,
      });
      expect(payload.outTrackId).toMatch(/^approval_/);
      expect(payload.cardParamMap.content).toContain("命令审批");
      expect(payload.cardParamMap.btns).toContain("allow-once");
    });

    it("buildPendingPayload handles plugin request", async () => {
      const payload = await dingtalkApprovalNativeRuntimeAdapter.presentation.buildPendingPayload({
        cfg,
        accountId: null,
        request: pluginRequest,
        approvalKind: "plugin",
        nowMs: Date.now(),
        view: {} as never,
      });
      expect(payload.cardParamMap.content).toContain("操作审批");
    });

    it("buildResolvedResult maps view.decision to update action", async () => {
      const action = await dingtalkApprovalNativeRuntimeAdapter.presentation.buildResolvedResult({
        cfg,
        accountId: null,
        request: execRequest,
        resolved: {} as never,
        view: { decision: "allow-once" } as never,
        entry: {} as never,
      });
      expect(action).toEqual({
        kind: "update",
        payload: { phase: "resolved", decision: "allow-once" },
      });
    });

    it("buildExpiredResult returns expired update action", async () => {
      const action = await dingtalkApprovalNativeRuntimeAdapter.presentation.buildExpiredResult({
        cfg,
        accountId: null,
        request: execRequest,
        view: {} as never,
        entry: {} as never,
      });
      expect(action).toEqual({ kind: "update", payload: { phase: "expired" } });
    });
  });

  describe("transport", () => {
    it("prepareTarget detects group conversation (cid prefix) and propagates accountId", async () => {
      const prepared = await dingtalkApprovalNativeRuntimeAdapter.transport.prepareTarget({
        cfg,
        accountId: "acc-1",
        plannedTarget: {
          surface: "origin",
          target: { to: "cid12345" },
          reason: "preferred",
        },
        request: execRequest,
        approvalKind: "exec",
        view: {} as never,
        pendingPayload: {} as never,
      });
      expect(prepared).not.toBeNull();
      expect(prepared?.dedupeKey).toBe("dingtalk:cid12345");
      expect(prepared?.target.isGroup).toBe(true);
      expect(prepared?.target.accountId).toBe("acc-1");
    });

    it("prepareTarget detects direct message (raw user id, no cid prefix)", async () => {
      const prepared = await dingtalkApprovalNativeRuntimeAdapter.transport.prepareTarget({
        cfg,
        accountId: null,
        plannedTarget: {
          surface: "origin",
          target: { to: "user-1" },
          reason: "preferred",
        },
        request: execRequest,
        approvalKind: "exec",
        view: {} as never,
        pendingPayload: {} as never,
      });
      expect(prepared?.target.isGroup).toBe(false);
    });

    it("deliverPending posts createAndDeliver and returns entry with outTrackId", async () => {
      const pendingPayload = await dingtalkApprovalNativeRuntimeAdapter.presentation.buildPendingPayload({
        cfg,
        accountId: null,
        request: execRequest,
        approvalKind: "exec",
        nowMs: Date.now(),
        view: {} as never,
      });
      const entry = await dingtalkApprovalNativeRuntimeAdapter.transport.deliverPending({
        cfg,
        accountId: null,
        plannedTarget: { surface: "origin", target: { to: "dingtalk:group:cid1" }, reason: "preferred" },
        preparedTarget: { conversationId: "cid1", isGroup: true, accountId: null },
        request: execRequest,
        approvalKind: "exec",
        view: {} as never,
        pendingPayload,
      });
      expect(entry).not.toBeNull();
      expect(entry?.outTrackId).toBe("effective-track-id");
      expect(entry?.approvalId).toBe("exec:abc");
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining("/createAndDeliver"),
        expect.objectContaining({ outTrackId: expect.stringMatching(/^approval_/) }),
        expect.any(Object),
      );
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining("/card/streaming"),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("deliverPending returns null on API failure", async () => {
      mockedAxios.post = vi.fn().mockRejectedValue(new Error("network boom"));
      const entry = await dingtalkApprovalNativeRuntimeAdapter.transport.deliverPending({
        cfg,
        accountId: null,
        plannedTarget: { surface: "origin", target: { to: "dingtalk:group:cid1" }, reason: "preferred" },
        preparedTarget: { conversationId: "cid1", isGroup: true, accountId: null },
        request: execRequest,
        approvalKind: "exec",
        view: {} as never,
        pendingPayload: { outTrackId: "approval_x", cardParamMap: { content: "hi" }, content: "hi" },
      });
      expect(entry).toBeNull();
    });

    it("updateEntry PUTs card instance with resolved status", async () => {
      await dingtalkApprovalNativeRuntimeAdapter.transport.updateEntry!({
        cfg,
        accountId: null,
        entry: {
          approvalId: "exec:abc",
          outTrackId: "track-1",
          conversationId: "cid1",
          accountId: null,
        },
        payload: { phase: "resolved", decision: "allow-once" },
        phase: "resolved",
      });
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining("/card/instances"),
        expect.objectContaining({
          outTrackId: "track-1",
          cardData: expect.objectContaining({
            cardParamMap: expect.objectContaining({
              status: expect.stringContaining("已允许"),
              hasAction: "false",
            }),
          }),
        }),
        expect.any(Object),
      );
    });

    it("updateEntry expired phase shows expired status", async () => {
      await dingtalkApprovalNativeRuntimeAdapter.transport.updateEntry!({
        cfg,
        accountId: null,
        entry: {
          approvalId: "exec:abc",
          outTrackId: "track-1",
          conversationId: "cid1",
          accountId: null,
        },
        payload: { phase: "expired" },
        phase: "expired",
      });
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          cardData: expect.objectContaining({
            cardParamMap: expect.objectContaining({
              status: expect.stringContaining("已过期"),
            }),
          }),
        }),
        expect.any(Object),
      );
    });
  });
});
