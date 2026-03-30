import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  attachNativeAckReactionMock: vi.fn(),
  recallNativeAckReactionWithRetryMock: vi.fn(),
}));

vi.mock("../../src/ack-reaction-service", () => ({
  attachNativeAckReaction: shared.attachNativeAckReactionMock,
  recallNativeAckReactionWithRetry: shared.recallNativeAckReactionWithRetryMock,
}));

import { createDynamicAckReactionController } from "../../src/ack-reaction/dynamic-ack-reaction-controller";

function createRuntimeEvents() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    surface: {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
    async emit(event: unknown) {
      await Promise.all(Array.from(listeners).map((listener) => listener(event)));
    },
  };
}

describe("dynamic-ack-reaction-controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shared.attachNativeAckReactionMock.mockReset();
    shared.recallNativeAckReactionWithRetryMock.mockReset();
    shared.attachNativeAckReactionMock.mockResolvedValue(true);
    shared.recallNativeAckReactionWithRetryMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("switches reaction when a correlated tool-start event arrives", async () => {
    const runtimeEvents = createRuntimeEvents();
    const controller = createDynamicAckReactionController({
      enabled: true,
      initialReaction: "🤔思考中",
      initialAttached: true,
      initialAttachedAt: Date.now(),
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      msgId: "msg_1",
      conversationId: "cid_1",
      sessionKey: "s1",
      runtimeEvents: runtimeEvents.surface,
    });

    await runtimeEvents.emit({
      stream: "lifecycle",
      sessionKey: "s1",
      runId: "run_1",
      data: { phase: "start", sessionKey: "s1", runId: "run_1" },
    });
    await runtimeEvents.emit({
      stream: "tool",
      sessionKey: "s1",
      runId: "run_1",
      data: { phase: "start", name: "read", toolCallId: "tool_1", sessionKey: "s1", runId: "run_1" },
    });
    await controller.awaitDrain();

    expect(shared.recallNativeAckReactionWithRetryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reactionName: "🤔思考中" }),
      undefined,
    );
    expect(shared.attachNativeAckReactionMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ reactionName: "📂" }),
      undefined,
    );
  });

  it("switches to heartbeat reaction after long tool silence", async () => {
    const runtimeEvents = createRuntimeEvents();
    const controller = createDynamicAckReactionController({
      enabled: true,
      initialReaction: "🤔思考中",
      initialAttached: true,
      initialAttachedAt: Date.now(),
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      msgId: "msg_2",
      conversationId: "cid_2",
      sessionKey: "s1",
      runtimeEvents: runtimeEvents.surface,
    });

    await runtimeEvents.emit({
      stream: "lifecycle",
      sessionKey: "s1",
      runId: "run_2",
      data: { phase: "start", sessionKey: "s1", runId: "run_2" },
    });
    await runtimeEvents.emit({
      stream: "tool",
      sessionKey: "s1",
      runId: "run_2",
      data: { phase: "start", name: "web_search", toolCallId: "tool_2", sessionKey: "s1", runId: "run_2" },
    });
    await controller.awaitDrain();

    shared.attachNativeAckReactionMock.mockClear();
    shared.recallNativeAckReactionWithRetryMock.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    await controller.awaitDrain();

    expect(shared.recallNativeAckReactionWithRetryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reactionName: "🌐" }),
      undefined,
    );
    expect(shared.attachNativeAckReactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reactionName: "⏳" }),
      undefined,
    );
  });

  it("logs debug and degrades cleanly when onAgentEvent is unavailable", async () => {
    const debugSpy = vi.fn();
    const controller = createDynamicAckReactionController({
      enabled: true,
      initialReaction: "🤔思考中",
      initialAttached: true,
      initialAttachedAt: Date.now(),
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      msgId: "msg_3",
      conversationId: "cid_3",
      sessionKey: "s1",
      runtimeEvents: {},
      log: { debug: debugSpy },
    });

    await controller.dispose(0);

    expect(debugSpy).toHaveBeenCalledWith(
      "[DingTalk] onAgentEvent not available, dynamic reaction tracking disabled",
    );
  });

  it("does not switch reactions when no initial ack reaction was attached", async () => {
    const runtimeEvents = createRuntimeEvents();
    const controller = createDynamicAckReactionController({
      enabled: true,
      initialReaction: "🤔思考中",
      initialAttached: false,
      initialAttachedAt: 0,
      dingtalkConfig: { clientId: "id", clientSecret: "secret" } as any,
      msgId: "msg_4",
      conversationId: "cid_4",
      sessionKey: "s1",
      runtimeEvents: runtimeEvents.surface,
    });

    await runtimeEvents.emit({
      stream: "lifecycle",
      sessionKey: "s1",
      runId: "run_4",
      data: { phase: "start", sessionKey: "s1", runId: "run_4" },
    });
    await runtimeEvents.emit({
      stream: "tool",
      sessionKey: "s1",
      runId: "run_4",
      data: { phase: "start", name: "exec", toolCallId: "tool_4", sessionKey: "s1", runId: "run_4" },
    });
    await controller.awaitDrain();

    expect(shared.recallNativeAckReactionWithRetryMock).not.toHaveBeenCalled();
    expect(shared.attachNativeAckReactionMock).not.toHaveBeenCalled();
  });
});
