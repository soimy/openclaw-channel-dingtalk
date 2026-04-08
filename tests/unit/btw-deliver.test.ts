import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/send-service", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import { deliverBtwReply } from "../../src/messaging/btw-deliver";
import { sendMessage } from "../../src/send-service";
import { buildBtwBlockquote } from "../../src/messaging/btw-deliver";

describe("buildBtwBlockquote", () => {
  it("formats a normal /btw question with sender prefix", () => {
    const result = buildBtwBlockquote("王滨", "/btw 这个函数为什么慢");
    expect(result).toBe("> 王滨: /btw 这个函数为什么慢\n\n");
  });

  it("omits sender prefix when senderName is empty", () => {
    const result = buildBtwBlockquote("", "/btw foo");
    expect(result).toBe("> /btw foo\n\n");
  });

  it("strips a single leading @mention", () => {
    const result = buildBtwBlockquote("王滨", "@Bot /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("strips multiple leading @mentions", () => {
    const result = buildBtwBlockquote("王滨", "@Bot @Other /btw foo");
    expect(result).toBe("> 王滨: /btw foo\n\n");
  });

  it("truncates question over 80 characters with ellipsis", () => {
    const longQuestion = "/btw " + "a".repeat(200);
    const result = buildBtwBlockquote("王滨", longQuestion);
    expect(result.startsWith("> 王滨: ")).toBe(true);
    expect(result).toContain("…\n\n");
    const inner = result.slice("> 王滨: ".length, -2);
    expect(inner).toHaveLength(81);
    expect(inner.endsWith("…")).toBe(true);
  });

  it("truncates by Unicode code points so emoji are not split", () => {
    // Each 🤔 is one code point but 2 UTF-16 code units. 100 emoji = 100 code
    // points (over the 80 limit) → must truncate to 80 emoji + …, not 40.
    const longEmoji = "🤔".repeat(100);
    const result = buildBtwBlockquote("", longEmoji);
    const inner = result.slice("> ".length, -2);
    expect([...inner].length).toBe(81); // 80 emoji + …
    expect(inner.endsWith("…")).toBe(true);
    // Ensure no half surrogates leaked in
    expect(inner.slice(0, -1)).toBe("🤔".repeat(80));
  });

  it("does not truncate question at exactly 80 characters", () => {
    const exact80 = "/btw " + "a".repeat(75);
    const result = buildBtwBlockquote("王滨", exact80);
    expect(result).toBe(`> 王滨: ${exact80}\n\n`);
    expect(result).not.toContain("…");
  });
});

describe("deliverBtwReply", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockReset();
    vi.mocked(sendMessage).mockResolvedValue({ ok: true });
  });

  it("delegates to sendMessage with forceMarkdown and sessionWebhook when provided", async () => {
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?token=abc",
      conversationId: "cidXXX",
      to: "userA",
      senderName: "王滨",
      rawQuestion: "/btw foo",
      replyText: "the answer",
      log: undefined,
    });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, conversationIdArg, textArg, optionsArg] = vi.mocked(sendMessage).mock.calls[0];
    expect(conversationIdArg).toBe("userA");
    expect(textArg).toBe("> 王滨: /btw foo\n\nthe answer");
    expect(optionsArg).toMatchObject({
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?token=abc",
      forceMarkdown: true,
      conversationId: "cidXXX",
    });
  });

  it("delegates to sendMessage with forceMarkdown and no sessionWebhook when absent", async () => {
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: undefined,
      conversationId: "cidXXX",
      to: "userA",
      senderName: "",
      rawQuestion: "/btw bar",
      replyText: "answer",
      log: undefined,
    });

    expect(result.ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, , textArg, optionsArg] = vi.mocked(sendMessage).mock.calls[0];
    expect(textArg).toBe("> /btw bar\n\nanswer");
    expect(optionsArg).toMatchObject({ forceMarkdown: true, sessionWebhook: undefined });
  });

  it("propagates sendMessage { ok: false } instead of silently succeeding", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce({ ok: false, error: "session webhook expired" });
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: "https://example",
      conversationId: "cidXXX",
      to: "userA",
      senderName: "王滨",
      rawQuestion: "/btw foo",
      replyText: "answer",
      log: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("session webhook expired");
  });

  it("returns ok=false when sendMessage throws", async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("network down"));
    const result = await deliverBtwReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: {} as any,
      sessionWebhook: "https://example",
      conversationId: "cidXXX",
      to: "userA",
      senderName: "王滨",
      rawQuestion: "/btw foo",
      replyText: "answer",
      log: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});
