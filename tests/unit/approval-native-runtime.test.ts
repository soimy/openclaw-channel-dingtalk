import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/approval/approval-config", () => ({
  getExecApprovalsConfig: vi.fn(() => ({ isNativeDeliveryEnabled: true })),
  listExecApprovers: vi.fn(() => ["staffA"]),
}));
vi.mock("../../src/approval/approval-card-locator", () => ({
  findActiveAgentCard: vi.fn(),
}));
vi.mock("../../src/approval/approval-card-patcher", () => ({
  applyPendingPatch: vi.fn().mockResolvedValue(undefined),
  applyResolvedPatch: vi.fn().mockResolvedValue(undefined),
  applyExpiredPatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/approval/approval-markdown-render", () => ({
  buildExecApprovalMarkdown: vi.fn(() => "exec-md"),
  buildPluginApprovalMarkdown: vi.fn(() => "plugin-md"),
}));
vi.mock("../../src/card/card-run-registry", () => ({
  resolveCardRun: vi.fn(),
  isActiveCardRun: vi.fn(() => true),
}));
vi.mock("../../src/send-service", () => ({
  sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("tok"),
}));
vi.mock("../../src/config", () => ({
  getConfig: vi.fn(() => ({ clientId: "x", bypassProxyForSend: false })),
}));
vi.mock("../../src/logger-context", () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn() })),
}));

const { createDingTalkApprovalNativeRuntime } = await import(
  "../../src/approval/approval-native-runtime"
);
const { getExecApprovalsConfig, listExecApprovers } = await import(
  "../../src/approval/approval-config"
);
const { findActiveAgentCard } = await import("../../src/approval/approval-card-locator");
const { applyExpiredPatch, applyPendingPatch, applyResolvedPatch } = await import(
  "../../src/approval/approval-card-patcher"
);
const { sendProactiveTextOrMarkdown } = await import("../../src/send-service");
const { resolveCardRun, isActiveCardRun } = await import("../../src/card/card-run-registry");
const { getAccessToken } = await import("../../src/auth");

const mockGetApprovalsConfig = vi.mocked(getExecApprovalsConfig);
const mockListApprovers = vi.mocked(listExecApprovers);
const mockFindActiveCard = vi.mocked(findActiveAgentCard);
const mockPending = vi.mocked(applyPendingPatch);
const mockResolved = vi.mocked(applyResolvedPatch);
const mockExpired = vi.mocked(applyExpiredPatch);
const mockSend = vi.mocked(sendProactiveTextOrMarkdown);
const mockResolveCardRun = vi.mocked(resolveCardRun);
const mockIsActiveCardRun = vi.mocked(isActiveCardRun);
const mockGetAccessToken = vi.mocked(getAccessToken);

function request(payload: Record<string, unknown> = {}) {
  return {
    id: "abc123",
    createdAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "rm -rf tmp",
      sessionKey: "session-A",
      turnSourceChannel: "dingtalk",
      turnSourceTo: "group:cid_xxx",
      turnSourceAccountId: "default",
      ...payload,
    },
  } as never;
}

