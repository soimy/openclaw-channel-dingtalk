import { afterEach, expect, it, vi } from "vitest";
import { resolveReplySessionWebhook } from "../../src/messaging/reply-session-webhook";
import { createReplyStrategy } from "../../src/messaging/reply-strategy";
import { createCardReplyStrategy } from "../../src/messaging/reply-strategy-card";
vi.mock("../../src/messaging/reply-strategy-card", () => ({
  createCardReplyStrategy: vi.fn(() => ({})),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("retains late webhook resolution when the factory constructs a card strategy", () => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 60_000;
  createReplyStrategy({
    useCardMode: true,
    card: {},
    get sessionWebhook() {
      return resolveReplySessionWebhook("https://session.example", expiresAt);
    },
  } as any);
  const context = vi.mocked(createCardReplyStrategy).mock.calls[0][0];
  expect(context.sessionWebhook).toBe("https://session.example");
  vi.setSystemTime(expiresAt);
  expect(context.sessionWebhook).toBe("");
});
