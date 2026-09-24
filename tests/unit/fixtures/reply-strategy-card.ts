import { vi } from "vitest";
import * as cardService from "../../../src/card/card-service";
import * as sendService from "../../../src/messaging/send-service";
import * as mediaUtils from "../../../src/messaging/media-utils";
import { clearAllSessionStatesForTest } from "../../../src/platform/session-state";
import { clearAllForTest as clearAllUsageForTest } from "../../../src/card/run-usage-store";
import { AICardStatus } from "../../../src/platform/types";
import type { AICardInstance } from "../../../src/platform/types";
import type { ReplyStrategyContext } from "../../../src/messaging/reply-strategy";

/**
 * Shared mocks and builders for the `reply-strategy-card` test suites.
 *
 * Import this module **before** any `src/messaging/reply-strategy-card` import so
 * the `vi.mock` registrations below are in place when the strategy module is
 * evaluated. Test files consume it through `beforeEachReplyStrategyCard` plus the
 * exported mock handles.
 */
vi.mock("../../../src/card/card-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/card/card-service")>();
    return {
        ...actual,
        finishAICard: vi.fn(),
        commitAICardBlocks: vi.fn(),
        updateAICardStatusLine: vi.fn(),
        streamAICard: vi.fn(),
        updateAICardBlockList: vi.fn(),
        streamAICardContent: vi.fn(),
        clearAICardStreamingContent: vi.fn(),
        sendSplitProactiveCards: vi.fn(),
    };
});

vi.mock("../../../src/messaging/send-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/messaging/send-service")>();
    return {
        ...actual,
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
        sendBySession: vi.fn().mockResolvedValue({}),
        sendProactiveTextOrMarkdown: vi.fn().mockResolvedValue({}),
        sendProactiveMedia: vi.fn().mockResolvedValue({ ok: true, mediaId: "test-media-id" }),
        uploadMedia: vi.fn().mockResolvedValue({ mediaId: "test-media-id" }),
    };
});

vi.mock("../../../src/messaging/media-utils", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/messaging/media-utils")>();
    return {
        ...actual,
        prepareMediaInput: vi.fn().mockImplementation(async (input: string) => ({ path: input })),
        resolveOutboundMediaType: vi.fn().mockImplementation(({ mediaPath }: { mediaPath: string }) => {
            // Detect media type based on file extension
            if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
                return "image";
            }
            return "file";
        }),
    };
});

export const commitAICardBlocksMock = vi.mocked(cardService.commitAICardBlocks);
export const updateAICardBlockListMock = vi.mocked(cardService.updateAICardBlockList);
export const updateAICardStatusLineMock = vi.mocked(cardService.updateAICardStatusLine);
export const streamAICardContentMock = vi.mocked(cardService.streamAICardContent);
export const clearAICardStreamingContentMock = vi.mocked(cardService.clearAICardStreamingContent);
export const sendSplitProactiveCardsMock = vi.mocked(cardService.sendSplitProactiveCards);
export const sendMessageMock = vi.mocked(sendService.sendMessage);
export const sendProactiveMediaMock = vi.mocked(sendService.sendProactiveMedia);
export const uploadMediaMock = vi.mocked(sendService.uploadMedia);
export const prepareMediaInputMock = vi.mocked(mediaUtils.prepareMediaInput);
export const resolveOutboundMediaTypeMock = vi.mocked(mediaUtils.resolveOutboundMediaType);

export function makeCard(overrides: Partial<AICardInstance> = {}): AICardInstance {
    return {
        cardInstanceId: "card-test",
        accessToken: "token",
        conversationId: "cid_1",
        state: AICardStatus.PROCESSING,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        ...overrides,
    } as AICardInstance;
}

export function buildCtx(
    card: AICardInstance,
    overrides: Partial<ReplyStrategyContext> = {},
): ReplyStrategyContext & { card: AICardInstance } {
    return {
        config: { clientId: "id", clientSecret: "secret", messageType: "card" } as any,
        to: "cid_1",
        sessionWebhook: "https://session.webhook",
        senderId: "sender_1",
        isDirect: true,
        accountId: "main",
        sessionAgentId: "main",
        storePath: "/tmp/store.json",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        deliverMedia: vi.fn(),
        card,
        ...overrides,
    };
}

/**
 * Fake timers plus a clean mock/state baseline for every `reply-strategy-card`
 * test. Register directly: `beforeEach(beforeEachReplyStrategyCard)`.
 */
export function beforeEachReplyStrategyCard(): void {
    vi.useFakeTimers();
    clearAllSessionStatesForTest();
    clearAllUsageForTest();
    commitAICardBlocksMock.mockClear().mockResolvedValue(undefined);
    updateAICardBlockListMock.mockClear().mockResolvedValue(undefined);
    updateAICardStatusLineMock.mockClear().mockResolvedValue(undefined);
    streamAICardContentMock.mockClear().mockResolvedValue(undefined);
    clearAICardStreamingContentMock.mockClear().mockResolvedValue(undefined);
    sendSplitProactiveCardsMock.mockReset().mockResolvedValue({
        ok: false,
        error: "no-cards",
        sent: 0,
        total: 0,
    });
    sendMessageMock.mockClear().mockResolvedValue({ ok: true });
    sendProactiveMediaMock.mockClear().mockResolvedValue({ ok: true, mediaId: "test-media-id" });
    uploadMediaMock.mockClear().mockResolvedValue({ mediaId: "test-media-id", buffer: Buffer.from("") });
    prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
    resolveOutboundMediaTypeMock.mockImplementation(({ mediaPath }: { mediaPath: string }) => {
        if (mediaPath.endsWith(".png") || mediaPath.endsWith(".jpg") || mediaPath.endsWith(".gif")) {
            return "image";
        }
        if (mediaPath.endsWith(".mp3") || mediaPath.endsWith(".wav")) {
            return "voice";
        }
        if (mediaPath.endsWith(".mp4") || mediaPath.endsWith(".mov")) {
            return "video";
        }
        return "file";
    });
}

/** Restores real timers. Register as `afterEach(afterEachReplyStrategyCard)`. */
export function afterEachReplyStrategyCard(): void {
    vi.useRealTimers();
}
