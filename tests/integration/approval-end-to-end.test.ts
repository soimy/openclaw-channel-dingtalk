import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(() => Promise.resolve("tok")),
  updateCardVariables: vi.fn(() => Promise.resolve(200)),
  sendProactiveTextOrMarkdown: vi.fn(() => Promise.resolve({ ok: true })),
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: mocks.resolveApprovalOverGateway,
}));

vi.mock("../../src/card-callback-service", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/card-callback-service")>(
      "../../src/card-callback-service",
    );
  return {
    ...actual,
    updateCardVariables: mocks.updateCardVariables,
  };
});

vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: mocks.sendProactiveTextOrMarkdown,
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: mocks.getAccessToken,
}));

vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn(() => undefined),
}));

const { tryHandleApprovalCallback } = await import(
  "../../src/approval/approval-callback-handler"
);
const { tryInterceptApproveCommand } = await import(
  "../../src/approval/approval-command-intercept"
);
const { createDingTalkApprovalNativeRuntime } = await import(
  "../../src/approval/approval-native-runtime"
);

const mockGateway = mocks.resolveApprovalOverGateway;
const mockPut = mocks.updateCardVariables;
const mockSend = mocks.sendProactiveTextOrMarkdown;

const baseCfg = {
  channels: {
    dingtalk: {
      clientId: "x",
      clientSecret: "y",
      execApprovals: { approvers: ["staffA", "staffB"] },
    },
  },
} as never;

function callbackAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    summary: "allow-once",
    actionId: "allow-once",
    userId: "staffA",
    outTrackId: "ai_card_xxx",
    cardPrivateData: {
      actionIds: ["allow-once"],
      params: { action: "allow-once", approveId: "abc123" },
    },
    ...overrides,
  } as never;
}

function approvalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc",
    createdAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "rm -rf tmp",
      sessionKey: "s1",
      turnSourceChannel: "dingtalk",
      turnSourceTo: "group:c",
      turnSourceAccountId: "default",
      ...overrides,
    },
  };
}

beforeEach(() => {
  mockGateway.mockReset();
  mockPut.mockReset().mockImplementation(() => Promise.resolve(200));
  mockSend.mockReset().mockImplementation(() => Promise.resolve({ ok: true } as never));
  mocks.getAccessToken.mockReset().mockImplementation(() => Promise.resolve("tok"));
});

