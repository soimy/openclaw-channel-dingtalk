import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import httpClient from "../../src/http-client";

vi.mock("../../src/http-client", () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import {
  RegistrationError,
  beginDeviceRegistration,
  openUrlInBrowser,
} from "../../src/device-registration";

// Helper: mock a sequence of POST responses
function mockPostSequence(responses: Record<string, unknown>[]) {
  const fn = vi.mocked(httpClient.post);
  responses.forEach((resp) => {
    fn.mockResolvedValueOnce({ data: resp });
  });
}

/**
 * Returns a helper to track a promise's settled state.
 * The catch handler is attached immediately, preventing unhandled rejections
 * when fake timers cause the promise to reject before the test can `await` it.
 */
function trackPromise<T>(p: Promise<T>) {
  const state: { settled: boolean; result?: T; error?: unknown } = { settled: false };
  p.then(
    (r) => {
      state.result = r;
      state.settled = true;
    },
    (e) => {
      state.error = e;
      state.settled = true;
    },
  );
  return state;
}

describe("beginDeviceRegistration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns verificationUrl and resolves on SUCCESS poll", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "test-nonce-123" },
      {
        errcode: 0,
        device_code: "dc-abc",
        verification_uri_complete: "https://oapi.dingtalk.com/verify?code=abc",
        expires_in: 300,
        interval: 1,
      },
    ]);
    // First poll: WAITING
    vi.mocked(httpClient.post).mockResolvedValueOnce({
      data: { errcode: 0, status: "WAITING" },
    });
    // Second poll: SUCCESS
    vi.mocked(httpClient.post).mockResolvedValueOnce({
      data: {
        errcode: 0,
        status: "SUCCESS",
        client_id: "ding123",
        client_secret: "sec456",
      },
    });

    const session = await beginDeviceRegistration();
    expect(session.verificationUrl).toBe("https://oapi.dingtalk.com/verify?code=abc");

    let waitingCalled = false;
    const resultPromise = session.waitForResult({
      onWaiting: () => {
        waitingCalled = true;
      },
    });
    const state = trackPromise(resultPromise);

    // Advance past the first interval sleep (clamped to 2s) → WAITING poll fires
    await vi.advanceTimersByTimeAsync(3000);
    // Advance past the second interval sleep → SUCCESS poll fires
    await vi.advanceTimersByTimeAsync(3000);

    // Allow microtask queue to flush
    await vi.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    expect(state.result?.clientId).toBe("ding123");
    expect(state.result?.clientSecret).toBe("sec456");
    expect(waitingCalled).toBe(true);
  });

  it("throws RegistrationError when init returns no nonce", async () => {
    mockPostSequence([{ errcode: 0 }]); // no nonce
    await expect(beginDeviceRegistration()).rejects.toThrow(RegistrationError);
  });

  it("throws RegistrationError when init returns errcode !== 0", async () => {
    mockPostSequence([{ errcode: 1, errmsg: "denied" }]);
    await expect(beginDeviceRegistration()).rejects.toThrow(RegistrationError);
  });

  it("throws RegistrationError when begin returns no device_code", async () => {
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, verification_uri_complete: "https://x" }, // no device_code
    ]);
    await expect(beginDeviceRegistration()).rejects.toThrow(RegistrationError);
  });

  it("throws RegistrationError when SUCCESS has no credentials", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, device_code: "dc", verification_uri_complete: "https://x", interval: 1 },
    ]);
    vi.mocked(httpClient.post).mockResolvedValueOnce({
      data: { errcode: 0, status: "SUCCESS" }, // no client_id/client_secret
    });

    const session = await beginDeviceRegistration();
    const resultPromise = session.waitForResult();
    const state = trackPromise(resultPromise);

    // Advance past interval (clamped to 2s) to trigger the poll
    await vi.advanceTimersByTimeAsync(3000);

    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(RegistrationError);
    expect((state.error as Error).message).toContain("credentials are missing");
  });

  it("retries on transient network error then succeeds", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, device_code: "dc", verification_uri_complete: "https://x", interval: 1, expires_in: 300 },
    ]);
    // First poll: network error
    vi.mocked(httpClient.post).mockRejectedValueOnce(new Error("ECONNRESET"));
    // Second poll: SUCCESS
    vi.mocked(httpClient.post).mockResolvedValueOnce({
      data: { errcode: 0, status: "SUCCESS", client_id: "c", client_secret: "s" },
    });

    const session = await beginDeviceRegistration();
    const resultPromise = session.waitForResult();
    const state = trackPromise(resultPromise);

    // Advance past first interval → network error, retry
    await vi.advanceTimersByTimeAsync(3000);
    // Advance past second interval → SUCCESS
    await vi.advanceTimersByTimeAsync(3000);

    // Allow microtask queue to flush
    await vi.advanceTimersByTimeAsync(0);

    expect(state.settled).toBe(true);
    expect(state.result?.clientId).toBe("c");
  });

  it("throws after retry window exhausted on persistent network errors", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, device_code: "dc", verification_uri_complete: "https://x", interval: 1, expires_in: 300 },
    ]);
    // All polls: network error
    vi.mocked(httpClient.post).mockRejectedValue(new Error("ECONNRESET"));

    const session = await beginDeviceRegistration();
    const resultPromise = session.waitForResult();
    const state = trackPromise(resultPromise);

    // Advance well beyond the retry window (120_000ms) + many interval cycles
    await vi.advanceTimersByTimeAsync(200_000);

    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(RegistrationError);
    expect((state.error as Error).message).toContain("retry window");
  });

  it("throws on poll FAIL after retry window", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, device_code: "dc", verification_uri_complete: "https://x", interval: 1, expires_in: 300 },
    ]);
    vi.mocked(httpClient.post).mockResolvedValue({
      data: { errcode: 0, status: "FAIL", fail_reason: "user denied" },
    });

    const session = await beginDeviceRegistration();
    const resultPromise = session.waitForResult();
    const state = trackPromise(resultPromise);

    // Advance beyond retry window so FAIL exhausts the window
    await vi.advanceTimersByTimeAsync(200_000);

    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(RegistrationError);
    expect((state.error as Error).message).toContain("user denied");
  });

  it("respects AbortSignal", async () => {
    vi.useFakeTimers();
    mockPostSequence([
      { errcode: 0, nonce: "n" },
      { errcode: 0, device_code: "dc", verification_uri_complete: "https://x", interval: 1, expires_in: 300 },
    ]);
    vi.mocked(httpClient.post).mockResolvedValue({
      data: { errcode: 0, status: "WAITING" },
    });

    const controller = new AbortController();
    controller.abort();

    const session = await beginDeviceRegistration();
    const resultPromise = session.waitForResult({ signal: controller.signal });
    const state = trackPromise(resultPromise);

    // Advance to allow the while-loop to check abort
    await vi.advanceTimersByTimeAsync(3000);

    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(RegistrationError);
    expect((state.error as Error).message).toContain("cancelled");
  });
});

describe("openUrlInBrowser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls execFile with 'open' on darwin", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      openUrlInBrowser("https://example.com");
      expect(execFile).toHaveBeenCalledWith("open", ["https://example.com"], expect.any(Function));
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("calls execFile with 'xdg-open' on linux", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      openUrlInBrowser("https://example.com");
      expect(execFile).toHaveBeenCalledWith("xdg-open", ["https://example.com"], expect.any(Function));
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("calls execFile with 'cmd' on win32", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      openUrlInBrowser("https://example.com");
      expect(execFile).toHaveBeenCalledWith("cmd", ["/c", "start", "", "https://example.com"], expect.any(Function));
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("does not throw when execFile fails", () => {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error("no browser"));
    }) as typeof execFile);
    expect(() => openUrlInBrowser("https://example.com")).not.toThrow();
  });
});
