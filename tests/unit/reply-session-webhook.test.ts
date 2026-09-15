import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReplySessionWebhook } from "../../src/messaging/reply-session-webhook";
import { sendMessage } from "../../src/messaging/send-service";

vi.mock("../../src/platform/auth", () => ({ getAccessToken: vi.fn(async () => "test-token") }));
vi.mock("axios", () => ({ default: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("reply webhook selection", () => {
  it.each([0, NaN, Infinity, -1])("does not use an unknown or malformed deadline %s", (expiry) => {
    expect(resolveReplySessionWebhook("https://session.example", expiry)).toBe("");
  });
  it("rechecks time and switches to proactive before the expiry boundary", () => {
    vi.useFakeTimers();
    const now = Date.now();
    expect(resolveReplySessionWebhook("https://session.example", now + 30_001)).toBe(
      "https://session.example",
    );
    vi.setSystemTime(now + 1);
    expect(resolveReplySessionWebhook("https://session.example", now + 30_001)).toBe("");
    expect(resolveReplySessionWebhook("https://session.example")).toBe("https://session.example");
  });
  it.each([
    ["staff_origin", "/v1.0/robot/oToMessages/batchSend"],
    ["cid_Origin", "/v1.0/robot/groupMessages/send"],
  ])(
    "delivers an expired-session reply via the actual proactive API for %s",
    async (target, endpoint) => {
      vi.mocked(axios).mockResolvedValue({ status: 200, data: { processQueryKey: "delivery" } });
      const result = await sendMessage(
        { clientId: "bot", clientSecret: "secret", messageType: "markdown" } as any,
        target,
        "collection summary",
        { sessionWebhook: resolveReplySessionWebhook("https://expired.example", 0) },
      );
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(axios).toHaveBeenCalledOnce();
      const request = vi.mocked(axios).mock.calls[0][0] as any;
      expect(request.url).toBe("https://api.dingtalk.com" + endpoint);
      expect(
        target.startsWith("cid") ? request.data.openConversationId : request.data.userIds,
      ).toEqual(target.startsWith("cid") ? target : [target]);
    },
  );
});
