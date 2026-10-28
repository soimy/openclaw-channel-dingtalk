import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPairingChallengeDelivery,
  deliverPairingChallenge,
  resetPairingChallengeDeliveryForTest,
} from "../../src/gateway/pairing-challenge-delivery";

const challenge = { accountId: "primary", senderId: "staff-1", code: "TEST2345" };

beforeEach(() => {
  resetPairingChallengeDeliveryForTest();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
});

afterEach(() => vi.useRealTimers());

describe("pairing challenge delivery", () => {
  it("sends a pending code once after success, independently of request creation", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverPairingChallenge(challenge, send);
    vi.advanceTimersByTime(10 * 60_000);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries only after 60 seconds from the most recent failed send", async () => {
    const error = new Error("send unavailable");
    const send = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue(undefined);
    await expect(deliverPairingChallenge(challenge, send)).rejects.toBe(error);
    vi.advanceTimersByTime(59_999);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(deliverPairingChallenge(challenge, send)).rejects.toBe(error);
    vi.advanceTimersByTime(59_999);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await deliverPairingChallenge(challenge, send);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("starts cooldown after a slow failure settles and releases the in-flight reservation", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const pending = deliverPairingChallenge(challenge, send);
    vi.advanceTimersByTime(61 * 60_000);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
    const rejected = expect(pending).rejects.toThrow("slow failure");
    reject(new Error("slow failure"));
    await rejected;
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reserves before calling a sender that throws synchronously", async () => {
    const send = vi.fn(() => { throw new Error("reply construction failed"); });
    await expect(deliverPairingChallenge(challenge, send)).rejects.toThrow("reply construction failed");
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send an empty code or suppress a later valid code", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverPairingChallenge({ ...challenge, code: "" }, send);
    expect(send).not.toHaveBeenCalled();
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("isolates accounts and users even when they share a code", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverPairingChallenge(challenge, send);
    await deliverPairingChallenge({ ...challenge, accountId: "secondary" }, send);
    await deliverPairingChallenge({ ...challenge, senderId: "staff-2" }, send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not alias account/user scopes containing delimiters", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverPairingChallenge({ ...challenge, accountId: "a:b", senderId: "c" }, send);
    await deliverPairingChallenge({ ...challenge, accountId: "a", senderId: "b:c" }, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])("sends a replacement code immediately after old-code %s", async (outcome) => {
    const send = vi.fn().mockResolvedValue(undefined);
    if (outcome === "failure") send.mockRejectedValueOnce(new Error("unavailable"));
    await deliverPairingChallenge(challenge, send).catch(() => undefined);
    const replacement = { ...challenge, code: "NEWCODE2" };
    await deliverPairingChallenge(replacement, send);
    await deliverPairingChallenge(replacement, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not let late old-code completion overwrite new-code delivery state", async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const old = deliverPairingChallenge(challenge, send);
    const replacement = { ...challenge, code: "NEWCODE2" };
    await deliverPairingChallenge(replacement, send);
    const rejected = expect(old).rejects.toThrow("old failure");
    reject(new Error("old failure"));
    await rejected;
    await deliverPairingChallenge(replacement, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps one send in flight even across cache expiry", async () => {
    let resolve!: () => void;
    const send = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const first = deliverPairingChallenge(challenge, send);
    vi.advanceTimersByTime(60 * 60_000 + 1);
    await Promise.all([deliverPairingChallenge(challenge, send), deliverPairingChallenge(challenge, send)]);
    expect(send).toHaveBeenCalledTimes(1);
    resolve();
    await first;
  });

  it("expires settled delivery state after an hour", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliverPairingChallenge(challenge, send);
    vi.advanceTimersByTime(60 * 60_000);
    await deliverPairingChallenge(challenge, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("clears only the admitted user's state", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const other = { ...challenge, accountId: "secondary" };
    await deliverPairingChallenge(challenge, send);
    await deliverPairingChallenge(other, send);
    clearPairingChallengeDelivery(challenge.accountId, challenge.senderId);
    await deliverPairingChallenge(challenge, send);
    await deliverPairingChallenge(other, send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("bounds state without evicting active sends, and recovers capacity after settlement", async () => {
    const releases: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((done) => { releases.push(done); }));
    const pending = Array.from({ length: 1000 }, (_, index) => deliverPairingChallenge({ ...challenge, senderId: `staff-${index}` }, send));
    const overflow = { ...challenge, senderId: "overflow" };
    await deliverPairingChallenge(overflow, send);
    expect(send).toHaveBeenCalledTimes(1000);
    releases[0]();
    await pending[0];
    const recovered = deliverPairingChallenge(overflow, send);
    await deliverPairingChallenge({ ...challenge, senderId: "staff-1" }, send);
    expect(send).toHaveBeenCalledTimes(1001);
    releases.forEach((resolve) => resolve());
    await Promise.all([...pending, recovered]);
  });

  it("does not evict failed-send cooldowns when capacity is full", async () => {
    const send = vi.fn().mockRejectedValue(new Error("unavailable"));
    await Promise.all(Array.from({ length: 1000 }, (_, index) =>
      deliverPairingChallenge({ ...challenge, senderId: `staff-${index}` }, send).catch(() => undefined),
    ));
    const overflow = { ...challenge, senderId: "overflow" };
    await deliverPairingChallenge(overflow, send);
    await deliverPairingChallenge({ ...challenge, senderId: "staff-0" }, send);
    expect(send).toHaveBeenCalledTimes(1000);
    vi.advanceTimersByTime(60_000);
    send.mockResolvedValue(undefined);
    await deliverPairingChallenge(overflow, send);
    expect(send).toHaveBeenCalledTimes(1001);
  });
});
