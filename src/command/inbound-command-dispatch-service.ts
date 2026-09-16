import type {
  DingTalkConfig,
  HandleDingTalkMessageParams,
  Logger,
  MessageContent,
} from "../platform/types";
import type { SessionPeerSourceKind } from "../targeting/session-peer-store";
import {
  applyManualGlobalLearningRule,
  applyManualSessionLearningNote,
  applyManualTargetLearningRule,
  applyManualTargetsLearningRule,
  applyTargetSetLearningRule,
  createOrUpdateTargetSet,
  deleteManualRule,
  disableManualRule,
  listLearningTargetSets,
  isManualGlobalRuleAllowed,
  isLearningEnabled,
  listScopedLearningRules,
  resolveLearningRuleTtlMs,
  resolveManualForcedReply,
} from "./feedback-learning-service";
import {
  formatLearnAppliedReply,
  formatLearnCommandHelp,
  formatLearnDeletedReply,
  formatLearnDisabledReply,
  formatLearnListReply,
  formatLearningDisabledReply,
  formatManualGlobalRuleDisabledReply,
  formatOwnerOnlyDeniedReply,
  formatOwnerStatusReply,
  formatTargetSetSavedReply,
  formatWhereAmIReply,
  formatWhoAmIReply,
  isLearningOwner,
  parseLearnCommand,
} from "./learning-command-service";
import {
  formatSessionAliasBoundReply,
  formatSessionAliasClearedReply,
  formatSessionAliasReply,
  formatSessionAliasSetReply,
  formatSessionAliasUnboundReply,
  formatSessionAliasValidationErrorReply,
  parseSessionCommand,
  validateSessionAlias,
} from "./session-command-service";

type InboundCommandDispatchParams = {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  dingtalkConfig: DingTalkConfig;
  senderId: string;
  isDirect: boolean;
  extractedText: string;
  messageType: MessageContent["messageType"];
  data: {
    conversationId: string;
    senderId?: string;
    senderStaffId?: string;
  };
  accountStorePath: string;
  /** Channel log sink; used to make forced-reply overrides auditable. */
  log?: Logger;
  currentSessionSourceKind: SessionPeerSourceKind;
  currentSessionSourceId: string;
  peerIdOverride?: string;
  sessionPeer: {
    peerId: string;
  };
  sendReply: (text: string) => Promise<void>;
  clearSessionPeerOverride: (params: {
    storePath: string;
    accountId: string;
    sourceKind: SessionPeerSourceKind;
    sourceId: string;
  }) => boolean;
  setSessionPeerOverride: (params: {
    storePath: string;
    accountId: string;
    sourceKind: SessionPeerSourceKind;
    sourceId: string;
    peerId: string;
  }) => void;
};

