import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/platform/types";
import {
    resetOutboundSendThrottle,
    resolveOutboundThrottleScope,
    runThrottledOutboundSend,
} from "../../src/shared/outbound-throttle";

const BASE_MS = 1_700_000_000_000;

describe("runThrottledOutboundSend", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_MS);
        resetOutboundSendThrottle();
    });

    afterEach(() => {
        resetOutboundSendThrottle();
        vi.useRealTimers();
    });

    it("never waits when the caller cannot name the conversation", async () => {
        const started = Date.now();

        const result = await runThrottledOutboundSend(undefined, 1000, async () => "sent");

        expect(result).toBe("sent");
        expect(Date.now() - started).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("never waits when the interval is disabled or unusable", async () => {
        for (const interval of [0, -5, Number.NaN]) {
            await runThrottledOutboundSend("default:cid", interval, async () => undefined);
        }

        expect(vi.getTimerCount()).toBe(0);
    });

    it("runs the first send of a conversation immediately", async () => {
        const started = Date.now();

        await runThrottledOutboundSend("default:cid", 1000, async () => undefined);

        expect(Date.now() - started).toBe(0);
    });

    it("returns the operation result to its caller", async () => {
        await expect(
            runThrottledOutboundSend("default:cid", 1000, async () => ({ ok: true })),
        ).resolves.toEqual({ ok: true });
    });

    it("spaces consecutive sends to the same conversation by the interval", async () => {
        await runThrottledOutboundSend("default:cid", 1000, async () => undefined);

        let started = false;
        const second = runThrottledOutboundSend("default:cid", 1000, async () => {
            started = true;
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(started).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(started).toBe(true);
    });

    it("stops waiting once the conversation has already been idle past the interval", async () => {
        await runThrottledOutboundSend("default:cid", 1000, async () => undefined);
        await vi.advanceTimersByTimeAsync(5000);

        const started = Date.now();
        await runThrottledOutboundSend("default:cid", 1000, async () => undefined);

        expect(Date.now() - started).toBe(0);
    });

    it("keeps separate conversations independent", async () => {
        await runThrottledOutboundSend("default:a", 1000, async () => undefined);

        let started = false;
        const other = runThrottledOutboundSend("default:b", 1000, async () => {
            started = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        await other;

        expect(started).toBe(true);
    });

    // Greptile review (PR #627, third finding): a queued send that captured its
    // predecessor's start time before that predecessor was admitted would read a
    // placeholder, compute a negative wait, and start immediately — losing the
    // spacing that keeps messages out of the same second.
    it("spaces every send when several are queued in the same tick", async () => {
        const starts: number[] = [];
        const send = () =>
            runThrottledOutboundSend("default:cid", 1000, async () => {
                starts.push(Date.now() - BASE_MS);
            });

        const all = Promise.all([send(), send(), send()]);
        await vi.advanceTimersByTimeAsync(5000);
        await all;

        expect(starts).toEqual([0, 1000, 2000]);
    });

    // Greptile review (PR #627, P1): spacing start times alone still lets a slow
    // send overlap the next one and finish after it, which reproduces the very
    // reordering this change exists to prevent.
    it("serializes sends so a slow one cannot be overtaken by the next", async () => {
        const order: string[] = [];
        let releaseSlow: () => void = () => {};
        const slowGate = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });

        const slow = runThrottledOutboundSend("default:cid", 1000, async () => {
            order.push("slow:start");
            await slowGate;
            order.push("slow:end");
        });
        const fast = runThrottledOutboundSend("default:cid", 1000, async () => {
            order.push("fast:start");
            order.push("fast:end");
        });

        // Well past the interval: the second send still must not have started,
        // because the first one has not finished.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(order).toEqual(["slow:start"]);

        releaseSlow();
        await vi.advanceTimersByTimeAsync(10_000);
        await Promise.all([slow, fast]);

        expect(order).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
    });

    it("does not wait on a slow send once it has settled", async () => {
        const slow = runThrottledOutboundSend("default:cid", 1000, async () => {
            await new Promise((resolve) => setTimeout(resolve, 3000));
        });
        const fast = runThrottledOutboundSend("default:cid", 1000, async () => "sent");

        await vi.advanceTimersByTimeAsync(3000);
        await slow;

        // The slow send already consumed the interval, so the next one starts as
        // soon as it settles instead of waiting a fresh 1000ms.
        await vi.advanceTimersByTimeAsync(0);
        await expect(fast).resolves.toBe("sent");
    });

    it("propagates a failed send without wedging later sends to the scope", async () => {
        const failing = runThrottledOutboundSend("default:cid", 1000, async () => {
            throw new Error("send exploded");
        });
        await expect(failing).rejects.toThrow("send exploded");

        const next = runThrottledOutboundSend("default:cid", 1000, async () => "sent");
        await vi.advanceTimersByTimeAsync(1000);

        await expect(next).resolves.toBe("sent");
    });

    it("logs each wait so a real-device run can prove the throttle engaged", async () => {
        const debug = vi.fn();
        const log = { debug } as unknown as Logger;

        await runThrottledOutboundSend("default:cid", 1000, async () => undefined, log);
        expect(debug).not.toHaveBeenCalled();

        const second = runThrottledOutboundSend("default:cid", 1000, async () => undefined, log);
        // The send is admitted on a microtask (it first awaits the previous
        // chain), so let it settle before asserting on the log.
        await vi.advanceTimersByTimeAsync(0);
        expect(debug).toHaveBeenCalledTimes(1);
        expect(debug.mock.calls[0]?.[0]).toContain("Outbound send throttled");
        expect(debug.mock.calls[0]?.[0]).toContain("waitMs=1000");

        await vi.advanceTimersByTimeAsync(1000);
        await second;
    });
});

describe("resolveOutboundThrottleScope", () => {
    it("returns undefined without a conversation id so unrelated chats are never serialized", () => {
        expect(resolveOutboundThrottleScope({})).toBeUndefined();
        expect(resolveOutboundThrottleScope({ accountId: "bot" })).toBeUndefined();
        expect(resolveOutboundThrottleScope({ conversationId: "   " })).toBeUndefined();
    });

    it("scopes by account and conversation", () => {
        expect(resolveOutboundThrottleScope({ conversationId: "cid" })).toBe("default:cid");
        expect(resolveOutboundThrottleScope({ accountId: "bot", conversationId: "cid" })).toBe(
            "bot:cid",
        );
    });

    // Greptile review (PR #627, P2): distinct accounts may legitimately reuse a
    // conversation id, and their delivery streams are unrelated.
    it("keeps accounts apart even when they share a conversation id", async () => {
        await runThrottledOutboundSend("account-a:cid", 1000, async () => undefined);

        const started = Date.now();
        await runThrottledOutboundSend("account-b:cid", 1000, async () => undefined);

        expect(Date.now() - started).toBe(0);
    });
});
