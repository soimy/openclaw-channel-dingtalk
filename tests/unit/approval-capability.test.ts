import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/approval-delivery-runtime", () => ({
  createApproverRestrictedNativeApprovalCapability: vi.fn(() => ({ mock: "capability" })),
}));

vi.mock("../../src/approval/approval-native-runtime", () => ({
  createDingTalkApprovalNativeRuntime: vi.fn(() => ({ marker: "native-runtime" })),
}));

const { createDingTalkApprovalCapability } = await import("../../src/approval/approval-capability");
const { createApproverRestrictedNativeApprovalCapability } = await import(
  "openclaw/plugin-sdk/approval-delivery-runtime"
);

const mockFactory = vi.mocked(createApproverRestrictedNativeApprovalCapability);

describe("createDingTalkApprovalCapability", () => {
  it("configures the SDK factory for DingTalk", () => {
    createDingTalkApprovalCapability();

    expect(mockFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "dingtalk",
        channelLabel: "DingTalk",
      }),
    );
  });

  it("uses origin-only native delivery boundaries in v1", () => {
    createDingTalkApprovalCapability();
    const args = mockFactory.mock.calls.at(-1)?.[0];

    expect(args).toEqual(
      expect.objectContaining({
        notifyOriginWhenDmOnly: false,
        requireMatchingTurnSourceChannel: true,
      }),
    );
    expect(args?.resolveApproverDmTargets).toBeUndefined();
  });

  it("attaches nativeRuntime for channel-native approval delivery", () => {
    createDingTalkApprovalCapability();

    expect(mockFactory.mock.calls.at(-1)?.[0].nativeRuntime).toEqual({ marker: "native-runtime" });
  });

  it("does not implement resolveApproveCommandBehavior because DingTalk intercepts early", () => {
    createDingTalkApprovalCapability();

    expect(mockFactory.mock.calls.at(-1)?.[0]).not.toHaveProperty("resolveApproveCommandBehavior");
  });

  it("describes approvers, ownerAllowFrom fallback, and enabled mode", () => {
    createDingTalkApprovalCapability();
    const describe = mockFactory.mock.calls.at(-1)?.[0].describeExecApprovalSetup;

    const text = describe?.({ cfg: {} as never, accountId: "default" });

    expect(text).toMatch(/channels\.dingtalk\.execApprovals\.approvers/);
    expect(text).toMatch(/commands\.ownerAllowFrom/);
    expect(text).toMatch(/enabled/);
  });
});