export async function handleInboundCommandDispatch(
  params: InboundCommandDispatchParams,
): Promise<boolean> {
  const parsedLearnCommand = parseLearnCommand(params.extractedText);
  const parsedSessionCommand = parseSessionCommand(params.extractedText);
  const isOwner = isLearningOwner({
    cfg: params.cfg,
    config: params.dingtalkConfig,
    senderId: params.senderId,
    rawSenderId: params.data.senderId,
  });
  // `learningEnabled` is the documented master switch for the whole learning
  // loop, so it also gates rule writes and forced-reply execution below, not
  // just prompt injection.
  const learningEnabled = isLearningEnabled(params.dingtalkConfig);

  if (params.isDirect && parsedLearnCommand.scope === "whoami") {
    await params.sendReply(
      formatWhoAmIReply({
        senderId: params.senderId,
        rawSenderId: params.data.senderId,
        senderStaffId: params.data.senderStaffId,
        isOwner,
      }),
    );
    return true;
  }

  if (parsedLearnCommand.scope === "whereami") {
    await params.sendReply(
      formatWhereAmIReply({
        conversationId: params.data.conversationId,
        conversationType: params.isDirect ? "dm" : "group",
        peerId: params.sessionPeer.peerId,
      }),
    );
    return true;
  }

  if (params.isDirect && parsedLearnCommand.scope === "owner-status") {
    await params.sendReply(
      formatOwnerStatusReply({
        senderId: params.senderId,
        rawSenderId: params.data.senderId,
        isOwner,
      }),
    );
    return true;
  }

  if (parsedLearnCommand.scope === "help") {
    await params.sendReply(formatLearnCommandHelp());
    return true;
  }

  if (
    (parsedLearnCommand.scope === "global" ||
      parsedLearnCommand.scope === "session" ||
      parsedLearnCommand.scope === "here" ||
      parsedLearnCommand.scope === "target" ||
      parsedLearnCommand.scope === "targets" ||
      parsedLearnCommand.scope === "list" ||
      parsedLearnCommand.scope === "disable" ||
      parsedLearnCommand.scope === "delete" ||
      parsedLearnCommand.scope === "target-set-create" ||
      parsedLearnCommand.scope === "target-set-apply" ||
      parsedSessionCommand.scope === "session-alias-show" ||
      parsedSessionCommand.scope === "session-alias-set" ||
      parsedSessionCommand.scope === "session-alias-clear" ||
      parsedSessionCommand.scope === "session-alias-bind" ||
      parsedSessionCommand.scope === "session-alias-unbind") &&
    !isOwner
  ) {
    await params.sendReply(formatOwnerOnlyDeniedReply());
    return true;
  }

  // Writing or changing rules is refused while the master switch is off. Read-only
  // and cleanup commands (list / disable / delete) stay available so an operator
  // can still inspect and remove persisted rules without enabling the loop.
  if (
    !learningEnabled &&
    (parsedLearnCommand.scope === "global" ||
      parsedLearnCommand.scope === "session" ||
      parsedLearnCommand.scope === "here" ||
      parsedLearnCommand.scope === "target" ||
      parsedLearnCommand.scope === "targets" ||
      parsedLearnCommand.scope === "target-set-create" ||
      parsedLearnCommand.scope === "target-set-apply")
  ) {
    await params.sendReply(formatLearningDisabledReply());
    return true;
  }

  // Account-wide rules are an explicit opt-in: refusing the write keeps every
  // accepted command effective, instead of storing a rule that would be ignored.
  // Session-scoped forms (`here` / `target` / `targets` / `target-set`) stay
  // available as the way to reach several conversations by default.
  if (!isManualGlobalRuleAllowed(params.dingtalkConfig) && parsedLearnCommand.scope === "global") {
    await params.sendReply(formatManualGlobalRuleDisabledReply());
    return true;
  }

  if (isOwner) {
    if (parsedSessionCommand.scope === "session-alias-show") {
      await params.sendReply(
        formatSessionAliasReply({
          sourceKind: params.currentSessionSourceKind,
          sourceId: params.currentSessionSourceId,
          peerId: params.sessionPeer.peerId,
          aliasSource: params.peerIdOverride ? "override" : "default",
        }),
      );
      return true;
    }

    if (parsedSessionCommand.scope === "session-alias-set" && parsedSessionCommand.peerId) {
      const aliasValidationError = validateSessionAlias(parsedSessionCommand.peerId);
      if (aliasValidationError) {
        await params.sendReply(formatSessionAliasValidationErrorReply(aliasValidationError));
        return true;
      }
      params.setSessionPeerOverride({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        sourceKind: params.currentSessionSourceKind,
        sourceId: params.currentSessionSourceId,
        peerId: parsedSessionCommand.peerId,
      });
      await params.sendReply(
        formatSessionAliasSetReply({
          sourceKind: params.currentSessionSourceKind,
          sourceId: params.currentSessionSourceId,
          peerId: parsedSessionCommand.peerId,
        }),
      );
      return true;
    }

    if (parsedSessionCommand.scope === "session-alias-clear") {
      params.clearSessionPeerOverride({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        sourceKind: params.currentSessionSourceKind,
        sourceId: params.currentSessionSourceId,
      });
      await params.sendReply(
        formatSessionAliasClearedReply({
          sourceKind: params.currentSessionSourceKind,
          sourceId: params.currentSessionSourceId,
        }),
      );
      return true;
    }

    if (
      parsedSessionCommand.scope === "session-alias-bind" &&
      parsedSessionCommand.sourceKind &&
      parsedSessionCommand.sourceId &&
      parsedSessionCommand.peerId
    ) {
      const aliasValidationError = validateSessionAlias(parsedSessionCommand.peerId);
      if (aliasValidationError) {
        await params.sendReply(formatSessionAliasValidationErrorReply(aliasValidationError));
        return true;
      }
      params.setSessionPeerOverride({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        sourceKind: parsedSessionCommand.sourceKind,
        sourceId: parsedSessionCommand.sourceId,
        peerId: parsedSessionCommand.peerId,
      });
      await params.sendReply(
        formatSessionAliasBoundReply({
          sourceKind: parsedSessionCommand.sourceKind,
          sourceId: parsedSessionCommand.sourceId,
          peerId: parsedSessionCommand.peerId,
        }),
      );
      return true;
    }

    if (
      parsedSessionCommand.scope === "session-alias-unbind" &&
      parsedSessionCommand.sourceKind &&
      parsedSessionCommand.sourceId
    ) {
      const existed = params.clearSessionPeerOverride({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        sourceKind: parsedSessionCommand.sourceKind,
        sourceId: parsedSessionCommand.sourceId,
      });
      await params.sendReply(
        formatSessionAliasUnboundReply({
          sourceKind: parsedSessionCommand.sourceKind,
          sourceId: parsedSessionCommand.sourceId,
          existed,
        }),
      );
      return true;
    }

    if (parsedLearnCommand.scope === "global" && parsedLearnCommand.instruction) {
      const applied = applyManualGlobalLearningRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        formatLearnAppliedReply({
          scope: "global",
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
      );
      return true;
    }

    if (parsedLearnCommand.scope === "session" && parsedLearnCommand.instruction) {
      applyManualSessionLearningNote({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        targetId: params.data.conversationId,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        formatLearnAppliedReply({
          scope: "session",
          instruction: parsedLearnCommand.instruction,
        }),
      );
      return true;
    }

    if (parsedLearnCommand.scope === "here" && parsedLearnCommand.instruction) {
      const applied = applyManualTargetLearningRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        targetId: params.data.conversationId,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        formatLearnAppliedReply({
          scope: "target",
          targetId: params.data.conversationId,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
      );
      return true;
    }

    if (
      parsedLearnCommand.scope === "target" &&
      parsedLearnCommand.targetId &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyManualTargetLearningRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        targetId: parsedLearnCommand.targetId,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        formatLearnAppliedReply({
          scope: "target",
          targetId: parsedLearnCommand.targetId,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied?.ruleId,
        }),
      );
      return true;
    }

    if (
      parsedLearnCommand.scope === "targets" &&
      parsedLearnCommand.targetIds?.length &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyManualTargetsLearningRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        targetIds: parsedLearnCommand.targetIds,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        formatLearnAppliedReply({
          scope: "targets",
          targetIds: parsedLearnCommand.targetIds,
          instruction: parsedLearnCommand.instruction,
          ruleId: applied[0]?.ruleId,
        }),
      );
      return true;
    }

    if (
      parsedLearnCommand.scope === "target-set-create" &&
      parsedLearnCommand.setName &&
      parsedLearnCommand.targetIds?.length
    ) {
      const saved = createOrUpdateTargetSet({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        name: parsedLearnCommand.setName,
        targetIds: parsedLearnCommand.targetIds,
      });
      await params.sendReply(
        saved
          ? formatTargetSetSavedReply({
              setName: parsedLearnCommand.setName,
              targetIds: parsedLearnCommand.targetIds,
            })
          : "目标组保存失败，请检查名称和目标列表。",
      );
      return true;
    }

    if (
      parsedLearnCommand.scope === "target-set-apply" &&
      parsedLearnCommand.setName &&
      parsedLearnCommand.instruction
    ) {
      const applied = applyTargetSetLearningRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        name: parsedLearnCommand.setName,
        instruction: parsedLearnCommand.instruction,
      });
      await params.sendReply(
        applied.length > 0
          ? formatLearnAppliedReply({
              scope: "target-set",
              setName: parsedLearnCommand.setName,
              targetIds: applied.map((item) => item.targetId),
              instruction: parsedLearnCommand.instruction,
              ruleId: applied[0]?.ruleId,
            })
          : `未找到目标组 \`${parsedLearnCommand.setName}\`，或该目标组为空。`,
      );
      return true;
    }

    if (parsedLearnCommand.scope === "list") {
      const allowManualGlobalRules = isManualGlobalRuleAllowed(params.dingtalkConfig);
      const rules = listScopedLearningRules({
        storePath: params.accountStorePath,
        accountId: params.accountId,
      })
        .slice(0, 20)
        .map((rule) => {
          const scope = rule.scope === "target" ? `target(${rule.targetId})` : "global";
          // Account-wide rules can be stored but skipped entirely; say so instead
          // of reporting them as active.
          const notApplied =
            rule.scope === "global" && rule.manual === true && !allowManualGlobalRules;
          const status = rule.enabled
            ? notApplied
              ? "enabled, not applied"
              : "enabled"
            : "disabled";
          return `- [${scope}] ${rule.ruleId} (${status}) => ${rule.instruction}`;
        });
      const targetSets = listLearningTargetSets({
        storePath: params.accountStorePath,
        accountId: params.accountId,
      })
        .slice(0, 10)
        .map(
          (targetSet) => `- [target-set] ${targetSet.name} => ${targetSet.targetIds.join(", ")}`,
        );
      await params.sendReply(formatLearnListReply([...rules, ...targetSets]));
      return true;
    }

    if (parsedLearnCommand.scope === "disable" && parsedLearnCommand.ruleId) {
      const result = disableManualRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        ruleId: parsedLearnCommand.ruleId,
      });
      await params.sendReply(
        formatLearnDisabledReply({
          ruleId: parsedLearnCommand.ruleId,
          existed: result.existed,
          scope: result.scope,
          targetId: result.targetId,
        }),
      );
      return true;
    }

    if (parsedLearnCommand.scope === "delete" && parsedLearnCommand.ruleId) {
      const result = deleteManualRule({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        ruleId: parsedLearnCommand.ruleId,
      });
      await params.sendReply(
        formatLearnDeletedReply({
          ruleId: parsedLearnCommand.ruleId,
          existed: result.existed,
          scope: result.scope,
          targetId: result.targetId,
        }),
      );
      return true;
    }
  }

  const forcedContent: MessageContent = {
    text: params.extractedText,
    messageType: params.messageType,
  };
  const manualForcedReply = learningEnabled
    ? resolveManualForcedReply({
        storePath: params.accountStorePath,
        accountId: params.accountId,
        targetId: params.data.conversationId,
        content: forcedContent,
        options: {
          allowGlobalRules: isManualGlobalRuleAllowed(params.dingtalkConfig),
          ruleTtlMs: resolveLearningRuleTtlMs(params.dingtalkConfig),
        },
      })
    : null;
  if (manualForcedReply) {
    // A forced reply bypasses the model entirely, so it is logged with the rule
    // that produced it instead of being applied silently.
    params.log?.info?.(
      `[DingTalk][Learning][ForcedReply] ruleId=${manualForcedReply.ruleId} scope=${manualForcedReply.scope} target=${manualForcedReply.targetId ?? "-"}`,
    );
    await params.sendReply(manualForcedReply.reply);
    return true;
  }

  return false;
}
