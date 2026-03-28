import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  axiosPostMock: vi.fn(),
  getAccessTokenMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: shared.axiosPostMock,
  },
}));

vi.mock("../../src/auth", () => ({
  getAccessToken: shared.getAccessTokenMock,
}));

import {
  attachNativeAckReaction,
  recallNativeAckReactionWithRetry,
} from "../../src/ack-reaction-service";

describe("ack-reaction-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shared.axiosPostMock.mockReset();
    shared.getAccessTokenMock.mockReset();
    shared.getAccessTokenMock.mockResolvedValue("token_abc");
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it("does not schedule retry timers when robot identity is missing", async () => {
    const settled = vi.fn();

    void attachNativeAckReaction(
      { clientSecret: "secret_only" } as any,
      {
        msgId: "msg_1",
        conversationId: "cid_1",
      },
    ).then(settled);

    await vi.advanceTimersByTimeAsync(0);

    expect(shared.getAccessTokenMock).not.toHaveBeenCalled();
    expect(shared.axiosPostMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).toHaveBeenCalledWith(false);
  });

  it("does not schedule recall retry timers when robot identity is missing", async () => {
    const settled = vi.fn();

    void recallNativeAckReactionWithRetry(
      { clientSecret: "secret_only" } as any,
      {
        msgId: "msg_2",
        conversationId: "cid_2",
      },
    ).then(settled);

    await vi.advanceTimersByTimeAsync(0);

    expect(shared.getAccessTokenMock).not.toHaveBeenCalled();
    expect(shared.axiosPostMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).toHaveBeenCalledWith(undefined);
  });
});
