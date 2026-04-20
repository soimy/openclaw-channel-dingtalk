import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConfigured } from "../../src/config";
import { DingTalkConfigSchema } from "../../src/config-schema";
import {
  formatSecretInputResolutionFailure,
  parseSecretInputString,
  resolveSecretInputString,
  resolveSecretInputStringWithFailure,
} from "../../src/secret-input";

describe("SecretInput support", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    delete process.env.DINGTALK_TEST_SECRET;
    if (tempDir) {
      const dir = tempDir;
      tempDir = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts SecretInput references in the DingTalk config schema", () => {
    const parsed = DingTalkConfigSchema.parse({
      clientId: "id",
      clientSecret: { source: "env", provider: "env", id: "DINGTALK_TEST_SECRET" },
      accounts: {
        main: {
          clientId: "account-id",
          clientSecret: {
            source: "file",
            provider: "local",
            id: "~/.config/dingtalk-secret",
          },
        },
      },
    }) as { clientSecret?: unknown; accounts: Record<string, { clientSecret?: unknown }> };

    expect(parsed.clientSecret).toEqual({
      source: "env",
      provider: "env",
      id: "DINGTALK_TEST_SECRET",
    });
    expect(parsed.accounts.main?.clientSecret).toEqual({
      source: "file",
      provider: "local",
      id: "~/.config/dingtalk-secret",
    });
  });

  it("treats env SecretInput as configured only when the env value exists", () => {
    process.env.DINGTALK_TEST_SECRET = "sec-from-env";

    expect(
      isConfigured({
        channels: {
          dingtalk: {
            clientId: "id",
            clientSecret: { source: "env", provider: "env", id: "DINGTALK_TEST_SECRET" },
          },
        },
      } as any),
    ).toBe(true);
    expect(
      isConfigured({
        channels: {
          dingtalk: {
            clientId: "id",
            clientSecret: { source: "env", provider: "env", id: "DINGTALK_MISSING_SECRET" },
          },
        },
      } as any),
    ).toBe(false);
  });

  it("resolves file SecretInput values from a local file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dingtalk-secret-input-"));
    const secretPath = join(tempDir, "client-secret.txt");
    await writeFile(secretPath, "secret-from-file\n", "utf8");

    await expect(
      resolveSecretInputString({
        source: "file",
        provider: "local",
        id: secretPath,
      }),
    ).resolves.toBe("secret-from-file");
  });

  it("reports env SecretInput resolution failures with source context", async () => {
    const result = await resolveSecretInputStringWithFailure({
      source: "env",
      provider: "env",
      id: "DINGTALK_MISSING_SECRET",
    });

    expect(result.value).toBeUndefined();
    expect(result.failure).toEqual({
      source: "env",
      provider: "env",
      id: "DINGTALK_MISSING_SECRET",
      reason: "environment variable is not set or is empty",
    });
    expect(formatSecretInputResolutionFailure(result.failure!)).toBe(
      "env:env:DINGTALK_MISSING_SECRET - environment variable is not set or is empty",
    );
  });

  it("reports file SecretInput resolution failures with source context", async () => {
    const result = await resolveSecretInputStringWithFailure({
      source: "file",
      provider: "local",
      id: "/missing-dingtalk-secret",
    });

    expect(result.value).toBeUndefined();
    expect(result.failure).toMatchObject({
      source: "file",
      provider: "local",
      id: "/missing-dingtalk-secret",
    });
    expect(result.failure?.reason).toContain("ENOENT");
  });

  it("parses normalized SecretInput strings back into object refs", () => {
    expect(parseSecretInputString("<env:env:DINGTALK_TEST_SECRET>")).toEqual({
      source: "env",
      provider: "env",
      id: "DINGTALK_TEST_SECRET",
    });
    expect(parseSecretInputString("plain-secret")).toBe("plain-secret");
  });
});
