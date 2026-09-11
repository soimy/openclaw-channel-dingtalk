import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConfigured } from "../../src/config";
import { DingTalkConfigSchema } from "../../src/config-schema";
import {
  formatSecretInputResolutionFailure,
  normalizeSecretInputString,
  parseSecretInputString,
  resolveSecretInputString,
  resolveSecretInputStringWithFailure,
} from "../../src/secret-input";

describe("SecretInput support", () => {
  let tempDir: string | undefined;
  let previousStateDir: string | undefined;

  afterEach(async () => {
    delete process.env.DINGTALK_TEST_SECRET;
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    previousStateDir = undefined;
    if (tempDir) {
      const dir = tempDir;
      tempDir = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Host SDK 2026.8+ requires file SecretRef payloads to live under the trusted
   * state dir with strict permissions (`allowInsecurePath` was removed), so the
   * fixture points OPENCLAW_STATE_DIR at the temp dir instead of /tmp directly.
   */
  async function createSecureSecretFixture(): Promise<string> {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tempDir = await mkdtemp(join(tmpdir(), "dingtalk-secret-input-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    const secretPath = join(tempDir, "client-secret.txt");
    await writeFile(secretPath, "secret-from-file\n", { encoding: "utf8", mode: 0o600 });
    await chmod(secretPath, 0o600);
    return secretPath;
  }

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

  it("rejects exec SecretInput references", () => {
    expect(
      DingTalkConfigSchema.safeParse({
        clientId: "id",
        clientSecret: {
          source: "exec",
          provider: "secret-helper",
          id: "dingtalk/client-secret",
        },
      }).success,
    ).toBe(false);
    expect(parseSecretInputString("<exec:secret-helper:dingtalk/client-secret>")).toBe(
      "<exec:secret-helper:dingtalk/client-secret>",
    );
  });

  it("treats valid SecretInput references as configured without reading them", () => {
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
    ).toBe(true);
  });

  it("resolves file SecretInput values from a local file", async () => {
    const secretPath = await createSecureSecretFixture();

    await expect(
      resolveSecretInputString(
        {
          source: "file",
          provider: "local",
          id: "value",
        },
        undefined,
        {
          secrets: {
            providers: {
              local: {
                source: "file",
                path: secretPath,
                mode: "singleValue",
              },
            },
          },
        } as any,
      ),
    ).resolves.toBe("secret-from-file");
  });

  it("reports env SecretInput resolution failures with source context", async () => {
    const result = await resolveSecretInputStringWithFailure(
      {
        source: "env",
        provider: "env",
        id: "DINGTALK_MISSING_SECRET",
      },
      undefined,
      {
        secrets: {
          providers: {
            env: { source: "env", allowlist: ["DINGTALK_MISSING_SECRET"] },
          },
        },
      } as any,
    );

    expect(result.value).toBeUndefined();
    expect(result.failure?.source).toBe("env");
    expect(result.failure?.provider).toBe("env");
    expect(result.failure?.id).toBe("DINGTALK_MISSING_SECRET");
    // Allowlisted but unset must not be reported as a missing allowlist entry.
    expect(result.failure?.reason).toBe(
      "channels.dingtalk.clientSecret SecretRef is unresolved (env:env:DINGTALK_MISSING_SECRET). " +
        `Environment variable "DINGTALK_MISSING_SECRET" is authorized but unset or empty.`,
    );
    expect(formatSecretInputResolutionFailure(result.failure!)).toBe(
      "env:env:DINGTALK_MISSING_SECRET - channels.dingtalk.clientSecret SecretRef is unresolved (env:env:DINGTALK_MISSING_SECRET). " +
        `Environment variable "DINGTALK_MISSING_SECRET" is authorized but unset or empty.`,
    );
  });

  it("resolves an allowlisted env SecretInput value from the environment", async () => {
    process.env.DINGTALK_TEST_SECRET = "secret-from-env";

    await expect(
      resolveSecretInputString(
        {
          source: "env",
          provider: "env",
          id: "DINGTALK_TEST_SECRET",
        },
        undefined,
        {
          secrets: {
            providers: {
              env: { source: "env", allowlist: ["DINGTALK_TEST_SECRET"] },
            },
          },
        } as any,
      ),
    ).resolves.toBe("secret-from-env");
  });

  it("refuses an env SecretInput value that the allowlist does not cover", async () => {
    process.env.DINGTALK_TEST_SECRET = "ambient-secret";

    const result = await resolveSecretInputStringWithFailure(
      {
        source: "env",
        provider: "env",
        id: "DINGTALK_TEST_SECRET",
      },
      undefined,
      {
        secrets: {
          providers: {
            env: { source: "env", allowlist: ["SOME_OTHER_SECRET"] },
          },
        },
      } as any,
    );

    expect(result.value).toBeUndefined();
    expect(result.failure?.reason).toContain("is not authorized for a read-only path");
  });

  it("does not treat a file SecretInput id as a local path", async () => {
    const result = await resolveSecretInputStringWithFailure(
      {
        source: "file",
        provider: "local",
        id: "/missing-dingtalk-secret",
      },
      undefined,
      {} as any,
    );

    expect(result.value).toBeUndefined();
    expect(result.failure).toMatchObject({
      source: "file",
      provider: "local",
      id: "/missing-dingtalk-secret",
    });
    expect(result.failure?.reason).toContain("SecretRef is unresolved");
  });

  it("parses normalized SecretInput strings back into object refs", () => {
    expect(parseSecretInputString("<env:env:DINGTALK_TEST_SECRET>")).toEqual({
      source: "env",
      provider: "env",
      id: "DINGTALK_TEST_SECRET",
    });
    expect(parseSecretInputString("plain-secret")).toBe("plain-secret");
  });

  it("leaves malformed normalized SecretInput strings as plain secrets", () => {
    expect(parseSecretInputString("<exec:helper:my>id>")).toBe("<exec:helper:my>id>");
  });

  it("rejects SecretInput refs that cannot round-trip through normalized placeholders", () => {
    const providerWithColon = { source: "env", provider: "vault:kv", id: "my-secret" } as const;
    const idWithClosingBracket = { source: "file", provider: "local", id: "my>secret" } as const;

    expect(
      DingTalkConfigSchema.safeParse({ clientId: "id", clientSecret: providerWithColon }).success,
    ).toBe(false);
    expect(
      DingTalkConfigSchema.safeParse({ clientId: "id", clientSecret: idWithClosingBracket })
        .success,
    ).toBe(false);
    expect(normalizeSecretInputString(providerWithColon)).toBeUndefined();
    expect(normalizeSecretInputString(idWithClosingBracket)).toBeUndefined();
  });
});
