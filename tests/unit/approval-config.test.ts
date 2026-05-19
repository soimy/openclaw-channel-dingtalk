import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import {
  getExecApprovalsConfig,
  isExecAuthorizedSender,
  isPluginAuthorizedSender,
  listExecApprovers,
  resolveNativeDeliveryMode,
} from "../../src/approval/approval-config";

const cfg = (
  approvers: string[],
  opts: { ownerAllowFrom?: string[]; enabled?: boolean | "auto" } = {},
): OpenClawConfig =>
  ({
    channels: {
      dingtalk: {
        clientId: "x",
        clientSecret: "y",
        execApprovals: { enabled: opts.enabled ?? "auto", approvers },
      },
    },
    commands: { ownerAllowFrom: opts.ownerAllowFrom },
  }) as unknown as OpenClawConfig;

describe("approval-config", () => {
  it("returns deduplicated normalized staff IDs", () => {
    const c = cfg(["staff001", "dingtalk:staff002", "DD:staff003", "ding:staff001"]);
    expect(listExecApprovers({ cfg: c, accountId: "default" })).toEqual([
      "staff001",
      "staff002",
      "staff003",
    ]);
  });

  it("falls back to commands.ownerAllowFrom when approvers are empty", () => {
    const c = cfg([], { ownerAllowFrom: ["staff999"] });
    expect(listExecApprovers({ cfg: c, accountId: "default" })).toEqual(["staff999"]);
  });

  it("authorizes listed staff IDs for exec approval", () => {
    const c = cfg(["staff001"]);
    expect(isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff001" })).toBe(
      true,
    );
    expect(isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff999" })).toBe(
      false,
    );
  });

  it("accepts dingtalk/dd/ding prefixes in senderId", () => {
    const c = cfg(["staff001"]);
    expect(
      isExecAuthorizedSender({ cfg: c, accountId: "default", senderId: "dingtalk:staff001" }),
    ).toBe(true);
  });

  it("uses exec authorization for plugin approvals in v1", () => {
    const c = cfg(["staff001"]);
    expect(isPluginAuthorizedSender({ cfg: c, accountId: "default", senderId: "staff001" })).toBe(
      true,
    );
  });

  it("preserves explicit enabled=false even when approvers are configured", () => {
    const c = cfg(["staff001"], { enabled: false });
    expect(getExecApprovalsConfig({ cfg: c, accountId: "default" }).enabled).toBe(false);
  });

  it("enables native delivery for enabled=auto when approvers exist", () => {
    const c = cfg(["staff001"]);
    expect(getExecApprovalsConfig({ cfg: c, accountId: "default" }).isNativeDeliveryEnabled).toBe(
      true,
    );
  });

  it("disables native delivery for enabled=auto when approvers are empty", () => {
    const c = cfg([]);
    expect(getExecApprovalsConfig({ cfg: c, accountId: "default" }).isNativeDeliveryEnabled).toBe(
      false,
    );
  });

  it('uses "channel" as the v1 native delivery mode', () => {
    const c = cfg(["staff001"]);
    expect(resolveNativeDeliveryMode({ cfg: c, accountId: "default" })).toBe("channel");
  });
});
