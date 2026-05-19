import { describe, expect, it } from "vitest";
import {
  normalizeApprovalTargetTo,
  resolveDingTalkOriginTarget,
} from "../../src/approval/approval-target-resolver";

const request = (
  payload: Partial<{
    turnSourceChannel: string | null;
    turnSourceTo: string | null;
    turnSourceAccountId: string | null;
    turnSourceThreadId: string | number | null;
    sessionKey: string | null;
  }>,
) =>
  ({
    id: "approval-1",
    createdAtMs: 0,
    expiresAtMs: 0,
    request: payload,
  }) as never;

describe("normalizeApprovalTargetTo", () => {
  it("keeps group-prefixed targets unchanged", () => {
    expect(normalizeApprovalTargetTo("group:cidxxxxx")).toBe("group:cidxxxxx");
  });

  it("keeps user-prefixed targets unchanged", () => {
    expect(normalizeApprovalTargetTo("user:staff001")).toBe("user:staff001");
  });

  it("adds group prefix for bare cid targets", () => {
    expect(normalizeApprovalTargetTo("cidxxxxx")).toBe("group:cidxxxxx");
  });

  it("adds user prefix for bare staff IDs", () => {
    expect(normalizeApprovalTargetTo("staff001")).toBe("user:staff001");
  });
});

describe("resolveDingTalkOriginTarget", () => {
  it("returns null for non-DingTalk turn sources", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "default",
      request: request({ turnSourceChannel: "discord", turnSourceTo: "group:cidxxx" }),
    });

    expect(resolved).toBeNull();
  });

  it("returns null when turnSourceTo is empty", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "default",
      request: request({ turnSourceChannel: "dingtalk", turnSourceTo: null }),
    });

    expect(resolved).toBeNull();
  });

  it("resolves prefixed DingTalk group targets", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "default",
      request: request({ turnSourceChannel: "dingtalk", turnSourceTo: "group:cidxxx" }),
    });

    expect(resolved).toEqual(expect.objectContaining({ to: "group:cidxxx" }));
  });

  it("normalizes bare cid targets to group targets", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "default",
      request: request({ turnSourceChannel: "dingtalk", turnSourceTo: "cidxxx" }),
    });

    expect(resolved?.to).toBe("group:cidxxx");
  });

  it("normalizes bare staff IDs to user targets", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "default",
      request: request({ turnSourceChannel: "dingtalk", turnSourceTo: "staff001" }),
    });

    expect(resolved?.to).toBe("user:staff001");
  });

  it("returns null when turnSourceAccountId does not match the input accountId", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "acme",
      request: request({
        turnSourceChannel: "dingtalk",
        turnSourceTo: "group:cidxxx",
        turnSourceAccountId: "other",
      }),
    });

    expect(resolved).toBeNull();
  });

  it("preserves turnSourceAccountId and turnSourceThreadId", () => {
    const resolved = resolveDingTalkOriginTarget({
      cfg: {} as never,
      accountId: "acme",
      request: request({
        turnSourceChannel: "dingtalk",
        turnSourceTo: "group:cidxxx",
        turnSourceAccountId: "acme",
        turnSourceThreadId: "thread-xyz",
      }),
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        to: "group:cidxxx",
        accountId: "acme",
        threadId: "thread-xyz",
      }),
    );
  });
});
