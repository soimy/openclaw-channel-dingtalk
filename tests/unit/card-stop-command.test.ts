import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    finalizeInboundContext: vi.fn(),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("../../src/runtime", () => ({
    getDingTalkRuntime: () => ({
        channel: {
            reply: {
                finalizeInboundContext: mocks.finalizeInboundContext,
                dispatchReplyWithBufferedBlockDispatcher:
                    mocks.dispatchReplyWithBufferedBlockDispatcher,
            },
        },
    }),
}));

import { dispatchDingTalkCardStopCommand } from "../../src/command/card-stop-command";

describe("dispatchDingTalkCardStopCommand", () => {
    beforeEach(() => {
        mocks.finalizeInboundContext.mockImplementation(
            (input: Record<string, unknown>) => ({
                ...input,
                CommandAuthorized: input.CommandAuthorized ?? false,
            }),
        );
        mocks.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
            queuedFinal: false,
            counts: {},
        });
    });

    const baseParams = {
        cfg: { session: { store: "/tmp/test" } } as any,
        accountId: "default",
        agentId: "test-agent",
        targetSessionKey: "agent:test-agent:dingtalk:cid_abc",
        clickerUserId: "user_123",
    };

    it("generates command SessionKey in format agent:<agentId>:dingtalk:card-stop:<userId>", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.SessionKey).toBe("agent:test-agent:dingtalk:card-stop:user_123");
    });

    it("sets CommandTargetSessionKey to the real conversation sessionKey", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.CommandTargetSessionKey).toBe("agent:test-agent:dingtalk:cid_abc");
    });

    it("sets Body, RawBody, and CommandBody to /stop", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.Body).toBe("/stop");
        expect(ctxArg.RawBody).toBe("/stop");
        expect(ctxArg.CommandBody).toBe("/stop");
    });

    it("sets CommandSource to native", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.CommandSource).toBe("native");
    });

    it("sets CommandAuthorized to true", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.CommandAuthorized).toBe(true);
    });

    it("calls dispatchReplyWithBufferedBlockDispatcher with finalized ctx and cfg", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        expect(mocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
        const call = mocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
        expect(call.cfg).toBe(baseParams.cfg);
        expect(call.ctx).toBeDefined();
        expect(call.dispatcherOptions.deliver).toBeTypeOf("function");
    });

    it("returns ok: true on successful dispatch", async () => {
        const result = await dispatchDingTalkCardStopCommand(baseParams);
        expect(result).toEqual({ ok: true });
    });

    it("propagates dispatch errors to caller", async () => {
        mocks.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValueOnce(
            new Error("dispatch failed"),
        );

        await expect(dispatchDingTalkCardStopCommand(baseParams)).rejects.toThrow(
            "dispatch failed",
        );
    });

    it("deliver callback is a silent no-op", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const call = mocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
        await expect(
            call.dispatcherOptions.deliver({ text: "Generation stopped." }),
        ).resolves.toBeUndefined();
    });

    it("sets Provider and Surface to dingtalk", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.Provider).toBe("dingtalk");
        expect(ctxArg.Surface).toBe("dingtalk");
    });

    it("sets SenderId to the clicker userId", async () => {
        await dispatchDingTalkCardStopCommand(baseParams);

        const ctxArg = mocks.finalizeInboundContext.mock.calls[0][0];
        expect(ctxArg.SenderId).toBe("user_123");
    });
});
