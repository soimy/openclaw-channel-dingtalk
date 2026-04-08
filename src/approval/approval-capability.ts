import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { dingtalkApprovalNativeRuntimeAdapter } from "./approval-native-adapter";

/**
 * Native delivery descriptor: DingTalk only supports the origin surface
 * (审批卡片发到 agent 所在会话/群)。Approver-DM 分发不在范围内。
 *
 * `resolveOriginTarget` reads the request's `turnSourceTo` (set by
 * inbound-handler as the raw conversationId / userId) and returns it
 * unchanged for downstream `transport.prepareTarget` to interpret.
 */
const dingtalkApprovalNativeAdapter: NonNullable<ChannelApprovalCapability["native"]> = {
  describeDeliveryCapabilities: () => ({
    enabled: true,
    preferredSurface: "origin",
    supportsOriginSurface: true,
    supportsApproverDmSurface: false,
  }),
  resolveOriginTarget: ({ request }) => {
    const source = (request.request.turnSourceChannel ?? "").toString().toLowerCase();
    if (source !== "dingtalk") {
      return null;
    }
    const to = request.request.turnSourceTo;
    if (!to) {
      return null;
    }
    return { to };
  },
};

/**
 * DingTalk channel approval capability.
 *
 * - `nativeRuntime` 处理 build/deliver/update 全生命周期（5 子 adapter）。
 * - `native` 描述投递目标解析（仅 origin）。
 * - 卡片按钮回调 → `card-callback-service` → `resolveApprovalOverGateway`，
 *   不在 capability 上注册（callback 走 channel callback 路径）。
 * - `/approve` 文本命令早期 intercept 在 inbound-handler 内部处理，
 *   绕过 DingTalk 自身的 session lock。
 */
export const dingtalkApprovalCapability: ChannelApprovalCapability = {
  // The capability field uses the type-erased ChannelApprovalNativeRuntimeAdapter
  // (default unknowns); TS treats different generic instantiations as invariant.
  // Cast bridges our concrete typed adapter into the erased registration shape —
  // matches the same pattern other channels use via splitChannelApprovalCapability.
  nativeRuntime:
    dingtalkApprovalNativeRuntimeAdapter as unknown as ChannelApprovalNativeRuntimeAdapter,
  native: dingtalkApprovalNativeAdapter,
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.dingtalk.accounts.${accountId}`
        : "channels.dingtalk";
    return `DingTalk supports native exec/plugin approvals via interactive cards. Configure \`${prefix}\` as usual; approvals will be delivered to the originating conversation as an interactive card with three buttons.`;
  },
};
