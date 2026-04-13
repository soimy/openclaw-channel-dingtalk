import { afterEach, describe, expect, it } from "vitest";
import { isConfigured } from "../../src/config";
import { DingTalkConfigSchema } from "../../src/config-schema";

describe("SecretInput support", () => {
  afterEach(() => {
    delete process.env.DINGTALK_TEST_SECRET;
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
});
