import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMessage,
  dispatch,
  shared,
  resetInboundSessionQueueIntegrationTest,
  cleanupInboundSessionQueueIntegrationTest,
} from "../unit/fixtures/inbound-session-queue-fixture";

beforeEach(resetInboundSessionQueueIntegrationTest);
afterEach(cleanupInboundSessionQueueIntegrationTest);

describe("targeted question reply webhook expiry", () => {
  it.each(["1", "2"])(
    "selects original type %s destination when expiry occurs during model generation",
    async (conversationType) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const start = Date.now();
      const msg = buildMessage("collection result", "expired-question");
      msg.inboundOrigin = "ask-user";
      msg.inboundQueueEligible = false;
      msg.dingtalkConfig.messageType = "markdown";
      msg.data.conversationType = conversationType;
      msg.data.conversationId = "cid_Original";
      msg.data.senderStaffId = "staff_Original";
      msg.replySessionWebhookExpiresAt = start + 60_000;
      shared.extractMessageContentMock.mockReturnValue({
        text: "collection result",
        mediaUrls: [],
      });
      shared.dispatchMock.mockImplementation(async (args) => {
        vi.setSystemTime(start + 61_000);
        await args.dispatcherOptions.deliver({ text: "summary" }, { kind: "final" });
        return { queuedFinal: true, counts: { final: 1 } };
      });
      await dispatch(msg);
      expect(shared.sendMessageMock).toHaveBeenCalledWith(
        msg.dingtalkConfig,
        conversationType === "1" ? "staff_Original" : "cid_Original",
        "summary",
        expect.objectContaining({ sessionWebhook: "" }),
      );
      expect(shared.sendBySessionMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, Date.now() + 3_600_000])(
    "keeps session replies for ordinary messages or a valid webhook (%s)",
    async (expiry) => {
      const msg = buildMessage("collection result", "valid-question");
      msg.inboundOrigin = "ask-user";
      msg.inboundQueueEligible = false;
      msg.dingtalkConfig.messageType = "markdown";
      msg.replySessionWebhookExpiresAt = expiry;
      shared.extractMessageContentMock.mockReturnValue({
        text: "collection result",
        mediaUrls: [],
      });
      shared.dispatchMock.mockImplementation(async (args) => {
        await args.dispatcherOptions.deliver({ text: "summary" }, { kind: "final" });
        return { queuedFinal: true, counts: { final: 1 } };
      });
      await dispatch(msg);
      expect(shared.sendMessageMock).toHaveBeenCalledWith(
        msg.dingtalkConfig,
        msg.data.senderId,
        "summary",
        expect.objectContaining({ sessionWebhook: msg.sessionWebhook }),
      );
    },
  );
});