describe("approval-native-runtime", () => {
  const runtime = createDingTalkApprovalNativeRuntime();

  beforeEach(() => {
    mockGetApprovalsConfig.mockReset().mockReturnValue({ isNativeDeliveryEnabled: true } as never);
    mockListApprovers.mockReset().mockReturnValue(["staffA"]);
    mockFindActiveCard.mockReset();
    mockPending.mockReset().mockResolvedValue(undefined);
    mockResolved.mockReset().mockResolvedValue(undefined);
    mockExpired.mockReset().mockResolvedValue(undefined);
    mockSend.mockReset().mockResolvedValue({ ok: true } as never);
    mockResolveCardRun.mockReset().mockReturnValue({ card: { state: "2" } } as never);
    mockIsActiveCardRun.mockReset().mockReturnValue(true);
    mockGetAccessToken.mockReset().mockResolvedValue("tok");
  });

  it("handles only configured DingTalk origin requests with approvers", () => {
    expect(runtime.availability.shouldHandle({ cfg: {} as never, accountId: "default", request: request() })).toBe(true);
    expect(
      runtime.availability.shouldHandle({
        cfg: {} as never,
        accountId: "default",
        request: request({ turnSourceChannel: "discord" }),
      }),
    ).toBe(false);

    mockListApprovers.mockReturnValue([]);
    expect(runtime.availability.shouldHandle({ cfg: {} as never, accountId: "default", request: request() })).toBe(false);
  });

  it("builds pending payload using the upstream approval kind", async () => {
    await expect(Promise.resolve(
      runtime.presentation.buildPendingPayload({
        cfg: {} as never,
        request: request(),
        approvalKind: "exec",
        nowMs: Date.now(),
        view: {} as never,
      }),
    )).resolves.toEqual({ approvalId: "abc123", markdownText: "exec-md" });
  });

  it("prepareTarget returns the required { dedupeKey, target } wrapper for card route", () => {
    mockFindActiveCard.mockReturnValue({ outTrackId: "ot1", sessionKey: "session-A" });

    const prepared = runtime.transport.prepareTarget({
      cfg: {} as never,
      accountId: "default",
      plannedTarget: { surface: "origin", target: { to: "group:cid_xxx" } },
      request: request(),
      approvalKind: "exec",
      pendingPayload: { approvalId: "abc123", markdownText: "md" },
      view: {} as never,
    } as never);

    expect(prepared).toEqual({
      dedupeKey: "dingtalk:default:group:cid_xxx:ot1",
      target: {
        route: "card",
        to: "group:cid_xxx",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
    });
  });

  it("delivers pending approval by patching active card", async () => {
    const entry = await runtime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      plannedTarget: { surface: "origin", target: { to: "group:cid_xxx" } },
      preparedTarget: {
        route: "card",
        to: "group:cid_xxx",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
      request: request(),
      approvalKind: "exec",
      pendingPayload: { approvalId: "abc123", markdownText: "md" },
      view: {} as never,
    } as never);

    expect(mockPending).toHaveBeenCalledWith("ot1", "abc123", "tok", expect.objectContaining({ clientId: "x" }));
    expect(entry).toEqual({ mode: "card", approvalId: "abc123", accountId: "default", outTrackId: "ot1" });
  });

  it("falls back to markdown on explicit card patch failure", async () => {
    mockPending.mockRejectedValueOnce(Object.assign(new Error("400"), { status: 400 }));

    const entry = await runtime.transport.deliverPending({
      cfg: {} as never,
      preparedTarget: {
        route: "card",
        to: "group:cid_xxx",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
      pendingPayload: { approvalId: "abc123", markdownText: "md" },
    } as never);

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      "group:cid_xxx",
      "md",
      expect.objectContaining({ forceMarkdown: true }),
    );
    expect(entry).toEqual({ mode: "markdown", approvalId: "abc123", accountId: "default" });
  });

  it("does not duplicate-send markdown when card patch outcome is ambiguous", async () => {
    mockPending.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));

    const entry = await runtime.transport.deliverPending({
      cfg: {} as never,
      preparedTarget: {
        route: "card",
        to: "group:cid_xxx",
        accountId: "default",
        activeCardOutTrackId: "ot1",
      },
      pendingPayload: { approvalId: "abc123", markdownText: "md" },
    } as never);

    expect(entry).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("updates card entries and no-ops markdown entries", async () => {
    await runtime.transport.updateEntry?.({
      cfg: {} as never,
      entry: { mode: "card", approvalId: "abc123", accountId: "default", outTrackId: "ot1" },
      payload: { phase: "resolved", decision: "allow-once" },
      phase: "resolved",
    } as never);

    expect(mockResolved).toHaveBeenCalledWith(
      "ot1",
      "allow-once",
      "tok",
      true,
      expect.objectContaining({ clientId: "x" }),
    );

    await runtime.transport.updateEntry?.({
      cfg: {} as never,
      entry: { mode: "markdown", approvalId: "abc123", accountId: "default" },
      payload: { phase: "resolved", decision: "allow-once" },
      phase: "resolved",
    } as never);
    expect(mockExpired).not.toHaveBeenCalled();
  });
});
