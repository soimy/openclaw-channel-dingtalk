import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/send-service", () => ({
  sendBySession: vi.fn(async () => ({ ok: true })),
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import { deliverBtwReply } from "../../src/messaging/btw-deliver";
import { sendBySession, sendMessage } from "../../src/send-service";
import { buildBtwBlockquote } from "../../src/messaging/btw-deliver";

describe("buildBtwBlockquote", () => {
  it("formats a normal /btw question with sender prefix on its own line", () => {
    const result = buildBtwBlockquote("王滨", "/btw 这个函数为什么慢");
    expect(result).toBe("> 王滨:  \n> /btw 这个函数为什么慢\n\n");
  });

  it("omits sender line when senderName is empty", () => {
    const result = buildBtwBlockquote("", "/btw foo");
    expect(result).toBe("> /btw foo\n\n");
  });

  it("strips a single leading @mention", () => {
    const result = buildBtwBlockquote("王滨", "@Bot /btw foo");
    expect(result).toBe("> 王滨:  \n> /btw foo\n\n");
  });

  it("strips multiple leading @mentions", () => {
    const result = buildBtwBlockquote("王滨", "@Bot @Other /btw foo");
    expect(result).toBe("> 王滨:  \n> /btw foo\n\n");
  });

  it("truncates question over 80 characters with ellipsis", () => {
    const longQuestion = "/btw " + "a".repeat(200);
    const result = buildBtwBlockquote("王滨", longQuestion);
    expect(result.startsWith("> 王滨:  \n> ")).toBe(true);
    expect(result).toContain("…\n\n");
    const inner = result.slice("> 王滨:  \n> ".length, -2);
    expect(inner).toHaveLength(81);
    expect(inner.endsWith("…")).toBe(true);
  });

  it("does not truncate question at exactly 80 characters", () => {
    const exact80 = "/btw " + "a".repeat(75);
    const result = buildBtwBlockquote("王滨", exact80);
    expect(result).toBe(`> 王滨:  \n> ${exact80}\n\n`);
    expect(result).not.toContain("…");
  });
});

describe("deliverBtwReply", () => {
  beforeEach(() => {
    vi.mocked(sendBySession).mockClear();
    vi.mocked(sendMessage).mockClear();
  });

  it("uses sendBySession when sessionWebhook is provided", async () => {
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
    expect(sendBySession).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const call = vi.mocked(sendBySession).mock.calls[0];
    expect(call[2]).toBe("> 王滨:  \n> /btw foo\n\nthe answer");
  });

  it("uses sendMessage when sessionWebhook is undefined", async () => {
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
    expect(sendBySession).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessage).mock.calls[0][2]).toBe("> /btw bar\n\nanswer");
  });

  it("returns ok=false when send throws", async () => {
    vi.mocked(sendBySession).mockRejectedValueOnce(new Error("network down"));
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
