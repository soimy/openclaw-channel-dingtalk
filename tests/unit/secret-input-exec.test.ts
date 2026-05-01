import { describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("SecretInput exec support", () => {
  it("bounds async exec secret helper calls with a timeout", async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "secret-from-helper\n", "");
    });
    const { SECRET_INPUT_EXEC_TIMEOUT_MS, resolveSecretInputString } =
      await import("../../src/secret-input");

    const secret = await resolveSecretInputString({
      source: "exec",
      provider: "secret-helper",
      id: "dingtalk/client-secret",
    });

    expect(secret).toBe("secret-from-helper");
    expect(execFileMock).toHaveBeenCalledWith(
      "secret-helper",
      ["dingtalk/client-secret"],
      {
        encoding: "utf8",
        timeout: SECRET_INPUT_EXEC_TIMEOUT_MS,
        windowsHide: true,
      },
      expect.any(Function),
    );
  });
});
