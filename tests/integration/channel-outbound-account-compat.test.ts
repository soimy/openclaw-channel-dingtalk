import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const shared = vi.hoisted(() => ({ sendText: vi.fn(), sendMedia: vi.fn(), runtime: vi.fn() }));
vi.mock("../../src/messaging/send-service", () => ({ sendMessage: shared.sendText, sendMedia: shared.sendMedia }));
vi.mock("../../src/platform/runtime", () => ({ getDingTalkRuntime: shared.runtime }));
vi.mock("../../src/platform/logger-context", () => ({ getLogger: () => undefined }));

import { createDingTalkOutbound } from "../../src/messaging/channel-outbound";
import { getConfig } from "../../src/platform/config";

const cfg = { channels: { dingtalk: { clientId: "root-bot", clientSecret: "test-secret", dmPolicy: "pairing" } } } as OpenClawConfig;

describe("outbound adapter account compatibility with real config resolution", () => {
  beforeEach(() => {
    shared.sendText.mockReset().mockResolvedValue({ ok: true, data: { messageId: "text-1" } });
    shared.sendMedia.mockReset().mockResolvedValue({ ok: true, messageId: "media-1" });
    shared.runtime.mockReturnValue({ channel: { session: { resolveStorePath: vi.fn().mockReturnValue("/tmp/outbound-compat-sessions.json") } } });
  });

  it.each([null, undefined])("treats accountId=%j as unspecified in config resolution", (accountId) => {
    expect(getConfig(cfg, accountId)).toEqual(getConfig(cfg));
  });

  it.each([null, undefined])("sends text with the SDK's nullable accountId=%j", async (accountId) => {
    const result = await createDingTalkOutbound().sendText!({ cfg, to: "user:staff-1", text: "hello", accountId });
    expect(result.messageId).toBe("text-1");
    expect(shared.sendText).toHaveBeenCalledWith(expect.objectContaining({ clientId: "root-bot" }), "user:staff-1", "hello", expect.objectContaining({ accountId }));
  });

  it.each([null, undefined])("sends media with the SDK's nullable accountId=%j", async (accountId) => {
    const result = await createDingTalkOutbound().sendMedia!({ cfg, to: "user:staff-1", mediaUrl: "/test/image.png", accountId });
    expect(result.messageId).toBe("media-1");
    expect(shared.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ clientId: "root-bot" }), "user:staff-1", "/test/image.png", expect.objectContaining({ accountId }));
  });

  it.each(["", " "])("still rejects explicitly blank accountId=%j before text or media sending", async (accountId) => {
    const outbound = createDingTalkOutbound();
    await expect(outbound.sendText!({ cfg, to: "user:staff-1", text: "hello", accountId })).rejects.toThrow(/empty or whitespace/);
    await expect(outbound.sendMedia!({ cfg, to: "user:staff-1", mediaUrl: "/test/image.png", accountId })).rejects.toThrow(/empty or whitespace/);
    expect(shared.sendText).not.toHaveBeenCalled();
    expect(shared.sendMedia).not.toHaveBeenCalled();
  });

  it("does not let an unspecified account bypass configured identity collisions", async () => {
    const collision = { channels: { dingtalk: { accounts: { Main: { clientId: "first" }, main: { clientId: "second" } } } } } as OpenClawConfig;
    const outbound = createDingTalkOutbound();
    await expect(outbound.sendText!({ cfg: collision, to: "user:staff-1", text: "hello", accountId: null })).rejects.toThrow(/pairing identity/);
    await expect(outbound.sendMedia!({ cfg: collision, to: "user:staff-1", mediaUrl: "/test/image.png", accountId: null })).rejects.toThrow(/pairing identity/);
    expect(shared.sendText).not.toHaveBeenCalled();
    expect(shared.sendMedia).not.toHaveBeenCalled();
  });
});
