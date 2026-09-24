import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../../../src/platform/types";

const shared = vi.hoisted(() => ({
  sendBySessionMock: vi.fn(),
  sendMessageMock: vi.fn(),
  extractMessageContentMock: vi.fn(),
  getRuntimeMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  createAICardMock: vi.fn(),
  finishAICardMock: vi.fn(),
  commitAICardBlocksMock: vi.fn(),
  recallAICardMessageMock: vi.fn(),
  dispatchDingTalkCardStopCommandMock: vi.fn(),
  isCardInTerminalStateMock: vi.fn(),
  updateAICardBlockListMock: vi.fn(),
  streamAICardMock: vi.fn(),
  sendSplitProactiveCardsMock: vi.fn(),
  formatContentForCardMock: vi.fn((s: string) => s),
  invalidateAskUserQuestionsForScopeMock: vi.fn().mockResolvedValue([]),
  syncInvalidatedAskUserQuestionCardsMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/platform/auth", () => ({
  getAccessToken: vi.fn().mockResolvedValue("token_abc"),
}));

vi.mock("openclaw/plugin-sdk/media-local-roots", () => ({
  getAgentScopedMediaLocalRoots: () => ["/test/agent-workspace"],
}));
vi.mock("../../../src/platform/runtime", () => ({
  getDingTalkRuntime: shared.getRuntimeMock,
}));

vi.mock("../../../src/messaging/message-utils", () => ({
  extractMessageContent: shared.extractMessageContentMock,
}));

vi.mock("../../../src/messaging/send-service", () => ({
  sendBySession: shared.sendBySessionMock,
  sendMessage: shared.sendMessageMock,
  sendProactiveMediaMock: vi.fn(),
  uploadMedia: vi.fn(),
}));

vi.mock("../../../src/card/card-service", () => ({
  createAICard: shared.createAICardMock,
  finishAICard: shared.finishAICardMock,
  commitAICardBlocks: shared.commitAICardBlocksMock,
  recallAICardMessage: shared.recallAICardMessageMock,
  formatContentForCard: shared.formatContentForCardMock,
  isCardInTerminalState: shared.isCardInTerminalStateMock,
  streamAICard: shared.streamAICardMock,
  updateAICardBlockList: shared.updateAICardBlockListMock,
  streamAICardContent: vi.fn(),
  clearAICardStreamingContent: vi.fn(),
  sendSplitProactiveCards: shared.sendSplitProactiveCardsMock,
}));

vi.mock("../../../src/command/card-stop-command", () => ({
  dispatchDingTalkCardStopCommand: shared.dispatchDingTalkCardStopCommandMock,
}));

vi.mock("../../../src/card/ask-user-question", () => ({
  invalidateAskUserQuestionsForScope: shared.invalidateAskUserQuestionsForScopeMock,
  syncInvalidatedAskUserQuestionCards: shared.syncInvalidatedAskUserQuestionCardsMock,
}));

vi.mock("../../../src/gateway/session-lock", () => ({
  acquireSessionLock: shared.acquireSessionLockMock,
}));

