import { describe, expect, it } from "vitest";
import { dingtalkPlugin } from "../../src/channel";

describe("dingtalkPlugin approval capability", () => {
  it("exposes approvalCapability for OpenClaw native approvals", () => {
    expect(dingtalkPlugin.approvalCapability).toBeDefined();
    expect(dingtalkPlugin.approvalCapability?.authorizeActorAction).toBeTypeOf("function");
  });
});
