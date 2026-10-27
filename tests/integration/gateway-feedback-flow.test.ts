import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  connectMock: vi.fn(),
  waitForStopMock: vi.fn(),
  stopMock: vi.fn(),
  isConnectedMock: vi.fn(),
  listeners: {} as Record<string, (res: any) => Promise<void>>,
  socketCallBackResponseMock: vi.fn(),
  isMessageProcessedMock: vi.fn(),
  markMessageProcessedMock: vi.fn(),
  handleDingTalkMessageMock: vi.fn(),
  sendProactiveTextMock: vi.fn(),
  connectionConfig: undefined as any,
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock("dingtalk-stream", () => ({
  TOPIC_CARD: "TOPIC_CARD",
  TOPIC_ROBOT: "TOPIC_ROBOT",
  DWClient: class {
    config: Record<string, unknown>;
    registerCallbackListener: (topic: string, cb: (res: any) => Promise<void>) => void;
    socketCallBackResponse: (messageId: string, payload: unknown) => void;

    constructor() {
      this.config = {};
      this.registerCallbackListener = vi.fn((_topic: string, cb: (res: any) => Promise<void>) => {
        shared.listeners[_topic] = cb;
      });
      this.socketCallBackResponse = shared.socketCallBackResponseMock;
    }
  },
}));

vi.mock("../../src/gateway/connection-manager", () => ({
  ConnectionManager: class {
    connect: () => Promise<void>;
    waitForStop: () => Promise<void>;
    stop: () => void;
    isConnected: () => boolean;

    constructor(_client: unknown, _accountId: string, config: unknown) {
      shared.connectionConfig = config;
      this.connect = shared.connectMock;
      this.waitForStop = shared.waitForStopMock;
      this.stop = shared.stopMock;
      this.isConnected = shared.isConnectedMock;
    }
  },
}));

vi.mock("../../src/shared/dedup", () => ({
  isMessageProcessed: shared.isMessageProcessedMock,
  markMessageProcessed: shared.markMessageProcessedMock,
}));

vi.mock("../../src/gateway/inbound-handler", () => ({
  handleDingTalkMessage: shared.handleDingTalkMessageMock,
}));

vi.mock("../../src/messaging/send-service", () => ({
  sendMessage: vi.fn(),
  sendProactiveMedia: vi.fn(),
  sendProactiveTextOrMarkdown: shared.sendProactiveTextMock,
  sendBySession: vi.fn(),
  uploadMedia: vi.fn(),
}));

import { CHANNEL_INFLIGHT_NAMESPACE_POLICY, dingtalkPlugin } from "../../src/channel";

const startGatewayAccount = (ctx: any) => dingtalkPlugin.gateway!.startAccount!(ctx);

function createStartContext() {
  let status = {
    accountId: "main",
    running: false,
    lastStartAt: null as number | null,
    lastStopAt: null as number | null,
    lastError: null as string | null,
  };

  return {
    cfg: {},
    account: {
      accountId: "main",
      config: { clientId: "ding_id", clientSecret: "ding_secret" },
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getStatus: () => status,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

import * as feedbackCallbacks from "../../src/card/feedback-callback";

const frame = () => ({
  headers: { messageId: "vote-event-1", time: "1800000000000" },
  data: JSON.stringify({
    userId: "alice",
    userIdType: 1,
    outTrackId: "card-1",
    content: JSON.stringify({
      cardPrivateData: {
        actionIds: ["feedback_vote"],
        params: { variableKey: "node_test_likeOrDislike", variableValue: "like" },
      },
    }),
  }),
});

describe("gateway feedback transport", () => {
  beforeEach(() => {
    shared.connectMock.mockReset();
    shared.waitForStopMock.mockReset();
    shared.stopMock.mockReset();
    shared.isConnectedMock.mockReset();
    shared.socketCallBackResponseMock.mockReset();
    shared.isMessageProcessedMock.mockReset();
    shared.markMessageProcessedMock.mockReset();
    shared.handleDingTalkMessageMock.mockReset();
    shared.sendProactiveTextMock.mockReset();
    shared.connectionConfig = undefined;

    shared.listeners = {};
    shared.connectMock.mockResolvedValue(undefined);
    shared.waitForStopMock.mockResolvedValue(undefined);
    shared.isConnectedMock.mockReturnValue(false);
    shared.sendProactiveTextMock.mockResolvedValue({});
  });

  it("does not claim feedback was saved for an unbound legacy callback", async () => {
    await startGatewayAccount(createStartContext() as any);
    await shared.listeners.TOPIC_CARD({
      headers: { messageId: "legacy" },
      data: JSON.stringify({
        value: JSON.stringify({ cardPrivateData: { actionIds: ["feedback_up"] } }),
        spaceType: "IM",
        userId: "alice",
      }),
    });
    expect(shared.sendProactiveTextMock).not.toHaveBeenCalled();
    expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("legacy", { success: false });
  });
  it("acknowledges with private UI state only after persistence resolves", async () => {
    let resolve: (value: any) => void = () => {};
    const spy = vi.spyOn(feedbackCallbacks, "handleFeedbackCallback").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    try {
      await startGatewayAccount(createStartContext() as any);
      const pending = shared.listeners.TOPIC_CARD(frame());
      expect(shared.socketCallBackResponseMock).not.toHaveBeenCalled();
      const response = {
        userPrivateData: { cardParamMap: { node_test_likeOrDislike: "like" } },
        cardUpdateOptions: { updatePrivateDataByKey: true },
      };
      resolve({ response, userId: "alice" });
      await pending;
      expect(shared.socketCallBackResponseMock).toHaveBeenCalledWith("vote-event-1", response);
      expect(shared.sendProactiveTextMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("withholds ACK after storage failure to allow delivery retry", async () => {
    const spy = vi
      .spyOn(feedbackCallbacks, "handleFeedbackCallback")
      .mockRejectedValue(new Error("disk full"));
    try {
      const ctx = createStartContext();
      await startGatewayAccount(ctx as any);
      await shared.listeners.TOPIC_CARD(frame());
      expect(shared.socketCallBackResponseMock).not.toHaveBeenCalled();
      expect(ctx.log.error).toHaveBeenCalledWith(
        expect.stringContaining("callback not acknowledged"),
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("uses a plain rejection notice rather than creating another rateable card", async () => {
    const spy = vi.spyOn(feedbackCallbacks, "handleFeedbackCallback").mockResolvedValue({
      response: { success: false },
      userId: "denied-user",
      notice: "只有原提问者可以评价。",
    });
    try {
      await startGatewayAccount(createStartContext() as any);
      await shared.listeners.TOPIC_CARD(frame());
      expect(shared.sendProactiveTextMock).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: "markdown" }),
        "denied-user",
        "只有原提问者可以评价。",
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