vi.mock("../../../src/messaging/quoted-file-service", () => ({
  downloadGroupFile: vi.fn().mockResolvedValue(null),
  getUnionIdByStaffId: vi.fn().mockResolvedValue("union_1"),
  resolveQuotedFile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/messaging/attachment-text-extractor", () => ({
  extractAttachmentText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/messaging/media-utils", async () => {
  const actual = await vi.importActual<typeof import("../../../src/messaging/media-utils")>("../../../src/messaging/media-utils");
  return {
    ...actual,
    prepareMediaInput: vi.fn(),
    resolveOutboundMediaType: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  isAbortRequestText: vi.fn().mockReturnValue(false),
  isBtwRequestText: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/messaging/message-context-store", async () => {
  const actual = await vi.importActual<typeof import("../../../src/messaging/message-context-store")>(
    "../../../src/messaging/message-context-store",
  );
  return {
    ...actual,
    upsertInboundMessageContext: vi.fn(actual.upsertInboundMessageContext),
    resolveByMsgId: vi.fn(actual.resolveByMsgId),
    resolveByAlias: vi.fn(actual.resolveByAlias),
    resolveByCreatedAtWindow: vi.fn(actual.resolveByCreatedAtWindow),
    clearMessageContextCacheForTest: vi.fn(actual.clearMessageContextCacheForTest),
  };
});

import { resetProactivePermissionHintStateForTest } from "../../../src/gateway/inbound-handler";
import * as messageContextStore from "../../../src/messaging/message-context-store";
import * as sendService from "../../../src/messaging/send-service";
import * as mediaUtils from "../../../src/messaging/media-utils";
import { clearCardRunRegistryForTest } from "../../../src/card/card-run-registry";
import { clearTargetDirectoryStateCache } from "../../../src/targeting/target-directory-store";

export { shared };

export const mockedUpsertInboundMessageContext = vi.mocked(
  messageContextStore.upsertInboundMessageContext,
);
export const uploadMediaMock = vi.mocked(sendService.uploadMedia);
export const prepareMediaInputMock = vi.mocked(mediaUtils.prepareMediaInput);
export const resolveOutboundMediaTypeMock = vi.mocked(mediaUtils.resolveOutboundMediaType);

export function buildRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({ agentId: "main", sessionKey: "s1", mainSessionKey: "s1" }),
        buildAgentSessionKey: vi.fn().mockReturnValue("agent-session-key"),
      },
      media: {
        saveMediaBuffer: vi.fn().mockResolvedValue({
          path: "/tmp/.openclaw/media/inbound/test-file.png",
          contentType: "image/png",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store.json"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockReturnValue("body"),
        finalizeInboundContext: vi.fn().mockReturnValue({ SessionKey: "s1" }),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onReasoningStream?.({ text: "thinking" });
            await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
            await dispatcherOptions.deliver({ text: "final output" }, { kind: "final" });
            return { queuedFinal: "queued final" };
          },
        ),
      },
    },
  };
}

/**
 * Shared mocks, runtime builder and per-test reset for the inbound-handler card suites.
 *
 * Import this module **before** any `src/gateway/inbound-handler` import so the `vi.mock`
 * registrations above are in place when the handler module is evaluated.
 */

export function beforeEachInboundHandlerCard(): void {
    clearTargetDirectoryStateCache();
    mockedUpsertInboundMessageContext.mockClear();
    shared.sendBySessionMock.mockReset();
    shared.sendMessageMock.mockReset();
    shared.sendMessageMock.mockImplementation(
      async (_config: unknown, _to: unknown, text: unknown, options: unknown) => {
        // Simulate real sendMessage behavior: update lastStreamedContent when appending to card
        const opts = options as { card?: { lastStreamedContent: unknown }; cardUpdateMode?: string } | undefined;
        if (opts?.card && opts?.cardUpdateMode === "append") {
          opts.card.lastStreamedContent = text;
        }
        return { ok: true };
      },
    );
    shared.extractMessageContentMock.mockReset();
    shared.extractMessageContentMock.mockReturnValue({ text: "hello", messageType: "text" });
    shared.acquireSessionLockMock.mockReset();
    shared.acquireSessionLockMock.mockResolvedValue(vi.fn());
    shared.createAICardMock.mockReset();
    shared.finishAICardMock.mockReset();
    shared.commitAICardBlocksMock.mockReset();
    shared.dispatchDingTalkCardStopCommandMock.mockReset();
    shared.dispatchDingTalkCardStopCommandMock.mockResolvedValue({ ok: true });
    shared.invalidateAskUserQuestionsForScopeMock.mockReset().mockResolvedValue([]);
    shared.syncInvalidatedAskUserQuestionCardsMock.mockReset().mockResolvedValue(undefined);
    shared.recallAICardMessageMock.mockReset().mockImplementation(async (card: { state?: string }) => {
      card.state = "3";
      return true;
    });
    shared.isCardInTerminalStateMock.mockReset();
    shared.updateAICardBlockListMock.mockReset().mockResolvedValue(undefined);
    shared.streamAICardMock.mockReset();
    uploadMediaMock.mockReset().mockResolvedValue({
      mediaId: "test-media-id",
      buffer: Buffer.from(""),
    } as never);
    prepareMediaInputMock.mockReset().mockImplementation(async (input: string) => ({ path: input }));
    resolveOutboundMediaTypeMock.mockReset().mockImplementation(({ mediaPath }: { mediaPath: string }) => {
      if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
        return "image";
      }
      return "file";
    });
    shared.getRuntimeMock.mockReturnValue(buildRuntime());
    resetProactivePermissionHintStateForTest();
    clearCardRunRegistryForTest();
    messageContextStore.clearMessageContextCacheForTest();
    shared.createAICardMock.mockResolvedValue({
      cardInstanceId: "card_1",
      state: "1",
      lastUpdated: Date.now(),
    });
}
