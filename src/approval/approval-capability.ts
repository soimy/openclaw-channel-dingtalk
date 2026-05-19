import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { listDingTalkAccountIds } from "../config";
import {
  getExecApprovalsConfig,
  isExecAuthorizedSender,
  isPluginAuthorizedSender,
  listExecApprovers,
  resolveNativeDeliveryMode,
} from "./approval-config";
import { resolveDingTalkOriginTarget } from "./approval-target-resolver";

const EXEC_APPROVAL_SETUP_TEXT =
  "Configure channels.dingtalk.execApprovals.approvers or commands.ownerAllowFrom; " +
  "leave channels.dingtalk.execApprovals.enabled unset/auto or set it to true.";

export function createDingTalkApprovalCapability(): ChannelApprovalCapability {
  return createApproverRestrictedNativeApprovalCapability({
    channel: "dingtalk",
    channelLabel: "DingTalk",
    listAccountIds: (cfg) => {
      const accountIds = listDingTalkAccountIds(cfg);
      return accountIds.length > 0 ? accountIds : ["default"];
    },
    hasApprovers: ({ cfg, accountId }) =>
      listExecApprovers({ cfg, accountId: accountId || "default" }).length > 0,
    isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
      Boolean(
        senderId &&
          isExecAuthorizedSender({ cfg, accountId: accountId || "default", senderId }),
      ),
    isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
      Boolean(
        senderId &&
          isPluginAuthorizedSender({ cfg, accountId: accountId || "default", senderId }),
      ),
    isNativeDeliveryEnabled: ({ cfg, accountId }) =>
      getExecApprovalsConfig({ cfg, accountId: accountId || "default" }).isNativeDeliveryEnabled,
    resolveNativeDeliveryMode: ({ cfg, accountId }) =>
      resolveNativeDeliveryMode({ cfg, accountId: accountId || "default" }),
    requireMatchingTurnSourceChannel: true,
    resolveOriginTarget: resolveDingTalkOriginTarget,
    notifyOriginWhenDmOnly: false,
    describeExecApprovalSetup: () => EXEC_APPROVAL_SETUP_TEXT,
  });
}
