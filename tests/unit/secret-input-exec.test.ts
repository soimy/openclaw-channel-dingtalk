import { describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

describe("SecretInput exec support", () => {
  it("bounds exec secret helper calls with a timeout", async () => {
    execFileSyncMock.mockReturnValue("secret-from-helper\n");
    const { SECRET_INPUT_EXEC_TIMEOUT_MS, resolveSecretInputString } =
      await import("../../src/secret-input");

    const secret = resolveSecretInputString({
      source: "exec",
      provider: "secret-helper",
      id: "dingtalk/client-secret",
    });

    expect(secret).toBe("secret-from-helper");
    expect(execFileSyncMock).toHaveBeenCalledWith("secret-helper", ["dingtalk/client-secret"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SECRET_INPUT_EXEC_TIMEOUT_MS,
    });
  });
});
