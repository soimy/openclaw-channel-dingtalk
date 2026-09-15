import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import type {
  DingTalkConfig,
  DingTalkInboundMessage,
  HandleDingTalkMessageParams,
  Logger,
  ResolvedDingTalkRoute,
  SubAgentOptions,
} from "../platform/types";

export type DingTalkQuestionContext = {
  cfg: HandleDingTalkMessageParams["cfg"];
  accountId: string;
  data: DingTalkInboundMessage;
  sessionWebhook: string;
  log?: Logger;
  dingtalkConfig: DingTalkConfig;
  storePath?: string;
  questionScopeKey?: string;
  resolvedRoute?: ResolvedDingTalkRoute;
  continuationSubAgentOptions?: Omit<SubAgentOptions, "commandText">;
  onQuestionCardSent?: (event: {
    questionId: string;
    outTrackId: string;
  }) => boolean | void | Promise<boolean | void>;
};

const questionContextStorage = new AsyncLocalStorage<DingTalkQuestionContext>();

export function withDingTalkQuestionContext<T>(
  context: DingTalkQuestionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return questionContextStorage.run(context, fn);
}

export function getDingTalkQuestionContext(): DingTalkQuestionContext | undefined {
  return questionContextStorage.getStore();
}

// Only dispatching turns are eligible for a reused native-runtime tool. Queued,
// unauthorized, and completed inbound messages must never supply a fallback.
const activeToolRuns = new Set<DingTalkQuestionContext>();
const trackedToolRuns = new WeakSet<DingTalkQuestionContext>();

export async function withDingTalkQuestionToolRun<T>(
  context: DingTalkQuestionContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!context) {
    return fn();
  }
  trackedToolRuns.add(context);
  activeToolRuns.add(context);
  try {
    return await fn();
  } finally {
    activeToolRuns.delete(context);
  }
}

function matchesTrustedToolIdentity(
  context: DingTalkQuestionContext,
  toolContext: OpenClawPluginToolContext,
): boolean {
  const senderId = (context.data.senderStaffId || context.data.senderId || "").trim();
  return Boolean(
    senderId &&
    toolContext.sessionKey?.trim() &&
    toolContext.messageChannel === "dingtalk" &&
    toolContext.agentAccountId === context.accountId &&
    toolContext.requesterSenderId?.trim() === senderId,
  );
}

/** Resolve again at execution: native runtimes may retain a previous turn's tool. */
export function resolveDingTalkQuestionToolContext(
  toolContext: OpenClawPluginToolContext,
  captured: DingTalkQuestionContext | undefined,
): DingTalkQuestionContext | undefined {
  if (captured && (!trackedToolRuns.has(captured) || activeToolRuns.has(captured))) {
    return captured;
  }
  const candidates = [...activeToolRuns].filter(
    (context) =>
      matchesTrustedToolIdentity(context, toolContext) &&
      getDingTalkQuestionToolContext(toolContext, context) !== undefined,
  );
  // Never choose arbitrarily between concurrent runs.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Bind only the current inbound run, including the host's isolated DM policy key. */
export function getDingTalkQuestionToolContext(
  toolContext: OpenClawPluginToolContext,
  context = getDingTalkQuestionContext(),
): DingTalkQuestionContext | undefined {
  if (!context) {
    return undefined;
  }
  const runtimeSessionKey = toolContext.sessionKey?.trim();
  const route = context.resolvedRoute;

  if (!runtimeSessionKey || route?.sessionKey.trim() === runtimeSessionKey) {
    return context;
  }

  // OpenClaw can keep the transcript in the main session while using a
  // per-account/channel/peer key for tool policy. Accept that alias only for
  // a direct inbound turn whose trusted runtime channel/account/sender match.
  // Never relax group, named-session, or sub-agent session isolation.
  const senderId = (context.data.senderStaffId || context.data.senderId || "").trim();
  if (
    !route ||
    route.sessionKey !== route.mainSessionKey ||
    context.data.conversationType !== "1" ||
    toolContext.messageChannel !== "dingtalk" ||
    toolContext.agentAccountId !== context.accountId ||
    !senderId ||
    toolContext.requesterSenderId?.trim() !== senderId
  ) {
    return undefined;
  }
  const policySessionKey = buildAgentSessionKey({
    agentId: route.agentId,
    channel: "dingtalk",
    accountId: context.accountId,
    peer: { kind: "direct", id: senderId },
    dmScope: "per-account-channel-peer",
    identityLinks: context.cfg.session?.identityLinks,
  });
  return runtimeSessionKey === policySessionKey ? context : undefined;
}