describe("approval end-to-end · 12 scenarios", () => {
  it("(1) multi-approver: 1st wins → 2nd already-resolved → applyExpiredPatch 仍 PUT 三变量", async () => {
    mockGateway.mockResolvedValueOnce(undefined);
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({ userId: "staffA" }),
    });
    expect(mockPut).toHaveBeenCalledWith(
      "ai_card_xxx",
      expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
      "tok",
      expect.objectContaining({ clientId: "x" }),
    );
    mockPut.mockClear();

    mockGateway.mockRejectedValueOnce(
      Object.assign(new Error("already"), { gatewayCode: "APPROVAL_ALREADY_RESOLVED" }),
    );
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({ userId: "staffB" }),
    });
    expect(mockPut).toHaveBeenCalledWith(
      "ai_card_xxx",
      expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
      "tok",
      expect.objectContaining({ clientId: "x" }),
    );
  });

  it("(2) self-approval in DM: approver 自己点 → resolveApproval ok=true → 不私聊", async () => {
    mockGateway.mockResolvedValue(undefined);
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({ userId: "staffA" }),
    });
    expect(mockGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "abc123",
        decision: "allow-once",
        senderId: "staffA",
      }),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("(3) 非 approver 点击 → 私聊提示 + 不调 gateway + 不 PUT 卡片", async () => {
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({ userId: "outsider" }),
    });
    expect(mockGateway).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:outsider",
      expect.stringContaining("无权"),
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("(4) 上游 expired event → transport.updateEntry({phase:'expired'}) → applyExpiredPatch", async () => {
    const runtime = createDingTalkApprovalNativeRuntime();
    await runtime.transport.updateEntry?.({
      cfg: baseCfg,
      entry: {
        mode: "card",
        approvalId: "abc",
        accountId: "default",
        outTrackId: "ot1",
      },
      payload: { phase: "expired" },
      phase: "expired",
    } as never);
    expect(mockPut).toHaveBeenCalledWith(
      "ot1",
      expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
      "tok",
      expect.objectContaining({ clientId: "x" }),
    );
  });

  it("(5) card 路径 HTTP 400 → 降级 markdown, entry.mode='markdown'", async () => {
    mockPut.mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400 }));
    const runtime = createDingTalkApprovalNativeRuntime();
    const entry = await runtime.transport.deliverPending({
      cfg: baseCfg,
      preparedTarget: {
        route: "card",
        to: "group:c",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
      request: approvalRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md-payload" },
    } as never);
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "group:c",
      "md-payload",
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect((entry as { mode?: string } | null)?.mode).toBe("markdown");
  });

  it("(6) card 路径 ETIMEDOUT → return null, 不发 markdown", async () => {
    mockPut.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    const runtime = createDingTalkApprovalNativeRuntime();
    const entry = await runtime.transport.deliverPending({
      cfg: baseCfg,
      preparedTarget: {
        route: "card",
        to: "group:c",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
      request: approvalRequest(),
      pendingPayload: { approvalId: "abc", markdownText: "md" },
    } as never);
    expect(entry).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("(7) /approve 命令路径 → 调 gateway, 命令被早期拦截", async () => {
    mockGateway.mockResolvedValue(undefined);
    const intercepted = await tryInterceptApproveCommand({
      cfg: baseCfg,
      accountId: "default",
      text: "/approve abc once",
      senderId: "staffA",
    });
    expect(intercepted).toBe(true);
    expect(mockGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "abc",
        decision: "allow-once",
        senderId: "staffA",
      }),
    );
  });

  it("(8) 未配置 approvers → availability.shouldHandle=false", async () => {
    const cfgNoApprovers = {
      channels: { dingtalk: { clientId: "x", clientSecret: "y" } },
    } as never;
    const runtime = createDingTalkApprovalNativeRuntime();
    expect(
      runtime.availability.shouldHandle({
        cfg: cfgNoApprovers,
        accountId: "default",
        request: approvalRequest() as never,
      } as never),
    ).toBe(false);
  });

  it("(9) turnSourceChannel != dingtalk (CLI) → availability.shouldHandle=false", async () => {
    const runtime = createDingTalkApprovalNativeRuntime();
    expect(
      runtime.availability.shouldHandle({
        cfg: baseCfg,
        accountId: "default",
        request: approvalRequest({ turnSourceChannel: "codex-cli" }) as never,
      } as never),
    ).toBe(false);
  });

  it("(10) Channel 重启后旧按钮 → gateway 抛 APPROVAL_NOT_FOUND → applyExpiredPatch 三变量, 无终态文字", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("not found"), { gatewayCode: "APPROVAL_NOT_FOUND" }),
    );
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({ userId: "staffA" }),
    });
    const vars = mockPut.mock.calls[0][1] as Record<string, string>;
    expect(vars).toEqual(
      expect.objectContaining({ show_approve_btns: "false", approveId: "" }),
    );
    expect(vars).not.toHaveProperty("status");
    expect(vars).not.toHaveProperty("statusFooter");
    expect(vars).not.toHaveProperty("approval_status");
  });

  it("(11) exec invalid-decision (APPROVAL_ALLOW_ALWAYS_UNAVAILABLE) → 不 PUT + 私聊重选", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" },
      }),
    );
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({
        userId: "staffA",
        actionId: "allow-always",
        cardPrivateData: {
          actionIds: ["allow-always"],
          params: { action: "allow-always", approveId: "abc123" },
        },
      }),
    });
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("不支持 allow-always"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });

  it("(12) plugin invalid-decision (allowedDecisions=['allow-once']) → 私聊含 allowed 列表", async () => {
    mockGateway.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        gatewayCode: "INVALID_REQUEST",
        details: { allowedDecisions: ["allow-once"] },
      }),
    );
    await tryHandleApprovalCallback({
      cfg: baseCfg,
      accountId: "default",
      analysis: callbackAnalysis({
        userId: "staffA",
        actionId: "allow-always",
        cardPrivateData: {
          actionIds: ["allow-always"],
          params: { action: "allow-always", approveId: "plugin:xyz789" },
        },
      }),
    });
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "user:staffA",
      expect.stringContaining("allow-once"),
      expect.objectContaining({ forceMarkdown: true }),
    );
  });
});
